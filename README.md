# translation-resilience

Stops browser page translation (Chrome's built-in Google Translate) from **crashing React apps** and **silently freezing translated text** — by repairing the DOM instead of swallowing errors.

```ts
import { installTranslationResilience } from 'translation-resilience';

installTranslationResilience();
```

Framework-agnostic (it patches the DOM layer, not React), dependency-free, ~2.6 kB min+gzip, and lazily activated — near-zero cost until a translator actually touches the page.

## The problem

When Chrome translates a page, it rewrites the DOM underneath your framework:

1. Adjacent `Text` nodes are merged (`normalize()`) — so `Lights: {count}` collapses into one run.
2. The merged run is split into segments (numbers isolated) and each segment is wrapped in nested `<font style="vertical-align: inherit;">` elements containing **new** text nodes.
3. The original text nodes are removed from the document — but React still owns and references them.
4. Translation can also delete text nodes outright and reorder inline elements to match target-language word order ([Chromium bug 872770](https://issues.chromium.org/issues/41407169)).

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
  // path taken, e.g. 'translation signal detected, observing document',
  // 'translation activity detected',
  // 'removeChild: displaced text already gone, removal skipped'.
  onEvent: (message) => {
    Bugsnag.leaveBreadcrumb('translation-resilience', { message }, 'log');
  },

  // Install the document-wide observer immediately instead of waiting for a
  // translation signal (see "Performance cost"). Costs more on never-translated
  // pages. Rarely needed: lazy activation covers translators that mark <html>
  // (Chrome) and, via the detection stylesheet, translators that only wrap text
  // in <font> (Edge, the Google Translate extension). eager buys earlier
  // tracking for a translator that displaces text without marking <html> and
  // without an identifiable <font> wrapper — that case is otherwise caught on
  // the repair path, which prevents the crash but cannot re-adopt the first
  // displacement it never saw.
  eager: false,
});
```

`onEvent` is the recommended way to learn how often translation actually happens to your users — the `'translation activity detected'` message fires once per page load, only when a translator starts displacing text.

## Safety properties

- **Inert until translation happens.** The document-wide observer isn't even created until a translation signal appears — the translator marking `<html>`, or its first signature `<font>` entering the tree (see "Performance cost") — and until translation activity is detected every operation behaves natively, including throwing `NotFoundError` on genuine `removeChild`/`insertBefore` bugs in your code. The one deliberate exception is the repair-path sweep: on an operation that is *already* about to throw, finding translator markup anywhere in the document is taken as evidence that a translator, not your code, moved the node. A genuine DOM bug committed while the page is being translated is therefore repaired rather than reported — the trade that keeps a translated page from crashing. On an untranslated page nothing is masked.
- **Fault-contained.** Every non-native code path runs inside a guard; an internal error in the shim falls back to stock browser behavior and reports through `onEvent` (`internal error in …`). A bug in the shim can never make things worse than not having it.
- **Reversible.** `installTranslationResilience()` returns an uninstall function that restores all prototypes and disconnects the observer. Calling install twice returns the same uninstall (idempotent).
- **SSR-safe to import.** Native DOM entry points are captured lazily, so importing the module in Node is fine; only *calling* install requires a DOM.

## Performance cost

The shim is **lazily activated**. At install it patches the DOM methods and watches for two kinds of signal, whichever comes first:

- **`<html>` markers.** It watches the `class` attribute of `<html>`. Chrome's built-in translator announces itself there — it adds a `translated-ltr`/`translated-rtl` class — a few hundred milliseconds *before* it touches any text (~275–500 ms measured against real Chrome). The class *value* is checked (`translated-…`), not merely "class changed", because browser extensions routinely add unrelated classes to `<html>`. `lang` is deliberately *not* watched, for the same reason: apps write it themselves — i18n libraries sync `<html lang>` once language detection resolves and on every language switch, as WCAG 3.1.1 asks — so arming on it would run the full observer on every such page. Watching it would not arm any earlier, either: Chrome adds the class first, in the same call, and only rewrites a `lang` the page already has.
- **A detection stylesheet keyed to the translator's own `<font>` wrappers.** Not every translator marks `<html>`: Microsoft Edge's built-in translator and the Google Translate browser extension wrap text in `<font>` elements without ever touching the class or `lang`. The shim installs a stylesheet giving a 1 ms CSS animation to a translator's *signature* `<font>` — `style="vertical-align: inherit;"` (Google) or the `_msttexthash`/`_msthash`/`_mstmutation` attributes (Edge) — and arms when `animationstart` fires. Matching the signature rather than the bare tag matters because `<font>` is deprecated but not impossible for an app to render itself (via JSX, `dangerouslySetInnerHTML`, or rendered HTML/markdown); an app's own `<font>` has neither marker and is ignored. The stylesheet is installed as a constructable stylesheet (`adoptedStyleSheets`) so that a `style-src 'self'` Content-Security-Policy — which blocks an injected `<style>` element outright — does not disable detection, with a `<style>` fallback for engines without constructable stylesheet support. The rule uses `!important` so a global `* { animation: none !important }` reset cannot silence it.

Only on a signal does the shim create the document-wide `MutationObserver` that does the real work. Installing on an already-marked document activates immediately, and a synchronous fallback in the patched methods covers same-realm translators (like the bundled simulator) that signal and displace in the same task.

Anything that still slips through — a translator whose wrappers carry no recognisable signature, or a renderer commit landing in the same task as the displacement, before `animationstart` is delivered — is caught on the way to the exception: when a patched method is about to throw `NotFoundError`, the shim sweeps the document for translator markup and degrades gracefully if it finds any. That sweep runs *only* on a path that would otherwise crash, so it costs nothing in normal operation. `eager: true` remains available to arm the full observer from the start.

**Why detection cannot simply hook the patched methods.** A browser's page translator does not run in your page's JavaScript world. Chromium executes the translate script in an *isolated world* (`ExecuteScriptInIsolatedWorld`, [`translate_agent.cc`](https://chromium.googlesource.com/chromium/src/+/main/components/translate/content/renderer/translate_agent.cc)) — a separate copy of every JS builtin, including `Node.prototype`, over the *same* DOM. Patching `Node.prototype.insertBefore` in the page therefore has no effect on the translator's own DOM calls: they are simply invisible to it. Only signals the shared DOM itself raises — attribute changes, mutation records, style/animation events — cross that boundary. This is why detection is a stylesheet rather than a check inside the patched methods, and why any test that displaces text by calling the patched methods directly proves nothing about real browsers (see the simulator's `displaceFromIsolatedWorld`).

Measured numbers, with an honest caveat: these are microbenchmarks from one machine (Apple Silicon, headless Chrome, production React 18 build; a 500-row × 4-column table, medians of 7 runs). The shim has **not yet been benchmarked inside a large production app** — if you measure something different, please open an issue.

**Before any translation signal (the overwhelmingly common case) the cost is near zero:**

- Re-rendering the table with three cells changing in every row, 50 commits: 26.9 ms → 29.1 ms (+8%, ≈ 40 µs per full-table commit). Repeated mount+unmount of the whole table: +3% (noise).
- Writes to an attached `text.data`: ~0.05 µs → ~0.08 µs each. The worst case we could construct — a tight synchronous loop appending and removing individual detached text nodes, a pattern frameworks don't produce — ~0.2 µs → ~0.26 µs per pair.
- The detection stylesheet adds one selector for the style engine to evaluate against elements it is already matching. Measured on a 500 × 4 grid under sustained churn (50 commits of 2,000 text writes + 1,000 insert/remove each, medians of 9 interleaved trials, headless Chrome on Apple Silicon): **+1.1%** against no detection at all. The alternatives for detecting an out-of-world translator are much more expensive — a `childList`/`subtree` `MutationObserver` measured +7.2% and the full observer +9.5% on the same benchmark. A cheap cross-world signal is the whole reason detection is a stylesheet.
- What remains is the patched-method call indirection plus one attribute read per operation while dormant. There is no observer, so the browser allocates no mutation records.

**After translation starts**, the full machinery is live: one document-wide `MutationObserver` (childList + characterData + oldValue, subtree) means a record per DOM mutation, and inserting a *detached* text node drains and processes pending records. Correlation state expires after 100 ms and is purged incrementally (amortized O(1) per entry), so steady-state memory is effectively zero. On a translated page, operations on *untranslated* content cost roughly: ≈ 0.3 ms per pathological full-table commit, ~0.3 µs per text write, ~1.8 µs per worst-case churn op. Updates to *translated* text pay the restore → re-translate cycle: ≈ 14 µs per updated text run, so a commit updating 1,500 translated runs at once costs ≈ 20 ms extra — the alternative without the shim is those updates never becoming visible at all. Translated pages that are idle cost nothing beyond the observer.

### How React core could fix this (nearly for free)

Almost everything this package pays on the happy path is an *outsider tax*: the cost of reconstructing, from mutation records, knowledge the renderer already has. React knows which text nodes it owns (each HostText fiber holds its DOM node), what they should contain (`memoizedProps`), and what the DOM around them should look like (the fiber tree). A fix inside React would need none of this package's machinery:

- **Detection is one pointer comparison.** A text node displaced by translation has `parentNode === null`, so the silent-freeze case is caught by a single check inside `commitTextUpdate`, on an operation React is already performing — instead of a document-wide `MutationObserver` allocating a record (plus an `oldValue` string copy) for every DOM mutation on the page.
- **The crash half can cost literally nothing.** React 19 already wraps commit-phase deletions in try/catch — that is why it tears down to the nearest error boundary instead of white-screening. Upgrading that catch from "tear down" to "repair and continue" adds zero instructions to the non-throwing path.
- **Repair needs no archaeology.** This package tracks displacement groups through a correlation window because, from the outside, "which foreign nodes replaced mine, and what did mine say?" can only be answered by watching the mutations happen. React can instead rebuild the affected host element's children from fiber state — the moral equivalent of hydration-mismatch recovery — and let the translator re-translate the result. Same self-healing loop as this shim, none of the bookkeeping.
- **Nobody else pays.** The prototype patches here are page-global: every DOM user, React or not, pays the (small) toll. An in-core fix is scoped to React's own commit operations.

Against the numbers above: lazy activation already makes the never-translated case nearly free, but once translation is active the userland machinery has real costs that an in-core fix would not — and even the dormant-state residue (patched-call indirection, an attribute read per op) would drop to a branch-predicted pointer compare. A fix has been requested since 2017 ([facebook/react#11538](https://github.com/facebook/react/issues/11538)); the traditional objections — defensive checks don't belong in the commit hot path, and third-party DOM mutation is outside React's contract — are worth weighing against what userland has to do instead, which is this entire package. The same reasoning applies to any renderer that keeps references to the text nodes it creates (Vue, Ember, Svelte). We would be delighted for this package to be made obsolete.

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

Like real Chrome, `translateSubtree` marks the document before touching any text — it adds `translated-ltr` and flips `lang` on `<html>` (the class is what activates the lazily-installed shim). Remember to reset those attributes between tests if your assertions depend on them.

### Testing the out-of-world case

`translateSubtree` mutates the DOM from your own JavaScript realm, which is fine for the Chrome-style flow but is **not** how a browser translator behaves — a real one runs in an isolated world and never calls the patched methods (see "Why detection cannot simply hook the patched methods"). A test that displaces text in-realm can arm the shim through a path no browser can reach, and will pass even if the shim would crash in production.

`displaceFromIsolatedWorld(textNode, translatedText?, signature?)` reproduces that constraint faithfully: it performs the wrapper-in/original-out displacement using DOM natives captured at import time, so the patched methods never observe it. `signature` is `'google'` (nested `<font style="vertical-align: inherit;">`) or `'edge'` (`_msttexthash`/`_msthash`, no `<html>` markers).

```ts
import { displaceFromIsolatedWorld } from 'translation-resilience/simulator';

it('survives Edge translating the page', () => {
  const { container, rerender } = render(<Row show={false} />);
  const text = findTextNode(container, 'trailing text');

  displaceFromIsolatedWorld(text, 'nachlaufender Text', 'edge');

  expect(() => rerender(<Row show />)).not.toThrow();
});
```

Import the simulator before calling `installTranslationResilience()`, so the natives it captures are the unpatched ones (ES module imports are hoisted, so a normal top-level `import` already guarantees this).

Note that jsdom runs no CSS animations, so the detection stylesheet never fires there; under jsdom these cases are caught by the repair-path sweep instead. The stylesheet's own behaviour is covered by `npm run test:browser`, which drives real headless Chrome and displaces text from a genuine isolated world via `Page.createIsolatedWorld`.

## Compatibility and limitations

- **Renderers**: developed and tested against React 18 (the tests render real components with `react-dom` and assert both crash-avoidance and update-visibility). React 19 benefits equally — its error-boundary teardown and the silent freeze both disappear. The patch layer is framework-agnostic, so Vue/Svelte/Ember apps should benefit too, but the test suite currently covers React.
- **Translators**: built against Chrome's translation mutations (the merge/wrap/remove pattern, `<font>` wrappers). Covers both translators that mark `<html>` (Chrome's built-in Google Translate) and translators that only wrap text in `<font>` (Microsoft Edge's built-in translator, the Google Translate browser extension). A translator that mutates in some entirely different way simply isn't recognized — unrecognized mutations degrade to stock behavior, never worse than not having the shim (and `eager: true` widens coverage further).
- **`event.target` inside translated text is a `<font>` element.** That's inherent to page translation, not this shim. React's synthetic event dispatch is unaffected (handlers fire on the right components with the right `currentTarget`), but avoid comparing `event.target` by identity or tag — use `closest()`/`contains()`.
- **Word-order moves are cosmetically imperfect**: text the translator deleted for a word-order change is restored at the best position still known, which may differ from the translator's chosen ordering until re-translation catches up.
- **Per-frame**: iframes have their own prototypes and documents; install the shim inside each frame that renders your app. (This is separate from the translator's isolated world, which shares the document and is handled.)

## Demo

`npm run build`, serve the repo root over HTTP (`npx serve .`), and open `/demo/`. Translate the page via Chrome's right-click → "Translate", or use the "Simulate Google Translate" button in browsers without it. `?shim=off` shows stock behavior: the toggles crash the app and the counter freezes.

## License

MIT © Alex Speller
