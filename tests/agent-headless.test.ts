import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { startAgent } from '../src/engine/steps/agent';
import { HeadlessStream } from '../src/engine/steps/session';
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

/** What claude streams when it cannot reach the API (captured live, claude 2.1.258). */
const OFFLINE_TEXT = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
const OFFLINE_LINES = [
  JSON.stringify({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 616,
    error_status: null,
    error: 'unknown',
    session_id: 'x',
    uuid: 'y',
  }),
  JSON.stringify({
    type: 'assistant',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: OFFLINE_TEXT }] },
    error: 'server_error',
    is_api_error_message: true,
    session_id: 'x',
    uuid: 'z',
  }),
  JSON.stringify({
    type: 'result',
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: null,
    result: OFFLINE_TEXT,
    total_cost_usd: 0,
    num_turns: 1,
    subtype: 'success',
    duration_ms: 184823,
    session_id: 'x',
    uuid: 'w',
  }),
];

describe('HeadlessStream', () => {
  const replay = (lines: string[]): HeadlessStream => {
    const s = new HeadlessStream();
    for (const l of lines) s.feed(l);
    return s;
  };

  it('reads an unreachable API off the stream', () => {
    const s = replay(OFFLINE_LINES);
    expect(s.networkRetries).toBe(1);
    expect(s.terminalReason).toBe('api_error');
    expect(s.apiErrorStatus).toBeNull();
    expect(s.result).toBe(OFFLINE_TEXT);
    expect(s.isError).toBe(true);
    expect(s.network).toBe(true);
  });

  it('an API that answered with an error is not a network failure', () => {
    const s = replay([
      JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: 429 }),
      JSON.stringify({ type: 'result', is_error: true, terminal_reason: 'api_error', api_error_status: 401, result: '401 Unauthorized' }),
    ]);
    expect(s.networkRetries).toBe(0);
    expect(s.network).toBe(false);
  });

  it('keeps reading the fields the rest of the session needs', () => {
    const s = replay([
      'not json at all',
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_700_000_000 } }),
      JSON.stringify({ type: 'result', is_error: false, result: 'all good', structured_output: { act: true }, total_cost_usd: 0.02 }),
    ]);
    expect(s.usageLimitResetMs).toBe(1_700_000_000_000);
    expect(s.structured).toEqual({ act: true });
    expect(s.costUsd).toBe(0.02);
    expect(s.network).toBe(false);
  });
});

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

  it('writes claude settings with the stop-hook gate and an unsandboxed looper-done', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(root, `echo '{"type":"result","result":"ok"}'`);
    const ctx = makeCtx(harness);
    const handle = await startAgent(ctx, { onData: () => {} });
    await handle.finished;
    const settings = JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'settings.json'), 'utf8'));
    expect(settings.permissions.allow).toContain('Bash(looper-done:*)');
    expect(settings.sandbox).toEqual({ excludedCommands: ['looper-done'] });
    const gate = path.join(ctx.runDir, 'bin', 'looper-stop-hook');
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(`bash '${gate}'`);
    expect(fs.existsSync(gate)).toBe(true);
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

  it('adds --session-id for a new rolling conversation and --resume for a continued one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(root, `echo '{"type":"result","result":"ok"}'`);

    const fresh = makeCtx(harness);
    fresh.agentSession = { id: '11111111-1111-4111-8111-111111111111', resume: false };
    await (await startAgent(fresh, { onData: () => {} })).finished;
    const freshLauncher = fs.readFileSync(path.join(fresh.runDir, 'run.sh'), 'utf8');
    expect(freshLauncher).toContain(`--session-id '11111111-1111-4111-8111-111111111111'`);
    expect(freshLauncher).not.toContain('--resume');

    const continued = makeCtx(harness);
    continued.agentSession = { id: '11111111-1111-4111-8111-111111111111', resume: true };
    await (await startAgent(continued, { onData: () => {} })).finished;
    const contLauncher = fs.readFileSync(path.join(continued.runDir, 'run.sh'), 'utf8');
    expect(contLauncher).toContain(`--resume '11111111-1111-4111-8111-111111111111'`);
    expect(contLauncher).not.toContain('--session-id');
  });

  it('ends as an error with sessionLost when the conversation to resume is gone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    // What claude prints (stderr, exit 1) when a --resume id has no conversation.
    const harness = fakeHarness(
      root,
      [`echo 'No conversation found with session ID: 11111111-1111-4111-8111-111111111111' >&2`, `exit 1`].join('\n'),
    );
    const ctx = makeCtx(harness);
    ctx.agentSession = { id: '11111111-1111-4111-8111-111111111111', resume: true };
    const handle = await startAgent(ctx, { onData: () => {} });
    const end = await handle.finished;
    expect(end.reason).toBe('error');
    expect(end.sessionLost).toBe(true);
    expect(end.headline).toContain('no longer exists');
  });

  it('never flags sessionLost when the error text appears without a resume', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(
      root,
      [`echo 'No conversation found with session ID: x' >&2`, `echo '{"type":"result","result":"ok"}'`].join('\n'),
    );
    const ctx = makeCtx(harness);
    const handle = await startAgent(ctx, { onData: () => {} });
    const end = await handle.finished;
    expect(end.reason).toBe('done');
    expect(end.sessionLost).toBeUndefined();
  });

  it('ends an unreachable API as a network error, not as a plain non-zero exit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const stream = path.join(root, 'stream.jsonl');
    writeText(stream, OFFLINE_LINES.join('\n') + '\n');
    const harness = fakeHarness(root, [`cat ${stream}`, 'exit 1'].join('\n'));
    const end = await (await startAgent(makeCtx(harness), { onData: () => {} })).finished;
    expect(end.reason).toBe('error');
    expect(end.network).toBe(true);
    expect(end.headline).toBe(OFFLINE_TEXT);
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
