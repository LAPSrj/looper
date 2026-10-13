import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { defaultDataDir } from '../engine/host';
import { formatDuration } from '../shared/duration';
import { EXAMPLE_CHECK_SCRIPT, EXAMPLE_TASK } from '../shared/example-task';
import { FILE_KINDS, readLooperFile, wrapLooperFile } from '../shared/files';
import { DEFINITION_VERSION, migrateDefinition } from '../shared/migrate';
import { taskSchemaDoc } from '../shared/schema-doc';
import { SettingsSchema, type Environment, type InboxCommand, type RunRecord, type TaskRuntime } from '../shared/types';
import { importTaskDraft, slugify, validateTask } from '../shared/validate';
import { waitForInbox } from './inbox-wait';

const program = new Command();
program
  .name('looper')
  .description('Cron-style manager for AI agent loops')
  .option('--data-dir <dir>', 'looper data directory (default: LOOPER_HOME or ~/looper)')
  .addHelpText('before', 'Agents automating Looper: run `looper agents` for the task-authoring guide.\n');

function dataDir(): string {
  const opt = program.opts<{ dataDir?: string }>().dataDir;
  return opt ?? defaultDataDir();
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function dropInbox(obj: unknown, prefix: string): string {
  const dir = path.join(dataDir(), 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  const tmp = path.join(dir, name + '.tmp');
  const final = path.join(dir, name);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, final); // rename so the engine never sees a half-written file
  return final;
}

/** The tasks the app has stored. Settings → Advanced → Tasks file can keep them outside the data dir, as the engine reads them. */
function readTasks(): { id: string; name: string; enabled: boolean; completedAt?: string; [field: string]: unknown }[] {
  const dir = dataDir();
  const custom = readJsonFile<{ tasksFile?: unknown } | null>(path.join(dir, 'settings.json'), null)?.tasksFile;
  const tasksFile = typeof custom === 'string' && custom ? custom : path.join(dir, 'tasks.json');
  if (tasksFile !== path.join(dir, 'tasks.json') && !fs.existsSync(tasksFile)) {
    console.error(`cannot read the tasks file set in Settings: ${tasksFile}`);
    process.exit(2);
  }
  return readJsonFile<{ tasks: ReturnType<typeof readTasks> }>(tasksFile, {
    tasks: [],
  }).tasks;
}

function command(op: InboxCommand['op']) {
  return (taskId: string, opts: { reason?: string }) => {
    const file = dropInbox({ op, taskId, reason: opts.reason } satisfies InboxCommand, op);
    console.log(`queued ${op} ${taskId} -> ${file}`);
  };
}

program
  .command('home')
  .description('print the data directory')
  .action(() => console.log(dataDir()));

program
  .command('example')
  .description('print an example task definition (and check script with --script)')
  .option('--script', 'print an example check script instead')
  .action((opts: { script?: boolean }) => {
    if (opts.script) process.stdout.write(EXAMPLE_CHECK_SCRIPT);
    else console.log(JSON.stringify(EXAMPLE_TASK, null, 2));
    console.error('\nSee docs/tasks.md for a full field reference and guide.');
  });

/**
 * The settings of the app this data dir belongs to, so environment/harness
 * references are checked here instead of bouncing off the engine. Unreadable
 * or unparseable settings just skip those checks — the running app
 * re-validates anyway. The host is deliberately not passed to validateTask:
 * the CLI may run on a different OS than the app (WSL against Windows), so
 * a `local` environment's path style is undecidable here.
 */
function targetSettings(): { environments: Environment[]; defaultEnvironmentId: string } | undefined {
  const raw = readJsonFile<unknown>(path.join(dataDir(), 'settings.json'), null);
  if (!raw) return undefined;
  const s = SettingsSchema.safeParse(raw);
  return s.success ? { environments: s.data.environments, defaultEnvironmentId: s.data.defaultEnvironmentId } : undefined;
}

/**
 * Read a task definition: plain JSON, or a .loopertask (envelope stripped),
 * from a file or, for "-", from stdin. Exits on unreadable input.
 */
function readDefinition(file: string): Record<string, unknown> {
  let raw: Record<string, unknown> | null = null;
  if (file === '-') {
    try {
      raw = JSON.parse(fs.readFileSync(0, 'utf8')) as Record<string, unknown>;
    } catch {
      /* reported below */
    }
  } else {
    raw = readJsonFile<Record<string, unknown> | null>(file, null);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.error(`cannot read a JSON object from ${file === '-' ? 'stdin' : file}`);
    process.exit(2);
  }
  let def = raw;
  if ('$type' in raw) {
    const doc = readLooperFile(raw);
    if (!doc.ok) {
      console.error(
        doc.reason === 'newer'
          ? `written by a newer Looper (${doc.app ?? 'unknown version'}) — update Looper to read it`
          : `not a Looper task document: ${file}`,
      );
      process.exit(2);
    }
    if (doc.kind !== 'task') {
      console.error(`not a task document (a ${doc.kind}): ${file}`);
      process.exit(2);
    }
    def = doc.payload;
  }
  if (!def.id && typeof def.name === 'string') def.id = slugify(def.name);
  return def;
}

/** Version stamped as $app into written .loopertask files. */
function cliVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Dotted paths whose original value the import heuristics changed or dropped.
 * Fields the author never set are ignored: filling a default is not a fix.
 */
function changedPaths(before: unknown, after: unknown, prefix: string, out: string[]): void {
  if (before === undefined) return;
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (isObj(before) && isObj(after)) {
    for (const key of Object.keys(before)) {
      changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out.push(prefix || 'task');
}

const AGENTS_GUIDE = `Task-authoring guide for agents

Read first:
  looper schema              the field reference as JSON: every task field with its type,
                             default and allowed values, and the permission modes per
                             harness kind (includes the environments block below when
                             this data dir's settings.json is readable)
  looper environments        just the configured environment and harness ids — what
                             environmentId / harnessId must name
  looper example             a complete example task definition (every field, valid values)
  looper example --script    an example check script (the check-output contract)

Then:
  1. write <task>.json       "id" may be omitted: "name" is slugified into one
  2. looper validate <file>  check it; errors block (exit 1), while references to
                             environments/harnesses this setup lacks are only warnings here;
                             writes <id>.loopertask next to the file (or into --out <dir>)
  3. looper add <file>       validate strictly (references included), queue the task in the
                             running app's inbox, and wait until the app has stored it
                             (--timeout <s>, default 30); refuses an id that already exists
     looper add --update     update the existing task with that id instead (refuses a new id)
     looper add --fix        first replace invalid values with defaults (the .loopertask
                             import heuristics); each change is printed as "fixed: <path>"
  To change a stored task: looper export <id> --out <dir>, edit the file, looper add --update.

Notes:
  - add and validate accept plain JSON or a .loopertask document; "-" as the file reads
    it from stdin, e.g. looper add - <<'EOF' … EOF
  - Exit codes: 0 ok; 1 invalid task, id conflict, or rejected by the app; 2 unreadable
    input or missing settings; 3 (add only) queued, but no running app picked it up.
  - Results go to stdout; errors, warnings and fixes go to stderr.
  - Point LOOPER_HOME (or --data-dir) at the data dir of the Looper app that should run
    the task.
  - Older task files/stores are migrated to the current format automatically on read;
    "looper migrate <file>" rewrites them in place.

Full documentation: docs/tasks.md (field guide), docs/cli-and-automation.md (CLI and inbox).`;

program
  .command('agents')
  .description('print the task-authoring guide for agents: what to read, then how to validate and register')
  .action(() => {
    console.log(AGENTS_GUIDE);
  });

/** This setup's configured ids — what environmentId / harnessId must name. */
function configuredIds(settings: NonNullable<ReturnType<typeof targetSettings>>): object {
  return {
    defaultEnvironmentId: settings.defaultEnvironmentId,
    environments: settings.environments.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      harnesses: e.harnesses.map((h) => ({ id: h.id, name: h.name, kind: h.kind })),
    })),
  };
}

program
  .command('environments')
  .description('print the configured environment and harness ids (what environmentId / harnessId must name)')
  .action(() => {
    const settings = targetSettings();
    if (!settings) {
      console.error(`cannot read settings.json in ${dataDir()}`);
      process.exit(2);
    }
    console.log(JSON.stringify(configuredIds(settings), null, 2));
  });

program
  .command('schema')
  .description('print the task JSON field reference (generated from the schema): field, type, default, allowed values')
  .action(() => {
    const settings = targetSettings();
    const doc = { ...taskSchemaDoc(), ...(settings && configuredIds(settings)) };
    console.log(JSON.stringify(doc, null, 2));
  });

program
  .command('add <file>')
  .description('register a new task from a JSON or .loopertask file ("-" reads stdin) and wait for the running app to store it')
  .option('--update', 'update the existing task with this id instead of creating a new one')
  .option('--fix', 'replace invalid values with defaults (the .loopertask import heuristics) instead of rejecting them')
  .option('--timeout <s>', 'seconds to wait for the running app to pick the task up', '30')
  .action(async (file: string, opts: { update?: boolean; fix?: boolean; timeout: string }) => {
    const timeoutSec = Number(opts.timeout);
    if (!(timeoutSec >= 0)) {
      console.error(`--timeout must be a number of seconds, got "${opts.timeout}"`);
      process.exit(2);
    }
    let def = readDefinition(file);
    const settings = targetSettings();
    const fixes: string[] = [];
    if (opts.fix) {
      if (!settings) {
        console.error(`--fix needs a readable settings.json in ${dataDir()}`);
        process.exit(2);
      }
      const draft = importTaskDraft(def, settings) as Record<string, unknown>;
      changedPaths(def, draft, '', fixes);
      def = draft;
    }
    const v = validateTask(def, settings?.environments);
    if (!v.ok) {
      console.error('invalid task:');
      for (const e of v.errors) console.error('  - ' + e);
      process.exit(1);
    }
    for (const f of fixes) console.error('fixed: ' + f);
    const id = v.task.id;
    const exists = readTasks().some((t) => t.id === id);
    if (exists && !opts.update) {
      console.error(`task ${id} already exists: pass --update to change it, or give the new task another id`);
      process.exit(1);
    }
    if (!exists && opts.update) {
      console.error(`no task ${id} to update: leave out --update to create it`);
      process.exit(1);
    }
    const dest = dropInbox(v.task, `task-${id}`);
    const outcome = await waitForInbox(dest, timeoutSec * 1000);
    if (outcome.status === 'rejected') {
      console.error(`rejected task ${id}: ${outcome.reason}`);
      process.exit(1);
    }
    if (outcome.status === 'pending') {
      console.error(
        `queued task ${id} -> ${dest}, but no running Looper app picked it up within ${timeoutSec}s; ` +
          'it is applied when the app starts, or delete the file to cancel',
      );
      process.exit(3);
    }
    if (outcome.status === 'vanished' || !readTasks().some((t) => t.id === id)) {
      console.error(`task ${id} left the inbox but isn't in the tasks file; check ${path.join(dataDir(), 'engine.log')}`);
      process.exit(1);
    }
    console.log(`${opts.update ? 'updated' : 'added'} task ${id}`);
  });

program
  .command('validate <file>')
  .description('validate a task JSON and write the .loopertask document next to it (or into --out <dir>)')
  .option('--out <dir>', 'directory to write the .loopertask into')
  .action((file: string, opts: { out?: string }) => {
    const def = readDefinition(file);
    // References to environments/harnesses this setup doesn't have are only
    // warnings here: the file may be written for another Looper setup.
    const v = validateTask(def, targetSettings()?.environments, undefined, { refWarnings: true });
    if (!v.ok) {
      console.error('invalid task:');
      for (const e of v.errors) console.error('  - ' + e);
      process.exit(1);
    }
    for (const w of v.warnings) console.error('warning: ' + w);
    const doc = wrapLooperFile('task', cliVersion(), v.task);
    const dest = path.join(opts.out ?? path.dirname(path.resolve(file)), `${v.task.id}.${FILE_KINDS.task.ext}`);
    fs.writeFileSync(dest, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log(`valid task ${v.task.id} -> ${dest}`);
  });

program
  .command('export <taskId>')
  .description('print a stored task as a .loopertask document, or write it with --out')
  .option('--out <path>', 'file to write, or a directory to write <id>.loopertask into')
  .action((taskId: string, opts: { out?: string }) => {
    const task = readTasks().find((t) => t.id === taskId);
    if (!task) {
      console.error(`no task ${taskId}`);
      process.exit(1);
    }
    const text = JSON.stringify(wrapLooperFile('task', cliVersion(), task), null, 2) + '\n';
    if (!opts.out) {
      process.stdout.write(text);
      return;
    }
    const isDir = fs.existsSync(opts.out) && fs.statSync(opts.out).isDirectory();
    const dest = isDir ? path.join(opts.out, `${taskId}.${FILE_KINDS.task.ext}`) : opts.out;
    fs.writeFileSync(dest, text, 'utf8');
    console.log(`exported task ${taskId} -> ${dest}`);
  });

/**
 * Migrate one file in place: a `.loopertask`/`.loopertpl` document, a
 * tasks.json/templates.json store, or a bare v1 task JSON (a `schedule` key,
 * no `trigger` key). Prints its own result line; never throws.
 */
function migrateOne(file: string): boolean {
  try {
    const raw = readJsonFile<Record<string, unknown> | null>(file, null);
    if (!raw) {
      console.error(`cannot read JSON from ${file}`);
      return false;
    }
    if ('$type' in raw) {
      const oldVersion = raw.$version;
      const doc = readLooperFile(raw);
      if (!doc.ok) {
        console.error(
          doc.reason === 'newer'
            ? `${file}: written by a newer Looper (${doc.app ?? 'unknown version'}) — update Looper to read it`
            : `${file}: not a Looper document`,
        );
        return false;
      }
      if (oldVersion === DEFINITION_VERSION) {
        console.log(`${file}: already v${DEFINITION_VERSION}`);
        return true;
      }
      const out = wrapLooperFile(doc.kind, cliVersion(), doc.payload);
      fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
      console.log(`${file}: migrated v${oldVersion} -> v${DEFINITION_VERSION}`);
      return true;
    }
    const entries = Array.isArray(raw.tasks)
      ? (raw.tasks as Record<string, unknown>[])
      : Array.isArray(raw.templates)
        ? (raw.templates as Record<string, unknown>[])
        : undefined;
    if (typeof raw.version === 'number' && entries) {
      const oldVersion = raw.version;
      if (oldVersion > DEFINITION_VERSION) {
        console.error(`${file}: written by a newer Looper (format v${oldVersion}; this build reads up to v${DEFINITION_VERSION})`);
        return false;
      }
      if (oldVersion === DEFINITION_VERSION) {
        console.log(`${file}: already v${DEFINITION_VERSION}`);
        return true;
      }
      const key = Array.isArray(raw.tasks) ? 'tasks' : 'templates';
      const migrated = entries.map((e) => migrateDefinition(e, oldVersion));
      const out = { ...raw, version: DEFINITION_VERSION, [key]: migrated };
      fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
      console.log(`${file}: migrated v${oldVersion} -> v${DEFINITION_VERSION} (${migrated.length} task(s))`);
      return true;
    }
    if (raw.schedule !== undefined && raw.trigger === undefined) {
      const out = migrateDefinition(raw, 1);
      fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
      console.log(`${file}: migrated v1 -> v${DEFINITION_VERSION}`);
      return true;
    }
    console.log(`${file}: already current (nothing to migrate)`);
    return true;
  } catch (e) {
    console.error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

program
  .command('migrate <file...>')
  .description('rewrite Looper files from an older format version to the current one (v2)')
  .action((files: string[]) => {
    let ok = true;
    for (const file of files) {
      if (!migrateOne(file)) ok = false;
    }
    process.exit(ok ? 0 : 2);
  });

program
  .command('list')
  .description('list tasks and their current state')
  .action(() => {
    const dir = dataDir();
    const tasks = readTasks();
    const state = readJsonFile<{ tasks: Record<string, TaskRuntime> }>(path.join(dir, 'state.json'), {
      tasks: {},
    }).tasks;
    if (!tasks.length) {
      console.log('no tasks');
      return;
    }
    const now = Date.now();
    for (const t of tasks) {
      const rt = state[t.id];
      const st = rt?.state ?? (t.completedAt ? 'completed' : t.enabled ? 'idle' : 'disabled');
      const next = rt?.nextRunAt ? `next in ${formatDuration(Math.max(0, rt.nextRunAt - now))}` : '';
      const last = rt?.lastResult ? `last: ${rt.lastResult}${rt.lastDetail ? ` (${rt.lastDetail})` : ''}` : '';
      console.log(`${t.id.padEnd(24)} ${st.padEnd(11)} ${next.padEnd(16)} ${last}`);
    }
  });

program.command('run <taskId>').description('run a task now').option('--reason <r>').action(command('run'));
program.command('pause <taskId>').description('pause a task').option('--reason <r>').action(command('pause'));
program.command('resume <taskId>').description('resume a paused task').option('--reason <r>').action(command('resume'));
program.command('stop <taskId>').description("stop the task's current run").option('--reason <r>').action(command('stop'));
program.command('remove <taskId>').description('remove a task').option('--reason <r>').action(command('remove'));
program.command('enable <taskId>').description('enable a task').option('--reason <r>').action(command('enable'));
program.command('disable <taskId>').description('disable a task').option('--reason <r>').action(command('disable'));
program
  .command('complete <taskId>')
  .description('finish a task for good: it stops being scheduled')
  .option('--reason <r>')
  .action(command('complete'));
program.command('reopen <taskId>').description('undo a completion').option('--reason <r>').action(command('reopen'));
program
  .command('guide <taskId> <text...>')
  .description("send guidance to the task's running agent; it gets the text mid-run")
  .option('--run <runId>', 'the run to send it to (default: the newest run in flight)')
  .action((taskId: string, words: string[], opts: { run?: string }) => {
    const file = dropInbox({ op: 'guide', taskId, runId: opts.run, text: words.join(' ') } satisfies InboxCommand, 'guide');
    console.log(`queued guide ${taskId} -> ${file}`);
  });

program
  .command('logs <taskId>')
  .description('show recent run records')
  .option('-n, --lines <n>', 'number of records', '30')
  .action((taskId: string, opts: { lines: string }) => {
    const file = path.join(dataDir(), 'tasks', taskId, 'runs.jsonl');
    let lines: string[];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      console.log('no runs yet');
      return;
    }
    for (const line of lines.slice(-Number(opts.lines))) {
      try {
        const r = JSON.parse(line) as RunRecord;
        const extra = r.error ?? r.summary ?? '';
        const dur = r.durationMs !== undefined ? ` (${formatDuration(r.durationMs)})` : '';
        console.log(`${r.ts}  ${r.runId}  ${r.phase.padEnd(8)} ${r.result.padEnd(12)}${dur} ${extra}`);
      } catch {
        /* torn line */
      }
    }
  });

program
  .command('done [message...]')
  .description('signal completion of the current agent run (needs LOOPER_DONE_FILE in env)')
  .action((message: string[]) => {
    const file = process.env.LOOPER_DONE_FILE;
    if (!file) {
      console.error('LOOPER_DONE_FILE is not set: not inside a looper agent run');
      process.exit(1);
    }
    fs.writeFileSync(file, (message.join(' ') || 'done') + '\n', 'utf8');
  });

program
  .command('serve')
  .description('run the engine headless in this terminal (no UI)')
  .option('--quiet', 'do not echo agent terminal output')
  .option('--take-over', 'when another Looper is running on this data dir, stop it and run here without asking')
  .action(async (opts: { quiet?: boolean; takeOver?: boolean }) => {
    const { createEngine } = await import('../engine/engine');
    const { describeHolder, EngineLock, liveHolder, TAKEOVER_WAIT_MS } = await import('../engine/lock');
    const holder = liveHolder(dataDir());
    if (holder) {
      const who = `Looper is already running on ${dataDir()}: ${describeHolder(holder)}.`;
      let takeOver = !!opts.takeOver;
      if (!takeOver && process.stdin.isTTY) {
        const readline = await import('node:readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`${who}\nRunning both would run every task twice. Take over (stops it and its runs)? [y/N] `);
        rl.close();
        takeOver = /^y(es)?$/i.test(answer.trim());
      }
      if (!takeOver) {
        console.error(process.stdin.isTTY ? 'not started' : `${who}\nPass --take-over to stop it and run here.`);
        process.exit(1);
      }
    }
    let stopping = false;
    let started: ReturnType<typeof createEngine> | null = null;
    const lock = new EngineLock(dataDir(), 'serve', (by) => {
      if (stopping) return;
      stopping = true;
      console.error(`\nanother Looper took over ${dataDir()}${by ? `: ${describeHolder(by)}` : ''}; stopping`);
      void (started?.stop() ?? Promise.resolve()).finally(() => process.exit(1));
    });
    lock.acquire();
    if (holder) {
      console.log('waiting for the other Looper to stop…');
      await new Promise((r) => setTimeout(r, TAKEOVER_WAIT_MS));
      if (stopping) return;
    }
    const engine = createEngine({ dataDir: dataDir(), echoLog: true });
    started = engine;
    engine.on((e) => {
      if (e.type === 'record') {
        const r = e.record;
        console.log(`[run] ${r.taskId} ${r.runId} ${r.phase} ${r.result} ${r.error ?? r.summary ?? ''}`);
      } else if (e.type === 'runtime') {
        console.log(`[state] ${e.runtime.taskId} -> ${e.runtime.state}${e.runtime.held ? ' (held)' : ''}`);
      } else if (e.type === 'agent:data' && !opts.quiet) {
        process.stdout.write(e.data);
      }
    });
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      console.log('\nstopping…');
      await engine.stop();
      lock.release();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (err) => engine.log.error(`uncaught: ${err.stack ?? err.message}`));
    process.on('unhandledRejection', (err) => engine.log.error(`unhandled: ${String(err)}`));
    engine.start();
    console.log(`looper serving from ${engine.dataDir} (inbox: ${engine.inboxDir()})`);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
