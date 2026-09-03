import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { BashTarget, WindowsTarget } from '../src/engine/target';
import { STOP_BLOCK_BACKGROUND, STOP_BLOCK_NO_DONE } from '../src/engine/target/stop-hook';

// The Stop-hook gate, run for real (bash): block while background tasks run,
// remind once about looper-done, otherwise record the payload in stop.json.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface Gate {
  dir: string;
  stopJson: string;
  doneFile: string;
  reminderFile: string;
  run(payload: unknown): string;
}

function makeGate(): Gate {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-stophook-'));
  dirs.push(dir);
  const stopJson = path.join(dir, 'stop.json');
  const doneFile = path.join(dir, 'done');
  const reminderFile = path.join(dir, 'stop-reminded');
  const script = path.join(dir, 'looper-stop-hook');
  const t = new BashTarget({ host: 'wsl' }, undefined);
  fs.writeFileSync(script, t.renderStopHook({ stopJson, doneFile, reminderFile }), { mode: 0o755 });
  return {
    dir,
    stopJson,
    doneFile,
    reminderFile,
    run(payload: unknown): string {
      const r = spawnSync('bash', [script], { input: JSON.stringify(payload), encoding: 'utf8' });
      expect(r.status).toBe(0);
      return r.stdout;
    },
  };
}

const runningTask = { id: 'a1', type: 'shell', status: 'running', description: 'watch deploy', command: 'node watch.js --need 1' };

describe('bash Stop-hook gate', () => {
  it('blocks while a background task is running and leaves no signal files', () => {
    const g = makeGate();
    const out = g.run({ last_assistant_message: 'waiting', background_tasks: [runningTask] });
    expect(JSON.parse(out)).toEqual(JSON.parse(STOP_BLOCK_BACKGROUND));
    expect(fs.existsSync(g.stopJson)).toBe(false);
    expect(fs.existsSync(g.reminderFile)).toBe(false);
  });

  it('blocks when a bracket inside an earlier string field precedes the status', () => {
    const g = makeGate();
    const task = {
      id: 'a1',
      type: 'shell',
      description: 'kill leftovers: for p in /proc/[0-9]*; do echo "]"; done',
      meta: { nested: [1, 2, { deep: ']' }] },
      status: 'running',
    };
    const out = g.run({ background_tasks: [task] });
    expect(JSON.parse(out)).toEqual(JSON.parse(STOP_BLOCK_BACKGROUND));
    expect(fs.existsSync(g.stopJson)).toBe(false);
  });

  it('blocks on pretty-printed JSON with whitespace around the key and colon', () => {
    const g = makeGate();
    const spaced = JSON.stringify({ background_tasks: [runningTask] }, null, 2);
    const script = path.join(g.dir, 'looper-stop-hook');
    const r = spawnSync('bash', [script], { input: spaced, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(STOP_BLOCK_BACKGROUND));
    expect(fs.existsSync(g.stopJson)).toBe(false);
  });

  it('allows when the only running mention sits inside a finished task string', () => {
    const g = makeGate();
    fs.writeFileSync(g.reminderFile, '');
    const payload = {
      background_tasks: [
        { id: 'a1', status: 'completed', description: 'was "status":"running" earlier, then ]' },
      ],
    };
    const out = g.run(payload);
    expect(out).toBe('');
    expect(JSON.parse(fs.readFileSync(g.stopJson, 'utf8'))).toEqual(payload);
  });

  it('reminds about looper-done exactly once, then lets the stop through', () => {
    const g = makeGate();
    const payload = { last_assistant_message: 'report', background_tasks: [] };
    const first = g.run(payload);
    expect(JSON.parse(first)).toEqual(JSON.parse(STOP_BLOCK_NO_DONE));
    expect(fs.existsSync(g.reminderFile)).toBe(true);
    expect(fs.existsSync(g.stopJson)).toBe(false);
    const second = g.run(payload);
    expect(second).toBe('');
    expect(JSON.parse(fs.readFileSync(g.stopJson, 'utf8'))).toEqual(payload);
  });

  it('allows any stop once looper-done ran, even with tasks still running', () => {
    const g = makeGate();
    fs.writeFileSync(g.doneFile, 'success\nAll fixed\n');
    const payload = { last_assistant_message: 'final report', background_tasks: [runningTask] };
    const out = g.run(payload);
    expect(out).toBe('');
    expect(JSON.parse(fs.readFileSync(g.stopJson, 'utf8'))).toEqual(payload);
  });

  it('ignores background_tasks text inside a message string (escaped quotes)', () => {
    const g = makeGate();
    fs.writeFileSync(g.reminderFile, '');
    const payload = {
      last_assistant_message: 'the payload had "background_tasks":[{"status":"running"}] in it',
      background_tasks: [],
    };
    const out = g.run(payload);
    expect(out).toBe('');
    expect(JSON.parse(fs.readFileSync(g.stopJson, 'utf8'))).toEqual(payload);
  });

  it('treats a missing background_tasks key as no tasks', () => {
    const g = makeGate();
    fs.writeFileSync(g.reminderFile, '');
    const payload = { last_assistant_message: 'hi' };
    g.run(payload);
    expect(JSON.parse(fs.readFileSync(g.stopJson, 'utf8'))).toEqual(payload);
  });
});

describe('windows Stop-hook gate', () => {
  it('renders a PowerShell gate with the same decisions', () => {
    const t = new WindowsTarget({ host: 'windows' });
    const script = t.renderStopHook({
      stopJson: 'C:\\data\\r1\\stop.json',
      doneFile: 'C:\\data\\r1\\done',
      reminderFile: 'C:\\data\\r1\\stop-reminded',
    });
    expect(script).toContain("Test-Path -LiteralPath 'C:\\data\\r1\\done'");
    expect(script).toContain('ConvertFrom-Json');
    expect(script).toContain(`Write-Output '${STOP_BLOCK_BACKGROUND}'`);
    expect(script).toContain(`Write-Output '${STOP_BLOCK_NO_DONE}'`);
    expect(script).toContain("[IO.File]::WriteAllText('C:\\data\\r1\\stop.json', $payload)");
    expect(t.stopHookCommand('C:\\data\\r1\\bin\\looper-stop-hook.ps1')).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/data/r1/bin/looper-stop-hook.ps1"',
    );
  });
});
