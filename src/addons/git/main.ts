// The Git addon's program: Looper runs it with its own Node and talks to it
// over stdin and stdout, one JSON-RPC 2.0 message per line (src/shared/addons.ts).
import { createInterface } from 'node:readline';
import { createGitAddon, type LooperLink } from './addon';

interface Message {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

const write = (msg: object): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
};
// Looper may stop reading before the last answers are written.
process.stdout.on('error', () => undefined);

/** The addon's own requests waiting for Looper's answer, by id ("q1", "q2"…). */
const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let lastId = 0;
let closed = false;
/** Looper's requests still being answered. */
let answering = 0;

const looper: LooperLink = {
  request(method, params) {
    if (closed) return Promise.reject(new Error('Looper closed the connection.'));
    const id = `q${++lastId}`;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      write({ id, method, params });
    });
  },
  refresh(params) {
    if (!closed) write({ method: 'refresh', params });
  },
};

const addon = createGitAddon(looper);

function answer(msg: Message & { method: string }): void {
  answering++;
  Promise.resolve()
    // A window the addon opens while answering (git's prompt during a pull) goes over the one this request came from.
    .then(() => addon.handle(msg.method, msg.params ?? {}, typeof msg.id === 'number' && Number.isInteger(msg.id) && msg.id > 0 ? { request: msg.id } : {}))
    .then(
      (result) => write({ id: msg.id, result }),
      (e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        write({ id: msg.id, error: { code: (err as { code?: unknown }).code === -32601 ? -32601 : -32000, message: err.message || 'The Git addon failed.' } });
      },
    )
    .finally(() => answering--);
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      process.stderr.write(`A line from Looper isn't JSON: ${line.slice(0, 80)}\n`);
      return;
    }
    if (typeof msg.method === 'string') {
      if (msg.id === undefined || msg.id === null) addon.notify(msg.method, msg.params ?? {});
      else answer(msg as Message & { method: string });
      return;
    }
    // An answer to one of the addon's requests.
    const pending = typeof msg.id === 'string' ? waiting.get(msg.id) : undefined;
    if (!pending) return;
    waiting.delete(msg.id as string);
    if (msg.error) pending.reject(new Error(msg.error.message || 'Looper refused the request.'));
    else pending.resolve(msg.result);
  })
  .on('close', () => {
    // Nothing more can come from Looper: the requests waiting on it fail, the
    // ones being answered finish, and the process ends once nothing is left.
    closed = true;
    addon.close();
    for (const p of waiting.values()) p.reject(new Error('Looper closed the connection.'));
    waiting.clear();
    if (answering) process.stderr.write(`Finishing ${answering} request${answering === 1 ? '' : 's'} before exiting.\n`);
  });
