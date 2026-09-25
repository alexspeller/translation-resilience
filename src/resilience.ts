/**
 * Makes React (and any other text-node-owning renderer) resilient to browser
 * page translation — Chrome / Google Translate and Edge, which merge and
 * replace Text nodes with `<font>` wrappers, and Firefox, which empties and
 * refills translated elements, reusing only some of their Text nodes. React
 * keeps references to the original, now detached, Text nodes, so without this
 * shim:
 *
 *  - unmounting translated conditional text throws NotFoundError (removeChild)
 *  - mounting content before translated text throws NotFoundError (insertBefore)
 *  - updating translated text writes to the detached node — the visible page
 *    silently never updates again (see facebook/react#11538)
 *
 * Strategy — "re-adoption", not error swallowing:
 *
 * 1. A document-wide MutationObserver watches mutations. Translation displaces
 *    text nodes in a recognizable pattern: adjacent Text nodes are merged
 *    (`normalize()`), then the merged run is replaced by wrapper elements
 *    inserted next to it in the same task. We track a DISPLACEMENT GROUP per
 *    replaced run: the ordered renderer-owned originals (with their
 *    pre-translation values) and the run of replacement nodes standing in for
 *    them. React's own commits never look like this: React processes
 *    deletions before placements, so a node it removes is never adjacent to a
 *    same-batch insertion at removal time, and React never merges text nodes.
 *
 * 2. Patched Node.prototype.removeChild / insertBefore / appendChild and the
 *    nodeValue / data setters detect operations on displaced Text nodes and
 *    first RESTORE the group — original nodes go back into the replacement
 *    run's position, replacements are removed — then let the native operation
 *    proceed. This repairs the renderer's ownership invariant: updates become
 *    visible, removals remove the right content, and the translator
 *    re-translates the freshly restored text via its own observer.
 *
 * 3. Translation can also delete text nodes outright and move inline elements
 *    (word-order changes — Chromium bug 872770). Deletions within a
 *    translation batch get an empty group with position hints so the node can
 *    come back if React updates it. Once translation activity has been
 *    detected, unrecoverable parent mismatches degrade to guarded best-effort
 *    operations instead of throwing.
 *
 * 4. Firefox applies a translation to an element by detaching every child and
 *    appending the translation back, reusing Text nodes by position; all but
 *    the first node of each run of text stay detached (see
 *    recognizeChildrenMerges). A lossy merge gets a WHOLE-PARENT group — the
 *    parent's original children and pre-translation text — restored before
 *    any renderer operation on one of them, attached or not. Firefox then
 *    re-translates the restored nodes one by one, in place.
 *
 * Arming, and why it cannot rely on the patches above: a browser's page
 * translator runs in the engine's own ISOLATED WORLD — it shares the DOM but
 * holds a separate copy of Node.prototype (Chromium runs the translate script
 * via ExecuteScriptInIsolatedWorld; see translate_agent.cc). None of the
 * patched methods here ever observe a translator's own mutations, so every
 * arming signal has to be one the shared DOM raises:
 *
 *  - Chrome's translator adds a `translated-*` class to <html> a few hundred
 *    ms before it touches text: an attribute sentinel catches that, and
 *    attributes are shared across worlds.
 *  - Firefox's translator sets <html lang> as it starts. Apps write that
 *    attribute too, so only a write from outside the page counts — told apart
 *    by wrappers on the <html> instance that the page's own writes go through
 *    and a translator's never do (see trackPageAttributeWrites).
 *  - Edge's translator and the Google Translate extension mark nothing. For
 *    those, a detection stylesheet (DETECTION_CSS) puts a CSS animation on the
 *    translator's signature <font>, and `animationstart` fires whichever world
 *    inserted it — at a fraction of the cost of observing the document.
 *  - Whatever still slips through lands on a patched method that is about to
 *    throw NotFoundError, where a document sweep (translationEvident) tells a
 *    translated page from a genuine renderer bug.
 *
 * Before any translation activity is detected, operations on untracked nodes
 * behave exactly as before — including throwing on genuine bugs.
 */

interface DisplacedOriginal {
  node: Node;
  /**
   * A Text node's value before translation touched it (normalize and Firefox's
   * merge both overwrite nodes they reuse); null for any other node.
   */
  value: string | null;
}

interface DisplacementGroup {
  parent: Node;
  /** Renderer-owned nodes this group stands in for, in document order. */
  originals: DisplacedOriginal[];
  /** Nodes currently displaying the originals' content (empty if translation deleted the run). */
  replacement: Node[];
  /** Position hints captured at removal time, used when `replacement` is empty. */
  previousSiblingHint: Node | null;
  nextSiblingHint: Node | null;
  /**
   * The originals are ALL of the parent's children, text and elements, and
   * restoring rebuilds the parent's child list (Firefox's merge — see
   * recognizeChildrenMerges). Otherwise they are one displaced run of text
   * that `replacement` stands in for (Chrome/Edge wrap-and-remove).
   */
  wholeParent: boolean;
}

const displaced = new WeakMap<Node, DisplacementGroup>();
const groupByReplacementNode = new WeakMap<Node, DisplacementGroup>();
/** Live merge targets (normalize) carrying content of already-detached originals. */
const pendingCarrierOriginals = new WeakMap<Text, DisplacedOriginal[]>();

let observer: MutationObserver | null = null;
let sentinelObserver: MutationObserver | null = null;
/** True while installed but not yet observing — patched methods run a cheap synchronous signal check. */
let sentinelActive = false;
let translationDetected = false;
const noopEvent = (_message: string): void => undefined;
let emitEvent: (message: string) => void = noopEvent;

interface DomNatives {
  insertBefore: typeof Node.prototype.insertBefore;
  removeChild: typeof Node.prototype.removeChild;
  appendChild: typeof Node.prototype.appendChild;
  nodeValueDescriptor: PropertyDescriptor;
  dataDescriptor: PropertyDescriptor;
  setNodeValue(node: Node, value: string | null): void;
  setData(node: CharacterData, value: string): void;
}

let capturedNatives: DomNatives | null = null;

/**
 * Native DOM entry points, captured once on first use rather than at module
 * load so that importing this module is safe in non-DOM environments (SSR);
 * only calling install requires a browser.
 */
function domNatives(): DomNatives {
  if (capturedNatives) return capturedNatives;
  if (typeof Node === 'undefined' || typeof CharacterData === 'undefined') {
    throw new Error(
      'translation-resilience requires a DOM. Call installTranslationResilience() from client-side code only.'
    );
  }
  const nodeValueDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeValue');
  const dataDescriptor = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data');
  const nodeValueSet = nodeValueDescriptor?.set;
  const dataSet = dataDescriptor?.set;
  if (!nodeValueDescriptor?.get || !nodeValueSet || !dataDescriptor?.get || !dataSet) {
    throw new Error('translation-resilience: expected accessor descriptors for nodeValue and data');
  }
  capturedNatives = {
    insertBefore: Node.prototype.insertBefore,
    removeChild: Node.prototype.removeChild,
    appendChild: Node.prototype.appendChild,
    nodeValueDescriptor,
    dataDescriptor,
    setNodeValue: (node, value) => nodeValueSet.call(node, value),
    setData: (node, value) => dataSet.call(node, value),
  };
  return capturedNatives;
}

/**
 * A fault in the shim itself must never make things worse than stock
 * behavior: every non-native code path runs through this guard, and on an
 * internal error the caller falls back to the native operation.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function guarded<T>(operation: string, run: () => T, fallback: T): T {
  try {
    return run();
  } catch (error) {
    emitEvent(`internal error in ${operation}: ${describeError(error)}`);
    return fallback;
  }
}

function markTranslationDetected(): void {
  if (translationDetected) return;
  translationDetected = true;
  emitEvent('translation activity detected');
}

function registerGroup(group: DisplacementGroup): void {
  markTranslationDetected();
  for (const original of group.originals) displaced.set(original.node, group);
  for (const node of group.replacement) groupByReplacementNode.set(node, group);
}

function unregisterGroup(group: DisplacementGroup): void {
  for (const original of group.originals) displaced.delete(original.node);
  for (const node of group.replacement) groupByReplacementNode.delete(node);
}

/**
 * Correlation state must survive batch boundaries: the record stream can be
 * split at arbitrary points — the shim's own synchronous drains inside
 * patched DOM methods split a translator's mutation sequence across several
 * processRecords calls, and translators themselves spread work across tasks.
 * Entries are consumed on use and expire after a short wall-clock window so
 * that old insertions are never attributed to unrelated removals later.
 */
const CORRELATION_WINDOW_MS = 100;

interface TimedRun {
  at: number;
  nodes: Node[];
}
interface TimedValue {
  at: number;
  value: string;
}
interface PendingOrphan {
  at: number;
  parent: Node;
  removed: Text;
  previousSibling: Node | null;
  nextSibling: Node | null;
}

/**
 * Every correlation store below is kept in ascending-`at` order: new entries
 * are appended, and any refresh of an existing entry's timestamp must
 * delete-then-set so the entry moves to the end. purgeExpired relies on this
 * to drop only the expired prefix and stop at the first fresh entry —
 * processRecords runs on every synchronous drain (i.e. inside patched DOM
 * calls), so a full scan of the stores per drain is quadratic under heavy
 * synchronous DOM churn.
 */

/** Nodes recently inserted, indexed by their at-insertion-time nextSibling. */
const recentInsertedBefore = new Map<Node, TimedRun>();
/** First recently-seen characterData oldValue per node = value before the mutation sequence. */
const recentOldValues = new Map<Node, TimedValue>();
/** Accumulated merged-away content per normalize target, for validation. */
const recentCarrierAccumulated = new Map<Text, TimedValue>();
/** Text removals with no replacement — become deletion groups once translator activity is confirmed. */
let pendingOrphans: PendingOrphan[] = [];

function purgeExpired(now: number): void {
  for (const [key, entry] of recentInsertedBefore) {
    if (now - entry.at <= CORRELATION_WINDOW_MS) break;
    recentInsertedBefore.delete(key);
  }
  for (const [key, entry] of recentOldValues) {
    if (now - entry.at <= CORRELATION_WINDOW_MS) break;
    recentOldValues.delete(key);
  }
  for (const [key, entry] of recentCarrierAccumulated) {
    if (now - entry.at <= CORRELATION_WINDOW_MS) break;
    recentCarrierAccumulated.delete(key);
  }
  const firstFresh = pendingOrphans.findIndex((orphan) => now - orphan.at <= CORRELATION_WINDOW_MS);
  if (firstFresh === -1) {
    if (pendingOrphans.length > 0) pendingOrphans = [];
  } else if (firstFresh > 0) {
    pendingOrphans = pendingOrphans.slice(firstFresh);
  }
}

function clearCorrelationState(): void {
  recentInsertedBefore.clear();
  recentOldValues.clear();
  recentCarrierAccumulated.clear();
  pendingOrphans = [];
  forgetPageMoves();
}

/** Replacement nodes a translator produces: <font> wrappers or plain text (revert). */
function looksLikeTranslatorReplacement(node: Node): boolean {
  return node instanceof Text || node.nodeName === 'FONT';
}

/**
 * Recognises the <font> wrapper a page translator specifically emits — not a
 * <font> an app happens to render itself. <font> is deprecated but apps can
 * still produce one (JSX, dangerouslySetInnerHTML, rendered HTML/markdown), so
 * the tag alone is not enough; we match the translator's signature:
 *
 *  - Chrome's Google Translate (built-in and the browser extension) wraps text
 *    in `<font style="vertical-align: inherit;">` (doubly nested).
 *  - Microsoft Edge's built-in translator wraps in `<font>` carrying
 *    `_msttexthash` / `_msthash` / `_mstmutation` attributes and no style.
 *
 * Matching the signature keeps an app's own <font> from arming the observer,
 * while still covering translators that never mark <html>.
 */
function isTranslatorFontWrapper(node: Node): boolean {
  if (node.nodeName !== 'FONT' || !(node instanceof HTMLElement)) return false;
  return (
    node.style.verticalAlign === 'inherit' ||
    node.hasAttribute('_msttexthash') ||
    node.hasAttribute('_msthash') ||
    node.hasAttribute('_mstmutation')
  );
}

/**
 * The CSS spelling of the same signature isTranslatorFontWrapper matches.
 * Kept deliberately adjacent to it: both must describe the same wrappers.
 */
const TRANSLATOR_FONT_SELECTOR = 'font[_msttexthash],font[_msthash],font[_mstmutation],font[style*="vertical-align"]';

const DETECTION_ANIMATION_NAME = 'translation-resilience-detect';

/**
 * A browser's page translator runs in the engine's own isolated world: it
 * shares the DOM but has a separate copy of Node.prototype, so it never calls
 * the patched methods in this module. Any signal that depends on those
 * patches firing (see noticeTranslatorFont) can therefore only ever be raised
 * by a same-realm translator such as the bundled simulator — never by Chrome,
 * Edge or Firefox. Arming has to come from the shared DOM itself.
 *
 * A MutationObserver would see it, but observing childList across the whole
 * document costs about what the full observer costs (+7.2% vs +9.5% on a
 * 500x4 grid churn benchmark, headless Chrome, medians of 9 interleaved
 * trials) — precisely the cost lazy activation exists to avoid. A CSS
 * animation keyed to the translator's signature <font> costs the style engine
 * one more selector on elements it is already matching, and raises
 * `animationstart` when a matching element enters the tree from any world:
 * +1.1% on the same benchmark.
 *
 * `!important` and the attribute-qualified selector keep a global
 * `* { animation: none !important }` reset from silencing the hook.
 */
const DETECTION_CSS =
  `@keyframes ${DETECTION_ANIMATION_NAME}{from{opacity:1}to{opacity:1}}` +
  `${TRANSLATOR_FONT_SELECTOR}{animation-duration:1ms!important;animation-name:${DETECTION_ANIMATION_NAME}!important}`;

/**
 * Constructable stylesheets first: a `style-src 'self'` Content-Security-Policy
 * blocks an injected <style> element outright (verified in Chrome), while
 * adoptedStyleSheets is CSSOM and unaffected by it. The <style> fallback
 * covers engines without constructable stylesheet support.
 */
function installDetectionStylesheet(doc: Document): () => void {
  const view = doc.defaultView;
  try {
    if (view && typeof view.CSSStyleSheet === 'function' && Array.isArray(doc.adoptedStyleSheets)) {
      const sheet = new view.CSSStyleSheet();
      sheet.replaceSync(DETECTION_CSS);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      return () => {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
      };
    }
  } catch (error) {
    emitEvent(`detection stylesheet: adoptedStyleSheets unusable (${describeError(error)})`);
  }
  try {
    const style = doc.createElement('style');
    style.textContent = DETECTION_CSS;
    (doc.head ?? doc.documentElement).appendChild(style);
    return () => style.remove();
  } catch (error) {
    // No detection stylesheet: the repair-path sweep still prevents the crash.
    emitEvent(`detection stylesheet: not installed (${describeError(error)})`);
    return () => undefined;
  }
}

/**
 * Whether the document currently holds a translator's signature <font>. Only
 * ever called from a path that is otherwise about to throw, so a
 * document-wide query is affordable there; it never runs on a healthy path.
 */
function documentShowsTranslation(doc: Document): boolean {
  try {
    return doc.querySelector(TRANSLATOR_FONT_SELECTOR) !== null;
  } catch {
    return false;
  }
}

/**
 * The run of nodes that took a removed node's place. A replaceChild-style
 * swap queues a single record carrying both sides — correlate those directly.
 * Translation instead inserts the wrapper(s) directly before the original and
 * then removes it as separate operations, so each wrapper's insertion record
 * has the original as its at-insertion-time nextSibling. Sibling pointers are
 * NOT walked at processing time — later mutations may already have
 * invalidated them.
 */
function replacementRunFor(removed: Node, record: MutationRecord): Node[] {
  if (record.removedNodes.length === 1 && record.addedNodes.length === 1) {
    const added = record.addedNodes[0];
    return added ? [added] : [];
  }
  const entry = recentInsertedBefore.get(removed);
  if (!entry) return [];
  recentInsertedBefore.delete(removed);
  return entry.nodes.filter(looksLikeTranslatorReplacement);
}

/**
 * Detects a normalize() merge: the removed text's content was appended onto
 * the preceding Text sibling. The carrier must have a recent characterData
 * record (a renderer removing a node never mutates its neighbor) and its
 * content must be consistent with concatenation. Pre-mutation values are
 * used throughout — the caller (e.g. React) may already have written a new
 * value into a node before these records were processed.
 */
function mergeCarrierFor(removed: Text, record: MutationRecord, now: number): Text | null {
  const carrier = record.previousSibling;
  if (!carrier || !(carrier instanceof Text)) return null;
  const carrierOriginalValue = recentOldValues.get(carrier)?.value;
  if (carrierOriginalValue === undefined) return null;
  const accumulated = (recentCarrierAccumulated.get(carrier)?.value ?? '') + snapshotValue(removed);
  if (!(carrier.nodeValue ?? '').startsWith(carrierOriginalValue + accumulated)) return null;
  // delete-then-set keeps the store in ascending-`at` order (see purgeExpired)
  recentCarrierAccumulated.delete(carrier);
  recentCarrierAccumulated.set(carrier, { at: now, value: accumulated });
  return carrier;
}

function snapshotValue(node: Text): string {
  return recentOldValues.get(node)?.value ?? node.nodeValue ?? '';
}

/** Returns true if a displacement group was registered. */
function handleDisplacedText(removed: Text, record: MutationRecord, now: number): boolean {
  const run = replacementRunFor(removed, record);
  if (run.length > 0) {
    const group: DisplacementGroup = {
      parent: record.target,
      originals: [{ node: removed, value: snapshotValue(removed) }, ...(pendingCarrierOriginals.get(removed) ?? [])],
      replacement: run,
      previousSiblingHint: record.previousSibling,
      nextSiblingHint: record.nextSibling,
      wholeParent: false,
    };
    pendingCarrierOriginals.delete(removed);
    registerGroup(group);
    return true;
  }

  const carrier = mergeCarrierFor(removed, record, now);
  if (carrier) {
    const carried = pendingCarrierOriginals.get(carrier) ?? [];
    carried.push({ node: removed, value: snapshotValue(removed) }, ...(pendingCarrierOriginals.get(removed) ?? []));
    pendingCarrierOriginals.delete(removed);
    pendingCarrierOriginals.set(carrier, carried);
    return false;
  }

  pendingOrphans.push({
    at: now,
    parent: record.target,
    removed,
    previousSibling: record.previousSibling,
    nextSibling: record.nextSibling,
  });
  return false;
}

function handleReplacementRemoved(group: DisplacementGroup, removed: Node, record: MutationRecord): void {
  groupByReplacementNode.delete(removed);
  const index = group.replacement.indexOf(removed);
  const run = replacementRunFor(removed, record).filter((node) => {
    // The translator may revert by re-inserting an original itself; an
    // original never doubles as its own group's replacement.
    return !group.originals.some((original) => original.node === node);
  });
  if (index >= 0) {
    group.replacement.splice(index, 1, ...run);
  } else {
    group.replacement.push(...run);
  }
  for (const node of run) groupByReplacementNode.set(node, group);

  // Full revert: every original is back in the document — the group is moot.
  if (group.replacement.length === 0 && group.originals.every((original) => original.node.parentNode !== null)) {
    unregisterGroup(group);
    return;
  }
  if (group.replacement.length === 0) {
    group.previousSiblingHint = record.previousSibling;
    group.nextSiblingHint = record.nextSibling;
  }
}

/**
 * Text removals with no replacement, seen around confirmed translator
 * activity, are translation deletions (word-order changes drop text nodes —
 * Chromium bug 872770). Track them so React can bring the text back.
 */
function flushPendingOrphans(): void {
  for (const orphan of pendingOrphans) {
    if (displaced.has(orphan.removed)) continue;
    const group: DisplacementGroup = {
      parent: orphan.parent,
      originals: [
        { node: orphan.removed, value: snapshotValue(orphan.removed) },
        ...(pendingCarrierOriginals.get(orphan.removed) ?? []),
      ],
      replacement: [],
      previousSiblingHint: orphan.previousSibling,
      nextSiblingHint: orphan.nextSibling,
      wholeParent: false,
    };
    pendingCarrierOriginals.delete(orphan.removed);
    registerGroup(group);
  }
  pendingOrphans = [];
}

/**
 * Firefox's full-page translator (`merge()` in translations-document.sys.mjs)
 * applies a translation to an element by detaching every child, first to
 * last, then appending the translated nodes in order: live Text nodes are
 * reused BY POSITION with their data overwritten, live elements by identity.
 * Its engine sees adjacent Text nodes as one run of text, so a run of several
 * renderer Text nodes comes back as one — the first node carries the whole
 * run's translation and the rest are never re-appended. They stay detached
 * while the renderer still holds them: the same silent freeze and
 * NotFoundError as Chrome's displacement, from a different mutation shape.
 *
 * The shape is recognised per parent within one batch: removals that each
 * take the first child (previousSibling null) until the parent is empty, then
 * appends (nextSibling null), with at least one removed Text node appended
 * back. Page code can produce that sequence too — a keyed move of a text node
 * that has become an only child is a removal from the front plus an append —
 * so two more things must hold, each of which rules out what the other
 * cannot:
 *
 *  - every Text node appended back was overwritten (a characterData record):
 *    Firefox writes the translation into each node it reuses, while a plain
 *    move changes no text;
 *  - none of the nodes went through the patched DOM methods since records
 *    were last processed (movedByPage): Firefox never calls them, while a
 *    renderer's moves and removals always do — including one that rewrites a
 *    text node in the same commit that moves it.
 *
 * Firefox applies a translation synchronously, so one merge lands in one
 * batch — unless page code runs inside it (a custom element's
 * connectedCallback touching a detached text node drains records midway), in
 * which case the halves are judged separately and may be missed.
 */
interface ChildrenMerge {
  parent: Node;
  removed: Node[];
  appended: Node[];
  records: MutationRecord[];
  emptied: boolean;
}

/** Returns the records that belong to recognised merges. */
function recognizeChildrenMerges(records: MutationRecord[]): Set<MutationRecord> {
  const consumed = new Set<MutationRecord>();
  const open = new Map<Node, ChildrenMerge>();
  /**
   * A reused Text node's value before the merge overwrote it: its first
   * characterData oldValue in the batch. Collected up front because where
   * that record falls relative to the node's removal and re-append is not
   * part of the shape (Firefox overwrites while the node is detached).
   */
  const valuesBefore = new Map<Node, string>();
  for (const record of records) {
    if (record.type === 'characterData' && record.oldValue !== null && !valuesBefore.has(record.target)) {
      valuesBefore.set(record.target, record.oldValue);
    }
  }

  const close = (merge: ChildrenMerge): void => {
    open.delete(merge.parent);
    const removed = new Set(merge.removed);
    const reusedText = merge.appended.filter((node) => node instanceof Text && removed.has(node));
    if (reusedText.length === 0 || !reusedText.every((node) => valuesBefore.has(node))) return;
    if (merge.removed.some((node) => movedByPage.has(node)) || merge.appended.some((node) => movedByPage.has(node))) {
      return;
    }
    for (const record of merge.records) consumed.add(record);
    markTranslationDetected();
    registerChildrenMerge(merge, valuesBefore);
  };

  for (const record of records) {
    if (record.type !== 'childList') continue;
    const removedOne =
      record.addedNodes.length === 0 && record.removedNodes.length === 1 && record.previousSibling === null
        ? record.removedNodes[0]
        : undefined;
    const appendedOne =
      record.removedNodes.length === 0 && record.addedNodes.length === 1 && record.nextSibling === null
        ? record.addedNodes[0]
        : undefined;
    const merge = open.get(record.target);
    if (merge && !merge.emptied && removedOne) {
      merge.removed.push(removedOne);
      merge.records.push(record);
      merge.emptied = record.nextSibling === null;
      continue;
    }
    if (merge?.emptied && appendedOne) {
      merge.appended.push(appendedOne);
      merge.records.push(record);
      continue;
    }
    if (merge) close(merge);
    if (removedOne) {
      open.set(record.target, {
        parent: record.target,
        removed: [removedOne],
        appended: [],
        records: [record],
        emptied: record.nextSibling === null,
      });
    }
  }
  for (const merge of [...open.values()]) close(merge);
  return consumed;
}

/**
 * A merge that put every original back and added nothing translated its text
 * in place: the renderer's nodes still stand for themselves, so there is
 * nothing to restore. Otherwise the parent gets a whole-parent group recording
 * its original children and their pre-translation text, restored before any
 * renderer operation on one of them.
 */
function registerChildrenMerge(merge: ChildrenMerge, valuesBefore: Map<Node, string>): void {
  // A parent merged again before being restored: the earlier group still holds
  // the renderer's structure and pre-translation text, whereas this merge's
  // "before" values are the earlier translation. Build on the earlier group.
  let earlier: DisplacementGroup | undefined;
  for (const node of merge.removed) {
    const group = displaced.get(node) ?? groupByReplacementNode.get(node);
    if (group?.wholeParent && group.parent === merge.parent) {
      earlier = group;
      break;
    }
  }
  const originals: DisplacedOriginal[] = earlier ? [...earlier.originals] : [];
  const known = new Set<Node>(originals.map((original) => original.node));
  const earlierReplacement = new Set<Node>(earlier?.replacement ?? []);
  for (const node of merge.removed) {
    if (known.has(node) || earlierReplacement.has(node)) continue;
    originals.push({ node, value: node instanceof Text ? (valuesBefore.get(node) ?? node.data) : null });
    known.add(node);
  }
  if (earlier) unregisterGroup(earlier);

  const appended = new Set(merge.appended);
  const replacement = merge.appended.filter((node) => !known.has(node));
  if (replacement.length === 0 && originals.every((original) => appended.has(original.node))) return;
  registerGroup({
    parent: merge.parent,
    originals,
    replacement,
    previousSiblingHint: null,
    nextSiblingHint: null,
    wholeParent: true,
  });
}

/**
 * Nodes the page moved or removed through the patched DOM methods since
 * records were last processed — never a translator's work (see
 * recognizeChildrenMerges). Noted only while the observer runs, always after
 * the native call has queued its records, and forgotten whenever records are
 * processed, which covers every record those calls queued. Weakly held:
 * mutations the observer never sees (a shadow root, a detached container)
 * leave notes that nothing would otherwise clear.
 */
let movedByPage = new WeakSet<Node>();
let pageMovesNoted = false;

function notePageMove(node: Node): void {
  if (!observer) return;
  movedByPage.add(node);
  pageMovesNoted = true;
}

function forgetPageMoves(): void {
  if (!pageMovesNoted) return;
  movedByPage = new WeakSet<Node>();
  pageMovesNoted = false;
}

/**
 * Set once Firefox's signal — <html lang> written from outside the page —
 * has been seen. Only then are children merges recognised: nothing else
 * produces them, and page code that happens to empty an element and put some
 * of its text back (through APIs the shim does not patch) must never be read
 * as one on a page Firefox is not translating.
 */
let firefoxSignalSeen = false;
const NO_RECORDS: ReadonlySet<MutationRecord> = new Set();

/**
 * Firefox's other mark: it tags the elements inside each block it sends to its
 * engine (so it can match them up again), before the translation comes back,
 * and removes the tags when it merges. Blocks of plain text carry none, and a
 * lazy shim is not observing yet when they appear — but it is how an eager
 * shim installed after Firefox's <html lang> write still recognises it.
 */
const FIREFOX_ID_ATTRIBUTE = 'data-moz-translations-id';

function processRecords(records: MutationRecord[]): void {
  try {
    processRecordBatch(records);
  } finally {
    forgetPageMoves();
  }
}

function processRecordBatch(records: MutationRecord[]): void {
  if (records.length === 0) return;
  const now = performance.now();
  purgeExpired(now);

  if (
    !firefoxSignalSeen &&
    records.some((record) => record.type === 'attributes' && record.attributeName === FIREFOX_ID_ATTRIBUTE)
  ) {
    firefoxSignalSeen = true;
    emitEvent('Firefox translation markers detected');
  }
  const merged = firefoxSignalSeen ? recognizeChildrenMerges(records) : NO_RECORDS;
  let sawTranslatorActivity = false;
  for (const record of records) {
    if (merged.has(record)) continue;
    if (record.type === 'childList') {
      for (const added of record.addedNodes) {
        if (added.nodeName === 'FONT') sawTranslatorActivity = true;
        if (record.nextSibling) {
          const entry = recentInsertedBefore.get(record.nextSibling) ?? { at: now, nodes: [] };
          entry.at = now;
          entry.nodes.push(added);
          // delete-then-set keeps the store in ascending-`at` order (see purgeExpired)
          recentInsertedBefore.delete(record.nextSibling);
          recentInsertedBefore.set(record.nextSibling, entry);
        }
      }
    } else if (record.type === 'characterData' && record.oldValue !== null && !recentOldValues.has(record.target)) {
      recentOldValues.set(record.target, { at: now, value: record.oldValue });
    }
  }

  for (const record of records) {
    if (record.type !== 'childList' || merged.has(record)) continue;
    for (const removed of record.removedNodes) {
      const group = groupByReplacementNode.get(removed);
      if (group) {
        handleReplacementRemoved(group, removed, record);
      } else if (removed instanceof Text && !displaced.has(removed)) {
        if (handleDisplacedText(removed, record, now)) sawTranslatorActivity = true;
      }
    }
  }

  if (sawTranslatorActivity) flushPendingOrphans();
}

/** Synchronously fold in records the observer hasn't delivered yet. */
function drainPendingRecords(): void {
  if (observer) {
    const records = observer.takeRecords();
    guarded('record processing', () => processRecords(records), undefined);
  }
}

type RestoreResult = 'restored' | 'gone' | 'untracked';

function setTextValue(node: Text, value: string): void {
  domNatives().setData(node, value);
}

/**
 * Puts a displaced group's original nodes back into the position its
 * replacement run occupies (removing the replacements), so the caller's
 * native DOM operation can proceed on a consistent tree. A whole-parent group
 * rebuilds the parent's child list from its first child on: any node the
 * renderer appended since the merge stays after the originals.
 */
function restoreGroup(group: DisplacementGroup, skipValueFor?: Node): RestoreResult {
  const natives = domNatives();
  unregisterGroup(group);
  for (const original of group.originals) {
    // Re-adoption makes the node's DOM state authoritative again; correlation
    // entries recorded while it was displaced would poison future sequences.
    recentOldValues.delete(original.node);
    if (original.node instanceof Text) {
      recentCarrierAccumulated.delete(original.node);
      pendingCarrierOriginals.delete(original.node);
    }
  }

  const attached = group.replacement.filter((node) => node.parentNode === group.parent);
  let cursor: Node | null;
  if (group.wholeParent) {
    // Take the translator's own nodes out first: originals already in order
    // then stay where they are rather than being moved in front of them —
    // moving an element re-creates what it hosts (an iframe reloads, a
    // focused input loses focus).
    for (const node of attached) natives.removeChild.call(group.parent, node);
    cursor = group.parent.firstChild;
  } else if (attached.length > 0) {
    cursor = attached[0] ?? null;
  } else if (group.previousSiblingHint?.parentNode === group.parent) {
    cursor = group.previousSiblingHint.nextSibling;
  } else if (group.nextSiblingHint?.parentNode === group.parent) {
    cursor = group.nextSiblingHint;
  } else if (group.replacement.length === 0 && group.parent.isConnected) {
    cursor = null; // deleted run with dead hints: append to the parent
  } else {
    return 'gone';
  }

  for (const original of group.originals) {
    if (original.value !== null && original.node !== skipValueFor && original.node instanceof Text) {
      setTextValue(original.node, original.value);
    }
    if (original.node === cursor) {
      cursor = original.node.nextSibling;
      continue;
    }
    if (original.node.parentNode !== null && original.node.parentNode !== group.parent) continue;
    natives.insertBefore.call(group.parent, original.node, cursor);
  }
  for (const node of attached) {
    if (node.parentNode === group.parent && !group.originals.some((original) => original.node === node)) {
      natives.removeChild.call(group.parent, node);
    }
  }
  return 'restored';
}

function restoreDisplaced(node: Node, skipValue = false): RestoreResult {
  drainPendingRecords();
  const group = displaced.get(node);
  if (!group) return 'untracked';
  const result = restoreGroup(group, skipValue ? node : undefined);
  // The restore's own mutations are not translator activity, and read back
  // they would be misattributed: a translator-created Text node removed after
  // the originals were inserted before it looks like one the originals
  // displaced.
  observer?.takeRecords();
  return result;
}

/**
 * Whether a detached node might belong to a displacement group. Text nodes
 * always drain pending records first (a displacement may not be folded in
 * yet). Other nodes only join groups through a Firefox merge, which marks
 * translation detected and is folded in before any renderer task runs — so
 * until then, inserting an element costs nothing extra.
 */
function mayBeDisplaced(node: Node): boolean {
  return node instanceof Text || (translationDetected && displaced.has(node));
}

/**
 * Firefox's merge leaves renderer nodes attached that no longer stand for
 * their own content: a reused Text node carries its whole run's translation
 * while the rest of the run is detached, and siblings may be reordered. Any
 * renderer operation on a member of such a group restores the parent first,
 * so the operation lands on the structure the renderer built.
 */
function restoreAttachedMember(node: Node, skipValue = false): void {
  if (displaced.get(node)?.wholeParent) restoreDisplaced(node, skipValue);
}

let uninstallCurrent: (() => void) | null = null;

export interface TranslationResilienceOptions {
  document?: Document;
  /** Observability hook: called with a short message on every non-native path taken. */
  onEvent?: (message: string) => void;
  /**
   * Install the document-wide observer immediately instead of waiting for a
   * translation signal. The lazy default costs nothing until translation
   * starts, and arms on Chrome's translated-* class, on Firefox's <html lang>
   * write from outside the page, and on the translator's own <font> wrappers
   * for translators that mark nothing (Edge's built-in translator, the Google
   * Translate extension). eager remains as an escape hatch for a translator
   * that marks nothing and inserts no recognizable <font> wrapper.
   */
  eager?: boolean;
}

/**
 * Chrome's translator marks the document before it displaces any text: it
 * adds a `translated-ltr`/`translated-rtl` class to <html>, measured
 * ~275-500ms ahead of the first text mutation in real Chrome. The class VALUE
 * is checked (not just "class changed") because extensions add unrelated
 * classes to <html> on ordinary page loads.
 */
function hasTranslatedClass(doc: Document): boolean {
  return doc.documentElement.className.includes('translated-');
}

type PageWrite = <T>(write: () => T) => T;

/**
 * Shared by every copy of this package (Symbol.for), on each function it
 * installs on <html>: whether that copy is still tracking, and how to put
 * back what its wrapper replaced. See trackPageAttributeWrites.
 */
const WRAPPER_STATE = Symbol.for('translation-resilience.html-write-wrapper');

interface WrapperState {
  readonly active: boolean;
  unwrap(): void;
}

/**
 * If html[key] is a wrapper from a copy that has stopped tracking, returns
 * the function that removes it. Read defensively: the state may come from a
 * different version of this package.
 */
function inertWrapperOn(html: Element, key: string): (() => void) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(html, key);
  const fn: unknown = descriptor?.value ?? descriptor?.set;
  if (typeof fn !== 'function') return undefined;
  const state: unknown = Reflect.get(fn, WRAPPER_STATE);
  if (typeof state !== 'object' || state === null) return undefined;
  if (!('active' in state) || state.active !== false || !('unwrap' in state)) return undefined;
  const { unwrap } = state;
  if (typeof unwrap !== 'function') return undefined;
  return () => {
    unwrap.call(state);
  };
}

/**
 * Firefox's translator sets <html lang> to the target language as it starts,
 * well before it touches any text, and marks nothing else a page can see
 * cheaply. But applications write <html lang> too — i18n libraries sync it
 * when language detection resolves and on every switch (WCAG 3.1.1) — so the
 * attribute changing says nothing on its own. Where the write comes from
 * does: the page's own code reaches <html> through the page's JavaScript
 * objects, while a browser translator writes from its isolated world (Chrome,
 * Edge) or through Xray wrappers (Firefox), and neither ever sees a property
 * the page defines on an element.
 *
 * So <html> — that one instance, never Element.prototype, which would tax
 * every attribute write on the page — gets its own wrappers for each Element
 * API that writes attributes, and for the `lang` accessor. A write through a
 * wrapper is the page's own; a lang change that arrives any other way came
 * from outside the page. Writes through an Attr node, a NamedNodeMap, or a
 * prototype method called on <html> directly also count as outside. The only
 * cost of that misclassification is an observer armed early: an outside lang
 * write is never taken as evidence of translation (see translationEvident).
 *
 * A second copy of this package on the page (duplicated versions, micro
 * frontends) wraps the first copy's wrappers rather than skipping them, so
 * both see the page's writes as the page's. Every copy tags its wrappers with
 * WRAPPER_STATE, so whichever order copies go away in, the last one out
 * unwinds the others' inert wrappers too and leaves <html> as it was.
 *
 * Returns a function removing every wrapper.
 */
function trackPageAttributeWrites(html: Element, asPageWrite: PageWrite): () => void {
  let active = true;
  const restorers: Array<() => void> = [];

  /**
   * Defines html[key] as `descriptor` (whose function is `fn`), remembering
   * what was there — the prototype's, or another copy's wrapper, which ours
   * calls through to. Removal puts that back, unless another copy has since
   * wrapped ours: then ours stays, inert, until that copy unwinds it. Any
   * failure (a non-extensible <html>) leaves the key unwrapped, which only
   * means writes through it count as outside.
   */
  const replace = (key: string, descriptor: PropertyDescriptor, fn: object): void => {
    guarded(
      `<html> ${key} wrapper`,
      () => {
        const previous = Object.getOwnPropertyDescriptor(html, key);
        if (previous && !previous.configurable) return;
        const unwrap = (): void => {
          if (previous) Object.defineProperty(html, key, previous);
          else Reflect.deleteProperty(html, key);
        };
        const state: WrapperState = {
          get active() {
            return active;
          },
          unwrap,
        };
        Object.defineProperty(fn, WRAPPER_STATE, { value: state });
        Object.defineProperty(html, key, { configurable: true, enumerable: false, ...descriptor });
        restorers.push(() => {
          const current = Object.getOwnPropertyDescriptor(html, key);
          if (!current || (current.value ?? current.set) !== fn) return;
          unwrap();
          // Bounded: the wrappers beneath may come from another version of this package.
          for (let depth = 0; depth < 16; depth++) {
            const exposed = inertWrapperOn(html, key);
            if (!exposed) break;
            exposed();
          }
        });
      },
      undefined
    );
  };

  const wrap = <A extends unknown[], R>(key: string, current: ((this: Element, ...args: A) => R) | undefined): void => {
    if (typeof current !== 'function') return;
    const wrapper = function (this: Element, ...args: A): R {
      return active && this === html ? asPageWrite(() => current.call(this, ...args)) : current.call(this, ...args);
    };
    replace(key, { writable: true, value: wrapper }, wrapper);
  };
  wrap('setAttribute', html.setAttribute);
  wrap('setAttributeNS', html.setAttributeNS);
  wrap('removeAttribute', html.removeAttribute);
  wrap('removeAttributeNS', html.removeAttributeNS);
  wrap('toggleAttribute', html.toggleAttribute);
  wrap('setAttributeNode', html.setAttributeNode);
  wrap('setAttributeNodeNS', html.setAttributeNodeNS);
  wrap('removeAttributeNode', html.removeAttributeNode);

  const view = html.ownerDocument.defaultView;
  const inherited =
    view && html instanceof view.HTMLElement
      ? Object.getOwnPropertyDescriptor(view.HTMLElement.prototype, 'lang')
      : undefined;
  const lang = Object.getOwnPropertyDescriptor(html, 'lang') ?? inherited;
  const getLang = lang?.get;
  const setLang = lang?.set;
  if (getLang && setLang) {
    const set = function (this: Element, value: string): void {
      if (active && this === html) asPageWrite(() => setLang.call(this, value));
      else setLang.call(this, value);
    };
    replace('lang', { get: getLang, set }, set);
  }

  return () => {
    active = false;
    for (const restore of restorers) guarded('<html> wrapper removal', restore, undefined);
  };
}

export function installTranslationResilience(options: TranslationResilienceOptions = {}): () => void {
  if (uninstallCurrent) return uninstallCurrent;
  const natives = domNatives();
  const doc = options.document ?? document;
  emitEvent = options.onEvent ?? noopEvent;

  let teardownDetection: () => void = () => undefined;
  let stopTrackingLang: () => void = () => undefined;
  /**
   * Chrome's translator rewrites a lang the page already has, from its
   * isolated world — right after adding its class, and again after removing
   * it on "show original". Once the class has been seen, a lang write from
   * outside is Chrome's, never Firefox's signal.
   */
  let chromeMarkingSeen = hasTranslatedClass(doc);

  const activateObserver = (): void => {
    if (observer) return;
    sentinelActive = false;
    teardownDetection();
    teardownDetection = () => undefined;
    observer = new MutationObserver((records) => {
      guarded('record processing', () => processRecords(records), undefined);
    });
    observer.observe(doc, {
      childList: true,
      subtree: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeFilter: [FIREFOX_ID_ATTRIBUTE],
    });
    emitEvent('translation signal detected, observing document');
  };

  /**
   * Same-realm translators (the bundled simulator, or anything else calling
   * the patched DOM methods directly) can displace text in the same task that
   * sets the signal — before the sentinel's microtask callback runs. Real
   * Chrome translation runs in an isolated world with a large gap between
   * signal and displacement, so this synchronous fallback is only load
   * bearing for same-realm use: it reads one attribute while dormant and
   * costs a boolean check once active.
   */
  const sentinelSyncCheck = (): void => {
    if (sentinelActive && hasTranslatedClass(doc)) activateObserver();
  };

  /**
   * `pageWrite` is true for records produced inside one of the page's own
   * writes to <html>; a lang record anywhere else is a translator (Firefox)
   * starting, which it does well before it changes any text. That is also the
   * one thing that turns on recognition of Firefox's merges, so lang is
   * watched until it happens — even once something else has armed the
   * observer, and in eager mode.
   */
  const onSentinelRecords = (records: MutationRecord[], pageWrite: boolean): void => {
    if (hasTranslatedClass(doc)) chromeMarkingSeen = true;
    if (!pageWrite && !chromeMarkingSeen && records.some((record) => record.attributeName === 'lang')) {
      emitEvent('<html lang> changed from outside the page');
      firefoxSignalSeen = true;
      stopTrackingLang();
      activateObserver();
      return;
    }
    if (hasTranslatedClass(doc)) activateObserver();
  };

  /**
   * Brackets one of the page's own writes to <html>: records already queued
   * are someone else's and are handled first; the records the write itself
   * produces are taken synchronously, before the sentinel's callback could
   * see them, and handled as the page's.
   */
  const asPageWrite: PageWrite = (write) => {
    const before = sentinelObserver?.takeRecords() ?? [];
    if (before.length > 0) guarded('sentinel processing', () => onSentinelRecords(before, false), undefined);
    try {
      return write();
    } finally {
      const own = sentinelObserver?.takeRecords() ?? [];
      if (own.length > 0) guarded('sentinel processing', () => onSentinelRecords(own, true), undefined);
    }
  };

  /**
   * Not every translator marks <html> before it displaces text. Chrome's
   * built-in Google Translate does (the translated-* class above), but
   * Microsoft Edge's built-in translator and the Google Translate browser
   * extension wrap text in <font> elements WITHOUT adding a translated-* class
   * — so the attribute sentinel never fires and the shim would
   * stay dormant while the page is actively being translated, letting the
   * renderer crash exactly as it would with no shim (reported in production on
   * Edge). A <font> carrying a translator's signature (isTranslatorFontWrapper)
   * entering the tree is an unambiguous translation signal, so arm on it too.
   * Called before the native insertion runs, so the observer is watching in
   * time to record this very displacement; and translationDetected is set
   * directly, so the crash-avoidance paths engage even for a translator whose
   * mutation shape the observer does not recognise as a displacement group
   * (Edge structures its wrapping differently from Chrome). The cost while
   * dormant is a nodeName comparison per insert — far cheaper than running the
   * full observer eagerly for the whole page lifetime.
   */
  const noticeTranslatorFont = (inserted: Node): void => {
    if (translationDetected || !isTranslatorFontWrapper(inserted)) return;
    activateObserver();
    markTranslationDetected();
  };

  /**
   * The signal that actually covers real browsers. The translator inserts its
   * signature <font> from its own isolated world, which the patched methods
   * above never see, but the shared DOM raises `animationstart` for it via
   * DETECTION_CSS regardless of which world made the change.
   */
  const onDetectionAnimation = (event: AnimationEvent): void => {
    if (event.animationName !== DETECTION_ANIMATION_NAME) return;
    guarded(
      'detection animation',
      () => {
        if (translationDetected) return;
        emitEvent('translator font detected via detection stylesheet');
        activateObserver();
        markTranslationDetected();
      },
      undefined
    );
  };

  /**
   * Last line of defence, consulted only where the native call is about to
   * throw NotFoundError. Two cases reach here even with the detection
   * stylesheet installed: `animationstart` is delivered on the next style
   * update, so a renderer commit in the same task as the displacement can
   * still arrive first; and a translator that displaces text without emitting
   * a recognisable <font> raises no animation at all. Sweeping the document
   * for translator evidence at that point is what separates "a translator
   * moved this node" from a genuine renderer bug — so the shim degrades
   * gracefully on translated pages while still throwing on untranslated ones.
   * A <html lang> change from outside the page is deliberately NOT evidence:
   * it only arms the observer. Firefox's first merge marks translation
   * detected, while a write merely misattributed to outside the page (see
   * trackPageAttributeWrites) must not start masking genuine bugs.
   */
  const translationEvident = (): boolean => {
    if (translationDetected) return true;
    if (!documentShowsTranslation(doc)) return false;
    emitEvent('translation evidence found on repair path');
    activateObserver();
    markTranslationDetected();
    return true;
  };

  const sentinel = new MutationObserver((records) => {
    guarded('sentinel processing', () => onSentinelRecords(records, false), undefined);
  });
  sentinelObserver = sentinel;
  sentinel.observe(doc.documentElement, { attributes: true, attributeFilter: ['lang', 'class'] });
  const stopTrackingPageWrites = trackPageAttributeWrites(doc.documentElement, asPageWrite);
  stopTrackingLang = () => {
    stopTrackingLang = () => undefined;
    sentinel.disconnect();
    if (sentinelObserver === sentinel) sentinelObserver = null;
    stopTrackingPageWrites();
  };

  if (options.eager || hasTranslatedClass(doc)) {
    activateObserver();
  } else {
    sentinelActive = true;
    const removeStylesheet = installDetectionStylesheet(doc);
    doc.addEventListener('animationstart', onDetectionAnimation, true);
    teardownDetection = () => {
      removeStylesheet();
      doc.removeEventListener('animationstart', onDetectionAnimation, true);
    };
  }

  Node.prototype.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    sentinelSyncCheck();
    if (child.parentNode !== this) {
      const outcome = guarded(
        'removeChild repair',
        (): 'native' | 'handled' => {
          const result = mayBeDisplaced(child) ? restoreDisplaced(child) : 'untracked';
          if (result === 'gone') {
            // The displaced content is already absent, which is what this removal wanted.
            emitEvent('removeChild: displaced text already gone, removal skipped');
            return 'handled';
          }
          if (result === 'restored' && child.parentNode === this) return 'native';
          if (translationEvident()) {
            // Either translation moved this node somewhere we could not track
            // (e.g. a word-order change), or restoring it put it back under a
            // different parent. Remove it from wherever it actually is.
            emitEvent('removeChild: removing node from its actual parent');
            if (child.parentNode) natives.removeChild.call(child.parentNode, child);
            notePageMove(child);
            return 'handled';
          }
          return 'native';
        },
        'native'
      );
      if (outcome === 'handled') return child;
    } else if (translationDetected) {
      guarded('removeChild member restore', () => restoreAttachedMember(child), undefined);
    }
    natives.removeChild.call(this, child);
    notePageMove(child);
    return child;
  };

  Node.prototype.insertBefore = function insertBefore<T extends Node>(this: Node, node: T, child: Node | null): T {
    sentinelSyncCheck();
    noticeTranslatorFont(node);
    if (node.parentNode === null) {
      if (mayBeDisplaced(node)) guarded('insertBefore node repair', () => restoreDisplaced(node), 'untracked');
    } else if (translationDetected) {
      guarded('insertBefore node restore', () => restoreAttachedMember(node), undefined);
    }
    if (child && child.parentNode !== this) {
      const outcome = guarded(
        'insertBefore reference repair',
        (): 'native' | 'handled' => {
          const result = mayBeDisplaced(child) ? restoreDisplaced(child) : 'untracked';
          if (result === 'restored' && child.parentNode === this) return 'native';
          if (translationEvident()) {
            // The reference node is unrecoverable, or restoring it put it back
            // under a different parent; appending keeps the new node in the
            // right parent, which is the best position still guaranteed.
            emitEvent('insertBefore: reference gone, appending instead');
            natives.appendChild.call(this, node);
            notePageMove(node);
            return 'handled';
          }
          return 'native';
        },
        'native'
      );
      if (outcome === 'handled') return node;
    } else if (child && translationDetected) {
      guarded('insertBefore reference restore', () => restoreAttachedMember(child), undefined);
    }
    natives.insertBefore.call(this, node, child);
    notePageMove(node);
    return node;
  };

  Node.prototype.appendChild = function appendChild<T extends Node>(this: Node, node: T): T {
    sentinelSyncCheck();
    noticeTranslatorFont(node);
    if (node.parentNode === null) {
      if (mayBeDisplaced(node)) guarded('appendChild repair', () => restoreDisplaced(node), 'untracked');
    } else if (translationDetected) {
      guarded('appendChild node restore', () => restoreAttachedMember(node), undefined);
    }
    natives.appendChild.call(this, node);
    notePageMove(node);
    return node;
  };

  const restoreAfterWrite = (node: Node): void => {
    if (!(node instanceof Text)) return;
    if (node.parentNode === null) {
      guarded('text write repair', () => restoreDisplaced(node, true), 'untracked');
    } else if (translationDetected) {
      guarded('text write restore', () => restoreAttachedMember(node, true), undefined);
    }
  };

  Object.defineProperty(Node.prototype, 'nodeValue', {
    configurable: true,
    enumerable: natives.nodeValueDescriptor.enumerable,
    get: natives.nodeValueDescriptor.get,
    set(this: Node, value: string | null) {
      sentinelSyncCheck();
      natives.setNodeValue(this, value);
      restoreAfterWrite(this);
    },
  });

  Object.defineProperty(CharacterData.prototype, 'data', {
    configurable: true,
    enumerable: natives.dataDescriptor.enumerable,
    get: natives.dataDescriptor.get,
    set(this: CharacterData, value: string) {
      sentinelSyncCheck();
      natives.setData(this, value);
      restoreAfterWrite(this);
    },
  });

  uninstallCurrent = () => {
    teardownDetection();
    teardownDetection = () => undefined;
    stopTrackingLang();
    observer?.disconnect();
    observer = null;
    sentinelObserver?.disconnect();
    sentinelObserver = null;
    sentinelActive = false;
    translationDetected = false;
    firefoxSignalSeen = false;
    emitEvent = noopEvent;
    clearCorrelationState();
    Node.prototype.removeChild = natives.removeChild;
    Node.prototype.insertBefore = natives.insertBefore;
    Node.prototype.appendChild = natives.appendChild;
    Object.defineProperty(Node.prototype, 'nodeValue', natives.nodeValueDescriptor);
    Object.defineProperty(CharacterData.prototype, 'data', natives.dataDescriptor);
    uninstallCurrent = null;
  };
  return uninstallCurrent;
}
