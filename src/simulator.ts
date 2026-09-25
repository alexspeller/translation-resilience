/**
 * Simulates the DOM mutations Chrome / Google Translate performs when
 * translating a page, so tests can reproduce the well-known class of React
 * crashes and stale-text bugs without a real browser translation session.
 *
 * Mutation shape, cross-verified from facebook/react#11538 (incl. the verbatim
 * Chromium bug 872770 analysis in comment 59) and
 * https://martijnhols.nl/blog/everything-about-google-translate-crashing-react:
 *
 *  1. Adjacent Text nodes are merged first (`normalize()`), so several
 *     renderer-owned text nodes can collapse into one run.
 *  2. Each run is split into segments (numbers get isolated into their own
 *     segment), and every segment becomes a nested double
 *     `<font style="vertical-align: inherit;">` wrapper around a NEW text
 *     node with the translated content.
 *  3. The wrappers are inserted before the original text node, then the
 *     original is REMOVED — it stays alive in memory (renderers still hold
 *     references) but has parentNode === null.
 *  4. Translation can also delete text nodes outright and move inline
 *     elements to match target-language word order (Chromium bug 872770).
 *  5. Comment nodes are never touched.
 *  6. A MutationObserver keeps watching the page and translates content that
 *     appears or changes later.
 *  7. BEFORE any text is touched, the document is marked: a `translated-ltr`
 *     class and a `lang` flip on <html> (class first, then lang — verified
 *     empirically against real Chrome, where both land ~275-500ms ahead of
 *     the first displacement mutation).
 */

export function pseudoTranslate(text: string): string {
  return `[${text}]`;
}

export type TranslateFn = (text: string) => string;

export interface TranslateOptions {
  /** Text nodes the "translation" deletes outright (no replacement). */
  deleteTextNodes?: Text[];
  /** Inline elements moved to the end of their parent (word-order change). */
  moveToParentEnd?: Element[];
}

/** Inner text nodes created by the simulator (already-translated content). */
const simulatorOwnedTextNodes = new WeakSet<Text>();

function isText(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

function hasTranslatableContent(node: Text): boolean {
  return /\S/.test(node.nodeValue ?? '');
}

function isInsideFont(node: Node): boolean {
  let current: Node | null = node.parentNode;
  while (current) {
    if (current.nodeName === 'FONT') return true;
    current = current.parentNode;
  }
  return false;
}

function createFontWrapper(translatedText: string): HTMLElement {
  const outer = document.createElement('font');
  outer.setAttribute('style', 'vertical-align: inherit;');
  const inner = document.createElement('font');
  inner.setAttribute('style', 'vertical-align: inherit;');
  const translatedNode = document.createTextNode(translatedText);
  simulatorOwnedTextNodes.add(translatedNode);
  inner.appendChild(translatedNode);
  outer.appendChild(inner);
  return outer;
}

/** Numbers are isolated into their own segment, like the real translator. */
function splitIntoSegments(text: string): string[] {
  return text.split(/(\d+)/).filter((segment) => segment !== '');
}

/**
 * Replaces a single text node with translated <font> wrappers, exactly the
 * way Google Translate does: insert the wrappers, then detach the original.
 */
function translateTextNode(textNode: Text, translate: TranslateFn): void {
  const parent = textNode.parentNode;
  if (!parent) return;
  for (const segment of splitIntoSegments(textNode.nodeValue ?? '')) {
    parent.insertBefore(createFontWrapper(translate(segment)), textNode);
  }
  parent.removeChild(textNode);
}

function collectTranslatableTextNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const result: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if (isText(node) && hasTranslatableContent(node) && !isInsideFont(node) && !simulatorOwnedTextNodes.has(node)) {
      result.push(node);
    }
    node = walker.nextNode();
  }
  return result;
}

/**
 * Spec-equivalent Node.normalize(): merge each run of adjacent Text siblings
 * into the first node of the run and remove the rest. Done with explicit DOM
 * operations (rather than calling normalize()) so the MutationRecords emitted
 * are deterministic across DOM implementations.
 */
function mergeAdjacentTextNodes(parent: Node): void {
  let child = parent.firstChild;
  while (child) {
    if (isText(child)) {
      let next = child.nextSibling;
      while (next && isText(next)) {
        const after = next.nextSibling;
        child.nodeValue = (child.nodeValue ?? '') + (next.nodeValue ?? '');
        parent.removeChild(next);
        next = after;
      }
    }
    child = child.nextSibling;
  }
}

function normalizeSubtree(root: Node): void {
  const base = isText(root) ? (root.parentNode ?? root) : root;
  mergeAdjacentTextNodes(base);
  const walker = document.createTreeWalker(base, NodeFilter.SHOW_ELEMENT);
  let element = walker.nextNode();
  while (element) {
    mergeAdjacentTextNodes(element);
    element = walker.nextNode();
  }
}

/**
 * Marks the document the way Chrome's translator does before touching any
 * text: a `translated-ltr` class and a `lang` flip on <html>. Emitting these
 * first lets lazily-activating consumers (like translation-resilience
 * itself) arm before displacement begins.
 */
function emitTranslationSignals(root: Node): void {
  const doc = root.ownerDocument ?? (root instanceof Document ? root : document);
  const html = doc.documentElement;
  if (!html.classList.contains('translated-ltr')) html.classList.add('translated-ltr');
  if (html.getAttribute('lang') !== 'x-pseudo') html.setAttribute('lang', 'x-pseudo');
}

/** One-shot translation pass over a subtree, like the initial page translate. */
export function translateSubtree(
  root: Node,
  translate: TranslateFn = pseudoTranslate,
  options: TranslateOptions = {}
): void {
  emitTranslationSignals(root);
  for (const textNode of options.deleteTextNodes ?? []) {
    textNode.parentNode?.removeChild(textNode);
  }
  normalizeSubtree(root);
  for (const textNode of collectTranslatableTextNodes(root)) {
    translateTextNode(textNode, translate);
  }
  if (isText(root) && hasTranslatableContent(root) && !isInsideFont(root) && !simulatorOwnedTextNodes.has(root)) {
    translateTextNode(root, translate);
  }
  for (const element of options.moveToParentEnd ?? []) {
    element.parentNode?.appendChild(element);
  }
}

/**
 * Models Google Translate's ongoing observation of the page: newly inserted
 * text gets translated (including a fresh normalize pass over its parent,
 * merging adjacent restored text nodes); text that changes inside an existing
 * <font> wrapper is re-translated in place.
 *
 * Returns a stop function.
 */
export function startTranslateObserver(root: Node, translate: TranslateFn = pseudoTranslate): () => void {
  const observer = new MutationObserver((records) => {
    const parentsToTranslate = new Set<Node>();
    for (const record of records) {
      if (record.type === 'childList') {
        for (const added of record.addedNodes) {
          if (isText(added) && simulatorOwnedTextNodes.has(added)) continue;
          if (isInsideFont(added)) {
            if (isText(added) && hasTranslatableContent(added)) {
              added.nodeValue = translate(added.nodeValue ?? '');
              simulatorOwnedTextNodes.add(added);
            }
          } else if (isText(added)) {
            if (hasTranslatableContent(added) && added.parentNode) parentsToTranslate.add(added.parentNode);
          } else {
            parentsToTranslate.add(added);
          }
        }
      } else if (record.type === 'characterData') {
        const target = record.target;
        if (
          isText(target) &&
          !simulatorOwnedTextNodes.has(target) &&
          isInsideFont(target) &&
          hasTranslatableContent(target)
        ) {
          target.nodeValue = translate(target.nodeValue ?? '');
          simulatorOwnedTextNodes.add(target);
        }
      }
    }
    for (const parent of parentsToTranslate) {
      if (parent.isConnected) translateSubtree(parent, translate);
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

/**
 * Native DOM entry points, captured when this module is first imported — that
 * is, before `installTranslationResilience` patches `Node.prototype`.
 *
 * A real page translator (Chrome's, Edge's, the Google Translate extension)
 * runs in the browser engine's own *isolated world*: it shares the DOM but
 * holds a separate copy of `Node.prototype`, so none of the shim's patched
 * methods ever observe its mutations. Calling these captured natives
 * reproduces exactly that constraint inside a single realm.
 *
 * This distinction decides whether a test is meaningful. A simulator that
 * displaces text through the live prototype methods arms the shim through a
 * path no real translator can reach, so it passes whether or not the shim
 * would survive a real translation — which is how a whole class of production
 * crash stayed green in CI. Displace through these instead.
 */
const nativeDataSetter = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data')?.set;

const nativeDom = {
  insertBefore: Node.prototype.insertBefore,
  removeChild: Node.prototype.removeChild,
  appendChild: Node.prototype.appendChild,
  setAttribute: Element.prototype.setAttribute,
  removeAttribute: Element.prototype.removeAttribute,
  setData(node: CharacterData, value: string): void {
    if (!nativeDataSetter) throw new Error('simulator: CharacterData.prototype.data has no setter');
    nativeDataSetter.call(node, value);
  },
};

/** Which browser's wrapper markup to emit. */
export type TranslatorSignature = 'google' | 'edge';

/**
 * Built entirely through the captured natives — including while assembling the
 * wrapper off-document. Using the live `appendChild` here would call the
 * shim's patched method with a signature <font>, arming it through the very
 * path a real translator cannot reach, and the test would pass for the wrong
 * reason.
 */
function createSignatureWrapper(translatedText: string, signature: TranslatorSignature): HTMLElement {
  const translatedNode = document.createTextNode(translatedText);
  simulatorOwnedTextNodes.add(translatedNode);

  if (signature === 'google') {
    // Chrome's translator and its extension: doubly nested
    // <font style="vertical-align: inherit;">.
    const outer = document.createElement('font');
    outer.setAttribute('style', 'vertical-align: inherit;');
    const inner = document.createElement('font');
    inner.setAttribute('style', 'vertical-align: inherit;');
    nativeDom.appendChild.call(inner, translatedNode);
    nativeDom.appendChild.call(outer, inner);
    return outer;
  }

  // Edge's built-in translator: a <font> carrying _msttexthash/_msthash and no
  // style, and no `translated-*` class or `lang` flip on <html> at all.
  const font = document.createElement('font');
  font.setAttribute('_msttexthash', '27820');
  font.setAttribute('_msthash', '1');
  nativeDom.appendChild.call(font, translatedNode);
  return font;
}

/**
 * Displaces one text node the way a real translator does — wrapper in, original
 * out — using only the captured natives, so the shim's patched methods never
 * see the operation. This is the faithful reproduction of a browser
 * translator; `translateSubtree` is the same mutation shape performed in-realm.
 *
 * Returns the wrapper now standing in for the original.
 */
export function displaceFromIsolatedWorld(
  textNode: Text,
  translatedText: string = pseudoTranslate(textNode.nodeValue ?? ''),
  signature: TranslatorSignature = 'google'
): HTMLElement {
  const parent = textNode.parentNode;
  if (!parent) throw new Error('displaceFromIsolatedWorld: text node must be attached');
  const wrapper = createSignatureWrapper(translatedText, signature);
  nativeDom.insertBefore.call(parent, wrapper, textNode);
  nativeDom.removeChild.call(parent, textNode);
  return wrapper;
}

/**
 * Firefox's full-page translator (translations-document.sys.mjs) sends an
 * element's content to its engine as one piece — adjacent Text nodes
 * serialise into a single run of text — and applies the result with its
 * `merge()`: every child is detached, first to last; then the translated
 * nodes are appended in order, reusing the element's live Text nodes BY
 * POSITION (their data overwritten) and its live elements by identity, each
 * merged recursively before it is re-appended. A run of several renderer Text
 * nodes comes back as one translated text, so the first node of the run
 * carries the whole translation and the rest are never re-appended: they stay
 * detached while the renderer still holds them.
 *
 * Like the other out-of-world helpers, this uses DOM natives captured at
 * import: Firefox applies translations through Xray wrappers, which never see
 * a page's prototype patches.
 *
 * One deliberate difference in ordering: Firefox overwrites a reused Text
 * node, and merges a child element, while it is detached, and browsers report
 * those mutations to page observers through the DOM's transient registered
 * observers. jsdom does not implement transient observers, so it would never
 * report them. Here each node is overwritten or merged just after it is
 * re-appended instead: every parent's own record sequence and the final DOM
 * are the same, and jsdom sees every mutation a browser would report.
 */
export function mergeLikeFirefox(element: Element, translate: TranslateFn = pseudoTranslate): void {
  mergeChildren(element, translate);
  for (const tagged of element.querySelectorAll(`[${FIREFOX_ID_ATTRIBUTE}]`)) {
    nativeDom.removeAttribute.call(tagged, FIREFOX_ID_ATTRIBUTE);
  }
}

/**
 * Firefox tags the elements inside a block it sends to its engine, so it can
 * match them up with the translated markup, and removes the tags when it
 * merges. Blocks of plain text carry none.
 */
const FIREFOX_ID_ATTRIBUTE = 'data-moz-translations-id';

function mergeChildren(element: Element, translate: TranslateFn): void {
  const children = [...element.childNodes];
  const translated: Array<string | Element> = [];
  let run = '';
  const endRun = (): void => {
    if (run === '') return;
    translated.push(/\S/.test(run) ? translate(run) : run);
    run = '';
  };
  for (const child of children) {
    if (isText(child)) {
      run += child.data;
    } else if (child instanceof Element) {
      endRun();
      translated.push(child);
    }
  }
  endRun();

  const liveTextNodes = children.filter(isText);
  let first = element.firstChild;
  while (first) {
    nativeDom.removeChild.call(element, first);
    first = element.firstChild;
  }
  for (const item of translated) {
    if (typeof item === 'string') {
      const reused = liveTextNodes.shift();
      if (reused) {
        nativeDom.appendChild.call(element, reused);
        nativeDom.setData(reused, item);
      } else {
        const created = document.createTextNode(item);
        simulatorOwnedTextNodes.add(created);
        nativeDom.appendChild.call(element, created);
      }
    } else {
      nativeDom.appendChild.call(element, item);
      if (/\S/.test(item.textContent ?? '')) mergeChildren(item, translate);
    }
  }
}

/**
 * The whole of a Firefox page translation of `element`, in the order a real
 * one happens: `<html lang>` is set to the target language from outside the
 * page's JavaScript world as translation starts, the elements inside the
 * block are tagged as it is sent to the engine, and the translation arrives
 * later, from the engine running in another process — so the merge happens in
 * a later task.
 */
export async function translateLikeFirefox(
  element: Element,
  translate: TranslateFn = pseudoTranslate,
  targetLanguage = 'x-pseudo'
): Promise<void> {
  const doc = element.ownerDocument;
  nativeDom.setAttribute.call(doc.documentElement, 'lang', targetLanguage);
  element.querySelectorAll('*').forEach((descendant, index) => {
    nativeDom.setAttribute.call(descendant, FIREFOX_ID_ATTRIBUTE, String(index));
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  mergeLikeFirefox(element, translate);
}
