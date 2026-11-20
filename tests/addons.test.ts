import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { AddonHost, SLOW_REQUEST_MS, addonEnv, addonLaunch, addonSpawnLine, compareVersions, migrateAddonFiles, type AddonHostDeps } from '../src/main/addon-host';
import { readAddonPackage, zipEntries, PACKAGE_LIMITS } from '../src/main/addon-package';
import { zipSync, strToU8, type Zippable } from 'fflate';
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
  $version: 2,
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

  it('tells a newer or older format from a file that is not an addon', () => {
    expect(readAddonManifest({ ...MANIFEST, $version: 3 })).toEqual({ ok: false, reason: 'newer' });
    expect(readAddonManifest({ ...MANIFEST, $version: 1 })).toEqual({ ok: false, reason: 'older' });
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
        { type: 'field', id: 'dir', label: 'Folder', input: 'folder' },
        { type: 'text', text: 'line one\nline two' },
      ],
    };
    expect(AddonScreenSchema.safeParse(screen).success).toBe(true);
    const noExtensions = { body: [{ type: 'field', id: 'f', label: 'F', input: 'file', accept: [{ label: 'X', extensions: [] }] }] };
    expect(AddonScreenSchema.safeParse(noExtensions).success).toBe(false);
  });

  it('takes a list with its rows, its empty text and the buttons on its selected row', () => {
    const list = (extra: object) => ({ body: [{ type: 'field', id: 'deleted', label: 'Deleted accounts', input: 'list', ...extra }] });
    const ok = list({
      options: [{ value: 'a1', label: 'github.com · me', description: 'Deleted Nov 18' }],
      placeholder: 'The Recycle Bin is empty',
      buttons: [{ id: 'restore', label: 'Restore' }],
    });
    expect(AddonScreenSchema.safeParse(ok).success).toBe(true);
    expect(AddonScreenSchema.safeParse(list({ buttons: [{ id: 'restore' }] })).success).toBe(false);
    expect(AddonScreenSchema.safeParse(list({ options: [{ value: 'a1', label: 'github.com' }], readOnly: true })).success).toBe(true);
    expect(AddonScreenSchema.safeParse(list({ readOnly: 'yes' })).success).toBe(false);
  });

  it('takes a main instruction and a wizard’s Back, Next or named commit button', () => {
    const page = (footer: object, instruction: unknown = 'Choose the file Edge exported') =>
      AddonScreenSchema.safeParse({ instruction, body: [{ type: 'footer', ...footer }] }).success;
    expect(page({ wizard: { next: 'check' } })).toBe(true);
    expect(page({ wizard: { back: 'back', commit: { id: 'run', label: 'Import' } } })).toBe(true);
    expect(page({ primary: { id: 'save', label: 'Save' } })).toBe(true);
    expect(page({ wizard: { back: 'back' } })).toBe(false);
    expect(page({ wizard: { next: 'check', commit: { id: 'run', label: 'Import' } } })).toBe(false);
    expect(page({ wizard: { back: 'back', commit: { id: 'run' } } })).toBe(false);
    expect(page({ wizard: { next: 'check' }, primary: { id: 'save', label: 'Save' } })).toBe(false);
    expect(page({ wizard: { next: 'check' } }, '')).toBe(false);
  });

  it('takes a description for each option of a drop-down list', () => {
    const select = { type: 'field', id: 'browser', label: 'Browser', input: 'select', value: 'edge', options: [{ value: 'edge', label: 'Microsoft Edge', description: 'Go to edge://settings/passwords.' }] };
    expect(AddonScreenSchema.safeParse({ body: [select] }).success).toBe(true);
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


/** A .looperaddon package: a zip of these files (string contents, or bytes with zip options). */
function zipOf(files: Record<string, string | Uint8Array | [Uint8Array, object]>): Uint8Array {
  const z: Zippable = {};
  for (const [name, v] of Object.entries(files)) z[name] = typeof v === 'string' ? strToU8(v) : (v as never);
  return zipSync(z);
}

const ADDON_JSON = (over: object = {}) => JSON.stringify({ ...MANIFEST, ...over });

describe('addon packages', () => {
  it('reads the manifest at the root and every file beside it', async () => {
    const big = new Uint8Array(600 * 1024).fill(7);
    const r = await readAddonPackage(zipOf({ 'addon.json': ADDON_JSON(), 'addon.js': 'run()', 'bin/tool': [strToU8('#!/bin/sh'), { attrs: (0o100755 << 16) >>> 0, os: 3 }], 'data/big.bin': big }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe('demo');
    expect(r.files.map((f) => [f.name, f.executable])).toEqual([
      ['addon.json', false],
      ['addon.js', false],
      ['bin/tool', true],
      ['data/big.bin', false],
    ]);
    expect(r.files[3].data).toEqual(big);
  }, 20_000);

  it('tells an older, newer or invalid manifest, a zip without one and a file that is no zip', async () => {
    expect(await readAddonPackage(zipOf({ 'addon.json': ADDON_JSON({ $version: 3 }) }))).toEqual({ ok: false, reason: 'newer' });
    expect(await readAddonPackage(zipOf({ 'addon.json': ADDON_JSON({ $version: 1 }) }))).toEqual({ ok: false, reason: 'older' });
    expect(await readAddonPackage(zipOf({ 'addon.json': '{' }))).toMatchObject({ ok: false, reason: 'invalid', error: expect.stringMatching(/^addon\.json: /) });
    expect(await readAddonPackage(zipOf({ 'addon.json': ADDON_JSON({ run: { on: 'looper', command: [] } }) }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await readAddonPackage(zipOf({ 'sub/addon.json': ADDON_JSON() }))).toEqual({ ok: false, reason: 'not-addon' });
    expect(await readAddonPackage(strToU8('hello'))).toEqual({ ok: false, reason: 'not-addon' });
    // Format 1's file was the manifest alone, as JSON.
    expect(await readAddonPackage(strToU8(ADDON_JSON({ $version: 1 })))).toEqual({ ok: false, reason: 'older' });
    expect(await readAddonPackage(strToU8(ADDON_JSON()))).toEqual({ ok: false, reason: 'not-addon' });
  });

  it('refuses a path that leaves its folder, a link, a name twice and a package over the limits, before reading any', () => {
    const bad = (name: string) => zipEntries(zipOf({ 'addon.json': '{}', [name]: 'x' }));
    expect(bad('../evil.js')).toBe('"../evil.js" leaves the addon\'s folder.');
    expect(bad('a/../../evil.js')).toMatch(/leaves the addon's folder/);
    expect(bad('/etc/passwd')).toMatch(/is an absolute path/);
    expect(bad('C:/Windows/x.dll')).toMatch(/starts with a drive letter/);
    expect(bad('a\\b.js')).toMatch(/has a backslash/);
    expect(bad('addon.js:stream')).toMatch(/a character a file name can't have/);
    const link = zipOf({ 'addon.json': '{}', 'link': [strToU8('/etc/passwd'), { attrs: (0o120777 << 16) >>> 0, os: 3 }] });
    expect(zipEntries(link)).toBe('"link" is a link.');
    expect(zipEntries(zipOf({ 'addon.json': '{}', 'A.js': 'x', 'a.js': 'y' }))).toBe('"a.js" is in the package twice.');
    expect(zipEntries(zipOf({ 'addon.json': '{}', 'lib': 'x', 'lib/a.js': 'y' }))).toBe('"lib/a.js" is inside "lib", which is a file.');
    const three = zipOf({ 'addon.json': '{}', 'a.js': 'x', 'b.js': 'y' });
    expect(zipEntries(three, { ...PACKAGE_LIMITS, entries: 2 })).toBe('The package has 3 files; an addon can have 2.');
    expect(zipEntries(three, { entries: 10, bytes: 3 })).toMatch(/^The package's files take more than/);
    expect(zipEntries(strToU8('not a zip'))).toBeNull();
  });
});

describe('the looper runtime', () => {
  const run: AddonRun = { on: 'looper', command: ['${addonDir}/addon.js', '--flag'] };

  it("runs Looper's own executable with the script first, in the addon's folder unless it names one", () => {
    expect(addonSpawnLine(withAddonDir(run, '/data/addons/x'), 'windows', undefined, '/data/addons/x')).toEqual({
      command: process.execPath,
      args: ['/data/addons/x/addon.js', '--flag'],
      cwd: '/data/addons/x',
    });
    expect(addonSpawnLine({ ...run, cwd: '/elsewhere' }, 'wsl', undefined, '/data/addons/x').cwd).toBe('/elsewhere');
  });

  it('gives ELECTRON_RUN_AS_NODE to its process alone, under its own variables', () => {
    expect(addonEnv({ ...run, env: { A: '1' } }, 'windows', { PATH: 'p' })).toEqual({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', A: '1' });
    expect(addonEnv(MANIFEST.run as AddonRun, 'windows', { PATH: 'p' })).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('needs no environment', () => {
    const envs = { environments: [ENV({ id: 'ubuntu', kind: 'wsl' })], defaultEnvironmentId: 'ubuntu' };
    expect(addonLaunch(run, undefined, envs, 'windows')).toEqual({ run });
    expect(addonLaunch(run, { command: ['x.js'] }, envs, 'windows')).toEqual({ run: { on: 'looper', command: ['x.js'] } });
  });
});

describe('compareVersions', () => {
  it('compares dot-separated numbers', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
  });
});

describe('migrateAddonFiles', () => {
  it("moves each format 1 file to its own folder as addon.json with $version 2, and leaves the rest", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-addon-migrate-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const old = { ...MANIFEST, $version: 1, run: { on: 'wsl', command: ['node', '/home/sam/addons/demo/addon.mjs'] } };
    fs.writeFileSync(path.join(dir, 'demo.looperaddon'), JSON.stringify(old));
    fs.writeFileSync(path.join(dir, 'odd.looperaddon'), JSON.stringify({ $type: 'looper/addon', $version: 1, id: '../x' }));
    fs.writeFileSync(path.join(dir, 'notes.looperaddon'), 'not json');
    fs.mkdirSync(path.join(dir, 'kept'));
    fs.writeFileSync(path.join(dir, 'kept', 'addon.json'), ADDON_JSON({ id: 'kept' }));
    const log = new MemoryLogger();
    expect(await migrateAddonFiles(dir, log)).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'demo', 'addon.json'), 'utf8'))).toEqual({ ...old, $version: 2 });
    expect(fs.existsSync(path.join(dir, 'demo.looperaddon'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'odd.looperaddon'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'x'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'notes.looperaddon'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'kept', 'addon.json'), 'utf8')).toBe(ADDON_JSON({ id: 'kept' }));
    expect(log.lines.some((l) => l.includes('odd.looperaddon'))).toBe(true);
    // Once moved, there's nothing left to move.
    expect(await migrateAddonFiles(dir, log)).toBe(0);
    expect(await migrateAddonFiles(path.join(dir, 'none'), log)).toBe(0);
  });

  it('runs before the host reads its addons', async () => {
    const { root, deps, manifest } = setup();
    fs.mkdirSync(path.join(root, 'addons'));
    fs.writeFileSync(path.join(root, 'addons', 'demo.looperaddon'), JSON.stringify({ ...manifest, $version: 1 }));
    const host = new AddonHost(deps);
    cleanups.push(() => host.dispose());
    await host.start();
    expect(host.list().map((a) => a.id)).toEqual(['demo']);
    // A login bash and node starting on a loaded machine can take more than the usual wait.
    await until(() => host.list()[0]?.status === 'running', 30_000);
  }, 40_000);
});

// A real addon process through the real launcher (a login bash on this host).

const FAKE_ADDON = String.raw`
const readline = require('node:readline');
console.log('profile noise that is not JSON');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let n = 0;
let init;
const asked = {};
const notes = [];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params;
  // An answer to one of its own requests to Looper: the event that asked gets it.
  if (msg.method === undefined && asked[msg.id] !== undefined) {
    const eventId = asked[msg.id];
    delete asked[msg.id];
    return send({ id: eventId, result: { value: JSON.stringify(msg.error ? { error: msg.error } : { result: msg.result }) } });
  }
  if (msg.method === 'projectsChanged' || msg.method === 'activity') return notes.push({ method: msg.method, params: p });
  if (msg.method === 'projectTab') {
    if (p.projectId === 'bad') return send({ id: msg.id, result: { title: '' } });
    return send({ id: msg.id, result: { title: 'Tab ' + p.tab + ' ' + p.projectId } });
  }
  if (msg.method === 'initialize') {
    init = p;
    return send({ id: msg.id, result: {} });
  }
  if (msg.method === 'pane') return send({ id: msg.id, result: { items: [{ id: process.env.DEMO_ITEM || 'a', label: 'A', view: 'thing', params: { n: ++n } }] } });
  if (msg.method === 'render') {
    if (p.view === 'bad') return send({ id: msg.id, result: { body: [{ type: 'video' }] } });
    return send({ id: msg.id, result: { title: 'Thing ' + p.params.n, body: [{ type: 'text', text: 'hi' }] } });
  }
  if (msg.method === 'event') {
    if (p.id === 'init') return send({ id: msg.id, result: { value: JSON.stringify(init) } });
    if (p.id === 'cwd') return send({ id: msg.id, result: { value: JSON.stringify({ cwd: process.cwd(), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }) } });
    if (p.id === 'ask') {
      const qid = 'q' + ++n;
      asked[qid] = msg.id;
      return send({ id: qid, method: p.values.method, ...(p.values.params ? { params: JSON.parse(p.values.params) } : {}) });
    }
    if (p.id === 'open-self') {
      const qid = 'q' + ++n;
      asked[qid] = msg.id;
      return send({ id: qid, method: 'looper/openWindow', params: { view: 'v', title: 'T', request: msg.id } });
    }
    if (p.id === 'notes') return send({ id: msg.id, result: { value: JSON.stringify(notes) } });
    if (p.id === 'refresh-only') {
      send({ method: 'refresh', params: { views: ['thing'], projectTabs: true } });
      send({ method: 'refresh', params: { views: 3 } });
      send({ method: 'refresh', params: {} });
      return send({ id: msg.id, result: {} });
    }
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
// A plain shell: an interactive login one reads the machine's ~/.bashrc, seconds of each addon's start.
const LOCAL_ENVS = () => ({ environments: [ENV({ id: 'local', kind: 'local', shell: 'bash -c' })], defaultEnvironmentId: 'local' });

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
  const onlys: unknown[] = [];
  const requests: { addonId: string; method: string; params: unknown }[] = [];
  /** What host.originOf gave for each looper/openWindow's `request`, as it arrived. */
  const openOrigins: unknown[] = [];
  const stopped: string[] = [];
  // Stands in for settings.disabledAddons, addonRuns and removedBundledAddons.
  const store = { disabled: [] as string[], runs: {} as Record<string, AddonLocalRun>, removed: [] as string[] };
  const log = new MemoryLogger();
  const deps: AddonHostDeps = {
    dir: path.join(root, 'addons'),
    host: 'linux',
    appVersion: '0.0.0',
    log,
    onChange: (list) => changes.push(list),
    onRefresh: (id, only) => {
      refreshes.push(id);
      onlys.push(only);
    },
    disabled: () => store.disabled,
    setDisabled: (ids) => {
      store.disabled = ids;
    },
    runs: () => store.runs,
    setRuns: (runs) => {
      store.runs = runs;
    },
    environments: LOCAL_ENVS,
    request: async (addonId, method, params) => {
      requests.push({ addonId, method, params });
      if (method === 'looper/openWindow') {
        openOrigins.push(host.originOf(addonId, (params as { request: number }).request));
        await new Promise((r) => setTimeout(r, SLOW_REQUEST_MS + 100)); // a window stays open a while
        return {};
      }
      if ((params as { projectId?: string }).projectId === 'boom') throw new Error('No such project.');
      return { asked: method };
    },
    onStopped: (id) => stopped.push(id),
    removedBundled: () => store.removed,
    setRemovedBundled: (ids) => {
      store.removed = ids;
    },
  };
  const host = new AddonHost(deps);
  cleanups.push(() => {
    host.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const manifest = readAddonManifest({ ...MANIFEST, run: { on: 'wsl', command: [process.execPath, script] } });
  if (!manifest.ok) throw new Error('bad test manifest');
  return { root, host, deps, changes, refreshes, onlys, requests, openOrigins, stopped, store, log, manifest: manifest.manifest };
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
    await host.install({ manifest });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'addons', 'demo', 'addon.json'), 'utf8'))).toMatchObject({ $version: 2, id: 'demo' });
    await until(() => host.list()[0]?.status === 'running');

    expect((await host.pane('demo', 'things')).items[0]).toMatchObject({ id: 'a', view: 'thing' });
    expect(await host.render('demo', 'thing', { n: 7 })).toEqual({ title: 'Thing 7', body: [{ type: 'text', text: 'hi' }] });
    await expect(host.render('demo', 'bad', {})).rejects.toThrow(/a screen Looper can't show:\nbody\.0\.type:/);

    const r = await host.event('demo', { source: { pane: 'things' }, kind: 'reveal', id: 'pw' });
    expect(r).toEqual({ value: 'reveal:pw', actions: [{ type: 'refresh' }] });
    expect(refreshes).toEqual(['demo']);
    const init = await host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'init' });
    expect(JSON.parse(String(init.value))).toEqual({ protocol: 2, looper: '0.0.0', host: 'linux', dataDir: root, locale: expect.any(String) });
    await expect(host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'boom' })).rejects.toThrow('It broke.');
  }, 20_000);

  it('logs its startup, slow and failed requests, and its stderr, never values or replies', async () => {
    const { host, log, manifest } = setup();
    await host.install({ manifest });
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

  it("remembers what sent an event until the addon has answered it, and doesn't log a window open for a while as slow", async () => {
    const { host, log, openOrigins, manifest } = setup();
    await host.install({ manifest });
    await until(() => host.list()[0]?.status === 'running');
    const window = { name: 'the window that sent it' };
    const ev = { source: { pane: 'things' }, kind: 'click' as const, id: 'open-self' };
    const r = await host.event('demo', ev, window);
    // The addon asked for a window while the event was pending: its `request` led back to the sender.
    expect(openOrigins).toEqual([window]);
    expect(JSON.parse(String(r.value))).toEqual({ result: {} });
    // Answered: nothing is remembered. An event without an origin, or an id nothing is answering, has none.
    expect(host.originOf('demo', 2)).toBeUndefined();
    for (let id = 1; id < 12; id++) expect(host.originOf('demo', id)).toBeUndefined();
    expect(host.originOf('nobody', 1)).toBeUndefined();
    await host.event('demo', ev);
    expect(openOrigins[1]).toBeUndefined();
    expect(log.lines.some((l) => l.includes('looper/openWindow'))).toBe(false);
  }, 20_000);

  it('forgets the origin of an event that fails, and tells when its process stops, restarts or crashes', async () => {
    const { host, stopped, manifest } = setup();
    await host.install({ manifest });
    await until(() => host.list()[0]?.status === 'running');
    const sender = {};
    const slow = host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'slow' }, sender);
    const originOf = () => [1, 2, 3, 4, 5, 6].map((id) => host.originOf('demo', id)).find((o) => o === sender);
    expect(originOf()).toBe(sender);
    host.restart('demo');
    await expect(slow).rejects.toThrow('Demo stopped.');
    expect(originOf()).toBeUndefined();
    expect(stopped).toEqual(['demo']);
    await until(() => host.list()[0]?.status === 'running');
    await expect(host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'crash' }, sender)).rejects.toThrow('Demo stopped.');
    await until(() => host.list()[0]?.status === 'stopped');
    expect(originOf()).toBeUndefined();
    expect(stopped).toEqual(['demo', 'demo']);
    host.setEnabled('demo', true);
    await until(() => host.list()[0]?.status === 'running');
    host.setEnabled('demo', false);
    expect(stopped).toEqual(['demo', 'demo', 'demo']);
  }, 20_000);

  it("runs the addon the way the user changed it, keeps that over a reinstall, and forgets it on remove", async () => {
    const { host, store, manifest } = setup();
    await host.install({ manifest });
    await until(() => host.list()[0]?.status === 'running');
    expect(host.list()[0]).toMatchObject({ localRun: undefined, environmentId: 'local', ownRun: manifest.run });

    const changed: AddonLocalRun = { environmentId: 'local', command: manifest.run.command, env: { DEMO_ITEM: 'mine' } };
    host.setRun('demo', changed);
    expect(store.runs).toEqual({ demo: changed });
    await until(() => host.list()[0]?.status === 'running');
    expect((await host.pane('demo', 'things')).items[0].id).toBe('mine');
    expect(host.list()[0]).toMatchObject({ localRun: changed, environmentId: 'local', ownRun: manifest.run });

    await host.install({ manifest });
    await until(() => host.list()[0]?.status === 'running');
    expect((await host.pane('demo', 'things')).items[0].id).toBe('mine');

    host.setRun('demo', undefined);
    await until(() => host.list()[0]?.status === 'running');
    expect((await host.pane('demo', 'things')).items[0].id).toBe('a');

    host.setRun('demo', changed);
    await host.remove('demo');
    expect(store.runs).toEqual({});
  }, 20_000);

  it('reports why an addon stopped and restarts it', async () => {
    const { host, manifest, log } = setup();
    await host.install({ manifest });
    await until(() => host.list()[0]?.status === 'running');
    await expect(host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'crash' })).rejects.toThrow('Demo stopped.');
    await until(() => host.list()[0]?.status === 'stopped');
    expect(host.list()[0]).toMatchObject({ error: 'It stopped unexpectedly. What it wrote last is in the Engine Log.', crashed: true });
    expect(log.lines.some((l) => l.includes('It stopped unexpectedly.\nError code: 3\nfatal: gone'))).toBe(true);
    await expect(host.pane('demo', 'things')).rejects.toThrow("Demo isn't running.");

    host.restart('demo');
    await until(() => host.list()[0]?.status === 'running');
    expect(host.list()[0].error).toBeUndefined();
    expect(host.list()[0].crashed).toBeUndefined();
  }, 20_000);

  it('loads installed addons on start and removes them', async () => {
    const first = setup();
    await first.host.install({ manifest: first.manifest });
    first.host.dispose();
    const again = new AddonHost({ ...first.deps, log: new Logger(), onChange: () => undefined, onRefresh: () => undefined, disabled: () => [], runs: () => ({}) });
    cleanups.push(() => again.dispose());
    await again.start();
    expect(again.list().map((a) => a.id)).toEqual(['demo']);
    await until(() => again.list()[0]?.status === 'running');
    await again.remove('demo');
    expect(again.list()).toEqual([]);
    expect(fs.existsSync(path.join(first.root, 'addons', 'demo'))).toBe(false);
  }, 20_000);

  it('stops an addon for good and starts it again', async () => {
    const { host, deps, store, manifest } = setup();
    await host.install({ manifest });
    await until(() => host.list()[0]?.status === 'running');

    host.setEnabled('demo', false);
    expect(store.disabled).toEqual(['demo']);
    expect(host.list()[0]).toMatchObject({ enabled: false, status: 'stopped' });
    expect(host.list()[0].error).toBeUndefined();
    host.restart('demo');
    expect(host.list()[0].status).toBe('stopped');

    // The next time Looper starts, it stays stopped.
    const again = new AddonHost({ ...deps, log: new Logger(), onChange: () => undefined, onRefresh: () => undefined });
    cleanups.push(() => again.dispose());
    await again.start();
    expect(again.list()[0]).toMatchObject({ enabled: false, status: 'stopped' });

    again.setEnabled('demo', true);
    expect(store.disabled).toEqual([]);
    await until(() => again.list()[0]?.status === 'running');
    expect(again.list()[0].enabled).toBe(true);
  }, 20_000);
});

describe('AddonHost, format 2', () => {
  const looperManifest = (over: object = {}) => ({ ...MANIFEST, run: { on: 'looper', command: ['${addonDir}/addon.js'] }, ...over });

  it("unpacks a package into the addon's folder, runs a looper addon from it, and swaps in a new version", async () => {
    const { root, host, deps } = setup();
    const pkg = await readAddonPackage(zipOf({ 'addon.json': JSON.stringify(looperManifest()), 'addon.js': FAKE_ADDON, 'old.txt': 'v1' }));
    if (!pkg.ok) throw new Error('bad package');
    await host.install(pkg);
    const folder = path.join(root, 'addons', 'demo');
    // The stored manifest keeps ${addonDir} as written.
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'addon.json'), 'utf8')).run.command).toEqual(['${addonDir}/addon.js']);
    await until(() => host.list()[0]?.status === 'running');
    expect(host.list()[0].run).toBe(`${folder}/addon.js\nwith Looper’s Node`);
    const r = await host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'cwd' });
    expect(JSON.parse(String(r.value))).toEqual({ cwd: folder, runAsNode: '1' });
    // ELECTRON_RUN_AS_NODE reaches only the addon.
    expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined();

    const next = await readAddonPackage(zipOf({ 'addon.json': JSON.stringify(looperManifest({ version: '0.2.0' })), 'addon.js': FAKE_ADDON }));
    if (!next.ok) throw new Error('bad package');
    await host.install(next);
    expect(fs.existsSync(path.join(folder, 'old.txt'))).toBe(false);
    // The old version's folder, set aside, goes after.
    await until(() => fs.readdirSync(path.join(root, 'addons')).join() === 'demo');
    await until(() => host.list()[0]?.status === 'running' && host.list()[0].version === '0.2.0');

    const again = new AddonHost({ ...deps, log: new Logger() });
    cleanups.push(() => again.dispose());
    host.dispose();
    await again.start();
    expect(again.list().map((a) => [a.id, a.version])).toEqual([['demo', '0.2.0']]);
    await again.remove('demo');
    expect(fs.existsSync(folder)).toBe(false);
  }, 20_000);

  it("answers the addon's requests: checked params, the handler's result or error, and unknown methods", async () => {
    const { host, manifest, requests } = setup();
    await host.install({ manifest });
    await until(() => host.list()[0]?.status === 'running');
    const ask = async (method: string, params?: unknown) =>
      JSON.parse(String((await host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'ask', values: { method, ...(params ? { params: JSON.stringify(params) } : {}) } })).value));
    expect(await ask('looper/projects')).toEqual({ result: { asked: 'looper/projects' } });
    expect(await ask('looper/exec', { projectId: 'p1', argv: ['git', 'status'] })).toEqual({ result: { asked: 'looper/exec' } });
    expect(requests.map((r) => [r.addonId, r.method, r.params])).toEqual([
      ['demo', 'looper/projects', {}],
      ['demo', 'looper/exec', { projectId: 'p1', argv: ['git', 'status'] }],
    ]);
    expect(await ask('looper/exec', { projectId: 'boom', argv: ['git'] })).toEqual({ error: { code: 1, message: 'No such project.' } });
    const invalid = await ask('looper/exec', { argv: [] });
    expect(invalid.error.code).toBe(-32602);
    expect(invalid.error.message).toMatch(/^Invalid params for looper\/exec:\n/);
    expect(await ask('looper/nothing')).toEqual({ error: { code: -32601, message: 'Looper has no method "looper/nothing"' } });
    expect(requests).toHaveLength(3);
  }, 20_000);

  it('tells running addons, asks for project tabs, and reads what a refresh names', async () => {
    const { host, manifest, refreshes, onlys, log } = setup();
    await host.install({ manifest });
    await until(() => host.list()[0]?.status === 'running');
    host.notify({ method: 'projectsChanged', params: {} });
    host.notify({ method: 'activity', params: { projectId: 'p1', working: true } });
    const notes = JSON.parse(String((await host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'notes' })).value));
    expect(notes).toEqual([
      { method: 'projectsChanged', params: {} },
      { method: 'activity', params: { projectId: 'p1', working: true } },
    ]);

    expect(await host.projectTab('demo', 'git', 'p1')).toEqual({ title: 'Tab git p1' });
    // The same question asked again while the addon answers it gets that answer: one call, one engine log line.
    const [a, b] = await Promise.all([host.projectTab('demo', 'git', 'p1'), host.projectTab('demo', 'git', 'p1')]);
    expect(a).toBe(b);
    // Asked again once it's answered, it goes to the addon again.
    expect(await host.projectTab('demo', 'git', 'p1')).not.toBe(a);
    await expect(host.projectTab('demo', 'git', 'bad')).rejects.toThrow(/a project tab Looper can't show/);

    await host.event('demo', { source: { pane: 'things' }, kind: 'click', id: 'refresh-only' });
    await until(() => refreshes.length >= 3);
    expect(onlys).toEqual([{ views: ['thing'], projectTabs: true }, undefined, {}]);
    expect(log.lines.some((l) => l.startsWith("[warn] addon demo: refresh with params Looper can't read"))).toBe(true);
  }, 20_000);

  it('installs the packages Looper comes with, updates them, and keeps one the user removed away until installed by hand', async () => {
    const { root, deps, store } = setup();
    const bundled = path.join(root, 'bundled');
    fs.mkdirSync(bundled);
    const writeBundled = (version: string) =>
      fs.writeFileSync(path.join(bundled, 'demo.looperaddon'), zipOf({ 'addon.json': JSON.stringify(looperManifest({ version })), 'addon.js': FAKE_ADDON }));
    writeBundled('0.1.0');
    let host = new AddonHost({ ...deps, bundledDir: bundled });
    cleanups.push(() => host.dispose());
    await host.start();
    await host.installBundled();
    expect(host.list().map((a) => [a.id, a.version])).toEqual([['demo', '0.1.0']]);
    // Stopped by the user, it stays stopped through an update.
    host.setEnabled('demo', false);

    writeBundled('0.2.0');
    host.dispose();
    host = new AddonHost({ ...deps, bundledDir: bundled });
    cleanups.push(() => host.dispose());
    await host.start();
    await host.installBundled();
    expect(host.list()[0]).toMatchObject({ version: '0.2.0', enabled: false });

    await host.remove('demo', true);
    expect(store.removed).toEqual(['demo']);
    await host.installBundled();
    expect(host.list()).toEqual([]);

    const pkg = await readAddonPackage(fs.readFileSync(path.join(bundled, 'demo.looperaddon')));
    if (!pkg.ok) throw new Error('bad package');
    await host.install(pkg);
    expect(store.removed).toEqual([]);
    expect(host.list()[0]).toMatchObject({ version: '0.2.0', enabled: true });
  }, 30_000);
});
