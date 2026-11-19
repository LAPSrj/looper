import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddonRequestMethod } from '../src/shared/addons';
import { addonRequestHandler, ProjectActivity, workingProjects, type AddonRequestDeps } from '../src/main/addon-requests';
import { envArgv, execInEnvironment, withCrossingVars } from '../src/engine/env-exec';
import { writeCommandLauncher } from '../src/engine/open-terminal';
import { projectSessionTask } from '../src/shared/projects';
import type { SessionSummary } from '../src/shared/sessions';
import type { Environment, Project, ProjectInput, Settings } from '../src/shared/types';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-addon-req-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const ENV = (e: Partial<Environment> & Pick<Environment, 'id' | 'kind'>): Environment =>
  ({ name: e.id, harnesses: [{ id: `${e.id}-cc`, name: 'Claude Code', kind: 'claude-code', command: 'claude', args: [], env: {} }], ...e }) as Environment;

const PROJECT = (p: Partial<Project> & Pick<Project, 'id' | 'environmentId' | 'cwd'>): Project =>
  ({ name: p.id, permissionMode: 'auto', mode: 'interactive', extraArgs: [], env: {}, remote: false, ...p }) as Project;

const session = (projectId: string | undefined, status: SessionSummary['status']) => ({ id: `s-${projectId}-${status}`, projectId, status }) as SessionSummary;

describe('envArgv', () => {
  it("runs a WSL environment's program through wsl.exe from Windows, in its folder", () => {
    expect(envArgv({ kind: 'wsl', distro: 'Ubuntu' }, 'windows', ['git', 'status'], '/home/sam/app')).toEqual([
      'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/sam/app', '--exec', 'git', 'status',
    ]);
    // Looper's own git: the folder rides in git's -C instead.
    expect(envArgv({ kind: 'wsl' }, 'windows', ['git', '-C', '/x', 'log'])).toEqual(['wsl.exe', '--exec', 'git', '-C', '/x', 'log']);
  });

  it("runs a Windows environment's program by its .exe from WSL, and anything else directly", () => {
    expect(envArgv({ kind: 'windows' }, 'wsl', ['git', 'status'])).toEqual(['git.exe', 'status']);
    expect(envArgv({ kind: 'windows' }, 'wsl', ['tool.cmd'])).toEqual(['tool.cmd']);
    expect(envArgv({ kind: 'local' }, 'windows', ['git', 'status'], 'C:\\x')).toEqual(['git', 'status']);
  });

  it('names the added variables in WSLENV only across WSL', () => {
    expect(withCrossingVars({ WSLENV: 'A' }, { B: '1' }, true)).toEqual({ WSLENV: 'A:B', B: '1' });
    expect(withCrossingVars({}, { B: '1' }, false)).toEqual({ B: '1' });
  });
});

describe('execInEnvironment', () => {
  const local = ENV({ id: 'local', kind: 'local' });
  const opts = { baseEnv: { PATH: process.env.PATH ?? '' }, timeoutMs: 10_000, maxBuffer: 1024 * 1024 };
  const script = 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{console.log(JSON.stringify({s,cwd:process.cwd(),v:process.env.V}));process.stderr.write("err");process.exit(3)})';

  it('runs in the folder with the variables, writes stdin, and gives the exit code and output', async () => {
    const dir = tmp();
    const r = await execInEnvironment(local, 'linux', [process.execPath, '-e', script], { ...opts, cwd: dir, env: { V: 'x' }, stdin: 'hello' });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toEqual({ s: 'hello', cwd: fs.realpathSync(dir), v: 'x' });
    expect(r.stderr).toBe('err');
    const plain = await execInEnvironment(local, 'linux', [process.execPath, '-e', 'console.log(process.env.V)'], { ...opts, env: { V: 'y' } });
    expect(plain).toEqual({ code: 0, stdout: 'y\n', stderr: '' });
  });

  it("rejects only a program that can't start or runs past its time", async () => {
    await expect(execInEnvironment(local, 'linux', ['no-such-program-looper'], opts)).rejects.toThrow("no-such-program-looper isn't installed on this machine.");
    await expect(execInEnvironment(local, 'linux', [process.execPath, '-e', 'setTimeout(()=>{},5000)'], { ...opts, timeoutMs: 300 })).rejects.toThrow(/didn't finish within/);
    await expect(execInEnvironment(local, 'linux', [process.execPath, '-e', 'setTimeout(()=>{},5000)'], { ...opts, timeoutMs: 300, stdin: '' })).rejects.toThrow(/didn't finish within/);
    await expect(execInEnvironment(local, 'linux', [process.execPath, '-e', 'process.stdout.write("x".repeat(5000))'], { ...opts, maxBuffer: 1000 })).rejects.toThrow(/wrote more than/);
  }, 20_000);
});

describe('addonRequestHandler', () => {
  function deps(over: Partial<AddonRequestDeps> = {}) {
    const environments = [ENV({ id: 'ubuntu', kind: 'wsl', distro: 'Ubuntu' }), ENV({ id: 'local', kind: 'local' }), ENV({ id: 'win', kind: 'windows' })];
    const settings = { environments, defaultEnvironmentId: 'win' } as unknown as Settings;
    const projects = [PROJECT({ id: 'app', environmentId: 'ubuntu', cwd: '/home/sam/app' }), PROJECT({ id: 'gone', environmentId: 'nope', cwd: '/x' }), PROJECT({ id: 'web', environmentId: 'local', cwd: 'C:\\web' })];
    const saved: Omit<ProjectInput, 'id'>[] = [];
    const terminals: unknown[][] = [];
    const windows: { addonId: string; p: unknown; close: () => void }[] = [];
    const d: AddonRequestDeps = {
      host: 'windows',
      settings: () => settings,
      projects: () => projects,
      saveProject: (input) => {
        saved.push(input);
        return PROJECT({ id: 'new-1', environmentId: input.environmentId, cwd: input.cwd });
      },
      sessions: () => [session('app', 'working'), session('web', 'ready'), session(undefined, 'working')],
      openTerminal: async (...args) => void terminals.push(args),
      // Open until the test closes it.
      openWindow: (addonId, p) => new Promise((resolve) => windows.push({ addonId, p, close: () => resolve(undefined) })),
      ...over,
    };
    const run = addonRequestHandler(d);
    return { d, saved, terminals, windows, handle: (method: AddonRequestMethod, params: unknown) => run(method, params, 'demo') };
  }

  it("lists projects with the side their environment runs on, and the environments that run programs from here", async () => {
    const { handle } = deps();
    expect(await handle('looper/projects', {})).toEqual([
      { id: 'app', name: 'app', cwd: '/home/sam/app', environmentId: 'ubuntu', side: 'wsl' },
      { id: 'web', name: 'web', cwd: 'C:\\web', environmentId: 'local', side: 'windows' },
    ]);
    // From Windows a Windows bridge runs nothing, so the default falls to the first that does.
    expect(await handle('looper/environments', {})).toEqual([
      { id: 'ubuntu', name: 'ubuntu', side: 'wsl', default: true },
      { id: 'local', name: 'local', side: 'windows', default: false },
    ]);
  });

  it('adds a project as New Project does', async () => {
    const { handle, saved } = deps();
    expect(await handle('looper/createProject', { name: 'Repo', cwd: '/home/sam/repo', environmentId: 'ubuntu' })).toEqual({ id: 'new-1' });
    expect(saved).toEqual([{ name: 'Repo', cwd: '/home/sam/repo', environmentId: 'ubuntu', harnessId: 'ubuntu-cc', permissionMode: 'auto', mode: 'interactive', remote: false }]);
    await expect(handle('looper/createProject', { name: 'R', cwd: '/x', environmentId: 'zzz' })).rejects.toThrow('There\'s no environment "zzz".');
  });

  it("opens a terminal in a project's folder, another folder of its environment, or a folder of an environment", async () => {
    const { handle, terminals } = deps();
    expect(await handle('looper/openTerminal', { projectId: 'app', command: ['git', 'push'] })).toEqual({});
    await handle('looper/openTerminal', { projectId: 'app', cwd: '/home/sam/other', command: ['git', 'pull'], title: 'Pull' });
    await handle('looper/openTerminal', { cwd: '/home/sam', command: ['git', 'clone', 'git@host:a b'] });
    expect(terminals).toEqual([
      [{ projectId: 'app' }, ['git', 'push'], 'git push'],
      [{ environmentId: 'ubuntu', cwd: '/home/sam/other' }, ['git', 'pull'], 'Pull'],
      [{ environmentId: 'ubuntu', cwd: '/home/sam' }, ['git', 'clone', 'git@host:a b'], 'git clone "git@host:a b"'],
    ]);
    await expect(handle('looper/openTerminal', { projectId: 'zzz', command: ['x'] })).rejects.toThrow('There\'s no project "zzz".');
  });

  it("runs a program in a project's environment and folder", async () => {
    const dir = tmp();
    const environments = [ENV({ id: 'local', kind: 'local' })];
    const { handle } = deps({
      host: 'linux',
      settings: () => ({ environments, defaultEnvironmentId: 'local' }) as unknown as Settings,
      projects: () => [PROJECT({ id: 'p', environmentId: 'local', cwd: dir })],
    });
    const r = (await handle('looper/exec', { projectId: 'p', argv: [process.execPath, '-e', 'console.log(process.cwd())'] })) as { code: number; stdout: string };
    expect(r).toMatchObject({ code: 0, stdout: `${fs.realpathSync(dir)}\n` });
    const viaEnv = (await handle('looper/exec', { cwd: dir, argv: [process.execPath, '-e', 'process.exit(4)'] })) as { code: number };
    expect(viaEnv.code).toBe(4);
  });

  it("opens the addon's screen and answers only once the window has closed", async () => {
    const { handle, windows } = deps();
    let answered: unknown;
    const pending = handle('looper/openWindow', { view: 'password', title: 'Password', request: 7 }).then((r) => (answered = r));
    await new Promise((r) => setTimeout(r, 20));
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ addonId: 'demo', p: { view: 'password', title: 'Password', request: 7 } });
    expect(answered).toBeUndefined();
    windows[0].close();
    expect(await pending).toEqual({});
  });

  it('says which projects an agent is working in', async () => {
    const { handle } = deps();
    expect(await handle('looper/activity', {})).toEqual({ working: ['app'] });
  });
});

describe('ProjectActivity', () => {
  it('reports only the projects whose working state changed', () => {
    const a = new ProjectActivity([session('app', 'working')]);
    expect(a.update([session('app', 'working'), session('web', 'ready')])).toEqual([]);
    expect(a.update([session('web', 'working'), session('web', 'ready')])).toEqual([
      { projectId: 'web', working: true },
      { projectId: 'app', working: false },
    ]);
    expect(workingProjects([session('x', 'ended')])).toEqual([]);
  });
});

describe('writeCommandLauncher', () => {
  const settings = (env: Environment) => ({ environments: [env], defaultEnvironmentId: env.id }) as unknown as Settings;

  it('runs the command with each argument quoted, in the folder with its variables, ending with it', () => {
    const env = ENV({ id: 'local', kind: 'local' });
    const task = projectSessionTask(PROJECT({ id: 'p', environmentId: 'local', cwd: "/home/sam/it's", env: { A: 'b c' } }), settings(env));
    const dir = tmp();
    const { launcherHost } = writeCommandLauncher(task, { host: 'linux', settings: settings(env) }, dir, ['git', 'commit', '-m', "it's done"]);
    const script = fs.readFileSync(launcherHost, 'utf8');
    expect(script).toContain("export A='b c'");
    expect(script).toContain("cd '/home/sam/it'\\''s' || {");
    expect(script).toContain("exec 'git' 'commit' '-m' 'it'\\''s done'");
    const held = fs.readFileSync(writeCommandLauncher(task, { host: 'linux', settings: settings(env) }, dir, ['git', 'push'], true).launcherHost, 'utf8');
    expect(held).toContain(`'git' 'push'; echo; read -r -p "Press Enter to close." _`);
  });

  it("uses PowerShell's call operator for a Windows environment", () => {
    const env = ENV({ id: 'local', kind: 'local' });
    const task = projectSessionTask(PROJECT({ id: 'p', environmentId: 'local', cwd: 'C:\\repo' }), settings(env));
    const { launcherHost } = writeCommandLauncher(task, { host: 'windows', settings: settings(env) }, tmp(), ['git', 'push']);
    const script = fs.readFileSync(launcherHost, 'utf8');
    expect(script).toContain("Set-Location -LiteralPath 'C:\\repo' -ErrorAction Stop");
    expect(script).toContain("& 'git' 'push'");
  });
});
