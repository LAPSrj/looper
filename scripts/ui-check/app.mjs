// The app `npm run ui-check` drives: a private copy of the built app and of the demo data (scripts/screenshots/demo) in
// UI_CHECK_ROOT (default /tmp/looper-ui-check), launched in this computer's Electron with Remote Access on, so a phone
// can pair as scripts/perf/phone.mjs pairs one. The agents run as a script that stays up (AGENT), and one chat is seeded
// from a made-up transcript with two subagents and two background commands still running, so the Activity sheet has items
// to open and a running subagent's conversation has its message box (a chat that has ended takes no messages for them).
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const ROOT = process.env.UI_CHECK_ROOT || '/tmp/looper-ui-check';
const APP = path.join(ROOT, 'app');
const DATA = path.join(ROOT, 'home');
const PROJ = path.join(ROOT, 'projects');
const CONFIG = path.join(ROOT, 'claude');
const DEMO = path.join(REPO, 'scripts', 'screenshots', 'demo');
/** Stands in for Claude Code: stays up whatever its arguments, so the chat doesn't end (cat exits on Claude Code's). */
const AGENT = path.join(ROOT, 'agent.sh');
// The build to run: out/ unless UI_CHECK_OUT names another (`electron-vite build --outDir`), so a check can run a build
// of its own while other work rebuilds out/.
const OUT = process.env.UI_CHECK_OUT ? path.resolve(process.env.UI_CHECK_OUT) : path.join(REPO, 'out');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

/** The built app copied, so a rebuild of out/ while this runs can't pull chunks from under it. */
function copyApp() {
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  for (const e of fs.readdirSync(REPO)) {
    if (['out', '.git', 'scratch', 'release', '.browser', 'audit', 'mockups'].includes(e)) continue;
    fs.symlinkSync(path.join(REPO, e), path.join(APP, e));
  }
  fs.cpSync(OUT, path.join(APP, 'out'), { recursive: true });
}

const replaceAll = (file, pairs) => {
  let text = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) text = text.split(a).join(b);
  fs.writeFileSync(file, text);
};
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

/** A Claude Code transcript (JSONL) in the shape its records have, and its subagents' files, made up for the check. */
function writeTranscript(dir, sid, cwd) {
  const base = { userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.330', gitBranch: 'main' };
  let parent = null;
  const records = [];
  const push = (r) => {
    const uuid = crypto.randomUUID();
    records.push({ parentUuid: parent, isSidechain: false, ...r, uuid, ...base });
    parent = uuid;
    return uuid;
  };
  const assistant = (minutes, content) => push({ type: 'assistant', timestamp: iso(minutes), message: { id: crypto.randomUUID(), model: 'claude-sonnet-5-5', role: 'assistant', type: 'message', stop_reason: 'tool_use', usage: { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 }, content } });
  const toolResult = (minutes, id, content, tur) => push({ type: 'user', timestamp: iso(minutes), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] }, ...(tur ? { toolUseResult: tur } : {}) });
  push({ type: 'user', timestamp: iso(40), message: { role: 'user', content: 'Chat 0 message 0: look through the repo and keep a build and a test run going in the background.' } });
  assistant(39, [{ type: 'text', text: 'I will start two subagents and two background commands.' }]);
  const subagents = [
    { agentId: 'a1c0ffee00000001', toolUseId: 'toolu_uicheck_sub1', description: 'Find every use of the old header', type: 'general-purpose' },
    { agentId: 'a1c0ffee00000002', toolUseId: 'toolu_uicheck_sub2', description: 'Read the build log for warnings', type: 'general-purpose' },
  ];
  subagents.forEach((s, i) => {
    assistant(38 - i, [{ type: 'tool_use', id: s.toolUseId, name: 'Agent', input: { description: s.description, subagent_type: s.type, prompt: s.description, run_in_background: true } }]);
    toolResult(38 - i, s.toolUseId, 'Async agent launched.', { isAsync: true, status: 'async_launched', agentId: s.agentId, description: s.description, outputFile: '/tmp/ui-check-' + s.agentId + '.output', canReadOutputFile: true, canContinueAgent: true });
  });
  const background = [
    { id: 'toolu_uicheck_bg1', task: 'bguicheck1', command: 'npm run build -- --watch', name: 'Bash' },
    { id: 'toolu_uicheck_bg2', task: 'bguicheck2', command: 'npx vitest --watch', name: 'Bash' },
  ];
  background.forEach((b, i) => {
    assistant(30 - i, [{ type: 'tool_use', id: b.id, name: b.name, input: { command: b.command, run_in_background: true } }]);
    toolResult(30 - i, b.id, 'Command running in background with ID: ' + b.task + '. Output is being written to: /tmp/ui-check-' + b.task + '.output', { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: b.task });
  });
  assistant(5, [{ type: 'text', text: 'Both subagents and both commands are running. I will report when they finish.' }]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const subDir = path.join(dir, sid, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  for (const s of subagents) {
    fs.writeFileSync(path.join(subDir, 'agent-' + s.agentId + '.meta.json'), JSON.stringify({ agentType: s.type, description: s.description, toolUseId: s.toolUseId, model: 'sonnet', finished: false }));
    const side = (r) => JSON.stringify({ isSidechain: true, agentId: s.agentId, ...r, uuid: crypto.randomUUID(), ...base });
    fs.writeFileSync(
      path.join(subDir, 'agent-' + s.agentId + '.jsonl'),
      [
        side({ parentUuid: null, type: 'user', timestamp: iso(37), message: { role: 'user', content: s.description } }),
        side({ type: 'assistant', timestamp: iso(36), message: { id: crypto.randomUUID(), model: 'claude-sonnet-5-5', role: 'assistant', type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: 'Looking now.' }] } }),
      ].join('\n') + '\n',
    );
  }
}

/** The demo data with its projects under ROOT, agents run as cat in the local shell, and the made-up chat's transcript. */
function seed() {
  for (const d of [DATA, PROJ, CONFIG, path.join(ROOT, 'profile')]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(AGENT, "#!/bin/sh\ntrap 'exit 0' TERM INT HUP\nwhile :; do sleep 2; done\n", { mode: 0o755 });
  fs.cpSync(path.join(DEMO, 'home'), DATA, { recursive: true });
  fs.cpSync(path.join(DEMO, 'projects'), PROJ, { recursive: true });
  // The grouped pane of a few hundred items the check opens (fixture-addon/): not part of the screenshots' demo data.
  fs.cpSync(path.join(HERE, 'fixture-addon'), path.join(DATA, 'addons', 'ui-check-passwords'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(ROOT, 'clone-'));
  execFileSync('git', ['clone', '-q', '--no-checkout', path.join(DEMO, 'webapp.bundle'), path.join(tmp, 'webapp')]);
  fs.renameSync(path.join(tmp, 'webapp', '.git'), path.join(PROJ, 'webapp', '.git'));
  fs.rmSync(tmp, { recursive: true, force: true });
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: path.join(PROJ, 'webapp') });
  execFileSync('git', ['reset', '-q'], { cwd: path.join(PROJ, 'webapp') });
  fs.mkdirSync(path.join(PROJ, 'looper'), { recursive: true });
  execFileSync('git', ['init', '-q', path.join(PROJ, 'looper')]);
  for (const f of walk(DATA).filter((f) => /\.json$/.test(f))) replaceAll(f, [['/home/leandro/looper-demo', PROJ]]);
  const settingsFile = path.join(DATA, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  for (const h of settings.environments.find((e) => e.id === 'local').harnesses) Object.assign(h, { command: AGENT, args: [], env: { CLAUDE_CONFIG_DIR: CONFIG } });
  settings.environments = settings.environments.filter((e) => e.id === 'local');
  settings.defaultEnvironmentId = 'local';
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  for (const f of walk(DATA).filter((f) => /\.json$/.test(f))) replaceAll(f, [['"environmentId": "wsl"', '"environmentId": "local"'], ['"environmentId":"wsl"', '"environmentId":"local"']]);
  const projectsFile = path.join(DATA, 'projects.json');
  const projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  projects.projects.push({ ...projects.projects[0], id: 'looperp', name: 'Looper', cwd: path.join(PROJ, 'looper') });
  for (const p of projects.projects) Object.assign(p, { environmentId: 'local', harnessId: 'claude' });
  fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));
  const web = path.join(CONFIG, 'projects', keyOf(path.join(PROJ, 'webapp')));
  fs.mkdirSync(web, { recursive: true });
  for (const f of fs.readdirSync(path.join(DEMO, 'claude-projects'))) {
    fs.copyFileSync(path.join(DEMO, 'claude-projects', f), path.join(web, f));
    replaceAll(path.join(web, f), [['/home/leandro/looper-demo', PROJ]]);
  }
  const sid = crypto.randomUUID();
  const cwd = path.join(PROJ, 'looper');
  writeTranscript(path.join(CONFIG, 'projects', keyOf(cwd)), sid, cwd);
  fs.copyFileSync(path.join(REPO, 'assets', 'icon.png'), path.join(PROJ, 'webapp', 'perf-image.png'));
  return { sid, transcript: path.join(CONFIG, 'projects', keyOf(cwd), sid + '.jsonl') };
}

/** Opens a chat for the history item that mentions `match`, and points its run at the transcript; the chat's id. */
async function openChat(page, match, transcript) {
  const list = await page.evaluate(async () => {
    for (let i = 0; i < 30; i++) {
      const l = await window.looper.history.list({ limit: 200, fresh: true, folder: '' });
      if (l.items.length) return l.items;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return [];
  });
  const item = list.find((i) => JSON.stringify(i).includes(match));
  if (!item) throw new Error('history has no ' + match + ': ' + list.map((i) => i.title).join(' | '));
  const before = new Set(await page.evaluate(async () => (await window.looper.sessions.state()).sessions.map((s) => s.id)));
  await page.evaluate((id) => window.looper.history.run(id, 'chat'), item.id);
  let chat;
  for (let i = 0; i < 30 && !chat; i++) {
    await sleep(500);
    chat = (await page.evaluate(async () => (await window.looper.sessions.state()).sessions.map((s) => s.id))).find((x) => !before.has(x));
  }
  if (!chat) throw new Error('the chat did not open');
  const run = fs.readdirSync(path.join(DATA, 'tasks')).map((t) => path.join(DATA, 'tasks', t, 'runs', chat)).find((d) => fs.existsSync(d));
  if (run) fs.writeFileSync(path.join(run, 'session.json'), JSON.stringify({ session_id: path.basename(transcript, '.jsonl'), transcript_path: transcript }));
  return { chat, title: item.title };
}

/** Remote Access on with its local source; its address. */
async function remoteUrl(page) {
  return page.evaluate(async () => {
    const s = await window.looper.info();
    await window.looper.updateSettings({ remoteAccess: { ...s.settings.remoteAccess, enabled: true, sources: ['local'] } });
    for (let i = 0; i < 50; i++) {
      const st = await window.looper.remoteAccess.state();
      const local = st.sources?.find((x) => x.id === 'local' && x.phase === 'running');
      if (local?.url) return local.url.replace(/\/$/, '');
      await new Promise((r) => setTimeout(r, 200));
    }
    return 'http://127.0.0.1:' + (await window.looper.info()).settings.remoteAccess.port;
  });
}

/** Seeds, launches and opens the chat; `{ app, page, url, chat }`. `remote: false` leaves Remote Access off (no url),
 *  so a desktop-only run doesn't take its port. */
export async function startApp({ remote = true } = {}) {
  copyApp();
  const { sid, transcript } = seed();
  const app = await electron.launch({
    executablePath: createRequire(path.join(REPO, 'package.json'))('electron'),
    args: ['--user-data-dir=' + path.join(ROOT, 'profile'), '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), APP],
    env: { ...process.env, LOOPER_HOME: DATA, LOOPER_NO_MEMORY_TRIM: '1' },
    timeout: 90_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await sleep(5000);
  const chat = await openChat(page, sid, transcript);
  await sleep(4000);
  const url = remote ? await remoteUrl(page) : null;
  return { app, page, url, chat };
}

export async function stopApp(app) {
  const proc = app.process();
  // The agents first: with them still up, the app didn't exit.
  try {
    execFileSync('pkill', ['-f', AGENT]);
  } catch {
    // None running.
  }
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
  if (proc.exitCode === null) await new Promise((done) => proc.once('exit', done));
}
