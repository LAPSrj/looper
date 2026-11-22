import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { Transcript } from '../engine/cli-requests';
import { allows, levelProblem, type CliLevel } from '../shared/cli-levels';
import { messagesToMarkdown } from '../shared/messages-md';
import { callApp, type CallOptions } from './connect';

export interface CliContext {
  dataDir(): string;
  /** A path as the app's host sees it: from WSL, a Windows one when the app runs on Windows. */
  appPath(p: string): string;
  /** What Settings → Advanced → Command-line tool allows (Standard when the settings can't be read). */
  level(): CliLevel;
}

/**
 * A command that needs a level of the command-line tool: above the level set,
 * it's left out of the help and running it says which level it needs. The app
 * refuses it as well, so this only spares a round trip.
 */
export function gated(ctx: CliContext, parent: Command, spec: string, level: CliLevel): Command {
  const allowed = allows(ctx.level(), level);
  const cmd = parent.command(spec, { hidden: !allowed });
  if (!allowed) {
    cmd.hook('preAction', () => {
      console.error(levelProblem(level, ctx.level()));
      process.exit(1);
    });
  }
  return cmd;
}

/** A folder as the project's environment sees it: a Windows path as it is, any other made absolute. */
const envFolder = (f: string) => (/^[A-Za-z]:[\\/]/.test(f) || f.startsWith('\\\\') ? f : path.resolve(f));

/** A JSON object from a file ("-" reads stdin); exits when there's none. */
function jsonObject(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file === '-' ? 0 : file, 'utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* reported below */
  }
  console.error(`cannot read a JSON object from ${file === '-' ? 'stdin' : file}`);
  process.exit(2);
}

/** --timeout in seconds; exits with 2 when it isn't a number. */
export function seconds(timeout: string): number {
  const s = Number(timeout);
  if (!(s >= 0)) {
    console.error(`--timeout must be a number of seconds, got "${timeout}"`);
    process.exit(2);
  }
  return s;
}

/** Send Looper a command and return its answer (connect.ts's callApp); 2 on a bad --timeout. */
export function ask<T = unknown>(ctx: CliContext, method: string, params: Record<string, unknown>, timeout: string, opts?: CallOptions): Promise<T> {
  return callApp<T>(ctx.dataDir(), method, params, seconds(timeout), opts);
}

/** Text as it is, anything else as JSON unless `text` formats it; JSON always with --json. */
export function show<T>(data: T, json?: boolean, text?: (d: T) => string): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else if (typeof data === 'string') console.log(data);
  else console.log(text ? text(data) : JSON.stringify(data, null, 2));
}

/** Rows as aligned columns; `none` when there are none. */
export function columns(rows: string[][], none: string): string {
  if (!rows.length) return none;
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd()).join('\n');
}

/** "2h", "30min" or "1d" ago, or a date and time; milliseconds since the epoch. */
function since(value: string): number {
  const ago = /^(\d+)\s*(min|h|d)$/.exec(value.trim());
  if (ago) return Date.now() - Number(ago[1]) * { min: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2] as 'min' | 'h' | 'd'];
  const at = Date.parse(value);
  if (Number.isNaN(at)) {
    console.error(`--since must be like 2h, 30min, 1d or a date, got "${value}"`);
    process.exit(2);
  }
  return at;
}

const local = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '');

function printTranscript(t: Transcript, opts: { json?: boolean; thinking: boolean; tools: boolean; plain?: boolean }): void {
  if (opts.json) console.log(JSON.stringify(t.rows, null, 2));
  else console.log(messagesToMarkdown(t.rows, { title: t.title, includeThinking: opts.thinking, includeTools: opts.tools, plain: !!opts.plain }));
}

interface Opts {
  timeout: string;
  json?: boolean;
}

export function registerAppCommands(program: Command, ctx: CliContext): void {
  /** A command that asks the running app, with the --timeout every such command takes. */
  const app = (parent: Command, spec: string, description: string, level: CliLevel = 'standard') =>
    gated(ctx, parent, spec, level).description(description).option('--timeout <s>', 'seconds to wait for Looper to answer', '30');
  const run = <T = unknown>(method: string, params: Record<string, unknown>, opts: Opts) => ask<T>(ctx, method, params, opts.timeout);
  /** Run the method and print what it answers. */
  const act = async (method: string, params: Record<string, unknown>, opts: Opts) => show(await run(method, params, opts), opts.json);

  // ---------- chats and sessions ----------

  app(program, 'sessions', 'list the open chats, terminal sessions and task runs, with their ids')
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => {
      type S = { id: string; kind: string; status: string; project: string; title: string; waiting?: string };
      show(await run<S[]>('sessions', {}, opts), opts.json, (list) =>
        columns(list.map((s) => [s.id, s.kind, s.waiting ? `waiting (${s.waiting})` : s.status, s.project, s.title]), 'no open chats, terminal sessions or runs'),
      );
    });

  app(program, 'send <ids> [message...]', 'send a message to chats (queued while they work), terminal sessions (typed in), task runs (as guidance) or task builders; ids separated by commas')
    .option('--message-file <file>', 'read the message from a file ("-" reads stdin)')
    .option('--file <path...>', 'attach files')
    .action(async (ids: string, words: string[], opts: Opts & { messageFile?: string; file?: string[] }) => {
      if (opts.messageFile !== undefined && words.length) {
        console.error('give the message as arguments or with --message-file, not both');
        process.exit(2);
      }
      let text = words.join(' ');
      try {
        if (opts.messageFile !== undefined) text = fs.readFileSync(opts.messageFile === '-' ? 0 : opts.messageFile, 'utf8');
        const files = (opts.file ?? []).map((f) => ({ name: path.basename(f), data: fs.readFileSync(f).toString('base64') }));
        await act('send', { ids: ids.split(',').map((s) => s.trim()).filter(Boolean), text, ...(files.length ? { files } : {}) }, opts);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(2);
      }
    });

  app(program, 'end <id>', 'end a chat or terminal session (as Close Conversation does), a task run, or the run in progress of a task', 'basic')
    .option('--reason <r>', "a stopped run's reason")
    .action((id: string, opts: Opts & { reason?: string }) => act('end', { id, ...(opts.reason ? { reason: opts.reason } : {}) }, opts));

  app(program, 'interrupt <id>', "end the agent's turn in a chat or terminal session, and the whole run of a task run (Stop); a chat goes on with the next message, and its background work keeps running")
    .action((id: string, opts: Opts) => act('interrupt', { id }, opts));

  app(program, 'send-now <id>', "send a chat's queued messages, or a run's waiting guidance, at once, ending the agent's turn")
    .action((id: string, opts: Opts) => act('send-now', { id }, opts));

  app(program, 'queue <id>', "list a chat's queued messages or a run's waiting guidance, or take one back")
    .option('--cancel [messageId]', "take back a queued message (a run's guidance needs no id)")
    .option('--json', 'print JSON')
    .action(async (id: string, opts: Opts & { cancel?: string | true }) => {
      type Q = { id: string; text: string; files: string[] };
      const params = { id, ...(opts.cancel !== undefined ? { cancel: opts.cancel === true ? '' : opts.cancel } : {}) };
      show(await run<Q[] | string>('queue', params, opts), opts.json, (list) =>
        typeof list === 'string' ? list : columns((list as Q[]).map((m) => [m.id, m.text.replace(/\s+/g, ' ').slice(0, 100) + (m.files.length ? ` [${m.files.join(', ')}]` : '')]), 'nothing queued'),
      );
    });

  app(program, 'restart <id>', "restart a chat's or terminal session's agent on the same conversation")
    .action((id: string, opts: Opts) => act('restart', { id }, opts));

  app(program, 'rename <id> [name...]', 'rename a chat or terminal session; no name gives it back its automatic one')
    .action((id: string, words: string[], opts: Opts) => act('rename', { id, name: words.join(' ') }, opts));

  app(program, 'configure <chatId>', "change a chat's model, effort or auto compact")
    .option('--model <model>', 'the model')
    .option('--effort <effort>', 'the effort')
    .option('--auto-compact <choice>', 'on, off, or default (as Settings → Chats says)')
    .option('--permission-mode <mode>', 'the permission mode (Unrestricted)')
    .option('--harness <harnessId>', 'another harness of its environment, only before anything was said (Unrestricted)')
    .action((chatId: string, opts: Opts & { model?: string; effort?: string; autoCompact?: string; permissionMode?: string; harness?: string }) =>
      act(
        'configure',
        {
          id: chatId,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.autoCompact ? { autoCompact: opts.autoCompact } : {}),
          ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
          ...(opts.harness ? { harnessId: opts.harness } : {}),
        },
        opts,
      ),
    );

  app(program, 'compact <id>', "start a new chat from a compacted copy of a chat's or run's conversation (its messages, the latest session's tool calls and the results that fit), which takes a chat's place; prints the new chat's id")
    .action((id: string, opts: Opts) => act('compact', { id }, opts));

  app(program, 'fork <chatId>', "start a new chat from a chat's conversation up to a row (the row numbers looper transcript --json counts from 0)")
    .requiredOption('--at <row>', 'the last row the new chat keeps')
    .action((chatId: string, opts: Opts & { at: string }) => act('fork', { id: chatId, at: Number(opts.at) }, opts));

  app(program, 'auto-continue <chatId> <onOrOff>', 'Continue When Limit Resets, on or off, for a chat')
    .action((chatId: string, onOrOff: string, opts: Opts) => {
      if (onOrOff !== 'on' && onOrOff !== 'off') {
        console.error('give on or off');
        process.exit(2);
      }
      return act('auto-continue', { id: chatId, on: onOrOff === 'on' }, opts);
    });

  app(program, 'mute <chatId> <onOrOff>', "Mute Notifications, on or off, for a chat: no paired device gets a push for it")
    .action((chatId: string, onOrOff: string, opts: Opts) => {
      if (onOrOff !== 'on' && onOrOff !== 'off') {
        console.error('give on or off');
        process.exit(2);
      }
      return act('mute', { id: chatId, on: onOrOff === 'on' }, opts);
    });

  app(program, 'continue-anyway <chatId>', "let a chat continue even though Settings → Chats' prompt-cache rule would stop it")
    .action((chatId: string, opts: Opts) => act('continue-anyway', { id: chatId }, opts));

  app(program, 'watch <chatId> <taskId>', "send a chat's agent a task's run ends and trigger events (Watch Task Events)")
    .option('--event <id>', 'only the trigger events related to this id')
    .option('--stop', 'stop watching')
    .action((chatId: string, taskId: string, opts: Opts & { event?: string; stop?: boolean }) =>
      act('watch', { id: chatId, taskId, ...(opts.event ? { eventId: opts.event } : {}), ...(opts.stop ? { stop: true } : {}) }, opts),
    );

  app(program, 'transcript <id>', "print a chat's, run's or task builder's conversation as Markdown")
    .option('--agent <agentId>', "a subagent's conversation instead")
    .option('--raw', 'every record of the transcript, as Raw Messages shows them')
    .option('--no-thinking', 'leave out the thinking')
    .option('--no-tools', 'leave out the tool calls')
    .option('--plain', 'plain text instead of Markdown')
    .option('--json', 'print the rows as JSON')
    .action(async (id: string, opts: Opts & { agent?: string; raw?: boolean; thinking: boolean; tools: boolean; plain?: boolean }) => {
      printTranscript(await run<Transcript>('transcript', { id, ...(opts.agent ? { agentId: opts.agent } : {}), ...(opts.raw ? { raw: true } : {}) }, opts), opts);
    });

  app(program, 'activity <id>', "list a chat's, terminal session's or run's background commands, subagents and workflows")
    .option('--json', 'print JSON')
    .action(async (id: string, opts: Opts) => {
      type A = { background: { id: string; kind: string; status: string; label: string }[]; subagents: { agentId: string; status: string; description: string }[]; workflows: { runId: string; status: string; name: string }[] };
      show(await run<A>('activity', { id }, opts), opts.json, (a) =>
        columns(
          [
            ...a.background.map((b) => [b.id, b.kind, b.status, b.label]),
            ...a.subagents.map((s) => [s.agentId, 'subagent', s.status, s.description]),
            ...a.workflows.map((w) => [w.runId, 'workflow', w.status, w.name]),
          ],
          'nothing in the background',
        ),
      );
    });

  app(program, 'close-all', 'close every chat and terminal session, or only a project\'s')
    .option('--project <id>', "only this project's (or task's)")
    .action((opts: Opts & { project?: string }) => act('close-all', opts.project ? { project: opts.project } : {}, opts));

  // Unrestricted: with these, an agent could answer its own permission requests, start an agent with more
  // permissions than its own, or run any program outside its harness's checks.
  app(program, 'terminal <id>', "open a task's or project's harness in a Looper terminal session, or the system's terminal", 'unrestricted')
    .option('--run <runId>', "resume that run's conversation")
    .option('--system', "in the system's terminal")
    .action((id: string, opts: Opts & { run?: string; system?: boolean }) =>
      act('terminal', { id, ...(opts.run ? { runId: opts.run } : {}), ...(opts.system ? { system: true } : {}) }, opts),
    );
  app(program, 'command <projectId> <argv...>', "run a program in a project's environment and folder, in a terminal session", 'unrestricted')
    .option('--system', "in the system's terminal")
    .action((projectId: string, argv: string[], opts: Opts & { system?: boolean }) => act('command', { projectId, argv, ...(opts.system ? { system: true } : {}) }, opts));
  for (const name of ['allow', 'deny'] as const) {
    app(program, `${name} <id>`, `${name} the tool call a chat's or task run's agent is waiting on (the oldest, when there are several)`, 'unrestricted').action((id: string, opts: Opts) =>
      act(name, { id }, opts),
    );
  }

  // ---------- tasks and runs ----------

  app(program, 'continue <runId> <guidance...>', "start a run that resumes a finished run's conversation with the guidance as its prompt")
    .action((runId: string, words: string[], opts: Opts) => act('continue', { id: runId, text: words.join(' ') }, opts));

  app(program, 'recent', 'list the newest runs across every task')
    .option('-n, --limit <n>', 'how many', '30')
    .option('--since <time>', 'and every run since then: 2h, 30min, 1d or a date')
    .option('--skipped', 'include the runs the scheduler skipped')
    .option('--json', 'print JSON')
    .action(async (opts: Opts & { limit: string; since?: string; skipped?: boolean }) => {
      type R = { runId: string; taskName: string; startTs: string; result: string; details: string };
      const params = { limit: Number(opts.limit), ...(opts.since ? { since: since(opts.since) } : {}), ...(opts.skipped ? { skipped: true } : {}) };
      show(await run<R[]>('recent', params, opts), opts.json, (list) => columns(list.map((r) => [local(r.startTs), r.runId, r.taskName, r.result, r.details]), 'no runs'));
    });

  app(program, 'output <runId>', "print the end of a run's agent output")
    .option('--raw', 'the raw output, terminal codes and all')
    .action((runId: string, opts: Opts & { raw?: boolean }) => act('output', { id: runId, ...(opts.raw ? { raw: true } : {}) }, opts));

  app(program, 'note <taskId> [text...]', 'set the guidance for the next run of a task (Add Guidance for Next Run); no text clears it')
    .option('--runs <n>', 'how many runs get it', '1')
    .action((taskId: string, words: string[], opts: Opts & { runs: string }) => act('note', { taskId, note: words.join(' '), runs: Number(opts.runs) }, opts));

  const attention = app(program, 'attention', 'list what Needs Attention')
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => {
      type A = { taskId: string; task: string; level: string; problem: string; runId: string | null; at: string | null };
      show(await run<A[]>('attention', {}, opts), opts.json, (list) => columns(list.map((a) => [a.level, a.taskId, a.runId ?? '', local(a.at), a.problem]), 'nothing needs attention'));
    });
  app(attention, 'clear [taskId]', "clear what Needs Attention, or only a task's")
    .action((taskId: string | undefined, opts: Opts) => act('attention-clear', taskId ? { taskId } : {}, opts));

  app(program, 'clear-runs <taskId>', "delete a task's run history")
    .action((taskId: string, opts: Opts) => act('clear-runs', { taskId }, opts));

  app(program, 'versions <taskId>', "list a task's versions")
    .option('--json', 'print JSON')
    .action(async (taskId: string, opts: Opts) => {
      type V = { n: number; ts: string; source: string; changed: string[] };
      show(await run<V[]>('versions', { taskId }, opts), opts.json, (list) => columns(list.map((v) => [String(v.n), local(v.ts), v.source, v.changed.join(', ')]), 'no versions'));
    });
  app(program, 'version <taskId> <n>', "print a version of a task, or with --diff what changed since")
    .option('--diff', 'its differences from the current task')
    .option('--json', 'print JSON')
    .action(async (taskId: string, n: string, opts: Opts & { diff?: boolean }) => {
      type D = { task: unknown; diff?: { field?: string; path?: string; a?: unknown; b?: unknown }[] };
      show(await run<D>('version', { taskId, n: Number(n), ...(opts.diff ? { diff: true } : {}) }, opts), opts.json, (d) =>
        JSON.stringify(opts.diff ? (d.diff ?? []) : d.task, null, 2),
      );
    });
  app(program, 'rollback <taskId> <n>', 'put a version of a task back (itself a new version)')
    .action((taskId: string, n: string, opts: Opts) => act('rollback', { taskId, n: Number(n) }, opts));

  type F = { id: string; name: string; parentId?: string };
  const listFolders = (list: F[]) => columns(list.map((f) => [f.id, f.name, f.parentId ? `in ${list.find((x) => x.id === f.parentId)?.name ?? f.parentId}` : '']), 'no folders');
  const folders = app(program, 'folders', "list the Tasks tab's folders")
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => show(await run<F[]>('folders', {}, opts), opts.json, listFolders));
  app(folders, 'add <name>', 'add a task folder')
    .option('--parent <folder>', 'inside this folder (its id or name)')
    .action((name: string, opts: Opts & { parent?: string }) => act('folder-add', { name, ...(opts.parent ? { parent: opts.parent } : {}) }, opts));
  app(folders, 'rename <folder> <name...>', 'rename a task folder (its id or name)')
    .action((folder: string, words: string[], opts: Opts) => act('folder-rename', { folder, name: words.join(' ') }, opts));
  app(folders, 'remove <folder>', 'delete a task folder; its tasks move to the top level')
    .action((folder: string, opts: Opts) => act('folder-remove', { folder }, opts));
  app(program, 'move <taskId>', 'move a task to a folder, or to the top level without --folder')
    .option('--folder <folder>', 'the folder (its id or name)')
    .action((taskId: string, opts: Opts & { folder?: string }) => act('move', { taskId, ...(opts.folder ? { folder: opts.folder } : {}) }, opts));

  const bin = app(program, 'bin', 'list the tasks in the Recycle Bin')
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => {
      type B = { id: string; name: string; deletedAt: string };
      show(await run<B[]>('bin', {}, opts), opts.json, (list) => columns(list.map((b) => [b.id, local(b.deletedAt), b.name]), 'the Recycle Bin is empty'));
    });
  app(bin, 'restore <taskId>', 'put a deleted task back').action((taskId: string, opts: Opts) => act('restore', { taskId }, opts));
  app(bin, 'purge <taskId>', 'delete a task in the Recycle Bin for good, with its run history').action((taskId: string, opts: Opts) => act('purge', { taskId }, opts));
  app(bin, 'empty', 'delete every task in the Recycle Bin for good').action((opts: Opts) => act('empty-bin', {}, opts));

  app(program, 'path <id>', "print the working directory of a task, project, run, chat or terminal session")
    .option('--run-dir', "the run's own folder in Looper's data instead")
    .action((id: string, opts: Opts & { runDir?: boolean }) => act('path', { id, ...(opts.runDir ? { runDir: true } : {}) }, opts));

  const build = gated(ctx, program, 'build', 'standard').description(
    'the task builder (New Task with Agent, Edit with Agent): an agent that writes a task from a description; looper send answers it and looper transcript shows what it said',
  );
  app(build, 'start <description...>', "start a task builder with the description as its first message and print its id; the desktop app also opens its window")
    .option('--task <taskId>', 'edit this task (with the builder already open on it, if any)')
    .option('--project <projectId>', "build a new task in this project's folder, environment and agent settings")
    .action((words: string[], opts: Opts & { task?: string; project?: string }) =>
      act('build-start', { description: words.join(' '), ...(opts.task ? { taskId: opts.task } : {}), ...(opts.project ? { projectId: opts.project } : {}) }, opts),
    );
  app(build, 'draft <id>', "print whether the builder's agent is working, its draft task, and what keeps the draft from being saved")
    .option('--json', 'print JSON')
    .action(async (id: string, opts: Opts) => {
      type D = { status: string; error?: string; unsaved: boolean; problems: string[]; changed: string[]; draft: unknown };
      show(await run<D>('build-draft', { id }, opts), opts.json, (d) =>
        [
          `agent: ${d.status}${d.error ? ` (${d.error})` : ''}`,
          d.unsaved ? 'not saved' : 'saved',
          ...(d.problems.length ? ["can't be saved yet:", ...d.problems.map((x) => `  - ${x}`)] : []),
          ...(d.changed.length ? [`changed: ${d.changed.join(', ')}`] : []),
          '',
          d.draft ? JSON.stringify(d.draft, null, 2) : 'no draft yet',
        ].join('\n'),
      );
    });
  app(build, 'save <id>', "store the builder's draft as the task (Save), and print the task's id").action((id: string, opts: Opts) => act('build-save', { id }, opts));
  app(build, 'close <id>', 'stop the builder and delete its files; refused while it has changes that aren\'t saved, unless --discard')
    .option('--discard', "drop the changes that aren't saved and put back the files it changed (Don't Save)")
    .action((id: string, opts: Opts & { discard?: boolean }) => act('build-close', { id, ...(opts.discard ? { discard: true } : {}) }, opts));

  // ---------- templates and projects ----------

  const templates = app(program, 'templates', 'list the templates')
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => {
      show(await run<{ id: string; name: string }[]>('templates', {}, opts), opts.json, (list) => columns(list.map((t) => [t.id, t.name]), 'no templates'));
    });
  app(templates, 'show <id>', 'print a template as JSON').action(async (id: string, opts: Opts) => show(await run('template', { id }, opts), true));
  app(templates, 'import <file>', 'add a template from a JSON or .loopertpl file ("-" reads stdin)')
    .action(async (file: string, opts: Opts) => {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file === '-' ? 0 : file, 'utf8'));
      } catch {
        console.error(`cannot read a JSON object from ${file === '-' ? 'stdin' : file}`);
        process.exit(2);
      }
      const doc = raw as { $type?: unknown; payload?: unknown };
      await act('template-import', { template: doc && doc.$type === 'looper/template' ? doc.payload : raw }, opts);
    });
  app(templates, 'remove <id>', 'delete a template').action((id: string, opts: Opts) => act('template-remove', { id }, opts));

  const projects = app(program, 'projects', 'list the projects and their folders')
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => {
      type P = { projects: { id: string; name: string; cwd: string; environmentId: string; folderId?: string }[]; folders: F[] };
      show(await run<P>('projects', {}, opts), opts.json, (p) =>
        columns(p.projects.map((x) => [x.id, x.name, x.environmentId, x.cwd, x.folderId ? `in ${p.folders.find((f) => f.id === x.folderId)?.name ?? x.folderId}` : '']), 'no projects'),
      );
    });
  app(projects, 'remove <id>', 'delete a project (its folder and files stay); refused while tasks belong to it').action((id: string, opts: Opts) => act('project-remove', { id }, opts));
  app(projects, 'move <id>', 'move a project to a project folder, or to the top level without --folder')
    .option('--folder <folder>', 'the project folder (its id or name)')
    .action((id: string, opts: Opts & { folder?: string }) => act('project-move', { id, ...(opts.folder ? { folder: opts.folder } : {}) }, opts));
  type ProjectOpts = Opts & { name?: string; env?: string; harness?: string; model?: string; effort?: string; permissionMode?: string; mode?: string; folder?: string };
  const projectOpts = (c: Command) =>
    c
      .option('--name <name>', 'its name (default: the folder\'s)')
      .option('--env <environmentId>', 'its environment (default: the default environment)')
      .option('--harness <harnessId>', "its harness (default: the environment's first)")
      .option('--model <model>', 'the model its chats and tasks use')
      .option('--effort <effort>', 'the effort its chats and tasks use')
      .option('--permission-mode <mode>', 'the permission mode its chats and tasks use')
      .option('--mode <mode>', 'interactive or headless');
  const projectFields = (o: ProjectOpts) => ({
    ...(o.folder ? { cwd: envFolder(o.folder) } : {}),
    ...(o.name ? { name: o.name } : {}),
    ...(o.env ? { environmentId: o.env } : {}),
    ...(o.harness ? { harnessId: o.harness } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.effort ? { effort: o.effort } : {}),
    ...(o.permissionMode !== undefined ? { permissionMode: o.permissionMode } : {}),
    ...(o.mode ? { mode: o.mode } : {}),
  });
  projectOpts(app(projects, 'add <folder>', "add a project; the folder as its environment sees it", 'extended')).action((folder: string, opts: ProjectOpts) =>
    act('project-save', { project: projectFields({ ...opts, folder }) }, opts),
  );
  projectOpts(app(projects, 'edit <id>', "change a project's settings", 'extended'))
    .option('--folder <folder>', 'its folder, as its environment sees it')
    .action((id: string, opts: ProjectOpts) => act('project-save', { id, project: projectFields(opts) }, opts));
  const projectFolders = app(program, 'project-folders', "list the Projects tab's folders")
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => show((await run<{ folders: F[] }>('projects', {}, opts)).folders, opts.json, listFolders));
  app(projectFolders, 'add <name>', 'add a project folder')
    .option('--parent <folder>', 'inside this folder (its id or name)')
    .action((name: string, opts: Opts & { parent?: string }) => act('project-folder-add', { name, ...(opts.parent ? { parent: opts.parent } : {}) }, opts));
  app(projectFolders, 'rename <folder> <name...>', 'rename a project folder (its id or name)')
    .action((folder: string, words: string[], opts: Opts) => act('project-folder-rename', { folder, name: words.join(' ') }, opts));
  app(projectFolders, 'remove <folder>', 'delete a project folder; its folders and projects move up')
    .action((folder: string, opts: Opts) => act('project-folder-remove', { folder }, opts));

  // ---------- harnesses, settings and logins ----------

  app(program, 'models <harnessId>', 'list the models a harness offers')
    .option('--env <environmentId>', "the harness's environment, when several have a harness with this id")
    .option('--json', 'print JSON')
    .action(async (harnessId: string, opts: Opts & { env?: string }) => {
      type M = { id: string; name: string; main: boolean };
      show(await run<M[]>('models', { harnessId, ...(opts.env ? { environmentId: opts.env } : {}) }, opts), opts.json, (list) =>
        columns(list.map((m) => [m.id, m.name, m.main ? 'main' : '']), 'no models'),
      );
    });

  app(program, 'settings [key]', 'print the settings, or one of them by its dotted key (such as chats.confirmClose), as JSON')
    .action(async (key: string | undefined, opts: Opts) => show(await run('settings', key ? { key } : {}, opts), true));
  app(program, 'settings-set <key> <json>', 'change one setting by its dotted key; the value is JSON, such as true or "text"', 'unrestricted').action(
    (key: string, json: string, opts: Opts) => {
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch {
        console.error(`the value must be JSON (text goes in double quotes), got ${json}`);
        process.exit(2);
      }
      return act('settings-set', { key, value }, opts);
    },
  );
  app(program, 'store-move <store> <file>', 'move the tasks or templates file (Settings → Advanced)', 'unrestricted').action((store: string, file: string, opts: Opts) =>
    act('store-move', { store, file: ctx.appPath(path.resolve(file)) }, opts),
  );

  // Extended: the environments and harnesses decide what every agent runs, and with what.
  const environments = program.commands.find((c) => c.name() === 'environments');
  if (environments) {
    app(environments, 'add <file>', 'add an environment from a JSON file of its fields ("-" reads stdin); prints its id', 'extended').action((file: string, opts: Opts) =>
      act('environment-save', { environment: jsonObject(file) }, opts),
    );
    app(environments, 'edit <id> <file>', "change an environment: the file's fields replace its own", 'extended').action((id: string, file: string, opts: Opts) =>
      act('environment-save', { id, environment: jsonObject(file) }, opts),
    );
    app(environments, 'remove <id>', 'remove an environment (not the last one)', 'extended').action((id: string, opts: Opts) => act('environment-remove', { id }, opts));
  }
  const harnesses = gated(ctx, program, 'harnesses', 'extended').description("add, change or remove an environment's harnesses");
  app(harnesses, 'add <environmentId> <file>', 'add a harness from a JSON file of its fields ("-" reads stdin); prints its id', 'extended').action(
    (environmentId: string, file: string, opts: Opts) => act('harness-save', { environmentId, harness: jsonObject(file) }, opts),
  );
  app(harnesses, 'edit <environmentId> <id> <file>', "change a harness: the file's fields replace its own", 'extended').action(
    (environmentId: string, id: string, file: string, opts: Opts) => act('harness-save', { environmentId, id, harness: jsonObject(file) }, opts),
  );
  app(harnesses, 'remove <environmentId> <id>', "remove a harness (not its environment's last one)", 'extended').action((environmentId: string, id: string, opts: Opts) =>
    act('harness-remove', { environmentId, id }, opts),
  );

  app(program, 'logins', "list the Claude Code logins the harnesses use, and whether they're logged in")
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => {
      type L = { environmentId: string; name: string; loggedIn: boolean; expiresAt?: number };
      show(await run<L[]>('logins', {}, opts), opts.json, (list) =>
        columns(list.map((l) => [l.environmentId, l.name, l.loggedIn ? 'logged in' : 'logged out', l.expiresAt ? `until ${new Date(l.expiresAt).toLocaleString()}` : '']), 'no logins'),
      );
    });
  app(program, 'login <harnessId>', "open Log In for a harness on the desktop (Claude Code's auth login)")
    .option('--env <environmentId>', "the harness's environment, when several have a harness with this id")
    .action((harnessId: string, opts: Opts & { env?: string }) => act('login', { harnessId, ...(opts.env ? { environmentId: opts.env } : {}) }, opts));

  // ---------- history ----------

  const transcriptOpts = (c: Command) =>
    c
      .option('--agent <agentId>', "a subagent's conversation instead")
      .option('--no-thinking', 'leave out the thinking')
      .option('--no-tools', 'leave out the tool calls')
      .option('--plain', 'plain text instead of Markdown')
      .option('--json', 'print the rows as JSON');
  const history = app(program, 'history', "list the newest conversations: Looper's, and Claude Code's and Codex's from outside it; with --runs, the task runs (Task History)")
    .option('--search <text>', 'only the ones whose messages contain the text')
    .option('--project <id>', "only a project's")
    .option('--runs', 'list the task runs instead of the conversations')
    .option('--task <id>', "only a task's runs (implies --runs)")
    .option('--result <result>', 'only the runs that ended with it, such as success, error or noop (implies --runs)')
    .option('--hide-skipped', 'leave out the runs the scheduler skipped (with --runs)')
    .option('--hide-no-action', 'leave out the runs whose check found nothing to do (with --runs)')
    .option('-n, --limit <n>', 'how many to look through', '50')
    .option('--json', 'print JSON')
    .action(async (opts: Opts & { search?: string; project?: string; runs?: boolean; task?: string; result?: string; hideSkipped?: boolean; hideNoAction?: boolean; limit: string }) => {
      type H = { id: string; title: string; folder: string; lastActive: string; result?: string };
      const params = {
        limit: Number(opts.limit),
        ...(opts.search ? { search: opts.search } : {}),
        ...(opts.project ? { project: opts.project } : {}),
        ...(opts.runs ? { runs: true } : {}),
        ...(opts.task ? { task: opts.task } : {}),
        ...(opts.result ? { result: opts.result } : {}),
        ...(opts.hideSkipped ? { hideSkipped: true } : {}),
        ...(opts.hideNoAction ? { hideNoAction: true } : {}),
      };
      const runs = opts.runs || opts.task || opts.result;
      show(await run<H[]>('history', params, opts), opts.json, (list) =>
        columns(list.map((h) => [h.id, local(h.lastActive), ...(runs ? [h.result ?? ''] : []), h.folder, h.title]), runs ? 'no runs' : 'no conversations'),
      );
    });
  transcriptOpts(app(history, 'show <id>', 'print a conversation from the history as Markdown')).action(
    async (id: string, opts: Opts & { agent?: string; thinking: boolean; tools: boolean; plain?: boolean }) =>
      printTranscript(await run<Transcript>('history-show', { id, ...(opts.agent ? { agentId: opts.agent } : {}) }, opts), opts),
  );
  app(history, 'continue <id>', 'continue a conversation from the history in a chat; prints the chat\'s id')
    .option('--compact', 'in a new chat that starts from its messages, without its tool calls')
    .option('--terminal', 'in a terminal session (Unrestricted)')
    .action((id: string, opts: Opts & { compact?: boolean; terminal?: boolean }) =>
      act('history-continue', { id, ...(opts.compact ? { compact: true } : {}), ...(opts.terminal ? { terminal: true } : {}) }, opts),
    );

  // ---------- the desktop app ----------

  app(program, 'open <id>', 'show a chat, terminal session, task or run on the desktop').action((id: string, opts: Opts) => act('open', { id }, opts));

  const remote = app(program, 'remote', 'list the Remote Control conversations')
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => {
      type R = { running: boolean; conversations: { id: string; status: string; name: string; title?: string; cwd: string }[] };
      show(await run<R>('remote', {}, opts), opts.json, (r) =>
        (r.running ? '' : 'Remote Control is off\n') + columns(r.conversations.map((c) => [c.id, c.status, c.name, c.title ?? '', c.cwd]), 'no conversations'),
      );
    });
  app(remote, 'stop <id>', 'end a Remote Control conversation').action((id: string, opts: Opts) => act('remote-stop', { id }, opts));
  app(remote, 'restart <id>', 'continue a Remote Control conversation in a new session').action((id: string, opts: Opts) => act('remote-restart', { id }, opts));

  app(program, 'rest [onOrOff]', 'turn Rest Mode on or off, or print its state')
    .option('--json', 'print JSON')
    .action(async (onOrOff: string | undefined, opts: Opts) => {
      if (onOrOff !== undefined && onOrOff !== 'on' && onOrOff !== 'off') {
        console.error('give on or off');
        process.exit(2);
      }
      type R = { armed: boolean; phase: string; sleepAt: number | null; wakeAt: number | null };
      show(await run<R | string>('rest', onOrOff ? { on: onOrOff === 'on' } : {}, opts), opts.json, (r) => {
        const s = r as R;
        return `Rest Mode is ${s.armed ? 'on' : 'off'} (${s.phase})${s.sleepAt ? `; sleeps at ${new Date(s.sleepAt).toLocaleString()}` : ''}${s.wakeAt ? `; wakes at ${new Date(s.wakeAt).toLocaleString()}` : ''}`;
      });
    });
  app(program, 'prevent-sleep [timer]', 'keep the computer awake for 30, 60 or 120 min, or until-off; off turns it off; no timer prints its state')
    .option('--json', 'print JSON')
    .action(async (timer: string | undefined, opts: Opts) => {
      const value = timer === undefined ? undefined : /^\d+$/.test(timer) ? Number(timer) : timer;
      type S = { timer: string | number; until: number | null; active: boolean };
      show(await run<S | string>('prevent-sleep', value === undefined ? {} : { timer: value }, opts), opts.json, (s) => {
        const st = s as S;
        return st.active ? `Prevent Sleep is on${st.until ? ` until ${new Date(st.until).toLocaleString()}` : ' until you turn it off'}` : 'Prevent Sleep is off';
      });
    });

  type Addon = { id: string; name: string; version: string; enabled: boolean; status: string; error?: string };
  const addons = app(program, 'addons', 'list the installed addons')
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => {
      show(await run<Addon[]>('addons', {}, opts), opts.json, (list) =>
        columns(list.map((a) => [a.id, a.version, a.enabled ? a.status : 'off', a.name + (a.error ? ` (${a.error})` : '')]), 'no addons'),
      );
    });
  app(addons, 'install <file>', 'install a .looperaddon file, once you agree in the dialog the desktop shows')
    .action((file: string, opts: Opts) => act('addons-install', { file: ctx.appPath(path.resolve(file)) }, opts));
  app(addons, 'disable <id>', 'turn an addon off').action((id: string, opts: Opts) => act('addons-disable', { id }, opts));
  app(addons, 'enable <id>', 'turn an addon on', 'extended').action((id: string, opts: Opts) => act('addons-enable', { id }, opts));
  app(addons, 'restart <id>', 'restart an addon').action((id: string, opts: Opts) => act('addons-restart', { id }, opts));
  app(addons, 'remove <id>', 'remove an addon').action((id: string, opts: Opts) => act('addons-remove', { id }, opts));

  const devices = app(program, 'devices', 'list the devices paired with Remote Access')
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => {
      type D = { id: string; name: string; pairedAt: string; lastSeenAt?: string; connected: number };
      show(await run<D[]>('devices', {}, opts), opts.json, (list) =>
        columns(list.map((d) => [d.id, d.name, d.connected ? 'connected' : d.lastSeenAt ? `last seen ${local(d.lastSeenAt)}` : `paired ${local(d.pairedAt)}`]), 'no paired devices'),
      );
    });
  app(devices, 'rename <id> <name...>', 'rename a paired device').action((id: string, words: string[], opts: Opts) => act('devices-rename', { id, name: words.join(' ') }, opts));
  app(devices, 'remove <id>', 'unpair a device').action((id: string, opts: Opts) => act('devices-remove', { id }, opts));
  app(devices, 'notify <id>', 'choose what a paired device is notified of; with no option, print it')
    .option('--turns <onOrOff>', 'chat turn ends')
    .option('--questions <onOrOff>', 'questions and permission requests')
    .option('--runs <onOrOff>', "task runs (each task's own notification settings still apply)")
    .option('--warnings <onOrOff>', 'login and usage warnings')
    .action((id: string, opts: Opts & Partial<Record<'turns' | 'questions' | 'runs' | 'warnings', string>>) => {
      const notify: Record<string, boolean> = {};
      for (const key of ['turns', 'questions', 'runs', 'warnings'] as const) {
        const v = opts[key];
        if (v === undefined) continue;
        if (v !== 'on' && v !== 'off') {
          console.error(`--${key}: give on or off`);
          process.exit(2);
        }
        notify[key] = v === 'on';
      }
      return act('devices-notify', { id, notify }, opts);
    });
  app(devices, 'pair', 'print a code to pair a new device with Remote Access', 'extended')
    .option('--json', 'print JSON')
    .action(async (opts: Opts) => {
      show(await run<{ code: string; expiresAt: number }>('devices-pair', {}, opts), opts.json, (c) => `${c.code}\nEnter it on the device before ${new Date(c.expiresAt).toLocaleTimeString()}.`);
    });
}
