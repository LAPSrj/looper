import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { AddonHost, addonEnv, addonSpawnLine } from '../src/main/addon-host';
import {
  AddonPaneContentSchema,
  AddonScreenSchema,
  engineLogSource,
  matchesSearch,
  readAddonManifest,
  type AddonInfo,
  type AddonManifest,
} from '../src/shared/addons';
import { isAddonFileName, isLooperFileName } from '../src/shared/files';

const MANIFEST = {
  $type: 'looper/addon',
  $version: 1,
  id: 'demo',
  name: 'Demo',
  version: '0.1.0',
  run: { on: 'wsl', command: ['node', '/opt/demo/addon.mjs'] },
  panes: [{ id: 'things', title: 'Things' }],
};

describe('readAddonManifest', () => {
  it('accepts a manifest and defaults panes', () => {
    const { panes: _, ...noPanes } = MANIFEST;
    const r = readAddonManifest(noPanes);
    expect(r.ok && r.manifest.panes).toEqual([]);
  });

  it('tells a newer format from a file that is not an addon', () => {
    expect(readAddonManifest({ ...MANIFEST, $version: 2 })).toEqual({ ok: false, reason: 'newer' });
    expect(readAddonManifest({ $type: 'looper/task', $version: 1 })).toEqual({ ok: false, reason: 'not-addon' });
    expect(readAddonManifest([])).toEqual({ ok: false, reason: 'not-addon' });
  });

  it('names the field that is wrong', () => {
    const r = readAddonManifest({ ...MANIFEST, run: { on: 'wsl', command: [] } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^run\.command:/);
    const dup = readAddonManifest({ ...MANIFEST, panes: [MANIFEST.panes[0], MANIFEST.panes[0]] });
    expect(!dup.ok && dup.error).toBe('panes: duplicate id "things"');
    expect(readAddonManifest({ ...MANIFEST, id: 'a/b' }).ok).toBe(false);
    const noPane = readAddonManifest({ ...MANIFEST, tools: [{ id: 't', label: 'T', pane: 'nope' }] });
    expect(!noPane.ok && noPane.error).toBe('tools: "t" names no pane "nope"');
    const both = readAddonManifest({ ...MANIFEST, tools: [{ id: 't', label: 'T', pane: 'things', view: 'v' }] });
    expect(!both.ok && both.error).toBe('tools.0: give either "pane" or "view"');
    expect(readAddonManifest({ ...MANIFEST, tools: [{ id: 't', label: 'T', pane: 'things' }] }).ok).toBe(true);
    const tools = [{ id: 't', label: 'T', pane: 'things' }];
    const button = readAddonManifest({ ...MANIFEST, tools, toolbar: [{ id: 'b', label: 'B', icon: 'key', tool: 't' }] });
    expect(button.ok && button.manifest.toolbar).toEqual([{ id: 'b', label: 'B', icon: 'key', tool: 't' }]);
    const noTool = readAddonManifest({ ...MANIFEST, toolbar: [{ id: 'b', label: 'B', tool: 'nope' }] });
    expect(!noTool.ok && noTool.error).toBe('toolbar: "b" names no tool "nope"');
    expect(readAddonManifest({ ...MANIFEST, extra: 1 }).ok).toBe(false);
  });
});

describe('addon file names', () => {
  it('opens .looperaddon like the other Looper documents', () => {
    expect(isLooperFileName('C:\\x\\lapm.looperaddon')).toBe(true);
    expect(isAddonFileName('LAPM.LOOPERADDON')).toBe(true);
    expect(isAddonFileName('task.loopertask')).toBe(false);
  });
});

describe('engineLogSource', () => {
  it("tells an addon's lines, stderr included, from Looper's own", () => {
    expect(engineLogSource('addon lapm: #4 render account 300 ms')).toBe('addon:lapm');
    expect(engineLogSource('addon my.addon-2 stderr: #4 lapm show 290 ms')).toBe('addon:my.addon-2');
    expect(engineLogSource('cleared run history of t1')).toBe('looper');
    expect(engineLogSource('addons: something else')).toBe('looper');
  });
});

describe('addonSpawnLine', () => {
  const wsl = MANIFEST.run as AddonManifest['run'];

  it('crosses into WSL through a login bash from Windows', () => {
    expect(addonSpawnLine({ ...wsl, distro: 'Ubuntu', cwd: '/opt/demo' } as AddonManifest['run'], 'windows')).toEqual({
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '/opt/demo', '-e', 'bash', '-lic', 'exec "$@"', 'looper-addon', 'node', '/opt/demo/addon.mjs'],
    });
  });

  it('runs a WSL command locally when Looper itself is in WSL', () => {
    expect(addonSpawnLine(wsl, 'wsl')).toEqual({
      command: 'bash',
      args: ['-lic', 'exec "$@"', 'looper-addon', 'node', '/opt/demo/addon.mjs'],
    });
  });

  it('starts a Windows command directly, and refuses it where there is no Windows', () => {
    const win: AddonManifest['run'] = { on: 'windows', command: ['node.exe', 'C:\\demo\\addon.mjs'], cwd: 'C:\\demo' };
    expect(addonSpawnLine(win, 'windows')).toEqual({ command: 'node.exe', args: ['C:\\demo\\addon.mjs'], cwd: 'C:\\demo' });
    expect(addonSpawnLine(win, 'wsl')).toEqual({ command: 'node.exe', args: ['C:\\demo\\addon.mjs'] });
    expect(() => addonSpawnLine(win, 'mac')).toThrow('this addon runs on Windows');
  });
});

describe('addonEnv', () => {
  const run = { ...MANIFEST.run, env: { LAPM_BIN: '/x/lapm.js', LAPM_HOME: '/x/home' } } as AddonManifest['run'];

  it('names the manifest variables in WSLENV when the command crosses into WSL', () => {
    expect(addonEnv(run, 'windows', { PATH: 'C:\\', WSLENV: 'WT_SESSION' })).toEqual({
      PATH: 'C:\\',
      LAPM_BIN: '/x/lapm.js',
      LAPM_HOME: '/x/home',
      WSLENV: 'WT_SESSION:LAPM_BIN:LAPM_HOME',
    });
  });

  it('leaves WSLENV alone when nothing crosses', () => {
    expect(addonEnv(run, 'wsl', { PATH: '/bin' })).toEqual({ PATH: '/bin', LAPM_BIN: '/x/lapm.js', LAPM_HOME: '/x/home' });
    expect(addonEnv(MANIFEST.run as AddonManifest['run'], 'windows', { PATH: 'C:\\' })).toEqual({ PATH: 'C:\\' });
  });
});

describe('AddonScreenSchema', () => {
  it('checks nested nodes', () => {
    const ok = AddonScreenSchema.safeParse({
      title: 'X',
      body: [{ type: 'section', title: 'S', body: [{ type: 'props', items: [{ label: 'Password', secret: 'pw' }] }] }],
    });
    expect(ok.success).toBe(true);
    const bad = AddonScreenSchema.safeParse({ body: [{ type: 'section', title: 'S', body: [{ type: 'video' }] }] });
    expect(bad.success).toBe(false);
  });

  it('takes a toolbar with Looper icons and a menu bar', () => {
    const screen = {
      body: [],
      toolbar: [{ id: 'edit', label: 'Edit…', icon: 'edit' }, { separator: true }, { id: 'go', label: 'Go' }],
      menuBar: [{ label: '&File', items: [{ id: 'new', label: '&New…' }, { separator: true }] }],
    };
    expect(AddonScreenSchema.safeParse(screen).success).toBe(true);
    const ownIcon = { body: [], toolbar: [{ id: 'x', label: 'X', icon: 'rocket' }] };
    expect(AddonScreenSchema.safeParse(ownIcon).success).toBe(false);
  });
});

describe('matchesSearch', () => {
  const item = { id: 'db-1', label: 'db-1', view: 'server', description: 'postgres@db-1.example.com', group: 'Production', keywords: 'Linux' };

  it('matches the start of a word, in any case, and any of several words', () => {
    expect(matchesSearch(item, '')).toBe(true);
    expect(matchesSearch(item, '  ')).toBe(true);
    expect(matchesSearch(item, 'PROD')).toBe(true);
    expect(matchesSearch(item, 'exam')).toBe(true);
    expect(matchesSearch(item, 'gres')).toBe(false);
    expect(matchesSearch(item, 'windows')).toBe(false);
    expect(matchesSearch(item, 'windows linux')).toBe(true);
  });
});

describe('the fields lapm asked for', () => {
  it('takes search, keywords, checked and radio menu items, file fields', () => {
    const pane = {
      items: [{ id: 'a', label: 'A', view: 'v', keywords: 'alpha beta' }],
      search: { placeholder: 'Search accounts' },
      menu: [{ id: 'all', label: '&All', checked: true, radio: true }],
    };
    expect(AddonPaneContentSchema.safeParse(pane).success).toBe(true);
    const screen = {
      body: [
        { type: 'field', id: 'csv', label: 'Export file', input: 'file', accept: [{ label: 'CSV files', extensions: ['csv'] }] },
        { type: 'text', text: 'line one\nline two' },
      ],
    };
    expect(AddonScreenSchema.safeParse(screen).success).toBe(true);
    const noExtensions = { body: [{ type: 'field', id: 'f', label: 'F', input: 'file', accept: [{ label: 'X', extensions: [] }] }] };
    expect(AddonScreenSchema.safeParse(noExtensions).success).toBe(false);
  });
});

describe('AddonPaneContentSchema', () => {
  it('takes groups, a toolbar and a menu bar', () => {
    const pane = {
      items: [{ id: 'a', label: 'A', view: 'v', group: 'github.com' }],
      toolbar: [{ id: 'edit', label: 'Edit…', icon: 'edit', needsItem: true }],
      menuBar: [{ label: '&Edit', items: [{ id: 'edit', label: '&Edit…', needsItem: true }] }],
    };
    expect(AddonPaneContentSchema.safeParse(pane).success).toBe(true);
    expect(AddonPaneContentSchema.safeParse({ items: [{ id: 'a', label: 'A', view: 'v', group: '' }] }).success).toBe(false);
  });
});

// A real addon process through the real launcher (a login bash on this host).

const FAKE_ADDON = String.raw`
const readline = require('node:readline');
console.log('profile noise that is not JSON');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params;
  if (msg.method === 'initialize') return send({ id: msg.id, result: {} });
  if (msg.method === 'pane') return send({ id: msg.id, result: { items: [{ id: 'a', label: 'A', view: 'thing', params: { n: ++n } }] } });
  if (msg.method === 'render') {
    if (p.view === 'bad') return send({ id: msg.id, result: { body: [{ type: 'video' }] } });
    return send({ id: msg.id, result: { title: 'Thing ' + p.params.n, body: [{ type: 'text', text: 'hi' }] } });
  }
  if (msg.method === 'event') {
    if (p.id === 'boom') return send({ id: msg.id, error: { code: 1, message: 'It broke.' } });
    if (p.id === 'crash') { process.stderr.write('fatal: gone\n'); process.exit(3); }
    if (p.id === 'slow') return setTimeout(() => send({ id: msg.id, result: { value: 'secret-value' } }), 300);
    if (p.id === 'noisy') {
      process.stderr.write('bash: no job control in this shell\n');
      for (let i = 1; i <= 70; i++) process.stderr.write('line ' + i + '\n');
      return send({ id: msg.id, result: {} });
    }
    send({ method: 'refresh' });
    return send({ id: msg.id, result: { value: p.kind + ':' + p.id, actions: [{ type: 'refresh' }] } });
  }
}).on('close', () => process.exit(0));
`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

/** Keeps what's logged, as "[level] message". */
class MemoryLogger extends Logger {
  lines: string[] = [];
  override log(level: string, message: string): void {
    this.lines.push(`[${level}] ${message}`);
  }
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-addons-'));
  const script = path.join(root, 'addon.js');
  fs.writeFileSync(script, FAKE_ADDON);
  const changes: AddonInfo[][] = [];
  const refreshes: string[] = [];
  // Stands in for settings.disabledAddons.
  const store = { disabled: [] as string[] };
  const log = new MemoryLogger();
  const host = new AddonHost({
    dir: path.join(root, 'addons'),
    host: 'linux',
    appVersion: '0.0.0',
    log,
    onChange: (list) => changes.push(list),
    onRefresh: (id) => refreshes.push(id),
    disabled: () => store.disabled,
    setDisabled: (ids) => {
      store.disabled = ids;
    },
  });
  cleanups.push(() => {
    host.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const manifest = readAddonManifest({ ...MANIFEST, run: { on: 'wsl', command: [process.execPath, script] } });
  if (!manifest.ok) throw new Error('bad test manifest');
  return { root, host, changes, refreshes, store, log, manifest: manifest.manifest };
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('AddonHost', () => {
  it('installs, starts and talks to an addon', async () => {
    const { root, host, refreshes, manifest } = setup();
    host.install(manifest);
    expect(fs.existsSync(path.join(root, 'addons', 'demo.looperaddon'))).toBe(true);
    await until(() => host.list()[0]?.status === 'running');

    expect((await host.pane('demo', 'things')).items[0]).toMatchObject({ id: 'a', view: 'thing' });
    expect(await host.render('demo', 'thing', { n: 7 })).toEqual({ title: 'Thing 7', body: [{ type: 'text', text: 'hi' }] });
    await expect(host.render('demo', 'bad', {})).rejects.toThrow(/a screen Looper can't show:\nbody\.0\.type:/);

    const r = await host.event('demo', { source: { pane: 'things' }, kind: 'reveal', id: 'pw' });
    expect(r).toEqual({ value: 'reveal:pw', actions: [{ type: 'refresh' }] });
    expect(refreshes).toEqual(['demo']);
    await expect(host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'boom' })).rejects.toThrow('It broke.');
  }, 20_000);

  it('logs its startup, slow and failed requests, and its stderr, never values or replies', async () => {
    const { host, log, manifest } = setup();
    host.install(manifest);
    await until(() => host.list()[0]?.status === 'running');
    expect(log.lines).toContainEqual(expect.stringMatching(/^\[info\] addon demo: running after \d+ ms$/));

    // A fast request writes nothing.
    await host.render('demo', 'thing', { n: 1 });
    expect(log.lines.some((l) => l.includes('render thing'))).toBe(false);

    // Two slow events at once: the second was sent while the first was unanswered.
    const slow = { source: { view: 'thing', params: {} }, kind: 'click' as const, id: 'slow', values: { password: 'hunter2' } };
    await Promise.all([host.event('demo', slow), host.event('demo', slow)]);
    const slowLines = log.lines.filter((l) => l.includes('event click slow'));
    expect(slowLines[0]).toMatch(/^\[info\] addon demo: #\d+ event click slow \d+ ms$/);
    expect(slowLines[1]).toMatch(/^\[info\] addon demo: #\d+ event click slow \d+ ms \(1 in flight\)$/);

    await expect(host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'boom' })).rejects.toThrow();
    expect(log.lines).toContainEqual(expect.stringMatching(/^\[warn\] addon demo: #\d+ event click boom \d+ ms, failed: It broke\.$/));
    await expect(host.render('demo', 'bad', {})).rejects.toThrow();
    expect(log.lines).toContainEqual(expect.stringMatching(/^\[warn\] addon demo: #\d+ render bad \d+ ms, The addon sent a screen Looper can't show:\nbody\.0\.type:/));

    // Stderr: line by line without bash's own noise, up to 60 lines a minute.
    await host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'noisy' });
    await until(() => log.lines.some((l) => l.includes('the rest of the minute')));
    const stderr = log.lines.filter((l) => l.startsWith('[info] addon demo stderr: '));
    expect(stderr).toHaveLength(60);
    expect(stderr[0]).toBe('[info] addon demo stderr: line 1');
    expect(log.lines.some((l) => l.includes('job control'))).toBe(false);

    host.logSlowDraw('demo', 'thing', 812.4);
    host.logSlowDraw('other', 'thing', 900);
    expect(log.lines.filter((l) => l.includes('drawn after'))).toEqual(['[info] addon demo: render thing drawn after 812 ms']);

    expect(log.lines.join('\n')).not.toMatch(/hunter2|secret-value/);
  }, 20_000);

  it('reports why an addon stopped and restarts it', async () => {
    const { host, manifest } = setup();
    host.install(manifest);
    await until(() => host.list()[0]?.status === 'running');
    await expect(host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'crash' })).rejects.toThrow('Demo stopped.');
    await until(() => host.list()[0]?.status === 'stopped');
    expect(host.list()[0].error).toBe('It exited with code 3.\nfatal: gone');
    await expect(host.pane('demo', 'things')).rejects.toThrow("Demo isn't running.");

    host.restart('demo');
    await until(() => host.list()[0]?.status === 'running');
    expect(host.list()[0].error).toBeUndefined();
  }, 20_000);

  it('loads installed addons on start and removes them', async () => {
    const first = setup();
    first.host.install(first.manifest);
    first.host.dispose();
    const again = new AddonHost({
      dir: path.join(first.root, 'addons'),
      host: 'linux',
      appVersion: '0.0.0',
      log: new Logger(),
      onChange: () => undefined,
      onRefresh: () => undefined,
      disabled: () => [],
      setDisabled: () => undefined,
    });
    cleanups.push(() => again.dispose());
    again.start();
    expect(again.list().map((a) => a.id)).toEqual(['demo']);
    await until(() => again.list()[0]?.status === 'running');
    again.remove('demo');
    expect(again.list()).toEqual([]);
    expect(fs.existsSync(path.join(first.root, 'addons', 'demo.looperaddon'))).toBe(false);
  }, 20_000);

  it('stops an addon for good and starts it again', async () => {
    const { root, host, store, manifest } = setup();
    host.install(manifest);
    await until(() => host.list()[0]?.status === 'running');

    host.setEnabled('demo', false);
    expect(store.disabled).toEqual(['demo']);
    expect(host.list()[0]).toMatchObject({ enabled: false, status: 'stopped' });
    expect(host.list()[0].error).toBeUndefined();
    host.restart('demo');
    expect(host.list()[0].status).toBe('stopped');

    // The next time Looper starts, it stays stopped.
    const again = new AddonHost({
      dir: path.join(root, 'addons'),
      host: 'linux',
      appVersion: '0.0.0',
      log: new Logger(),
      onChange: () => undefined,
      onRefresh: () => undefined,
      disabled: () => store.disabled,
      setDisabled: (ids) => {
        store.disabled = ids;
      },
    });
    cleanups.push(() => again.dispose());
    again.start();
    expect(again.list()[0]).toMatchObject({ enabled: false, status: 'stopped' });

    again.setEnabled('demo', true);
    expect(store.disabled).toEqual([]);
    await until(() => again.list()[0]?.status === 'running');
    expect(again.list()[0].enabled).toBe(true);
  }, 20_000);
});
