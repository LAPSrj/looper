import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { writeTerminalLauncher, type RemoteLaunch } from '../src/engine/open-terminal';
import { RemoteControl, lastCacheUse, remoteStandIn } from '../src/engine/remote';
import { createTarget } from '../src/engine/target';
import type { RemoteState } from '../src/shared/remote';
import { projectSessionTask, projectTaskId } from '../src/shared/projects';
import { ProjectSchema, SettingsSchema, TaskSchema, type Project, type Settings, type Task } from '../src/shared/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function settingsWith(remote: unknown): Settings {
  return SettingsSchema.parse({
    environments: [
      {
        id: 'local',
        name: 'Local',
        kind: 'local',
        harnesses: [{ id: 'claude', name: 'Claude Code', kind: 'claude-code', command: 'claude' }],
      },
    ],
    remote,
  });
}

const task = (id: string, cwd = '/home/me/proj'): Task =>
  TaskSchema.parse({ id, name: `Task ${id}`, environmentId: 'local', cwd, trigger: { mode: 'manual' }, agent: { prompt: '-' } });

/** A project that keeps a Remote Control conversation open, unless `extra` says otherwise. */
const project = (id: string, name: string, cwd: string, extra: Partial<Project> = {}): Project =>
  ProjectSchema.parse({ id, name, environmentId: 'local', cwd, remote: true, ...extra });

/** The project the tests mostly use: the folder of task t1, under that task's name. */
const p1 = () => project('p1', 'Task t1', '/home/me/proj');

interface Started {
  runId: string;
  task: Task;
  dir: string;
  launch: RemoteLaunch;
  resume?: string;
}

function setup(
  remote: unknown,
  opts: { tasks?: Task[]; projects?: Project[]; now?: () => number; output?: (n: number) => string } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-remote-'));
  const settings = settingsWith(remote);
  const projects = opts.projects ?? [];
  const started: Started[] = [];
  const closed: string[] = [];
  const writes: string[] = [];
  const outputs = new Map<string, string>();
  const states: RemoteState[] = [];
  let n = 0;
  const rc = new RemoteControl({
    dataDir: root,
    settings,
    log: new Logger(),
    emit: (s) => states.push(s),
    getTask: (id) => {
      const p = projects.find((x) => projectTaskId(x.id) === id);
      return opts.tasks?.find((t) => t.id === id) ?? (p ? projectSessionTask(p, settings) : undefined);
    },
    listTasks: () => opts.tasks ?? [],
    listProjects: () => projects,
    createTarget: (t) => createTarget(t, { host: 'linux', settings }),
    startSession(t, launch, resume) {
      const runId = resume?.runId ?? `r${++n}`;
      const dir = path.join(root, 'tasks', t.id, 'runs', runId);
      fs.mkdirSync(dir, { recursive: true });
      started.push({ runId, task: t, dir, launch: launch(dir, createTarget(t, { host: 'linux', settings })), resume: resume?.sessionId });
      outputs.set(runId, opts.output?.(n) ?? '');
      return { runId, dir };
    },
    closeSession(runId) {
      closed.push(runId);
      outputs.delete(runId);
    },
    output: (runId) => (outputs.has(runId) ? { data: outputs.get(runId)!, ended: false } : null),
    write: (_runId, data) => writes.push(data),
    readTitle: () => 'Fix the footer',
    runDir: (taskId, runId) => path.join(root, 'tasks', taskId, 'runs', runId),
    pollMs: 20,
    now: opts.now,
  });
  open.push(rc);
  return { rc, root, settings, projects, started, closed, writes, outputs, states };
}

const touch = (file: string) => fs.writeFileSync(file, '{}');

/** Send a helper's `looper-remote` request (one line per argument) and wait for Looper's answer. */
async function ask(dir: string, cwd: string, ...lines: string[]): Promise<{ out: string; code: string }> {
  const rid = `q${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'requests', `${rid}.req`), ['remote', cwd, ...lines].join('\n') + '\n');
  for (let i = 0; i < 100; i++) {
    const code = path.join(dir, 'responses', `${rid}.code`);
    if (fs.existsSync(code)) return { out: fs.readFileSync(path.join(dir, 'responses', `${rid}.out`), 'utf8'), code: fs.readFileSync(code, 'utf8') };
    await sleep(30);
  }
  throw new Error('no answer');
}

/** A transcript line for one API request. */
const request = (at: number, cache: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: { usage: { cache_read_input_tokens: 900, ...(cache ? { cache_creation: cache } : {}) } },
  });

/** A conversation's turn: its message, then its end. */
async function turn(dir: string): Promise<void> {
  touch(path.join(dir, 'prompt.json'));
  await sleep(30);
  touch(path.join(dir, 'stop.json'));
  await sleep(80);
}

let open: RemoteControl[] = [];
afterEach(() => {
  for (const rc of open) rc.stop();
  open = [];
});

const helper = { id: 'h1', name: 'Helper', environmentId: 'local', cwd: '/home/me' };

describe('Remote Control', () => {
  it('gives every helper and Remote Control project a session when it starts, and ends them all when it stops', () => {
    const { rc, started, closed } = setup(
      { helpers: [helper] },
      {
        tasks: [task('t1')],
        projects: [p1(), project('p2', 'Site', '/home/me/site', { model: 'opus' }), project('p3', 'Off', '/home/me/off', { remote: false })],
      },
    );
    rc.start();
    expect(started.map((s) => [s.task.id, s.launch.name, s.task.cwd])).toEqual([
      ['@remote-h1', 'Helper', '/home/me'],
      ['@project-p1', 'Task t1', '/home/me/proj'],
      ['@project-p2', 'Site', '/home/me/site'],
    ]);
    expect(started[2].task.agent.model).toBe('opus');
    expect(rc.state().conversations.map((c) => [c.id, c.source, c.status]).sort()).toEqual([
      ['r1', 'helper', 'waiting'],
      ['r2', 'project', 'waiting'],
      ['r3', 'project', 'waiting'],
    ]);
    rc.stop();
    expect(closed.sort()).toEqual(['r1', 'r2', 'r3']);
    expect(rc.state().running).toBe(false);
    expect(rc.liveCount()).toBe(0);
  });

  it('runs a project on its first Claude Code harness when its own is another kind', () => {
    const { rc, started } = setup({}, { projects: [p1()] });
    const settings = (rc as unknown as { d: { settings: Settings } }).d.settings;
    settings.environments[0].harnesses.unshift({ ...settings.environments[0].harnesses[0], id: 'codex', name: 'Codex', kind: 'codex' });
    rc.start();
    expect(started[0].task.agent.harnessId).toBe('claude');
  });

  it("a helper gets Looper's instructions, the looper-remote command and settings that let it run unasked", () => {
    const { rc, started } = setup({ helpers: [helper] });
    rc.start();
    const l = started[0].launch;
    expect(l.systemPrompt).toContain('looper-remote open');
    expect(l.systemPrompt).toContain('looper-remote recent');
    expect(l.systemPrompt).toContain('looper-remote conversations');
    expect(l.systemPrompt).toContain('looper-remote resume <conversation id> [prompt]');
    expect(Object.keys(l.helpers ?? {})).toEqual(['looper-remote']);
    expect(l.helpers?.['looper-remote']).toContain('LOOPER_REMOTE_DIR');
    expect(l.env).toEqual({ LOOPER_REMOTE_DIR: started[0].dir });
    expect(l.settings).toMatchObject({
      permissions: { allow: ['Bash(looper-remote:*)', 'Bash(looper-remote)', 'Bash(ls:*)', 'Bash(ls)'] },
      idleCompaction: false,
    });
  });

  it("runs a helper apart from the user's and the folder's setup, refusing every command but ls and looper-remote", () => {
    const { rc, started } = setup({ helpers: [{ ...helper, instructions: 'Answer in Portuguese.' }] });
    rc.start();
    const s = started[0];
    expect(s.launch.args).toEqual(['--setting-sources=', '--strict-mcp-config', '--disable-slash-commands', '--tools', 'Bash']);
    expect(s.task.agent.permissionMode).toBe('dontAsk');
    expect(s.launch.prelude).toBe(`printf '%s\\n%s\\n' "$HOME" "$CLAUDE_CONFIG_DIR" > '${path.join(s.dir, 'home.txt')}'`);
    expect(s.launch.systemPrompt?.endsWith('\n\nAnswer in Portuguese.')).toBe(true);
  });

  it('looper-remote recent: the folders Claude Code knows that still exist, newest session first', async () => {
    const { rc, root, started } = setup({ helpers: [helper] });
    rc.start();
    const h = started[0];
    const home = path.join(root, 'home');
    const claudeDir = path.join(home, '.claude', 'projects');
    const folder = (name: string, ageMin?: number) => {
      const f = path.join(home, name);
      fs.mkdirSync(f, { recursive: true });
      if (ageMin !== undefined) {
        const t = path.join(claudeDir, f.replace(/[^A-Za-z0-9]/g, '-'));
        fs.mkdirSync(t, { recursive: true });
        const when = new Date(Date.now() - ageMin * 60_000);
        fs.utimesSync(t, when, when);
      }
      return f;
    };
    const old = folder('old-site', 60);
    const fresh = folder('fresh_repo', 1);
    const never = folder('never');
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [old]: {}, [fresh + '/']: {}, [fresh]: {}, [never]: {}, [path.join(home, 'gone')]: {} } }),
    );
    fs.writeFileSync(path.join(h.dir, 'home.txt'), `${home}\n\n`);
    fs.mkdirSync(path.join(h.dir, 'requests'), { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'requests', 'q1.req'), ['remote', home, 'recent'].join('\n') + '\n');
    const code = path.join(h.dir, 'responses', 'q1.code');
    for (let i = 0; i < 100 && !fs.existsSync(code); i++) await sleep(20);
    const out = fs.readFileSync(path.join(h.dir, 'responses', 'q1.out'), 'utf8').trim().split('\n');
    // The local day of the fresh folder's own time (a minute ago), which isn't today just after midnight.
    const d = new Date(Date.now() - 60_000);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(out[0]).toBe(`- ${fresh} (last session ${day})`);
    expect(out[1]).toMatch(new RegExp(`^- ${old} \\(last session \\d{4}-\\d{2}-\\d{2}\\)$`));
    expect(out[2]).toBe(`- ${never}`);
    expect(out).toHaveLength(3);
  });

  it("a project's used conversation is its only one, and another opens once it ends", async () => {
    let t = 0;
    const { rc, started } = setup({}, { tasks: [task('t1')], projects: [p1()], now: () => t });
    rc.start();
    touch(path.join(started[0].dir, 'prompt.json'));
    await sleep(100);
    expect(started).toHaveLength(1);
    t += 60_000;
    rc.exited('r1');
    expect(started.map((s) => s.runId)).toEqual(['r1', 'r2']);
    expect(rc.state().problems).toEqual({});
  });

  it("shows the last message: the user's while its turn runs, then Claude's answer", async () => {
    const { rc, started } = setup({}, { tasks: [task('t1')], projects: [p1()] });
    rc.start();
    const dir = started[0].dir;
    expect(rc.lastMessage('r1')).toBeNull();
    fs.writeFileSync(path.join(dir, 'prompt.json'), '﻿{"hook_event_name":"UserPromptSubmit","prompt":"Fix the footer"}');
    expect(rc.lastMessage('r1')).toEqual({ from: 'user', text: 'Fix the footer' });
    await sleep(20);
    fs.writeFileSync(path.join(dir, 'stop.json'), '{"hook_event_name":"Stop","last_assistant_message":"Fixed it."}');
    expect(rc.lastMessage('r1')).toEqual({ from: 'agent', text: 'Fixed it.' });
    expect(rc.lastMessage('nope')).toBeNull();
  });

  it('records a used conversation, titled once its first turn ends, and lists it after it ends', async () => {
    const { rc, started } = setup({}, { tasks: [task('t1')], projects: [p1()] });
    rc.start();
    touch(path.join(started[0].dir, 'prompt.json'));
    await sleep(30);
    touch(path.join(started[0].dir, 'stop.json'));
    await sleep(100);
    expect(rc.state().conversations[0]).toMatchObject({ id: 'r1', status: 'idle', title: 'Fix the footer' });
    rc.stopConversation('r1');
    const listed = rc.state().conversations.find((c) => c.id === 'r1');
    expect(listed).toMatchObject({ status: 'ended', title: 'Fix the footer', taskId: '@project-p1' });
    // An empty conversation leaves no trace.
    const waiting = rc.state().conversations.find((c) => c.status === 'waiting');
    rc.stop();
    expect(rc.state().conversations.some((c) => c.id === waiting?.id)).toBe(false);
  });

  it("lists each conversation's last message on one line, and keeps it once the conversation ends", async () => {
    const { rc, started } = setup({}, { tasks: [task('t1')], projects: [p1()] });
    rc.start();
    const dir = started[0].dir;
    fs.writeFileSync(path.join(dir, 'prompt.json'), '{"prompt":"Fix the\\nfooter"}');
    await sleep(80);
    expect(rc.state().conversations.find((c) => c.id === 'r1')?.lastMessage).toBe('Fix the footer');
    fs.writeFileSync(path.join(dir, 'stop.json'), '{"last_assistant_message":"Fixed it.\\n\\nThe footer is done."}');
    await sleep(80);
    expect(rc.state().conversations.find((c) => c.id === 'r1')?.lastMessage).toBe('Fixed it. The footer is done.');
    rc.stopConversation('r1');
    expect(rc.state().conversations.find((c) => c.id === 'r1')).toMatchObject({ status: 'ended', lastMessage: 'Fixed it. The footer is done.' });
  });

  it('restarts a conversation in its own run, resuming it in the same folder; an open one ends first', async () => {
    const { rc, started, closed } = setup({}, { tasks: [task('t1')], projects: [p1()] });
    rc.start();
    const dir = started[0].dir;
    fs.writeFileSync(path.join(dir, 'session.json'), '{"session_id":"abc-123"}');
    touch(path.join(dir, 'prompt.json'));
    await sleep(30);
    fs.writeFileSync(path.join(dir, 'stop.json'), '{"last_assistant_message":"Done."}');
    await sleep(80);
    const before = rc.state().conversations.find((c) => c.id === 'r1')!;
    rc.restartConversation('r1');
    expect(closed).toEqual(['r1']);
    expect(started.map((s) => [s.runId, s.resume])).toEqual([
      ['r1', undefined],
      ['r1', 'abc-123'],
    ]);
    expect(started[1].launch.name).toBe('Task t1');
    // Still the project's conversation: no empty one opens next to it.
    expect(rc.liveCount()).toBe(1);
    expect(rc.state().conversations[0]).toMatchObject({ id: 'r1', status: 'idle', startedAt: before.startedAt, lastMessage: 'Done.' });
    rc.stopConversation('r1');
    rc.restartConversation('r1');
    expect(started.at(-1)).toMatchObject({ runId: 'r1', resume: 'abc-123' });
  });

  it("won't restart a helper, a conversation with nothing recorded, or one while Remote Control is off", async () => {
    const { rc, started } = setup({ helpers: [helper] }, { tasks: [task('t1')], projects: [p1()] });
    expect(() => rc.restartConversation('r1')).toThrow('Turn on Remote Control first.');
    rc.start();
    expect(() => rc.restartConversation('r1')).toThrow(/replaces a helper/);
    expect(() => rc.restartConversation('r2')).toThrow(/No conversation was recorded/);
    expect(started).toHaveLength(2);
  });

  it('replaces a helper that has been idle past its restart time: the fresh one first, then the old one ends', async () => {
    const { rc, started, closed } = setup({ helpers: [{ ...helper, idleRestartMin: 0.002 }] });
    rc.start();
    touch(path.join(started[0].dir, 'prompt.json'));
    await sleep(20);
    touch(path.join(started[0].dir, 'stop.json'));
    await sleep(300);
    expect(started.map((s) => s.runId)).toEqual(['r1', 'r2']);
    expect(closed).toEqual(['r1']);
  });

  it('never replaces a helper while its turn runs', async () => {
    const { rc, started, closed } = setup({ helpers: [{ ...helper, idleRestartMin: 0.002 }] });
    rc.start();
    touch(path.join(started[0].dir, 'prompt.json'));
    await sleep(300);
    expect(started).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  it('stops trying an entry whose session keeps exiting right after it starts, and says why', () => {
    let t = 0;
    const { rc, started, outputs } = setup({}, { tasks: [task('t1')], projects: [p1()], now: () => t });
    rc.start();
    for (let i = 0; i < 3; i++) {
      const runId = started[started.length - 1].runId;
      outputs.set(runId, 'Error: not logged in\r\n');
      t += 10_000;
      rc.exited(runId);
    }
    expect(started).toHaveLength(3);
    expect(rc.state().problems['project:p1']).toMatch(/exited right after starting, 3 times in a row: Error: not logged in/);
    t += 60_000;
    rc.settingsChanged();
    // A settings change gives it another try.
    expect(started).toHaveLength(4);
  });

  it("says why an entry can't start: no working directory, an environment that's gone", () => {
    const { rc, started } = setup({ helpers: [{ ...helper, cwd: '' }] }, { projects: [project('p1', 'Lost', '/home/me/lost', { environmentId: 'gone' })] });
    rc.start();
    expect(started).toHaveLength(0);
    expect(rc.state().problems['helper:h1']).toBe('Choose its working directory.');
    expect(rc.state().problems['project:p1']).toMatch(/unknown environment "gone"/);
  });

  it("answers the folder trust dialog and picks up the session's link from its output", async () => {
    const { rc, writes, outputs, started } = setup({ helpers: [helper] });
    rc.start();
    outputs.set(started[0].runId, 'Quick safety check:\r\n Do you trust this\x1b[1Cfolder?\r\n');
    await sleep(900);
    expect(writes).toEqual(['\x1b[B', '\r']);
    outputs.set(started[0].runId, '/remote-control is active · at \x1b[2mhttps://claude.ai/code/session_01ABCdef\x1b[0m');
    await sleep(60);
    expect(rc.state().conversations[0].link).toBe('https://claude.ai/code/session_01ABCdef');
  });

  it('a removed entry loses its empty session, and a used one goes on', async () => {
    const { rc, projects, started, closed } = setup({}, { projects: [p1(), project('p2', 'Task t2', '/home/me/two')] });
    rc.start();
    touch(path.join(started[1].dir, 'prompt.json'));
    await sleep(60);
    projects.splice(0);
    rc.settingsChanged();
    expect(closed).toEqual(['r1']);
    expect(rc.liveCount()).toBe(1);
  });

  it('looper-remote: lists what it can open, opens a project, a task or a folder, and refuses a folder that is not there', async () => {
    const tasks = [task('site', '/home/me/site')];
    // The helper's folder: a real one, so an opened path can be checked.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-remote-home-'));
    fs.mkdirSync(path.join(home, 'repo'));
    fs.mkdirSync(path.join(home, 'blog'));
    const { rc, root, started } = setup(
      { helpers: [{ ...helper, cwd: home, model: 'sonnet', effort: 'low' }] },
      {
        tasks,
        projects: [project('p1', 'Website', '/home/me/site', { remote: false }), project('blog', 'Blog', path.join(home, 'blog'), { remote: false })],
        output: (n) => `connected https://claude.ai/code/session_${n}x`,
      },
    );
    rc.start();
    const h = started.find((s) => s.launch.name === 'Helper')!;
    const ask = async (...lines: string[]): Promise<{ out: string; code: string }> => {
      const rid = `q${Math.random().toString(36).slice(2, 6)}`;
      fs.mkdirSync(path.join(h.dir, 'requests'), { recursive: true });
      fs.writeFileSync(path.join(h.dir, 'requests', `${rid}.req`), ['remote', home, ...lines].join('\n') + '\n');
      for (let i = 0; i < 100; i++) {
        const code = path.join(h.dir, 'responses', `${rid}.code`);
        if (fs.existsSync(code)) return { out: fs.readFileSync(path.join(h.dir, 'responses', `${rid}.out`), 'utf8'), code: fs.readFileSync(code, 'utf8') };
        await sleep(30);
      }
      throw new Error('no answer');
    };
    const listed = (await ask('list')).out;
    expect(listed).toContain('Projects:\n- Website: /home/me/site\n');
    expect(listed).toContain('Tasks:\n- site (Task site): /home/me/site');
    const byProject = await ask('open', 'website');
    expect(byProject.out).toMatch(/^Opened "Website" in \/home\/me\/site\./);
    expect(started.at(-1)!.task.id).toBe('@project-p1');
    const byTask = await ask('open', 'site');
    expect(byTask.code).toBe('0');
    expect(byTask.out).toMatch(/^Opened "Task site" in \/home\/me\/site\.\nLink: https:\/\/claude\.ai\/code\/session_\d+x/);
    expect(started.at(-1)!.task.id).toBe('site');
    // A project's folder opens as that project.
    await ask('open', 'blog/');
    expect(started.at(-1)!.task.id).toBe('@project-blog');
    const byFolder = await ask('open', '../' + path.basename(home) + '/repo/');
    expect(byFolder.out).toContain(`Opened "repo" in ${path.join(home, 'repo')}.`);
    const opened = started[started.length - 1];
    expect(opened.task.id).toBe('@remote-h1');
    expect(opened.launch.systemPrompt).toBeUndefined();
    // The helper's own model is for its job; an opened folder runs on the harness's default.
    expect(opened.task.agent.model).toBeUndefined();
    expect(opened.task.agent.effort).toBeUndefined();
    expect(opened.task.agent.permissionMode).toBe('auto');
    const missing = await ask('open', 'nowhere');
    expect(missing.code).toBe('1');
    expect(missing.out).toContain(`isn't a folder`);
    expect(rc.state().conversations.filter((c) => c.source === 'opened')).toHaveLength(4);
    void root;
  });

  it('ends an idle conversation once its prompt cache expires, opening a fresh one for its project, but never a helper', async () => {
    const t0 = Date.now();
    let t = t0;
    const { rc, started, closed } = setup(
      { helpers: [helper] },
      { tasks: [task('t1')], projects: [p1()], now: () => t },
    );
    rc.start();
    const [h, p] = started;
    const transcript = path.join(p.dir, 'transcript.jsonl');
    fs.writeFileSync(transcript, [request(t0, { ephemeral_5m_input_tokens: 900 }), request(t0, null)].join('\n') + '\n');
    fs.writeFileSync(path.join(p.dir, 'session.json'), JSON.stringify({ transcript_path: transcript }));
    await Promise.all([turn(h.dir), turn(p.dir)]);
    t = t0 + 4 * 60_000;
    await sleep(80);
    expect(closed).toEqual([]);
    t = t0 + 6 * 60_000;
    await sleep(80);
    expect(closed).toEqual([p.runId]);
    expect(started.map((s) => s.runId)).toEqual([h.runId, p.runId, 'r3']);
    expect(rc.state().conversations.find((c) => c.id === p.runId)?.status).toBe('ended');
  });

  it("gives a conversation whose transcript names no cache the long lifetime, and keeps it open while its harness's option is off", async () => {
    const t0 = Date.now();
    let t = t0;
    const { rc, settings, started, closed } = setup({}, { tasks: [task('t1')], projects: [p1()], now: () => t });
    rc.start();
    await turn(started[0].dir);
    t = t0 + 30 * 60_000;
    await sleep(80);
    expect(closed).toEqual([]);
    const harness = settings.environments[0].harnesses[0];
    harness.options = { closeWhenCacheExpires: false };
    t = t0 + 2 * 60 * 60_000;
    await sleep(80);
    expect(closed).toEqual([]);
    harness.options = {};
    await sleep(80);
    expect(closed).toEqual(['r1']);
  });

  it("lists a chat or terminal that started with Remote Control while it's open, but leaves it to the user", async () => {
    const t0 = Date.now();
    let t = t0;
    const { rc, root, started, closed, outputs } = setup({}, { tasks: [task('t1')], now: () => t });
    const dir = path.join(root, 'tasks', 't1', 'runs', 'term1');
    fs.mkdirSync(dir, { recursive: true });
    // Not while Remote Control is off.
    rc.attach({ id: 'term1', taskId: 't1', source: 'terminal', name: 'Task t1', cwd: '/home/me/proj', dir });
    expect(rc.isAttached('term1')).toBe(false);
    rc.start();
    outputs.set('term1', 'connected https://claude.ai/code/session_term1');
    rc.attach({ id: 'term1', taskId: 't1', source: 'terminal', name: 'Task t1', cwd: '/home/me/proj', dir });
    rc.attach({ id: 'chat1', taskId: 't1', source: 'chat', name: 'Task t1', cwd: '/home/me/proj', dir: path.join(root, 'chat1'), link: 'https://claude.ai/code/session_chat1' });
    expect(rc.owns('term1')).toBe(false);
    await turn(dir);
    const listed = rc.state().conversations;
    expect(listed.find((c) => c.id === 'term1')).toMatchObject({ source: 'terminal', status: 'idle', link: 'https://claude.ai/code/session_term1', title: 'Fix the footer' });
    expect(listed.find((c) => c.id === 'chat1')).toMatchObject({ source: 'chat', status: 'waiting', link: 'https://claude.ai/code/session_chat1' });
    // Idle past any prompt cache: still open, since it's the user's.
    t = t0 + 3 * 60 * 60_000;
    await sleep(80);
    expect(closed).toEqual([]);
    expect(() => rc.restartConversation('term1')).toThrow(/open in Looper/);
    expect(started).toEqual([]);
    // It closed: a used one stays on the list as ended, an unused one goes.
    rc.detach('term1');
    rc.detach('chat1');
    expect(rc.state().conversations.map((c) => [c.id, c.status])).toEqual([['term1', 'ended']]);
    expect(() => rc.restartConversation('term1')).toThrow(/No conversation was recorded/);
  });

  it('looper-remote: opens with a prompt, lists the conversations, and resumes an ended one where it left off', async () => {
    const { rc, started } = setup(
      { helpers: [helper] },
      { tasks: [task('site', '/home/me/site')], projects: [project('p1', 'Website', '/home/me/site')], output: (n) => `connected https://claude.ai/code/session_${n}x` },
    );
    rc.start();
    const h = started[0];
    const opened = await ask(h.dir, '/home/me', 'open', 'site', 'Fix the footer', 'on every page');
    expect(opened.out).toMatch(/^Opened "Task site" in \/home\/me\/site\.\nLink: https:\/\/claude\.ai\/code\/session_\d+x/);
    const s = started.at(-1)!;
    expect(s.launch.prompt).toBe('Fix the footer\non every page');
    fs.writeFileSync(path.join(s.dir, 'session.json'), '{"session_id":"abc-123"}');
    await turn(s.dir);
    // Only used conversations, and no helper's.
    expect((await ask(h.dir, '/home/me', 'conversations')).out).toMatch(
      new RegExp(`^- ${s.runId} "Task site" \\(open, idle, started \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}, in /home/me/site\\): Fix the footer\\n$`),
    );
    expect((await ask(h.dir, '/home/me', 'resume', s.runId)).out).toMatch(/^Already open: "Task site" in \/home\/me\/site\.\nLink: /);
    rc.stopConversation(s.runId);
    expect((await ask(h.dir, '/home/me', 'conversations')).out).toContain(`- ${s.runId} "Task site" (ended, started `);
    const resumed = await ask(h.dir, '/home/me', 'resume', s.runId, 'Now the header');
    expect(resumed.out).toMatch(/^Resumed "Task site" in \/home\/me\/site\.\nLink: /);
    expect(started.at(-1)).toMatchObject({ runId: s.runId, resume: 'abc-123' });
    expect(started.at(-1)!.launch.prompt).toBe('Now the header');
    const own = await ask(h.dir, '/home/me', 'resume', h.runId);
    expect([own.code, own.out]).toEqual(['1', "looper: That's a helper's conversation; only other conversations can be resumed.\n"]);
  });

  it("keeps a helper's stand-in task, so its conversations stay readable", () => {
    const { rc } = setup({ helpers: [helper] });
    rc.start();
    expect(rc.standIn('@remote-h1')).toMatchObject({ id: '@remote-h1', name: 'Helper', environmentId: 'local', cwd: '/home/me' });
    expect(rc.standIn('t1')).toBeUndefined();
  });
});

describe('lastCacheUse', () => {
  it("finds the last request's time and the lifetime of the last cache it wrote, past a cut first line", () => {
    const t = Date.parse('2026-10-27T23:06:31.400Z');
    const tail = (lines: string[]) => ['ype":"assistant"}', ...lines, ''].join('\n');
    expect(lastCacheUse(tail([request(t - 9000, { ephemeral_1h_input_tokens: 5 }), request(t, { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 })]))).toEqual({
      at: t,
      ttlMs: 60 * 60_000,
    });
    expect(lastCacheUse(tail([request(t, { ephemeral_5m_input_tokens: 5 })]))).toEqual({ at: t, ttlMs: 5 * 60_000 });
    expect(lastCacheUse(tail([request(t, null), '{"type":"user","timestamp":"2026-10-28T00:00:00.000Z"}']))).toEqual({ at: t });
    expect(lastCacheUse('')).toEqual({});
  });
});

describe('a Remote Control launcher', () => {
  it('adds --remote-control and the instructions, records each message, and puts its helpers on PATH', () => {
    const settings = settingsWith({});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-remote-launch-'));
    const stand = remoteStandIn({ ...helper, permissionMode: 'auto' }, settings);
    const { launcherHost } = writeTerminalLauncher(stand, { host: 'linux', settings }, root, undefined, true, {
      name: "Leandro's helper",
      systemPrompt: 'Be brief.',
      helpers: { 'looper-remote': '#!/usr/bin/env bash\n' },
      env: { LOOPER_REMOTE_DIR: root },
      settings: { idleCompaction: false },
      args: ['--setting-sources=', '--tools', 'Bash'],
      prelude: 'echo before',
    });
    const script = fs.readFileSync(launcherHost, 'utf8');
    expect(script).toContain(`--remote-control 'Leandro'\\''s helper'`);
    expect(script).toMatch(/--append-system-prompt "\$\(cat '[^']+'\)" --setting-sources= --tools Bash\n/);
    expect(script.indexOf('echo before')).toBeGreaterThan(script.indexOf('cd '));
    expect(script.indexOf('echo before')).toBeLessThan(script.indexOf('exec claude'));
    expect(script).toContain(`--append-system-prompt "$(cat '${path.join(root, 'system.txt')}')"`);
    expect(script).toContain(`export PATH='${path.join(root, 'bin')}'":$PATH"`);
    expect(script).toContain(`export LOOPER_REMOTE_DIR='${root}'`);
    expect(fs.readFileSync(path.join(root, 'system.txt'), 'utf8')).toBe('Be brief.');
    expect(fs.existsSync(path.join(root, 'bin', 'looper-remote'))).toBe(true);
    const s = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
    expect(s.idleCompaction).toBe(false);
    expect(Object.keys(s.hooks)).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit', 'Notification']);
  });

  it('passes a first message after --, so a variadic option before it cannot take it', () => {
    const settings = settingsWith({});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-remote-launch-'));
    const { launcherHost } = writeTerminalLauncher(task('t1'), { host: 'linux', settings }, root, undefined, true, {
      name: 'Site',
      args: ['--tools', 'Bash'],
      prompt: 'Fix the footer',
    });
    expect(fs.readFileSync(launcherHost, 'utf8')).toContain(`--tools Bash -- "$(cat '${path.join(root, 'initial-prompt.txt')}')"\n`);
    expect(fs.readFileSync(path.join(root, 'initial-prompt.txt'), 'utf8')).toBe('Fix the footer');
  });

  it('a plain terminal session has no remote flags, and records its turns and notifications for the Sessions window', () => {
    const settings = settingsWith({});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-remote-launch-'));
    const { launcherHost } = writeTerminalLauncher(task('t1'), { host: 'linux', settings }, root, undefined, true);
    const script = fs.readFileSync(launcherHost, 'utf8');
    expect(script).not.toContain('--remote-control');
    expect(script).not.toContain('export PATH');
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).hooks)).toEqual([
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
      'Notification',
    ]);
  });
});
