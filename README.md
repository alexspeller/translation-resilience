# translation-resilience

Stops browser page translation (Chrome's built-in Google Translate) from **crashing React apps** and **silently freezing translated text** — by repairing the DOM instead of swallowing errors.

```ts
import { installTranslationResilience } from 'translation-resilience';

installTranslationResilience();
```

Framework-agnostic (it patches the DOM layer, not React), dependency-free, ~2.3 kB min+gzip.

## The problem

When Chrome translates a page, it rewrites the DOM underneath your framework:

1. Adjacent `Text` nodes are merged (`normalize()`) — so `Lights: {count}` collapses into one run.
2. The merged run is split into segments (numbers isolated) and each segment is wrapped in nested `<font style="vertical-align: inherit;">` elements containing **new** text nodes.
3. The original text nodes are removed from the document — but React still owns and references them.
4. Translation can also delete text nodes outright and reorder inline elements to match target-language word order ([Chromium bug 872770](https://issues.chromium.org/issues/41410214)).

React keeps operating on the original, now-detached nodes:

- **Crash**: unmounting translated conditional text throws `NotFoundError: Failed to execute 'removeChild' on 'Node'`. On React ≤ 18 this takes down the whole tree; React 19 catches it and tears down to the nearest error boundary — still broken, just politer.
- **Crash**: mounting an element before translated text throws the same from `insertBefore`.
- **Silent freeze**: updating translated text (counters, timers, live data) writes into the detached node. The visible page never updates again, with no error anywhere.

Background reading: [facebook/react#11538](https://github.com/facebook/react/issues/11538), [Everything about Google Translate crashing React](https://martijnhols.nl/blog/everything-about-google-translate-crashing-react). The same mechanism breaks Vue ([vuejs/core#14810](https://github.com/vuejs/core/issues/14810)) and Ember/Glimmer ([glimmerjs/glimmer-vm#1372](https://github.com/glimmerjs/glimmer-vm/issues/1372)).

## Why not the well-known monkey-patch?

The widely copied [error-swallowing patch](https://github.com/facebook/react/issues/11538#issuecomment-417504600) catches the `removeChild`/`insertBefore` exceptions. That stops the crash but **not the freeze**: text React updates still never reaches the screen, and "removed" text stays visible. Other mitigations — wrapping every text interpolation in a `<span>`, or `<meta name="google" content="notranslate">` — are invasive or hostile to users who genuinely need translation.

## How this is different: re-adoption

Instead of swallowing errors, this shim puts the original text nodes **back** the moment the renderer touches them:

1. A document-wide `MutationObserver` recognizes translation's displacement pattern (merge, wrap, remove — a pattern renderer commits never produce) and tracks each replaced text run as a *displacement group*: the ordered renderer-owned originals with their pre-translation values, plus the wrapper nodes currently standing in for them.
2. Patched `Node.prototype.removeChild` / `insertBefore` / `appendChild` and the `nodeValue` / `data` setters detect operations on displaced text nodes and first **restore the group** — originals go back into the wrappers' position, wrappers are removed — then let the native operation proceed on a consistent tree.
3. The translator's own observer notices the restored (now updated) text and re-translates it, so the user sees fresh, translated content. The loop is self-healing: update → restore → re-translate.

The result: no crashes, **and** live data keeps updating on translated pages — in the visitor's language.

## Usage

Install:

```sh
npm install translation-resilience
```

Call once in your client entrypoint, before your framework renders:

```ts
import { installTranslationResilience } from 'translation-resilience';

const uninstall = installTranslationResilience();
```

### Options

```ts
installTranslationResilience({
  // Which document to observe (defaults to the global `document`).
  document,

  // Observability hook: called with a short message on every non-native
  // path taken, e.g. 'translation activity detected',
  // 'removeChild: displaced text already gone, removal skipped'.
  onEvent: (message) => {
    Bugsnag.leaveBreadcrumb('translation-resilience', { message }, 'log');
  },
});
```

`onEvent` is the recommended way to learn how often translation actually happens to your users — the `'translation activity detected'` message fires once per page load, only when a translator starts displacing text.

## Safety properties

- **Inert until translation happens.** Before any translation activity is detected, every operation behaves natively — including throwing `NotFoundError` on genuine `removeChild`/`insertBefore` bugs in your code. The shim does not mask real bugs.
- **Fault-contained.** Every non-native code path runs inside a guard; an internal error in the shim falls back to stock browser behavior and reports through `onEvent` (`internal error in …`). A bug in the shim can never make things worse than not having it.
- **Reversible.** `installTranslationResilience()` returns an uninstall function that restores all prototypes and disconnects the observer. Calling install twice returns the same uninstall (idempotent).
- **SSR-safe to import.** Native DOM entry points are captured lazily, so importing the module in Node is fine; only *calling* install requires a DOM.

### Cost

One document-wide `MutationObserver` (childList + characterData, subtree). Record processing is linear in the number of mutations with small constants, and correlation state expires after 100 ms, so steady-state memory is effectively zero. The prototype patches add one `parentNode` comparison to `removeChild`/`insertBefore`/`appendChild` calls on the happy path.

## Testing your app against translation: the simulator

The package ships the mutation simulator used to test the shim itself — it reproduces Google Translate's exact DOM mutations (merge, segment-split, nested `<font>` wrappers, detached originals, deletions, word-order moves, and the ongoing re-translation observer) so you can write deterministic tests without a real browser translation session:

```ts
import { render } from '@testing-library/react';
import { installTranslationResilience } from 'translation-resilience';
import { startTranslateObserver, translateSubtree } from 'translation-resilience/simulator';

it('keeps counters updating on translated pages', async () => {
  const uninstall = installTranslationResilience();
  const { container, rerender } = render(<Counter count={4} />);
  const stopTranslator = startTranslateObserver(container);
  translateSubtree(container);

  rerender(<Counter count={5} />);
  await Promise.resolve();

  expect(container.textContent).toContain('5');
  stopTranslator();
  uninstall();
});
```

`translateSubtree(root, translate?, options?)` performs the initial translation pass (the default `translate` wraps text as `[text]` so assertions are easy); `options` can simulate the nastier behaviors: `deleteTextNodes` (translation dropping nodes) and `moveToParentEnd` (word-order element moves). `startTranslateObserver(root)` keeps re-translating changed content, like the real thing.

## Compatibility and limitations

- **Renderers**: developed and tested against React 18 (the tests render real components with `react-dom` and assert both crash-avoidance and update-visibility). React 19 benefits equally — its error-boundary teardown and the silent freeze both disappear. The patch layer is framework-agnostic, so Vue/Svelte/Ember apps should benefit too, but the test suite currently covers React.
- **Translators**: built against Chrome's translation mutations (the merge/wrap/remove pattern, `<font>` wrappers). A translator that mutates differently simply isn't recognized — unrecognized mutations degrade to stock behavior, never worse than not having the shim.
- **`event.target` inside translated text is a `<font>` element.** That's inherent to page translation, not this shim. React's synthetic event dispatch is unaffected (handlers fire on the right components with the right `currentTarget`), but avoid comparing `event.target` by identity or tag — use `closest()`/`contains()`.
- **Word-order moves are cosmetically imperfect**: text the translator deleted for a word-order change is restored at the best position still known, which may differ from the translator's chosen ordering until re-translation catches up.
- **Same-realm only**: iframes have their own prototypes and documents; install the shim inside each frame that renders your app.

## Demo

`npm run build`, serve the repo root over HTTP (`npx serve .`), and open `/demo/`. Translate the page via Chrome's right-click → "Translate", or use the "Simulate Google Translate" button in browsers without it. `?shim=off` shows stock behavior: the toggles crash the app and the counter freezes.

## License

MIT © Alex Speller
