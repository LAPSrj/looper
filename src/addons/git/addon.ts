import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  AddonCommandStates,
  AddonEnvironmentInfo,
  AddonEvent,
  AddonEventResult,
  AddonExecResult,
  AddonListRow,
  AddonNode,
  AddonPaneContent,
  AddonProjectInfo,
  AddonProjectTabState,
  AddonRefresh,
  AddonRequestMethod,
  AddonScreen,
  AddonSide,
  AddonValue,
} from '../../shared/addons';
import { formatDateTime } from '../../shared/format';
import { CHANGE_LABELS, branchText, changeText, gitTabLabel, type GitChangeKind, type GitStatus } from '../../shared/git';
import { baseName, dirName } from '../../shared/paths';
import { AskpassServer, askContext, randomId, type AskContext, type Asked, type Host, type Prompt } from './askpass';
import { Git, type Place, type RepoState, type Step, type StepResult } from './git';
import { INSTALL_SCRIPT, WINGET, installProblem, rootCommand, tail } from './install';
import type { RepoCommand } from './manifest';
import { promptAnswer, promptWindow } from './prompt-window';
import { badFolderName, headText, itemId, joinSidePath, nameFromUrl, needsIdentity, pathRowId, repoDescription, toSidePath, syncText, gitProblem, gitWords } from './text';

/** How the addon reaches Looper: its requests (ADDON_REQUESTS) and the `refresh` notification. */
export interface LooperLink {
  request(method: AddonRequestMethod, params: Record<string, unknown>): Promise<unknown>;
  refresh(params: AddonRefresh): void;
}

/** About one of Looper's requests: its JSON-RPC id, which a window the addon opens while answering it names (looper/openWindow's `request`). */
export interface RequestInfo {
  request?: number;
}

export interface GitAddon {
  /** One of Looper's requests: initialize, pane, render, event, projectTab. */
  handle(method: string, params: Record<string, unknown>, info?: RequestInfo): Promise<unknown>;
  /** One of Looper's notifications: projectsChanged, activity. */
  notify(method: string, params: Record<string, unknown>): void;
  /** Looper closed the connection: stop the timers and the askpass server. */
  close(): void;
}

export interface GitAddonOptions {
  activityPollMs?: number;
  /** askpass.js, the program git's prompts run; unset: the one next to this file in the package. */
  askpassClient?: string;
  /** The executable that runs it as Node; unset: the one running the addon (Looper's). */
  exe?: string;
  /** Where the addon's own messages go (Looper's Engine Log reads its stderr). */
  log?: (line: string) => void;
}

const PANE = 'repositories';
/** Commits a History list shows at first, and adds each time it's scrolled to its end. */
const PAGE = 200;
/** How often a project an agent works in is checked. */
const ACTIVITY_POLL_MS = 5000;
/** Seconds a command that talks to a remote may take. */
const REMOTE_TIMEOUT_SEC = 600;
/** Seconds a commit may take, hooks included. */
const COMMIT_TIMEOUT_SEC = 300;
/** Seconds installing git may take. */
const INSTALL_TIMEOUT_SEC = 600;

/** The settings windows' sizes, which fit their tallest form (with the infobar a commit opens Git Settings with). */
const SETTINGS_WINDOW = { title: 'Git Settings', width: 560, height: 520 };
const REPO_SETTINGS_WINDOW = { title: 'Repository Settings', width: 560, height: 380 };

/** What changes after an action on a repository. */
const AFTER_ACTION: AddonRefresh = { views: ['repo', 'project', 'branches'], panes: [PANE], projectTabs: true };

/** Thrown for a request the addon doesn't know, so its answer has JSON-RPC's code for that. */
export class UnknownMethodError extends Error {
  readonly code = -32601;
}

const ALL_COMMANDS: RepoCommand[] = ['commit', 'pull', 'push', 'sync', 'fetch', 'branches', 'repo-settings', 'init'];

/** How each repository command is for a project: what doesn't apply hidden, what can't run now off. */
export function commandStates(state: RepoState): AddonCommandStates {
  if (!state.repo) {
    // Without git or the folder, nothing applies, Create Repository included.
    const init = state.missing ? { hidden: true } : { hidden: false, enabled: true };
    return Object.fromEntries(ALL_COMMANDS.map((id) => [id, id === 'init' ? init : { hidden: true }]));
  }
  const remote = state.remotes.length > 0;
  return {
    commit: { hidden: false, enabled: state.changes.length > 0 },
    pull: { hidden: false, enabled: remote },
    push: { hidden: false, enabled: remote },
    sync: { hidden: false, enabled: remote },
    fetch: { hidden: false, enabled: remote },
    branches: { hidden: false, enabled: true },
    'repo-settings': { hidden: false, enabled: true },
    init: { hidden: true },
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** A problem with what was typed in one field: shown under it, as Windows' in-place errors are. */
const invalid = (field: string, text: string): AddonEventResult => ({ errors: { [field]: text } });
/** A failed git command's message: what went wrong in the user's terms (gitProblem). */
const problem = (r: { stdout: string; stderr: string }, action: string, url?: string): AddonEventResult => {
  const p = gitProblem(r, action, url);
  return message('error', p.message, p.detail);
};
const message = (kind: 'info' | 'warning' | 'error', text: string, detail?: string): AddonEventResult => ({
  actions: [{ type: 'message', kind, message: text, ...(detail ? { detail } : {}) }],
});

/** A file's line in a list: its name, its folder (or where it came from) and what happened to it. */
function fileRow(path: string, origPath: string | undefined, value: string, detail: AddonListRow['detail']): AddonListRow {
  return { id: pathRowId(path), title: baseName(path), subtitle: origPath ? `from ${origPath}` : dirName(path) || undefined, mono: true, value, detail };
}

/** The keys git config -z --get-regexp printed, lowercased as git prints them, with their values. */
function configValues(out: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rec of out.split('\0')) {
    const nl = rec.indexOf('\n');
    if (nl > 0) values.set(rec.slice(0, nl).toLowerCase(), rec.slice(nl + 1));
  }
  return values;
}

/** How git pull joins the remote's work: pull.ff=only, pull.rebase=true or a merge (git's default). */
type PullMode = 'merge' | 'rebase' | 'ff-only';
const PULL_OPTIONS: { value: PullMode; label: string }[] = [
  { value: 'merge', label: 'Merge' },
  { value: 'rebase', label: 'Rebase' },
  { value: 'ff-only', label: 'Fast-forward only' },
];
function pullMode(values: Map<string, string>): PullMode {
  if (values.get('pull.ff') === 'only') return 'ff-only';
  const rebase = values.get('pull.rebase');
  return rebase && rebase !== 'false' ? 'rebase' : 'merge';
}

/** The global settings Git Settings shows. */
const GLOBAL_KEYS = '^(user\\.(name|email)|init\\.defaultbranch|pull\\.(rebase|ff))$';
/** The repository's settings Repository Settings shows, read from its own config and from the global one. */
const REPO_KEYS = '^(user\\.(name|email)|remote\\.origin\\.url)$';

interface GlobalSettings {
  name: string;
  email: string;
  defaultBranch: string;
  pull: PullMode;
  /** The config as read, to know which pull keys are set. */
  raw: Map<string, string>;
}

/** A failure of one of several steps: the first one that exited with an error, if any. */
const failedStep = (r: StepResult[], ok: (s: StepResult) => boolean = (s) => s.code === 0): StepResult | undefined => r.find((s) => !s.skipped && !ok(s));

export function createGitAddon(looper: LooperLink, opts: GitAddonOptions = {}): GitAddon {
  const exec = (params: Record<string, unknown>) => looper.request('looper/exec', params) as Promise<AddonExecResult>;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  /** Where Looper runs (initialize's `host`); before it says, where this process runs. */
  let host: Host = process.platform === 'win32' ? 'windows' : 'wsl';
  let dataDir: string | undefined;

  /** Whether a Windows environment's folder exists, seen from here. */
  const folderExists = (cwd: string): Promise<boolean> => {
    let local = cwd;
    if (host !== 'windows') {
      try {
        local = toSidePath(cwd, 'wsl');
      } catch {
        return Promise.resolve(false);
      }
    }
    return stat(local).then(
      (s) => s.isDirectory(),
      () => false,
    );
  };
  const git = new Git(exec, folderExists);
  let projectList: Promise<AddonProjectInfo[]> | undefined;
  /** Pages of history each project's History list shows. */
  const historyPages = new Map<string, number>();
  /** The projects an agent works in, each with its check's timer. */
  const watched = new Map<string, ReturnType<typeof setInterval>>();
  /** The prompts whose windows are open, by the id in their params. */
  const prompts = new Map<string, { prompt: Prompt; retry: boolean; purpose?: AskContext['purpose']; resolve: (a: Asked) => void }>();
  let askpass: AskpassServer | undefined;
  let activityAsked = false;
  let closed = false;
  /** The environment Git Settings' Environment select was last set to, since the window opened. */
  let settingsChoice: string | undefined;
  /** The BCP 47 tag Looper formats dates with (initialize's `locale`); unset: Node's own. */
  let locale: string | undefined;
  /** A date as Looper shows it; formatDateTime keeps one formatter per locale. */
  const date = (at: number): string => formatDateTime(at, locale);

  function projects(): Promise<AddonProjectInfo[]> {
    projectList ??= (looper.request('looper/projects', {}) as Promise<AddonProjectInfo[]>).catch((e: unknown) => {
      projectList = undefined;
      throw e;
    });
    return projectList;
  }

  async function project(projectId: unknown): Promise<AddonProjectInfo> {
    const p = typeof projectId === 'string' ? (await projects()).find((x) => x.id === projectId) : undefined;
    if (!p) throw new Error('The project no longer exists.');
    return p;
  }

  const environments = () => looper.request('looper/environments', {}) as Promise<AddonEnvironmentInfo[]>;

  /** The project's environment, by name, for what's said about it. */
  async function environmentOf(p: AddonProjectInfo): Promise<AddonEnvironmentInfo> {
    const env = (await environments()).find((e) => e.id === p.environmentId);
    return env ?? { id: p.environmentId, name: p.side === 'wsl' ? 'WSL' : 'Windows', side: p.side, default: false };
  }

  /** A folder every environment has, where a command that isn't about a project runs. */
  const envRoot = (side: AddonSide): string => (side === 'wsl' ? '/' : host === 'windows' ? homedir() : 'C:\\');

  async function repo(p: AddonProjectInfo): Promise<RepoState & { repo: true }> {
    const s = await git.state(p);
    if (!s.repo) throw new Error(s.missing === 'git' ? "Git isn't installed in the project's environment." : s.missing === 'folder' ? "The project's folder doesn't exist." : "The project's folder isn't in a git repository.");
    return s;
  }

  /** The first time Looper asks for anything: which projects an agent is working in already. */
  function askActivity(): void {
    if (activityAsked) return;
    activityAsked = true;
    looper.request('looper/activity', {}).then(
      (r) => {
        for (const id of (r as { working?: string[] }).working ?? []) setWorking(id, true);
      },
      () => undefined,
    );
  }

  /** Read the project's status again, and redraw its screens when it changed. */
  async function check(projectId: string): Promise<void> {
    const before = git.lastSeen(projectId);
    git.forget(projectId);
    const after = await project(projectId)
      .then((p) => git.state(p))
      .then(
        (s) => JSON.stringify(s),
        () => undefined,
      );
    if (!closed && after !== undefined && after !== before) looper.refresh({ views: ['project', 'repo', 'change'], projectTabs: true });
  }

  function setWorking(projectId: string, working: boolean): void {
    const timer = watched.get(projectId);
    if (working && !timer && !closed) {
      let busy = false;
      const tick = () => {
        if (busy) return;
        busy = true;
        void check(projectId).finally(() => (busy = false));
      };
      watched.set(projectId, setInterval(tick, opts.activityPollMs ?? ACTIVITY_POLL_MS));
    } else if (!working && timer) {
      clearInterval(timer);
      watched.delete(projectId);
      // The last of the work shows at once.
      void check(projectId);
    }
  }

  // ---------- Prompts ----------

  /** A prompt from git, ssh or sudo, in a window over the one the action came from; resolves when it's answered or closed. */
  function ask(prompt: Prompt, o: { retry: boolean; ctx: AskContext }): Promise<Asked> {
    const id = randomId(8);
    const w = promptWindow(prompt, o.retry, o.ctx.purpose);
    const answered = new Promise<Asked>((resolve) => prompts.set(id, { prompt, retry: o.retry, purpose: o.ctx.purpose, resolve }));
    const settle = (a: Asked) => {
      const p = prompts.get(id);
      if (!p) return;
      prompts.delete(id);
      p.resolve(a);
    };
    looper
      .request('looper/openWindow', { view: 'askpass', params: { id }, title: w.title, width: w.width, height: w.height, ...(o.ctx.request ? { request: o.ctx.request } : {}) })
      .then(
        // Closed without an answer: the user said no.
        () => settle('cancelled'),
        (e: unknown) => {
          log(`Looper couldn't show git's prompt: ${(e as Error).message}`);
          settle('failed');
        },
      );
    return answered;
  }

  function prompter(): AskpassServer {
    askpass ??= new AskpassServer({
      host,
      dataDir,
      exe: opts.exe ?? process.execPath,
      client: opts.askpassClient ?? path.join(__dirname, 'askpass.js'),
      ask,
      log,
    });
    return askpass;
  }

  /**
   * A command that may prompt (git talking to a remote, an install): its
   * prompts open the addon's windows. Resolves with how it exited; `ctx`
   * says afterwards whether the user cancelled one.
   */
  async function withPrompts(ctx: AskContext, side: AddonSide, run: (o: { env?: Record<string, string>; wrap?: (argv: string[]) => string[] }) => Promise<AddonExecResult>): Promise<AddonExecResult> {
    const cmd = await prompter().command(ctx, side);
    try {
      const r = await run(cmd ? { env: cmd.env, wrap: cmd.wrap } : {});
      cmd?.done(r.code === 0);
      return r;
    } catch (e) {
      cmd?.done(false);
      throw e;
    }
  }

  const remoteGit = (place: Place, side: AddonSide, args: string[], ctx: AskContext): Promise<AddonExecResult> =>
    withPrompts(ctx, side, (o) => git.run(place, args, { timeoutSec: REMOTE_TIMEOUT_SEC, ...o }));

  // ---------- The pane ----------

  /** What the pane and the screens say instead of a repository's state. */
  function missingText(s: RepoState & { repo: false }, envName: string): string {
    if (s.missing === 'git') return `Git isn't installed in "${envName}"`;
    if (s.missing === 'folder') return "The folder doesn't exist";
    return 'Not a git repository';
  }

  async function pane(params: Record<string, unknown>): Promise<AddonPaneContent> {
    if (params.pane !== PANE) throw new Error(`There's no pane "${str(params.pane)}".`);
    const list = await projects();
    const states = await Promise.all(git.statesOf(list).map((s) => s.catch((e: unknown) => ({ repo: false as const, error: (e as Error).message }))));
    const envs = states.some((s) => !s.repo && 'missing' in s && s.missing === 'git') ? await environments().catch(() => []) : [];
    const envName = (p: AddonProjectInfo) => envs.find((e) => e.id === p.environmentId)?.name ?? (p.side === 'wsl' ? 'WSL' : 'Windows');
    const rows = list.map((p, i) => {
      const s = states[i];
      return {
        id: itemId(p.id),
        label: p.name,
        description: s.repo ? repoDescription(s) : 'error' in s ? s.error : s.missing ? missingText(s, envName(p)) : p.cwd,
        // A project whose folder or git can't be read may be a repository or not: it has a group of its own.
        group: s.repo ? 'Repositories' : 'error' in s || s.missing ? 'Unavailable' : 'No repository',
        ...(!s.repo && !('error' in s) && !s.missing ? { mono: true } : {}),
        keywords: p.cwd,
        view: 'repo',
        params: { projectId: p.id },
        commands: commandStates('error' in s ? { repo: false } : s),
      };
    });
    return {
      items: ['Repositories', 'No repository', 'Unavailable'].flatMap((g) => rows.filter((r) => r.group === g)),
      search: { placeholder: 'Search repositories' },
      empty: 'No projects yet.',
    };
  }

  // ---------- Screens ----------

  /** The infobar a project without a repository shows: Create Repository, Install Git, or the missing folder. */
  async function notRepo(p: AddonProjectInfo, s: RepoState & { repo: false }): Promise<AddonNode> {
    if (s.missing === 'git') {
      const env = await environmentOf(p);
      return { type: 'empty', level: 'error', text: `Git isn't installed in "${env.name}"`, button: { id: 'install-git', label: 'Install Git' } };
    }
    if (s.missing === 'folder') return { type: 'empty', level: 'error', text: "The project's folder doesn't exist" };
    return { type: 'empty', text: "The project's folder isn't a git repository", button: { id: 'init', label: 'Create Repository' } };
  }

  /** A screen without a repository is drawn again now and then, so git installed or a folder made elsewhere shows. */
  const MISSING_REFRESH_SEC = 15;

  /** A repository's changes and history, as tabs. */
  async function repoTabs(projectId: string, s: GitStatus): Promise<AddonNode> {
    const limit = (historyPages.get(projectId) ?? 1) * PAGE;
    const commits = s.initial ? [] : await git.log(projectId, s.root, limit);
    const changes: AddonNode = {
      type: 'listDetail',
      id: 'changes',
      label: 'Changes',
      items: s.changes.map((c) =>
        fileRow(c.path, c.origPath, changeText(c), {
          view: 'change',
          params: { projectId, path: c.path, ...(c.origPath ? { origPath: c.origPath } : {}), kind: c.kind, initial: s.initial, staged: c.staged, unstaged: c.unstaged },
        }),
      ),
      empty: 'There are no uncommitted changes.',
      detailEmpty: 'Select a file to see its changes.',
    };
    const history: AddonNode = {
      type: 'listDetail',
      id: 'history',
      label: 'Commits',
      items: commits.map((c) => ({
        id: c.hash,
        title: c.subject,
        subtitle: [c.author, date(c.at), c.shortHash, ...(c.refs.length ? [c.refs.join(', ')] : [])].join(' · '),
        detail: { view: 'commit', params: { projectId, hash: c.hash } },
      })),
      empty: 'The branch has no commits yet.',
      detailEmpty: 'Select a commit to see its changes.',
      ...(commits.length >= limit ? { more: true } : {}),
    };
    return {
      type: 'tabs',
      id: 'git',
      items: [
        { id: 'changes', title: 'Changes', body: [changes] },
        { id: 'history', title: 'History', body: [history] },
      ],
    };
  }

  /** Git Settings: the global identity, default branch and pull mode of an environment. */
  async function readGlobal(env: AddonEnvironmentInfo): Promise<GlobalSettings | 'no-git'> {
    const r = await git.steps({ environmentId: env.id }, env.side, [{ cwd: envRoot(env.side), args: ['config', '--global', '-z', '--get-regexp', GLOBAL_KEYS] }]);
    if (r === 'no-git') return r;
    // Exits with 1 when none is set.
    if (r[0].code !== 0 && r[0].code !== 1) throw new Error(gitProblem(r[0], 'read the settings').message);
    const raw = configValues(r[0].stdout);
    return { name: raw.get('user.name') ?? '', email: raw.get('user.email') ?? '', defaultBranch: raw.get('init.defaultbranch') ?? '', pull: pullMode(raw), raw };
  }

  /** Repository Settings: the repository's own name and email (with the global ones), and origin's URL. */
  async function readRepo(p: AddonProjectInfo): Promise<{ local: Map<string, string>; global: Map<string, string> }> {
    const steps: Step[] = [
      { cwd: p.cwd, args: ['config', '--local', '-z', '--get-regexp', REPO_KEYS] },
      { cwd: p.cwd, args: ['config', '--global', '-z', '--get-regexp', REPO_KEYS] },
    ];
    const r = await git.steps({ projectId: p.id }, p.side, steps);
    if (r === 'no-git') throw new Error("Git isn't installed in the project's environment");
    const bad = failedStep(r, (s) => s.code === 0 || s.code === 1);
    if (bad) throw new Error(gitProblem(bad, "read the repository's settings").message);
    return { local: configValues(r[0].stdout), global: configValues(r[1].stdout) };
  }

  async function settingsScreen(p: Record<string, unknown>): Promise<AddonScreen> {
    const envs = await environments();
    const env = envs.find((e) => e.id === settingsChoice) ?? envs.find((e) => e.id === p.environmentId) ?? envs.find((e) => e.default) ?? envs[0];
    if (!env) return { body: [{ type: 'empty', level: 'error', text: "There isn't an environment to run Git in" }] };
    // Choosing another environment shows its settings (a change event).
    const choose: AddonNode[] =
      envs.length > 1
        ? [{ type: 'field', id: 'environment', label: 'Environment', input: 'select', value: env.id, options: envs.map((e) => ({ value: e.id, label: e.name })), change: true }]
        : [];
    const g = await readGlobal(env);
    if (g === 'no-git') {
      return {
        title: 'Git Settings',
        body: [...choose, { type: 'empty', level: 'error', text: `Git isn't installed in "${env.name}"`, button: { id: 'install-git', label: 'Install Git' } }],
      };
    }
    return {
      title: 'Git Settings',
      body: [
        ...choose,
        // Opened by a commit git refused: what's missing is the problem, under its field.
        { type: 'field', id: 'name', label: 'Name', input: 'text', value: g.name, autofocus: true, ...(p.identity === true && !g.name ? { error: "Git can't commit without a name" } : {}) },
        { type: 'field', id: 'email', label: 'Email', input: 'text', value: g.email, ...(p.identity === true && !g.email ? { error: "Git can't commit without an email" } : {}) },
        { type: 'field', id: 'defaultBranch', label: 'Default branch', input: 'text', value: g.defaultBranch, placeholder: 'master' },
        { type: 'field', id: 'pull', label: 'Pull', input: 'select', value: g.pull, options: PULL_OPTIONS },
        { type: 'footer', primary: { id: 'save-settings', label: 'Save', primary: true } },
      ],
    };
  }

  async function repoSettingsScreen(proj: AddonProjectInfo): Promise<AddonScreen> {
    await repo(proj);
    const { local, global } = await readRepo(proj);
    return {
      title: 'Repository Settings',
      body: [
        { type: 'field', id: 'name', label: 'Name', input: 'text', value: local.get('user.name') ?? '', placeholder: global.get('user.name') ?? '', autofocus: true },
        { type: 'field', id: 'email', label: 'Email', input: 'text', value: local.get('user.email') ?? '', placeholder: global.get('user.email') ?? '' },
        { type: 'field', id: 'remote', label: 'Remote URL', input: 'text', value: local.get('remote.origin.url') ?? '' },
        { type: 'footer', primary: { id: 'save-repo-settings', label: 'Save', primary: true } },
      ],
    };
  }

  /** A prompt's window: what git, ssh or sudo asks. */
  function askpassScreen(p: Record<string, unknown>): AddonScreen {
    const open = prompts.get(str(p.id));
    if (!open) return { body: [{ type: 'text', text: 'Git no longer needs an answer here.' }] };
    return promptWindow(open.prompt, open.retry, open.purpose).screen;
  }

  async function render(params: Record<string, unknown>): Promise<AddonScreen> {
    const view = str(params.view);
    const p = (params.params ?? {}) as Record<string, unknown>;
    switch (view) {
      case 'repo': {
        const proj = await project(p.projectId);
        const s = await git.state(proj);
        const folder = { label: 'Folder', value: proj.cwd, mono: true, copy: true };
        if (!s.repo) return { title: proj.name, commands: commandStates(s), body: [{ type: 'props', items: [folder] }, await notRepo(proj, s)], ...(s.missing ? { refreshSec: MISSING_REFRESH_SEC } : {}) };
        // The remote the branch tracks, else origin, else the first.
        const remote = s.remotes.find((r) => r.name === s.branchRemote) ?? s.remotes.find((r) => r.name === 'origin') ?? s.remotes[0];
        return {
          title: proj.name,
          commands: commandStates(s),
          body: [
            {
              type: 'props',
              items: [
                folder,
                { label: 'Branch', value: headText(s) },
                { label: 'Status', value: syncText(s) },
                ...(remote ? [{ label: 'Remote', value: remote.url, mono: true, copy: true }] : []),
              ],
            },
            await repoTabs(proj.id, s),
          ],
          refreshSec: 60,
        };
      }
      case 'project': {
        const proj = await project(p.projectId);
        const s = await git.state(proj);
        if (!s.repo) return { commands: commandStates(s), body: [await notRepo(proj, s)], ...(s.missing ? { refreshSec: MISSING_REFRESH_SEC } : {}) };
        return {
          commands: commandStates(s),
          body: [{ type: 'text', text: branchText(s), muted: true }, await repoTabs(proj.id, s)],
          refreshSec: 60,
        };
      }
      case 'change': {
        const proj = await project(p.projectId);
        const s = await repo(proj);
        const path = str(p.path);
        const kind = str(p.kind) as GitChangeKind;
        if (!path || !(kind in CHANGE_LABELS)) throw new Error("The change's file or kind is missing.");
        const origPath = str(p.origPath) || undefined;
        const diff = await git.changeDiff(proj.id, s.root, { path, origPath, kind }, p.initial === true);
        const subtitle = changeText({ path, origPath, kind, staged: p.staged === true, unstaged: p.unstaged === true });
        return { title: baseName(path), body: [diffNode(path, subtitle, diff)] };
      }
      case 'commit': {
        const proj = await project(p.projectId);
        const s = await repo(proj);
        const hash = str(p.hash);
        const d = await git.commit(proj.id, s.root, hash);
        return {
          title: d.subject,
          body: [
            ...(d.body ? [{ type: 'text' as const, text: d.body }] : []),
            {
              type: 'props',
              items: [
                { label: 'Author', value: `${d.author} <${d.email}>` },
                { label: 'Date', value: date(d.at) },
                { label: 'Commit', value: d.hash, mono: true, copy: true },
                ...(d.refs.length ? [{ label: 'Refs', value: d.refs.join(', ') }] : []),
              ],
            },
            {
              type: 'listDetail',
              id: 'files',
              label: 'Files',
              items: d.files.map((f) =>
                fileRow(f.path, f.origPath, CHANGE_LABELS[f.kind], {
                  view: 'commitFile',
                  params: { projectId: proj.id, hash: d.hash, path: f.path, ...(f.origPath ? { origPath: f.origPath } : {}), kind: f.kind },
                }),
              ),
              empty: 'This commit changed no files.',
              detailEmpty: 'Select a file to see its changes.',
            },
          ],
        };
      }
      case 'commitFile': {
        const proj = await project(p.projectId);
        const s = await repo(proj);
        const path = str(p.path);
        const origPath = str(p.origPath) || undefined;
        const kind = str(p.kind) as GitChangeKind;
        const label = CHANGE_LABELS[kind] ?? 'Changed';
        const diff = await git.commitDiff(proj.id, s.root, str(p.hash), path, origPath);
        return { title: baseName(path), body: [diffNode(path, origPath ? `${label} from ${origPath}` : label, diff)] };
      }
      case 'clone': {
        const envs = await environments();
        const chosen = envs.find((e) => e.default) ?? envs[0];
        return {
          title: 'Clone Repository',
          body: [
            { type: 'field', id: 'url', label: 'Repository URL', input: 'text', value: '', required: true, autofocus: true },
            { type: 'field', id: 'folder', label: 'Folder', input: 'folder', value: '', required: true },
            { type: 'field', id: 'name', label: 'Name', input: 'text', value: '' },
            {
              type: 'field',
              id: 'environment',
              label: 'Environment',
              input: 'select',
              value: chosen?.id ?? '',
              options: envs.map((e) => ({ value: e.id, label: e.name })),
            },
            { type: 'field', id: 'add', label: 'Add it to Looper as a project', input: 'checkbox', value: true },
            { type: 'footer', primary: { id: 'clone', label: 'Clone', primary: true } },
          ],
        };
      }
      case 'commit-window': {
        const proj = await project(p.projectId);
        git.forget(proj.id);
        const s = await repo(proj);
        return {
          title: 'Commit',
          body: [
            { type: 'field', id: 'message', label: 'Message', input: 'textarea', value: '', required: true, autofocus: true },
            {
              type: 'field',
              id: 'files',
              label: 'Files',
              input: 'checklist',
              value: s.changes.map((c) => c.path),
              options: s.changes.map((c) => ({ value: c.path, label: c.path, description: c.origPath ? `${changeText(c)} from ${c.origPath}` : changeText(c) })),
              placeholder: 'There are no uncommitted changes.',
            },
            ...(s.initial ? [] : [{ type: 'field' as const, id: 'amend', label: 'Amend the last commit', input: 'checkbox' as const, value: false }]),
            { type: 'footer', primary: { id: 'commit', label: 'Commit', primary: true } },
          ],
        };
      }
      case 'branches': {
        const proj = await project(p.projectId);
        const s = await repo(proj);
        const branches = await git.branches(proj.id, s.root);
        return {
          title: 'Branches',
          body: [
            {
              type: 'field',
              id: 'branch',
              label: 'Branches',
              input: 'list',
              value: branches.find((b) => b.current)?.name ?? '',
              options: branches.map((b) => ({ value: b.name, label: b.name, ...(b.current ? { description: 'The current branch' } : {}) })),
              placeholder: 'There are no branches before the first commit.',
              buttons: [{ id: 'switch', label: 'Switch' }],
            },
            { type: 'field', id: 'newBranch', label: 'New branch', input: 'text', value: '' },
            { type: 'buttons', items: [{ id: 'create-branch', label: 'Create Branch' }] },
          ],
        };
      }
      case 'settings':
        return settingsScreen(p);
      case 'repo-settings':
        return repoSettingsScreen(await project(p.projectId));
      case 'askpass':
        return askpassScreen(p);
    }
    throw new Error(`There's no screen "${view}".`);
  }

  // ---------- Events ----------

  /** The project an event acts on: a project's command, a pane item's, or the screen's. */
  async function eventProject(ev: AddonEvent): Promise<AddonProjectInfo> {
    if (ev.project) return project(ev.project);
    if ('view' in ev.source) return project(ev.source.params.projectId);
    if ('pane' in ev.source && ev.item) {
      const p = (await projects()).find((x) => itemId(x.id) === ev.item);
      if (p) return p;
    }
    throw new Error('The project no longer exists.');
  }

  /**
   * git commands one after another in the project, stopping at the first that
   * fails: one whose prompt the user closed shows nothing, another failure is
   * `failed` with git's output.
   */
  async function runSteps(proj: AddonProjectInfo, steps: { args: string[]; action: string }[], request?: number): Promise<AddonEventResult> {
    const ctx = askContext(request);
    try {
      for (const step of steps) {
        const r = await remoteGit({ projectId: proj.id }, proj.side, step.args, ctx);
        if (r.code === 0) continue;
        return ctx.cancelled ? {} : problem(r, step.action);
      }
      return {};
    } finally {
      afterAction(proj.id);
    }
  }

  function afterAction(projectId?: string): void {
    git.forget(projectId);
    looper.refresh(AFTER_ACTION);
  }

  async function push(proj: AddonProjectInfo): Promise<{ args: string[]; action: string }> {
    const s = await repo(proj);
    const args = !s.upstream && s.remotes.length === 1 ? ['push', '-u', s.remotes[0].name, 'HEAD'] : ['push'];
    return { args, action: 'push' };
  }

  const settingsWindow = (params: Record<string, unknown>, modal = false): AddonEventResult => {
    settingsChoice = undefined;
    return settingsWindowAction(params, modal);
  };
  const settingsWindowAction = (params: Record<string, unknown>, modal: boolean): AddonEventResult => ({
    actions: [{ type: 'openWindow', view: 'settings', params, ...SETTINGS_WINDOW, ...(modal ? { modal: true } : {}) }],
  });

  async function command(ev: AddonEvent, request?: number): Promise<AddonEventResult> {
    if (ev.id === 'clone') return { actions: [{ type: 'openWindow', view: 'clone', title: 'Clone Repository', width: 560, height: 440 }] };
    if (ev.id === 'settings') return settingsWindow({});
    const proj = await eventProject(ev);
    git.forget(proj.id);
    switch (ev.id) {
      case 'commit':
        await repo(proj);
        return { actions: [{ type: 'openWindow', view: 'commit-window', params: { projectId: proj.id }, title: 'Commit', width: 560, height: 560 }] };
      case 'branches':
        await repo(proj);
        return { actions: [{ type: 'openWindow', view: 'branches', params: { projectId: proj.id }, title: 'Branches', width: 480, height: 520 }] };
      case 'repo-settings':
        await repo(proj);
        return { actions: [{ type: 'openWindow', view: 'repo-settings', params: { projectId: proj.id }, ...REPO_SETTINGS_WINDOW }] };
      case 'pull':
        return runSteps(proj, [{ args: ['pull'], action: 'pull' }], request);
      case 'push':
        return runSteps(proj, [await push(proj)], request);
      case 'sync':
        return runSteps(proj, [{ args: ['pull'], action: 'pull' }, await push(proj)], request);
      case 'fetch':
        return runSteps(proj, [{ args: ['fetch', '--all', '--prune'], action: 'fetch' }], request);
      case 'init':
        return init(proj.id);
    }
    throw new Error(`There's no command "${ev.id}".`);
  }

  async function init(projectId: string): Promise<AddonEventResult> {
    try {
      const r = await git.run({ projectId }, ['init']);
      return r.code === 0 ? {} : problem(r, 'create the repository');
    } finally {
      afterAction(projectId);
    }
  }

  async function commit(proj: AddonProjectInfo, values: Record<string, AddonValue>): Promise<AddonEventResult> {
    const projectId = proj.id;
    const text = str(values.message).trim();
    if (!text) return invalid('message', 'The commit message is empty');
    const checked = new Set(Array.isArray(values.files) ? values.files : []);
    const amend = values.amend === true;
    git.forget(projectId);
    const s = await repo(proj);
    const files = s.changes.filter((c) => checked.has(c.path));
    if (!files.length && !amend) return invalid('files', "There aren't any files chosen to commit");
    const at: Place = { projectId, cwd: s.root };
    try {
      const untracked = files.filter((c) => c.kind === 'untracked').map((c) => c.path);
      if (untracked.length) {
        const r = await git.run(at, ['add', '--', ...untracked]);
        if (r.code !== 0) return problem(r, 'add the new files');
      }
      const paths = files.flatMap((c) => [c.path, ...(c.origPath ? [c.origPath] : [])]);
      const r = await git.run(at, ['commit', '-m', text, ...(amend ? ['--amend'] : []), ...(paths.length ? ['--', ...paths] : [])], { timeoutSec: COMMIT_TIMEOUT_SEC });
      if (r.code === 0) return { actions: [{ type: 'closeWindow' }] };
      // No name or email: Git Settings over the Commit window, which keeps its message for when they're saved.
      if (needsIdentity(`${r.stderr}\n${r.stdout}`)) return settingsWindow({ environmentId: proj.environmentId, identity: true }, true);
      return problem(r, 'commit');
    } finally {
      afterAction(projectId);
    }
  }

  async function switchBranch(proj: AddonProjectInfo, values: Record<string, AddonValue>): Promise<AddonEventResult> {
    const name = str(values.branch);
    if (!name) return invalid('branch', "There isn't a branch selected");
    const s = await repo(proj);
    if (name === s.branch) return {};
    if (name.startsWith('-')) return invalid('branch', `"${name}" isn't a branch`);
    try {
      const r = await git.run({ projectId: proj.id, cwd: s.root }, ['switch', name]);
      return r.code === 0 ? {} : problem(r, `switch to "${name}"`);
    } finally {
      afterAction(proj.id);
    }
  }

  async function createBranch(proj: AddonProjectInfo, values: Record<string, AddonValue>): Promise<AddonEventResult> {
    const name = str(values.newBranch).trim();
    if (!name) return invalid('newBranch', 'The new branch needs a name');
    if (name.startsWith('-')) return invalid('newBranch', `"${name}" can't be a branch's name`);
    const s = await repo(proj);
    try {
      const r = await git.run({ projectId: proj.id, cwd: s.root }, ['switch', '-c', name]);
      if (r.code === 0) return { values: { newBranch: '' } };
      // A name git refuses, or one a branch already has, is the field's problem.
      const p = gitProblem(r, `create the branch "${name}"`);
      return /already exists|can't be a branch's name/.test(p.message) ? invalid('newBranch', p.message) : message('error', p.message, p.detail);
    } finally {
      afterAction(proj.id);
    }
  }

  async function clone(values: Record<string, AddonValue>, request?: number): Promise<AddonEventResult> {
    const url = str(values.url).trim();
    if (!url) return invalid('url', "The repository's URL is empty");
    const picked = str(values.folder).trim();
    if (!picked) return invalid('folder', "There isn't a folder chosen to clone into");
    const envs = await environments();
    const env = envs.find((e) => e.id === values.environment) ?? envs.find((e) => e.default) ?? envs[0];
    if (!env) return message('error', "There isn't an environment to clone in");
    const name = str(values.name).trim() || nameFromUrl(url);
    const bad = badFolderName(name);
    if (bad) return invalid('name', bad);
    let folder: string;
    try {
      folder = toSidePath(picked, env.side);
    } catch (e) {
      return invalid('folder', (e as Error).message);
    }
    const ctx = askContext(request);
    let r: AddonExecResult;
    try {
      r = await remoteGit({ environmentId: env.id, cwd: folder }, env.side, ['clone', '--', url, name], ctx);
    } catch (e) {
      return message('error', "Can't clone the repository", (e as Error).message);
    }
    // The user closed a prompt: the Clone window stays as it was.
    if (r.code !== 0) return ctx.cancelled ? {} : problem(r, 'clone the repository', url);
    if (values.add === false) {
      looper.refresh({ panes: [PANE] });
      return { actions: [{ type: 'closeWindow' }] };
    }
    const created = (await looper.request('looper/createProject', { name, cwd: joinSidePath(folder, name, env.side), environmentId: env.id })) as { id: string };
    projectList = undefined;
    return {
      actions: [{ type: 'closeWindow' }, { type: 'refresh' }, { type: 'select', pane: PANE, item: itemId(created.id) }],
    };
  }

  /** The environment an Install Git button is for: the screen's project's, or Git Settings' chosen one. */
  async function installTarget(ev: AddonEvent): Promise<AddonEnvironmentInfo & { projectId?: string }> {
    if ('view' in ev.source && ev.source.view === 'settings') {
      const envs = await environments();
      const id = str(ev.values?.environment) || str(ev.source.params.environmentId);
      const env = envs.find((e) => e.id === id) ?? envs.find((e) => e.default);
      if (!env) throw new Error('The environment no longer exists.');
      return env;
    }
    const proj = await eventProject(ev);
    return { ...(await environmentOf(proj)), side: proj.side, projectId: proj.id };
  }

  /** Install git in an environment where it's missing, then look again. */
  async function installGit(env: AddonEnvironmentInfo & { projectId?: string }, request?: number): Promise<AddonEventResult> {
    const ctx = askContext(request, 'install');
    const where = env.projectId ? { projectId: env.projectId } : { environmentId: env.id };
    const place = { ...where, cwd: envRoot(env.side) };
    const failed = `Can't install Git in "${env.name}"`;
    let r: AddonExecResult;
    try {
      // sudo asks for its password through the prompt windows; winget asks nothing (Windows' own UAC prompt shows if the installer needs it).
      r =
        env.side === 'wsl'
          ? await withPrompts(ctx, env.side, (o) =>
              exec({ ...place, argv: o.wrap ? o.wrap(['sh', '-c', INSTALL_SCRIPT]) : ['sh', '-c', INSTALL_SCRIPT], ...(o.env ? { env: o.env } : {}), timeoutSec: INSTALL_TIMEOUT_SEC }),
            )
          : await exec({ ...place, argv: WINGET, timeoutSec: INSTALL_TIMEOUT_SEC });
    } catch (e) {
      const why = (e as Error).message;
      if (env.side === 'windows' && /isn't installed/.test(why)) return message('error', "Can't install Git because winget isn't installed", 'To install Git, download it from https://git-scm.com/download/win.');
      return message('error', failed, why);
    } finally {
      git.forget();
      looper.refresh({ ...AFTER_ACTION, views: [...AFTER_ACTION.views!, 'settings'] });
    }
    if (r.code !== 0) {
      if (ctx.cancelled) return {};
      const problem = installProblem(r.stdout);
      if (problem?.kind === 'no-manager') return message('error', failed, `Looper didn't find apt-get, dnf, zypper, pacman or apk in "${env.name}".`);
      if (problem?.kind === 'no-sudo') {
        return message('info', `Git has to be installed as root in "${env.name}"`, `"${env.name}" doesn't have sudo. To install Git, run this${problem.distro ? ' in a Windows terminal' : ''}:\n\n${rootCommand(problem)}`);
      }
      return message('error', failed, tail(gitWords(r)));
    }
    if (env.side === 'windows') {
      // Looper's programs keep the PATH Looper started with, which doesn't have Git's folder yet.
      const now = env.projectId ? await project(env.projectId).then((p) => git.state(p)) : undefined;
      if (!now || (!now.repo && now.missing === 'git')) return message('info', 'Git is installed', 'To use it, restart Looper.');
    }
    return {};
  }

  /** Git Settings' Environment changed: its fields show that environment's settings. */
  async function environmentChanged(ev: AddonEvent): Promise<AddonEventResult> {
    const env = (await environments()).find((e) => e.id === ev.values?.environment);
    if (!env) return message('error', 'The environment no longer exists');
    settingsChoice = env.id;
    const g = await readGlobal(env);
    // Drawn again for the chosen environment: its fields, or that git isn't installed there with Install Git.
    looper.refresh({ views: ['settings'] });
    if (g === 'no-git') return {};
    return { values: { name: g.name, email: g.email, defaultBranch: g.defaultBranch, pull: g.pull } };
  }

  async function saveSettings(ev: AddonEvent): Promise<AddonEventResult> {
    const values = ev.values ?? {};
    const envs = await environments();
    // The fields hold the chosen environment's settings: the select's, or the one the window opened with.
    const chosen = str(values.environment) || ('view' in ev.source ? str(ev.source.params.environmentId) : '');
    const env = envs.find((e) => e.id === chosen) ?? envs.find((e) => e.default) ?? envs[0];
    if (!env) return message('error', "There isn't an environment to run Git in");
    const branch = str(values.defaultBranch).trim();
    if (branch && (branch.startsWith('-') || /\s/.test(branch))) return invalid('defaultBranch', `"${branch}" can't be a branch's name`);
    const g = await readGlobal(env);
    if (g === 'no-git') return message('error', `Git isn't installed in "${env.name}"`);
    const cwd = envRoot(env.side);
    const steps: Step[] = [];
    const set = (key: string, value: string) => steps.push({ cwd, args: ['config', '--global', key, value] });
    const unset = (key: string) => steps.push({ cwd, args: ['config', '--global', '--unset-all', key] });
    for (const [field, key, before] of [
      ['name', 'user.name', g.name],
      ['email', 'user.email', g.email],
      ['defaultBranch', 'init.defaultBranch', g.defaultBranch],
    ] as const) {
      const now = field === 'defaultBranch' ? branch : str(values[field]).trim();
      if (now === before) continue;
      if (now) set(key, now);
      else unset(key);
    }
    const pull = PULL_OPTIONS.some((o) => o.value === values.pull) ? (values.pull as PullMode) : g.pull;
    if (pull !== g.pull) {
      if (pull === 'ff-only') set('pull.ff', 'only');
      else {
        set('pull.rebase', pull === 'rebase' ? 'true' : 'false');
        if (g.raw.has('pull.ff')) unset('pull.ff');
      }
      if (pull === 'ff-only' && g.raw.has('pull.rebase')) unset('pull.rebase');
    }
    if (steps.length) {
      const r = await git.steps({ environmentId: env.id }, env.side, steps);
      if (r === 'no-git') return message('error', `Git isn't installed in "${env.name}"`);
      // --unset-all exits with 5 when the key isn't set.
      const bad = failedStep(r, (s) => s.code === 0 || (s.code === 5 && s.stdout === ''));
      if (bad) return problem(bad, 'save the settings');
    }
    return { actions: [{ type: 'closeWindow' }] };
  }

  async function saveRepoSettings(proj: AddonProjectInfo, values: Record<string, AddonValue>): Promise<AddonEventResult> {
    await repo(proj);
    const { local } = await readRepo(proj);
    const url = str(values.remote).trim();
    if (url.startsWith('-')) return invalid('remote', `"${url}" isn't a URL`);
    const cwd = proj.cwd;
    const steps: Step[] = [];
    for (const [field, key] of [
      ['name', 'user.name'],
      ['email', 'user.email'],
    ] as const) {
      const now = str(values[field]).trim();
      if (now === (local.get(key) ?? '')) continue;
      steps.push({ cwd, args: now ? ['config', '--local', key, now] : ['config', '--local', '--unset-all', key] });
    }
    const before = local.get('remote.origin.url') ?? '';
    if (url !== before) steps.push({ cwd, args: !url ? ['remote', 'remove', 'origin'] : before ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url] });
    if (!steps.length) return { actions: [{ type: 'closeWindow' }] };
    try {
      const r = await git.steps({ projectId: proj.id }, proj.side, steps);
      if (r === 'no-git') return message('error', "Git isn't installed in the project's environment");
      const bad = failedStep(r, (s) => s.code === 0 || (s.code === 5 && s.stdout === ''));
      if (bad) return problem(bad, "save the repository's settings");
      return { actions: [{ type: 'closeWindow' }] };
    } finally {
      afterAction(proj.id);
    }
  }

  /** A prompt's window's button: the answer goes to the command waiting for it, and the window closes. */
  function answerPrompt(ev: AddonEvent): AddonEventResult {
    const id = 'view' in ev.source ? str(ev.source.params.id) : '';
    const open = prompts.get(id);
    if (open) {
      prompts.delete(id);
      open.resolve(promptAnswer(open.prompt, ev.values ?? {}));
    }
    return { actions: [{ type: 'closeWindow' }] };
  }

  async function event(ev: AddonEvent, request?: number): Promise<AddonEventResult> {
    if (ev.kind === 'more') {
      if (ev.id !== 'history' || !('view' in ev.source)) return {};
      const projectId = str(ev.source.params.projectId);
      historyPages.set(projectId, (historyPages.get(projectId) ?? 1) + 1);
      looper.refresh({ views: [ev.source.view] });
      return {};
    }
    if (ev.kind === 'command') return command(ev, request);
    if (ev.kind === 'change') {
      if ('view' in ev.source && ev.source.view === 'settings' && ev.id === 'environment') return environmentChanged(ev);
      return {};
    }
    // Double-clicking a repository does nothing more than selecting it.
    if (ev.kind === 'open') return {};
    if (ev.kind === 'click') {
      const values = ev.values ?? {};
      const view = 'view' in ev.source ? ev.source.view : '';
      if (view === 'askpass' && ev.id === 'answer') return answerPrompt(ev);
      if (ev.id === 'clone') return clone(values, request);
      if (ev.id === 'save-settings') return saveSettings(ev);
      if (ev.id === 'install-git') return installGit(await installTarget(ev), request);
      const proj = await eventProject(ev);
      switch (ev.id) {
        case 'init':
          return init(proj.id);
        case 'commit':
          return commit(proj, values);
        case 'switch':
          return switchBranch(proj, values);
        case 'create-branch':
          return createBranch(proj, values);
        case 'save-repo-settings':
          return saveRepoSettings(proj, values);
      }
    }
    throw new Error(`There's no action "${ev.id}".`);
  }

  async function projectTab(params: Record<string, unknown>): Promise<AddonProjectTabState> {
    if (params.tab !== 'git') throw new Error(`There's no project tab "${str(params.tab)}".`);
    const s = await project(params.projectId)
      .then((p) => git.state(p))
      .catch((): RepoState => ({ repo: false }));
    return s.repo ? { title: gitTabLabel(s.changes) } : { hidden: true };
  }

  return {
    async handle(method, params, info = {}) {
      if (method === 'initialize') {
        locale = typeof params.locale === 'string' && params.locale ? params.locale : undefined;
        if (params.host === 'windows' || params.host === 'wsl' || params.host === 'linux' || params.host === 'mac') host = params.host;
        dataDir = typeof params.dataDir === 'string' && params.dataDir ? params.dataDir : undefined;
        return {};
      }
      askActivity();
      switch (method) {
        case 'pane':
          return pane(params);
        case 'render':
          return render(params);
        case 'event':
          return event(params as unknown as AddonEvent, info.request);
        case 'projectTab':
          return projectTab(params);
      }
      throw new UnknownMethodError(`The Git addon doesn't answer "${method}".`);
    },
    notify(method, params) {
      if (method === 'projectsChanged') {
        projectList = undefined;
        git.forget();
        looper.refresh({ panes: [PANE], projectTabs: true });
      } else if (method === 'activity' && typeof params.projectId === 'string') {
        setWorking(params.projectId, params.working === true);
      }
    },
    close() {
      closed = true;
      for (const timer of watched.values()) clearInterval(timer);
      watched.clear();
      askpass?.close();
      for (const p of prompts.values()) p.resolve('failed');
      prompts.clear();
    },
  };
}

function diffNode(path: string, subtitle: string, diff: { binary: boolean; hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]; truncated: boolean }): AddonNode {
  return {
    type: 'diff',
    title: path,
    subtitle,
    hunks: diff.hunks,
    ...(diff.binary ? { binary: true } : {}),
    ...(diff.truncated ? { truncated: true } : {}),
  };
}
