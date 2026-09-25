import { render } from '@testing-library/react';

import { mergeLikeFirefox, pseudoTranslate, translateLikeFirefox, translateSubtree } from './simulator';

/**
 * These tests verify the simulator faithfully reproduces the documented,
 * real-world failure modes that browser page translation causes for React
 * (see https://github.com/facebook/react/issues/11538). They intentionally
 * exercise an UNPATCHED react-dom: if React or our mitigation ever makes
 * these scenarios safe, the assertions on the failure modes below will fail
 * and the simulator (or the mitigation's tests) should be revisited.
 */

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

function captureThrown(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
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

describe('googleTranslate simulator fidelity', () => {
  afterEach(() => {
    document.documentElement.classList.remove('translated-ltr');
    document.documentElement.removeAttribute('lang');
  });

  it('marks the document like Chrome does before touching any text', () => {
    const { container } = render(<CounterCase count={4} />);
    expect(document.documentElement.classList.contains('translated-ltr')).toBe(false);

    translateSubtree(container);

    expect(document.documentElement.classList.contains('translated-ltr')).toBe(true);
    expect(document.documentElement.getAttribute('lang')).toBe('x-pseudo');
  });

  it('replaces text nodes with nested font wrappers and detaches the originals', () => {
    const { container } = render(<CounterCase count={4} />);
    const original = findTextNode(container, '4');
    expect(original).not.toBeNull();

    translateSubtree(container);

    expect(container.querySelectorAll('font font').length).toBeGreaterThan(0);
    expect(container.textContent).toContain(pseudoTranslate('4'));
    expect(original?.parentNode).toBeNull();
  });

  it('merges adjacent text nodes and isolates numbers into separate font wrappers', () => {
    const { container } = render(<CounterCase count={4} />);
    const label = findTextNode(container, 'Lights: ');
    const count = findTextNode(container, '4');

    translateSubtree(container);

    const div = container.firstElementChild;
    // "Lights: " and "4" merged into one run, then split at the number: two
    // sibling font wrappers, both original nodes detached.
    expect(div?.childNodes[0]?.nodeName).toBe('FONT');
    expect(div?.childNodes[1]?.nodeName).toBe('FONT');
    expect(div?.childNodes[0]?.textContent).toBe(pseudoTranslate('Lights: '));
    expect(div?.childNodes[1]?.textContent).toBe(pseudoTranslate('4'));
    expect(label?.parentNode).toBeNull();
    expect(count?.parentNode).toBeNull();
  });

  it('leaves comment nodes untouched', () => {
    const { container } = render(<CounterCase count={4} />);
    const comment = document.createComment('marker');
    container.firstElementChild?.appendChild(comment);

    translateSubtree(container);

    expect(comment.parentNode).toBe(container.firstElementChild);
  });

  it('control: without translation, conditional text removal works fine', () => {
    const { container, rerender } = render(<RemovalCase show />);
    rerender(<RemovalCase show={false} />);
    expect(container.textContent).toBe('tail');
  });

  it('reproduces the removeChild NotFoundError crash when translated conditional text unmounts', () => {
    const { container, rerender } = render(<RemovalCase show />);
    translateSubtree(container);

    const thrown = captureThrown(() => rerender(<RemovalCase show={false} />));
    expect(thrown).toBeInstanceOf(DOMException);
    expect(thrown).toHaveProperty('name', 'NotFoundError');
  });

  it('reproduces the insertBefore NotFoundError crash when mounting before translated text', () => {
    const { container, rerender } = render(<InsertionCase show={false} />);
    translateSubtree(container);

    const thrown = captureThrown(() => rerender(<InsertionCase show />));
    expect(thrown).toBeInstanceOf(DOMException);
    expect(thrown).toHaveProperty('name', 'NotFoundError');
  });

  it('reproduces silent stale text: updates go to the detached node and never reach the screen', () => {
    const { container, rerender } = render(<CounterCase count={4} />);
    const original = findTextNode(container, '4');
    translateSubtree(container);

    rerender(<CounterCase count={5} />);

    // React wrote the new value into the detached text node...
    expect(original?.nodeValue).toBe('5');
    // ...but the visible DOM still shows the stale translated value.
    expect(container.textContent).toContain(pseudoTranslate('4'));
    expect(container.textContent).not.toContain('5');
  });
});

function SentenceCase({ count }: { count: number }) {
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

/**
 * Pinned to what real Firefox 153 does (mutation log recorded against a React
 * 18 page): the element is emptied first to last, the first Text node of each
 * run is reused to carry the run's whole translation, and the rest of the run
 * is never re-appended.
 */
describe('Firefox simulator fidelity', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('lang');
  });

  it('sets <html lang> to the target language before any text changes', async () => {
    const { container } = render(<SentenceCase count={4} />);
    const div = container.firstElementChild;
    if (!div) throw new Error('setup failed');
    const before = div.innerHTML;

    const pending = translateLikeFirefox(div);
    expect(document.documentElement.getAttribute('lang')).toBe('x-pseudo');
    expect(div.innerHTML).toBe(before);
    await pending;
    expect(div.textContent).toBe(pseudoTranslate('There are 4 lights in the tower'));
  });

  it('empties the element first to last, then appends the reused and translated nodes', () => {
    const { container } = render(<LinkSentenceCase word="today" />);
    const p = container.firstElementChild;
    if (!p) throw new Error('setup failed');
    const [lead, link, written, word] = [...p.childNodes];
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(p, { childList: true, subtree: true, characterData: true });

    mergeLikeFirefox(p);
    records.push(...observer.takeRecords());
    observer.disconnect();

    const onP = records.filter((record) => record.target === p);
    const removals = onP.filter((record) => record.removedNodes.length > 0);
    expect(removals.map((record) => record.removedNodes[0])).toEqual([lead, link, written, word]);
    expect(removals.every((record) => record.previousSibling === null)).toBe(true);
    expect(removals[removals.length - 1]?.nextSibling).toBeNull();
    const appends = onP.filter((record) => record.addedNodes.length > 0);
    expect(appends.map((record) => record.addedNodes[0])).toEqual([lead, link, written]);
    expect(appends.every((record) => record.nextSibling === null)).toBe(true);

    expect([...p.childNodes]).toEqual([lead, link, written]);
    expect(written?.textContent).toBe(pseudoTranslate(' written today'));
    expect(word?.parentNode).toBeNull();
  });

  it('reproduces silent stale text: an interpolation merged into its run never updates', async () => {
    const { container, rerender } = render(<SentenceCase count={4} />);
    const div = container.firstElementChild;
    if (!div) throw new Error('setup failed');
    const count = findTextNode(div, '4');

    await translateLikeFirefox(div);
    rerender(<SentenceCase count={5} />);

    expect(count?.nodeValue).toBe('5');
    expect(count?.parentNode).toBeNull();
    expect(div.textContent).toBe(pseudoTranslate('There are 4 lights in the tower'));
  });

  it('reproduces the removeChild NotFoundError when conditional text Firefox dropped unmounts', async () => {
    const { container, rerender } = render(<FlickerCase note />);
    const div = container.firstElementChild;
    if (!div) throw new Error('setup failed');
    await translateLikeFirefox(div);

    const thrown = captureThrown(() => rerender(<FlickerCase note={false} />));
    expect(thrown).toBeInstanceOf(DOMException);
    expect(thrown).toHaveProperty('name', 'NotFoundError');
  });

  it('reproduces the insertBefore NotFoundError when mounting before text Firefox dropped', async () => {
    const { container, rerender } = render(<KeeperCase badge={false} />);
    const div = container.firstElementChild;
    if (!div) throw new Error('setup failed');
    await translateLikeFirefox(div);

    const thrown = captureThrown(() => rerender(<KeeperCase badge />));
    expect(thrown).toBeInstanceOf(DOMException);
    expect(thrown).toHaveProperty('name', 'NotFoundError');
  });
});
