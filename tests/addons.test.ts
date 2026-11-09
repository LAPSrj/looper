import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { AddonHost, addonEnv, addonLaunch, addonSpawnLine } from '../src/main/addon-host';
import type { Environment } from '../src/shared/types';
import {
  addonAdditions,
  AddonPaneContentSchema,
  AddonScreenSchema,
  engineLogSource,
  findToolCall,
  matchesSearch,
  readAddonManifest,
  toolCallMatches,
  toolCallTitle,
  withAddonDir,
  type AddonInfo,
  type AddonToolCall,
  type AddonManifest,
  type AddonLocalRun,
  type AddonRun,
} from '../src/shared/addons';
import { isAddonFileName, isLooperFileName } from '../src/shared/files';
import { addonTabId, mainTabs } from '../src/shared/main-tabs';

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

  it("places a command on Looper's tabs, its panes and screens, and nowhere else", () => {
    const placed = (where: object, menu = 'edit') => readAddonManifest({ ...MANIFEST, commands: [{ id: 'go', label: 'Go', menu, in: where }] });
    const r = placed({ tasks: { toolbar: true } });
    expect(r.ok && r.manifest.commands[0].in.tasks).toEqual({ toolbar: true });
    expect(r.ok && r.manifest.commands[0].menu).toBe('edit');
    expect(placed({ nowhere: {} }).ok).toBe(false);
    expect(placed({}).ok).toBe(false);
    expect(placed({ tasks: {} }, 'window').ok).toBe(false);
    expect(placed({ tasks: { menu: 'edit' } }).ok).toBe(false);
  });

  it('has one menu for a command, File for a New one', () => {
    const command = (over: object) => readAddonManifest({ ...MANIFEST, commands: [{ id: 'c', label: 'C', ...over }] });
    const noMenu = command({ in: { tasks: {} } });
    expect(!noMenu.ok && noMenu.error).toMatch(/^commands\.0\.menu: give the menu it goes in/);
    expect(command({ in: { new: {} } }).ok).toBe(true);
    expect(command({ menu: 'file', in: { new: {}, panes: {} } }).ok).toBe(true);
    const elsewhere = command({ menu: 'tools', in: { new: {} } });
    expect(!elsewhere.ok && elsewhere.error).toMatch(/a command in "new" goes in the file menu/);
  });

  it('refuses the old toolbar, tools and new lists', () => {
    for (const old of ['toolbar', 'tools', 'new']) expect(readAddonManifest({ ...MANIFEST, [old]: [] }).ok).toBe(false);
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
    const command = { id: 'c', label: 'C', menu: 'tools', in: { app: {} } };
    const twice = readAddonManifest({ ...MANIFEST, commands: [command, command] });
    expect(!twice.ok && twice.error).toBe('commands: duplicate id "c"');
    const { panes: _, ...noPanes } = MANIFEST;
    const noPane = readAddonManifest({ ...noPanes, commands: [{ ...command, in: { item: {} } }] });
    expect(!noPane.ok && noPane.error).toBe('commands: "c" is placed in panes the addon doesn\'t have');
    const panesTab = readAddonManifest({ ...MANIFEST, tabs: [{ id: 'panes', title: 'P', view: 'v' }] });
    expect(!panesTab.ok && panesTab.error).toBe('tabs: "panes" is the id of the panes\' own tab');
    expect(readAddonManifest({ ...MANIFEST, extra: 1 }).ok).toBe(false);
  });
});

describe('a command’s submenu', () => {
  const read = (over: object) => readAddonManifest({ ...MANIFEST, commands: [{ id: 'c', label: 'C', menu: 'view', in: { panes: {} }, ...over }] });
  const entry = { id: 'e', label: 'E' };

  it('takes items and lines between them', () => {
    expect(read({ entries: [entry, { separator: true }, { ...entry, id: 'f', check: 'radio', icon: 'key', opens: { view: 'v' }, confirm: 'Sure?', destructive: true }] }).ok).toBe(true);
  });

  it('refuses no items, one level below an item, and a check mark on the command itself', () => {
    expect(read({ entries: [] }).ok).toBe(false);
    expect(read({ entries: [{ ...entry, entries: [{ id: 'g', label: 'G' }] }] }).ok).toBe(false);
    const checked = read({ check: 'check', entries: [entry] });
    expect(!checked.ok && checked.error).toMatch(/a command with "entries" can't have a check mark/);
  });

  it('refuses an id twice among the commands and items, and a tab it doesn’t have', () => {
    const twice = read({ entries: [{ ...entry, id: 'c' }] });
    expect(!twice.ok && twice.error).toBe('commands: duplicate id "c"');
    const noTab = read({ entries: [{ ...entry, opens: { tab: 'nope' } }] });
    expect(!noTab.ok && noTab.error).toBe('commands: "e" opens a tab the addon doesn\'t have: "nope"');
  });

  it('takes `primary` only with items', () => {
    expect(read({ primary: true, entries: [entry] }).ok).toBe(true);
    const alone = read({ primary: true });
    expect(!alone.ok && alone.error).toMatch(/"primary" needs "entries"/);
  });
});

describe('addon file names', () => {
  it('opens .looperaddon like the other Looper documents', () => {
    expect(isLooperFileName('C:\\x\\lapm.looperaddon')).toBe(true);
    expect(isAddonFileName('LAPM.LOOPERADDON')).toBe(true);
    expect(isAddonFileName('task.loopertask')).toBe(false);
  });
});

describe('what a command opens', () => {
  const command = { id: 'c', label: 'C', menu: 'tools', in: { app: {} } };
  const opening = (opens: object, more: object = {}) => readAddonManifest({ ...MANIFEST, ...more, commands: [{ ...command, opens }] });

  it('opens a screen in a window, or a tab the addon has', () => {
    expect(opening({ view: 'settings', width: 500 }).ok).toBe(true);
    expect(opening({ tab: 'panes' }).ok).toBe(true);
    expect(opening({ tab: 'main' }, { tabs: [{ id: 'main', title: 'Main', view: 'v' }] }).ok).toBe(true);
  });

  it('refuses a tab the addon doesn’t have, and both at once', () => {
    const noTab = opening({ tab: 'nope' });
    expect(!noTab.ok && noTab.error).toBe('commands: "c" opens a tab the addon doesn\'t have: "nope"');
    const noPanes = opening({ tab: 'panes' }, { panes: [] });
    expect(!noPanes.ok && noPanes.error).toBe('commands: "c" opens a tab the addon doesn\'t have: "panes"');
    expect(opening({ tab: 'panes', view: 'v' }).ok).toBe(false);
  });
});

describe('tabs, icon-only buttons and a toolbar name', () => {
  it('takes tabs with fields inside, and refuses no tabs or two tabs with one id', () => {
    const tabs = (items: unknown[]) => AddonScreenSchema.safeParse({ body: [{ type: 'tabs', id: 'settings', items }] }).success;
    expect(
      tabs([
        { id: 'general', title: 'General', body: [{ type: 'field', id: 'folder', label: 'Vault folder', input: 'text' }] },
        { id: 'import', title: 'Import', body: [] },
      ]),
    ).toBe(true);
    expect(tabs([])).toBe(false);
    expect(
      tabs([
        { id: 'a', title: 'A', body: [] },
        { id: 'a', title: 'B', body: [] },
      ]),
    ).toBe(false);
  });

  it('takes a label beside a command’s icon, and refuses the old icon-only field', () => {
    const button = (over: object) => readAddonManifest({ ...MANIFEST, commands: [{ id: 'r', label: 'Refresh', menu: 'view', in: { app: { toolbar: true } }, ...over }] }).ok;
    expect(button({ icon: 'refresh' })).toBe(true);
    expect(button({ icon: 'refresh', labeled: true })).toBe(true);
    expect(button({ iconOnly: true, icon: 'refresh' })).toBe(false);
  });

  it('takes tabs for the main window, each with a screen, and refuses one id twice', () => {
    const tab = { id: 'monitor', title: 'Monitor', view: 'monitor', icon: 'search' };
    const r = readAddonManifest({ ...MANIFEST, tabs: [tab] });
    expect(r.ok && r.manifest.tabs).toEqual([tab]);
    expect(readAddonManifest({ ...MANIFEST, tabs: [tab, { ...tab, title: 'Again' }] })).toMatchObject({ ok: false, error: 'tabs: duplicate id "monitor"' });
    expect(readAddonManifest({ ...MANIFEST, tabs: [{ id: 'x', title: 'X' }] }).ok).toBe(false);
    expect(readAddonManifest(MANIFEST).ok && (readAddonManifest(MANIFEST) as { manifest: { tabs: unknown[] } }).manifest.tabs).toEqual([]);
  });

  it("puts the started addons' tabs after Looper's own, with a window icon when they name none", () => {
    const addon = (id: string, enabled: boolean) => ({ id, name: id.toUpperCase(), enabled, tabs: [{ id: 'main', title: `${id} tab`, view: 'v' }], panes: [], icons: {} });
    expect(mainTabs([addon('a', true), addon('b', false)]).map((t) => [t.id, t.label, t.icon])).toEqual([
      ['dashboard', 'Dashboard', 'dashboardTab'],
      ['projects', 'Projects', 'projectsTab'],
      ['tasks', 'Tasks', 'tasksTab'],
      ['chats', 'Chats', 'chatsTab'],
      [addonTabId('a', 'main'), 'a tab', 'window'],
    ]);
  });

  it('gives an addon’s panes a tab of their own, named after its one pane or else the addon', () => {
    const panes = [{ id: 'list', title: 'Servers' }] as never[];
    const only = { id: 'srv', name: 'Servers addon', enabled: true, tabs: [], panes, icons: {} };
    const tab = (title: string) => [{ id: 'main', title, view: 'v' }];
    const added = mainTabs([
      only,
      { ...only, id: 'off', enabled: false },
      { ...only, id: 'other', tabs: tab('Main') },
      { ...only, id: 'same', tabs: tab('Servers') },
      { ...only, id: 'two', panes: [...panes, { id: 'more', title: 'More' }] as never[] },
      { ...only, id: 'clash', panes: [...panes, { id: 'more', title: 'More' }] as never[], tabs: tab('Servers addon') },
    ]).slice(4);
    expect(added.map((t) => [t.id, t.label, t.icon])).toEqual([
      ['addon/srv/panes', 'Servers', 'window'],
      [addonTabId('other', 'main'), 'Main', 'window'],
      ['addon/other/panes', 'Servers', 'window'],
      [addonTabId('same', 'main'), 'Servers', 'window'],
      ['addon/same/panes', 'Servers List', 'window'],
      ['addon/two/panes', 'Servers addon', 'window'],
      [addonTabId('clash', 'main'), 'Servers addon', 'window'],
      ['addon/clash/panes', 'Servers addon List', 'window'],
    ]);
  });

  it('takes a name for the toolbar', () => {
    const r = readAddonManifest({ ...MANIFEST, toolbarName: 'Password' });
    expect(r.ok && r.manifest.toolbarName).toBe('Password');
  });

  it('takes a New item, with its toolbar button or without', () => {
    const r = readAddonManifest({ ...MANIFEST, commands: [{ id: 'server', label: 'New Server…', icon: 'add', in: { new: { toolbar: true } } }] });
    expect(r.ok && r.manifest.commands[0].in.new).toEqual({ toolbar: true });
    expect(readAddonManifest({ ...MANIFEST, commands: [{ id: 'server', label: 'New Server…', in: { new: {} } }] }).ok).toBe(true);
    expect(readAddonManifest({ ...MANIFEST, commands: [{ id: 'server', label: 'New Server…', in: { new: { menu: 'file' } } }] }).ok).toBe(false);
  });
});

describe('withAddonDir', () => {
  it('puts the folder the file was installed from into the command, working folder and environment', () => {
    const run: AddonRun = {
      on: 'wsl',
      command: ['node', '${addonDir}/addon.mjs'],
      cwd: '${addonDir}',
      env: { TOOL: '${addonDir}/../../tool.js', OTHER: 'x' },
    };
    expect(withAddonDir(run, '/home/sam/tools/demo')).toEqual({
      on: 'wsl',
      command: ['node', '/home/sam/tools/demo/addon.mjs'],
      cwd: '/home/sam/tools/demo',
      env: { TOOL: '/home/sam/tools/demo/../../tool.js', OTHER: 'x' },
    });
  });
});

describe('addonAdditions', () => {
  it('says in plain words where each thing the addon adds appears', () => {
    const command = (id: string, label: string, where: object) => ({ id, label, in: where });
    expect(
      addonAdditions({
        panes: [{ id: 'a', title: 'Passwords' }],
        commands: [
          { ...command('p', '&Passwords', { app: { toolbar: true } }), menu: 'tools' },
          { ...command('s', 'LAPM &Settings…', { app: {} }), menu: 'tools' },
          { ...command('edit', '&Edit…', { item: { toolbar: true } }), menu: 'edit' },
        ],
      } as never),
    ).toEqual(['A Passwords pane in a tab of its own', 'Passwords and LAPM Settings… in the Tools menu', 'A Passwords button on the toolbar']);
    expect(
      addonAdditions({
        panes: [
          { id: 'a', title: 'Servers' },
          { id: 'b', title: 'Keys' },
          { id: 'c', title: 'Logs' },
        ],
        commands: [],
      }),
    ).toEqual(['Servers, Keys and Logs panes in a tab of their own']);
    expect(addonAdditions({ panes: [], commands: [command('n', '&New Server…', { new: { toolbar: true } })] } as never)).toEqual([
      'New Server… in the File menu',
      'A New Server button on the toolbar',
    ]);
    expect(addonAdditions({ panes: [], commands: [], tabs: [{ id: 'm', title: 'Monitor', view: 'monitor' }] })).toEqual(['A Monitor tab in the main window']);
    expect(addonAdditions({ panes: [], commands: [] })).toEqual([]);
    expect(addonAdditions({ panes: [], commands: [], toolCalls: [{ tool: 'a' }, { tool: 'b' }] })).toEqual(['How 2 tools’ calls show on the Now tab']);
  });
});

describe('toolCalls', () => {
  const info = (id: string, toolCalls: AddonToolCall[], enabled = true) => ({ id, enabled, toolCalls }) as unknown as AddonInfo;

  it('takes how tool calls show, and refuses a misplaced "*", an unknown result or one tool twice', () => {
    const calls = [
      { tool: 'mcp__servers__deploy', title: 'Deploy {server}', params: ['server'], result: 'markdown' },
      { tool: 'mcp__servers__*', result: { view: 'call' } },
      { tool: 'mcp__servers__logs', result: 'code', language: 'json' },
    ];
    const r = readAddonManifest({ ...MANIFEST, toolCalls: calls });
    expect(r.ok && r.manifest.toolCalls).toEqual(calls);
    expect(readAddonManifest(MANIFEST).ok && (readAddonManifest(MANIFEST) as { manifest: AddonManifest }).manifest.toolCalls).toEqual([]);
    expect(readAddonManifest({ ...MANIFEST, toolCalls: [{ tool: 'a*b' }] }).ok).toBe(false);
    expect(readAddonManifest({ ...MANIFEST, toolCalls: [{ tool: 'a', result: 'html' }] }).ok).toBe(false);
    const twice = readAddonManifest({ ...MANIFEST, toolCalls: [{ tool: 'a' }, { tool: 'a' }] });
    expect(!twice.ok && twice.error).toBe('toolCalls: "a" is there twice');
  });

  it('picks the exact name first, then the longest "*", and skips addons stopped in the Addons window', () => {
    const exact = { tool: 'mcp__s__deploy', result: 'markdown' } as const;
    const broad = { tool: 'mcp__*', result: 'text' } as const;
    const narrow = { tool: 'mcp__s__*', result: 'table' } as const;
    const addons = [info('a', [broad]), info('b', [narrow, exact])];
    expect(findToolCall(addons, 'mcp__s__deploy')?.call).toBe(exact);
    expect(findToolCall(addons, 'mcp__s__logs')?.call).toBe(narrow);
    expect(findToolCall(addons, 'mcp__other__x')?.addon.id).toBe('a');
    expect(findToolCall(addons, 'Bash')).toBeUndefined();
    expect(findToolCall([info('a', [exact], false)], 'mcp__s__deploy')).toBeUndefined();
    expect(toolCallMatches({ tool: 'Read' }, 'ReadMore')).toBe(false);
  });

  it("fills a title's {name} with the call's parameters", () => {
    expect(toolCallTitle('Deploy {server} to {env}', { server: 'db-1', env: 'prod' })).toBe('Deploy db-1 to prod');
    expect(toolCallTitle('Run {n} ({missing})', { n: 3 })).toBe('Run 3 ()');
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

const ENV = (e: Partial<Environment> & Pick<Environment, 'id' | 'kind'>): Environment => ({ name: e.id, harnesses: [], ...e });

describe('addonSpawnLine', () => {
  const wsl = MANIFEST.run as AddonManifest['run'];

  it("crosses into WSL from Windows through the environment's distro and shell", () => {
    expect(addonSpawnLine({ ...wsl, cwd: '/opt/demo' }, 'windows', ENV({ id: 'u', kind: 'wsl', distro: 'Ubuntu' }))).toEqual({
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '/opt/demo', '-e', 'bash', '-lic', 'exec "$@"', 'looper-addon', 'node', '/opt/demo/addon.mjs'],
    });
    expect(addonSpawnLine(wsl, 'windows', ENV({ id: 'z', kind: 'wsl', shell: 'zsh -lc' })).args).toEqual([
      '-e', 'zsh', '-lc', 'exec "$@"', 'looper-addon', 'node', '/opt/demo/addon.mjs',
    ]);
  });

  it('runs a WSL command in the local shell when Looper itself is in WSL', () => {
    expect(addonSpawnLine(wsl, 'wsl', ENV({ id: 'local', kind: 'local' }))).toEqual({
      command: 'bash',
      args: ['-lic', 'exec "$@"', 'looper-addon', 'node', '/opt/demo/addon.mjs'],
    });
  });

  it('starts a Windows command directly, and refuses an environment on the other side', () => {
    const win: AddonManifest['run'] = { on: 'windows', command: ['node.exe', 'C:\\demo\\addon.mjs'], cwd: 'C:\\demo' };
    expect(addonSpawnLine(win, 'windows', ENV({ id: 'local', kind: 'local' }))).toEqual({
      command: 'node.exe',
      args: ['C:\\demo\\addon.mjs'],
      cwd: 'C:\\demo',
    });
    expect(addonSpawnLine(win, 'wsl', ENV({ id: 'w', kind: 'windows' }))).toEqual({ command: 'node.exe', args: ['C:\\demo\\addon.mjs'] });
    expect(() => addonSpawnLine(win, 'wsl', ENV({ id: 'local', name: 'Local', kind: 'local' }))).toThrow(
      `the "Local" environment can't run Windows programs`,
    );
  });
});

describe('addonLaunch', () => {
  const envs = [ENV({ id: 'local', kind: 'local' }), ENV({ id: 'ubuntu', kind: 'wsl' }), ENV({ id: 'debian', kind: 'wsl' })];
  const own = MANIFEST.run as AddonManifest['run'];

  it('runs in the default environment when it fits, else the first that does, else nowhere', () => {
    expect(addonLaunch(own, undefined, { environments: envs, defaultEnvironmentId: 'debian' }, 'windows').environment?.id).toBe('debian');
    expect(addonLaunch(own, undefined, { environments: envs, defaultEnvironmentId: 'local' }, 'windows').environment?.id).toBe('ubuntu');
    expect(addonLaunch(own, undefined, { environments: [envs[0]], defaultEnvironmentId: 'local' }, 'windows').environment).toBeUndefined();
  });

  it("uses the user's environment and command, and the default environment when theirs is gone", () => {
    const local = { environmentId: 'debian', command: ['node', '/home/sam/addon.mjs'] };
    const l = addonLaunch(own, local, { environments: envs, defaultEnvironmentId: 'local' }, 'windows');
    expect(l).toMatchObject({ run: { on: 'wsl', command: ['node', '/home/sam/addon.mjs'] }, environment: { id: 'debian' }, defaultEnvironment: { id: 'ubuntu' } });
    expect(addonLaunch(own, { ...local, environmentId: 'gone' }, { environments: envs, defaultEnvironmentId: 'local' }, 'windows').environment?.id).toBe('ubuntu');
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

  it('says how commands are, and has no toolbar or menu bar of its own', () => {
    expect(AddonScreenSchema.safeParse({ body: [], commands: { edit: { enabled: false }, lock: { label: '&Unlock', checked: true, hidden: false } } }).success).toBe(true);
    expect(AddonScreenSchema.safeParse({ body: [], commands: { edit: { icon: 'edit' } } }).success).toBe(true);
    expect(AddonScreenSchema.safeParse({ body: [], commands: { edit: { icon: '<svg>' } } }).success).toBe(false);
    expect(AddonScreenSchema.safeParse({ body: [], commands: { edit: { confirm: 'Sure?' } } }).success).toBe(false);
    for (const old of ['toolbar', 'menuBar', 'mobileMore']) expect(AddonScreenSchema.safeParse({ body: [], [old]: [] }).success).toBe(false);
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
  it('takes search, keywords, a check mark’s state, file fields', () => {
    const pane = {
      items: [{ id: 'a', label: 'A', view: 'v', keywords: 'alpha beta' }],
      search: { placeholder: 'Search accounts' },
      commands: { all: { checked: true } },
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
  it('takes groups and how commands are, for the pane and an item', () => {
    const pane = {
      items: [{ id: 'a', label: 'A', view: 'v', group: 'github.com', commands: { edit: { hidden: true } } }],
      commands: { all: { checked: true } },
    };
    expect(AddonPaneContentSchema.safeParse(pane).success).toBe(true);
    expect(AddonPaneContentSchema.safeParse({ items: [{ id: 'a', label: 'A', view: 'v', group: '' }] }).success).toBe(false);
  });

  it('has no toolbar, menu bar or item menus of its own', () => {
    for (const old of ['toolbar', 'menuBar', 'menu', 'mobileMore']) expect(AddonPaneContentSchema.safeParse({ items: [], [old]: [] }).success).toBe(false);
    expect(AddonPaneContentSchema.safeParse({ items: [{ id: 'a', label: 'A', view: 'v', menu: [] }] }).success).toBe(false);
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
  if (msg.method === 'pane') return send({ id: msg.id, result: { items: [{ id: process.env.DEMO_ITEM || 'a', label: 'A', view: 'thing', params: { n: ++n } }] } });
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

/** The test host (Linux) runs WSL-side addons in its local environment. */
const LOCAL_ENVS = () => ({ environments: [ENV({ id: 'local', kind: 'local' })], defaultEnvironmentId: 'local' });

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
  const store = { disabled: [] as string[], runs: {} as Record<string, AddonLocalRun> };
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
    runs: () => store.runs,
    setRuns: (runs) => {
      store.runs = runs;
    },
    environments: LOCAL_ENVS,
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

  it("runs the addon the way the user changed it, keeps that over a reinstall, and forgets it on remove", async () => {
    const { host, store, manifest } = setup();
    host.install(manifest);
    await until(() => host.list()[0]?.status === 'running');
    expect(host.list()[0]).toMatchObject({ localRun: undefined, environmentId: 'local', ownRun: manifest.run });

    const changed: AddonLocalRun = { environmentId: 'local', command: manifest.run.command, env: { DEMO_ITEM: 'mine' } };
    host.setRun('demo', changed);
    expect(store.runs).toEqual({ demo: changed });
    await until(() => host.list()[0]?.status === 'running');
    expect((await host.pane('demo', 'things')).items[0].id).toBe('mine');
    expect(host.list()[0]).toMatchObject({ localRun: changed, environmentId: 'local', ownRun: manifest.run });

    host.install(manifest);
    await until(() => host.list()[0]?.status === 'running');
    expect((await host.pane('demo', 'things')).items[0].id).toBe('mine');

    host.setRun('demo', undefined);
    await until(() => host.list()[0]?.status === 'running');
    expect((await host.pane('demo', 'things')).items[0].id).toBe('a');

    host.setRun('demo', changed);
    host.remove('demo');
    expect(store.runs).toEqual({});
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
      runs: () => ({}),
      setRuns: () => undefined,
      environments: LOCAL_ENVS,
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
      runs: () => store.runs,
      setRuns: (runs) => {
        store.runs = runs;
      },
      environments: LOCAL_ENVS,
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
