import type { TaskWatch } from '../shared/chat';
import type { Task } from '../shared/types';
import { relatedIdOfLine } from './guidance';
import { AGENT_WATCH } from './steps/common';

/*
 * What a chat watches of Looper's tasks, from its agent's
 * looper-watch or the Chat menu's Watch Task Events: the end of each of a
 * task's runs, or its trigger events, all of them or only those with one
 * related id (the event id).
 */

export const WATCH_USAGE = [
  'usage:',
  `  ${AGENT_WATCH} tasks`,
  `  ${AGENT_WATCH} task <task-id>`,
  `  ${AGENT_WATCH} events <task-id> [<event-id>]`,
  `  ${AGENT_WATCH} stop <task-id>`,
].join('\n');

/** What a chat's agent is told about looper-watch. */
export const WATCH_FOOTER = [
  `Looper: this chat can watch Looper's tasks with the ${AGENT_WATCH} command.`,
  `\`${AGENT_WATCH} tasks\` lists its project's tasks, then the other projects', in the Tasks list's order, with what this chat watches.`,
  `\`${AGENT_WATCH} task <task-id>\` brings you the end of each of the task's runs, with its report.`,
  `\`${AGENT_WATCH} events <task-id> <event-id>\` brings you the task's trigger events whose looper_related_id is <event-id>; leave the event id out for all of its events.`,
  `\`${AGENT_WATCH} stop <task-id>\` stops watching the task.`,
  'What you watch reaches you as a "Looper task events" message while the chat is open.',
].join(' ');

export type WatchRequest = { op: 'tasks' } | { op: 'watch'; watch: TaskWatch } | { op: 'stop'; taskId: string };

/** What a looper-watch call asks for, or why it can't be done. */
export function parseWatchArgs(args: readonly string[]): WatchRequest | { error: string } {
  const [cmd, id, eventId, ...rest] = args.map((a) => a.trim());
  switch (cmd) {
    case 'tasks':
      return id ? { error: 'tasks takes no arguments' } : { op: 'tasks' };
    case 'task':
      if (!id || eventId) return { error: 'task needs one task id' };
      return { op: 'watch', watch: { taskId: id, what: 'runs' } };
    case 'events':
      if (!id || rest.length) return { error: 'events needs a task id, and at most one event id' };
      return { op: 'watch', watch: { taskId: id, what: 'events', ...(eventId ? { eventId } : {}) } };
    case 'stop':
      return id && !eventId ? { op: 'stop', taskId: id } : { error: 'stop needs one task id' };
    default:
      return { error: cmd ? `there is no command "${cmd}"` : 'no command given' };
  }
}

/** The watches with `w` added: watching all of a task's events covers each event id, and a watch already there stays one. */
export function withWatch(watches: readonly TaskWatch[], w: TaskWatch): TaskWatch[] {
  const same = (x: TaskWatch) => x.taskId === w.taskId && x.what === w.what;
  if (watches.some((x) => same(x) && (!x.eventId || x.eventId === w.eventId))) return [...watches];
  return [...watches.filter((x) => !(same(x) && !w.eventId)), w];
}

/** The event lines the watches take of the task's: all of them, or those whose related id is one they watch. */
export function watchedLines(watches: readonly TaskWatch[], taskId: string, lines: readonly string[]): string[] {
  const events = watches.filter((w) => w.taskId === taskId && w.what === 'events');
  if (!events.length) return [];
  if (events.some((w) => !w.eventId)) return [...lines];
  const ids = new Set(events.map((w) => w.eventId));
  return lines.filter((l) => ids.has(relatedIdOfLine(l) ?? ''));
}

/** What a watch is, in words. */
export function watchText(w: TaskWatch): string {
  if (w.what === 'runs') return 'the end of each run';
  return w.eventId ? `trigger events with event id ${w.eventId}` : 'all trigger events';
}

const TRIGGER_TEXT: Record<Task['trigger']['mode'], string> = { manual: 'started by hand', schedule: 'on a schedule', watcher: 'by its watcher' };

/** A task a chat can watch, in the Tasks list's order: whether it's in the chat's project, the folders it's in from the top, and its project's name. */
export interface WatchTarget {
  task: Task;
  own: boolean;
  folders: { id: string; name: string }[];
  project?: string;
}

/** looper-watch tasks: the project's tasks, then the other projects', each with how it starts and what the chat watches of it. */
export function tasksText(targets: readonly WatchTarget[], watches: readonly TaskWatch[]): string {
  const line = ({ task: t, own, project }: WatchTarget) => {
    const watched = watches.filter((w) => w.taskId === t.id).map(watchText);
    const where = !own && project ? ` (${project})` : '';
    return `${t.id}  "${t.name}"${where}, runs ${TRIGGER_TEXT[t.trigger.mode]}${watched.length ? `; watching ${watched.join(', ')}` : ''}`;
  };
  const own = targets.filter((x) => x.own);
  const other = targets.filter((x) => !x.own);
  return [
    ...(own.length ? [`The tasks of this chat's project, in the Tasks list's order (id, name):`, ...own.map(line)] : ["This chat's project has no tasks."]),
    ...(other.length ? [`The tasks of other projects, in the Tasks list's order (id, name, project):`, ...other.map(line)] : []),
  ].join('\n');
}
