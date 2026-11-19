import { defaultEnvironment, resolveEnvironment } from '../shared/environments';
import { projectSessionTask } from '../shared/projects';
import {
  environmentSide,
  type AddonEnvironmentInfo,
  type AddonExecResult,
  type AddonProjectInfo,
  type AddonRequestMethod,
  ADDON_REQUESTS,
} from '../shared/addons';
import type { SessionSummary } from '../shared/sessions';
import type { Environment, Project, ProjectInput, Settings } from '../shared/types';
import { execInEnvironment } from '../engine/env-exec';
import type { CommandPlace } from '../engine/engine';
import type { HostKind } from '../engine/host';
import { childEnv } from '../engine/steps/common';
import type { z } from 'zod';

/** What an addon's `looper/exec` may write, stdout and stderr together. */
export const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const EXEC_TIMEOUT_SEC = 60;

export type AddonRequestParams<M extends AddonRequestMethod> = z.output<(typeof ADDON_REQUESTS)[M]>;

export interface AddonRequestDeps {
  host: HostKind;
  settings: () => Settings;
  /** Looper's projects, in the Projects tab's order. */
  projects: () => Project[];
  /** Validate and save a project (engine.saveProject); throws with the reason. */
  saveProject: (input: Omit<ProjectInput, 'id'>) => Project;
  /** The Chats window's sessions now. */
  sessions: () => SessionSummary[];
  /** A terminal that runs `command` there, where Looper shows terminals. */
  openTerminal: (where: CommandPlace, command: string[], title: string) => Promise<void>;
  /** An addon's screen as a dialog (openRequestedWindow); resolves once it has closed. */
  openWindow: (addonId: string, p: AddonRequestParams<'looper/openWindow'>) => Promise<unknown>;
}

/** Environments a program can run in from where Looper runs (a WSL bridge works from Windows, a Windows one from WSL). */
const reachable = (e: Environment, host: HostKind): boolean => e.kind === 'local' || (e.kind === 'wsl' && host === 'windows') || (e.kind === 'windows' && host === 'wsl');

/** The projects an agent is working in now, as a project's view tells it (a session there with status 'working'). */
export function workingProjects(sessions: SessionSummary[]): string[] {
  const ids = new Set<string>();
  for (const s of sessions) if (s.projectId && s.status === 'working') ids.add(s.projectId);
  return [...ids];
}

/** Each project's working state, so the `activity` notification goes out only when one changes. */
export class ProjectActivity {
  private working: Set<string>;

  constructor(sessions: SessionSummary[] = []) {
    this.working = new Set(workingProjects(sessions));
  }

  /** The projects whose working state changed with these sessions. */
  update(sessions: SessionSummary[]): { projectId: string; working: boolean }[] {
    const now = new Set(workingProjects(sessions));
    const changes: { projectId: string; working: boolean }[] = [];
    for (const id of now) if (!this.working.has(id)) changes.push({ projectId: id, working: true });
    for (const id of this.working) if (!now.has(id)) changes.push({ projectId: id, working: false });
    this.working = now;
    return changes;
  }
}

/** A command as one line, for a terminal's title. */
const commandTitle = (argv: string[]): string => argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');

/** Answers an addon's requests to Looper (ADDON_REQUESTS); the host has checked their params. */
export function addonRequestHandler(d: AddonRequestDeps): (method: AddonRequestMethod, params: unknown, addonId: string) => Promise<unknown> {
  const project = (id: string): Project => {
    const p = d.projects().find((x) => x.id === id);
    if (!p) throw new Error(`There's no project "${id}".`);
    return p;
  };
  const projectEnvironment = (p: Project): Environment => resolveEnvironment(projectSessionTask(p, d.settings()), d.settings());
  /** `environmentId`'s environment, or the default one that runs programs from here. */
  const environment = (id: string | undefined): Environment => {
    const s = d.settings();
    const found = id ? s.environments.find((e) => e.id === id) : defaultEnvironment(s, (e) => reachable(e, d.host));
    if (!found) throw new Error(id ? `There's no environment "${id}".` : 'No environment in Settings → Environments runs programs.');
    return found;
  };

  const handlers: { [M in AddonRequestMethod]: (p: AddonRequestParams<M>, addonId: string) => Promise<unknown> | unknown } = {
    'looper/projects': (): AddonProjectInfo[] =>
      d.projects().flatMap((p) => {
        let env: Environment;
        try {
          env = projectEnvironment(p);
        } catch {
          return []; // its environment is gone: nothing runs there
        }
        return [{ id: p.id, name: p.name, cwd: p.cwd, environmentId: p.environmentId, side: environmentSide(env.kind, d.host) }];
      }),
    'looper/environments': (): AddonEnvironmentInfo[] => {
      const s = d.settings();
      const fits = s.environments.filter((e) => reachable(e, d.host));
      const def = defaultEnvironment(s, (e) => reachable(e, d.host));
      return fits.map((e) => ({ id: e.id, name: e.name, side: environmentSide(e.kind, d.host), default: e.id === def?.id }));
    },
    'looper/exec': async (p): Promise<AddonExecResult> => {
      let env: Environment;
      let cwd = p.cwd;
      if (p.projectId) {
        const proj = project(p.projectId);
        env = projectEnvironment(proj);
        cwd ??= proj.cwd;
      } else env = environment(p.environmentId);
      return execInEnvironment(env, d.host, p.argv, {
        cwd,
        env: p.env,
        baseEnv: childEnv(),
        stdin: p.stdin,
        timeoutMs: (p.timeoutSec ?? EXEC_TIMEOUT_SEC) * 1000,
        maxBuffer: EXEC_MAX_BUFFER,
      });
    },
    'looper/createProject': (p) => {
      const s = d.settings();
      const env = p.environmentId ? s.environments.find((e) => e.id === p.environmentId) : defaultEnvironment(s);
      if (!env) throw new Error(p.environmentId ? `There's no environment "${p.environmentId}".` : 'Add an environment in Settings → Environments first.');
      // As File → New Project starts one.
      const harnessId = env.harnesses[0]?.id;
      const saved = d.saveProject({
        name: p.name,
        cwd: p.cwd,
        environmentId: env.id,
        ...(harnessId ? { harnessId } : {}),
        permissionMode: 'auto',
        mode: 'interactive',
        remote: false,
      });
      return { id: saved.id };
    },
    'looper/openTerminal': async (p) => {
      let where: CommandPlace;
      if (p.projectId) {
        const proj = project(p.projectId);
        // Another folder than the project's: that folder, in the project's environment.
        where = p.cwd ? { environmentId: proj.environmentId, cwd: p.cwd } : { projectId: proj.id };
      } else where = { environmentId: environment(p.environmentId).id, cwd: p.cwd! };
      await d.openTerminal(where, p.command, p.title ?? commandTitle(p.command));
      return {};
    },
    'looper/activity': () => ({ working: workingProjects(d.sessions()) }),
    'looper/openWindow': async (p, addonId) => {
      await d.openWindow(addonId, p);
      return {};
    },
  };
  return async (method, params, addonId) => (handlers[method] as (p: unknown, addonId: string) => unknown)(params, addonId);
}
