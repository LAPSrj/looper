import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalInfo } from '../src/shared/chat';
import type { MessageRow } from '../src/shared/messages';
import type { RunRecord, Task } from '../src/shared/types';
import { Logger } from '../src/engine/log';
import { writeTerminalLauncher } from '../src/engine/open-terminal';
import { TerminalRuns } from '../src/engine/terminal-runs';
import { SettingsSchema, TaskSchema } from '../src/shared/types';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'looper-terminal-runs-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(rows: MessageRow[] = [{ id: '0', kind: 'prompt', text: 'Fix the footer\nand deploy', preview: '' }]) {
  const root = tmp();
  const records: RunRecord[] = [];
  const infos: Record<string, TerminalInfo> = {};
  const runs = new TerminalRuns({
    runDir: (_t, runId) => path.join(root, runId),
    readHistory: async () => rows,
    writeInfo: (_t, runId, info) => (infos[runId] = info),
    appendRecord: (r) => records.push(r),
    taskVersion: () => 3,
    log: new Logger(),
    pollMs: 20,
  });
  const dir = (runId: string) => {
    fs.mkdirSync(path.join(root, runId), { recursive: true });
    return path.join(root, runId);
  };
  return { runs, records, infos, dir };
}

let open: TerminalRuns[] = [];
afterEach(() => {
  for (const r of open) r.closeAll();
  open = [];
});

describe('terminal sessions as runs', () => {
  it('becomes a run with its first turn, titled by its first message, and records the close', async () => {
    const { runs, records, infos, dir } = setup();
    open.push(runs);
    const d = dir('r1');
    runs.start({ taskId: 't', runId: 'r1', harnessKind: 'claude-code' });
    await sleep(80);
    expect(records).toEqual([]);
    fs.writeFileSync(path.join(d, 'stop.json'), '{"session_id":"s1"}');
    await sleep(80);
    expect(infos.r1).toEqual({ harnessKind: 'claude-code', title: 'Fix the footer' });
    expect(records.map((r) => [r.phase, r.result, r.summary, r.detail?.event, r.taskVersion])).toEqual([
      ['terminal', 'terminal', 'Fix the footer', 'opened', 3],
    ]);
    runs.close('r1');
    expect(records[1].detail?.event).toBe('closed');
    expect(records[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(d)).toBe(true);
  });

  it('leaves nothing behind when the window closes before a turn', () => {
    const { runs, records, dir } = setup();
    const d = dir('r1');
    runs.start({ taskId: 't', runId: 'r1', harnessKind: 'claude-code' });
    runs.close('r1');
    expect(records).toEqual([]);
    expect(fs.existsSync(d)).toBe(false);
  });

  it("opened again, waits for a turn newer than the window and keeps the run's title and folder", async () => {
    const { runs, records, dir } = setup([]);
    open.push(runs);
    const d = dir('r1');
    fs.writeFileSync(path.join(d, 'stop.json'), '{"session_id":"s1"}');
    fs.utimesSync(path.join(d, 'stop.json'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    runs.start({ taskId: 't', runId: 'r1', harnessKind: 'claude-code', info: { harnessKind: 'claude-code', title: 'Old title' } });
    await sleep(80);
    expect(records).toEqual([]);
    runs.close('r1');
    expect(fs.existsSync(d)).toBe(true);
    runs.start({ taskId: 't', runId: 'r1', harnessKind: 'claude-code', info: { harnessKind: 'claude-code', title: 'Old title' } });
    fs.writeFileSync(path.join(d, 'stop.json'), '{"session_id":"s1"}');
    await sleep(80);
    expect(records.map((r) => r.summary)).toEqual(['Old title']);
  });

  it("records codex's thread id, skipping the side thread that names the session", async () => {
    const { runs, records, dir } = setup();
    open.push(runs);
    const d = dir('r1');
    runs.start({ taskId: 't', runId: 'r1', harnessKind: 'codex', fromRunId: 'r0' });
    fs.writeFileSync(
      path.join(d, 'stop.json'),
      JSON.stringify({ 'thread-id': 'side', 'input-messages': ['Generate a concise, single-line task title for…'] }),
    );
    await sleep(80);
    expect(records).toEqual([]);
    fs.writeFileSync(path.join(d, 'stop.json'), JSON.stringify({ 'thread-id': 'thread-1', 'input-messages': ['hi'] }));
    await sleep(80);
    expect(JSON.parse(fs.readFileSync(path.join(d, 'codex-session.json'), 'utf8'))).toEqual({ thread_id: 'thread-1' });
    expect(records[0].detail).toEqual({ event: 'opened', fromRunId: 'r0' });
    // The open window holds the conversation, by its run, the run it went on with, or the session.
    expect(runs.findOpen('t', 'r1', 'x')).toBe('r1');
    expect(runs.findOpen('t', 'r0', 'x')).toBe('r1');
    expect(runs.findOpen('t', 'other', 'thread-1')).toBe('r1');
    expect(runs.findOpen('t', 'other', 'x')).toBeUndefined();
  });

  it('a window closed while its first turn is being recorded still becomes a run, and closes', async () => {
    let release: () => void = () => {};
    const root = tmp();
    const records: RunRecord[] = [];
    const runs = new TerminalRuns({
      runDir: (_t, runId) => path.join(root, runId),
      readHistory: () => new Promise((r) => (release = () => r([{ id: '0', kind: 'prompt', text: 'hi', preview: '' }]))),
      writeInfo: () => {},
      appendRecord: (r) => records.push(r),
      taskVersion: () => undefined,
      log: new Logger(),
      pollMs: 20,
    });
    const d = path.join(root, 'r1');
    fs.mkdirSync(d);
    runs.start({ taskId: 't', runId: 'r1', harnessKind: 'claude-code' });
    fs.writeFileSync(path.join(d, 'stop.json'), '{}');
    await sleep(80);
    runs.close('r1');
    release();
    await sleep(20);
    expect(records.map((r) => [r.summary, r.detail?.event])).toEqual([
      ['hi', 'opened'],
      ['hi', 'closed'],
    ]);
    expect(fs.existsSync(d)).toBe(true);
  });
});

describe('terminal launcher hooks', () => {
  const settings = SettingsSchema.parse({});
  const task = (harnessId: string): Task =>
    TaskSchema.parse({
      id: 't1',
      name: 'T',
      cwd: '/work',
      environmentId: 'local',
      trigger: { mode: 'manual' },
      agent: { harnessId, prompt: 'x', permissionMode: '' },
    });
  const withHarness = (kind: 'claude-code' | 'codex') =>
    SettingsSchema.parse({
      ...settings,
      environments: settings.environments.map((e) =>
        e.id === 'local' ? { ...e, harnesses: [{ id: 'h', name: 'H', kind, command: kind === 'codex' ? 'codex' : 'claude' }] } : e,
      ),
    });

  it('gives claude the settings with the SessionStart and Stop hooks', () => {
    const dir = tmp();
    const { launcherHost } = writeTerminalLauncher(task('h'), { host: 'linux', settings: withHarness('claude-code') }, dir, undefined, true);
    const script = fs.readFileSync(launcherHost, 'utf8');
    expect(script).toContain(`--settings '${path.join(dir, 'settings.json')}'`);
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).hooks;
    expect(hooks.SessionStart[0].hooks[0].command).toBe(`cat > '${path.join(dir, 'session.json')}'`);
    expect(hooks.Stop[0].hooks[0].command).toBe(`cat > '${path.join(dir, 'stop.json')}'`);
  });

  it("gives codex the notify hook and records its home before it starts", () => {
    const dir = tmp();
    const { launcherHost } = writeTerminalLauncher(task('h'), { host: 'linux', settings: withHarness('codex') }, dir, 'thread-1', true);
    const script = fs.readFileSync(launcherHost, 'utf8');
    expect(script).toContain(`> '${path.join(dir, 'codex-home')}'\nexec codex`);
    expect(script).toContain(`'notify=['\\''bash'\\'','\\''${path.join(dir, 'bin', 'looper-notify')}'\\'']' resume 'thread-1'`);
    expect(fs.readFileSync(path.join(dir, 'bin', 'looper-notify'), 'utf8')).toContain(`> '${path.join(dir, 'stop.json')}'`);
  });

  it("gives a session nothing records (the system's terminal) no hooks", () => {
    const dir = tmp();
    const { launcherHost } = writeTerminalLauncher(task('h'), { host: 'linux', settings: withHarness('codex') }, dir, 'thread-1');
    expect(fs.readFileSync(launcherHost, 'utf8')).toContain("\nexec codex resume 'thread-1'\n");
    expect(fs.readdirSync(dir)).toEqual(['terminal.sh']);
  });
});
