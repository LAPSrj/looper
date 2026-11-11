import { execOffThread } from '../exec-worker';

/** Kill a host-side process tree. Windows needs taskkill for the tree; elsewhere the signal is enough. */
export async function killHostTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (process.platform === 'win32') {
    await execOffThread('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}
