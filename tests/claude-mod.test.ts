import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeClaudeSettings, mergeSystemPrompt, readUserSettings } from '../src/engine/claude-settings';
import { renderMod } from '../src/engine/claude-mod';
import { Logger } from '../src/engine/log';
import { startAgent } from '../src/engine/steps/agent';
import type { RunContext } from '../src/engine/steps/common';
import { writeText } from '../src/engine/store/fsutil';
import { BashTarget, createTarget } from '../src/engine/target';
import { claudeArgsProblem, takeFlagValues } from '../src/shared/claude-args';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { SettingsSchema, TaskSchema } from '../src/shared/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};

describe('the user\'s Claude Code arguments', () => {
  it('finds every --settings in both forms and leaves the rest in order', () => {
    expect(takeFlagValues(['--verbose', '--settings', 'a.json', '--tools', 'Bash', '--settings={"x":1}'])).toEqual({
      values: ['a.json', '{"x":1}'],
      rest: ['--verbose', '--tools', 'Bash'],
    });
  });

  it('refuses at save what Looper sets, what a field sets, and what keeps the mod from loading', () => {
    expect(claudeArgsProblem(['--verbose', '--settings', 'x.json'], 'Arguments')).toBeNull();
    expect(claudeArgsProblem(['-p'], 'Arguments')).toBe('Arguments: Looper sets -p itself. Remove it.');
    expect(claudeArgsProblem(['--output-format=json'], 'Arguments')).toContain('Looper sets --output-format itself');
    expect(claudeArgsProblem(['--model', 'opus'], 'Arguments')).toBe('Arguments: --model has a field of its own. Remove it and set Model instead.');
    expect(claudeArgsProblem(['--dangerously-skip-permissions'], 'X')).toContain('set Permission mode instead');
    expect(claudeArgsProblem(['--bare'], 'X')).toContain("Looper can't run Claude Code with --bare");
    expect(claudeArgsProblem(['--settings', '{"a":'], 'X')).toContain("the JSON after --settings isn't valid");
    expect(claudeArgsProblem(['--settings', '[1]'], 'X')).toBeNull();
    expect(claudeArgsProblem(['--settings', '{"a":[1]}'], 'X')).toBeNull();
  });
});

describe('merging the user\'s settings into Looper\'s', () => {
  const looper = {
    permissions: { allow: ['Bash(looper-done:*)'] },
    sandbox: { excludedCommands: ['looper-done'] },
    enableAllProjectMcpServers: true,
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'looper-stop' }] }], SessionStart: [{ hooks: [{ type: 'command', command: 'looper-start' }] }] },
  };

  it('keeps both sides of the lists and hooks, and lets the user win elsewhere', () => {
    const merged = mergeClaudeSettings(looper, [
      {
        permissions: { allow: ['Bash(npm:*)'], defaultMode: 'acceptEdits' },
        enableAllProjectMcpServers: false,
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }], Notification: [{ hooks: [] }] },
        env: { A: '1' },
      },
    ]);
    expect(merged.permissions).toEqual({ allow: ['Bash(looper-done:*)', 'Bash(npm:*)'], defaultMode: 'acceptEdits' });
    expect(merged.sandbox).toEqual({ excludedCommands: ['looper-done'] });
    expect(merged.enableAllProjectMcpServers).toBe(false);
    expect(merged.env).toEqual({ A: '1' });
    const hooks = merged.hooks as Record<string, { hooks: { command: string }[] }[]>;
    expect(hooks.Stop.map((g) => g.hooks[0].command)).toEqual(['mine', 'looper-stop']);
    expect(hooks.SessionStart).toEqual(looper.hooks.SessionStart);
    expect(hooks.Notification).toEqual([{ hooks: [] }]);
  });

  it("refuses settings that turn off every hook", () => {
    expect(() => mergeClaudeSettings(looper, [{ disableAllHooks: true }])).toThrow(/disableAllHooks/);
  });

  it('reads inline JSON and files relative to the task folder, and names the argument it cannot read', async () => {
    const dir = tmp('looper-settings-');
    fs.writeFileSync(path.join(dir, 'mine.json'), '{"env":{"B":"2"}}');
    const place = { target: new BashTarget({ host: 'linux' }, undefined), cwd: dir };
    const read = await readUserSettings(['--settings', 'mine.json', '--settings={"env":{"C":"3"}}', '--verbose'], place);
    expect(read).toEqual({ rest: ['--verbose'], settings: [{ env: { B: '2' } }, { env: { C: '3' } }] });
    await expect(readUserSettings(['--settings', 'gone.json'], place)).rejects.toThrow(/^--settings gone\.json: ENOENT/);
    fs.writeFileSync(path.join(dir, 'bad.json'), '[1]');
    await expect(readUserSettings(['--settings', 'bad.json'], place)).rejects.toThrow('--settings bad.json: the settings must be a JSON object');
  });

  it("puts the user's system prompt after Looper's", () => {
    expect(mergeSystemPrompt('Looper footer', ['--append-system-prompt', 'Be brief.', '-x'])).toEqual({ text: 'Looper footer\n\nBe brief.', rest: ['-x'] });
    expect(mergeSystemPrompt(undefined, ['-x'])).toEqual({ text: undefined, rest: ['-x'] });
  });
});

describe('the mod', () => {
  it('bakes the session into the module, which parses as JavaScript', () => {
    const source = renderMod({
      files: { ready: '/r/mod.json', control: '/r/mod-control.json', turnEnd: '/r/turn-end.json', usage: '/r/usage.json', turn: '/r/turn.json' },
      inbox: ['/r/guidance.json'],
      signalCommands: ['looper-done'],
      guardMessage: "a subagent can't",
      ask: { command: 'looper-ask', timeoutMs: 1000 },
      headless: false,
      windows: false,
    });
    expect(source).toContain('"/r/guidance.json"');
    expect(source).not.toContain('__CONFIG__');
    // An ES module: syntax-check it as one, with its export turned into a plain function.
    expect(() => new Function(source.replace('export function register', 'function register'))).not.toThrow();
  });
});

/** An interactive Claude Code run whose fake harness writes what the mod and hooks would. */
function makeCtx(fake: string, agent: Record<string, unknown> = {}, harnessArgs: string[] = []): RunContext {
  const root = tmp('looper-mod-run-');
  const harness = path.join(root, 'fake-claude');
  writeText(harness, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$LOOPER_RUN_DIR/argv.txt"\n${fake}\n`, 0o755);
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
        harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code', command: harness, args: harnessArgs }],
      },
    ],
  });
  const task = TaskSchema.parse({
    ...EXAMPLE_TASK,
    cwd: root,
    agent: { ...EXAMPLE_TASK.agent, harnessId: 'fake', mode: 'interactive', maxRuntimeMin: 1, ...agent },
  });
  return {
    task,
    runId: `r-${path.basename(root)}`,
    runDir,
    target: createTarget(task, { host: 'linux', settings }),
    settings,
    host: 'linux',
    log: new Logger(),
    vars: {},
  };
}

const MOD_READY = `printf '{"version":"1"}' > "$LOOPER_RUN_DIR/mod.json"; printf '{}' > "$LOOPER_RUN_DIR/session.json"`;

describe('a Claude Code run on the mod', () => {
  it("merges the harness's --settings and --append-system-prompt into Looper's, and passes neither on", async () => {
    const ctx = makeCtx(`${MOD_READY}; looper-done success "ok"; sleep 0.3; printf '{"last_assistant_message":"r"}' > "$LOOPER_STOP_FILE"; sleep 30`, {}, [
      '--settings',
      '{"env":{"MINE":"1"},"permissions":{"allow":["Bash(npm:*)"]}}',
      '--append-system-prompt',
      'Answer in French.',
    ]);
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('done');
    const settings = JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'settings.json'), 'utf8'));
    expect(settings.env).toEqual({ MINE: '1' });
    expect(settings.permissions.allow).toEqual(['Bash(looper-done:*)', 'Bash(looper-done)', 'Bash(npm:*)']);
    expect(settings.hooks.Stop).toBeDefined();
    const argv = fs.readFileSync(path.join(ctx.runDir, 'argv.txt'), 'utf8').split('\n');
    expect(argv.filter((a) => a === '--settings')).toHaveLength(1);
    expect(argv.filter((a) => a === '--append-system-prompt')).toHaveLength(1);
    expect(argv).toContain('--plugin-dir');
    expect(fs.readFileSync(path.join(ctx.runDir, 'system.txt'), 'utf8').endsWith('\n\nAnswer in French.')).toBe(true);
  }, 30_000);

  it('ends a usage limit that StopFailure reports, retrying after the reset the mod saw', async () => {
    const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const usage = JSON.stringify({ rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], cost: { usd: 0.42 } });
    const failure = JSON.stringify({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You have hit your limit" });
    const ctx = makeCtx(`${MOD_READY}; printf '%s' '${usage}' > "$LOOPER_RUN_DIR/usage.json"; sleep 1.5; printf '%s' '${failure}' > "$LOOPER_RUN_DIR/stop-failure.json"; sleep 30`);
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('error');
    expect(end.headline).toBe("You have hit your limit");
    expect(end.retryAtMs).toBe(Date.parse(resetsAt) + 60_000);
    expect(end.costUsd).toBe(0.42);
  }, 30_000);

  it('ends with the API error StopFailure reports, as Claude Code worded it', async () => {
    const failure = JSON.stringify({ error: 'model_not_found', last_assistant_message: "There is an issue with the selected model." });
    const ctx = makeCtx(`${MOD_READY}; sleep 1.5; printf '%s' '${failure}' > "$LOOPER_RUN_DIR/stop-failure.json"; sleep 30`);
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('error');
    expect(end.headline).toBe("There is an issue with the selected model.");
    expect(end.network).toBeUndefined();
    expect(end.environment).toBeUndefined();
  }, 30_000);

  it('Stop asks the mod to end the turn instead of typing Esc', async () => {
    const ctx = makeCtx(`${MOD_READY}; sleep 30`);
    const handle = await startAgent(ctx, { onData: () => {} });
    await new Promise((r) => setTimeout(r, 2500));
    handle.stopTurn();
    expect(JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'mod-control.json'), 'utf8'))).toEqual({ abort: 1 });
    expect(handle.turnOver).toBe(true);
    await handle.stop();
  }, 30_000);

  /** A fake that asks permission as the hook would, then copies Looper's answer where the test reads it. */
  const ASKS = (dir: string) =>
    [
      MOD_READY,
      'mkdir -p "$LOOPER_RUN_DIR/permissions"',
      `printf '%s' '{"tool_name":"Bash","tool_input":{"command":"rm -rf build"}}' > "$LOOPER_RUN_DIR/permissions/1.req"`,
      'for i in $(seq 200); do [ -e "$LOOPER_RUN_DIR/permissions/1.ans" ] || [ -e "$LOOPER_RUN_DIR/permissions/1.cancel" ] && break; sleep 0.05; done',
      `cp "$LOOPER_RUN_DIR/permissions/1.ans" '${dir}/answer.json' 2>/dev/null; [ -e "$LOOPER_RUN_DIR/permissions/1.cancel" ] && touch '${dir}/cancelled'`,
      'rm -f "$LOOPER_RUN_DIR/permissions/1.req"',
      'sleep 30',
    ].join('\n');

  it("relays a permission request to Looper, and the user's answer goes back to the hook", async () => {
    const dir = tmp('looper-perm-');
    const ctx = makeCtx(ASKS(dir));
    const seen: (string | null)[] = [];
    let handle: Awaited<ReturnType<typeof startAgent>> | undefined;
    handle = await startAgent(ctx, {
      onData: () => {},
      onPermission: (p) => {
        seen.push(p ? `${p.tool}: ${(p.input as { command: string }).command}` : null);
        if (p) expect(handle!.answerPermission(p.id, true)).toBe(true);
      },
    });
    const settings = JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(5 * 60 + 60);
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'answer.json')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'answer.json'), 'utf8'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(seen).toEqual(['Bash: rm -rf build', null]);
    expect(handle.permission).toBeNull();
    await handle.stop();
  }, 30_000);

  it('denies a permission request nobody answers in time, telling the agent why', async () => {
    const dir = tmp('looper-perm-');
    const ctx = makeCtx(ASKS(dir), { ask: { allowed: false, waitMin: 0.01 } });
    const handle = await startAgent(ctx, { onData: () => {} });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'answer.json')); i++) await new Promise((r) => setTimeout(r, 50));
    const decision = JSON.parse(fs.readFileSync(path.join(dir, 'answer.json'), 'utf8')).hookSpecificOutput.decision;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain("Nobody answered this permission request within");
    await handle.stop();
  }, 30_000);

  it('lets the hook go once the call was answered in the terminal', async () => {
    const dir = tmp('looper-perm-');
    const toolEnd = JSON.stringify({ tool: 'Bash', key: 'rm -rf build' }).replace('{', '{"at":9999999999999,');
    const fake = ASKS(dir).replace('mkdir -p', `(sleep 1.5; printf '%s' '${toolEnd}' > "$LOOPER_RUN_DIR/tool-end.json") & mkdir -p`);
    const ctx = makeCtx(fake);
    const seen: (string | null)[] = [];
    const handle = await startAgent(ctx, { onData: () => {}, onPermission: (p) => seen.push(p?.id ?? null) });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'cancelled')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(path.join(dir, 'cancelled'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'answer.json'))).toBe(false);
    expect(seen).toEqual(['1', null]);
    await handle.stop();
  }, 30_000);

  it('ends at once with the report when the final Stop comes before the done signal is read', async () => {
    // looper-done, then the turn's Stop right after: both land within the two polls that read the done file.
    const ctx = makeCtx(`looper-done success "Fixed it"; printf '{"last_assistant_message":"The report."}' > "$LOOPER_STOP_FILE"; sleep 30`);
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('done');
    expect(end.body).toBe('The report.');
    expect(end.durationMs).toBeLessThan(10_000);
  }, 30_000);

  it("takes the report from the mod's record when the session exits before its Stop hook", async () => {
    const turnEnd = JSON.stringify({ answer: 'The full report.', aborted: false });
    const ctx = makeCtx(`${MOD_READY}; looper-done success "Fixed it"; sleep 0.3; printf '%s' '${turnEnd}' > "$LOOPER_RUN_DIR/turn-end.json"; exit 0`);
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('done');
    expect(end.headline).toBe('Fixed it');
    expect(end.body).toBe('The full report.');
  }, 30_000);
});
