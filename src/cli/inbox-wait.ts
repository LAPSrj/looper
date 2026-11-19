import fs from 'node:fs';
import path from 'node:path';
import { RESULT_EXT } from '../engine/inbox';

export type InboxOutcome =
  /** `result`: what the app wrote back for it (a new chat's id and a line about it). */
  | { status: 'processed'; result?: string }
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
  const processed = moved(path.join(dir, 'processed'), name);
  if (!processed) return { status: 'vanished' };
  try {
    return { status: 'processed', result: fs.readFileSync(processed + RESULT_EXT, 'utf8').trimEnd() };
  } catch {
    return { status: 'processed' };
  }
}
