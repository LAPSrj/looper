import type { AddonExecResult, AddonProjectInfo, AddonSide } from '../../shared/addons';
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
  type GitStatus,
} from '../../shared/git';
import { randomId } from './askpass';
import { gitMessage } from './text';

/** Every git command starts this way, as Looper's own do: no lock a refresh could hold, paths and output as they are. */
const GIT = ['git', '--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=false'];
/** git never waits for a password nobody can type: a command that may prompt gets the askpass variables on top (askpass.ts). */
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' };
/** How long a project's read waits for others asked for with it, to read them together. */
const COALESCE_MS = 10;
/** The most git processes running at once. */
const MAX_RUNNING = 4;
/** Projects a single read of a WSL environment's states takes before the read is split. */
const READ_CHUNK = 8;
/** How long a project's status stays good: a render and a projectTab asked together run git once. */
const STATE_TTL_MS = 2000;
/** Characters of one file's diff a screen shows. */
const DIFF_MAX = 1_000_000;
/** git's id of the empty tree: what a branch without commits compares against. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HASH_RE = /^[0-9a-f]{4,64}$/i;

/** Asks Looper to run a program (`looper/exec`). */
export type Exec = (params: Record<string, unknown>) => Promise<AddonExecResult>;

/** Where a command runs: a project's environment (in its folder, or `cwd`), or an environment and a folder. */
export type Place = { projectId: string; cwd?: string } | { environmentId?: string; cwd: string };

export interface Remote {
  name: string;
  url: string;
}

/**
 * A project's folder as git sees it now. Not a repository: `missing` says
 * why when it's something other than a folder without one: git isn't
 * installed in the project's environment, or the folder doesn't exist.
 */
export type RepoState = { repo: false; missing?: 'git' | 'folder' } | ({ repo: true; remotes: Remote[]; branchRemote?: string } & GitStatus);

export interface Branch {
  name: string;
  current: boolean;
}

/** A git command that exited with an error. */
export class GitError extends Error {
  constructor(readonly result: AddonExecResult) {
    super(gitMessage(result));
  }
}

/** One git command of several run together: its arguments (after GIT's) and its folder. */
export interface Step {
  cwd: string;
  args: string[];
  /** Run only when the step before it exited with 0; otherwise its result is `skipped`. */
  ifOk?: boolean;
}

/** How a step went: git's exit and output, or the folder that doesn't exist, or a step left out. */
export type StepResult = AddonExecResult & { noDir?: boolean; skipped?: boolean };

/** The steps' results, or 'no-git' when git isn't installed where they ran. */
export type StepResults = StepResult[] | 'no-git';

const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * A sh script that runs the steps one after another, each in its folder, and
 * after each step's output writes "\n<mark> <code>\n" to stdout ("nodir" for a
 * folder it can't enter, "skip" for a step left out) and "\n<mark>\n" to
 * stderr, so one process returns every step's output and exit. Without git it
 * writes only "\n<mark> nogit\n". The mark is its first argument.
 */
export function stepsScript(steps: Step[]): string {
  const lines = [
    'm=$1',
    `command -v git >/dev/null 2>&1 || { printf '\n%s nogit\n' "$m"; exit 0; }`,
    `e() { printf '\n%s %s\n' "$m" "$1"; printf '\n%s\n' "$m" >&2; }`,
    's() { if cd "$1" 2>/dev/null; then shift; "$@"; c=$?; e $c; else c=nodir; e nodir; fi; }',
    'c=0',
  ];
  for (const st of steps) {
    const run = `s ${quote(st.cwd)} ${[...GIT, ...st.args].map(quote).join(' ')}`;
    lines.push(st.ifOk ? `if [ "$c" = 0 ]; then ${run}; else c=skip; e skip; fi` : run);
  }
  return lines.join('\n');
}

/** The steps' results from what stepsScript's run wrote; throws when they aren't all there. */
export function parseSteps(r: AddonExecResult, mark: string, count: number): StepResults {
  if (new RegExp(`(^|\\n)${mark} nogit(\\n|$)`).test(r.stdout)) return 'no-git';
  const outs: { text: string; code: string }[] = [];
  let at = 0;
  for (const m of r.stdout.matchAll(new RegExp(`\\n${mark} (\\d+|nodir|skip)\\n`, 'g'))) {
    outs.push({ text: r.stdout.slice(at, m.index), code: m[1] });
    at = m.index + m[0].length;
  }
  const errs = r.stderr.split(`\n${mark}\n`);
  if (outs.length !== count) {
    // The script didn't get to every step: wsl.exe or sh failed, or git was killed.
    throw new Error(errs[outs.length]?.trim() || errs.join('').trim() || `git stopped with code ${r.code}.`);
  }
  return outs.map((o, i) => ({
    code: o.code === 'nodir' || o.code === 'skip' ? 1 : Number(o.code),
    stdout: o.text,
    stderr: errs[i] ?? '',
    ...(o.code === 'nodir' ? { noDir: true } : {}),
    ...(o.code === 'skip' ? { skipped: true } : {}),
  }));
}

/** The steps that read a folder's state: the repository's top, its status and its remotes. */
const stateSteps = (cwd: string): Step[] => [
  { cwd, args: ['rev-parse', '--show-toplevel'] },
  // Porcelain paths are from the repository's top, wherever it runs.
  { cwd, args: ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], ifOk: true },
  // Exits with 1 when there's no remote.
  { cwd, args: ['config', '-z', '--get-regexp', '^(remote\\..*\\.url|branch\\..*\\.remote)$'], ifOk: true },
];

/** A folder's state from its stateSteps' results. */
export function stateOf([top, status, config]: StepResult[]): RepoState {
  if (top.noDir) return { repo: false, missing: 'folder' };
  const root = top.stdout.trim();
  if (top.code !== 0 || !root) return { repo: false };
  if (status.code !== 0) throw new GitError(status);
  const s = parseStatus(status.stdout);
  const remotes: Remote[] = [];
  let branchRemote: string | undefined;
  for (const rec of config.stdout.split('\0')) {
    const nl = rec.indexOf('\n');
    if (nl < 0) continue;
    const key = rec.slice(0, nl);
    const value = rec.slice(nl + 1);
    const remote = /^remote\.(.+)\.url$/.exec(key);
    if (remote) remotes.push({ name: remote[1], url: value });
    else if (s.branch && key === `branch.${s.branch}.remote`) branchRemote = value;
  }
  return { repo: true, root, ...s, remotes, ...(branchRemote ? { branchRemote } : {}) };
}

/** A project as the Git class needs it. */
export type GitProject = Pick<AddonProjectInfo, 'id' | 'cwd' | 'environmentId' | 'side'>;

/** At most `max` of the functions given to `run` at once; the others wait their turn. */
class Limiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

/** looper/exec rejects this way when it can't start git: on Windows, git isn't there or the folder isn't. */
const CANT_START = /isn't installed/;

/**
 * Git through Looper: each command runs where the project's programs run (a
 * WSL project's inside its distro), and the same commands and parsing as
 * Looper's own Git tab (src/engine/git.ts).
 */
export class Git {
  private readonly limiter = new Limiter(MAX_RUNNING);
  private readonly states = new Map<string, { at: number; state: Promise<RepoState> }>();
  /** Each project's last state read, as JSON, so a check can tell whether it changed. */
  private readonly seen = new Map<string, string>();

  constructor(
    private readonly execute: Exec,
    /** Whether a Windows folder exists, when looper/exec couldn't start git in it. */
    private readonly folderExists: (cwd: string) => Promise<boolean> = async () => true,
  ) {}

  /** git `args` at `place`; resolves with how it exited, and rejects only when git can't run. `env` goes on top of GIT_ENV, and `wrap` changes the command line (askpass). */
  run(
    place: Place,
    args: string[],
    opts: { timeoutSec?: number; stdin?: string; env?: Record<string, string>; wrap?: (argv: string[]) => string[] } = {},
  ): Promise<AddonExecResult> {
    const { env, wrap, ...rest } = opts;
    const argv = [...GIT, ...args];
    return this.limiter.run(() => this.execute({ ...place, argv: wrap ? wrap(argv) : argv, env: { ...GIT_ENV, ...env }, ...rest }));
  }

  /** Like `run`, and rejects with git's message when it fails. */
  async ok(place: Place, args: string[], opts?: { timeoutSec?: number; stdin?: string }): Promise<AddonExecResult> {
    const r = await this.run(place, args, opts);
    if (r.code !== 0) throw new GitError(r);
    return r;
  }

  /**
   * Several git commands with one looper/exec in a WSL environment (a sh
   * script, stepsScript), since each exec there starts wsl.exe; in a Windows
   * one, where there may be no sh and git starts fast, each its own, all at
   * once with `parallel` (which then ignores `ifOk`). `where`: the project
   * whose environment they run in, or the environment.
   */
  async steps(where: { projectId: string } | { environmentId: string }, side: AddonSide, steps: Step[], o: { parallel?: boolean; timeoutSec?: number } = {}): Promise<StepResults> {
    if (side === 'wsl') {
      const mark = randomId(8);
      const r = await this.limiter.run(() =>
        this.execute({ ...where, cwd: '/', argv: ['sh', '-c', stepsScript(steps), 'sh', mark], env: GIT_ENV, ...(o.timeoutSec ? { timeoutSec: o.timeoutSec } : {}) }),
      );
      return parseSteps(r, mark, steps.length);
    }
    let noGit = false;
    const one = async (st: Step): Promise<StepResult> => {
      try {
        return await this.run({ ...where, cwd: st.cwd }, st.args, o.timeoutSec ? { timeoutSec: o.timeoutSec } : {});
      } catch (e) {
        if (!CANT_START.test((e as Error).message)) throw e;
        if (!(await this.folderExists(st.cwd))) return { code: 1, stdout: '', stderr: '', noDir: true };
        noGit = true;
        return { code: 1, stdout: '', stderr: '' };
      }
    };
    const out: StepResult[] = [];
    if (o.parallel) out.push(...(await Promise.all(steps.map(one))));
    else {
      for (const st of steps) {
        const prev = out[out.length - 1];
        out.push(st.ifOk && prev && prev.code !== 0 ? { code: 1, stdout: '', stderr: '', skipped: true } : await one(st));
        if (noGit) break;
      }
    }
    return noGit ? 'no-git' : out;
  }

  /**
   * The project's repository and status, read again only when the last read is
   * older than a couple of seconds. Reads asked for within a few ms of each
   * other go together, as statesOf's do: the main window asks for every
   * project's tab title at once.
   */
  state(p: GitProject): Promise<RepoState> {
    const cached = this.states.get(p.id);
    if (cached && this.fresh(p.id)) return cached.state;
    let resolve!: (s: Promise<RepoState>) => void;
    this.remember(p.id, new Promise<RepoState>((r) => (resolve = r)));
    this.queued.push({ p, resolve });
    this.flushTimer ??= setTimeout(() => this.flush(), COALESCE_MS);
    return this.states.get(p.id)!.state;
  }

  private queued: { p: GitProject; resolve: (s: Promise<RepoState>) => void }[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  private flush(): void {
    this.flushTimer = undefined;
    const batch = this.queued;
    this.queued = [];
    const reads = this.read(batch.map((q) => q.p));
    for (const q of batch) q.resolve(reads.get(q.p.id)!);
  }

  /**
   * The projects' states, each read again only when its last read is older
   * than a couple of seconds: the WSL ones a few at most per environment in
   * one looper/exec each, the Windows ones each with its own.
   */
  statesOf(ps: GitProject[]): Promise<RepoState>[] {
    const stale = ps.filter((p, i) => ps.findIndex((x) => x.id === p.id) === i && !this.fresh(p.id));
    for (const [id, read] of this.read(stale)) this.remember(id, read);
    return ps.map((p) => this.states.get(p.id)!.state);
  }

  /** Each project's read: the WSL ones a few at most per environment in one looper/exec each, the Windows ones each with its own. */
  private read(stale: GitProject[]): Map<string, Promise<RepoState>> {
    const reads = new Map<string, Promise<RepoState>>();
    const groups = new Map<string, GitProject[]>();
    for (const p of stale) {
      if (reads.has(p.id) || groups.get(p.environmentId)?.some((x) => x.id === p.id)) continue;
      if (p.side === 'windows') {
        reads.set(p.id, this.readWindows(p));
        continue;
      }
      groups.set(p.environmentId, [...(groups.get(p.environmentId) ?? []), p]);
    }
    for (const group of groups.values()) {
      const chunks = Math.min(MAX_RUNNING, Math.ceil(group.length / READ_CHUNK));
      const size = Math.ceil(group.length / chunks);
      for (let i = 0; i < group.length; i += size) {
        const chunk = group.slice(i, i + size);
        const read = this.readWsl(chunk);
        chunk.forEach((p, j) =>
          reads.set(
            p.id,
            read.then((r) => {
              const s = r[j];
              if (s instanceof Error) throw s;
              return s;
            }),
          ),
        );
      }
    }
    return reads;
  }

  private fresh(projectId: string): boolean {
    const cached = this.states.get(projectId);
    return !!cached && Date.now() - cached.at < STATE_TTL_MS;
  }

  private remember(projectId: string, read: Promise<RepoState>): void {
    const state = read.then(
      (s) => {
        this.seen.set(projectId, JSON.stringify(s));
        return s;
      },
      (e: unknown) => {
        if (this.states.get(projectId)?.state === state) this.states.delete(projectId);
        throw e;
      },
    );
    // A failed read is the caller's to report; this copy only keeps it out of the cache.
    state.catch(() => undefined);
    this.states.set(projectId, { at: Date.now(), state });
  }

  /** WSL projects of one environment, with one looper/exec. */
  private async readWsl(ps: GitProject[]): Promise<(RepoState | Error)[]> {
    const r = await this.steps({ projectId: ps[0].id }, 'wsl', ps.flatMap((p) => stateSteps(p.cwd)));
    if (r === 'no-git') return ps.map(() => ({ repo: false, missing: 'git' }));
    return ps.map((_, i) => {
      try {
        return stateOf(r.slice(i * 3, i * 3 + 3));
      } catch (e) {
        return e as Error;
      }
    });
  }

  /** A Windows project: its three commands at once, since none waits for another's answer. */
  private async readWindows(p: GitProject): Promise<RepoState> {
    const r = await this.steps({ projectId: p.id }, 'windows', stateSteps(p.cwd), { parallel: true });
    return r === 'no-git' ? { repo: false, missing: 'git' } : stateOf(r);
  }

  /** The last state read for the project, as JSON; undefined before the first. */
  lastSeen(projectId: string): string | undefined {
    return this.seen.get(projectId);
  }

  /** Read the project (or every project) again next time: after an action, or when the projects change. */
  forget(projectId?: string): void {
    if (projectId === undefined) this.states.clear();
    else this.states.delete(projectId);
  }

  /** The branch's newest `limit` commits. */
  async log(projectId: string, root: string, limit: number): Promise<GitCommit[]> {
    const r = await this.run({ projectId, cwd: root }, ['log', `--format=${LOG_FORMAT}`, '-n', String(Math.max(1, Math.floor(limit)))]);
    if (r.code !== 0) {
      // A branch without commits has no log.
      if (/does not have any commits|bad default revision/.test(r.stderr)) return [];
      throw new GitError(r);
    }
    return parseLog(r.stdout);
  }

  async commit(projectId: string, root: string, hash: string): Promise<GitCommitDetail> {
    const at = { projectId, cwd: root };
    const h = checkHash(hash);
    const detail = parseShow((await this.ok(at, ['show', '-s', `--format=${SHOW_FORMAT}`, h])).stdout);
    if (!detail) throw new Error(`git didn't describe the commit ${h}.`);
    const files = await this.ok(at, ['diff-tree', '--no-commit-id', '-r', '-M', '--name-status', '-z', ...againstParent(h, detail.parents)]);
    return { ...detail, files: parseNameStatus(files.stdout) };
  }

  /** What a commit changed in one file. */
  async commitDiff(projectId: string, root: string, hash: string, path: string, origPath?: string): Promise<GitFileDiff> {
    const at = { projectId, cwd: root };
    const h = checkHash(hash);
    const parents = (await this.ok(at, ['rev-list', '--parents', '-n', '1', h])).stdout.trim().split(/\s+/).slice(1);
    const r = await this.ok(at, ['diff-tree', '-p', '--no-color', '-M', ...againstParent(h, parents), '--', path, ...(origPath ? [origPath] : [])]);
    return diffOf(r.stdout);
  }

  /** An uncommitted file's change against HEAD: what's staged and what isn't, together. */
  async changeDiff(projectId: string, root: string, change: Pick<GitChange, 'path' | 'origPath' | 'kind'>, initial: boolean): Promise<GitFileDiff> {
    const at = { projectId, cwd: root };
    if (change.kind === 'untracked') {
      // --no-index exits with 1 when the files differ, which they always do here.
      const r = await this.run(at, ['diff', '--no-color', '--no-index', '--', '/dev/null', change.path]);
      if (r.code !== 0 && r.code !== 1) throw new GitError(r);
      return diffOf(r.stdout);
    }
    const paths = [change.path, ...(change.origPath ? [change.origPath] : [])];
    const r = await this.ok(at, ['diff', '--no-color', '-M', initial ? EMPTY_TREE : 'HEAD', '--', ...paths]);
    return diffOf(r.stdout);
  }

  /** The local branches, by name. */
  async branches(projectId: string, root: string): Promise<Branch[]> {
    const r = await this.ok({ projectId, cwd: root }, ['for-each-ref', '--format=%(HEAD)%09%(refname:short)', 'refs/heads']);
    return r.stdout
      .split(/\r?\n/)
      .filter((l) => l.includes('\t'))
      .map((l) => ({ current: l.startsWith('*'), name: l.slice(l.indexOf('\t') + 1) }));
  }
}

/** diff-tree's arguments for what a commit changed: a merge against its first parent, the first commit against nothing. */
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
