import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { writeTerminalLauncher, type RemoteLaunch } from '../src/engine/open-terminal';
import { RemoteControl, remoteStandIn } from '../src/engine/remote';
import { createTarget } from '../src/engine/target';
import type { RemoteState } from '../src/shared/remote';
import { SettingsSchema, TaskSchema, type Settings, type Task } from '../src/shared/types';

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

interface Started {
  runId: string;
  task: Task;
  dir: string;
  launch: RemoteLaunch;
  resume?: string;
}

function setup(remote: unknown, opts: { tasks?: Task[]; now?: () => number; output?: (n: number) => string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-remote-'));
  const settings = settingsWith(remote);
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
    getTask: (id) => opts.tasks?.find((t) => t.id === id),
    listTasks: () => opts.tasks ?? [],
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
  return { rc, root, settings, started, closed, writes, outputs, states };
}

const touch = (file: string) => fs.writeFileSync(file, '{}');

let open: RemoteControl[] = [];
afterEach(() => {
  for (const rc of open) rc.stop();
  open = [];
});

const helper = { id: 'h1', name: 'Helper', environmentId: 'local', cwd: '/home/me' };

describe('Remote Control', () => {
  it('gives every helper and project a session when it starts, and ends them all when it stops', () => {
    const { rc, started, closed } = setup(
      {
        helpers: [helper],
        projects: [
          { kind: 'task', id: 'p1', taskId: 't1' },
          { kind: 'folder', id: 'p2', name: 'Site', environmentId: 'local', cwd: '/home/me/site', model: 'opus' },
        ],
      },
      { tasks: [task('t1')] },
    );
    rc.start();
    expect(started.map((s) => [s.task.id, s.launch.name, s.task.cwd])).toEqual([
      ['@remote-h1', 'Helper', '/home/me'],
      ['t1', 'Task t1', '/home/me/proj'],
      ['@remote-p2', 'Site', '/home/me/site'],
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

  it("a task project's own name names its sessions instead of the task's", () => {
    const { rc, started } = setup(
      { projects: [{ kind: 'task', id: 'p1', taskId: 't1', name: 'Site work' }] },
      { tasks: [task('t1')], output: (n) => `https://claude.ai/code/session_${n}z` },
    );
    rc.start();
    expect(started[0].launch.name).toBe('Site work');
    expect(rc.state().conversations[0].name).toBe('Site work');
  });

  it("a helper gets Looper's instructions, the looper-remote command and settings that let it run unasked", () => {
    const { rc, started } = setup({ helpers: [helper] });
    rc.start();
    const l = started[0].launch;
    expect(l.systemPrompt).toContain('looper-remote open');
    expect(l.systemPrompt).toContain('looper-remote recent');
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
    const day = new Date().toISOString().slice(0, 10);
    expect(out[0]).toBe(`- ${fresh} (last session ${day})`);
    expect(out[1]).toMatch(new RegExp(`^- ${old} \\(last session \\d{4}-\\d{2}-\\d{2}\\)$`));
    expect(out[2]).toBe(`- ${never}`);
    expect(out).toHaveLength(3);
  });

  it("a project's used conversation is its only one, and another opens once it ends", async () => {
    let t = 0;
    const { rc, started } = setup({ projects: [{ kind: 'task', id: 'p1', taskId: 't1' }] }, { tasks: [task('t1')], now: () => t });
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
    const { rc, started } = setup({ projects: [{ kind: 'task', id: 'p1', taskId: 't1' }] }, { tasks: [task('t1')] });
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
    const { rc, started } = setup({ projects: [{ kind: 'task', id: 'p1', taskId: 't1' }] }, { tasks: [task('t1')] });
    rc.start();
    touch(path.join(started[0].dir, 'prompt.json'));
    await sleep(30);
    touch(path.join(started[0].dir, 'stop.json'));
    await sleep(100);
    expect(rc.state().conversations[0]).toMatchObject({ id: 'r1', status: 'idle', title: 'Fix the footer' });
    rc.stopConversation('r1');
    const listed = rc.state().conversations.find((c) => c.id === 'r1');
    expect(listed).toMatchObject({ status: 'ended', title: 'Fix the footer', taskId: 't1' });
    // An empty conversation leaves no trace.
    const waiting = rc.state().conversations.find((c) => c.status === 'waiting');
    rc.stop();
    expect(rc.state().conversations.some((c) => c.id === waiting?.id)).toBe(false);
  });

  it("lists each conversation's last message on one line, and keeps it once the conversation ends", async () => {
    const { rc, started } = setup({ projects: [{ kind: 'task', id: 'p1', taskId: 't1' }] }, { tasks: [task('t1')] });
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
    const { rc, started, closed } = setup({ projects: [{ kind: 'task', id: 'p1', taskId: 't1' }] }, { tasks: [task('t1')] });
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
    const { rc, started } = setup({ helpers: [helper], projects: [{ kind: 'task', id: 'p1', taskId: 't1' }] }, { tasks: [task('t1')] });
    expect(() => rc.restartConversation('r1')).toThrow('Start Remote Control first.');
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
    const { rc, started, outputs } = setup({ projects: [{ kind: 'task', id: 'p1', taskId: 't1' }] }, { tasks: [task('t1')], now: () => t });
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

  it("says why an entry can't start: a deleted task, no working directory, a harness that isn't Claude Code", () => {
    const { rc, started } = setup({
      helpers: [{ ...helper, cwd: '' }],
      projects: [{ kind: 'task', id: 'p1', taskId: 'gone' }],
    });
    rc.start();
    expect(started).toHaveLength(0);
    expect(rc.state().problems).toEqual({
      'helper:h1': 'Choose its working directory.',
      'project:p1': 'The task no longer exists.',
    });
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
    const { rc, settings, started, closed } = setup({
      projects: [
        { kind: 'task', id: 'p1', taskId: 't1' },
        { kind: 'task', id: 'p2', taskId: 't2' },
      ],
    }, { tasks: [task('t1'), task('t2')] });
    rc.start();
    touch(path.join(started[1].dir, 'prompt.json'));
    await sleep(60);
    settings.remote.projects = [];
    rc.settingsChanged();
    expect(closed).toEqual(['r1']);
    expect(rc.liveCount()).toBe(1);
  });

  it('looper-remote: lists what it can open, opens a task or a folder, and refuses a folder that is not there', async () => {
    const tasks = [task('site', '/home/me/site')];
    const { rc, root, started } = setup(
      { helpers: [{ ...helper, cwd: '', model: 'sonnet', effort: 'low' }], projects: [{ kind: 'task', id: 'p1', taskId: 'site' }] },
      { tasks, output: (n) => `connected https://claude.ai/code/session_${n}x` },
    );
    // The helper's folder: a real one, so an opened path can be checked.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-remote-home-'));
    fs.mkdirSync(path.join(home, 'repo'));
    (rc as unknown as { d: { settings: Settings } }).d.settings.remote.helpers[0].cwd = home;
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
    expect((await ask('list')).out).toContain('- Task site (task site): /home/me/site');
    const byTask = await ask('open', 'site');
    expect(byTask.code).toBe('0');
    expect(byTask.out).toMatch(/^Opened "Task site" in \/home\/me\/site\.\nLink: https:\/\/claude\.ai\/code\/session_\d+x/);
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
    expect(rc.state().conversations.filter((c) => c.source === 'opened')).toHaveLength(2);
    void root;
  });

  it("keeps a folder project's or helper's stand-in task, so its conversations stay readable", () => {
    const { rc } = setup({ projects: [{ kind: 'folder', id: 'p2', name: 'Site', environmentId: 'local', cwd: '/home/me/site' }] });
    rc.start();
    expect(rc.standIn('@remote-p2')).toMatchObject({ id: '@remote-p2', name: 'Site', environmentId: 'local', cwd: '/home/me/site' });
    expect(rc.standIn('t1')).toBeUndefined();
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
    expect(Object.keys(s.hooks)).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit']);
  });

  it('a plain terminal session records no messages and has no remote flags', () => {
    const settings = settingsWith({});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-remote-launch-'));
    const { launcherHost } = writeTerminalLauncher(task('t1'), { host: 'linux', settings }, root, undefined, true);
    const script = fs.readFileSync(launcherHost, 'utf8');
    expect(script).not.toContain('--remote-control');
    expect(script).not.toContain('export PATH');
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).hooks)).toEqual(['SessionStart', 'Stop']);
  });
});
