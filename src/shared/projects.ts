import { TaskSchema, type Environment, type Project, type Settings, type Task, type View } from './types';

/** What a session needs to know about where it runs: a project's or a Remote Control helper's values. */
export type SessionPlace = Pick<Project, 'name' | 'environmentId' | 'harnessId' | 'cwd' | 'model' | 'effort' | 'permissionMode'> &
  Partial<Pick<Project, 'env' | 'extraArgs'>>;

/**
 * The task-like stand-in a session that no task supplies runs as, under the
 * stand-in id `id`. `claude`: a harness that isn't Claude Code gives way to
 * the environment's first Claude Code harness (Remote Control needs one).
 */
export function sessionTask(place: SessionPlace, settings: Settings, id: string, claude = false): Task {
  const env = settings.environments.find((e) => e.id === place.environmentId);
  const own = place.harnessId ? env?.harnesses.find((h) => h.id === place.harnessId) : env?.harnesses[0];
  const harnessId = claude && own?.kind !== 'claude-code' ? env?.harnesses.find((h) => h.kind === 'claude-code')?.id : own?.id;
  const task = TaskSchema.parse({
    id: 'stand-in',
    name: place.name,
    environmentId: place.environmentId,
    cwd: place.cwd,
    env: place.env ?? {},
    trigger: { mode: 'manual' },
    agent: {
      extraArgs: place.extraArgs ?? [],
      ...(harnessId ? { harnessId } : {}),
      // A model, effort or mode picked for another harness doesn't carry over.
      ...(place.model && harnessId === own?.id ? { model: place.model } : {}),
      ...(place.effort && harnessId === own?.id ? { effort: place.effort } : {}),
      permissionMode: harnessId === own?.id ? place.permissionMode : 'auto',
      prompt: '-',
    },
  });
  return { ...task, id };
}

/** A project's sessions run as this stand-in. */
export const projectSessionTask = (project: Project, settings: Settings, claude = false): Task =>
  sessionTask(project, settings, projectTaskId(project.id), claude);

/** The stand-in task id a project's chats, terminals and Remote Control conversations are recorded under (a task id can't start with "@"). */
export const projectTaskId = (projectId: string): string => `@project-${projectId}`;
export const projectIdOf = (taskId: string): string | undefined =>
  taskId.startsWith('@project-') ? taskId.slice('@project-'.length) : undefined;
/** A stand-in id (a project's, a folder's or a Remote Control helper's), not a task's. */
export const isStandInTaskId = (taskId: string): boolean => taskId.startsWith('@');

/** The start of the stand-in id the chats and terminals opened in a folder without a project (Other Folder…) are recorded under. */
export const FOLDER_TASK_PREFIX = '@folder-';

/**
 * The environment a folder picked on the host opens in (Other Folder…): on a
 * Windows host a \\wsl.localhost\<distro> (or \\wsl$) folder opens in that
 * distro's WSL environment, else in one on the default distro; any other
 * folder in the default environment. Undefined: no WSL environment fits.
 */
export function folderEnvironment(hostFolder: string, settings: Pick<Settings, 'environments' | 'defaultEnvironmentId'>, windowsHost: boolean): Environment | undefined {
  const envs = settings.environments;
  const unc = windowsHost ? /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)/i.exec(hostFolder) : null;
  if (unc) {
    const wsl = envs.filter((e) => e.kind === 'wsl');
    return wsl.find((e) => e.distro?.toLowerCase() === unc[1].toLowerCase()) ?? wsl.find((e) => !e.distro);
  }
  return envs.find((e) => e.id === settings.defaultEnvironmentId) ?? envs[0];
}

/** A folder path without its trailing separators, for comparing two folders. */
export function normalizeFolder(cwd: string): string {
  const trimmed = cwd.trim();
  return trimmed.length > 1 ? trimmed.replace(/(?<!^[A-Za-z]:)[\\/]+$/, '') : trimmed;
}

/** Whether two folders are the same; Windows paths compare without case. */
export function sameFolder(a: string, b: string): boolean {
  const x = normalizeFolder(a);
  const y = normalizeFolder(b);
  return /^[A-Za-z]:[\\/]|^\\\\/.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** The folder a folder is in, in its own path form; '' when it has no parent part (a bare name). */
export function parentFolder(cwd: string): string {
  const folder = normalizeFolder(cwd);
  const i = Math.max(folder.lastIndexOf('/'), folder.lastIndexOf('\\'));
  if (i < 0) return '';
  // The root's own parent is the root: "/", and a drive's "C:\".
  if (i === 0) return folder.slice(0, 1);
  const parent = folder.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? folder.slice(0, i + 1) : parent;
}

/** What the Projects tab groups its list by. */
export type ProjectGroupBy = View['projectsPane']['groupBy'];

/** The name of the harness a project's sessions start with (unset = the environment's first). */
export function projectHarnessName(project: Project, environments: Environment[]): string {
  const env = environments.find((e) => e.id === project.environmentId);
  const harness = project.harnessId ? env?.harnesses.find((h) => h.id === project.harnessId) : env?.harnesses[0];
  return harness?.name ?? '';
}

export interface ProjectGroup {
  key: string;
  /** Empty for an ungrouped list. */
  title: string;
  projects: Project[];
}

/**
 * The projects grouped by their parent folder on disk or their harness: the
 * groups go by title (a project with no parent folder or harness last), each
 * keeping the user's order of its projects; Windows folders group without
 * regard to case. Ungrouped, one group of them all (the user's own folders are
 * a tree, which a list or menu walks with siblingOrder).
 */
export function groupProjects(projects: Project[], groupBy: ProjectGroupBy, environments: Environment[]): ProjectGroup[] {
  if (groupBy === 'none') return [{ key: '', title: '', projects }];
  const groups = new Map<string, ProjectGroup>();
  for (const p of projects) {
    const title = groupBy === 'folder' ? parentFolder(p.cwd) : projectHarnessName(p, environments);
    const windows = groupBy === 'folder' && /^[A-Za-z]:[\\/]|^\\\\/.test(title);
    const key = windows ? title.toLowerCase() : title;
    const group = groups.get(key);
    if (group) group.projects.push(p);
    else groups.set(key, { key, title, projects: [p] });
  }
  const none = groupBy === 'folder' ? 'No folder' : 'No harness';
  return [...groups.values()]
    .sort((a, b) => (a.title === '' ? 1 : b.title === '' ? -1 : a.title.localeCompare(b.title)))
    .map((g) => (g.title === '' ? { ...g, title: none } : g));
}

/** A new project's name: its folder's last part. */
export function folderName(cwd: string): string {
  const folder = normalizeFolder(cwd);
  return folder.split(/[\\/]/).pop() || folder;
}

/**
 * The harness a project's task gets in `environmentId` when it doesn't pick
 * its own: the project's harness in the project's environment, else the
 * harness with the same id or, failing that, of the same kind in the other
 * one. Unset = the environment's first harness.
 */
export function projectHarnessIn(project: Project, environmentId: string, environments: Environment[]): string | undefined {
  if (environmentId === project.environmentId) return project.harnessId;
  const own = environments.find((e) => e.id === project.environmentId);
  const harness = project.harnessId ? own?.harnesses.find((h) => h.id === project.harnessId) : own?.harnesses[0];
  const env = environments.find((e) => e.id === environmentId);
  if (!harness || !env) return undefined;
  if (env.harnesses.some((h) => h.id === harness.id)) return harness.id;
  return env.harnesses.find((h) => h.kind === harness.kind)?.id;
}

/** The agent settings a task takes from its project unless it overrides them (`overrideAgent`). */
export type ProjectAgent = Pick<Task['agent'], 'harnessId' | 'mode' | 'model' | 'effort' | 'permissionMode'>;

/**
 * The agent settings a project gives a task running in `environmentId`: its
 * harness there (see projectHarnessIn) and its session type, model, effort and
 * permission mode. A harness of another kind than the project's own doesn't
 * share those model ids, efforts and modes, so it gets the defaults.
 */
export function projectAgentIn(project: Project, environmentId: string, environments: Environment[]): ProjectAgent {
  const harnessId = projectHarnessIn(project, environmentId, environments);
  const kindOf = (envId: string, id?: string) => {
    const env = environments.find((e) => e.id === envId);
    return (id ? env?.harnesses.find((h) => h.id === id) : env?.harnesses[0])?.kind;
  };
  const sameKind = kindOf(project.environmentId, project.harnessId) === kindOf(environmentId, harnessId);
  return {
    harnessId,
    mode: project.mode,
    model: sameKind ? project.model : undefined,
    effort: sameKind ? project.effort : undefined,
    permissionMode: sameKind ? project.permissionMode : 'auto',
  };
}

/** An agent with the project's settings in place of its own; unset ones are left out. */
export function withProjectAgent<A extends Task['agent']>(agent: A, pa: ProjectAgent): A {
  const out = { ...agent, ...pa };
  for (const key of ['harnessId', 'model', 'effort'] as const) if (out[key] === undefined) delete out[key];
  return out;
}

/** Whether a task's agent settings differ from the ones its project would give it. */
export function agentDiffers(agent: Task['agent'], pa: ProjectAgent, env: Environment | undefined): boolean {
  const own = (id?: string) => id ?? env?.harnesses[0]?.id;
  return (
    own(agent.harnessId) !== own(pa.harnessId) ||
    agent.mode !== pa.mode ||
    (agent.model || undefined) !== pa.model ||
    agent.effort !== pa.effort ||
    agent.permissionMode !== pa.permissionMode
  );
}

/** The task as it runs in its project: the project's folder, and its environment and agent settings unless the task overrides them. */
export function deriveTask(task: Task, project: Project, environments: Environment[]): Task {
  const environmentId = task.overrideEnvironment ? task.environmentId : project.environmentId;
  const agent = task.overrideAgent ? task.agent : withProjectAgent(task.agent, projectAgentIn(project, environmentId, environments));
  return { ...task, projectId: project.id, environmentId, cwd: project.cwd, agent, projectEnv: project.env, projectArgs: project.extraArgs };
}

/** The environment variables a task's steps get: its project's, then its own, which win on the same name. */
export const taskEnv = (task: Task): Record<string, string> => ({ ...task.projectEnv, ...task.env });

/** The extra arguments a task's agent gets: its project's, then its own. */
export const agentArgs = (task: Task): string[] => [...task.projectArgs, ...task.agent.extraArgs];
