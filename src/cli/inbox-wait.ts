import fs from 'node:fs';
import path from 'node:path';

export type InboxOutcome =
  | { status: 'processed' }
  | { status: 'rejected'; reason: string }
  /** The file left the inbox but is in neither processed/ nor rejected/. */
  | { status: 'vanished' }
  /** Still in the inbox when the wait ran out: no running app picked it up. */
  | { status: 'pending' };

/** The file a running app moved `name` to in `dir` (it prefixes a timestamp), if any. */
function moved(dir: string, name: string): string | undefined {
  try {
    const hit = fs.readdirSync(dir).find((n) => n.endsWith(`-${name}`));
    return hit && path.join(dir, hit);
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a running app to handle a file dropped into its inbox, and report
 * where it was filed. A rejection's reason is written to `<file>.error.txt`
 * right after the move, so it gets a short grace period of its own.
 */
export async function waitForInbox(file: string, timeoutMs: number, intervalMs = 250): Promise<InboxOutcome> {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(file)) {
    if (Date.now() >= deadline) return { status: 'pending' };
    await sleep(intervalMs);
  }
  const rejected = moved(path.join(dir, 'rejected'), name);
  if (rejected) {
    const graceEnd = Date.now() + 2000;
    for (;;) {
      try {
        return { status: 'rejected', reason: fs.readFileSync(rejected + '.error.txt', 'utf8').trim() };
      } catch {
        if (Date.now() >= graceEnd) return { status: 'rejected', reason: 'no reason recorded' };
        await sleep(intervalMs);
      }
    }
  }
  return moved(path.join(dir, 'processed'), name) ? { status: 'processed' } : { status: 'vanished' };
}
