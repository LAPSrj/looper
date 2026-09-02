import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { writeLauncher, type RunContext } from '../src/engine/steps/common';
import { BashTarget } from '../src/engine/target';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { SettingsSchema, TaskSchema } from '../src/shared/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeCtx(taskEnv: Record<string, string>): RunContext {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-launcher-'));
  dirs.push(runDir);
  const task = TaskSchema.parse({ ...EXAMPLE_TASK, env: taskEnv });
  return {
    task,
    runId: 'r1',
    runDir,
    target: new BashTarget({ host: 'linux' }, undefined),
    settings: SettingsSchema.parse({}),
    host: 'linux',
    log: new Logger(),
    vars: {},
  };
}

describe('writeLauncher env layering', () => {
  it('task env overrides the harness env; LOOPER_* overrides both', () => {
    const ctx = makeCtx({ FOO: 'task', BAZ: 'b', LOOPER_RUN: 'evil' });
    const launcher = writeLauncher(ctx, 'run', 'exec true', { FOO: 'harness', BAR: 'h' });
    const script = fs.readFileSync(launcher.hostPath, 'utf8');
    expect(script).toContain("export FOO='task'");
    expect(script).not.toContain('harness');
    expect(script).toContain("export BAR='h'");
    expect(script).toContain("export BAZ='b'");
    expect(script).toContain("export LOOPER_RUN='r1'");
    expect(script).not.toContain('evil');
  });
});
