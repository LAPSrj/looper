import { execFile } from 'node:child_process';

/** Kill a host-side process tree. Windows needs taskkill for the tree; elsewhere the signal is enough. */
export function killHostTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
    resolve();
  });
}
