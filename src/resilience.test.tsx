import { render } from '@testing-library/react';

import { installTranslationResilience } from './resilience';
import {
  displaceFromIsolatedWorld,
  pseudoTranslate,
  startTranslateObserver,
  translateLikeFirefox,
  translateSubtree,
} from './simulator';

// Captured before any install: DOM calls a browser translator makes, which the
// shim's patches never see.
const nativeRemoveChild = Node.prototype.removeChild;
const nativeAppendChild = Node.prototype.appendChild;
const nativeDataSetter = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data')?.set;
function nativeSetData(node: CharacterData, value: string): void {
  if (!nativeDataSetter) throw new Error('no native data setter');
  nativeDataSetter.call(node, value);
}

/** MutationObserver callbacks are delivered as microtasks; let them run. */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function RemovalCase({ show }: { show: boolean }) {
  return (
    <div>
      {show && 'There are four lights!'}
      <span>tail</span>
    </div>
  );
}

function InsertionCase({ show }: { show: boolean }) {
  return (
    <div>
      {show && <em>now you see me</em>}
      trailing text
    </div>
  );
}

function CounterCase({ count }: { count: number }) {
  return (
    <div>
      Lights: {count}
      <button type="button">increment</button>
    </div>
  );
}

function AdjacentConditionalsCase({ first, second }: { first: boolean; second: boolean }) {
  return (
    <div>
      {first && 'first part. '}
      {second && 'second part.'}
      <span>tail</span>
    </div>
  );
}

function SentenceCase({ word }: { word: string }) {
  return (
    <p>
      This is a sentence <a href="#somewhere">with a link</a> {word}
    </p>
  );
}

function findTextNode(root: Node, value: string): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue === value && node instanceof Text) return node;
    node = walker.nextNode();
  }
  return null;
}

describe('installTranslationResilience', () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installTranslationResilience();
  });

  afterEach(() => {
    uninstall();
    document.documentElement.classList.remove('translated-ltr');
    document.documentElement.removeAttribute('lang');
  });

  it('survives unmounting translated conditional text and removes its visible replacement', () => {
    const { container, rerender } = render(<RemovalCase show />);
    translateSubtree(container);
    expect(container.textContent).toContain(pseudoTranslate('There are four lights!'));

    rerender(<RemovalCase show={false} />);

    expect(container.textContent).toBe(pseudoTranslate('tail'));
  });

  it('survives mounting an element before translated text, in the right position', () => {
    const { container, rerender } = render(<InsertionCase show={false} />);
    translateSubtree(container);

    rerender(<InsertionCase show />);

    const div = container.firstElementChild;
    expect(div?.querySelector('em')).not.toBeNull();
    // The re-adopted original text follows the newly inserted element.
    expect(div?.textContent).toBe('now you see metrailing text');
  });

  it('keeps merged interpolations updating: new values reach the visible DOM', () => {
    // "Lights: " and "4" are separate React text nodes that the translator
    // merges into one run and splits into separate <font> wrappers.
    const { container, rerender } = render(<CounterCase count={4} />);
    translateSubtree(container);
    expect(container.textContent).toContain(pseudoTranslate('4'));

    rerender(<CounterCase count={5} />);

    expect(container.textContent).toContain('5');
    expect(container.textContent).not.toContain(pseudoTranslate('4'));
    // The whole merged group is restored in order: label, value, button.
    const div = container.firstElementChild;
    expect(div?.childNodes[0]?.textContent).toBe('Lights: ');
    expect(div?.childNodes[1]?.textContent).toBe('5');
    expect(div?.childNodes[2]?.nodeName).toBe('BUTTON');
  });

  it('re-translates updated values when the translator keeps observing (full loop)', async () => {
    const { container, rerender } = render(<CounterCase count={4} />);
    const stopTranslator = startTranslateObserver(container);
    try {
      translateSubtree(container);

      rerender(<CounterCase count={5} />);
      await flushMicrotasks();
      expect(container.textContent).toContain(pseudoTranslate('5'));

      rerender(<CounterCase count={6} />);
      await flushMicrotasks();
      expect(container.textContent).toContain(pseudoTranslate('6'));
      expect(container.textContent).not.toContain(pseudoTranslate('5'));
    } finally {
      stopTranslator();
    }
  });

  it('survives unmounting one of two merged adjacent conditional texts', () => {
    const { container, rerender } = render(<AdjacentConditionalsCase first second />);
    translateSubtree(container);

    rerender(<AdjacentConditionalsCase first={false} second />);

    expect(container.textContent).toContain('second part.');
    expect(container.textContent).not.toContain('first part.');
  });

  it('brings back text the translator deleted when React updates it (word-order case)', () => {
    const { container, rerender } = render(<SentenceCase word="inside" />);
    const link = container.querySelector('a');
    const wordNode = findTextNode(container, 'inside');
    const spaceNode = findTextNode(container, ' ');
    if (!link || !wordNode || !spaceNode) throw new Error('setup failed');

    // Chromium bug 872770: translation moves the link to the end and deletes
    // the trailing text nodes entirely.
    translateSubtree(container, pseudoTranslate, {
      deleteTextNodes: [spaceNode, wordNode],
      moveToParentEnd: [link],
    });
    expect(container.textContent).not.toContain('inside');

    rerender(<SentenceCase word="outside" />);

    expect(container.textContent).toContain('outside');
  });

  it('survives unmounting text the translator deleted', () => {
    const { container, rerender } = render(<RemovalCase show />);
    const conditionalText = findTextNode(container, 'There are four lights!');
    if (!conditionalText) throw new Error('setup failed');
    translateSubtree(container, pseudoTranslate, { deleteTextNodes: [conditionalText] });

    rerender(<RemovalCase show={false} />);

    expect(container.textContent).toBe(pseudoTranslate('tail'));
  });

  it('survives reverting the translation with cloned text nodes ("show original")', () => {
    const { container, rerender } = render(<CounterCase count={4} />);
    translateSubtree(container);

    // Chrome's revert swaps each wrapper back out for a text node. Simulate
    // the unfavorable variant where those are clones, not the originals.
    for (const font of Array.from(container.querySelectorAll('div > font'))) {
      font.parentNode?.replaceChild(document.createTextNode(font.textContent ?? ''), font);
    }

    rerender(<CounterCase count={5} />);

    expect(container.textContent).toContain('5');
    expect(container.textContent).not.toContain('4');
  });

  it('unmounts a translated tree cleanly', () => {
    const { container, unmount } = render(<CounterCase count={4} />);
    translateSubtree(container);
    expect(() => unmount()).not.toThrow();
    expect(container.childNodes.length).toBe(0);
  });

  it('reports translation activity through the onEvent hook exactly once', () => {
    uninstall();
    const events: string[] = [];
    uninstall = installTranslationResilience({ onEvent: (message) => events.push(message) });

    const { container, rerender } = render(<CounterCase count={4} />);
    translateSubtree(container);
    rerender(<CounterCase count={5} />);

    expect(events.filter((message) => message === 'translation activity detected')).toHaveLength(1);
  });

  it('does not mask genuine removeChild bugs', () => {
    const parent = document.createElement('div');
    const child = document.createTextNode('x');
    parent.appendChild(child);
    document.body.appendChild(parent);
    parent.removeChild(child);

    expect(() => parent.removeChild(child)).toThrow();
    document.body.removeChild(parent);
  });

  it('does not mask genuine insertBefore bugs', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const foreignRef = document.createTextNode('elsewhere');
    document.body.appendChild(foreignRef);

    expect(() => parent.insertBefore(document.createElement('span'), foreignRef)).toThrow();
    document.body.removeChild(parent);
    document.body.removeChild(foreignRef);
  });
});

/**
 * Google Translate's displacement of one text node WITHOUT the document-level
 * class/lang signals: nested `<font style="vertical-align: inherit;">` wrappers
 * around the translated text, original detached. This is the signature the
 * built-in Google Translate and its browser extension emit; the extension in
 * particular never marks <html>.
 */
function displaceViaFontOnly(textNode: Text, impostor: string): void {
  const parent = textNode.parentNode;
  if (!parent) throw new Error('text node must be attached');
  const outer = document.createElement('font');
  outer.setAttribute('style', 'vertical-align: inherit;');
  const inner = document.createElement('font');
  inner.setAttribute('style', 'vertical-align: inherit;');
  inner.appendChild(document.createTextNode(impostor));
  outer.appendChild(inner);
  parent.insertBefore(outer, textNode);
  parent.removeChild(textNode);
}

/**
 * Microsoft Edge's built-in translator displacement: a `<font>` carrying
 * `_msttexthash`/`_msthash` attributes and NO style (verified from real Edge
 * output, mdn/browser-compat-data#26188). Edge also never adds a translated-*
 * class or changes lang — so the tag's attributes are the only signal.
 */
function displaceViaEdgeFont(textNode: Text, impostor: string): void {
  const parent = textNode.parentNode;
  if (!parent) throw new Error('text node must be attached');
  const font = document.createElement('font');
  font.setAttribute('_msttexthash', '27820');
  font.setAttribute('_msthash', '1');
  font.appendChild(document.createTextNode(impostor));
  parent.insertBefore(font, textNode);
  parent.removeChild(textNode);
}

/** A plain <font> an application might render itself — no translator signature. */
function insertPlainAppFont(parent: Node, before: Node | null, text: string): void {
  const font = document.createElement('font');
  font.setAttribute('color', 'red');
  font.appendChild(document.createTextNode(text));
  parent.insertBefore(font, before);
}

describe('lazy activation', () => {
  afterEach(() => {
    document.documentElement.classList.remove('translated-ltr');
    document.documentElement.removeAttribute('lang');
  });

  it("arms on the translator's <font> wrappers even with no class or lang signal", async () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<CounterCase count={1} />);
      const textNode = findTextNode(container, '1');
      expect(textNode).not.toBeNull();
      if (!textNode) return;

      // No class/lang signal — only <font> wrappers, like Edge / the GT
      // extension. The inserted <font> is the signal that arms the observer.
      displaceViaFontOnly(textNode, 'uno');
      await flushMicrotasks();
      rerender(<CounterCase count={2} />);
      await flushMicrotasks();

      // The update reaches the visible DOM and the impostor is gone.
      expect(container.textContent).toContain('2');
      expect(container.textContent).not.toContain('uno');
    } finally {
      uninstall();
    }
  });

  it('survives React inserting an element before <font>-displaced text (no class/lang signal)', async () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<InsertionCase show={false} />);
      const trailing = findTextNode(container, 'trailing text');
      expect(trailing).not.toBeNull();
      if (!trailing) return;

      // Edge wraps the trailing text in <font> and detaches the original.
      displaceViaFontOnly(trailing, '[trailing text]');
      await flushMicrotasks();

      // Mounting <em> makes React insertBefore(em, trailing); trailing is now
      // detached. This is the production NotFoundError (reported on Edge) — the
      // shim must have armed on the <font> and restore the reference instead.
      expect(() => rerender(<InsertionCase show />)).not.toThrow();
      expect(container.querySelector('em')).not.toBeNull();
    } finally {
      uninstall();
    }
  });

  it("arms on Edge's <font> signature (_msttexthash, no class/lang/style)", async () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<CounterCase count={1} />);
      const textNode = findTextNode(container, '1');
      expect(textNode).not.toBeNull();
      if (!textNode) return;

      // Edge marks the wrapper with _msttexthash and no vertical-align style.
      displaceViaEdgeFont(textNode, 'uno');
      await flushMicrotasks();
      rerender(<CounterCase count={2} />);
      await flushMicrotasks();

      expect(container.textContent).toContain('2');
      expect(container.textContent).not.toContain('uno');
    } finally {
      uninstall();
    }
  });

  it('stays dormant when nothing that looks like translation happens', async () => {
    const events: string[] = [];
    const uninstall = installTranslationResilience({ onEvent: (message) => events.push(message) });
    try {
      const { container, rerender } = render(<CounterCase count={1} />);
      // Ordinary React churn — no <font>, no class, no lang — must not arm the
      // observer, so genuine bugs keep throwing and idle cost stays near zero.
      rerender(<CounterCase count={2} />);
      await flushMicrotasks();
      rerender(<CounterCase count={3} />);
      await flushMicrotasks();

      expect(container.textContent).toContain('3');
      expect(events).not.toContain('translation signal detected, observing document');
      expect(events).not.toContain('translation activity detected');
    } finally {
      uninstall();
    }
  });

  it("does not arm on an application's own plain <font> element", async () => {
    const events: string[] = [];
    const uninstall = installTranslationResilience({ onEvent: (message) => events.push(message) });
    try {
      const { container } = render(<CounterCase count={1} />);
      const div = container.firstElementChild;
      if (!div) throw new Error('setup failed');

      // A <font> with no translator signature (no vertical-align / _mst*) is
      // just app content — it must not arm the observer.
      insertPlainAppFont(div, div.firstChild, 'legacy');
      await flushMicrotasks();

      expect(events).not.toContain('translation signal detected, observing document');
      expect(events).not.toContain('translation activity detected');
    } finally {
      uninstall();
    }
  });

  it('tracks the same displacement with eager: true', async () => {
    const uninstall = installTranslationResilience({ eager: true });
    try {
      const { container, rerender } = render(<CounterCase count={1} />);
      const textNode = findTextNode(container, '1');
      expect(textNode).not.toBeNull();
      if (!textNode) return;

      displaceViaFontOnly(textNode, 'uno');
      await flushMicrotasks();
      rerender(<CounterCase count={2} />);
      await flushMicrotasks();

      expect(container.textContent).toContain('2');
      expect(container.textContent).not.toContain('uno');
    } finally {
      uninstall();
    }
  });

  it('stays dormant when the application writes <html lang> itself', async () => {
    const events: string[] = [];
    const uninstall = installTranslationResilience({ onEvent: (message) => events.push(message) });
    try {
      const { container, rerender } = render(<CounterCase count={1} />);

      // i18n libraries sync <html lang> (WCAG 3.1.1): once language detection
      // resolves, again on every switch, sometimes rewriting the same value.
      document.documentElement.lang = 'de';
      await flushMicrotasks();
      document.documentElement.setAttribute('lang', 'de');
      rerender(<CounterCase count={2} />);
      await flushMicrotasks();
      document.documentElement.lang = 'fr';
      await flushMicrotasks();
      rerender(<CounterCase count={3} />);
      await flushMicrotasks();
      // Every other Element API route to the attribute.
      document.documentElement.setAttributeNS(null, 'lang', 'it');
      document.documentElement.toggleAttribute('lang');
      document.documentElement.toggleAttribute('lang', true);
      document.documentElement.removeAttribute('lang');
      document.documentElement.setAttribute('LANG', 'es');
      await flushMicrotasks();

      expect(container.textContent).toContain('3');
      expect(events).not.toContain('translation signal detected, observing document');
      expect(events).not.toContain('translation activity detected');
    } finally {
      uninstall();
    }
  });

  it('leaves <html> exactly as it found it once uninstalled', () => {
    const html = document.documentElement;
    const ownBefore = Object.getOwnPropertyNames(html).sort();
    const uninstall = installTranslationResilience();
    uninstall();
    expect(Object.getOwnPropertyNames(html).sort()).toEqual(ownBefore);
  });

  it("arms on Chrome's translated-* class ahead of text it displaces from its isolated world", async () => {
    const events: string[] = [];
    const uninstall = installTranslationResilience({ onEvent: (message) => events.push(message) });
    try {
      const { container, rerender } = render(<CounterCase count={1} />);
      const textNode = findTextNode(container, '1');
      if (!textNode) throw new Error('setup failed');

      document.documentElement.lang = 'de';
      await flushMicrotasks();

      // Chrome adds the class, then rewrites the lang the page already has,
      // a few hundred ms before it touches any text.
      document.documentElement.classList.add('translated-ltr');
      document.documentElement.setAttribute('lang', 'en');
      await flushMicrotasks();
      expect(events).toContain('translation signal detected, observing document');

      displaceFromIsolatedWorld(textNode, 'one', 'google');
      await flushMicrotasks();
      rerender(<CounterCase count={2} />);
      await flushMicrotasks();

      // Armed before the displacement, so the text is re-adopted rather than
      // merely kept from crashing: the update reaches the page.
      expect(container.textContent).toContain('2');
      expect(container.textContent).not.toContain('one');
    } finally {
      uninstall();
    }
  });

  it('activates synchronously when the translated class and displacement land in the same task', () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<CounterCase count={1} />);
      const textNode = findTextNode(container, '1');
      expect(textNode).not.toBeNull();
      if (!textNode) return;

      // No microtask between the signal and the displacement - the patched
      // methods must pick the signal up synchronously, like the simulator.
      document.documentElement.classList.add('translated-ltr');
      displaceViaFontOnly(textNode, 'uno');
      rerender(<CounterCase count={2} />);

      expect(container.textContent).toContain('2');
      expect(container.textContent).not.toContain('uno');
    } finally {
      uninstall();
    }
  });

  it('activates immediately when installed on an already-translated document', () => {
    document.documentElement.classList.add('translated-ltr');
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<CounterCase count={1} />);
      const textNode = findTextNode(container, '1');
      expect(textNode).not.toBeNull();
      if (!textNode) return;

      displaceViaFontOnly(textNode, 'uno');
      rerender(<CounterCase count={2} />);

      expect(container.textContent).toContain('2');
      expect(container.textContent).not.toContain('uno');
    } finally {
      uninstall();
    }
  });
});

/**
 * The cases that matter most: a real browser translator runs in the engine's
 * isolated world, so it never calls the patched DOM methods. Every test here
 * displaces text through `displaceFromIsolatedWorld`, which uses natives
 * captured before install — the only faithful way to model that from inside a
 * single realm. Tests that displace in-realm arm the shim through a path no
 * real translator can reach, and pass even when production crashes.
 */
describe('translators running outside the patched realm (real browsers)', () => {
  afterEach(() => {
    document.documentElement.classList.remove('translated-ltr');
    document.documentElement.removeAttribute('lang');
  });

  it("survives mounting an element before text Edge's translator displaced", () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<InsertionCase show={false} />);
      const trailing = findTextNode(container, 'trailing text');
      expect(trailing).not.toBeNull();
      if (!trailing) return;

      displaceFromIsolatedWorld(trailing, 'nachlaufender Text', 'edge');

      // React mounts <em> before the trailing text it still owns: that text is
      // now detached, so the native call would throw NotFoundError.
      expect(() => rerender(<InsertionCase show />)).not.toThrow();
      expect(container.querySelector('em')).not.toBeNull();
    } finally {
      uninstall();
    }
  });

  it('survives mounting an element before text the Google Translate extension displaced', () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<InsertionCase show={false} />);
      const trailing = findTextNode(container, 'trailing text');
      if (!trailing) throw new Error('setup failed');

      displaceFromIsolatedWorld(trailing, pseudoTranslate('trailing text'), 'google');

      expect(() => rerender(<InsertionCase show />)).not.toThrow();
      expect(container.querySelector('em')).not.toBeNull();
    } finally {
      uninstall();
    }
  });

  it('survives unmounting text an out-of-realm translator displaced', () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<RemovalCase show />);
      const text = findTextNode(container, 'There are four lights!');
      if (!text) throw new Error('setup failed');

      displaceFromIsolatedWorld(text, 'Es gibt vier Lichter!', 'edge');

      expect(() => rerender(<RemovalCase show={false} />)).not.toThrow();
    } finally {
      uninstall();
    }
  });

  it('reports that it recognised the translation rather than silently swallowing', () => {
    const events: string[] = [];
    const uninstall = installTranslationResilience({ onEvent: (message) => events.push(message) });
    try {
      const { container, rerender } = render(<InsertionCase show={false} />);
      const trailing = findTextNode(container, 'trailing text');
      if (!trailing) throw new Error('setup failed');

      displaceFromIsolatedWorld(trailing, 'nachlaufender Text', 'edge');
      rerender(<InsertionCase show />);

      expect(events).toContain('translation evidence found on repair path');
      expect(events).toContain('translation activity detected');
    } finally {
      uninstall();
    }
  });

  it('still throws on a genuine insertBefore bug when no translator has touched the page', () => {
    const uninstall = installTranslationResilience();
    try {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const stranger = document.createTextNode('never attached here');

      expect(() => parent.insertBefore(document.createElement('em'), stranger)).toThrow();
      parent.remove();
    } finally {
      uninstall();
    }
  });
});

describe('restoring into a parent the caller did not ask about', () => {
  afterEach(() => {
    document.documentElement.classList.remove('translated-ltr');
    document.documentElement.removeAttribute('lang');
  });

  it('does not throw when the restored reference lands under a different parent', async () => {
    const uninstall = installTranslationResilience();
    try {
      const { container } = render(<InsertionCase show={false} />);
      const trailing = findTextNode(container, 'trailing text');
      if (!trailing) throw new Error('setup failed');

      // Tracked displacement, so restoring the node succeeds — but it is
      // restored under its own parent, not the one asked about below.
      displaceViaEdgeFont(trailing, 'nachlaufender Text');
      await flushMicrotasks();

      const elsewhere = document.createElement('div');
      document.body.appendChild(elsewhere);

      expect(() => elsewhere.insertBefore(document.createElement('em'), trailing)).not.toThrow();
      expect(elsewhere.querySelector('em')).not.toBeNull();
      elsewhere.remove();
    } finally {
      uninstall();
    }
  });
});

function TowerCase({ count }: { count: number }) {
  return <div>There are {count} lights in the tower</div>;
}

function LinkSentenceCase({ word }: { word: string }) {
  return (
    <p>
      This is a sentence <a href="#x">with a link</a> written {word}
    </p>
  );
}

function FlickerCase({ note }: { note: boolean }) {
  return (
    <div>
      Status: {4} lights are burning{note && ' and one is flickering'}
    </div>
  );
}

function KeeperCase({ badge }: { badge: boolean }) {
  return (
    <div>
      The keeper {badge && <em>chief</em>}
      {' is '}
      on duty tonight
    </div>
  );
}

function LabelCase({ label }: { label: string }) {
  return <div>{label}: 4 lights</div>;
}

function WordCase({ word }: { word: string }) {
  return <div>{word}</div>;
}

function GreetingCase({ greeting }: { greeting: string }) {
  return (
    <div>
      {greeting}
      <b>world</b>
    </div>
  );
}

/**
 * Firefox's full-page translator marks <html lang> from outside the page as it
 * starts, then applies each translation with a detach-everything-and-re-append
 * merge that leaves all but the first Text node of every run detached (see the
 * simulator's mergeLikeFirefox, pinned to a real Firefox 153 mutation log).
 */
describe('Firefox full-page translation', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('lang');
  });

  it("arms on Firefox's <html lang> write, which comes from outside the page, before any text changes", async () => {
    const events: string[] = [];
    const uninstall = installTranslationResilience({ onEvent: (message) => events.push(message) });
    try {
      const { container } = render(<TowerCase count={4} />);
      const div = container.firstElementChild;
      if (!div) throw new Error('setup failed');

      const translation = translateLikeFirefox(div);
      await flushMicrotasks();
      expect(events).toContain('<html lang> changed from outside the page');
      expect(events).toContain('translation signal detected, observing document');
      expect(div.textContent).toBe('There are 4 lights in the tower');
      await translation;
    } finally {
      uninstall();
    }
  });

  it('keeps an interpolated count updating after Firefox merges its run', async () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<TowerCase count={4} />);
      const div = container.firstElementChild;
      if (!div) throw new Error('setup failed');
      await translateLikeFirefox(div);
      expect(div.textContent).toBe(pseudoTranslate('There are 4 lights in the tower'));

      rerender(<TowerCase count={5} />);

      // The run is restored for the translator to translate again; nothing of
      // the stale translation is left behind.
      expect(div.textContent).toBe('There are 5 lights in the tower');
    } finally {
      uninstall();
    }
  });

  it('keeps text after an inline element updating', async () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<LinkSentenceCase word="today" />);
      const p = container.firstElementChild;
      if (!p) throw new Error('setup failed');
      await translateLikeFirefox(p);

      rerender(<LinkSentenceCase word="tomorrow" />);

      expect(p.textContent).toBe(`This is a sentence ${pseudoTranslate('with a link')} written tomorrow`);
      expect(p.querySelector('a')?.previousSibling?.textContent).toBe('This is a sentence ');
    } finally {
      uninstall();
    }
  });

  it('survives unmounting conditional text that Firefox dropped', async () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<FlickerCase note />);
      const div = container.firstElementChild;
      if (!div) throw new Error('setup failed');
      await translateLikeFirefox(div);

      expect(() => rerender(<FlickerCase note={false} />)).not.toThrow();
      expect(div.textContent).toBe('Status: 4 lights are burning');
    } finally {
      uninstall();
    }
  });

  it('survives mounting an element before text that Firefox dropped, in the right position', async () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<KeeperCase badge={false} />);
      const div = container.firstElementChild;
      if (!div) throw new Error('setup failed');
      await translateLikeFirefox(div);

      expect(() => rerender(<KeeperCase badge />)).not.toThrow();
      expect(div.textContent).toBe('The keeper chief is on duty tonight');
      expect(div.querySelector('em')?.nextSibling?.textContent).toBe(' is ');
    } finally {
      uninstall();
    }
  });

  it('restores the whole run when the renderer rewrites the text node carrying its translation', async () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<LabelCase label="Lights" />);
      const div = container.firstElementChild;
      if (!div) throw new Error('setup failed');
      await translateLikeFirefox(div);

      // The label node is attached, but it carries the translation of the
      // whole run — overwriting it alone would lose ": 4 lights".
      rerender(<LabelCase label="Lamps" />);

      expect(div.textContent).toBe('Lamps: 4 lights');
    } finally {
      uninstall();
    }
  });

  it('leaves text Firefox translated in place alone', async () => {
    const events: string[] = [];
    const uninstall = installTranslationResilience({ onEvent: (message) => events.push(message) });
    try {
      const { container, rerender } = render(<WordCase word="today" />);
      const div = container.firstElementChild;
      const word = div?.firstChild;
      if (!div || !word) throw new Error('setup failed');
      await translateLikeFirefox(div);
      expect(div.firstChild).toBe(word);
      expect(events).toContain('translation activity detected');

      rerender(<WordCase word="tomorrow" />);

      expect(div.textContent).toBe('tomorrow');
      expect(div.firstChild).toBe(word);
    } finally {
      uninstall();
    }
  });

  it('removes text nodes Firefox added when it restores', async () => {
    const uninstall = installTranslationResilience();
    try {
      const { container, rerender } = render(<GreetingCase greeting="Hello " />);
      const div = container.firstElementChild;
      const greeting = div?.firstChild;
      const bold = div?.lastChild;
      if (!div || !(greeting instanceof Text) || !bold) throw new Error('setup failed');

      // The engine's translation can hold more text nodes than the original:
      // Firefox appends the extras as new nodes the renderer knows nothing of.
      await translateLikeFirefox(div, (text) => text);
      nativeRemoveChild.call(div, greeting);
      nativeRemoveChild.call(div, bold);
      nativeSetData(greeting, 'Bonjour ');
      nativeAppendChild.call(div, greeting);
      nativeAppendChild.call(div, bold);
      nativeAppendChild.call(div, document.createTextNode(' !'));
      await flushMicrotasks();
      expect(div.textContent).toBe('Bonjour world !');

      rerender(<GreetingCase greeting="Hi " />);

      expect(div.textContent).toBe('Hi world');
    } finally {
      uninstall();
    }
  });

  it("does not mistake the renderer's own child replacement and reordering for a Firefox merge", async () => {
    const events: string[] = [];
    const uninstall = installTranslationResilience({ eager: true, onEvent: (message) => events.push(message) });
    try {
      function Swap({ items, text }: { items: string[]; text: boolean }) {
        return (
          <div>
            {text ? 'first part. ' : <b>bold</b>}
            {text ? 'second part.' : <i>italic</i>}
            <ul>
              {items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        );
      }
      const { rerender } = render(<Swap items={['a', 'b', 'c']} text />);
      rerender(<Swap items={['c', 'b', 'a']} text={false} />);
      await flushMicrotasks();
      rerender(<Swap items={['b', 'c', 'a']} text />);
      await flushMicrotasks();

      expect(events).not.toContain('translation activity detected');
    } finally {
      uninstall();
    }
  });
});
