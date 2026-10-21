/**
 * Yandex Browser's own page translator, driven over CDP.
 *
 * Yandex ships this translator only inside Yandex Browser: it wraps each
 * translated run in <ya-tr-span>, detaching the Text nodes React owns. This
 * drives the real translator headlessly — the profile asks it to always
 * translate English to Russian — against a React page: once without the shim,
 * to prove the crash and the freeze reproduce, then with it, on a page that
 * declares <html lang> and on one that doesn't.
 *
 * Run with: YANDEX_PATH=/Applications/Yandex.app/Contents/MacOS/Yandex npm run test:yandex
 * A fresh profile spends its first minute downloading components; reuse a warm
 * one with YANDEX_PROFILE=<dir>.
 */
import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT ?? 9466);
const ROOT = path.resolve('.');
const BUNDLE = path.resolve('dist/index.js');
const SERVED = ['scripts/yandex-test/', 'dist/', 'node_modules/react/umd/', 'node_modules/react-dom/umd/'];

const YANDEX_CANDIDATES = [
  process.env.YANDEX_PATH,
  '/Applications/Yandex.app/Contents/MacOS/Yandex',
  '/usr/bin/yandex-browser-stable',
  '/usr/bin/yandex-browser',
].filter(Boolean);

const yandex = YANDEX_CANDIDATES.find((candidate) => existsSync(candidate));
if (!yandex) {
  console.error('No Yandex Browser found. Set YANDEX_PATH to its binary.');
  process.exit(1);
}
if (!existsSync(BUNDLE)) {
  console.error(`Missing ${BUNDLE}. Run "npm run build" first.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((request, response) => {
  const relative = path.relative(ROOT, path.join(ROOT, decodeURIComponent(new URL(request.url, 'http://x').pathname)));
  const file = path.join(ROOT, relative);
  if (!SERVED.some((prefix) => relative.startsWith(prefix)) || !existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404);
    response.end();
    return;
  }
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript';
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const ownProfile = !process.env.YANDEX_PROFILE;
const profile = process.env.YANDEX_PROFILE || fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tr-yandex-'));
const preferencesFile = path.join(profile, 'Default', 'Preferences');
fs.mkdirSync(path.dirname(preferencesFile), { recursive: true });
const preferences = existsSync(preferencesFile) ? JSON.parse(fs.readFileSync(preferencesFile, 'utf8')) : {};
fs.writeFileSync(
  preferencesFile,
  JSON.stringify({
    ...preferences,
    intl: { ...preferences.intl, accept_languages: 'ru,en', selected_languages: 'ru,en' },
    translate: { ...preferences.translate, enabled: true },
    translate_allowlists: { en: 'ru' },
  })
);

const child = spawn(
  yandex,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--lang=ru',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);
let browserStderr = '';
let spawnError = null;
child.on('error', (error) => {
  spawnError = error;
});
child.stderr.on('data', (data) => {
  browserStderr = (browserStderr + data).slice(-4000);
});

const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok)
    failures.push(`${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}

/** One browser-level connection; pages are attached as flattened sessions. */
class Browser {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const resolve = message.id && this.pending.get(message.id);
      if (!resolve) return;
      this.pending.delete(message.id);
      resolve(message);
    });
  }
  send(method, params = {}, sessionId = undefined, timeout = 15000) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        resolve({ error: { message: `timed out: ${method}` } });
      }, timeout);
    });
  }
  async page() {
    const created = await this.send('Target.createTarget', { url: 'about:blank' });
    const targetId = created.result.targetId;
    const attached = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.result.sessionId;
    await this.send('Page.enable', {}, sessionId);
    const navigate = (url) => this.send('Page.navigate', { url }, sessionId, 20000);
    const evaluate = async (expression) => {
      const response = await this.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId, 10000);
      if (response.error) return `EVAL-ERROR: ${response.error.message}`;
      if (response.result.exceptionDetails) return `EVAL-ERROR: ${response.result.exceptionDetails.text}`;
      return response.result.result.value;
    };
    const close = () => this.send('Target.closeTarget', { targetId });
    return { navigate, evaluate, close };
  }
}

async function connect() {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
    try {
      const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const ws = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', reject);
      });
      return new Browser(ws);
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Yandex Browser did not expose the DevTools endpoint.\n${spawnError ?? browserStderr}`);
}

/** A cold profile blocks navigation until its startup component downloads finish. */
async function waitUntilNavigable(browser) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const page = await browser.page();
    const navigated = await page.navigate('data:text/html,ready');
    await page.close();
    if (!navigated.error) return;
    await sleep(5000);
  }
  throw new Error('Yandex Browser never finished navigating a data: URL.');
}

/** Loads the page, waits until the translator has wrapped its text, then drives React. */
async function run(browser, shim, query = '') {
  const page = await browser.page();
  await page.navigate(`${origin}/scripts/yandex-test/page.html?shim=${shim ? 'on' : 'off'}${query}`);
  let translated = 0;
  for (let attempt = 0; attempt < 120 && translated === 0; attempt++) {
    await sleep(500);
    translated = await page.evaluate(`document.querySelectorAll('#app ya-tr-span').length`);
  }
  await sleep(1500);
  // #warning's children by tag, ignoring blank text: which nodes are on screen, whatever the translation says.
  const state = () =>
    page.evaluate(`JSON.stringify({
      counter: document.getElementById('counter')?.textContent ?? null,
      warning: (() => {
        const warning = document.getElementById('warning');
        if (!warning) return null;
        return [...warning.childNodes]
          .filter((node) => node.nodeType !== Node.TEXT_NODE || node.data.trim() !== '')
          .map((node) => node.nodeName);
      })(),
      mounted: document.querySelector('#badge strong') !== null,
      errors: window.__errors,
      events: window.__events,
    })`);
  const before = JSON.parse(await state());
  await page.evaluate('window.__actions.tick(); window.__actions.tick(); 0');
  await sleep(2500);
  const ticked = JSON.parse(await state());
  await page.evaluate('window.__actions.hideWarning(); 0');
  await sleep(1000);
  const hidden = JSON.parse(await state());
  await page.evaluate('window.__actions.showBadge(); 0');
  await sleep(2500);
  const after = JSON.parse(await state());
  await page.close();
  return { translated, before, ticked, hidden, after };
}

const notFound = (errors) => errors.some((error) => error.includes('NotFoundError'));

function checkWithShim(label, result, armingEvent) {
  console.log(`  with the shim, ${label}: events: ${result.after.events.join(' | ')}`);
  check(`${label}: the translator wrapped the React app in <ya-tr-span>`, result.translated > 0, true);
  check(
    `${label}: the conditional text was translated before React removed it`,
    result.before.warning?.[0],
    'YA-TR-SPAN'
  );
  check(`${label}: the shim armed on ${armingEvent}`, result.after.events.includes(armingEvent), true);
  check(
    `${label}: the translation was recognised`,
    result.after.events.includes('translation activity detected'),
    true
  );
  check(`${label}: the counter keeps updating`, /6/.test(result.ticked.counter ?? ''), true);
  check(`${label}: removing translated conditional text does not throw`, notFound(result.hidden.errors), false);
  check(`${label}: the removed text is gone and its sibling stays`, result.hidden.warning, ['STRONG']);
  check(`${label}: mounting before translated text does not throw`, notFound(result.after.errors), false);
  check(`${label}: the mounted element is in the document`, result.after.mounted, true);
}

try {
  const browser = await connect();
  await waitUntilNavigable(browser);
  console.log('Yandex Browser page translator (real, headless):');

  const off = await run(browser, false);
  check('without the shim: the translator wrapped the React app in <ya-tr-span>', off.translated > 0, true);
  check('without the shim: the counter freezes', /6/.test(off.ticked.counter ?? ''), false);
  check(
    'without the shim: removing translated conditional text throws NotFoundError',
    notFound(off.hidden.errors),
    true
  );

  const declared = await run(browser, true);
  checkWithShim('<html lang>', declared, '<html lang> changed by the Yandex translator');
  check(
    '<html lang>: the Yandex lang write is not taken for Firefox',
    declared.after.events.includes('<html lang> changed from outside the page'),
    false
  );

  const bare = await run(browser, true, '&nolang');
  checkWithShim('no <html lang>', bare, 'Yandex translator popup detected via detection stylesheet');

  if (failures.length > 0) {
    console.log(JSON.stringify({ off, declared, bare }, null, 2));
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
} finally {
  server.close();
  if (child.exitCode === null && child.signalCode === null && !spawnError) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  if (ownProfile) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.warn(`warning: could not remove temp profile ${profile}: ${error.message}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\nall Yandex checks passed');
process.exit(0);
