/**
 * Real-browser coverage for the parts jsdom cannot express.
 *
 * Two things in this package only exist because of how a real browser is
 * built, and neither can be exercised under jsdom:
 *
 *  1. A page translator runs in the engine's own isolated world — a separate
 *     copy of Node.prototype over a shared DOM. `Page.createIsolatedWorld` is
 *     the same primitive Chromium's own TranslateAgent uses
 *     (`ExecuteScriptInIsolatedWorld` in translate_agent.cc), so mutations made
 *     here reach the DOM exactly the way a translator's do: invisible to the
 *     patched prototype methods.
 *  2. The detection stylesheet arms on `animationstart`, and jsdom runs no
 *     animations, so its whole arming path is untestable there.
 *
 * Run with: npm run test:browser
 */
import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT ?? 9455);
const BUNDLE = path.resolve('dist/index.cjs');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chrome) {
  console.error('No Chrome found. Set CHROME_PATH to a Chrome/Chromium binary.');
  process.exit(1);
}
if (!existsSync(BUNDLE)) {
  console.error(`Missing ${BUNDLE}. Run "npm run build" first.`);
  process.exit(1);
}

const shim = fs.readFileSync(BUNDLE, 'utf8');
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tr-browser-'));
const child = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
  ],
  { stdio: 'ignore' }
);

const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok)
    failures.push(`${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}

const http = async (p) =>
  (await fetch(`http://127.0.0.1:${PORT}${p}`, { method: p.startsWith('/json/new') ? 'PUT' : 'GET' })).json();

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = message.id && this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const connect = (url) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new CDP(ws)));
  });

async function waitForBrowser() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await http('/json/version');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('Chrome did not expose the DevTools endpoint');
}

/** A page with the shim installed in the main world and a translator in an isolated one. */
async function session({ csp = '' } = {}) {
  const target = await http('/json/new?about:blank');
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const head = csp ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : '';
  const html = `<!doctype html><html><head>${head}</head><body><div id="app"><p id="p">trailing text</p></div></body></html>`;
  await cdp.send('Page.navigate', { url: `data:text/html,${encodeURIComponent(html)}` });
  await new Promise((r) => setTimeout(r, 350));

  const evaluate = async (expression, contextId) => {
    const params = { expression, returnByValue: true };
    if (contextId) params.contextId = contextId;
    const result = await cdp.send('Runtime.evaluate', params);
    if (result.exceptionDetails) {
      return `EVAL-ERROR: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`;
    }
    return result.result.value;
  };

  await evaluate(`
    window.__events = [];
    (function () { var module = { exports: {} }, exports = module.exports;
${shim}
      window.__TR = module.exports;
    })();
    window.__uninstall = window.__TR.installTranslationResilience({ onEvent: (m) => window.__events.push(m) });
    window.__original = document.getElementById('p').firstChild;
    'installed';
  `);

  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: 'translator',
  });
  return { evaluate, isolated: executionContextId };
}

/** Edge's displacement, performed from the isolated world. */
const EDGE_DISPLACEMENT = `(function () {
  const p = document.getElementById('p');
  const original = p.firstChild;
  const font = document.createElement('font');
  font.setAttribute('_msttexthash', '27820');
  font.setAttribute('_msthash', '1');
  font.appendChild(document.createTextNode('nachlaufender Text'));
  p.insertBefore(font, original);
  p.removeChild(original);
  return 'displaced';
})();`;

try {
  await waitForBrowser();
  console.log('real-browser checks (isolated world + detection stylesheet):');

  {
    const { evaluate, isolated } = await session();
    await evaluate(EDGE_DISPLACEMENT, isolated);
    await new Promise((r) => setTimeout(r, 400));
    const events = await evaluate('window.__events');
    check(
      'arms on a translator running in the browser isolated world',
      Array.isArray(events) && events.includes('translator font detected via detection stylesheet'),
      true
    );
    check(
      'the patched methods never saw the translator (arming came from the stylesheet)',
      Array.isArray(events) && events.includes('translation activity detected'),
      true
    );
    const mounted = await evaluate(`(function () {
      try {
        document.getElementById('p').insertBefore(document.createElement('em'), window.__original);
        return 'no-throw';
      } catch (error) { return error.name; }
    })();`);
    check('React can still mount an element before the displaced text', mounted, 'no-throw');
  }

  {
    // A strict CSP blocks an injected <style> element; adoptedStyleSheets is
    // CSSOM and unaffected, so detection must survive it.
    const { evaluate, isolated } = await session({ csp: "style-src 'self'" });
    await evaluate(EDGE_DISPLACEMENT, isolated);
    await new Promise((r) => setTimeout(r, 400));
    const events = await evaluate('window.__events');
    check(
      "arms under a strict Content-Security-Policy (style-src 'self')",
      Array.isArray(events) && events.includes('translator font detected via detection stylesheet'),
      true
    );
  }

  {
    // An app's own <font> carries no translator signature and must not arm it.
    const { evaluate } = await session();
    await evaluate(`(function () {
      const font = document.createElement('font');
      font.setAttribute('color', 'red');
      font.appendChild(document.createTextNode('app font'));
      document.getElementById('app').appendChild(font);
      return 1;
    })();`);
    await new Promise((r) => setTimeout(r, 400));
    check("stays dormant for an application's own <font>", await evaluate('window.__events'), []);
  }

  {
    // i18n libraries sync <html lang> from the page itself (WCAG 3.1.1):
    // once detection resolves, then on every language switch.
    const { evaluate } = await session();
    await evaluate(`document.documentElement.lang = 'de'; 1`);
    await new Promise((r) => setTimeout(r, 50));
    await evaluate(`document.documentElement.setAttribute('lang', 'de'); document.documentElement.lang = 'fr'; 1`);
    await new Promise((r) => setTimeout(r, 400));
    check("stays dormant for an application's own <html lang> writes", await evaluate('window.__events'), []);
  }

  {
    // Chrome's translator marks <html> from its isolated world before it
    // touches any text: the class, then a rewrite of the page's existing lang.
    const { evaluate, isolated } = await session();
    await evaluate(`document.documentElement.lang = 'de'; 1`);
    await evaluate(
      `document.documentElement.classList.add('translated-ltr'); document.documentElement.setAttribute('lang', 'en'); 1`,
      isolated
    );
    await new Promise((r) => setTimeout(r, 100));
    check(
      "arms on the translated-* class set from the translator's isolated world",
      await evaluate('window.__events'),
      ['translation signal detected, observing document']
    );
  }
} finally {
  child.kill('SIGKILL');
  fs.rmSync(profile, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} browser check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll real-browser checks passed.');
