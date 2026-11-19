import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnknownMethodError, createGitAddon, type GitAddon } from '../src/addons/git/addon';
import {
  ADDON_REQUESTS,
  AddonEventResultSchema,
  AddonPaneContentSchema,
  AddonProjectTabStateSchema,
  AddonRefreshSchema,
  AddonScreenSchema,
  readAddonManifest,
  type AddonEvent,
  type AddonExecResult,
  type AddonNode,
  type AddonProjectInfo,
  type AddonRefresh,
  type AddonRequestMethod,
  type AddonScreen,
} from '../src/shared/addons';

// git runs as it would for a user with no settings of their own.
let tmp: string;
let gitEnv: Record<string, string>;
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv }, encoding: 'utf8' });

/** Runs looper/exec like Looper: argv without a shell, in the project's folder or `cwd`. */
function runExec(cwd: string, argv: string[], env: Record<string, string> = {}, stdin?: string): Promise<AddonExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...gitEnv, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin ?? '');
  });
}

/** A Looper that answers the addon's requests, checking each one against the protocol. */
class FakeLooper {
  projects: AddonProjectInfo[] = [];
  refreshes: AddonRefresh[] = [];
  /** Each looper/exec's params. */
  execs: Record<string, unknown>[] = [];
  /** Each looper/openWindow's params; `onWindow` acts out the user, and the request resolves when it does (the window closed). */
  windows: Record<string, unknown>[] = [];
  onWindow?: (params: Record<string, unknown>) => Promise<unknown>;
  /** Variables of the programs an environment runs, on top of git's: an environment without git. */
  envVars: Record<string, Record<string, string>> = {};
  /** The order of the requests that change something. */
  order: string[] = [];
  created: { name: string; cwd: string; environmentId?: string }[] = [];
  working: string[] = [];
  /** Replaces a git run's result, to act out a remote that fails. */
  fake?: (argv: string[]) => AddonExecResult | undefined;
  running = 0;
  mostRunning = 0;

  link = {
    request: (method: AddonRequestMethod, params: Record<string, unknown>) => this.request(method, params),
    refresh: (params: AddonRefresh) => {
      AddonRefreshSchema.parse(params);
      this.refreshes.push(params);
    },
  };

  async request(method: AddonRequestMethod, params: Record<string, unknown>): Promise<unknown> {
    ADDON_REQUESTS[method].parse(params);
    switch (method) {
      case 'looper/projects':
        return this.projects.map((p) => ({ ...p }));
      case 'looper/environments':
        return [
          { id: 'wsl', name: 'WSL', side: 'wsl', default: true },
          { id: 'bare', name: 'Bare', side: 'wsl', default: false },
        ];
      case 'looper/activity':
        return { working: this.working };
      case 'looper/openWindow':
        this.windows.push(params);
        return this.onWindow ? this.onWindow(params) : {};
      case 'looper/createProject': {
        const p = params as { name: string; cwd: string; environmentId?: string };
        this.created.push(p);
        this.order.push(method);
        const id = `p${this.projects.length + 1}`;
        this.projects.push({ id, name: p.name, cwd: p.cwd, environmentId: p.environmentId ?? 'wsl', side: 'wsl' });
        return { id };
      }
      case 'looper/exec': {
        const p = params as { projectId?: string; environmentId?: string; cwd?: string; argv: string[]; env?: Record<string, string>; stdin?: string };
        this.execs.push(params);
        const faked = this.fake?.(p.argv);
        if (faked) return faked;
        const project = this.projects.find((x) => x.id === p.projectId);
        if (p.projectId && !project) throw new Error('The project no longer exists.');
        this.running++;
        this.mostRunning = Math.max(this.mostRunning, this.running);
        try {
          const vars = this.envVars[project?.environmentId ?? p.environmentId ?? 'wsl'] ?? {};
          return await runExec(p.cwd ?? project!.cwd, p.argv, { ...vars, ...p.env }, p.stdin);
        } finally {
          this.running--;
        }
      }
    }
    throw new Error(`unexpected ${method}`);
  }
}

let looper: FakeLooper;
let addon: GitAddon;
let repoDir: string;
let plainDir: string;
let remoteDir: string;

const screen = async (view: string, params: Record<string, unknown> = {}): Promise<AddonScreen> =>
  AddonScreenSchema.parse(await addon.handle('render', { view, params })) as AddonScreen;
const event = async (ev: AddonEvent, request?: number) =>
  AddonEventResultSchema.parse(await addon.handle('event', ev as unknown as Record<string, unknown>, request ? { request } : {}));
const pane = async () => AddonPaneContentSchema.parse(await addon.handle('pane', { pane: 'repositories' }));
/** A project's pane item id, as the addon gives it. */
const itemOf = (projectId: string) => (/^[a-z0-9][a-z0-9._:-]*$/i.test(projectId) && !projectId.startsWith('x-') ? projectId : `x-${Buffer.from(projectId).toString('hex')}`);
/** Drops the addon's cached status, as Looper's projectsChanged does. */
const fresh = () => addon.notify('projectsChanged', {});

function find<T extends AddonNode['type']>(nodes: AddonNode[], type: T): Extract<AddonNode, { type: T }>[] {
  const out: AddonNode[] = [];
  const walk = (list: AddonNode[]) => {
    for (const n of list) {
      if (n.type === type) out.push(n);
      if (n.type === 'tabs') for (const t of n.items) walk(t.body);
      if (n.type === 'section') walk(n.body);
    }
  };
  walk(nodes);
  return out as Extract<AddonNode, { type: T }>[];
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'looper-git-addon-'));
  const config = path.join(tmp, 'gitconfig');
  writeFileSync(config, '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  gitEnv = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', HOME: tmp };
  repoDir = path.join(tmp, 'repo');
  plainDir = path.join(tmp, 'plain');
  remoteDir = path.join(tmp, 'remote.git');
  mkdirSync(repoDir);
  mkdirSync(plainDir);
  sh(tmp, 'init', '--bare', remoteDir);
  sh(repoDir, 'init');
  writeFileSync(path.join(repoDir, 'a.txt'), 'one\ntwo\nthree\n');
  sh(repoDir, 'add', '.');
  sh(repoDir, 'commit', '-m', 'First');
  mkdirSync(path.join(repoDir, 'src'));
  writeFileSync(path.join(repoDir, 'src', 'old name.ts'), 'export const x = 1;\n');
  sh(repoDir, 'add', '.');
  sh(repoDir, 'commit', '-m', 'Second', '-m', 'With a body.');
  looper = new FakeLooper();
  looper.projects = [
    { id: 'repo', name: 'Repo', cwd: repoDir, environmentId: 'wsl', side: 'wsl' },
    { id: 'plain folder', name: 'Plain', cwd: plainDir, environmentId: 'wsl', side: 'wsl' },
  ];
  // The program git's prompts run, as the package has it.
  const askpassJs = path.join(tmp, 'askpass.js');
  await build({ entryPoints: [path.resolve(__dirname, '../src/addons/git/askpass-client.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: askpassJs, logLevel: 'silent' });
  addon = createGitAddon(looper.link, { activityPollMs: 100, askpassClient: askpassJs });
});

afterAll(() => {
  addon.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('the Git addon with a fake Looper', () => {
  it('answers initialize and scans nothing', async () => {
    expect(await addon.handle('initialize', { protocol: 2, looper: 'test', host: 'wsl', dataDir: tmp, locale: 'de-DE' })).toEqual({});
    expect(looper.mostRunning).toBe(0);
  });

  it('lists the projects as repositories and folders without one', async () => {
    const p = await pane();
    expect(p.items.map((i) => [i.label, i.group, i.description])).toEqual([
      ['Repo', 'Repositories', 'main'],
      ['Plain', 'No repository', plainDir],
    ]);
    expect(p.items[0]).toMatchObject({ view: 'repo', params: { projectId: 'repo' }, keywords: repoDir });
    expect(p.items[0].commands).toMatchObject({ init: { hidden: true }, commit: { enabled: false }, push: { enabled: false } });
    expect(p.items[1].commands).toMatchObject({ init: { hidden: false }, commit: { hidden: true } });
    expect(p.items[1].id).toMatch(/^x-/);
    expect(p).toMatchObject({ search: { placeholder: 'Search repositories' }, empty: 'No projects yet.' });
    expect(looper.mostRunning).toBeLessThanOrEqual(4);
  });

  it('shows a repository with its changes and history', async () => {
    writeFileSync(path.join(repoDir, 'a.txt'), 'one\n2\nthree\n');
    writeFileSync(path.join(repoDir, 'b.txt'), 'new\n');
    sh(repoDir, 'mv', 'src/old name.ts', 'src/new name.ts');
    fresh();
    const s = await screen('repo', { projectId: 'repo' });
    expect(s.title).toBe('Repo');
    expect(find(s.body, 'props')[0].items.map((i) => [i.label, i.value])).toEqual([
      ['Folder', repoDir],
      ['Branch', 'main'],
      ['Status', 'Not tracking a remote branch'],
    ]);
    const [changes, history] = find(s.body, 'listDetail');
    expect(changes.items.map((r) => [r.title, r.subtitle, r.value])).toEqual([
      ['a.txt', undefined, 'Modified'],
      ['new name.ts', 'from src/old name.ts', 'Renamed, staged'],
      ['b.txt', undefined, 'Untracked'],
    ]);
    expect(history.items.map((r) => r.title)).toEqual(['Second', 'First']);
    // The date in initialize's locale (de-DE: "19.11.26, 08:47").
    expect(history.items[0].subtitle).toMatch(/^Test User · \d{2}\.\d{2}\.\d{2}, \d{2}:\d{2} · [0-9a-f]{7} · main$/);
    expect(history.more).toBeUndefined();
    expect(s.commands).toMatchObject({ commit: { enabled: true } });

    const project = await screen('project', { projectId: 'repo' });
    expect(project.body[0]).toEqual({ type: 'text', text: 'On main · not tracking a remote branch', muted: true });
    expect(project.refreshSec).toBe(60);
  });

  it('shows a change, a commit and a commit file', async () => {
    const s = await screen('project', { projectId: 'repo' });
    const [changes, history] = find(s.body, 'listDetail');
    // A rename with nothing else changed has no lines to show.
    const hunks: number[] = [];
    for (const row of changes.items) {
      const detail = await screen(row.detail!.view, row.detail!.params);
      hunks.push(find(detail.body, 'diff')[0].hunks.length);
    }
    expect(hunks).toEqual([1, 0, 1]);
    const modified = await screen(changes.items[0].detail!.view, changes.items[0].detail!.params);
    expect(find(modified.body, 'diff')[0]).toMatchObject({ title: 'a.txt', subtitle: 'Modified' });
    expect(find(modified.body, 'diff')[0].hunks[0].lines).toEqual([' one', '-two', '+2', ' three']);

    const commit = await screen(history.items[0].detail!.view, history.items[0].detail!.params);
    expect(commit.title).toBe('Second');
    expect(commit.body[0]).toEqual({ type: 'text', text: 'With a body.' });
    expect(find(commit.body, 'props')[0].items[0]).toEqual({ label: 'Author', value: 'Test User <test@example.com>' });
    const files = find(commit.body, 'listDetail')[0];
    expect(files.items.map((f) => [f.title, f.value])).toEqual([['old name.ts', 'Added']]);
    const file = await screen(files.items[0].detail!.view, files.items[0].detail!.params);
    expect(find(file.body, 'diff')[0]).toMatchObject({ title: 'src/old name.ts', subtitle: 'Added', hunks: [{ lines: ['+export const x = 1;'] }] });
  });

  it("says each project tab's title, and hides it for a folder that isn't a repository", async () => {
    expect(AddonProjectTabStateSchema.parse(await addon.handle('projectTab', { tab: 'git', projectId: 'repo' }))).toEqual({ title: 'Git (+1 ~2)' });
    expect(await addon.handle('projectTab', { tab: 'git', projectId: 'plain folder' })).toEqual({ hidden: true });
  });

  it('commits the checked files', async () => {
    const w = await screen('commit-window', { projectId: 'repo' });
    const files = find(w.body, 'field').find((f) => f.id === 'files')!;
    expect(files.input).toBe('checklist');
    expect(files.value).toEqual(['a.txt', 'src/new name.ts', 'b.txt']);
    expect(find(w.body, 'footer')[0]).toMatchObject({ primary: { id: 'commit', label: 'Commit' } });

    const opened = await event({ source: { pane: 'repositories' }, kind: 'command', id: 'commit', item: 'repo' });
    expect(opened.actions?.[0]).toMatchObject({ type: 'openWindow', view: 'commit-window', params: { projectId: 'repo' } });

    const empty = await event({ source: { view: 'commit-window', params: { projectId: 'repo' } }, kind: 'click', id: 'commit', values: { message: ' ', files: [] } });
    expect(empty).toEqual({ errors: { message: 'The commit message is empty' } });

    const r = await event({
      source: { view: 'commit-window', params: { projectId: 'repo' } },
      kind: 'click',
      id: 'commit',
      values: { message: 'Third\n\nRename and add.', files: ['src/new name.ts', 'b.txt'], amend: false },
    });
    expect(r).toEqual({ actions: [{ type: 'closeWindow' }] });
    expect(sh(repoDir, 'log', '-1', '--format=%B').trim()).toBe('Third\n\nRename and add.');
    expect(sh(repoDir, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['A\tb.txt', 'R100\tsrc/old name.ts\tsrc/new name.ts']);
    expect(sh(repoDir, 'status', '--porcelain').trim()).toBe('M a.txt');
    expect(looper.refreshes.at(-1)).toMatchObject({ panes: ['repositories'], projectTabs: true });
  });

  it('creates and switches branches', async () => {
    const w = await screen('branches', { projectId: 'repo' });
    const list = find(w.body, 'field').find((f) => f.id === 'branch')!;
    expect(list.options).toEqual([{ value: 'main', label: 'main', description: 'The current branch' }]);
    const source = { view: 'branches', params: { projectId: 'repo' } };
    expect(await event({ source, kind: 'click', id: 'create-branch', values: { newBranch: 'feature' } })).toEqual({ values: { newBranch: '' } });
    expect(sh(repoDir, 'branch', '--show-current').trim()).toBe('feature');
    expect(await event({ source, kind: 'click', id: 'switch', values: { branch: 'main' } })).toEqual({});
    expect(sh(repoDir, 'branch', '--show-current').trim()).toBe('main');
    const failed = await event({ source, kind: 'click', id: 'switch', values: { branch: 'nowhere' } });
    expect(failed.actions?.[0]).toMatchObject({ type: 'message', kind: 'error', message: 'Can\'t switch to "nowhere"' });
    expect((failed.actions?.[0] as { detail?: string }).detail).toMatch(/nowhere/);
  });

  it('creates a repository', async () => {
    const r = await event({ source: { view: 'repo', params: { projectId: 'plain folder' } }, kind: 'click', id: 'init' });
    expect(r).toEqual({});
    const p = await pane();
    expect(p.items.map((i) => i.group)).toEqual(['Repositories', 'Repositories']);
    expect(await addon.handle('projectTab', { tab: 'git', projectId: 'plain folder' })).toEqual({ title: 'Git' });
    const s = await screen('project', { projectId: 'plain folder' });
    expect(find(s.body, 'text')[0].text).toBe('On main · no commits yet');
    expect(find(s.body, 'listDetail')[1].items).toEqual([]);
    // The first commit, of an untracked file.
    writeFileSync(path.join(plainDir, 'first.txt'), 'hello\n');
    fresh();
    const w = await screen('commit-window', { projectId: 'plain folder' });
    expect(find(w.body, 'field').map((f) => f.id)).toEqual(['message', 'files']);
    const r2 = await event({ source: { view: 'commit-window', params: { projectId: 'plain folder' } }, kind: 'click', id: 'commit', values: { message: 'Start', files: ['first.txt'] } });
    expect(r2).toEqual({ actions: [{ type: 'closeWindow' }] });
    expect(sh(plainDir, 'log', '--format=%s').trim()).toBe('Start');
  });

  it('pushes a branch without an upstream to the only remote, then syncs and fetches', async () => {
    sh(repoDir, 'remote', 'add', 'origin', remoteDir);
    fresh();
    expect((await pane()).items[0].commands).toMatchObject({ push: { enabled: true } });
    expect(await event({ source: { app: true }, kind: 'command', id: 'push', project: 'repo' })).toEqual({});
    expect(sh(remoteDir, 'log', '--format=%s', 'main').trim().split('\n')).toEqual(['Third', 'Second', 'First']);
    const s = await screen('repo', { projectId: 'repo' });
    expect(find(s.body, 'props')[0].items.slice(2)).toEqual([
      { label: 'Status', value: 'Up to date with origin/main' },
      { label: 'Remote', value: remoteDir, mono: true, copy: true },
    ]);
    expect(await event({ source: { view: 'repo', params: { projectId: 'repo' } }, kind: 'command', id: 'sync' })).toEqual({});
    expect(await event({ source: { view: 'repo', params: { projectId: 'repo' } }, kind: 'command', id: 'fetch' })).toEqual({});
  });

  it("shows git's failure", async () => {
    looper.fake = (argv) => (argv.includes('pull') ? { code: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.\n' } : undefined);
    const r = await event({ source: { app: true }, kind: 'command', id: 'sync', project: 'repo' });
    expect(r.actions).toEqual([{ type: 'message', kind: 'error', message: "Can't pull", detail: 'Not possible to fast-forward, aborting.' }]);
    looper.fake = undefined;
  });

  it('pages the history with a more event', async () => {
    const before = looper.refreshes.length;
    expect(await event({ source: { view: 'project', params: { projectId: 'repo' } }, kind: 'more', id: 'history' })).toEqual({});
    expect(looper.refreshes.slice(before)).toEqual([{ views: ['project'] }]);
  });

  it('clones into a folder and adds the project', async () => {
    const clone = await screen('clone');
    expect(find(clone.body, 'field').map((f) => [f.id, f.input])).toEqual([
      ['url', 'text'],
      ['folder', 'folder'],
      ['name', 'text'],
      ['environment', 'select'],
      ['add', 'checkbox'],
    ]);
    const r = await event({
      source: { view: 'clone', params: {} },
      kind: 'click',
      id: 'clone',
      values: { url: remoteDir, folder: tmp, name: '', environment: 'wsl', add: true },
    });
    expect(looper.created).toEqual([{ name: 'remote', cwd: path.join(tmp, 'remote'), environmentId: 'wsl' }]);
    expect(r.actions).toEqual([{ type: 'closeWindow' }, { type: 'refresh' }, { type: 'select', pane: 'repositories', item: 'p3' }]);
    expect(readFileSync(path.join(tmp, 'remote', 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    looper.order = [];
    // A clone that fails adds no project.
    looper.fake = (argv) => (argv.includes('clone') ? { code: 128, stdout: '', stderr: "fatal: could not read Username for 'https://example.com': terminal prompts disabled\n" } : undefined);
    const secret = await event({
      source: { view: 'clone', params: {} },
      kind: 'click',
      id: 'clone',
      values: { url: 'https://example.com/me/private.git', folder: tmp, name: '', environment: 'wsl', add: true },
    });
    looper.fake = undefined;
    expect(looper.order).toEqual([]);
    expect(secret.actions).toEqual([
      { type: 'message', kind: 'error', message: "Can't clone the repository", detail: "Could not read Username for 'https://example.com': terminal prompts disabled." },
    ]);
    const again = await event({ source: { view: 'clone', params: {} }, kind: 'click', id: 'clone', values: { url: remoteDir, folder: tmp, name: 'remote', environment: 'wsl', add: true } });
    expect(again.actions?.[0]).toMatchObject({ type: 'message', kind: 'error', message: 'Can\'t clone because the folder "remote" already exists', detail: 'To clone, choose another name or folder.' });
  });

  it('checks a project while an agent works in it', async () => {
    await pane();
    const before = looper.refreshes.length;
    addon.notify('activity', { projectId: 'repo', working: true });
    writeFileSync(path.join(repoDir, 'c.txt'), 'agent\n');
    await new Promise((r) => setTimeout(r, 600));
    const seen = looper.refreshes.slice(before);
    expect(seen).toContainEqual({ views: ['project', 'repo', 'change'], projectTabs: true });
    addon.notify('activity', { projectId: 'repo', working: false });
    const after = looper.refreshes.length;
    await new Promise((r) => setTimeout(r, 300));
    // Nothing changed since the last check, and the checks stopped.
    expect(looper.refreshes.length).toBe(after);
  });

  it("reads every project's state with one exec per environment", async () => {
    fresh();
    looper.execs = [];
    await pane();
    // The two projects with one sh; nothing else until their states are two seconds old.
    expect(looper.execs.map((e) => (e.argv as string[])[0])).toEqual(['sh']);
    await screen('project', { projectId: 'repo' });
    await addon.handle('projectTab', { tab: 'git', projectId: 'plain folder' });
    expect(looper.execs.filter((e) => (e.argv as string[])[0] === 'sh')).toHaveLength(1);
  });

  it('reads the states asked for together, such as every project tab title, with one exec', async () => {
    fresh();
    looper.execs = [];
    await Promise.all(['repo', 'plain folder'].map((projectId) => addon.handle('projectTab', { tab: 'git', projectId })));
    expect(looper.execs.map((e) => (e.argv as string[])[0])).toEqual(['sh']);
  });

  it("says where git isn't installed and where the folder doesn't exist, and offers to install git", async () => {
    // An environment whose programs find sh and nothing else.
    const bin = path.join(tmp, 'bare-bin');
    mkdirSync(bin);
    symlinkSync('/bin/sh', path.join(bin, 'sh'));
    looper.envVars.bare = { PATH: bin };
    looper.projects.push(
      { id: 'nogit', name: 'No Git', cwd: plainDir, environmentId: 'bare', side: 'wsl' },
      { id: 'gone', name: 'Gone', cwd: path.join(tmp, 'gone'), environmentId: 'wsl', side: 'wsl' },
    );
    fresh();
    const p = await pane();
    const rows = Object.fromEntries(p.items.map((i) => [i.label, i]));
    expect(rows['No Git'].description).toBe('Git isn\'t installed in "Bare"');
    expect(rows.Gone.description).toBe("The folder doesn't exist");
    for (const row of [rows['No Git'], rows.Gone]) for (const state of Object.values(row.commands!)) expect(state).toEqual({ hidden: true });
    const s = await screen('repo', { projectId: 'nogit' });
    expect(find(s.body, 'empty')[0]).toMatchObject({ level: 'error', text: 'Git isn\'t installed in "Bare"', button: { id: 'install-git', label: 'Install Git' } });
    expect(s.refreshSec).toBe(15);
    expect(find((await screen('project', { projectId: 'gone' })).body, 'empty')[0]).toMatchObject({ level: 'error', text: "The project's folder doesn't exist" });
    expect(await addon.handle('projectTab', { tab: 'git', projectId: 'nogit' })).toEqual({ hidden: true });
    // Here the install finds no package manager it knows.
    const r = await event({ source: { view: 'repo', params: { projectId: 'nogit' } }, kind: 'click', id: 'install-git' });
    expect(r.actions).toEqual([{ type: 'message', kind: 'error', message: 'Can\'t install Git in "Bare"', detail: 'Looper didn\'t find apt-get, dnf, zypper, pacman or apk in "Bare".' }]);
    looper.projects = looper.projects.filter((x) => x.id !== 'nogit' && x.id !== 'gone');
    fresh();
  });

  it('opens Git Settings when git has no name or email to commit with, and commits once they are saved', async () => {
    const dir = path.join(tmp, 'ident');
    mkdirSync(dir);
    sh(dir, 'init');
    writeFileSync(path.join(dir, 'i.txt'), 'i\n');
    looper.projects.push({ id: 'ident', name: 'Ident', cwd: dir, environmentId: 'wsl', side: 'wsl' });
    // A user who never set a name or an email, whose git doesn't guess them.
    const global = gitEnv.GIT_CONFIG_GLOBAL;
    const empty = path.join(tmp, 'empty-gitconfig');
    writeFileSync(empty, '[user]\n\tuseConfigOnly = true\n[init]\n\tdefaultBranch = main\n');
    gitEnv.GIT_CONFIG_GLOBAL = empty;
    try {
      fresh();
      const source = { view: 'commit-window', params: { projectId: 'ident' } };
      const r = await event({ source, kind: 'click', id: 'commit', values: { message: 'First', files: ['i.txt'] } });
      expect(r.actions).toEqual([
        { type: 'openWindow', view: 'settings', params: { environmentId: 'wsl', identity: true }, title: 'Git Settings', width: 560, height: 520, modal: true },
      ]);
      const params = (r.actions![0] as { params: Record<string, unknown> }).params;
      const w = await screen('settings', params);
      // What's missing is the problem, under its field.
      expect(find(w.body, 'field').filter((f) => f.error).map((f) => [f.id, f.error])).toEqual([
        ['name', "Git can't commit without a name"],
        ['email', "Git can't commit without an email"],
      ]);
      expect(find(w.body, 'infobar')).toEqual([]);
      expect(find(w.body, 'field')[0]).toMatchObject({ id: 'environment', input: 'select', change: true });
      expect(find(w.body, 'buttons')).toEqual([]);
      expect(find(w.body, 'field').map((f) => [f.id, f.value])).toEqual([
        ['environment', 'wsl'],
        ['name', ''],
        ['email', ''],
        ['defaultBranch', 'main'],
        ['pull', 'merge'],
      ]);
      expect(find(w.body, 'footer')[0]).toMatchObject({ primary: { id: 'save-settings', label: 'Save' } });
      const settings = { view: 'settings', params };
      // Choosing an environment without git draws the window again, saying so in place of the fields.
      const drawn = looper.refreshes.length;
      const bare = await event({ source: settings, kind: 'change', id: 'environment', values: { environment: 'bare', name: '', email: '', defaultBranch: 'main', pull: 'merge' } });
      expect(bare).toEqual({});
      expect(looper.refreshes.slice(drawn)).toEqual([{ views: ['settings'] }]);
      const bareScreen = await screen('settings', params);
      expect(find(bareScreen.body, 'empty')[0]).toMatchObject({ level: 'error', text: 'Git isn\'t installed in "Bare"', button: { id: 'install-git', label: 'Install Git' } });
      expect(find(bareScreen.body, 'field').map((f) => f.id)).toEqual(['environment']);
      expect(find(bareScreen.body, 'field')[0].value).toBe('bare');
      // Back to this one: its settings again.
      expect(await event({ source: settings, kind: 'change', id: 'environment', values: { environment: 'wsl', name: '', email: '', defaultBranch: '', pull: 'merge' } })).toEqual({
        values: { name: '', email: '', defaultBranch: 'main', pull: 'merge' },
      });
      const saved = await event({
        source: settings,
        kind: 'click',
        id: 'save-settings',
        values: { environment: 'wsl', name: 'Ident User', email: 'ident@example.com', defaultBranch: 'main', pull: 'ff-only' },
      });
      expect(saved).toEqual({ actions: [{ type: 'closeWindow' }] });
      expect(readFileSync(empty, 'utf8')).toMatch(/name = Ident User[\s\S]*email = ident@example.com[\s\S]*ff = only/);
      expect(await event({ source: settings, kind: 'change', id: 'environment', values: { environment: 'wsl', name: '', email: '', defaultBranch: '', pull: 'merge' } })).toEqual({
        values: { name: 'Ident User', email: 'ident@example.com', defaultBranch: 'main', pull: 'ff-only' },
      });
      // Rebase instead: pull.ff goes, an emptied field is unset.
      await event({ source: settings, kind: 'click', id: 'save-settings', values: { environment: 'wsl', name: 'Ident User', email: 'ident@example.com', defaultBranch: '', pull: 'rebase' } });
      const text = readFileSync(empty, 'utf8');
      expect(text).toMatch(/rebase = true/);
      expect(text).not.toMatch(/ff = only|defaultBranch/);
      // The Commit window, still open with its message, commits now.
      expect(await event({ source, kind: 'click', id: 'commit', values: { message: 'First', files: ['i.txt'] } })).toEqual({ actions: [{ type: 'closeWindow' }] });
      expect(sh(dir, 'log', '--format=%an <%ae> %s').trim()).toBe('Ident User <ident@example.com> First');
    } finally {
      gitEnv.GIT_CONFIG_GLOBAL = global;
      looper.projects = looper.projects.filter((x) => x.id !== 'ident');
      fresh();
    }
  });

  it("sets a repository's own name and email, and its remote", async () => {
    fresh();
    expect((await pane()).items.find((i) => i.label === 'Plain')!.commands).toMatchObject({ push: { enabled: false }, 'repo-settings': { enabled: true } });
    const opened = await event({ source: { pane: 'repositories' }, kind: 'command', id: 'repo-settings', item: itemOf('plain folder') });
    expect(opened.actions).toEqual([{ type: 'openWindow', view: 'repo-settings', params: { projectId: 'plain folder' }, title: 'Repository Settings', width: 560, height: 380 }]);
    const w = await screen('repo-settings', { projectId: 'plain folder' });
    expect(find(w.body, 'field').map((f) => [f.id, f.value, f.placeholder])).toEqual([
      ['name', '', 'Test User'],
      ['email', '', 'test@example.com'],
      ['remote', '', undefined],
    ]);
    const source = { view: 'repo-settings', params: { projectId: 'plain folder' } };
    expect(await event({ source, kind: 'click', id: 'save-repo-settings', values: { name: 'Local Me', email: '', remote: remoteDir } })).toEqual({ actions: [{ type: 'closeWindow' }] });
    expect(sh(plainDir, 'config', '--local', 'user.name').trim()).toBe('Local Me');
    expect(sh(plainDir, 'remote', 'get-url', 'origin').trim()).toBe(remoteDir);
    expect((await pane()).items.find((i) => i.label === 'Plain')!.commands).toMatchObject({ push: { enabled: true } });
    await event({ source, kind: 'click', id: 'save-repo-settings', values: { name: 'Local Me', email: '', remote: `${remoteDir}/` } });
    expect(sh(plainDir, 'remote', 'get-url', 'origin').trim()).toBe(`${remoteDir}/`);
    await event({ source, kind: 'click', id: 'save-repo-settings', values: { name: '', email: '', remote: '' } });
    expect(sh(plainDir, 'remote').trim()).toBe('');
    expect(() => sh(plainDir, 'config', '--local', 'user.name')).toThrow();
  });

  it("asks for git's password in a window over the action's, and shows nothing when it's closed", async () => {
    // A remote whose helper asks for a password the way git does for HTTPS.
    const bin = path.join(tmp, 'helper-bin');
    mkdirSync(bin);
    const out = path.join(tmp, 'credential.txt');
    writeFileSync(
      path.join(bin, 'git-remote-looperask'),
      `#!/bin/sh\nprintf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill > '${out}' 2>&1\necho 'fatal: the test remote' >&2\nexit 1\n`,
    );
    chmodSync(path.join(bin, 'git-remote-looperask'), 0o755);
    const path0 = gitEnv.PATH;
    gitEnv.PATH = `${bin}:${process.env.PATH}`;
    sh(repoDir, 'remote', 'add', 'asks', 'looperask::example');
    const shown: AddonScreen[] = [];
    try {
      looper.windows = [];
      looper.onWindow = async (w) => {
        shown.push(await screen('askpass', w.params as Record<string, unknown>));
        const answer = await event({ source: { view: 'askpass', params: w.params as Record<string, unknown> }, kind: 'click', id: 'answer', values: { username: 'me', password: 'pw' } });
        expect(answer).toEqual({ actions: [{ type: 'closeWindow' }] });
        return {};
      };
      const r = await event({ source: { app: true }, kind: 'command', id: 'fetch', project: 'repo' }, 42);
      // One window for both: the password came with the user name.
      expect(looper.windows).toEqual([{ view: 'askpass', params: { id: expect.stringMatching(/^[0-9a-f]{16}$/) }, title: 'Sign In', width: 480, height: 300, request: 42 }]);
      expect(shown[0].instruction).toBe('Sign in to example.com');
      expect(readFileSync(out, 'utf8')).toBe('protocol=https\nhost=example.com\nusername=me\npassword=pw\n');
      expect(r.actions?.[0]).toMatchObject({ type: 'message', kind: 'error', message: "Can't fetch" });
      // An answered window is gone.
      expect(find((await screen('askpass', looper.windows[0].params as Record<string, unknown>)).body, 'text')[0].text).toBe('Git no longer needs an answer here.');

      // The window closed without an answer: git fails, and that's no error to show.
      looper.windows = [];
      looper.onWindow = async () => ({});
      expect(await event({ source: { app: true }, kind: 'command', id: 'fetch', project: 'repo' })).toEqual({});
      expect(looper.windows).toHaveLength(1);
      expect(looper.windows[0].request).toBeUndefined();
      expect(readFileSync(out, 'utf8')).toMatch(/could not read Username/);
    } finally {
      looper.onWindow = undefined;
      gitEnv.PATH = path0 as string;
      if (path0 === undefined) delete gitEnv.PATH;
      sh(repoDir, 'remote', 'remove', 'asks');
      fresh();
    }
  });

  it('answers what it does not know with an error', async () => {
    await expect(addon.handle('nonsense', {})).rejects.toBeInstanceOf(UnknownMethodError);
    await expect(screen('nowhere')).rejects.toThrow(/no screen "nowhere"/);
    await expect(screen('repo', { projectId: 'gone' })).rejects.toThrow('The project no longer exists.');
  });
});

describe('the built package', () => {
  let out: string;
  beforeAll(() => {
    out = mkdtempSync(path.join(tmpdir(), 'looper-git-build-'));
    execFileSync(process.execPath, ['scripts/build-addons.mjs', '--out', out], { cwd: path.resolve(__dirname, '..') });
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('holds addon.json at its root, which passes readAddonManifest, and the program', () => {
    const files = unzipSync(readFileSync(path.join(out, 'git.looperaddon')));
    expect(Object.keys(files).sort()).toEqual(['addon.js', 'addon.json', 'askpass.js']);
    const r = readAddonManifest(JSON.parse(strFromU8(files['addon.json'])));
    expect(r.ok && r.manifest.run).toEqual({ on: 'looper', command: ['${addonDir}/addon.js'] });
    const js = strFromU8(files['addon.js']);
    // Nothing that pulls in zod or electron.
    expect(js).not.toMatch(/require\("(zod|electron)"\)/);
    expect(strFromU8(files['askpass.js'])).toMatch(/LOOPER_ASKPASS_PIPE/);
  });

  it('talks JSON-RPC over stdio, and finishes what it was asked before it exits', async () => {
    const child = spawn(process.execPath, [path.join(out, 'git', 'addon.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const answers = new Map<unknown, { result?: unknown; error?: { message: string } }>();
    const send = (msg: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    const asked: string[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method) {
        asked.push(msg.method);
        if (msg.method === 'looper/activity') send({ id: msg.id, result: { working: [] } });
        // looper/projects is left unanswered: the pane waits on it until stdin closes.
        return;
      }
      answers.set(msg.id, msg);
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    send({ id: 1, method: 'initialize', params: { protocol: 2, looper: 'test', host: 'wsl', dataDir: out } });
    send({ id: 2, method: 'pane', params: { pane: 'repositories' } });
    send({ id: 3, method: 'nonsense', params: {} });
    await new Promise((r) => setTimeout(r, 300));
    expect(answers.get(1)).toMatchObject({ result: {} });
    expect(answers.get(3)).toMatchObject({ error: { code: -32601 } });
    expect(asked).toContain('looper/projects');
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(answers.get(2)).toMatchObject({ error: { message: 'Looper closed the connection.' } });
  });
});
