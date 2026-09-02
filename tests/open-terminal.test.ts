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
    expect(cmd).toBe("claude --model 'sonnet' --permission-mode 'auto' '--verbose' '--allowedTools' 'Bash'");
  });

  it('empty model/permission mode omit the flags', () => {
    const cmd = terminalHarnessCommand(task({ model: undefined, permissionMode: '' }), bash, harness());
    expect(cmd).toBe('claude');
  });

  it('codex gets the model but never the permission mode', () => {
    const cmd = terminalHarnessCommand(task(), bash, harness({ kind: 'codex', command: 'codex' }));
    expect(cmd).toBe("codex --model 'sonnet'");
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
