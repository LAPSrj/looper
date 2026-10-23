// Drives the Looper build in this repo on Windows for docs screenshots: `npm run screenshots` in the
// Windows copy, then type commands (or pipe them in). Each launch runs on a fresh copy of demo/home
// with its own profile, so the installed Looper is untouched. Shots land in %TEMP%\looper-shots\shots.
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..', '..');
const ROOT = path.join(os.tmpdir(), 'looper-shots');
const SHOT_DIR = path.join(ROOT, 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let app = null;
let page = null;

const pickPage = (frag) => app.windows().find((w) => w.url().includes(frag));

/** The native window handle of the window showing `url`, as a decimal string. */
async function hwndOf(url) {
  return app.evaluate(({ BrowserWindow }, u) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL() === u);
    return w ? w.getNativeWindowHandle().readBigUInt64LE().toString() : null;
  }, url);
}

const ps = (script, args) =>
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, script), ...args], { encoding: 'utf8' }).trim();

const COMMANDS = {
  /** Start the app on a fresh copy of the demo data (SHOT_DATA: use that folder as it is instead). */
  async launch() {
    // The demo tasks' working folders and transcripts live in WSL.
    console.log(execFileSync('wsl.exe', ['-e', 'bash', '-c', 'bash "$(wslpath -a "$1")"', '_', path.join(HERE, 'setup-wsl.sh')], { encoding: 'utf8' }).trim());
    let data = process.env.SHOT_DATA;
    if (!data) {
      data = path.join(ROOT, 'home');
      fs.rmSync(data, { recursive: true, force: true });
      fs.cpSync(path.join(HERE, 'demo', 'home'), data, { recursive: true });
    }
    app = await electron.launch({
      executablePath: path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe'),
      // Chromium keeps painting while covered, so captures never need the window in front.
      args: [
        `--user-data-dir=${path.join(ROOT, 'profile')}`,
        '--disable-features=CalculateNativeWinOcclusion',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        APP_DIR,
      ],
      env: { ...process.env, LOOPER_HOME: data },
      timeout: 60_000,
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await new Promise((r) => setTimeout(r, 3000));
    console.log('launched', app.windows().map((w) => w.url()).join(' | '), 'data', data);
  },
  async quit() {
    await app?.close();
    app = null;
    console.log('closed');
  },
  async wins() {
    for (const w of app.windows()) console.log(' ', w.url());
  },
  /** use <url fragment>: act on the window whose URL contains it. */
  async use(frag) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const w = pickPage(frag);
      if (w) {
        page = w;
        await page.waitForLoadState('domcontentloaded');
        console.log('using', page.url());
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log('NO WINDOW', frag);
  },
  /** ss <name> [WxH]: capture the window, first sizing its visible frame to W x H pixels when given. */
  async ss(arg) {
    const [name, size] = arg.split(' ');
    const out = path.join(SHOT_DIR, name + '.png');
    const hwnd = await hwndOf(page.url());
    if (!hwnd) return console.log('NO HWND');
    await new Promise((r) => setTimeout(r, 400));
    const sizeArgs = size ? ['-Width', size.split('x')[0], '-Height', size.split('x')[1]] : [];
    console.log('screenshot:', ps('capture.ps1', ['-Hwnd', hwnd, '-Out', out, ...sizeArgs]));
  },
  /** dialog <title>|<shot name or ->|<button id or 0> */
  async dialog(arg) {
    const [title, name, click] = arg.split('|');
    const args = ['-Title', title];
    if (name && name !== '-') args.push('-Out', path.join(SHOT_DIR, name + '.png'));
    if (click && click !== '0') args.push('-Click', click);
    try {
      console.log('dialog:', ps('dialog.ps1', args));
    } catch (e) {
      console.log('dialog ERROR:', (e.stdout || e.message).toString().trim());
    }
  },
  async 'click-text'(text) {
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"], [role="option"], summary, .tab')];
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'OK';
    }, text);
    console.log('click-text', text, '->', r);
  },
  async fill(arg) {
    const [sel, ...rest] = arg.split(' ');
    await page.fill(sel, rest.join(' '));
    console.log('filled', sel);
  },
  async select(arg) {
    const [sel, value] = arg.split(' ');
    await page.selectOption(sel, value);
    console.log('selected', value);
  },
  async type(text) {
    await page.keyboard.type(text, { delay: 5 });
    console.log('typed');
  },
  async press(key) {
    await page.keyboard.press(key);
    console.log('pressed', key);
  },
  async 'wait-text'(arg) {
    const m = /^(\d+)\s+(.*)$/.exec(arg);
    const secs = m ? Number(m[1]) : 30;
    const text = m ? m[2] : arg;
    const deadline = Date.now() + secs * 1000;
    while (Date.now() < deadline) {
      const body = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (body.includes(text)) return console.log('found text:', text);
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('TIMEOUT text:', text);
  },
  async text(sel) {
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null));
  },
  async eval(expr) {
    try {
      console.log(JSON.stringify(await page.evaluate(expr)));
    } catch (e) {
      console.log('ERROR:', e.message);
    }
  },
  /** evalfile <file>: run a script in the window; a bare name is looked up in actions/. */
  async evalfile(file) {
    const p = path.isAbsolute(file) ? file : path.join(HERE, 'actions', file);
    try {
      console.log(JSON.stringify(await page.evaluate(fs.readFileSync(p, 'utf8'))));
    } catch (e) {
      console.log('ERROR:', e.message);
    }
  },
  /** main <function>: run `(electron) => …` in the main process. */
  async main(expr) {
    try {
      console.log(JSON.stringify(await app.evaluate(new Function('electron', `return (${expr})(electron)`))));
    } catch (e) {
      console.log('ERROR:', e.message);
    }
  },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' });
let chain = Promise.resolve();
rl.on('line', (line) => {
  chain = chain.then(async () => {
    const t = line.trim();
    const sp = t.indexOf(' ');
    const cmd = sp === -1 ? t : t.slice(0, sp);
    const rest = sp === -1 ? '' : t.slice(sp + 1);
    if (cmd) {
      const fn = COMMANDS[cmd];
      if (!fn) console.log('unknown:', cmd);
      else {
        try {
          await fn(rest);
        } catch (e) {
          console.log('ERROR:', e.message);
        }
      }
    }
    rl.prompt();
  });
});
// Piped commands: close the app once the last one is done.
rl.on('close', () => void chain.then(() => COMMANDS.quit()));
console.log('looper screenshot driver ready');
rl.prompt();
