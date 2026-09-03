/** Human labels of run results, shared by the UI and notification text. */
const RESULT_LABELS: Record<string, string> = {
  act: 'Action',
  done: 'Done',
  success: 'Success',
  warning: 'Warning',
  noop: 'No action',
  skipped: 'Skipped',
  started: 'Started',
  error: 'Error',
  'max-runtime': 'Timed out',
  interrupted: 'Interrupted',
  'idle-timeout': 'Idle timeout',
  held: 'Held',
  stopped: 'Stopped',
};

export function resultLabel(result: string): string {
  return RESULT_LABELS[result] ?? result;
}

export function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
