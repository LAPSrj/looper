import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { setConnectivityProbe } from '../src/engine/network';
import { parseCheckOutput, runCheck } from '../src/engine/steps/check';
import { toClassifyResult } from '../src/engine/steps/classify';
import type { RunContext } from '../src/engine/steps/common';
import type { SessionEnd } from '../src/engine/steps/session';
import { stripShellNoise } from '../src/engine/steps/common';
import { createTarget } from '../src/engine/target';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { SettingsSchema, TaskSchema } from '../src/shared/types';

describe('stripShellNoise', () => {
  it('drops only the job-control warnings of a terminal-less interactive bash', () => {
    const stderr =
      'bash: cannot set terminal process group (-1): Inappropriate ioctl for device\n' +
      'bash: no job control in this shell\n' +
      'bash: bun: command not found\n' +
      'warning: something else\n';
    expect(stripShellNoise(stderr)).toBe('bash: bun: command not found\nwarning: something else\n');
    expect(stripShellNoise('')).toBe('');
  });
});

describe('parseCheckOutput', () => {
  it('reads the last JSON line', () => {
    const r = parseCheckOutput('noise\nmore noise\n{"act": true, "summary": "3 items", "context": {"ids":[1]}}\n');
    expect(r).toEqual({ ok: true, value: { act: true, summary: '3 items', context: { ids: [1] } } });
  });
  it('rejects missing act', () => {
    expect(parseCheckOutput('{"summary": "x"}').ok).toBe(false);
  });
  it('rejects non-JSON', () => {
    expect(parseCheckOutput('nothing to do').ok).toBe(false);
    expect(parseCheckOutput('').ok).toBe(false);
    expect(parseCheckOutput('[1,2]').ok).toBe(false);
  });
});

// runCheck through the real launcher and spawn path, with the connectivity
// probe stubbed: a test must never touch the network.
const dirs: string[] = [];
afterEach(() => {
  setConnectivityProbe(null);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeCtx(command: string): RunContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-check-'));
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
        harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code', command: 'true' }],
      },
    ],
  });
  const task = TaskSchema.parse({ ...EXAMPLE_TASK, cwd: root, check: { command, timeoutSec: 30 } });
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

describe('runCheck network classification', () => {
  it('blames the network when the output names a network failure', async () => {
    setConnectivityProbe(async () => true); // online: the text alone decides
    const r = await runCheck(makeCtx(`echo 'curl: (6) Could not resolve host: example.com' >&2; exit 1`));
    expect(r.status).toBe('error');
    expect(r.network).toBe(true);
  });

  it('leaves an ordinary failure alone while the machine is online', async () => {
    setConnectivityProbe(async () => true);
    const r = await runCheck(makeCtx(`echo 'the script is broken' >&2; exit 1`));
    expect(r.status).toBe('error');
    expect(r.network).toBeUndefined();
  });

  it('blames the network for an unexplained failure while the machine is offline', async () => {
    setConnectivityProbe(async () => false);
    const r = await runCheck(makeCtx(`echo 'the script is broken' >&2; exit 1`));
    expect(r.network).toBe(true);
  });

  it('never probes a check that ran and answered badly', async () => {
    let probed = false;
    setConnectivityProbe(async () => {
      probed = true;
      return false;
    });
    const r = await runCheck(makeCtx(`echo 'not json'`));
    expect(r.status).toBe('error');
    expect(r.network).toBeUndefined();
    expect(probed).toBe(false);
  });
});

describe('toClassifyResult', () => {
  const end = (extra: Partial<SessionEnd>): SessionEnd => ({
    reason: 'done',
    exitCode: 0,
    durationMs: 5,
    wasHeld: false,
    ...extra,
  });

  it('headless: reads the verdict from the structured output', () => {
    const r = toClassifyResult(end({ structured: { act: true, reason: 'yes' }, costUsd: 0.01, body: '{"act":true}' }), true, 180);
    expect(r).toMatchObject({ status: 'act', reason: 'yes', costUsd: 0.01 });
  });
  it('headless: no structured output is an error', () => {
    const r = toClassifyResult(end({ body: 'free text' }), true, 180);
    expect(r.status).toBe('error');
    expect(r.error).toContain('no verdict');
  });
  it('interactive: reads the verdict from looper-classify', () => {
    const r = toClassifyResult(end({ doneStatus: 'noop', headline: 'nothing new', body: 'All quiet.' }), false, 180);
    expect(r).toMatchObject({ status: 'noop', reason: 'nothing new', body: 'All quiet.' });
  });
  it('interactive: looper-classify without act/noop is an error', () => {
    const r = toClassifyResult(end({ headline: 'done' }), false, 180);
    expect(r.status).toBe('error');
  });
  it('maps timeouts, exits and stops', () => {
    expect(toClassifyResult(end({ reason: 'max-runtime' }), true, 42).error).toContain('42 s');
    expect(toClassifyResult(end({ reason: 'exited', exitCode: 3, headline: 'Claude exited 3' }), true, 180).status).toBe('error');
    expect(toClassifyResult(end({ reason: 'stopped' }), false, 180).status).toBe('stopped');
    const limited = toClassifyResult(end({ reason: 'error', headline: 'usage limit', retryAtMs: 123 }), true, 180);
    expect(limited).toMatchObject({ status: 'error', retryAtMs: 123 });
  });

  it('carries the network verdict on every error branch', () => {
    for (const reason of ['max-runtime', 'idle-timeout', 'exited', 'error'] as const) {
      expect(toClassifyResult(end({ reason, network: true }), true, 180).network).toBe(true);
      expect(toClassifyResult(end({ reason }), true, 180).network).toBeUndefined();
    }
  });

  it('never carries it on a verdict or a stop', () => {
    expect(toClassifyResult(end({ reason: 'done', structured: { act: true, reason: 'y' }, network: true }), true, 180).network)
      .toBeUndefined();
    expect(toClassifyResult(end({ reason: 'stopped', network: true }), false, 180).network).toBeUndefined();
  });

  it('blames a system sleep when an errored session outlived its timeout by far', () => {
    for (const reason of ['max-runtime', 'idle-timeout', 'exited', 'error'] as const) {
      expect(toClassifyResult(end({ reason, durationMs: 300_000 }), true, 60).slept).toBe(true);
      expect(toClassifyResult(end({ reason, durationMs: 60_000 }), true, 60).slept).toBeUndefined();
    }
    expect(toClassifyResult(end({ reason: 'stopped', durationMs: 300_000 }), false, 60).slept).toBeUndefined();
  });
});
