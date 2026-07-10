import { render } from '@testing-library/react';

import { installTranslationResilience } from './resilience';
import { pseudoTranslate, startTranslateObserver, translateSubtree } from './simulator';

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
