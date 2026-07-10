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

/** One-shot translation pass over a subtree, like the initial page translate. */
export function translateSubtree(
  root: Node,
  translate: TranslateFn = pseudoTranslate,
  options: TranslateOptions = {}
): void {
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
