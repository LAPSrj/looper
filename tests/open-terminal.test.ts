import { describe, expect, it } from 'vitest';
import {
  buildTerminalLaunches,
  renderTerminalScript,
  terminalHarnessCommand,
} from '../src/engine/open-terminal';
import { BashTarget, WindowsTarget } from '../src/engine/target';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { TaskSchema, type Harness, type Task } from '../src/shared/types';

const harness = (over: Partial<Harness> = {}): Harness => ({
  id: 'claude',
  name: 'Claude Code',
  kind: 'claude-code',
  command: 'claude',
  args: [],
  env: {},
  ...over,
});

const task = (over: Partial<Task['agent']> = {}, env: Record<string, string> = {}): Task =>
  TaskSchema.parse({ ...EXAMPLE_TASK, env, agent: { ...EXAMPLE_TASK.agent, ...over } });

const bash = new BashTarget({ host: 'linux' }, undefined);
const win = new WindowsTarget({ host: 'windows' });

describe('terminalHarnessCommand', () => {
  it('claude-code carries model, permission mode, harness args and extra args — no prompt', () => {
    const cmd = terminalHarnessCommand(task({ extraArgs: ['--allowedTools', 'Bash'] }), bash, harness({ args: ['--verbose'] }));
    // 'sonnet' is a default-list entry, so its default effort rides along.
    expect(cmd).toBe("claude --model 'sonnet' --effort 'medium' --permission-mode 'auto' '--verbose' '--allowedTools' 'Bash'");
  });

  it('empty model/permission mode omit the flags', () => {
    const cmd = terminalHarnessCommand(task({ model: undefined, permissionMode: '' }), bash, harness());
    expect(cmd).toBe('claude');
  });

  it('an effort level rides along: --effort for claude, the config override for codex', () => {
    expect(terminalHarnessCommand(task({ effort: 'high' }), bash, harness())).toBe(
      "claude --model 'sonnet' --effort 'high' --permission-mode 'auto'",
    );
    expect(terminalHarnessCommand(task({ effort: 'xhigh' }), bash, harness({ kind: 'codex', command: 'codex' }))).toBe(
      "codex --approve-for-me --model 'sonnet' -c 'model_reasoning_effort=xhigh'",
    );
  });

  it("a model outside the harness's list has no default effort to resolve: the flag is omitted", () => {
    expect(terminalHarnessCommand(task({ model: 'claude-opus-4-1', permissionMode: '' }), bash, harness())).toBe(
      "claude --model 'claude-opus-4-1'",
    );
  });

  it("the harness's own model list overrides the default effort", () => {
    const h = harness({ models: [{ id: 'sonnet', name: 'Sonnet', defaultEffort: 'xhigh' }] });
    expect(terminalHarnessCommand(task({ permissionMode: '' }), bash, h)).toBe(
      "claude --model 'sonnet' --effort 'xhigh'",
    );
  });

  it('codex maps the permission mode to its own flags, then the model', () => {
    const cmd = terminalHarnessCommand(task(), bash, harness({ kind: 'codex', command: 'codex' }));
    expect(cmd).toBe("codex --approve-for-me --model 'sonnet'");
  });

  it('codex sandbox modes never ask, and bypass turns everything off', () => {
    const codex = harness({ kind: 'codex', command: 'codex' });
    expect(terminalHarnessCommand(task({ model: undefined, permissionMode: 'workspace-write' }), bash, codex)).toBe(
      'codex --sandbox workspace-write -a never',
    );
    expect(terminalHarnessCommand(task({ model: undefined, permissionMode: 'bypassPermissions' }), bash, codex)).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox',
    );
    expect(terminalHarnessCommand(task({ model: undefined, permissionMode: '' }), bash, codex)).toBe('codex');
  });
});

describe('renderTerminalScript', () => {
  it('bash: exports env, cds and execs the harness', () => {
    const script = renderTerminalScript(bash, task({}, { FOO: 'task' }), { FOO: 'task', BAR: 'h' }, 'claude');
    expect(script).toContain("export FOO='task'");
    expect(script).toContain("export BAR='h'");
    expect(script).toContain("cd '/home/me/repos/project'");
    expect(script).toContain('exec claude');
    expect(script).not.toContain('looper-done');
  });

  it('powershell: sets env, sets location and runs the harness', () => {
    const script = renderTerminalScript(win, task(), { BAR: 'h' }, 'claude');
    expect(script).toContain("$env:BAR = 'h'");
    expect(script).toContain("Set-Location -LiteralPath '/home/me/repos/project'");
    expect(script).toContain('claude');
    expect(script).not.toContain('exit $LASTEXITCODE');
  });
});

describe('buildTerminalLaunches', () => {
  it('windows host, windows target: one cmd start line through the default terminal', () => {
    const [l] = buildTerminalLaunches('windows', 'windows', {
      launcherTarget: 'C:\\Users\\me\\AppData\\Roaming\\looper\\tasks\\t\\terminal.ps1',
      launcherHost: 'C:\\Users\\me\\AppData\\Roaming\\looper\\tasks\\t\\terminal.ps1',
      sourceCmd: '',
    });
    expect(l.command).toBe('cmd.exe');
    expect(l.verbatim).toBe(true);
    expect(l.args[2]).toBe(
      'start "" powershell.exe -NoExit -NoLogo -ExecutionPolicy Bypass -File C:\\Users\\me\\AppData\\Roaming\\looper\\tasks\\t\\terminal.ps1',
    );
  });

  it('windows host, wsl target: start wsl.exe with the distro and the source command quoted', () => {
    const [l] = buildTerminalLaunches('windows', 'wsl', {
      launcherTarget: '/mnt/c/looper/tasks/t/terminal.sh',
      launcherHost: 'C:\\looper\\tasks\\t\\terminal.sh',
      sourceCmd: "source '/mnt/c/looper/tasks/t/terminal.sh'",
      distro: 'Ubuntu',
    });
    expect(l.args[2]).toBe(
      'start "" wsl.exe -d Ubuntu -- bash -lic "source \'/mnt/c/looper/tasks/t/terminal.sh\'"',
    );
  });

  it('a custom shell replaces the default bash flags', () => {
    const [l] = buildTerminalLaunches('windows', 'wsl', {
      launcherTarget: '/tmp/t.sh',
      launcherHost: '/tmp/t.sh',
      sourceCmd: "source '/tmp/t.sh'",
      shell: 'zsh -lc',
    });
    expect(l.args[2]).toContain('zsh -lc');
  });
});
