import fs from 'node:fs';
import path from 'node:path';
import { guidanceMessage, guidanceText } from '../shared/messages';

/**
 * Guidance for a running agent waits in the run dir until something hands it
 * over: a hook (claude PostToolUse / Stop, codex PostToolUse), the session
 * typing it into an idle terminal, or the scheduler starting a continuation
 * run when the agent ended without reading it. Every taker renames the file
 * first, so two of them can never deliver the same guidance twice; the renamed
 * copy (guidance-<stamp>.json) stays in the run dir as the record of it.
 *
 * The file holds the whole message as one JSON string literal with every
 * non-ASCII character escaped: the hooks splice it into their JSON output as
 * is, and plain ASCII survives any console code page on Windows.
 */
export const GUIDANCE_FILE = 'guidance.json';

function asciiJson(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** The user's text out of a guidance file, or null when it is absent or torn. */
function readGuidanceFile(file: string): string | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof v === 'string' ? guidanceText(v) : null;
  } catch {
    return null;
  }
}

/** Rename the waiting guidance to `dest`; false when there was none (or a hook took it first). */
function claim(runDir: string, dest: string): boolean {
  try {
    fs.renameSync(path.join(runDir, GUIDANCE_FILE), dest);
    return true;
  } catch {
    return false;
  }
}

/** The guidance still waiting for the agent, or null. */
export function readPendingGuidance(runDir: string): string | null {
  return readGuidanceFile(path.join(runDir, GUIDANCE_FILE));
}

/** Take the waiting guidance for delivery; null when there is none. */
export function takePendingGuidance(runDir: string): string | null {
  const dest = path.join(runDir, `guidance-${Date.now()}.json`);
  return claim(runDir, dest) ? readGuidanceFile(dest) : null;
}

/** Add guidance for the agent, after whatever is still waiting from earlier. */
export function queueGuidance(runDir: string, text: string): void {
  const merging = path.join(runDir, `guidance-merging-${process.pid}.json`);
  let combined = text;
  if (claim(runDir, merging)) {
    const earlier = readGuidanceFile(merging);
    if (earlier) combined = earlier + '\n\n' + text;
    fs.rmSync(merging, { force: true });
  }
  const file = path.join(runDir, GUIDANCE_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, asciiJson(guidanceMessage(combined)), 'utf8');
  fs.renameSync(tmp, file);
}
