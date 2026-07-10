import { render } from '@testing-library/react';

import { pseudoTranslate, translateSubtree } from './simulator';

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
