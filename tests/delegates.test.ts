import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath, delegateTask, parseDelegateArgs, resultEntry } from '../src/engine/delegates';
import { DELEGATE_FILE, queueDelegateMessage, takeDelegateMessages } from '../src/engine/guidance';
import { Logger } from '../src/engine/log';
import { Scheduler } from '../src/engine/scheduler';
import type { AgentCallbacks, AgentEnd, AgentHandle } from '../src/engine/steps/agent';
import { systemFooter } from '../src/engine/steps/agent';
import { DELEGATE_BUSY_FILE, DELEGATE_DIR, type RunContext } from '../src/engine/steps/common';
import { RunStore } from '../src/engine/store/runs';
import { StateStore } from '../src/engine/store/state';
import { TaskStore } from '../src/engine/store/tasks';
import { createTarget } from '../src/engine/target';
import { DELEGATE_BUSY_VAR } from '../src/engine/target/stop-hook';
import { delegateMessage, delegateText, guidanceMessage, guidanceText } from '../src/shared/messages';
import { groupRuns } from '../src/shared/runs';
import { ProjectSchema, SettingsSchema, TaskSchema, type EngineEvent, type RunRecord, type TaskInput } from '../src/shared/types';

describe('parseDelegateArgs', () => {
  it('reads a start with its options in either form', () => {
    expect(parseDelegateArgs(['start', '../site', '--title', 'Fix the form', '--brief-file=b.md', '--model', 'opus'])).toEqual({
      op: 'start',
      start: { folder: '../site', title: 'Fix the form', briefFile: 'b.md', model: 'opus' },
    });
  });

  it('refuses a start without its title, brief or folder, or with an unknown option', () => {
    expect(parseDelegateArgs(['start', 'x', '--brief-file', 'b.md'])).toEqual({ error: 'start needs --title' });
    expect(parseDelegateArgs(['start', 'x', '--title', 't'])).toEqual({ error: 'start needs --brief-file' });
    expect(parseDelegateArgs(['start', '--title', 't', '--brief-file', 'b'])).toEqual({ error: 'start needs the folder the agent works in' });
    expect(parseDelegateArgs(['start', 'x', '--prompt', 'p'])).toEqual({ error: 'start has no option --prompt' });
    expect(parseDelegateArgs(['start', 'x', 'y', '--title', 't', '--brief-file', 'b'])).toHaveProperty('error');
    expect(parseDelegateArgs(['start', 'x', '--title'])).toEqual({ error: '--title needs a value' });
  });

  it('keeps the line breaks of tell, and reads list and stop', () => {
    expect(parseDelegateArgs(['tell', 'r1', 'first line', 'second line'])).toEqual({ op: 'tell', id: 'r1', text: 'first line\nsecond line' });
    expect(parseDelegateArgs(['tell', 'r1'])).toHaveProperty('error');
    expect(parseDelegateArgs(['list'])).toEqual({ op: 'list' });
    expect(parseDelegateArgs(['list', 'x'])).toHaveProperty('error');
    expect(parseDelegateArgs(['stop', 'r1'])).toEqual({ op: 'stop', id: 'r1' });
    expect(parseDelegateArgs(['run'])).toEqual({ error: 'there is no command "run"' });
    expect(parseDelegateArgs([])).toEqual({ error: 'no command given' });
  });
});

describe('absolutePath', () => {
  it('resolves from the caller folder in its own path form', () => {
    expect(absolutePath(false, '/home/u/takt', '../repos/site/')).toBe('/home/u/repos/site');
    expect(absolutePath(false, '/home/u/takt', '/srv/x')).toBe('/srv/x');
    expect(absolutePath(true, 'C:\\work\\takt', '..\\site')).toBe('C:\\work\\site');
  });
});

describe('delegateTask', () => {
  const settings = SettingsSchema.parse({
    defaultEnvironmentId: 'wsl',
    environments: [
      {
        id: 'wsl',
        name: 'WSL',
        kind: 'wsl',
        harnesses: [
          { id: 'personal', name: 'Personal', kind: 'claude-code', command: 'claude' },
          { id: 'work', name: 'Work', kind: 'claude-code', command: 'claude' },
        ],
      },
    ],
  });
  const parent = TaskSchema.parse({
    id: 'takt',
    name: 'Takt robots',
    environmentId: 'wsl',
    cwd: '/home/u/takt',
    trigger: { mode: 'manual' },
    agent: {
      prompt: 'p',
      harnessId: 'work',
      model: 'opus',
      effort: 'high',
      permissionMode: 'bypassPermissions',
      extraArgs: ['--append-system-prompt', 'x'],
      maxRuntimeMin: 90,
      contextLimitK: 300,
      delegate: { allowed: true },
    },
    completion: { allowed: true },
  });
  const start = { folder: '', title: 'Fix the form', briefFile: 'b.md' };

  it('runs a folder outside the projects on the parent harness with the defaults and none of its flags', () => {
    const t = delegateTask(parent, settings, [], '/home/u/repos/site', start);
    expect(t.id).toBe('takt');
    expect(t.name).toBe('Fix the form');
    expect(t.cwd).toBe('/home/u/repos/site');
    expect(t.agent.harnessId).toBe('work');
    expect(t.agent.model).toBeUndefined();
    expect(t.agent.effort).toBeUndefined();
    expect(t.agent.permissionMode).toBe('auto');
    expect(t.agent.extraArgs).toEqual([]);
    expect(t.agent.mode).toBe('interactive');
    expect(t.agent.maxRuntimeMin).toBe(90);
    expect(t.agent.contextLimitK).toBe(300);
    expect(t.agent.ask.allowed).toBe(true);
    expect(t.agent.delegate.allowed).toBe(false);
    expect(t.completion.allowed).toBe(false);
  });

  it("runs a project's folder with the project's settings, and the overrides win", () => {
    const project = ProjectSchema.parse({
      id: 'p1',
      name: 'Site',
      environmentId: 'wsl',
      harnessId: 'personal',
      cwd: '/home/u/repos/site/',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      extraArgs: ['--verbose'],
      env: { A: '1' },
    });
    const t = delegateTask(parent, settings, [project], '/home/u/repos/site', start);
    expect(t.agent.harnessId).toBe('personal');
    expect(t.agent.model).toBe('sonnet');
    expect(t.agent.permissionMode).toBe('acceptEdits');
    expect(t.agent.extraArgs).toEqual(['--verbose']);
    expect(t.env).toEqual({ A: '1' });
    const over = delegateTask(parent, settings, [project], '/home/u/repos/site', { ...start, model: 'haiku', effort: 'low' });
    expect(over.agent.model).toBe('haiku');
    expect(over.agent.effort).toBe('low');
  });
});

describe('the delegated agents message', () => {
  it('keeps every entry until the agent takes them, and the views find their text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-delegate-'));
    try {
      queueDelegateMessage(dir, 'first');
      queueDelegateMessage(dir, 'second – ü');
      const raw = JSON.parse(fs.readFileSync(path.join(dir, DELEGATE_FILE), 'utf8')) as string;
      expect(delegateText(raw)).toBe('first\n\nsecond – ü');
      expect(takeDelegateMessages(dir)).toBe('first\n\nsecond – ü');
      expect(takeDelegateMessages(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is found when Claude Code recorded it as text pasted into an idle session, and so is guidance', () => {
    // As a live Claude Code 2.x session recorded the message Looper typed in.
    const pasted = (body: string) => `\n\n<pasted_content id="2c45">\n${body}\n</pasted_content id="2c45">\n`;
    expect(delegateText(pasted(delegateMessage(['## Fix (r2) ended: Success'])))).toBe('## Fix (r2) ended: Success');
    expect(guidanceText(pasted(guidanceMessage('use pnpm')))).toBe('use pnpm');
    expect(guidanceText('<pasted_content id="1">\nnot guidance\n</pasted_content id="1">')).toBeNull();
  });

  it('a result names the agent, its outcome, where to look and the report', () => {
    const text = resultEntry({
      id: 'r2',
      title: 'Fix the form',
      folder: '/home/u/repos/site',
      outcome: 'warning',
      headline: 'Fixed, live deploy needs a key',
      body: 'Commits: abc',
      transcript: '/home/u/.claude/x.jsonl',
      runFolder: '/data/tasks/t/runs/r2',
      others: ['r3'],
    });
    expect(text).toContain('## Fix the form (r2) ended: Warning. Fixed, live deploy needs a key');
    expect(text).toContain('Transcript: /home/u/.claude/x.jsonl');
    expect(text).toContain('Run folder: /data/tasks/t/runs/r2');
    expect(text).toContain('Still going: r3');
    expect(text.endsWith('Final report:\nCommits: abc')).toBe(true);
  });
});

describe('the footer', () => {
  it('explains looper-delegate to an agent that may start agents', () => {
    const f = systemFooter('T', 'r1', false, false, undefined, { delegate: true });
    expect(f).toContain('looper-delegate start <folder>');
    expect(f).toContain('looper-done refuses');
  });

  it("tells a delegated agent who started it, and that its questions go there", () => {
    const f = systemFooter('Fix', 'r2', false, false, { allowed: true, waitMin: 5 }, { delegatedBy: { taskName: 'Robots', runId: 'r1', title: 'Fix' } });
    expect(f).toContain('by the agent of the task "Robots" (run r1)');
    expect(f).toContain('ask it one question');
    expect(f).not.toContain('looper-delegate');
  });
});

describe('the bash helpers while an agent the session started is going', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-delegate-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const target = () =>
    createTarget(TaskSchema.parse({ id: 't', name: 't', environmentId: 'local', cwd: '/tmp', trigger: { mode: 'manual' }, agent: { prompt: 'p' } }), {
      host: 'wsl',
      settings: SettingsSchema.parse({}),
    });

  it('looper-done refuses and says why, and works once the agents are over', () => {
    const helper = path.join(dir, 'looper-done');
    fs.writeFileSync(helper, target().renderDoneHelper(['success', 'warning', 'error']), { mode: 0o755 });
    const busy = path.join(dir, 'busy');
    const done = path.join(dir, 'done');
    fs.writeFileSync(busy, 'looper-done refused: r2 is still going\n');
    const env = { ...process.env, [DELEGATE_BUSY_VAR]: busy, LOOPER_DONE_FILE: done };
    const refused = spawnSync('bash', [helper, 'success', 'Fixed'], { env, encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('r2 is still going');
    expect(fs.existsSync(done)).toBe(false);
    fs.rmSync(busy);
    expect(spawnSync('bash', [helper, 'success', 'Fixed'], { env }).status).toBe(0);
    expect(fs.readFileSync(done, 'utf8')).toBe('success\nFixed\n');
  });

  it('the launcher function refuses the same way', () => {
    const t = target();
    const launcher = t.renderLauncher({
      taskId: 't',
      runId: 'r1',
      cwd: dir,
      env: {},
      binDir: dir,
      doneCommand: 'looper-done',
      doneStatuses: ['success'],
      body: 'looper-done success "x"; echo "code=$?"',
    });
    const file = path.join(dir, 'run.sh');
    fs.writeFileSync(file, launcher);
    const busy = path.join(dir, 'busy');
    fs.writeFileSync(busy, 'still going\n');
    const out = spawnSync('bash', [file], { env: { ...process.env, [DELEGATE_BUSY_VAR]: busy, LOOPER_DONE_FILE: path.join(dir, 'done') }, encoding: 'utf8' });
    expect(out.stdout).toContain('code=1');
    expect(out.stderr).toContain('still going');
  });

  it('the Stop hook lets the turn end with no reminder, and records it for the idle signal', () => {
    const files = {
      stopJson: path.join(dir, 'stop.json'),
      doneFile: path.join(dir, 'done'),
      reminderFile: path.join(dir, 'stop-reminded'),
      delegateFile: path.join(dir, DELEGATE_FILE),
      delegateBusyFile: path.join(dir, 'busy'),
      blockBackground: '{"decision":"block","reason":"bg"}',
      blockNoDone: '{"decision":"block","reason":"done?"}',
    };
    const hook = path.join(dir, 'stop-hook');
    fs.writeFileSync(hook, target().renderStopHook(files), { mode: 0o755 });
    fs.writeFileSync(files.delegateBusyFile, 'x');
    const payload = '{"last_assistant_message":"waiting"}';
    expect(execFileSync('bash', [hook], { input: payload, encoding: 'utf8' })).toBe('');
    expect(fs.readFileSync(files.stopJson, 'utf8')).toBe(payload);
    expect(fs.existsSync(files.reminderFile)).toBe(false);
    // A result that arrived meanwhile keeps the turn going with it.
    queueDelegateMessage(dir, 'r2 ended');
    const out = execFileSync('bash', [hook], { input: payload, encoding: 'utf8' });
    expect(JSON.parse(out).decision).toBe('block');
    expect(delegateText(JSON.parse(out).reason)).toBe('r2 ended');
    // Background tasks still running: ending the turn could kill them, so it waits for them first.
    const background = '{"background_tasks":[{"id":"b1","status":"running"}]}';
    expect(JSON.parse(execFileSync('bash', [hook], { input: background, encoding: 'utf8' })).reason).toBe('bg');
  });
});

// ---------- the scheduler ----------

interface Session {
  ctx: RunContext;
  cb: AgentCallbacks;
  end: (e: AgentEnd) => void;
  delivered: number;
  question: string | null;
  answers: string[];
}

const end = (reason: AgentEnd['reason'], headline?: string, body?: string, doneStatus?: AgentEnd['doneStatus']): AgentEnd => ({
  reason,
  exitCode: 0,
  headline,
  body,
  doneStatus,
  durationMs: 10,
  wasHeld: false,
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe('Scheduler with delegated agents', () => {
  let dir: string;
  let parentDir: string;
  let childDir: string;
  let sched: Scheduler;
  let sessions: Session[];
  let busy: (string | null)[];
  let events: EngineEvent[];
  let clock: { now: number };
  let runs: RunStore;

  async function setup(agent: Partial<TaskInput['agent']> = {}, envLimit?: number): Promise<void> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-delegate-'));
    parentDir = path.join(dir, 'takt');
    childDir = path.join(dir, 'site');
    fs.mkdirSync(parentDir);
    fs.mkdirSync(childDir);
    fs.writeFileSync(path.join(parentDir, 'brief.md'), 'Fix the broker form.\n');
    const base = SettingsSchema.parse({ tickMs: 100000, signalPollMs: 5, staggerFirstRun: { enabled: false } });
    const settings =
      envLimit === undefined ? base : { ...base, environments: base.environments.map((e) => ({ ...e, maxConcurrentTasks: envLimit })) };
    const tasks = new TaskStore(path.join(dir, 'tasks.json'));
    tasks.load();
    clock = { now: 1_000_000 };
    tasks.upsert({
      id: 't1',
      name: 'Robots',
      createdAt: new Date(clock.now - 60_000).toISOString(),
      trigger: { mode: 'manual' },
      environmentId: 'local',
      cwd: parentDir,
      agent: { prompt: 'do it', delegate: { allowed: true }, ...agent },
    });
    runs = new RunStore(dir);
    sessions = [];
    busy = [];
    events = [];
    sched = new Scheduler({
      dataDir: dir,
      host: 'wsl',
      settings,
      tasks,
      runs,
      state: new StateStore(path.join(dir, 'state.json')),
      log: new Logger(),
      now: () => clock.now,
      folderBusy: async () => busy.shift() ?? null,
      steps: {
        runCheck: async () => ({ status: 'act', exitCode: 0, durationMs: 1, stdoutTail: '' }),
        runClassify: async () => ({ status: 'act', durationMs: 1, exitCode: 0 }),
        startAgent: async (ctx, cb) => {
          let resolve!: (e: AgentEnd) => void;
          const finished = new Promise<AgentEnd>((r) => (resolve = r));
          const s: Session = { ctx: { ...ctx, resume: ctx.resume && { ...ctx.resume } }, cb, end: resolve, delivered: 0, question: null, answers: [] };
          sessions.push(s);
          const handle: AgentHandle = {
            runId: ctx.runId,
            pid: 1,
            held: false,
            get question() {
              return s.question;
            },
            answer: (text) => {
              if (s.question === null) return false;
              s.answers.push(text);
              s.question = null;
              return true;
            },
            write: () => undefined,
            resize: () => undefined,
            deliverGuidance: () => void s.delivered++,
            stop: async (reason = 'stopped', headline) => resolve(end(reason, headline)),
            finished,
          };
          return handle;
        },
      },
    });
    sched.on('event', (e: EngineEvent) => events.push(e));
    sched.start();
    await flush();
  }

  afterEach(async () => {
    await sched.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const records = (): RunRecord[] => events.filter((e) => e.type === 'record').map((e) => (e as { record: RunRecord }).record);
  const tick = async () => {
    (sched as unknown as { tick(): void }).tick();
    await flush();
  };
  const delegate = (s: Session, ...args: string[]) => s.cb.delegate!.handle(args, parentDir);
  const busyFile = (s: Session) => path.join(s.ctx.runDir, DELEGATE_DIR, DELEGATE_BUSY_FILE);

  async function startParent(): Promise<Session> {
    sched.runNow('t1');
    await flush();
    expect(sessions).toHaveLength(1);
    return sessions[0];
  }

  async function startChild(parent: Session): Promise<{ id: string; child: Session }> {
    const r = await delegate(parent, 'start', '../site', '--title', 'Fix the form', '--brief-file', 'brief.md');
    expect(r.code).toBe(0);
    await flush();
    const child = sessions.at(-1)!;
    expect(child).not.toBe(parent);
    return { id: r.text.split('\n')[0], child };
  }

  it("starts the agent in its folder, and its result reaches the parent's agent", async () => {
    await setup();
    const parent = await startParent();
    expect(parent.cb.delegate).toBeDefined();
    const { id, child } = await startChild(parent);
    expect(child.ctx.runId).toBe(id);
    expect(child.ctx.task.cwd).toBe(childDir);
    expect(child.ctx.task.agent.permissionMode).toBe('auto');
    expect(child.ctx.promptOverride).toBe('Fix the broker form.\n');
    expect(child.ctx.delegatedBy).toEqual({ taskName: 'Robots', runId: parent.ctx.runId, title: 'Fix the form' });
    // A delegated agent can't start agents of its own.
    expect(child.cb.delegate).toBeUndefined();
    expect(child.ctx.task.agent.delegate.allowed).toBe(false);
    expect(sched.get('t1')!.children.map((r) => r.runId)).toEqual([id]);
    expect(parent.cb.delegate!.busy()).toBe(true);
    expect(fs.readFileSync(busyFile(parent), 'utf8')).toContain(id);
    expect((await delegate(parent, 'list')).text).toContain(`${id}  running  "Fix the form"  ${childDir}`);

    child.end(end('done', 'Fixed the form', 'Commits: abc', 'success'));
    await flush();
    expect(sched.get('t1')!.children).toEqual([]);
    expect(parent.cb.delegate!.busy()).toBe(false);
    expect(fs.existsSync(busyFile(parent))).toBe(false);
    const waiting = JSON.parse(fs.readFileSync(path.join(parent.ctx.runDir, DELEGATE_FILE), 'utf8')) as string;
    expect(delegateText(waiting)).toContain(`## Fix the form (${id}) ended: Success. Fixed the form`);
    expect(delegateText(waiting)).toContain('Commits: abc');
    expect(parent.delivered).toBe(1);

    const parentRecs = records().filter((r) => r.runId === parent.ctx.runId).map((r) => `${r.phase}:${r.result}`);
    expect(parentRecs).toEqual(['agent:started', 'delegate:started', 'delegate:success']);
    const childRecs = records().filter((r) => r.runId === id).map((r) => `${r.phase}:${r.result}`);
    expect(childRecs).toEqual(['delegate:started', 'agent:started', 'agent:success', 'result:success']);

    // The parent's run reads as its own result; the child's is a run of its own under it.
    parent.end(end('done', 'Replied in Slack', 'All good', 'success'));
    await flush();
    const groups = groupRuns(runs.list('t1'));
    const p = groups.find((g) => g.runId === parent.ctx.runId)!;
    const c = groups.find((g) => g.runId === id)!;
    expect(p.result).toBe('success');
    expect(p.details).toBe('Replied in Slack');
    expect(c.parentRunId).toBe(parent.ctx.runId);
    expect(c.title).toBe('Fix the form');
    expect(c.details).toBe('Fixed the form');
  });

  it('waits while another session works in the folder, and starts once it is free', async () => {
    await setup();
    const parent = await startParent();
    busy.push('the session "K&E fix" is working in that folder');
    const r = await delegate(parent, 'start', childDir, '--title', 'Fix', '--brief-file', path.join(parentDir, 'brief.md'));
    await flush();
    expect(sessions).toHaveLength(1);
    const run = sched.get('t1')!.children[0];
    expect(run.waiting).toBe('the session "K&E fix" is working in that folder');
    await tick(); // asked again only after FOLDER_PROBE_MS
    expect(sessions).toHaveLength(1);
    clock.now += 15_000;
    await tick();
    expect(sessions).toHaveLength(2);
    expect(sessions[1].ctx.runId).toBe(r.text.split('\n')[0]);
    expect(sched.get('t1')!.children[0].waiting).toBeUndefined();
  });

  it('a second agent for the same folder waits for the first', async () => {
    await setup();
    const parent = await startParent();
    const { child } = await startChild(parent);
    const second = await delegate(parent, 'start', childDir, '--title', 'Second', '--brief-file', 'brief.md');
    await flush();
    expect(sessions).toHaveLength(2);
    expect(sched.get('t1')!.children[1].waiting).toContain('is working in that folder');
    child.end(end('done', 'ok', undefined, 'success'));
    await flush();
    expect(sessions).toHaveLength(3);
    expect(sessions[2].ctx.runId).toBe(second.text.split('\n')[0]);
  });

  it("the agent's question goes to the parent, and tell answers it", async () => {
    await setup();
    const parent = await startParent();
    const { id, child } = await startChild(parent);
    child.question = 'Which branch?';
    child.cb.onQuestion!('Which branch?');
    await flush();
    const waiting = delegateText(JSON.parse(fs.readFileSync(path.join(parent.ctx.runDir, DELEGATE_FILE), 'utf8')) as string);
    expect(waiting).toContain(`## Fix the form (${id}) asks you:\nWhich branch?`);
    expect(waiting).toContain(`looper-delegate tell ${id} "<answer>"`);
    expect(sched.get('t1')!.asking).toBe(false); // nobody asks the user
    expect((await delegate(parent, 'tell', id, 'main')).text).toBe(`${id} got your answer.`);
    expect(child.answers).toEqual(['main']);
    // Without a question waiting, tell is guidance.
    expect((await delegate(parent, 'tell', id, 'also run the tests')).text).toBe(`${id} gets this with its next step.`);
    expect(fs.existsSync(path.join(child.ctx.runDir, 'guidance.json'))).toBe(true);
  });

  it('refuses what it cannot do, with the reason', async () => {
    await setup();
    const parent = await startParent();
    expect((await delegate(parent, 'start', '.', '--title', 't', '--brief-file', 'brief.md')).text).toContain('is your own folder');
    expect((await delegate(parent, 'start', 'nowhere', '--title', 't', '--brief-file', 'brief.md')).text).toContain('there is no folder');
    fs.writeFileSync(path.join(parentDir, 'empty.md'), '  \n');
    expect((await delegate(parent, 'start', childDir, '--title', 't', '--brief-file', 'empty.md')).text).toContain('is empty');
    expect((await delegate(parent, 'start', childDir, '--title', 't', '--brief-file', 'none.md')).text).toContain("can't read the brief");
    expect((await delegate(parent, 'tell', 'r9', 'x')).text).toContain('no agent r9 you started');
    const bad = await delegate(parent, 'go');
    expect(bad.code).toBe(2);
    expect(bad.text).toContain('usage:');
    expect(sched.get('t1')!.children).toEqual([]);
  });

  it('stop ends an agent, and its result still reaches the parent', async () => {
    await setup();
    const parent = await startParent();
    const { id } = await startChild(parent);
    await delegate(parent, 'stop', id);
    await flush();
    expect(sched.get('t1')!.children).toEqual([]);
    const waiting = delegateText(JSON.parse(fs.readFileSync(path.join(parent.ctx.runDir, DELEGATE_FILE), 'utf8')) as string);
    expect(waiting).toContain(`(${id}) ended: Stopped. stopped by the agent that started it`);
  });

  it("the parent's run ending stops its agents, including one still waiting", async () => {
    await setup();
    const parent = await startParent();
    const { id, child } = await startChild(parent);
    busy.push('busy');
    const queued = (await delegate(parent, 'start', path.join(dir, 'other'), '--title', 'x', '--brief-file', 'brief.md')).text;
    expect(queued).toContain('there is no folder');
    fs.mkdirSync(path.join(dir, 'other'));
    const waitingId = (await delegate(parent, 'start', path.join(dir, 'other'), '--title', 'Other', '--brief-file', 'brief.md')).text.split('\n')[0];
    await flush();
    parent.end(end('max-runtime', 'exceeded 120 min'));
    await flush();
    expect(sched.get('t1')!.children).toEqual([]);
    expect(sessions).toHaveLength(2);
    const childEnd = records().find((r) => r.runId === id && r.phase === 'agent' && r.result !== 'started')!;
    expect(childEnd.result).toBe('stopped');
    expect(records().some((r) => r.runId === waitingId && r.phase === 'system' && r.result === 'stopped')).toBe(true);
    expect(records().some((r) => r.runId === parent.ctx.runId && r.phase === 'delegate' && r.result === 'undelivered')).toBe(true);
    expect(fs.existsSync(busyFile(parent))).toBe(false);
    void child;
  });

  it('a headless parent that ended its turn to wait resumes its conversation with the results', async () => {
    await setup({ mode: 'headless' });
    const parent = await startParent();
    const { id, child } = await startChild(parent);
    fs.writeFileSync(path.join(parent.ctx.runDir, 'session.json'), JSON.stringify({ session_id: 'conv-1', transcript_path: '/x.jsonl' }));
    parent.end(end('done', 'waiting'));
    await flush();
    expect(sessions).toHaveLength(2);
    child.end(end('done', 'Fixed', 'report', 'success'));
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    expect(sessions).toHaveLength(3);
    const resumed = sessions[2];
    expect(resumed.ctx.runId).toBe(parent.ctx.runId);
    expect(resumed.ctx.agentSession).toEqual({ id: 'conv-1', resume: true });
    expect(delegateText(resumed.ctx.resume!.prompt)).toContain(`(${id}) ended: Success. Fixed`);
    resumed.end(end('done', 'Replied', 'ok', 'success'));
    await flush();
    expect(sched.get('t1')!.runs).toEqual([]);
    expect(records().some((r) => r.runId === parent.ctx.runId && r.phase === 'delegate' && r.result === 'delivered')).toBe(true);
  });

  it("a headless parent that waits is resumed with an agent's question, answers it, and waits again", async () => {
    await setup({ mode: 'headless' });
    const parent = await startParent();
    const { id, child } = await startChild(parent);
    fs.writeFileSync(path.join(parent.ctx.runDir, 'session.json'), JSON.stringify({ session_id: 'conv-1' }));
    parent.end(end('done', 'waiting'));
    await flush();
    child.question = 'Which branch?';
    child.cb.onQuestion!('Which branch?');
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    expect(sessions).toHaveLength(3);
    const asked = sessions[2];
    expect(delegateText(asked.ctx.resume!.prompt)).toContain(`(${id}) asks you:\nWhich branch?`);
    expect((await asked.cb.delegate!.handle(['tell', id, 'main'], parentDir)).text).toBe(`${id} got your answer.`);
    expect(child.answers).toEqual(['main']);
    asked.end(end('done', 'answered'));
    await flush();
    expect(sessions).toHaveLength(3); // waits again: the agent is still going
    child.end(end('done', 'Merged', 'report', 'success'));
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    expect(sessions).toHaveLength(4);
    expect(delegateText(sessions[3].ctx.resume!.prompt)).toContain(`(${id}) ended: Success. Merged`);
  });

  it("a headless parent that waits is resumed with the user's guidance too", async () => {
    await setup({ mode: 'headless' });
    const parent = await startParent();
    await startChild(parent);
    fs.writeFileSync(path.join(parent.ctx.runDir, 'session.json'), JSON.stringify({ session_id: 'conv-1' }));
    parent.end(end('done', 'waiting'));
    await flush();
    sched.sendGuidance('t1', parent.ctx.runId, 'the client changed the spec');
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    expect(sessions).toHaveLength(3);
    expect(guidanceText(sessions[2].ctx.resume!.prompt)).toBe('the client changed the spec');
  });

  it('Stop Task on a headless parent that waits stops it and its agents, with no new session', async () => {
    await setup({ mode: 'headless' });
    const parent = await startParent();
    const { id } = await startChild(parent);
    fs.writeFileSync(path.join(parent.ctx.runDir, 'session.json'), JSON.stringify({ session_id: 'conv-1' }));
    parent.end(end('done', 'waiting'));
    await flush();
    expect(sched.canGuideRun('t1', parent.ctx.runId)).toBe(true);
    expect(await sched.stopTask('t1')).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    expect(sessions).toHaveLength(2);
    expect(sched.get('t1')!.runs).toEqual([]);
    expect(sched.get('t1')!.children).toEqual([]);
    expect(records().find((r) => r.runId === id && r.phase === 'agent' && r.result !== 'started')!.result).toBe('stopped');
    expect(records().findLast((r) => r.runId === parent.ctx.runId && r.phase === 'agent')!.result).toBe('stopped');
  });

  it("starts the first agent in its parent's slot when the environment allows one task at a time", async () => {
    await setup({}, 1);
    const parent = await startParent();
    const { child } = await startChild(parent);
    expect(child.ctx.delegatedBy).toBeDefined();
    // A second agent of the same run needs a slot of its own.
    fs.mkdirSync(path.join(dir, 'other'));
    await delegate(parent, 'start', path.join(dir, 'other'), '--title', 'Other', '--brief-file', 'brief.md');
    await flush();
    expect(sessions).toHaveLength(2);
    expect(sched.get('t1')!.children[1].waiting).toContain('at its limit of 1');
  });

  it("doesn't continue a delegated agent's conversation as a run of the task", async () => {
    await setup();
    const parent = await startParent();
    const { id, child } = await startChild(parent);
    expect(() => sched.continueRun('t1', id, 'more')).toThrow('still active');
    child.end(end('done', 'ok', undefined, 'success'));
    await flush();
    expect(() => sched.continueRun('t1', id, 'more')).toThrow('folder of its own');
  });

  it('a task without the option gets no delegate command', async () => {
    await setup({ delegate: { allowed: false } });
    const parent = await startParent();
    expect(parent.cb.delegate).toBeUndefined();
  });
});
