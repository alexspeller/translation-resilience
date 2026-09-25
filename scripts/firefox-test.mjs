/**
 * Real-Firefox coverage: a React page, the built shim, and Firefox's own
 * full-page translator — not a model of it.
 *
 * Firefox applies translations from privileged code through Xray wrappers, so
 * like Chrome's isolated world it never calls the page's patched methods, and
 * its mutation shape (every child detached, the translation appended back,
 * surplus Text nodes left detached) is nothing like Chrome's. This drives the
 * real thing: Firefox is started with Marionette and system access, and
 * TranslationsParent.translate() is invoked from chrome context exactly as the
 * translations panel does. The first run downloads an en->fr model through
 * Remote Settings, so it needs network access.
 *
 * Assertions are invariants rather than exact French, which varies with the
 * model: nothing throws, updated numbers reach the page, the text nodes React
 * still considers mounted are in the document, and nodes React removed are
 * gone.
 *
 * Run with: npm run test:firefox   (FIREFOX_PATH overrides the binary)
 */
import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const BUNDLE = path.resolve('dist/index.cjs');
const REACT = path.resolve('node_modules/react/umd/react.production.min.js');
const REACT_DOM = path.resolve('node_modules/react-dom/umd/react-dom.production.min.js');

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
for (const file of [BUNDLE, REACT, REACT_DOM]) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run "npm ci && npm run build" first.`);
    process.exit(1);
  }
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Lighthouse keeper's log</title>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script src="/shim.js"></script>
</head>
<body>
<div id="root"></div>
<script>
  window.__errors = [];
  window.addEventListener('error', (event) => window.__errors.push('window.onerror: ' + event.message));
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
  function App() {
    const [count, setCount] = React.useState(4);
    const [word, setWord] = React.useState('today');
    const [note, setNote] = React.useState(true);
    const [badge, setBadge] = React.useState(false);
    window.__set = { count: setCount, word: setWord, note: setNote, badge: setBadge };
    return h('main', null,
      h('h1', { id: 'title' }, 'Welcome to the lighthouse'),
      // Adjacent interpolations: Firefox merges the run into its first text node.
      h('div', { id: 'b' }, 'There are ', count, ' lights in the tower'),
      h('p', { id: 'c' }, 'This is a sentence ', h('a', { href: '#x' }, 'with a link'), ' written ', word),
      // Conditional text Firefox leaves detached: unmounting it is a removeChild on a detached node.
      h('div', { id: 'f' }, 'Status: ', count, ' lights are burning', note && ' and one is flickering'),
      // An element mounted before text Firefox left detached: insertBefore on a detached reference.
      h('div', { id: 'g' }, 'The keeper ', badge && h('em', null, 'chief'), ' is ', 'on duty tonight'),
    );
  }
  ReactDOM.createRoot(document.getElementById('root')).render(h(Boundary, null, h(App)));

  // The Text nodes React owns, captured once rendered.
  window.__capture = () => {
    const textIn = (id) => [...document.getElementById(id).childNodes].filter((n) => n.nodeType === 3);
    const [, bCount] = textIn('b');
    const cText = textIn('c');
    const fText = textIn('f');
    const gText = textIn('g');
    window.__nodes = { bCount, cWord: cText[cText.length - 1], fNote: fText[fText.length - 1], gIs: gText[1] };
    return Object.values(window.__nodes).every((n) => n && n.isConnected);
  };
</script>
</body>
</html>`;

const files = {
  '/': ['text/html', () => PAGE],
  '/react.js': ['text/javascript', () => fs.readFileSync(REACT)],
  '/react-dom.js': ['text/javascript', () => fs.readFileSync(REACT_DOM)],
  '/shim.js': [
    'text/javascript',
    () =>
      `window.__events = [];\n(function () { var module = { exports: {} }, exports = module.exports;\n` +
      `${fs.readFileSync(BUNDLE, 'utf8')}\nwindow.__TR = module.exports; })();\n` +
      `window.__TR.installTranslationResilience({ onEvent: (m) => window.__events.push(m) });`,
  ],
};
const server = http.createServer((req, res) => {
  const entry = files[new URL(req.url, 'http://localhost').pathname];
  if (!entry) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': entry[0], 'cache-control': 'no-store' }).end(entry[1]());
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
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok)
    failures.push(`${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let marionette;
try {
  marionette = await connect();
  await marionette.send('WebDriver:NewSession', { capabilities: {} });
  await marionette.send('WebDriver:Navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  const page = (expression) => marionette.run(`return ${expression};`);
  const text = (id) => page(`document.getElementById(${JSON.stringify(id)})?.textContent ?? null`);
  const settle = async () => {
    // A React commit, then Firefox's re-translation (a double rAF, then the engine).
    await sleep(2000);
  };

  let captured = false;
  for (let attempt = 0; attempt < 50 && !captured; attempt++) {
    captured = await page(`!!document.getElementById('g') && window.__capture()`);
    if (!captured) await sleep(100);
  }
  if (!captured) throw new Error('the React page never rendered');

  console.log('real-Firefox checks (Firefox full-page translation):');
  check("stays dormant through the page's own <html lang> writes", await page('window.__events'), []);

  await marionette.run(
    `const { TranslationsParent } = ChromeUtils.importESModule("resource://gre/actors/TranslationsParent.sys.mjs");
     return TranslationsParent.getTranslationsActor(window.gBrowser.selectedBrowser)
       .translate({ sourceLanguage: "en", targetLanguage: "fr" }, false)
       .then(() => "requested");`,
    'chrome'
  );
  let translated = false;
  for (let attempt = 0; attempt < 720 && !translated; attempt++) {
    translated = (await text('title')) !== 'Welcome to the lighthouse';
    if (!translated) await sleep(250);
  }
  if (!translated) throw new Error('Firefox never translated the page (model download blocked?)');
  await settle();

  const events = await page('window.__events');
  check(
    "arms on Firefox's <html lang> write, from outside the page",
    ['<html lang> changed from outside the page', 'translation signal detected, observing document'].every((event) =>
      events.includes(event)
    ),
    true
  );
  check('recognises the translation', events.includes('translation activity detected'), true);
  const merged = await page('!window.__nodes.bCount.isConnected');
  check("Firefox's merge detached React's interpolated count (the shape under test)", merged, true);
  const translatedC = await text('c');

  await page('window.__set.count(5)');
  await settle();
  check(
    'a count update in a merged run reaches the page',
    /\b5\b/.test(await text('b')) && !/\b4\b/.test(await text('b')),
    true
  );
  check('the interpolated count node is back in the document', await page('window.__nodes.bCount.isConnected'), true);
  check('a count update next to conditional text reaches the page', /\b5\b/.test(await text('f')), true);

  await page(`window.__set.word('tomorrow')`);
  await settle();
  check('a word after an inline element updates', (await text('c')) !== translatedC, true);
  check('the word node is back in the document', await page('window.__nodes.cWord.isConnected'), true);

  const withNote = await text('f');
  await page('window.__set.note(false)');
  await settle();
  check('unmounting conditional text Firefox left detached does not throw', await page('window.__errors'), []);
  check(
    'the unmounted text is gone',
    (await page('window.__nodes.fNote.isConnected')) === false && (await text('f')) !== withNote,
    true
  );

  await page('window.__set.badge(true)');
  await settle();
  check('mounting an element before text Firefox left detached does not throw', await page('window.__errors'), []);
  check(
    'the element lands between its neighbours',
    await page(`(() => {
      const em = document.querySelector('#g em');
      return !!em && em.previousSibling?.nodeType === 3 && em.nextSibling === window.__nodes.gIs;
    })()`),
    true
  );

  await page('window.__set.count(6)');
  await settle();
  check(
    'updates keep reaching the page after re-translation',
    /\b6\b/.test(await text('b')) && /\b6\b/.test(await text('f')),
    true
  );
  check('no errors at all', await page('window.__errors'), []);
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
