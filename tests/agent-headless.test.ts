import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { startAgent } from '../src/engine/steps/agent';
import type { RunContext } from '../src/engine/steps/common';
import { writeText } from '../src/engine/store/fsutil';
import { createTarget } from '../src/engine/target';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { SettingsSchema, TaskSchema } from '../src/shared/types';

// Headless runs use plain pipes: a pty would hard-wrap long stream-json lines
// at the terminal width and the result object would never parse. These tests
// run a fake harness through the real launcher and the real spawn path.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A one-line "final message" far longer than any terminal width, in real stream-json key order. */
const REPORT = 'Fixed the divider\n\n' + 'Details: ' + 'x'.repeat(20_000) + ' end.';

function fakeHarness(dir: string, body: string): string {
  const file = path.join(dir, 'fake-claude');
  writeText(file, `#!/usr/bin/env bash\n${body}\n`, 0o755);
  return file;
}

function makeCtx(harnessCommand: string, taskExtra: Record<string, unknown> = {}): RunContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-headless-'));
  dirs.push(root);
  const runDir = path.join(root, 'run');
  fs.mkdirSync(path.join(runDir, 'bin'), { recursive: true });
  const settings = SettingsSchema.parse({
    environments: [
      {
        id: 'local',
        name: 'Local',
        kind: 'local',
        // No profile: keep the test independent of the machine's shell setup.
        shell: 'bash -c',
        harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code', command: harnessCommand }],
      },
    ],
  });
  const task = TaskSchema.parse({
    ...EXAMPLE_TASK,
    cwd: root,
    ...taskExtra,
    agent: { ...EXAMPLE_TASK.agent, harnessId: 'fake', mode: 'headless', maxRuntimeMin: 1 },
  });
  return {
    task,
    runId: 'r1',
    runDir,
    target: createTarget(task, { host: 'linux', settings }),
    settings,
    host: 'linux',
    log: new Logger(),
    vars: {},
  };
}

describe('headless agent over pipes', () => {
  it('parses a result line longer than any terminal width and keeps stderr out of output.txt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const resultLine = JSON.stringify({
      subtype: 'success',
      is_error: false,
      result: REPORT,
      type: 'result',
      duration_ms: 5,
    });
    const harness = fakeHarness(
      root,
      [
        `echo 'shell warning on stderr' >&2`,
        `echo '{"type":"system","subtype":"init"}'`,
        `printf '%s\\n' '${resultLine}'`,
      ].join('\n'),
    );
    const ctx = makeCtx(harness);
    const shown: string[] = [];
    const handle = await startAgent(ctx, { onData: (d) => shown.push(d) });
    const end = await handle.finished;

    expect(end.reason).toBe('done');
    expect(end.exitCode).toBe(0);
    expect(end.body).toBe(REPORT);
    expect(end.headline).toBe('Fixed the divider');

    const clean = fs.readFileSync(path.join(ctx.runDir, 'output.txt'), 'utf8');
    const lines = clean.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ type: 'result', result: REPORT });
    expect(clean).not.toContain('shell warning');

    const raw = fs.readFileSync(path.join(ctx.runDir, 'output.log'), 'utf8');
    expect(raw).toContain('shell warning on stderr');
    expect(raw).toContain(resultLine);

    // The terminal tab gets CRLF-terminated lines, never bare LF.
    const display = shown.join('');
    expect(display).toContain('shell warning on stderr\r\n');
    expect(display.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('drops the job-control warnings of an interactive shell, even split across writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(
      root,
      [
        // Written in pieces so a line boundary never coincides with a chunk boundary.
        `printf 'bash: cannot set terminal process' >&2`,
        `sleep 0.05`,
        `printf ' group (-1): Inappropriate ioctl for device\\nbash: no job control in this shell\\nkept: real warning\\n' >&2`,
        `echo '{"type":"result","result":"ok"}'`,
      ].join('\n'),
    );
    const ctx = makeCtx(harness);
    const shown: string[] = [];
    const handle = await startAgent(ctx, { onData: (d) => shown.push(d) });
    const end = await handle.finished;
    expect(end.reason).toBe('done');
    const raw = fs.readFileSync(path.join(ctx.runDir, 'output.log'), 'utf8');
    expect(raw).not.toContain('terminal process group');
    expect(raw).not.toContain('no job control');
    expect(raw).toContain('kept: real warning');
    const display = shown.join('');
    expect(display).not.toContain('no job control');
    expect(display).toContain('kept: real warning\r\n');
  });

  it('carries the looper-done status through to the agent end', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(
      root,
      [
        `looper-done warning "Deployed with caveats"`,
        `echo '{"type":"result","result":"Deployed, but the cache config needs a look."}'`,
      ].join('\n'),
    );
    const ctx = makeCtx(harness);
    const handle = await startAgent(ctx, { onData: () => {} });
    const end = await handle.finished;
    expect(end.reason).toBe('done');
    expect(end.doneStatus).toBe('warning');
    expect(end.headline).toBe('Deployed with caveats');
    expect(end.body).toBe('Deployed, but the cache config needs a look.');
  });

  it('ends as an error with a retry time when the usage limit is hit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    // The lines a real usage-limited run produces (captured from claude 2.1.258).
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    const message = "You've hit your session limit · resets 5:50am (America/Sao_Paulo)";
    const rateLine = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', overageStatus: 'rejected' },
    });
    const resultLine = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      terminal_reason: 'api_error',
      result: message,
      num_turns: 1,
    });
    const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    const harness = fakeHarness(
      root,
      [
        `printf '%s\\n' ${sq(rateLine)}`,
        `echo '{"type":"system","subtype":"init"}'`,
        `printf '%s\\n' ${sq(resultLine)}`,
        `exit 1`,
      ].join('\n'),
    );
    const ctx = makeCtx(harness);
    const handle = await startAgent(ctx, { onData: () => {} });
    const end = await handle.finished;
    expect(end.reason).toBe('error');
    expect(end.headline).toBe(message);
    expect(end.body).toBe(message);
    expect(end.retryAtMs).toBe(resetsAt * 1000 + 60_000);
  });

  it('appends the one-off note after everything else in the prompt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(root, `echo '{"type":"result","result":"ok"}'`);
    const ctx = makeCtx(harness, { note: { text: 'Use the staging mirror instead.', runsLeft: 1 } });
    const handle = await startAgent(ctx, { onData: () => {} });
    await handle.finished;
    const prompt = fs.readFileSync(path.join(ctx.runDir, 'prompt.txt'), 'utf8');
    expect(prompt).toContain('## One-off guidance for this run');
    expect(prompt.trim().endsWith('Use the staging mirror instead.')).toBe(true);
  });

  it('reports a non-zero exit as exited, with whatever result it did print', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(root, `echo '{"type":"result","result":"partial"}'\nexit 3`);
    const ctx = makeCtx(harness);
    const handle = await startAgent(ctx, { onData: () => {} });
    const end = await handle.finished;
    expect(end.reason).toBe('exited');
    expect(end.exitCode).toBe(3);
    expect(end.headline).toBe('Fake exited 3');
    expect(end.body).toBe('partial');
  });
});
