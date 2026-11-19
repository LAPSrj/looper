import { parentPort, type MessagePort } from 'node:worker_threads';
import { CleanLog } from './cleanlog';
import { CommandText } from './command-text';
import { ScreenModel } from './screen';

/**
 * Messages the host sends to the worker, each for one terminal (`id`): one worker serves every terminal. A terminal
 * with `text` sends its output back as text (CommandText) instead of writing a clean log to `file`.
 */
export type TerminalIn =
  | { type: 'init'; id: number; file: string; cols: number; rows: number; screen: boolean; append?: boolean; text?: boolean }
  | { type: 'write'; id: number; data: string }
  | { type: 'resize'; id: number; cols: number; rows: number }
  | { type: 'close'; id: number };

/** Messages the worker sends back to the host. */
export type TerminalOut =
  | { type: 'screen'; id: number; text: string }
  | { type: 'text'; id: number; text: string }
  | { type: 'closed'; id: number }
  | { type: 'failed'; id: number; message: string };

/** How long the screen snapshot may lag behind the pty stream. */
const SNAPSHOT_MS = 100;

function hostPort(): MessagePort {
  if (!parentPort) throw new Error('terminal-worker must be started as a worker thread');
  return parentPort;
}

const port = hostPort();

interface Terminal {
  log: CleanLog | null;
  text: CommandText | null;
  screen: ScreenModel | null;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
}

const terminals = new Map<number, Terminal>();

/** At most one snapshot per window, and always one within SNAPSHOT_MS of the last write. */
function scheduleSnapshot(id: number, t: Terminal): void {
  if (!t.screen || t.closing || t.snapshotTimer !== null) return;
  t.snapshotTimer = setTimeout(() => {
    t.snapshotTimer = null;
    if (!t.screen || t.closing) return;
    port.postMessage({ type: 'screen', id, text: t.screen.text() } satisfies TerminalOut);
  }, SNAPSHOT_MS);
}

async function close(id: number, t: Terminal): Promise<void> {
  if (t.closing) return;
  t.closing = true;
  if (t.snapshotTimer !== null) {
    clearTimeout(t.snapshotTimer);
    t.snapshotTimer = null;
  }
  try {
    await t.log?.close();
    await t.text?.end();
  } catch {
    /* never fatal */
  }
  t.log = null;
  t.text = null;
  try {
    t.screen?.dispose();
  } catch {
    /* never fatal */
  }
  t.screen = null;
  terminals.delete(id);
  port.postMessage({ type: 'closed', id } satisfies TerminalOut);
}

port.on('message', (msg: TerminalIn) => {
  if (msg.type === 'init') {
    // One terminal that can't start (its log can't be opened) mustn't take the others down with the worker.
    try {
      const id = msg.id;
      terminals.set(id, {
        log: msg.text ? null : new CleanLog(msg.file, msg.cols, msg.rows, msg.append),
        text: msg.text ? new CommandText(msg.cols, msg.rows, (text) => port.postMessage({ type: 'text', id, text } satisfies TerminalOut)) : null,
        screen: msg.screen ? new ScreenModel(msg.cols, msg.rows) : null,
        snapshotTimer: null,
        closing: false,
      });
    } catch (e) {
      port.postMessage({ type: 'failed', id: msg.id, message: e instanceof Error ? e.message : String(e) } satisfies TerminalOut);
    }
    return;
  }
  const t = terminals.get(msg.id);
  if (!t) {
    // Closed already (or never started): a close still gets its answer.
    if (msg.type === 'close') port.postMessage({ type: 'closed', id: msg.id } satisfies TerminalOut);
    return;
  }
  // A throw here would end the worker and every terminal in it: it fails only this one.
  const failed = (e: unknown) => {
    if (t.closing) return;
    t.closing = true;
    terminals.delete(msg.id);
    port.postMessage({ type: 'failed', id: msg.id, message: e instanceof Error ? e.message : String(e) } satisfies TerminalOut);
  };
  try {
    switch (msg.type) {
      case 'write':
        if (t.closing) return;
        t.log?.write(msg.data);
        t.text?.write(msg.data);
        if (t.screen) void t.screen.write(msg.data).then(() => scheduleSnapshot(msg.id, t), failed);
        break;
      case 'resize':
        if (t.closing) return;
        t.log?.resize(msg.cols, msg.rows);
        t.text?.resize(msg.cols, msg.rows);
        t.screen?.resize(msg.cols, msg.rows);
        break;
      case 'close':
        void close(msg.id, t).catch(failed);
        break;
    }
  } catch (e) {
    failed(e);
  }
});
