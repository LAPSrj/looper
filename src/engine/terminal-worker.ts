import { parentPort, type MessagePort } from 'node:worker_threads';
import { CleanLog } from './cleanlog';
import { ScreenModel } from './screen';

/** Messages the host sends to the worker. */
export type TerminalIn =
  | { type: 'init'; file: string; cols: number; rows: number; screen: boolean }
  | { type: 'write'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' };

/** Messages the worker sends back to the host. */
export type TerminalOut = { type: 'screen'; text: string } | { type: 'closed' };

/** How long the screen snapshot may lag behind the pty stream. */
const SNAPSHOT_MS = 100;

function hostPort(): MessagePort {
  if (!parentPort) throw new Error('terminal-worker must be started as a worker thread');
  return parentPort;
}

const port = hostPort();

let log: CleanLog | null = null;
let screen: ScreenModel | null = null;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let closing = false;

/** At most one snapshot per window, and always one within SNAPSHOT_MS of the last write. */
function scheduleSnapshot(): void {
  if (!screen || closing || snapshotTimer !== null) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    if (!screen || closing) return;
    port.postMessage({ type: 'screen', text: screen.text() } satisfies TerminalOut);
  }, SNAPSHOT_MS);
}

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  if (snapshotTimer !== null) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  try {
    await log?.close();
  } catch {
    /* never fatal */
  }
  log = null;
  try {
    screen?.dispose();
  } catch {
    /* never fatal */
  }
  screen = null;
  port.postMessage({ type: 'closed' } satisfies TerminalOut);
  port.close();
}

port.on('message', (msg: TerminalIn) => {
  switch (msg.type) {
    case 'init':
      log = new CleanLog(msg.file, msg.cols, msg.rows);
      if (msg.screen) screen = new ScreenModel(msg.cols, msg.rows);
      break;
    case 'write':
      if (closing) return;
      log?.write(msg.data);
      if (screen) void screen.write(msg.data).then(scheduleSnapshot);
      break;
    case 'resize':
      if (closing) return;
      log?.resize(msg.cols, msg.rows);
      screen?.resize(msg.cols, msg.rows);
      break;
    case 'close':
      void close();
      break;
  }
});
