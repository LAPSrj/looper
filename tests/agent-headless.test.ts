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
    expect(s.usageLimit).toBe(true);
    expect(s.usageLimitResetMs).toBe(1_700_000_000_000);
    expect(s.structured).toEqual({ act: true });
    expect(s.costUsd).toBe(0.02);
    expect(s.network).toBe(false);
  });

  // Codex --json JSONL, captured live from codex-cli 0.154.0.
  it('reads a codex stream: thread id, last agent message, clean end', () => {
    const s = replay([
      JSON.stringify({ type: 'thread.started', thread_id: '01a09c02-3a24-7f73-b40f-a7c458d908fd' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'pong' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 15256, output_tokens: 5 } }),
    ]);
    expect(s.sessionId).toBe('01a09c02-3a24-7f73-b40f-a7c458d908fd');
    expect(s.result).toBe('pong');
    expect(s.isError).toBe(false);
    expect(s.network).toBe(false);
  });

  it('reads a codex failure off error/turn.failed, and a completed turn clears earlier errors', () => {
    const failMsg = '{"type":"error","status":400,"error":{"message":"The model is not supported."}}';
    const failed = replay([
      JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
      JSON.stringify({ type: 'error', message: failMsg }),
      JSON.stringify({ type: 'turn.failed', error: { message: failMsg } }),
    ]);
    expect(failed.isError).toBe(true);
    expect(failed.errorMessage).toBe(failMsg);
    expect(failed.network).toBe(false);

    const recovered = replay([
      JSON.stringify({ type: 'error', message: 'transient' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done anyway' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ]);
    expect(recovered.isError).toBe(false);
    expect(recovered.result).toBe('done anyway');
  });

  it('classifies a codex network failure and a usage limit', () => {
    const offline = replay([
      JSON.stringify({ type: 'turn.failed', error: { message: 'error sending request for url (https://chatgpt.com/backend-api/codex)' } }),
    ]);
    expect(offline.isError).toBe(true);
    expect(offline.network).toBe(true);

    const limited = replay([
      JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit." } }),
    ]);
    expect(limited.usageLimit).toBe(true);
    expect(limited.network).toBe(false);
  });
});

function fakeHarness(dir: string, body: string): string {
  const file = path.join(dir, 'fake-claude');
  writeText(file, `#!/usr/bin/env bash\n${body}\n`, 0o755);
  return file;
}

function makeCtx(
  harnessCommand: string,
  taskExtra: Record<string, unknown> = {},
  kind: 'claude-code' | 'codex' = 'claude-code',
): RunContext {
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
        harnesses: [{ id: 'fake', name: 'Fake', kind, command: harnessCommand }],
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

  it('passes the effort level: --effort for claude, the config override for codex', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(root, `echo '{"type":"result","result":"ok"}'`);

    const claude = makeCtx(harness);
    claude.task.agent.effort = 'high';
    await (await startAgent(claude, { onData: () => {} })).finished;
    expect(fs.readFileSync(path.join(claude.runDir, 'run.sh'), 'utf8')).toContain("--effort 'high'");

    const codex = makeCtx(harness, {}, 'codex');
    codex.task.agent.effort = 'xhigh';
    await (await startAgent(codex, { onData: () => {} })).finished;
    expect(fs.readFileSync(path.join(codex.runDir, 'run.sh'), 'utf8')).toContain("-c 'model_reasoning_effort=xhigh'");
  });

  it("without a task pin, the model entry's default effort is emitted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(root, `echo '{"type":"result","result":"ok"}'`);
    // The example task runs 'sonnet', a default-list entry (defaultEffort medium).
    const ctx = makeCtx(harness);
    await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(fs.readFileSync(path.join(ctx.runDir, 'run.sh'), 'utf8')).toContain("--effort 'medium'");

    // A model id with no entry has no default to resolve: the flag is omitted.
    const custom = makeCtx(harness);
    custom.task.agent.model = 'claude-opus-4-1';
    await (await startAgent(custom, { onData: () => {} })).finished;
    expect(fs.readFileSync(path.join(custom.runDir, 'run.sh'), 'utf8')).not.toContain('--effort');
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

  it('codex: exec with the permission, json and git-check flags; the stream yields report and thread id', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(
      root,
      [
        `echo '{"type":"thread.started","thread_id":"01a09c02-3a24-7f73-b40f-a7c458d908fd"}'`,
        `echo '{"type":"item.completed","item":{"type":"agent_message","text":"Rotated 3 logs"}}'`,
        `echo '{"type":"turn.completed","usage":{}}'`,
      ].join('\n'),
    );
    const ctx = makeCtx(harness, {}, 'codex');
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('done');
    expect(end.body).toBe('Rotated 3 logs');
    expect(end.headline).toBe('Rotated 3 logs');
    expect(end.sessionId).toBe('01a09c02-3a24-7f73-b40f-a7c458d908fd');
    const launcher = fs.readFileSync(path.join(ctx.runDir, 'run.sh'), 'utf8');
    expect(launcher).toContain('exec --approve-for-me --add-dir ');
    expect(launcher).toContain(`--add-dir '${ctx.runDir}'`);
    expect(launcher).toContain("--model 'sonnet' --json --skip-git-repo-check");
    expect(launcher).not.toContain('--permission-mode');
    // The launcher records the target-native codex home for the Messages view…
    expect(launcher).toContain('CODEX_HOME');
    expect(fs.existsSync(path.join(ctx.runDir, 'codex-home'))).toBe(true);
    // …and the session records the thread id as soon as the stream names it.
    const ref = JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'codex-session.json'), 'utf8'));
    expect(ref).toEqual({ thread_id: '01a09c02-3a24-7f73-b40f-a7c458d908fd' });
    // No system-prompt flag: the footer rides at the top of the prompt itself.
    const prompt = fs.readFileSync(path.join(ctx.runDir, 'prompt.txt'), 'utf8');
    expect(prompt).toContain('started by Looper');
  });

  it('codex: a continued conversation resumes the thread, and a lost one flags sessionLost', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const ok = fakeHarness(root, `echo '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'`);
    const continued = makeCtx(ok, {}, 'codex');
    continued.agentSession = { id: '01a09c02-3a24-7f73-b40f-a7c458d908fd', resume: true };
    await (await startAgent(continued, { onData: () => {} })).finished;
    const launcher = fs.readFileSync(path.join(continued.runDir, 'run.sh'), 'utf8');
    expect(launcher).toContain(`resume '01a09c02-3a24-7f73-b40f-a7c458d908fd'`);

    const lostFile = path.join(root, 'fake-codex-lost');
    writeText(
      lostFile,
      '#!/usr/bin/env bash\necho "Error: thread/resume failed: no rollout found for thread id 01a09c02 (code -32600)" >&2\nexit 1\n',
      0o755,
    );
    const lost = makeCtx(lostFile, {}, 'codex');
    lost.agentSession = { id: '01a09c02-3a24-7f73-b40f-a7c458d908fd', resume: true };
    const end = await (await startAgent(lost, { onData: () => {} })).finished;
    expect(end.reason).toBe('error');
    expect(end.sessionLost).toBe(true);
  });

  it('codex: a failed turn keeps the error message as headline and body', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(
      root,
      [
        `echo '{"type":"error","message":"The model is not supported."}'`,
        `echo '{"type":"turn.failed","error":{"message":"The model is not supported."}}'`,
        `exit 1`,
      ].join('\n'),
    );
    const end = await (await startAgent(makeCtx(harness, {}, 'codex'), { onData: () => {} })).finished;
    expect(end.reason).toBe('exited');
    expect(end.headline).toBe('The model is not supported.');
    expect(end.body).toBe('The model is not supported.');
  });
});
