import { execOffThread, spawnOffThread, type OffThreadChild } from './exec-worker';
import type { PowerOps } from './rest';

/**
 * Windows power commands for Rest Mode, all non-elevated.
 *
 * Sleep goes through PowerShell's SetSuspendState — never
 * `rundll32 powrprof.dll,SetSuspendState`, which mangles its arguments,
 * hibernates on machines with hibernation enabled, and disables wake events
 * (killing the wake timer). The wake is an app-owned Task Scheduler task with
 * WakeToRun; `schtasks` cannot set that flag, so registration is PowerShell
 * too. The task's action is a no-op — the resident app detects the resume
 * itself via powerMonitor.
 */

const TASK_PATH = '\\Looper\\';
const TASK_NAME = 'Wake';

async function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  const { error, stdout, stderr } = await execOffThread(cmd, args, { timeout: timeoutMs, windowsHide: true });
  if (error) throw new Error(stderr.trim() || error.message);
  return stdout;
}

function ps(script: string, timeoutMs = 60_000): Promise<string> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs);
}

/** Local wall-clock ISO ("2026-09-05T03:40:00"): [datetime] parses it culture-independently. */
function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function createWindowsPowerOps(): PowerOps {
  return {
    async suspend(): Promise<void> {
      // No timeout: the PowerShell child freezes with the system and returns
      // after the resume; killing it mid-sleep would be pointless.
      await ps(
        "Add-Type -AssemblyName System.Windows.Forms; " +
          '[System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false) | Out-Null',
        0,
      );
    },

    async registerWake(atMs: number): Promise<void> {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]'${localIso(new Date(atMs))}')`,
        "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit'",
        '$settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
        `Register-ScheduledTask -TaskName '${TASK_NAME}' -TaskPath '${TASK_PATH}' -Trigger $trigger -Action $action -Settings $settings -Force | Out-Null`,
        `$task = Get-ScheduledTask -TaskName '${TASK_NAME}' -TaskPath '${TASK_PATH}'`,
        "if (-not $task.Settings.WakeToRun) { throw 'WakeToRun did not stick' }",
        "Write-Output 'OK'",
      ].join('; ');
      const out = await ps(script);
      if (!/\bOK\b/.test(out)) throw new Error(`wake task not verified: ${out.trim() || '(no output)'}`);
    },

    async clearWake(): Promise<void> {
      await ps(
        `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -TaskPath '${TASK_PATH}' -Confirm:$false -ErrorAction SilentlyContinue`,
      );
    },
  };
}

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED, set again for each line Looper sends and held until it closes the helper's input or exits.
const HOLD_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$k = Add-Type -Name ExecutionState -Namespace Looper -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(int flags);'`,
  'do { if ($k::SetThreadExecutionState(0x80000001) -eq 0) { exit 1 } } while ($null -ne [Console]::In.ReadLine())',
].join('; ');

/**
 * Keeps Windows from sleeping on idle while anyone holds it: a PowerShell child calls SetThreadExecutionState and
 * waits for its input to close. Electron's powerSaveBlocker can't do this. Its 'prevent-app-suspension' is an
 * execution-required request, which keeps only a traditional (S3) sleep computer awake, not a Modern Standby one,
 * and 'prevent-display-sleep' keeps the screen on. As PowerToys Awake does, the hold is set again after a resume and
 * when the power source changes (`reapply`), because Windows drops it on a sleep the user starts.
 */
export class SystemAwake {
  private readonly holders = new Set<string>();
  private child: OffThreadChild | null = null;

  constructor(
    private readonly onError: (message: string) => void,
    private readonly spawn = spawnOffThread,
  ) {}

  hold(holder: string, on: boolean): void {
    if (on) this.holders.add(holder);
    else this.holders.delete(holder);
    if (this.holders.size > 0 && !this.child) this.start();
    else if (this.holders.size === 0 && this.child) {
      this.child.stdin?.end();
      this.child = null;
    }
  }

  reapply(): void {
    this.child?.stdin?.write('\n');
  }

  private start(): void {
    const child = this.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HOLD_SCRIPT], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let why = '';
    child.on('error', (err) => (why += err.message));
    child.stderr?.on('data', (d: Buffer) => (why += d.toString()));
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.onError(`keep awake: the helper ended while held (exit ${code})${why.trim() ? `: ${why.trim()}` : ''}`);
    });
    this.child = child;
  }
}

/**
 * Whether Windows "Allow wake timers" is enabled per power source, read
 * non-elevated from the active scheme. The Current AC/DC lines are the last
 * two hex indexes in the output (0 = Disable), which sidesteps the
 * locale-dependent labels. Undefined when the output isn't parseable.
 */
export async function readWakeTimerPolicy(): Promise<{ ac: boolean; dc: boolean } | undefined> {
  try {
    const out = await run('powercfg', ['/q', 'SCHEME_CURRENT', 'SUB_SLEEP', 'RTCWAKE'], 15_000);
    const hexes = [...out.matchAll(/:\s*0x([0-9a-fA-F]+)\s*$/gm)].map((m) => parseInt(m[1], 16));
    if (hexes.length < 2) return undefined;
    const [ac, dc] = hexes.slice(-2);
    return { ac: ac !== 0, dc: dc !== 0 };
  } catch {
    return undefined;
  }
}
