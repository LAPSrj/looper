import { execFile } from 'node:child_process';
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

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(String(stdout));
    });
  });
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
