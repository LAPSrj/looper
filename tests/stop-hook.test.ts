import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { BashTarget, WindowsTarget } from '../src/engine/target';
import { stopHookMessages, subagentGuardMessage } from '../src/engine/target/stop-hook';
import { GUIDANCE_FILE, queueGuidance, readPendingGuidance } from '../src/engine/guidance';
import { guidanceText } from '../src/shared/messages';

const MSGS = stopHookMessages('agent');
const STOP_BLOCK_BACKGROUND = MSGS.blockBackground;
const STOP_BLOCK_NO_DONE = MSGS.blockNoDone;

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
  fs.writeFileSync(script, t.renderStopHook({ stopJson, doneFile, reminderFile, ...MSGS }), { mode: 0o755 });
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

describe('guidance through the bash hooks', () => {
  const t = new BashTarget({ host: 'wsl' }, undefined);

  function runScript(file: string, input: string, env: Record<string, string> = {}): string {
    const r = spawnSync('bash', [file], { input, encoding: 'utf8', env: { ...process.env, ...env } });
    expect(r.status).toBe(0);
    return r.stdout;
  }

  it('the Stop gate continues the turn with waiting guidance, once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-guide-'));
    dirs.push(dir);
    const script = path.join(dir, 'looper-stop-hook');
    const spec = {
      stopJson: path.join(dir, 'stop.json'),
      doneFile: path.join(dir, 'done'),
      reminderFile: path.join(dir, 'stop-reminded'),
      guidanceFile: path.join(dir, GUIDANCE_FILE),
      ...MSGS,
    };
    fs.writeFileSync(script, t.renderStopHook(spec), { mode: 0o755 });
    queueGuidance(dir, 'use "pnpm", not npm — and café');
    // Plain ASCII on disk, so a PowerShell hook prints it intact under any code page.
    expect(fs.readFileSync(path.join(dir, GUIDANCE_FILE), 'utf8')).toMatch(/^[\x20-\x7e]*$/);
    const out = JSON.parse(runScript(script, '{}'));
    expect(out.decision).toBe('block');
    expect(guidanceText(out.reason)).toBe('use "pnpm", not npm — and café');
    expect(readPendingGuidance(dir)).toBeNull();
    // Nothing waiting any more: the gate goes on to its usual reminder.
    expect(JSON.parse(runScript(script, '{}'))).toEqual(JSON.parse(STOP_BLOCK_NO_DONE));
  });

  it('the Stop gate leaves guidance alone once looper-done ran', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-guide-'));
    dirs.push(dir);
    const script = path.join(dir, 'looper-stop-hook');
    const doneFile = path.join(dir, 'done');
    fs.writeFileSync(
      script,
      t.renderStopHook({
        stopJson: path.join(dir, 'stop.json'),
        doneFile,
        reminderFile: path.join(dir, 'stop-reminded'),
        guidanceFile: path.join(dir, GUIDANCE_FILE),
        ...MSGS,
      }),
      { mode: 0o755 },
    );
    fs.writeFileSync(doneFile, 'success\nok\n');
    queueGuidance(dir, 'too late');
    expect(runScript(script, '{}')).toBe('');
    expect(readPendingGuidance(dir)).toBe('too late');
  });

  it('the claude PostToolUse hook prints the guidance as additional context', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-guide-'));
    dirs.push(dir);
    const script = path.join(dir, t.guideHookFile);
    fs.writeFileSync(script, t.renderGuideHook('claude', path.join(dir, GUIDANCE_FILE)), { mode: 0o755 });
    expect(runScript(script, '{"tool_name":"Bash"}')).toBe('');
    queueGuidance(dir, 'line one\nline two');
    const out = JSON.parse(runScript(script, '{"tool_name":"Bash"}'));
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(guidanceText(out.hookSpecificOutput.additionalContext)).toBe('line one\nline two');
    expect(runScript(script, '{}')).toBe('');
    // The taken file stays behind as the record of the delivery.
    expect(fs.readdirSync(dir).some((n) => /^guidance-.+\.json$/.test(n))).toBe(true);
  });

  it("the claude PostToolUse hook leaves the guidance for the agent when a subagent's call fires it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-guide-'));
    dirs.push(dir);
    const script = path.join(dir, t.guideHookFile);
    fs.writeFileSync(script, t.renderGuideHook('claude', path.join(dir, GUIDANCE_FILE)), { mode: 0o755 });
    queueGuidance(dir, 'for the agent');
    // Key order as claude sends it: agent_id/agent_type only on a subagent's call, before tool_input.
    const sub = { session_id: 's1', agent_id: 'a025a5695c64b4a2a', agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'ls' } };
    expect(runScript(script, JSON.stringify(sub))).toBe('');
    expect(readPendingGuidance(dir)).toBe('for the agent');
    // The agent's own call, even one whose command or output names agent_id, takes it.
    const own = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'jq .agent_id x.json' }, tool_response: { agent_id: 'x' } };
    const out = JSON.parse(runScript(script, JSON.stringify(own)));
    expect(guidanceText(out.hookSpecificOutput.additionalContext)).toBe('for the agent');
  });

  it('the codex hook finds the run through LOOPER_RUN_DIR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-guide-'));
    dirs.push(dir);
    const script = path.join(dir, 'codex-' + t.guideHookFile);
    fs.writeFileSync(script, t.renderGuideHook('codex'), { mode: 0o755 });
    queueGuidance(dir, 'stop after the tests');
    const out = JSON.parse(runScript(script, '{}', { LOOPER_RUN_DIR: dir }));
    expect(out).toEqual({ hookSpecificOutput: { additionalContext: expect.any(String) } });
    expect(guidanceText(out.hookSpecificOutput.additionalContext)).toBe('stop after the tests');
    expect(t.codexHookCommand('/mnt/c/Users/me/looper/hooks/codex-looper-guide-hook')).toBe(
      'bash /mnt/c/Users/me/looper/hooks/codex-looper-guide-hook',
    );
    expect(t.codexHookCommand("/home/o'neil/looper/hooks/x")).toBeNull();
  });
});

describe('subagent guard', () => {
  const commands = ['looper-done', 'looper-complete'];
  const message = subagentGuardMessage(commands);
  const sub = (command: string) => ({
    session_id: 's1',
    agent_id: 'a025a5695c64b4a2a',
    agent_type: 'general-purpose',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });

  it('bash: denies a subagent running a signal command, allows everything else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-guard-'));
    dirs.push(dir);
    const t = new BashTarget({ host: 'wsl' }, undefined);
    const script = path.join(dir, t.guardHookFile);
    fs.writeFileSync(script, t.renderSubagentGuard(commands, message), { mode: 0o755 });
    const run = (payload: unknown) => spawnSync('bash', [script], { input: JSON.stringify(payload), encoding: 'utf8' });

    const denied = run(sub('looper-done success "Fixed it"'));
    expect(denied.status).toBe(2);
    expect(denied.stderr.trim()).toBe(message);
    expect(run(sub('cd x && looper-complete "all done"')).status).toBe(2);
    expect(run(sub('npm test')).status).toBe(0);
    // The agent itself may run them.
    const { agent_id: _id, agent_type: _type, ...own } = sub('looper-done success "ok"');
    expect(run(own).status).toBe(0);
  });

  it('windows: renders the same guard for PowerShell', () => {
    const t = new WindowsTarget({ host: 'windows' });
    const script = t.renderSubagentGuard(commands, message);
    expect(script).toContain(`if (-not (($payload -split '"tool_input"', 2)[0] -match '"agent_id"\\s*:')) { exit 0 }`);
    expect(script).toContain("foreach ($c in @('looper-done', 'looper-complete')) {");
    expect(script).toContain('exit 2');
  });
});

describe('windows Stop-hook gate', () => {
  it('renders a PowerShell gate with the same decisions', () => {
    const t = new WindowsTarget({ host: 'windows' });
    const script = t.renderStopHook({
      stopJson: 'C:\\data\\r1\\stop.json',
      doneFile: 'C:\\data\\r1\\done',
      reminderFile: 'C:\\data\\r1\\stop-reminded',
      ...MSGS,
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

  it('renders the guidance hooks for PowerShell', () => {
    const t = new WindowsTarget({ host: 'windows' });
    const gate = t.renderStopHook({
      stopJson: 'C:\\data\\r1\\stop.json',
      doneFile: 'C:\\data\\r1\\done',
      reminderFile: 'C:\\data\\r1\\stop-reminded',
      guidanceFile: 'C:\\data\\r1\\guidance.json',
      ...MSGS,
    });
    // After the done check, before the reminder.
    const at = gate.indexOf("$g = 'C:\\data\\r1\\guidance.json'");
    expect(at).toBeGreaterThan(gate.indexOf('Test-Path -LiteralPath \'C:\\data\\r1\\done\''));
    expect(at).toBeLessThan(gate.indexOf('stop-reminded'));
    expect(gate).toContain(`Write-Output ('{"decision":"block","reason":' + [IO.File]::ReadAllText($d).Trim() + '}')`);
    expect(t.renderGuideHook('codex')).toContain("$g = (Join-Path $env:LOOPER_RUN_DIR 'guidance.json')");
    expect(t.renderGuideHook('claude', 'C:\\data\\r1\\guidance.json')).toContain(
      `if (($payload -split '"tool_input"', 2)[0] -match '"agent_id"\\s*:') { exit 0 }`,
    );
    expect(t.codexHookCommand('C:\\Users\\me\\looper\\hooks\\codex-looper-guide-hook.ps1')).toBe(
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/Users/me/looper/hooks/codex-looper-guide-hook.ps1',
    );
    expect(t.codexHookCommand('C:\\Users\\Jane Doe\\looper\\hooks\\x.ps1')).toBeNull();
  });
});
