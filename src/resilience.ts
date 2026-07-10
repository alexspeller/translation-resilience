/**
 * Makes React (and any other text-node-owning renderer) resilient to browser
 * page translation (Chrome / Google Translate), which merges and replaces
 * Text nodes with `<font>` wrappers. React keeps references to the original,
 * now detached, Text nodes, so without this shim:
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
 * Before any translation activity is detected, operations on untracked nodes
 * behave exactly as before — including throwing on genuine bugs.
 */

interface DisplacedOriginal {
  node: Text;
  /** The node's value before translation touched it (normalize mutates the merge target). */
  value: string;
}

interface DisplacementGroup {
  parent: Node;
  /** Renderer-owned text nodes this group stands in for, in document order. */
  originals: DisplacedOriginal[];
  /** Nodes currently displaying the originals' content (empty if translation deleted the run). */
  replacement: Node[];
  /** Position hints captured at removal time, used when `replacement` is empty. */
  previousSiblingHint: Node | null;
  nextSiblingHint: Node | null;
}

const displaced = new WeakMap<Text, DisplacementGroup>();
const groupByReplacementNode = new WeakMap<Node, DisplacementGroup>();
/** Live merge targets (normalize) carrying content of already-detached originals. */
const pendingCarrierOriginals = new WeakMap<Text, DisplacedOriginal[]>();

let observer: MutationObserver | null = null;
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
function guarded<T>(operation: string, run: () => T, fallback: T): T {
  try {
    return run();
  } catch (error) {
    emitEvent(`internal error in ${operation}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

function registerGroup(group: DisplacementGroup): void {
  if (!translationDetected) {
    translationDetected = true;
    emitEvent('translation activity detected');
  }
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
    if (now - entry.at > CORRELATION_WINDOW_MS) recentInsertedBefore.delete(key);
  }
  for (const [key, entry] of recentOldValues) {
    if (now - entry.at > CORRELATION_WINDOW_MS) recentOldValues.delete(key);
  }
  for (const [key, entry] of recentCarrierAccumulated) {
    if (now - entry.at > CORRELATION_WINDOW_MS) recentCarrierAccumulated.delete(key);
  }
  pendingOrphans = pendingOrphans.filter((orphan) => now - orphan.at <= CORRELATION_WINDOW_MS);
}

function clearCorrelationState(): void {
  recentInsertedBefore.clear();
  recentOldValues.clear();
  recentCarrierAccumulated.clear();
  pendingOrphans = [];
}

/** Replacement nodes a translator produces: <font> wrappers or plain text (revert). */
function looksLikeTranslatorReplacement(node: Node): boolean {
  return node instanceof Text || node.nodeName === 'FONT';
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
    };
    pendingCarrierOriginals.delete(orphan.removed);
    registerGroup(group);
  }
  pendingOrphans = [];
}

function processRecords(records: MutationRecord[]): void {
  if (records.length === 0) return;
  const now = performance.now();
  purgeExpired(now);

  let sawTranslatorActivity = false;
  for (const record of records) {
    if (record.type === 'childList') {
      for (const added of record.addedNodes) {
        if (added.nodeName === 'FONT') sawTranslatorActivity = true;
        if (record.nextSibling) {
          const entry = recentInsertedBefore.get(record.nextSibling) ?? { at: now, nodes: [] };
          entry.at = now;
          entry.nodes.push(added);
          recentInsertedBefore.set(record.nextSibling, entry);
        }
      }
    } else if (record.type === 'characterData' && record.oldValue !== null && !recentOldValues.has(record.target)) {
      recentOldValues.set(record.target, { at: now, value: record.oldValue });
    }
  }

  for (const record of records) {
    if (record.type !== 'childList') continue;
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
 * Puts a displaced group's original text nodes back into the position its
 * replacement run occupies (removing the replacements), so the caller's
 * native DOM operation can proceed on a consistent tree.
 */
function restoreGroup(group: DisplacementGroup, skipValueFor?: Text): RestoreResult {
  const natives = domNatives();
  unregisterGroup(group);
  for (const original of group.originals) {
    // Re-adoption makes the node's DOM state authoritative again; correlation
    // entries recorded while it was displaced would poison future sequences.
    recentOldValues.delete(original.node);
    recentCarrierAccumulated.delete(original.node);
    pendingCarrierOriginals.delete(original.node);
  }

  const attached = group.replacement.filter((node) => node.parentNode === group.parent);
  let cursor: Node | null;
  if (attached.length > 0) {
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
    if (original.node !== skipValueFor) setTextValue(original.node, original.value);
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

function restoreDisplaced(node: Text, skipValue = false): RestoreResult {
  drainPendingRecords();
  const group = displaced.get(node);
  if (!group) return 'untracked';
  return restoreGroup(group, skipValue ? node : undefined);
}

let uninstallCurrent: (() => void) | null = null;

export interface TranslationResilienceOptions {
  document?: Document;
  /** Observability hook: called with a short message on every non-native path taken. */
  onEvent?: (message: string) => void;
}

export function installTranslationResilience(options: TranslationResilienceOptions = {}): () => void {
  if (uninstallCurrent) return uninstallCurrent;
  const natives = domNatives();
  const doc = options.document ?? document;
  emitEvent = options.onEvent ?? noopEvent;

  observer = new MutationObserver((records) => {
    guarded('record processing', () => processRecords(records), undefined);
  });
  observer.observe(doc, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });

  Node.prototype.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      const outcome = guarded(
        'removeChild repair',
        (): 'native' | 'handled' => {
          const result = child instanceof Text ? restoreDisplaced(child) : 'untracked';
          if (result === 'gone') {
            // The displaced content is already absent, which is what this removal wanted.
            emitEvent('removeChild: displaced text already gone, removal skipped');
            return 'handled';
          }
          if (result === 'untracked' && translationDetected) {
            // Translation moved this node somewhere we could not track (e.g. a
            // word-order change). Remove it from wherever it actually is.
            emitEvent('removeChild: removing node from its actual parent');
            if (child.parentNode) natives.removeChild.call(child.parentNode, child);
            return 'handled';
          }
          return 'native';
        },
        'native'
      );
      if (outcome === 'handled') return child;
    }
    natives.removeChild.call(this, child);
    return child;
  };

  Node.prototype.insertBefore = function insertBefore<T extends Node>(this: Node, node: T, child: Node | null): T {
    if (node instanceof Text && node.parentNode === null) {
      guarded('insertBefore node repair', () => restoreDisplaced(node), 'untracked');
    }
    if (child && child.parentNode !== this) {
      const outcome = guarded(
        'insertBefore reference repair',
        (): 'native' | 'handled' => {
          const result = child instanceof Text ? restoreDisplaced(child) : 'untracked';
          if (result !== 'restored' && translationDetected) {
            // The reference node is unrecoverable; appending keeps the new node
            // in the right parent, which is the best position still guaranteed.
            emitEvent('insertBefore: reference gone, appending instead');
            natives.appendChild.call(this, node);
            return 'handled';
          }
          return 'native';
        },
        'native'
      );
      if (outcome === 'handled') return node;
    }
    natives.insertBefore.call(this, node, child);
    return node;
  };

  Node.prototype.appendChild = function appendChild<T extends Node>(this: Node, node: T): T {
    if (node instanceof Text && node.parentNode === null) {
      guarded('appendChild repair', () => restoreDisplaced(node), 'untracked');
    }
    natives.appendChild.call(this, node);
    return node;
  };

  const restoreAfterWrite = (node: Node): void => {
    if (node instanceof Text && node.parentNode === null) {
      guarded('text write repair', () => restoreDisplaced(node, true), 'untracked');
    }
  };

  Object.defineProperty(Node.prototype, 'nodeValue', {
    configurable: true,
    enumerable: natives.nodeValueDescriptor.enumerable,
    get: natives.nodeValueDescriptor.get,
    set(this: Node, value: string | null) {
      natives.setNodeValue(this, value);
      restoreAfterWrite(this);
    },
  });

  Object.defineProperty(CharacterData.prototype, 'data', {
    configurable: true,
    enumerable: natives.dataDescriptor.enumerable,
    get: natives.dataDescriptor.get,
    set(this: CharacterData, value: string) {
      natives.setData(this, value);
      restoreAfterWrite(this);
    },
  });

  uninstallCurrent = () => {
    observer?.disconnect();
    observer = null;
    translationDetected = false;
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
