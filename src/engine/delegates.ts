import path from 'node:path';
import { resolveEnvironment, resolveHarness } from '../shared/environments';
import { resultLabel } from '../shared/format';
import { normalizeFolder, sameFolder, sessionTask } from '../shared/projects';
import type { Environment, Harness, Project, Settings, Task } from '../shared/types';
import { envPrefix, envSide, runProbe } from './discover-models';
import type { HostKind } from './host';
import { AGENT_DELEGATE } from './steps/common';

/*
 * The parts of looper-delegate that don't need the scheduler: what the
 * command's arguments ask for, the task a delegated agent runs as, and the
 * messages its parent gets. A delegated agent is a run of its parent's task,
 * in its own folder, with the project's settings there (or the parent's
 * harness with the defaults when the folder is no project's).
 */

export const DELEGATE_USAGE = [
  'usage:',
  `  ${AGENT_DELEGATE} start <folder> --title "<short title>" --brief-file <file> [--model <model>] [--effort <effort>]`,
  `  ${AGENT_DELEGATE} list`,
  `  ${AGENT_DELEGATE} tell <id> "<text>"`,
  `  ${AGENT_DELEGATE} stop <id>`,
].join('\n');

export interface StartArgs {
  folder: string;
  title: string;
  briefFile: string;
  model?: string;
  effort?: string;
}

export type DelegateRequest =
  | { op: 'start'; start: StartArgs }
  | { op: 'list' }
  | { op: 'tell'; id: string; text: string }
  | { op: 'stop'; id: string };

const START_OPTIONS = new Set(['title', 'brief-file', 'model', 'effort']);

/** What a looper-delegate call asks for, or why it can't be done. */
export function parseDelegateArgs(args: readonly string[]): DelegateRequest | { error: string } {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'start': {
      let folder: string | undefined;
      const opts: Record<string, string> = {};
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(a);
        if (m) {
          if (!START_OPTIONS.has(m[1])) return { error: `start has no option --${m[1]}` };
          const v = m[2] ?? rest[++i];
          if (v === undefined || !v.trim()) return { error: `--${m[1]} needs a value` };
          opts[m[1]] = v.trim();
          continue;
        }
        if (folder !== undefined) return { error: `start takes one folder, and "${a}" is a second one` };
        folder = a;
      }
      if (!folder?.trim()) return { error: 'start needs the folder the agent works in' };
      if (!opts.title) return { error: 'start needs --title' };
      if (!opts['brief-file']) return { error: 'start needs --brief-file' };
      return {
        op: 'start',
        start: {
          folder: folder.trim(),
          title: opts.title,
          briefFile: opts['brief-file'],
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
        },
      };
    }
    case 'list':
      return rest.length ? { error: 'list takes no arguments' } : { op: 'list' };
    case 'tell': {
      const [id, ...words] = rest;
      // Each argument arrives on a line of its own, so the text's own line breaks survive.
      const text = words.join('\n').trim();
      if (!id || !text) return { error: 'tell needs an agent id and the text' };
      return { op: 'tell', id, text };
    }
    case 'stop':
      return rest.length === 1 && rest[0] ? { op: 'stop', id: rest[0] } : { error: 'stop needs one agent id' };
    default:
      return { error: cmd ? `there is no command "${cmd}"` : 'no command given' };
  }
}

/** A path the caller named, absolute in its own path form: relative ones are from the caller's folder. */
export function absolutePath(windows: boolean, cwd: string, p: string): string {
  const paths = windows ? path.win32 : path.posix;
  if (paths.isAbsolute(p)) return normalizeFolder(paths.normalize(p));
  return normalizeFolder(paths.join(cwd || paths.sep, p));
}

/**
 * The task a delegated agent runs as, under its parent's task id. A
 * project's folder gives the project's settings; any other folder the
 * parent's environment and harness, with Looper's default permission mode
 * and the harness's default model. Either way it runs interactive, with the
 * parent's runtime limits, asks its questions of its parent, and can neither
 * start agents of its own nor finish the task for good.
 */
export function delegateTask(parent: Task, settings: Settings, projects: readonly Project[], folder: string, start: StartArgs): Task {
  const project = projects.find((p) => sameFolder(p.cwd, folder));
  let base: Task;
  if (project) base = sessionTask(project, settings, parent.id);
  else {
    const env = resolveEnvironment(parent, settings);
    const harness = resolveHarness(parent, env);
    base = sessionTask({ name: start.title, environmentId: env.id, harnessId: harness.id, cwd: folder, permissionMode: 'auto' }, settings, parent.id);
  }
  const a = parent.agent;
  return {
    ...base,
    name: start.title,
    completion: { ...base.completion, allowed: false },
    agent: {
      ...base.agent,
      ...(start.model ? { model: start.model } : {}),
      ...(start.effort ? { effort: start.effort } : {}),
      mode: 'interactive',
      session: 'fresh',
      maxRuntimeMin: a.maxRuntimeMin,
      idleGraceMin: a.idleGraceMin,
      onIdleTimeout: 'finish',
      contextLimitK: a.contextLimitK,
      maxRestarts: a.maxRestarts,
      ask: { allowed: true, waitMin: a.ask.waitMin },
      delegate: { allowed: false },
    },
  };
}

/** What the parent's agent gets when one of its agents ends. */
export function resultEntry(o: {
  id: string;
  title: string;
  folder: string;
  outcome: string;
  headline?: string;
  body?: string;
  transcript?: string;
  runFolder: string;
  /** The parent's other agents still going. */
  others: readonly string[];
}): string {
  return [
    `## ${o.title} (${o.id}) ended: ${resultLabel(o.outcome)}${o.headline ? `. ${o.headline}` : ''}`,
    `Folder: ${o.folder}`,
    `Run folder: ${o.runFolder}`,
    `Transcript: ${o.transcript ?? 'none was recorded'}`,
    o.others.length ? `Still going: ${o.others.join(', ')}` : 'No other agent you started is still going.',
    '',
    'Final report:',
    o.body?.trim() || '(The agent wrote no final report.)',
  ].join('\n');
}

/** What the parent's agent gets when one of its agents asks it a question. */
export function questionEntry(id: string, title: string, question: string, waitMin: number): string {
  return [
    `## ${title} (${id}) asks you:`,
    question,
    '',
    `Answer with ${AGENT_DELEGATE} tell ${id} "<answer>". It waits up to ${Number(waitMin.toFixed(2))} min, then goes on without an answer.`,
  ].join('\n');
}

const posixQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Why a delegated agent must wait for its folder: a Claude Code session of
 * the harness's that `claude agents` reports busy there (Looper's own runs,
 * chats and terminals included), or null. Only Claude Code tells; for other
 * harnesses Looper goes by its own runs.
 */
export async function claudeBusyIn(env: Environment, harness: Harness, host: HostKind, folder: string): Promise<string | null> {
  if (harness.kind !== 'claude-code') return null;
  const side = envSide(env, host);
  // A wrapper (`bun run claude`) only works in its own repo: the CLI itself lists the sessions.
  const command = /\s/.test(harness.command.trim()) ? 'claude' : harness.command.trim();
  const quote = side === 'posix' ? posixQuote : psQuote;
  const out = await runProbe(env, host, envPrefix(side, harness.env) + `${command} agents --json --cwd ${quote(folder)}`);
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`${command} agents printed no list`);
  const list = JSON.parse(out.slice(start)) as { cwd?: unknown; status?: unknown; name?: unknown }[];
  const busy = list.find((s) => s.status === 'busy' && (typeof s.cwd !== 'string' || sameFolder(s.cwd, folder)));
  if (!busy) return null;
  return typeof busy.name === 'string' && busy.name ? `the session "${busy.name}" is working in that folder` : 'a session is working in that folder';
}
