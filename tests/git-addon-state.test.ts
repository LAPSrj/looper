import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitAddon } from '../src/addons/git/addon';
import { Git, parseSteps, stateOf, stepsScript, type GitProject } from '../src/addons/git/git';
import { INSTALL_SCRIPT, WINGET, installProblem, rootCommand } from '../src/addons/git/install';
import { AddonEventResultSchema, type AddonExecResult, type AddonProjectInfo } from '../src/shared/addons';

let tmp: string;
const gitEnv = () => ({ GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: tmp });
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, env: { ...process.env, ...gitEnv() }, encoding: 'utf8' });

/** Runs the argv as looper/exec would, without a shell, in `cwd`. */
function run(argv: string[], cwd: string, env: Record<string, string> = {}): AddonExecResult {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...gitEnv(), ...env }, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'looper-git-state-'));
  writeFileSync(path.join(tmp, 'gitconfig'), '[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n');
  for (const name of ["it's here", 'b']) {
    const d = path.join(tmp, name);
    mkdirSync(d);
    git(d, 'init', '-q');
    writeFileSync(path.join(d, 'a.txt'), 'x');
  }
  mkdirSync(path.join(tmp, 'plain'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('several git commands in one process', () => {
  it("runs each step in its folder, quoting what it's given, and reads each one's output and exit", () => {
    const repo = path.join(tmp, "it's here");
    const steps = [
      { cwd: repo, args: ['rev-parse', '--show-toplevel'] },
      { cwd: repo, args: ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], ifOk: true },
      { cwd: path.join(tmp, 'gone'), args: ['rev-parse', '--show-toplevel'] },
      { cwd: path.join(tmp, 'gone'), args: ['status'], ifOk: true },
      { cwd: path.join(tmp, 'plain'), args: ['rev-parse', '--show-toplevel'] },
      { cwd: path.join(tmp, 'plain'), args: ['log', '--format=$HOME %s'], ifOk: true },
    ];
    const r = parseSteps(run(['sh', '-c', stepsScript(steps), 'sh', 'abc123'], '/'), 'abc123', steps.length);
    expect(r).not.toBe('no-git');
    if (r === 'no-git') return;
    expect(r[0]).toEqual({ code: 0, stdout: `${repo}\n`, stderr: '' });
    expect(r[1].stdout).toContain('? a.txt\0');
    expect(r[2]).toMatchObject({ noDir: true, code: 1 });
    expect(r[3]).toMatchObject({ skipped: true });
    expect(r[4].code).toBe(128);
    expect(r[4].stderr).toMatch(/not a git repository/);
    expect(r[5]).toMatchObject({ skipped: true });
  });

  it('says when git isn\'t installed, without running a step', () => {
    const r = run(['/bin/sh', '-c', stepsScript([{ cwd: '/', args: ['status'] }]), 'sh', 'm1'], '/', { PATH: path.join(tmp, 'nowhere') });
    expect(parseSteps(r, 'm1', 1)).toBe('no-git');
  });

  it("fails with what wsl.exe said when the script didn't run", () => {
    const stderr = '<3>WSL (588340 - Relay) ERROR: CreateProcessCommon:881: execvpe(sh) failed: No such file or directory\n';
    expect(() => parseSteps({ code: 1, stdout: '', stderr }, 'm1', 3)).toThrow(/execvpe\(sh\) failed/);
  });

  it('reads a state: a repository, a folder without one, a missing folder', () => {
    const ok = { code: 0, stdout: '', stderr: '' };
    expect(stateOf([{ code: 1, stdout: '', stderr: '', noDir: true }, ok, ok])).toEqual({ repo: false, missing: 'folder' });
    expect(stateOf([{ code: 128, stdout: '', stderr: 'fatal: not a git repository' }, ok, ok])).toEqual({ repo: false });
    const s = stateOf([
      { code: 0, stdout: '/r\n', stderr: '' },
      { code: 0, stdout: '# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -0\0', stderr: '' },
      { code: 0, stdout: 'remote.origin.url\nhttps://example.com/r.git\0branch.main.remote\norigin\0', stderr: '' },
    ]);
    expect(s).toMatchObject({ repo: true, root: '/r', branch: 'main', ahead: 1, remotes: [{ name: 'origin', url: 'https://example.com/r.git' }], branchRemote: 'origin' });
    expect(() => stateOf([{ code: 0, stdout: '/r\n', stderr: '' }, { code: 128, stdout: '', stderr: 'fatal: bad index' }, ok])).toThrow('bad index');
  });
});

describe("reading the projects' states", () => {
  const projects = (): GitProject[] => [
    { id: 'a', cwd: path.join(tmp, "it's here"), environmentId: 'ubuntu', side: 'wsl' },
    { id: 'b', cwd: path.join(tmp, 'b'), environmentId: 'ubuntu', side: 'wsl' },
    { id: 'c', cwd: path.join(tmp, 'plain'), environmentId: 'debian', side: 'wsl' },
    { id: 'w', cwd: 'C:\\w', environmentId: 'win', side: 'windows' },
  ];

  it('reads the WSL projects of one environment with one exec, and keeps the states a couple of seconds', async () => {
    const execs: Record<string, unknown>[] = [];
    const g = new Git(async (p) => {
      execs.push(p);
      if (p.projectId === 'w') {
        const argv = p.argv as string[];
        if (argv.includes('rev-parse')) return { code: 0, stdout: 'C:/w\n', stderr: '' };
        if (argv.includes('status')) return { code: 0, stdout: '# branch.oid (initial)\0# branch.head main\0', stderr: '' };
        return { code: 1, stdout: '', stderr: '' };
      }
      return run(p.argv as string[], p.cwd as string, p.env as Record<string, string>);
    });
    const states = await Promise.all(g.statesOf(projects()));
    expect(states.map((s) => s.repo)).toEqual([true, true, false, true]);
    expect(states[0]).toMatchObject({ root: path.join(tmp, "it's here"), changes: [{ path: 'a.txt', kind: 'untracked' }] });
    // One for each WSL environment (from /, in the first project's), four at once for the Windows one.
    expect(execs.filter((e) => (e.argv as string[])[0] === 'sh').map((e) => [e.projectId, e.cwd])).toEqual([
      ['a', '/'],
      ['c', '/'],
    ]);
    expect(execs.filter((e) => e.projectId === 'w')).toHaveLength(4);
    execs.length = 0;
    await g.state(projects()[1]);
    expect(execs).toHaveLength(0);
    g.forget('b');
    await g.state(projects()[1]);
    expect(execs).toHaveLength(1);
    expect(g.lastSeen('b')).toContain('"repo":true');
  });

  it('tells a missing git from a missing folder in a Windows environment', async () => {
    const notFound = (cwd: string) => new Error(`git isn't installed on this machine, or the folder ${cwd} doesn't exist.`);
    let folder = true;
    const g = new Git(
      async (p) => {
        throw notFound(p.cwd as string);
      },
      async () => folder,
    );
    const w = projects()[3];
    expect(await g.state(w)).toEqual({ repo: false, missing: 'git' });
    folder = false;
    g.forget();
    expect(await g.state(w)).toEqual({ repo: false, missing: 'folder' });
  });

  it('says git is missing for every project of a WSL environment without it', async () => {
    // /bin/sh with a PATH that has no git.
    const noGit = new Git(async (p) => {
      const r = spawnSync('/bin/sh', (p.argv as string[]).slice(1), { cwd: '/', env: { PATH: path.join(tmp, 'nowhere') }, encoding: 'utf8' });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    });
    const states = await Promise.all(noGit.statesOf(projects().slice(0, 2)));
    expect(states).toEqual([
      { repo: false, missing: 'git' },
      { repo: false, missing: 'git' },
    ]);
  });
});

describe('installing git', () => {
  it('reads what the install script says went wrong', () => {
    expect(installProblem('looper-install: no-manager\n')).toEqual({ kind: 'no-manager' });
    const p = installProblem('looper-install: no-sudo\napt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git\nDebian\n');
    expect(p).toEqual({ kind: 'no-sudo', command: 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git', distro: 'Debian' });
    expect(rootCommand(p as { command: string; distro: string })).toBe('wsl.exe -d Debian -u root sh -c "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git"');
    expect(rootCommand({ command: 'apk add git' })).toBe('su -c "apk add git"');
    expect(installProblem('Reading package lists...')).toBeUndefined();
  });

  it('runs the script in sh, which finds a package manager', () => {
    // Here, with a PATH that has only sh's tools and no package manager.
    const r = spawnSync('/bin/sh', ['-c', INSTALL_SCRIPT], { env: { PATH: path.join(tmp, 'nowhere') }, encoding: 'utf8' });
    expect(r.status).toBe(3);
    expect(installProblem(r.stdout)).toEqual({ kind: 'no-manager' });
  });

  function addon(side: 'wsl' | 'windows', answer: (argv: string[]) => AddonExecResult) {
    const project: AddonProjectInfo = { id: 'p', name: 'P', cwd: tmp, environmentId: side === 'wsl' ? 'debian' : 'win', side };
    const execs: string[][] = [];
    const envs: Record<string, string>[] = [];
    let installed = false;
    const a = createGitAddon({
      request: async (method, params) => {
        if (method === 'looper/projects') return [project];
        if (method === 'looper/environments') return [{ id: project.environmentId, name: side === 'wsl' ? 'Debian' : 'Windows', side, default: true }];
        if (method === 'looper/activity') return { working: [] };
        if (method === 'looper/exec') {
          const argv = params.argv as string[];
          execs.push(argv);
          envs.push((params.env ?? {}) as Record<string, string>);
          if (argv.includes(INSTALL_SCRIPT) || argv[0] === 'winget') {
            const r = answer(argv);
            installed = r.code === 0;
            return r;
          }
          if (side === 'windows') throw new Error(`git isn't installed on this machine, or the folder ${tmp} doesn't exist.`);
          return installed ? { code: 128, stdout: '', stderr: '' } : { code: 0, stdout: '\nM nogit\n', stderr: '' };
        }
        throw new Error(method);
      },
      refresh: () => undefined,
    });
    const click = async () =>
      AddonEventResultSchema.parse(await a.handle('event', { source: { view: 'repo', params: { projectId: 'p' } }, kind: 'click', id: 'install-git' }));
    return { a, execs, envs, click };
  }

  it('says how to install it as root where there is no sudo', async () => {
    const { a, click, execs, envs } = addon('wsl', () => ({ code: 4, stdout: 'looper-install: no-sudo\napt-get update && apt-get install -y git\nDebian\n', stderr: '' }));
    await a.handle('initialize', { host: 'linux' });
    const r = await click();
    expect(r.actions).toEqual([
      { type: 'message', kind: 'info', message: 'Git has to be installed as root in "Debian"', detail: '"Debian" doesn\'t have sudo. To install Git, run this in a Windows terminal:\n\nwsl.exe -d Debian -u root sh -c "apt-get update && apt-get install -y git"' },
    ]);
    // With the askpass variables, for sudo's password.
    const at = execs.findIndex((x) => x.includes(INSTALL_SCRIPT));
    expect(execs[at]).toEqual(['sh', '-c', INSTALL_SCRIPT]);
    expect(envs[at]).toMatchObject({ SUDO_ASKPASS: expect.stringMatching(/askpass$/), LOOPER_ASKPASS_TOKEN: expect.stringMatching(/^[0-9a-f]{32}$/) });
    a.close();
  });

  it('shows the package manager\'s failure', async () => {
    const { a, click } = addon('wsl', () => ({ code: 100, stdout: 'E: Unable to locate package git\n', stderr: '' }));
    await a.handle('initialize', { host: 'linux' });
    expect((await click()).actions).toEqual([{ type: 'message', kind: 'error', message: 'Can\'t install Git in "Debian"', detail: 'Unable to locate package git.' }]);
    a.close();
  });

  it('installs with winget on Windows, and says to restart Looper while its programs still miss git', async () => {
    const { a, click, execs } = addon('windows', () => ({ code: 0, stdout: 'Successfully installed', stderr: '' }));
    await a.handle('initialize', { host: 'windows' });
    expect((await click()).actions).toEqual([{ type: 'message', kind: 'info', message: 'Git is installed', detail: 'To use it, restart Looper.' }]);
    expect(execs[0]).toEqual(WINGET);
    a.close();
  });
});
