import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { queueGuidance, readPendingGuidance } from '../src/engine/guidance';
import { Logger } from '../src/engine/log';
import { startAgent } from '../src/engine/steps/agent';
import type { RunContext } from '../src/engine/steps/common';
import { writeText } from '../src/engine/store/fsutil';
import { createTarget } from '../src/engine/target';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { SettingsSchema, TaskSchema } from '../src/shared/types';

// An interactive session through a real pty: a fake harness ends its turn the
// way claude's Stop hook records it (stop.json), then reads what is typed in.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Ends a turn, reads typed lines until the guidance arrives, then signals done with what it read. */
const FAKE = [
  `printf '{"last_assistant_message":"waiting"}' > "$LOOPER_STOP_FILE"`,
  'got=',
  'while IFS= read -r -t 20 line; do',
  '  got="$got$line"',
  '  case "$line" in *"skip the flaky test"*) break ;; esac',
  'done',
  'printf "%s" "$got" > "$LOOPER_RUN_DIR/typed.txt"',
  'looper-done success "got the guidance"',
  'sleep 0.3',
  `printf '{"last_assistant_message":"final report"}' > "$LOOPER_STOP_FILE"`,
  'sleep 30',
].join('\n');

function makeCtx(): RunContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-interactive-'));
  dirs.push(root);
  const harness = path.join(root, 'fake-claude');
  writeText(harness, `#!/usr/bin/env bash\n${FAKE}\n`, 0o755);
  const runDir = path.join(root, 'run');
  fs.mkdirSync(path.join(runDir, 'bin'), { recursive: true });
  const settings = SettingsSchema.parse({
    signalPollMs: 50,
    environments: [
      {
        id: 'local',
        name: 'Local',
        kind: 'local',
        shell: 'bash -c',
        harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code', command: harness }],
      },
    ],
  });
  const task = TaskSchema.parse({
    ...EXAMPLE_TASK,
    cwd: root,
    agent: { ...EXAMPLE_TASK.agent, harnessId: 'fake', mode: 'interactive', maxRuntimeMin: 1 },
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

describe('guidance for an interactive session', () => {
  it('types guidance waiting at the turn end in as the next prompt', async () => {
    const ctx = makeCtx();
    queueGuidance(ctx.runDir, 'skip the flaky test');
    const handle = await startAgent(ctx, { onData: () => {} });
    const end = await handle.finished;
    expect(end.reason).toBe('done');
    expect(end.headline).toBe('got the guidance');
    expect(end.body).toBe('final report');
    const typed = fs.readFileSync(path.join(ctx.runDir, 'typed.txt'), 'utf8');
    expect(typed).toContain('Looper guidance from the user');
    expect(typed).toContain('skip the flaky test');
    expect(readPendingGuidance(ctx.runDir)).toBeNull();
  }, 30_000);

  it('types guidance sent while the session sits idle', async () => {
    const ctx = makeCtx();
    const handle = await startAgent(ctx, { onData: () => {} });
    // Let the session see the turn end first.
    await new Promise((r) => setTimeout(r, 1500));
    queueGuidance(ctx.runDir, 'skip the flaky test');
    handle.deliverGuidance();
    const end = await handle.finished;
    expect(end.reason).toBe('done');
    expect(fs.readFileSync(path.join(ctx.runDir, 'typed.txt'), 'utf8')).toContain('skip the flaky test');
  }, 30_000);
});
