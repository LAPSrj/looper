import { resolveEnvironment } from '../shared/environments';
import { execOffThread } from './exec-worker';
import {
  LOG_FORMAT,
  SHOW_FORMAT,
  parseDiff,
  parseLog,
  parseNameStatus,
  parseShow,
  parseStatus,
  type GitChange,
  type GitCommit,
  type GitCommitDetail,
  type GitFileDiff,
  type GitStatusResult,
} from '../shared/git';
import type { Settings, Task } from '../shared/types';
import type { HostKind } from './host';
import type { Logger } from './log';
import { childEnv } from './steps/common';

const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 64 * 1024 * 1024;
/** Characters of one file's diff a Git tab shows. */
const DIFF_MAX = 1_000_000;
/** git's id of the empty tree: what a branch without commits compares against. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HASH_RE = /^[0-9a-f]{4,64}$/i;

export interface GitDeps {
  /** A project's stand-in task: its folder and environment. */
  projectTask(projectId: string): Task | undefined;
  projectIds(): string[];
  settings(): Settings;
  host: HostKind;
  log: Logger;
  /** The projects in a git repository changed. */
  onRepos(ids: string[]): void;
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Read-only git for the Git tabs. Every command runs in the project's own
 * environment (inside WSL for a WSL project, without a shell), with
 * --no-optional-locks so a refresh never holds the index lock an agent's own
 * git command needs.
 */
export class GitService {
  private readonly repos = new Map<string, boolean>();
  /** Each project's repository root, from its first status. */
  private readonly roots = new Map<string, string>();

  constructor(private readonly d: GitDeps) {}

  /** The projects whose folder is in a git repository, as far as checked. */
  repoIds(): string[] {
    return [...this.repos].filter(([, yes]) => yes).map(([id]) => id);
  }

  isRepo(projectId: string): boolean {
    return this.repos.get(projectId) === true;
  }

  /** Check every project (at start, and when the projects change); the list follows. */
  checkAll(): void {
    const ids = new Set(this.d.projectIds());
    let dropped = false;
    for (const id of [...this.repos.keys()]) {
      if (ids.has(id)) continue;
      this.repos.delete(id);
      this.roots.delete(id);
      dropped = true;
    }
    if (dropped) this.d.onRepos(this.repoIds());
    for (const id of ids) void this.check(id);
  }

  /** Whether the project's folder is in a git repository now; a change goes out to the windows. */
  async check(projectId: string): Promise<boolean> {
    const task = this.d.projectTask(projectId);
    let yes = false;
    if (task) {
      const r = await this.exec(task, task.cwd, ['rev-parse', '--show-toplevel']).catch(() => null);
      yes = r?.code === 0 && !!r.stdout.trim();
      if (yes) this.roots.set(projectId, r!.stdout.trim());
    }
    if (this.repos.get(projectId) !== yes) {
      this.repos.set(projectId, yes);
      this.d.onRepos(this.repoIds());
    }
    return yes;
  }

  async status(projectId: string): Promise<GitStatusResult> {
    const task = this.task(projectId);
    const top = await this.exec(task, task.cwd, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) {
      if (this.repos.get(projectId) !== false) {
        this.repos.set(projectId, false);
        this.d.onRepos(this.repoIds());
      }
      return { repo: false };
    }
    const root = top.stdout.trim();
    this.roots.set(projectId, root);
    if (this.repos.get(projectId) !== true) {
      this.repos.set(projectId, true);
      this.d.onRepos(this.repoIds());
    }
    const r = await this.ok(task, root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    return { repo: true, root, ...parseStatus(r.stdout) };
  }

  /** An uncommitted file's change against HEAD: what's staged and what isn't, together. */
  async changeDiff(projectId: string, change: Pick<GitChange, 'path' | 'origPath' | 'kind'>, initial: boolean): Promise<GitFileDiff> {
    const task = this.task(projectId);
    const root = await this.root(projectId, task);
    const paths = [change.path, ...(change.origPath ? [change.origPath] : [])];
    if (change.kind === 'untracked') {
      // --no-index exits with 1 when the files differ, which they always do here.
      const r = await this.exec(task, root, ['diff', '--no-color', '--no-index', '--', '/dev/null', change.path]);
      if (r.code !== 0 && r.code !== 1) throw new Error(this.message(r));
      return diffOf(r.stdout);
    }
    const r = await this.ok(task, root, ['diff', '--no-color', '-M', initial ? EMPTY_TREE : 'HEAD', '--', ...paths]);
    return diffOf(r.stdout);
  }

  /** The branch's history, newest first, `limit` commits after the first `skip`. */
  async log(projectId: string, skip: number, limit: number): Promise<GitCommit[]> {
    const task = this.task(projectId);
    const root = await this.root(projectId, task);
    const r = await this.exec(task, root, ['log', `--format=${LOG_FORMAT}`, `--skip=${Math.max(0, Math.floor(skip))}`, '-n', String(Math.min(1000, Math.max(1, Math.floor(limit))))]);
    // A branch without commits has no log.
    if (r.code !== 0) {
      if (/does not have any commits|bad default revision/.test(r.stderr)) return [];
      throw new Error(this.message(r));
    }
    return parseLog(r.stdout);
  }

  async commit(projectId: string, hash: string): Promise<GitCommitDetail> {
    const task = this.task(projectId);
    const root = await this.root(projectId, task);
    const h = checkHash(hash);
    const show = await this.ok(task, root, ['show', '-s', `--format=${SHOW_FORMAT}`, h]);
    const detail = parseShow(show.stdout);
    if (!detail) throw new Error(`git didn't describe the commit ${h}.`);
    const files = await this.ok(task, root, ['diff-tree', '--no-commit-id', '-r', '-M', '--name-status', '-z', ...againstParent(h, detail.parents)]);
    return { ...detail, files: parseNameStatus(files.stdout) };
  }

  async commitDiff(projectId: string, hash: string, path: string, origPath?: string): Promise<GitFileDiff> {
    const task = this.task(projectId);
    const root = await this.root(projectId, task);
    const h = checkHash(hash);
    const parents = (await this.ok(task, root, ['rev-list', '--parents', '-n', '1', h])).stdout.trim().split(/\s+/).slice(1);
    const r = await this.ok(task, root, ['diff-tree', '-p', '--no-color', '-M', ...againstParent(h, parents), '--', path, ...(origPath ? [origPath] : [])]);
    return diffOf(r.stdout);
  }

  private task(projectId: string): Task {
    const task = this.d.projectTask(projectId);
    if (!task) throw new Error('The project no longer exists.');
    return task;
  }

  private async root(projectId: string, task: Task): Promise<string> {
    const known = this.roots.get(projectId);
    if (known) return known;
    const r = await this.ok(task, task.cwd, ['rev-parse', '--show-toplevel']);
    const root = r.stdout.trim();
    this.roots.set(projectId, root);
    return root;
  }

  private message(r: GitRun): string {
    const line = r.stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l);
    return line ? line.replace(/^(fatal|error): /, '') : `git exited with code ${r.code}.`;
  }

  private async ok(task: Task, cwd: string, args: string[]): Promise<GitRun> {
    const r = await this.exec(task, cwd, args);
    if (r.code !== 0) throw new Error(this.message(r));
    return r;
  }

  /** git with `args` in `cwd`, in the task's environment. Rejects only when git can't start. */
  private exec(task: Task, cwd: string, args: string[]): Promise<GitRun> {
    const env = resolveEnvironment(task, this.d.settings());
    const git = ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-C', cwd, ...args];
    let argv: string[];
    if (env.kind === 'wsl' && this.d.host === 'windows') argv = ['wsl.exe', ...(env.distro ? ['-d', env.distro] : []), '--exec', 'git', ...git];
    else if (env.kind === 'windows' && this.d.host !== 'windows') argv = ['git.exe', ...git];
    else argv = ['git', ...git];
    return execOffThread(argv[0], argv.slice(1), { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0' } }).then(
      ({ error: e, stdout, stderr }) => {
        if (e && e.code === 'ENOENT') throw new Error(`${argv[0]} isn't installed${argv[0] === 'wsl.exe' ? '' : ' on this machine'}.`);
        if (e?.killed) throw new Error(`git didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
        // wsl.exe reports a git it can't find as exit code 1 with its own message.
        const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
        return { code, stdout, stderr };
      },
    );
  }
}

/**
 * diff-tree's arguments for what a commit changed: a merge against its first
 * parent (what it brought in), the first commit against nothing.
 */
function againstParent(hash: string, parents: string[]): string[] {
  return parents.length > 1 ? [parents[0], hash] : ['--root', hash];
}

function checkHash(hash: string): string {
  if (!HASH_RE.test(hash)) throw new Error(`"${hash}" isn't a commit id.`);
  return hash;
}

/** A diff past DIFF_MAX characters is cut at a line end. */
function diffOf(out: string): GitFileDiff {
  if (out.length <= DIFF_MAX) return parseDiff(out);
  return parseDiff(out.slice(0, out.lastIndexOf('\n', DIFF_MAX)), true);
}
