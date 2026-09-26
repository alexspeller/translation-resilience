/**
 * Real-Firefox coverage: React pages, the built shim, and Firefox's own
 * full-page translator — not a model of it.
 *
 * Firefox applies translations from privileged code through Xray wrappers, so
 * like Chrome's isolated world it never calls the page's patched methods, and
 * its mutation shape (every child detached, the translation appended back,
 * surplus Text nodes left detached) is nothing like Chrome's. This drives the
 * real thing: Firefox is started with Marionette and system access, and
 * TranslationsParent.translate() is invoked from chrome context exactly as the
 * translations panel's Translate button does. The first run downloads an
 * en->fr model through Remote Settings, so it needs network access.
 *
 * Each scenario runs on React 18 and React 19:
 *  - small page: precise checks on the text nodes React owns, each update made
 *    while the nodes it touches are still the ones Firefox left detached.
 *  - long page: more than Firefox translates at once. Firefox translates what
 *    is near the viewport, so merges keep arriving as the page scrolls,
 *    interleaved with React updates, and it re-translates changed content only
 *    once that content is near the viewport again.
 *  - racing: React re-rendering every few tens of milliseconds while Firefox
 *    translates, so some of Firefox's merges land between React's commits.
 *
 * Assertions are invariants rather than exact French, which varies with the
 * model: nothing throws, every number React rendered is on the page (every
 * value that changes is a number, which the translation keeps), the text nodes
 * React still considers mounted are in the document, nodes React removed are
 * gone, and nothing on screen is left half English, half French. Preconditions
 * check that Firefox's merges really did leave React's nodes detached.
 *
 * Run with: npm run test:firefox   (FIREFOX_PATH overrides the binary)
 */
import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { build } from 'esbuild';

const BUNDLE = path.resolve('dist/index.cjs');
const REACT_18 = path.resolve('node_modules/react/umd/react.production.min.js');
const REACT_DOM_18 = path.resolve('node_modules/react-dom/umd/react-dom.production.min.js');
// React 19 ships no UMD build, and react-dom 19's peer dependency on react 19
// cannot share the root install with the unit tests' React 18.
const REACT_19_DIR = path.resolve('scripts/react-19');

const FIREFOX_CANDIDATES = [
  process.env.FIREFOX_PATH,
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
  '/usr/lib/firefox/firefox',
  '/snap/bin/firefox',
].filter(Boolean);

const firefox = FIREFOX_CANDIDATES.find((candidate) => existsSync(candidate));
if (!firefox) {
  console.error('No Firefox found. Set FIREFOX_PATH to a Firefox binary.');
  process.exit(1);
}
for (const file of [
  BUNDLE,
  REACT_18,
  REACT_DOM_18,
  path.join(REACT_19_DIR, 'node_modules/react'),
  path.join(REACT_19_DIR, 'node_modules/react-dom'),
]) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run "npm ci && npm run build && npm ci --prefix scripts/react-19" first.`);
    process.exit(1);
  }
}

const react19 = (
  await build({
    stdin: {
      contents:
        "import * as React from 'react'; import * as ReactDOM from 'react-dom/client';" +
        'window.React = React; window.ReactDOM = ReactDOM;',
      resolveDir: REACT_19_DIR,
    },
    bundle: true,
    write: false,
    minify: true,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })
).outputFiles[0].text;

const PRELUDE = `
  window.__errors = [];
  window.addEventListener('error', (event) => window.__errors.push('window.onerror: ' + event.message));
  window.addEventListener('unhandledrejection', (event) => window.__errors.push('unhandledrejection: ' + event.reason));
  // React reports the errors it catches or recovers from here.
  const consoleError = console.error;
  console.error = (...args) => {
    window.__errors.push('console.error: ' + args.map(String).join(' ').slice(0, 300));
    consoleError(...args);
  };
  // The app's own i18n sync, before any translation: must not arm the shim.
  document.documentElement.lang = 'en';
  document.documentElement.setAttribute('lang', 'en');

  const h = React.createElement;
  class Boundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error) { window.__errors.push('boundary: ' + error.name + ': ' + error.message); }
    render() { return this.state.error ? h('p', { id: 'crashed' }, 'CRASHED') : this.props.children; }
  }
  const textNodesOf = (element) => [...element.childNodes].filter((n) => n.nodeType === 3);

  // When anything last touched the DOM, whoever did it.
  window.__lastMutation = performance.now();
  new MutationObserver(() => {
    window.__lastMutation = performance.now();
  }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
  // Every commit of the app, so the harness knows an update has reached the DOM.
  window.__commits = 0;
  const useCommitCounter = () => React.useLayoutEffect(() => { window.__commits++; });
`;

const SMALL_PAGE = `
  function App() {
    const [count, setCount] = React.useState(4);
    const [word, setWord] = React.useState('today');
    const [note, setNote] = React.useState(true);
    const [badge, setBadge] = React.useState(false);
    useCommitCounter();
    window.__set = { count: setCount, word: setWord, note: setNote, badge: setBadge };
    return h('main', null,
      h('h1', { id: 'title' }, 'Welcome to the lighthouse'),
      // Adjacent interpolations: Firefox merges the run into its first text node.
      h('div', { id: 'b' }, 'There are ', count, ' lights in the tower'),
      h('p', { id: 'c' }, 'This is a sentence ', h('a', { href: '#x' }, 'with a link'), ' written ', word),
      // Conditional text Firefox leaves detached: unmounting it before anything
      // re-attaches it is a removeChild on a detached node.
      h('div', { id: 'f' }, 'Status: ', count, ' lights are burning', note && ' and one is flickering'),
      // An element mounted before text Firefox left detached: insertBefore on a detached reference.
      h('div', { id: 'g' }, 'The keeper ', badge && h('em', null, 'chief'), ' is ', 'on duty tonight'),
    );
  }
  ReactDOM.createRoot(document.getElementById('root')).render(h(Boundary, null, h(App)));

  // The Text nodes React owns, captured once rendered.
  window.__ready = () => {
    if (!document.getElementById('g')) return false;
    const [, bCount] = textNodesOf(document.getElementById('b'));
    const cText = textNodesOf(document.getElementById('c'));
    const fText = textNodesOf(document.getElementById('f'));
    const gText = textNodesOf(document.getElementById('g'));
    window.__nodes = { bCount, cWord: cText[cText.length - 1], fNote: fText[fText.length - 1], gIs: gText[1] };
    return Object.values(window.__nodes).every((n) => n && n.isConnected);
  };
`;

const LONG_PAGE = `
  const SECTIONS = Number(new URLSearchParams(location.search).get('sections'));
  const HEADINGS = [
    'The keeper walked along the rocky shore',
    'Storms arrived from the northern sea',
    'The lamp was cleaned every morning',
    'Ships passed the headland at night',
    'Gulls nested beneath the gallery',
  ];
  const FRUITS = ['apple', 'banana', 'grape', 'lemon', 'melon', 'peach', 'pear', 'plum'];

  // Every value React changes is a number, so a stale one shows whatever the
  // translation says around it.
  function Section({ i, s }) {
    return h('section', { id: 's' + i },
      h('h2', null, HEADINGS[i % HEADINGS.length]),
      h('p', { className: 'b' }, 'There are ', s.count, ' lights in the tower'),
      h('p', { className: 'c' }, 'This is a sentence ', h('a', { href: '#x' }, 'with a link'), ' written on day ', s.day),
      // A lone string child: React rewrites the element's only text node in place.
      h('p', { className: 'd' }, 'Visitors this week: ' + s.count),
      h('p', { className: 'f' }, 'Status: ', s.count, ' lights are burning', s.note && ' and 12 of them flicker'),
      h('p', { className: 'g' }, 'The keeper ', s.badge && h('em', null, 'chief'), ' is ', 'on duty tonight'),
    );
  }
  function App() {
    const [s, setS] = React.useState({
      count: 4, day: 1, note: true, badge: false,
      order: [0, 1, 2, 3, 4, 5, 6, 7], prices: [3, 5, 7, 9, 11, 13, 15, 17],
    });
    useCommitCounter();
    window.__state = s;
    window.__set = (patch) => setS((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }));
    return h('main', null,
      h('h1', { id: 'title' }, 'Welcome to the lighthouse'),
      // Keyed rows: reordering them moves elements Firefox has merged into.
      h('ul', { id: 'list' }, s.order.map((k) =>
        h('li', { key: k, 'data-key': k }, 'The ', FRUITS[k], ' costs ', s.prices[k], ' euros today'))),
      Array.from({ length: SECTIONS }, (_, i) => h(Section, { key: i, i, s })),
    );
  }
  ReactDOM.createRoot(document.getElementById('root')).render(h(Boundary, null, h(App)));

  const PARAGRAPHS = ['b', 'c', 'd', 'f', 'g'];
  const section = (i) => document.getElementById('s' + i);
  const text = (i, cls) => section(i).querySelector('.' + cls).textContent;
  const onScreen = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight;
  };
  const assertAlive = () => {
    if (document.getElementById('crashed')) throw new Error('CRASHED: the error boundary replaced the app');
  };

  // React's own text nodes, captured once rendered: [paragraph, index among its text nodes].
  const OWNED = { count: ['b', 1], day: ['c', -1], note: ['f', -1], gIs: ['g', 1] };
  // React only ever rewrites these three in place; anything else that removes one is Firefox merging.
  const stable = new WeakSet();
  window.__ready = () => {
    if (!section(SECTIONS - 1)) return false;
    window.__nodes = Array.from({ length: SECTIONS }, (_, i) => {
      const nodes = {};
      for (const [name, [cls, at]] of Object.entries(OWNED)) {
        const texts = textNodesOf(section(i).querySelector('.' + cls));
        nodes[name] = texts[at < 0 ? texts.length + at : at];
      }
      stable.add(nodes.count);
      stable.add(nodes.day);
      stable.add(nodes.gIs);
      return nodes;
    });
    return window.__nodes.every((nodes) => Object.values(nodes).every((node) => node && node.isConnected));
  };
  /** How many of each captured node Firefox's merges currently hold detached. */
  window.__detached = () => {
    assertAlive();
    const out = { count: 0, day: 0, note: 0, gIs: 0 };
    for (const nodes of window.__nodes) for (const name in out) if (!nodes[name].isConnected) out[name]++;
    return out;
  };
  window.__translatedSections = () => {
    assertAlive();
    const out = [];
    for (let i = 0; i < SECTIONS; i++) {
      if (section(i).querySelector('h2').textContent !== HEADINGS[i % HEADINGS.length]) out.push(i);
    }
    return out;
  };
  window.__snapshots = {};
  window.__snapshot = (cls) => {
    window.__snapshots[cls] = Array.from({ length: SECTIONS }, (_, i) => text(i, cls));
  };

  // What React rendered, in English: a paragraph is either exactly this or translated.
  const english = (s) => ({
    b: 'There are ' + s.count + ' lights in the tower',
    c: 'This is a sentence with a link written on day ' + s.day,
    d: 'Visitors this week: ' + s.count,
    f: 'Status: ' + s.count + ' lights are burning' + (s.note ? ' and 12 of them flicker' : ''),
    g: 'The keeper ' + (s.badge ? 'chief' : '') + ' is on duty tonight',
  });
  const ENGLISH = /There are|lights in the tower|This is a sentence|written on day|Visitors this week|lights are burning|of them flicker|The keeper|on duty tonight/;
  const translatedText = (value, en) => value !== en && !ENGLISH.test(value);
  const numbersIn = (value) => (value.match(/\\d+/g) || []).map(Number).sort((a, b) => a - b);
  const expectedNumbers = (s) => ({
    b: [s.count],
    c: [s.day],
    d: [s.count],
    f: (s.note ? [s.count, 12] : [s.count]).sort((a, b) => a - b),
  });

  window.__onScreenTranslated = () => {
    assertAlive();
    const en = english(window.__state);
    for (let i = 0; i < SECTIONS; i++) {
      if (onScreen(section(i)) && !PARAGRAPHS.every((cls) => translatedText(text(i, cls), en[cls]))) return false;
    }
    return true;
  };

  window.__verify = ({ expect = {}, changed, translated = [], allTranslated = false, noteNodes = true }) => {
    if (document.getElementById('crashed')) return ['CRASHED: the error boundary replaced the app'];
    const s = window.__state;
    for (const [key, value] of Object.entries(expect)) {
      if (JSON.stringify(s[key]) !== JSON.stringify(value)) return ['React has not rendered ' + key + ' yet'];
    }
    const problems = [];
    const en = english(s);
    const numbers = expectedNumbers(s);
    const done = new Set(window.__translatedSections());
    for (const i of allTranslated ? Array.from({ length: SECTIONS }, (_, i) => i) : translated) {
      if (!done.has(i)) problems.push('section ' + i + ' is not translated');
    }
    for (let i = 0; i < SECTIONS; i++) {
      for (const [cls, want] of Object.entries(numbers)) {
        if (JSON.stringify(numbersIn(text(i, cls))) !== JSON.stringify(want)) {
          problems.push('s' + i + '.' + cls + ' shows "' + text(i, cls) + '", React rendered ' + JSON.stringify(want));
        }
      }
      const ems = section(i).querySelectorAll('.g em');
      if (ems.length !== (s.badge ? 1 : 0)) problems.push('s' + i + '.g has ' + ems.length + ' <em>: "' + text(i, 'g') + '"');
      else if (s.badge && ems[0].nextSibling !== window.__nodes[i].gIs) {
        problems.push('s' + i + '.g <em> is not before React\\'s " is " node: "' + text(i, 'g') + '"');
      }
      if (noteNodes && !s.note && window.__nodes[i].note.isConnected) {
        problems.push('s' + i + '.f unmounted text is still in the document: "' + text(i, 'f') + '"');
      }
      if (changed && text(i, changed) === window.__snapshots[changed][i]) {
        problems.push('s' + i + '.' + changed + ' did not change: "' + text(i, changed) + '"');
      }
      // Firefox re-translates changed content once it is near the viewport, so
      // off screen a paragraph may still read as React wrote it; on screen it
      // is that or translated, never a mix.
      for (const cls of PARAGRAPHS) {
        const value = text(i, cls);
        if (allTranslated ? !translatedText(value, en[cls]) : onScreen(section(i)) && value !== en[cls] && ENGLISH.test(value)) {
          problems.push('s' + i + '.' + cls + ' is not translated: "' + value + '"');
        }
      }
    }
    const rows = [...document.querySelectorAll('#list > li')];
    const order = rows.map((li) => Number(li.dataset.key));
    if (JSON.stringify(order) !== JSON.stringify(s.order)) problems.push('list order is ' + JSON.stringify(order));
    for (const li of rows) {
      const price = s.prices[Number(li.dataset.key)];
      if (JSON.stringify(numbersIn(li.textContent)) !== JSON.stringify([price])) {
        problems.push('row ' + li.dataset.key + ' shows "' + li.textContent + '" for price ' + price);
      }
    }
    return problems;
  };

  let churning = false;
  let detachedWhileChurning = 0;
  new MutationObserver((records) => {
    if (!churning) return;
    for (const record of records) for (const node of record.removedNodes) if (stable.has(node)) detachedWhileChurning++;
  }).observe(document, { childList: true, subtree: true });
  window.__startChurn = () => {
    churning = true;
    let updates = 0;
    const every = (ms, update) => setInterval(() => { updates++; window.__set(update); }, ms);
    const timers = [
      every(40, (s) => ({ count: s.count + 1 })),
      every(170, (s) => ({ note: !s.note })),
      every(230, (s) => ({ badge: !s.badge })),
      every(290, (s) => ({ day: s.day + 1 })),
      every(310, (s) => ({ order: [...s.order.slice(1), s.order[0]], prices: s.prices.map((p) => p + 1) })),
    ];
    window.__stopChurn = () => {
      timers.forEach(clearInterval);
      churning = false;
      return { updates, detached: detachedWhileChurning };
    };
  };
`;

const page = (script, react) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Lighthouse keeper's log</title>
<style>section { min-height: 160px; }</style>
<script src="/react-${react}.js"></script>
<script src="/shim.js"></script>
</head>
<body>
<div id="root"></div>
<script>${PRELUDE}${script}</script>
</body>
</html>`;

const PAGES = { '/small': SMALL_PAGE, '/long': LONG_PAGE };
const files = {
  '/react-18.js': () => `${fs.readFileSync(REACT_18, 'utf8')}\n${fs.readFileSync(REACT_DOM_18, 'utf8')}`,
  '/react-19.js': () => react19,
  '/shim.js': () =>
    `window.__events = [];\n(function () { var module = { exports: {} }, exports = module.exports;\n` +
    `${fs.readFileSync(BUNDLE, 'utf8')}\nwindow.__TR = module.exports; })();\n` +
    `window.__TR.installTranslationResilience({ onEvent: (m) => window.__events.push(m) });`,
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (PAGES[url.pathname]) {
    const react = url.searchParams.get('react');
    res
      .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      .end(page(PAGES[url.pathname], react));
  } else if (files[url.pathname]) {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(files[url.pathname]());
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const marionettePort = 20000 + Math.floor(Math.random() * 20000);
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tr-firefox-'));
const prefs = {
  // Marionette's recommended automation prefs disable translations and point
  // Remote Settings (where the models come from) at a dummy server.
  'remote.prefs.recommended': false,
  'marionette.port': marionettePort,
  'browser.translations.enable': true,
  'browser.translations.automaticallyPopup': false,
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'startup.homepage_welcome_url': 'about:blank',
  'browser.startup.page': 0,
  'browser.aboutwelcome.enabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'app.update.disabledForTesting': true,
};
fs.writeFileSync(
  path.join(profile, 'user.js'),
  Object.entries(prefs)
    .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
    .join('\n')
);

const child = spawn(
  firefox,
  ['-profile', profile, '-marionette', '-remote-allow-system-access', '-no-remote', '-headless'],
  {
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  }
);
let stderr = '';
child.stderr.on('data', (data) => {
  stderr = (stderr + data).slice(-4000);
});

/** Marionette's wire protocol: `${byteLength}:${json}` frames of [type, id, ...]. */
class Marionette {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve) => {
      this.onHandshake = resolve;
    });
    socket.on('data', (data) => this.receive(data));
  }
  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const colon = this.buffer.indexOf(58);
      if (colon < 0) return;
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (this.buffer.length < colon + 1 + length) return;
      const message = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString());
      this.buffer = this.buffer.subarray(colon + 1 + length);
      if (!Array.isArray(message)) {
        this.onHandshake(message);
        continue;
      }
      const [, id, error, result] = message;
      const entry = this.pending.get(id);
      this.pending.delete(id);
      if (error) entry.reject(new Error(`${error.error}: ${error.message}`));
      else entry.resolve(result);
    }
  }
  send(name, params = {}) {
    const id = ++this.id;
    const json = Buffer.from(JSON.stringify([0, id, name, params]));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(Buffer.concat([Buffer.from(`${json.length}:`), json]));
    });
  }
  async run(script, context = 'content') {
    await this.send('Marionette:SetContext', { value: context });
    const { value } = await this.send('WebDriver:ExecuteScript', { script, args: [] });
    return value;
  }
}

async function connect() {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const s = net.connect(marionettePort, '127.0.0.1', () => resolve(s));
        s.once('error', reject);
      });
      const marionette = new Marionette(socket);
      await marionette.ready;
      return marionette;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Marionette never came up.\n${stderr}`);
}

const failures = [];
let group = '';
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok)
    failures.push(
      `${group}: ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`
    );
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let marionette;
const inPage = (expression) => marionette.run(`return ${expression};`);

/** Polls until `expression` is truthy; false if it never is. */
async function waitFor(expression, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await inPage(expression)) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

/** Opens a page, checks it rendered React `react` without arming the shim, and returns once captured. */
async function open(name, pathname, react, sections = 0) {
  group = `React ${react}, ${name}`;
  console.log(`\n${group}:`);
  const url = `http://127.0.0.1:${server.address().port}${pathname}?react=${react}&sections=${sections}`;
  await marionette.send('WebDriver:Navigate', { url });
  if (!(await waitFor('!!window.__ready && window.__ready()', 10000))) throw new Error('the React page never rendered');
  check(`runs React ${react}`, await inPage(`React.version.split('.')[0]`), react);
  check("stays dormant through the page's own <html lang> writes", await inPage('window.__events'), []);
}

/** Starts Firefox's full-page translation, as its Translate button does, and waits for the first text. */
async function translate() {
  await marionette.run(
    `const { TranslationsParent } = ChromeUtils.importESModule("resource://gre/actors/TranslationsParent.sys.mjs");
     return TranslationsParent.getTranslationsActor(window.gBrowser.selectedBrowser)
       .translate({ sourceLanguage: "en", targetLanguage: "fr" }, false)
       .then(() => "requested");`,
    'chrome'
  );
  // The first run downloads the model, which can take minutes on a cold runner.
  if (!(await waitFor(`document.getElementById('title').textContent !== 'Welcome to the lighthouse'`, 180000)))
    throw new Error('Firefox never translated the page (model download blocked?)');
}

/**
 * Waits until nothing has touched the DOM for a while. React renders only when
 * the harness asks it to, so a quiet page is one Firefox has finished with for
 * now. Updating a paragraph while Firefox is still translating it would race
 * Firefox itself: a text change does not cancel a paragraph's translation in
 * flight, so the translation of the old text lands on top of the new one.
 */
async function quiet() {
  if (!(await waitFor('performance.now() - window.__lastMutation > 1500', 60000)))
    throw new Error('the page never went quiet');
}

/** Runs a React update once the page is quiet, and returns once React has committed it. */
async function render(expression) {
  await quiet();
  const before = await inPage('window.__commits');
  await inPage(expression);
  if (!(await waitFor(`window.__commits > ${before}`, 10000))) {
    const crashed = await inPage(`!!document.getElementById('crashed')`);
    throw new Error(`React never committed ${expression}${crashed ? ': the app had crashed' : ''}`);
  }
}

async function smallPage(react) {
  const text = (id) => inPage(`document.getElementById(${JSON.stringify(id)})?.textContent ?? null`);
  const detached = `['bCount', 'cWord', 'fNote', 'gIs'].filter((name) => !window.__nodes[name].isConnected)`;

  await open('small page', '/small', react);
  await translate();
  await waitFor(`${detached}.length === 4`, 30000);
  await quiet();

  const events = await inPage('window.__events');
  check(
    "arms on Firefox's <html lang> write, from outside the page",
    ['<html lang> changed from outside the page', 'translation signal detected, observing document'].every((event) =>
      events.includes(event)
    ),
    true
  );
  check('recognises the translation', events.includes('translation activity detected'), true);
  check("Firefox's merges left React's text nodes detached (the shapes under test)", await inPage(detached), [
    'bCount',
    'cWord',
    'fNote',
    'gIs',
  ]);
  const translatedC = await text('c');

  // First, while nothing has re-attached it: any update to #f would restore
  // its nodes and make this an ordinary removal.
  const withNote = await text('f');
  await render('window.__set.note(false)');
  await quiet();
  check('unmounting conditional text Firefox left detached does not throw', await inPage('window.__errors'), []);
  check(
    'the unmounted text is gone',
    (await inPage(`!!document.getElementById('f') && !window.__nodes.fNote.isConnected`)) &&
      (await text('f')) !== withNote,
    true
  );

  await render('window.__set.badge(true)');
  await quiet();
  check('mounting an element before text Firefox left detached does not throw', await inPage('window.__errors'), []);
  check(
    'the element lands between its neighbours',
    await inPage(`(() => {
      const em = document.querySelector('#g em');
      return !!em && em.previousSibling?.nodeType === 3 && em.nextSibling === window.__nodes.gIs;
    })()`),
    true
  );

  await render('window.__set.count(5)');
  await quiet();
  check(
    'a count update in a merged run reaches the page',
    /\b5\b/.test(await text('b')) && !/\b4\b/.test(await text('b')),
    true
  );
  check('the interpolated count node is back in the document', await inPage('window.__nodes.bCount.isConnected'), true);
  check('a count update next to conditional text reaches the page', /\b5\b/.test(await text('f')), true);

  await render(`window.__set.word('tomorrow')`);
  await quiet();
  check('a word after an inline element updates', (await text('c')) !== translatedC, true);
  check('the word node is back in the document', await inPage('window.__nodes.cWord.isConnected'), true);

  await render('window.__set.count(6)');
  await quiet();
  check(
    'updates keep reaching the page after re-translation',
    /\b6\b/.test(await text('b')) && /\b6\b/.test(await text('f')),
    true
  );
  check('no errors at all', await inPage('window.__errors'), []);
}

/**
 * Checks the long page until it matches `options` (see __verify), then again
 * once Firefox has reacted to it, failing with whatever is still wrong.
 */
async function eventually(name, options, timeout = 30000) {
  const deadline = Date.now() + timeout;
  const verify = () => inPage(`window.__verify(${JSON.stringify(options)})`);
  let problems;
  for (;;) {
    problems = await verify();
    if (problems.length === 0) {
      await quiet();
      problems = await verify();
      if (problems.length === 0) break;
    }
    if (Date.now() > deadline) break;
    await sleep(250);
  }
  check(name, problems.slice(0, 6), []);
  if (problems[0]?.startsWith('CRASHED')) {
    const errors = [...new Set(await inPage('window.__errors'))];
    throw new Error(`the app crashed, so the rest of this scenario is skipped: ${errors.join(' | ')}`);
  }
}
const update = (state) => render(`window.__set(${JSON.stringify(state)})`);
const snapshot = async (cls) => {
  await quiet();
  await inPage(`window.__snapshot('${cls}')`);
};

async function longPage(react) {
  const SECTIONS = 150;
  await open('long page', '/long', react, SECTIONS);
  await translate();
  check(
    'Firefox translates lazily: the last section waits until it is near the viewport',
    (await inPage('window.__translatedSections()')).includes(SECTIONS - 1),
    false
  );
  await eventually('the first merges leave the page intact', {});
  check(
    "Firefox's merges left React's counts detached near the top",
    (await inPage('window.__detached()')).count > 0,
    true
  );

  await update({ count: 5 });
  await eventually('a count update reaches translated and untranslated sections', { expect: { count: 5 } });

  await inPage('window.scrollTo(0, document.body.scrollHeight)');
  await eventually('scrolling to the bottom brings a fresh batch of merges', { translated: [SECTIONS - 1] });
  // Nothing has touched the bottom sections' conditional text since Firefox
  // merged them, so the removal below reaches nodes Firefox left detached;
  // the day and the text after the element's slot are untouched everywhere.
  const bottom = await inPage('window.__detached()');
  check('the fresh merges left conditional text detached', bottom.note > 0, true);
  check('text after an element slot, and the day, are detached too', bottom.gIs > 0 && bottom.day > 0, true);

  await snapshot('f');
  await update({ note: false });
  await eventually('unmounting conditional text Firefox left detached', { expect: { note: false }, changed: 'f' });

  await update({ badge: true });
  await eventually('mounting an element before text Firefox left detached', { expect: { badge: true } });

  await snapshot('c');
  await update({ day: 2 });
  await eventually('the number after an inline element', { expect: { day: 2 }, changed: 'c' });

  await update({ count: 6 });
  await eventually('a count update after those merges', { expect: { count: 6 } });

  await inPage(`document.getElementById('s${SECTIONS / 2}').scrollIntoView()`);
  await eventually('merges that arrive after React updated the content', { translated: [SECTIONS / 2] });

  await update({ count: 7, note: true, badge: false });
  await eventually('conditional text and the element toggled back', { expect: { count: 7, note: true, badge: false } });

  await inPage('window.scrollTo(0, 0)');
  const shuffled = { order: [7, 3, 5, 1, 0, 2, 6, 4], prices: [4, 6, 8, 10, 12, 14, 16, 18] };
  await update(shuffled);
  await eventually('keyed rows reordered with new prices', { expect: shuffled });
  await update({ order: [3, 5, 0, 6] });
  await eventually('keyed rows removed', { expect: { order: [3, 5, 0, 6] } });
  const restored = { order: [0, 1, 2, 3, 4, 5, 6, 7], prices: [9, 9, 9, 9, 9, 9, 9, 9], count: 8 };
  await update(restored);
  await eventually('keyed rows added back, and a count update', { expect: restored });

  // Read the whole page, a screen at a time, as a reader would: Firefox
  // translates each screen's sections and re-translates what React changed.
  const height = await inPage('document.body.scrollHeight');
  const screen = await inPage('Math.floor(innerHeight * 0.9)');
  for (let y = 0; y < height; y += screen) {
    await inPage(`window.scrollTo(0, ${y})`);
    if (!(await waitFor('window.__onScreenTranslated()', 30000)))
      throw new Error(`the sections on screen at scrollY ${y} never finished translating`);
  }
  await eventually('after reading the whole page, every paragraph is translated and current', {
    expect: restored,
    allTranslated: true,
  });
  check('no errors at all', await inPage('window.__errors'), []);
}

async function racing(react) {
  await open('racing', '/long', react, 30);
  await inPage('window.__startChurn()');
  await sleep(300);
  await translate();
  await sleep(3000);
  await inPage('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(3000);
  await inPage('window.scrollTo(0, 0)');
  await sleep(2000);
  const churn = await inPage('window.__stopChurn()');
  check('React kept re-rendering throughout', churn.updates > 100, true);
  check('Firefox merged paragraphs while React was re-rendering them', churn.detached > 0, true);

  const final = {
    count: 1000,
    day: 77,
    note: false,
    badge: true,
    order: [2, 0, 1, 3, 4, 5, 6, 7],
    prices: [1, 2, 3, 4, 5, 6, 7, 8],
  };
  await update(final);
  // React replaced the conditional text many times over; the captured nodes are long gone.
  await eventually('the page shows exactly what React last rendered', { expect: final, noteNodes: false });
  const next = { count: 1001, day: 78, note: true, badge: false };
  await update(next);
  await eventually('and later updates keep landing', { expect: next, noteNodes: false });
  check('no errors at all', await inPage('window.__errors'), []);
}

try {
  marionette = await connect();
  await marionette.send('WebDriver:NewSession', { capabilities: {} });
  console.log('real-Firefox checks (Firefox full-page translation):');
  for (const react of ['18', '19']) {
    for (const scenario of [smallPage, longPage, racing]) {
      try {
        await scenario(react);
      } catch (error) {
        failures.push(`${group}: harness: ${error.message}`);
        console.error(error);
      }
    }
  }
} catch (error) {
  failures.push(`harness: ${error.message}`);
  console.error(error);
} finally {
  try {
    await marionette?.send('WebDriver:DeleteSession');
  } catch {}
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  server.close();
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    console.warn(`warning: could not remove temp profile ${profile}: ${error.message}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} Firefox check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll real-Firefox checks passed.');
