import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { defaultDataDir } from '../engine/host';
import { formatDuration } from '../shared/duration';
import { EXAMPLE_CHECK_SCRIPT, EXAMPLE_TASK } from '../shared/example-task';
import type { InboxCommand, RunRecord, TaskRuntime } from '../shared/types';
import { slugify, validateTask } from '../shared/validate';

const program = new Command();
program
  .name('looper')
  .description('Cron-style manager for AI agent loops')
  .option('--data-dir <dir>', 'looper data directory (default: LOOPER_HOME or the platform config dir)');

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
  });

program
  .command('add <file>')
  .description('register (or update) a task from a JSON file')
  .action((file: string) => {
    const raw = readJsonFile<Record<string, unknown> | null>(file, null);
    if (!raw) {
      console.error(`cannot read JSON from ${file}`);
      process.exit(2);
    }
    if (!raw.id && typeof raw.name === 'string') raw.id = slugify(raw.name);
    const v = validateTask(raw);
    if (!v.ok) {
      console.error('invalid task:');
      for (const e of v.errors) console.error('  - ' + e);
      process.exit(1);
    }
    const dest = dropInbox(v.task, `task-${v.task.id}`);
    console.log(`queued task ${v.task.id} -> ${dest}`);
  });

program
  .command('list')
  .description('list tasks and their current state')
  .action(() => {
    const dir = dataDir();
    const tasks = readJsonFile<{ tasks: { id: string; name: string; enabled: boolean }[] }>(
      path.join(dir, 'tasks.json'),
      { tasks: [] },
    ).tasks;
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
      const st = rt?.state ?? (t.enabled ? 'idle' : 'disabled');
      const next = rt?.nextRunAt ? `next in ${formatDuration(Math.max(0, rt.nextRunAt - now))}` : '';
      const last = rt?.lastResult ? `last: ${rt.lastResult}` : '';
      console.log(`${t.id.padEnd(24)} ${st.padEnd(11)} ${next.padEnd(16)} ${last}`);
    }
  });

program.command('run <taskId>').description('run a task now').option('--reason <r>').action(command('run'));
program.command('pause <taskId>').description('pause a task').option('--reason <r>').action(command('pause'));
program.command('resume <taskId>').description('resume a paused task').option('--reason <r>').action(command('resume'));
program.command('stop <taskId>').description('stop the running agent').option('--reason <r>').action(command('stop'));
program.command('remove <taskId>').description('remove a task').option('--reason <r>').action(command('remove'));
program.command('enable <taskId>').description('enable a task').option('--reason <r>').action(command('enable'));
program.command('disable <taskId>').description('disable a task').option('--reason <r>').action(command('disable'));

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
  .action(async (opts: { quiet?: boolean }) => {
    const { createEngine } = await import('../engine/engine');
    const engine = createEngine({ dataDir: dataDir(), echoLog: true });
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
      console.log('\nstopping…');
      await engine.stop();
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
