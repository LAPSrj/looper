import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { runClassify } from '../src/engine/steps/classify';
import type { RunContext } from '../src/engine/steps/common';
import { writeText } from '../src/engine/store/fsutil';
import { createTarget } from '../src/engine/target';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { SettingsSchema, TaskSchema } from '../src/shared/types';

// The headless classifier through the real launcher and spawn path, with a
// fake harness standing in for `claude -p --output-format stream-json`.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeHarness(dir: string, body: string): string {
  const file = path.join(dir, 'fake-claude');
  writeText(file, `#!/usr/bin/env bash\n${body}\n`, 0o755);
  return file;
}

function makeCtx(harnessCommand: string, extra: Record<string, unknown> = {}): RunContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-classify-'));
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
    agent: { ...EXAMPLE_TASK.agent, harnessId: 'fake' },
    classifier: { model: 'haiku', prompt: 'act or not? {{summary}}', timeoutSec: 30 },
    ...extra,
  });
  return {
    task,
    runId: 'r1',
    runDir,
    target: createTarget(task, { host: 'linux', settings }),
    settings,
    host: 'linux',
    log: new Logger(),
    vars: { summary: '3 items' },
  };
}

const resultLine = (extra: Record<string, unknown>): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...extra });

describe('headless classifier over pipes', () => {
  it('reads the verdict from the structured output and keeps its files under classify-*', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const line = resultLine({
      result: '{"act":true,"reason":"real work"}',
      structured_output: { act: true, reason: 'real work' },
      total_cost_usd: 0.012,
    });
    const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    const harness = fakeHarness(root, [`echo '{"type":"system","subtype":"init"}'`, `printf '%s\\n' ${sq(line)}`].join('\n'));
    const ctx = makeCtx(harness);
    const r = await runClassify(ctx, { onData: () => {} });

    expect(r.status).toBe('act');
    expect(r.reason).toBe('real work');
    expect(r.costUsd).toBe(0.012);

    // The rendered prompt saw the check summary.
    expect(fs.readFileSync(path.join(ctx.runDir, 'classify-prompt.txt'), 'utf8')).toContain('3 items');
    // The full stream is logged, one line per record.
    const clean = fs.readFileSync(path.join(ctx.runDir, 'classify-output.txt'), 'utf8');
    expect(clean.split('\n').filter(Boolean)).toHaveLength(2);
    // Headless settings carry the transcript hook but no Stop gate (that would cost an extra turn per run).
    const settings = JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'classify-settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('classify-session.json');
    expect(settings.hooks.Stop).toBeUndefined();
    expect(settings.permissions.allow).toContain('Bash(looper-classify:*)');
    // The schema drives --json-schema; the launcher defines looper-classify with act|noop.
    expect(JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'classify-schema.json'), 'utf8')).required).toEqual(['act', 'reason']);
    const launcher = fs.readFileSync(path.join(ctx.runDir, 'classify.sh'), 'utf8');
    expect(launcher).toContain('looper-classify()');
    expect(launcher).toContain('act|noop');
    expect(launcher).toContain(`export LOOPER_DONE_FILE='${path.join(ctx.runDir, 'classify-done')}'`);
    expect(fs.existsSync(path.join(ctx.runDir, 'bin', 'looper-classify'))).toBe(true);
    // Nothing of the agent step's namespace is touched.
    expect(fs.existsSync(path.join(ctx.runDir, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(ctx.runDir, 'output.txt'))).toBe(false);
  });

  it('appends the run\'s one-off note to the classifier prompt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const line = resultLine({ result: '{"act":false,"reason":"nothing"}', structured_output: { act: false, reason: 'nothing' } });
    const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    const harness = fakeHarness(root, [`echo '{"type":"system","subtype":"init"}'`, `printf '%s\\n' ${sq(line)}`].join('\n'));
    const ctx = makeCtx(harness, { note: { text: 'Only act after the release freeze lifts.', runsLeft: 1 } });
    await runClassify(ctx, { onData: () => {} });
    const prompt = fs.readFileSync(path.join(ctx.runDir, 'classify-prompt.txt'), 'utf8');
    expect(prompt).toContain('## One-off guidance for this run');
    expect(prompt.trim().endsWith('Only act after the release freeze lifts.')).toBe(true);
  });

  it('a result without structured output is an error, not a verdict', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(root, `echo '${resultLine({ result: 'free text answer' })}'`);
    const ctx = makeCtx(harness);
    const r = await runClassify(ctx, { onData: () => {} });
    expect(r.status).toBe('error');
    expect(r.error).toContain('no verdict');
    expect(r.body).toBe('free text answer');
  });

  it('reports a non-zero exit as an error with the output tail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-fake-'));
    dirs.push(root);
    const harness = fakeHarness(root, `echo 'boom' >&2\nexit 2`);
    const ctx = makeCtx(harness);
    const r = await runClassify(ctx, { onData: () => {} });
    expect(r.status).toBe('error');
    expect(r.error).toContain('exited 2');
  });
});
