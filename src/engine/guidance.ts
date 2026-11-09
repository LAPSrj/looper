import fs from 'node:fs';
import path from 'node:path';
import { delegateMessage, delegateText, eventsMessage, eventsText, guidanceMessage, guidanceText } from '../shared/messages';
import { relatedIdIn } from '../shared/types';

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

/** Rename the waiting file to `dest`; false when there was none (or a hook took it first). */
function claim(runDir: string, file: string, dest: string): boolean {
  try {
    fs.renameSync(path.join(runDir, file), dest);
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
  return claim(runDir, GUIDANCE_FILE, dest) ? readGuidanceFile(dest) : null;
}

/**
 * A message from Looper itself (the context-limit warning) waits in its own
 * file, handed over the same way as guidance but never shown or kept as the
 * user's: a newer notice replaces a waiting one, and none ever starts a
 * continuation run.
 */
export const NOTICE_FILE = 'notice.json';

/** Leave a notice for the agent, replacing one still waiting. */
export function queueNotice(runDir: string, text: string): void {
  const file = path.join(runDir, NOTICE_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, asciiJson(text), 'utf8');
  fs.renameSync(tmp, file);
}

/** Take the waiting notice for delivery; null when there is none. */
export function takeNotice(runDir: string): string | null {
  const dest = path.join(runDir, `notice-${Date.now()}.json`);
  try {
    fs.renameSync(path.join(runDir, NOTICE_FILE), dest);
    const v: unknown = JSON.parse(fs.readFileSync(dest, 'utf8'));
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Related trigger events wait in their own file, handed over the same way as
 * guidance, after it. Whatever the agent never got goes back to the scheduler
 * with `takeEvents`, for the next run.
 */
export const EVENTS_FILE = 'events-waiting.json';

/** The related id of a trigger event line; a line that isn't JSON has none. */
export function relatedIdOfLine(line: string): string | undefined {
  try {
    return relatedIdIn(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Take the waiting events (for delivery, or back from a run that ended); null when there are none. */
export function takeEvents(runDir: string): string[] | null {
  const dest = path.join(runDir, `events-waiting-${Date.now()}.json`);
  if (!claim(runDir, EVENTS_FILE, dest)) return null;
  try {
    const v: unknown = JSON.parse(fs.readFileSync(dest, 'utf8'));
    const text = typeof v === 'string' ? eventsText(v) : null;
    return text ? text.split('\n') : null;
  } catch {
    return null;
  }
}

/** Add events for the agent, after whatever is still waiting, and keep them with the run's events file. */
export function queueEvents(runDir: string, lines: readonly string[]): void {
  const earlier = takeEvents(runDir) ?? [];
  const file = path.join(runDir, EVENTS_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, asciiJson(eventsMessage([...earlier, ...lines])), 'utf8');
  fs.renameSync(tmp, file);
  try {
    fs.appendFileSync(path.join(runDir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  } catch {
    /* only a copy: the agent gets the events from the file above */
  }
}

/**
 * The results and questions of the agents a run's agent started in other
 * folders wait in their own file, handed over the same way as guidance, after
 * the events.
 */
export const DELEGATE_FILE = 'delegate-waiting.json';

function readDelegateFile(file: string): string | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof v === 'string' ? delegateText(v) : null;
  } catch {
    return null;
  }
}

/** Add one agent's result or question for the run's agent, after whatever is still waiting. */
export function queueDelegateMessage(runDir: string, entry: string): void {
  const merging = path.join(runDir, `delegate-merging-${process.pid}.json`);
  const entries = [entry];
  if (claim(runDir, DELEGATE_FILE, merging)) {
    const earlier = readDelegateFile(merging);
    if (earlier) entries.unshift(earlier);
    fs.rmSync(merging, { force: true });
  }
  const file = path.join(runDir, DELEGATE_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, asciiJson(delegateMessage(entries)), 'utf8');
  fs.renameSync(tmp, file);
}

/** Take the waiting results and questions for delivery: their text without the header; null when there are none. */
export function takeDelegateMessages(runDir: string): string | null {
  const dest = path.join(runDir, `delegate-waiting-${Date.now()}.json`);
  return claim(runDir, DELEGATE_FILE, dest) ? readDelegateFile(dest) : null;
}

/** Add guidance for the agent, after whatever is still waiting from earlier. */
export function queueGuidance(runDir: string, text: string): void {
  const merging = path.join(runDir, `guidance-merging-${process.pid}.json`);
  let combined = text;
  if (claim(runDir, GUIDANCE_FILE, merging)) {
    const earlier = readGuidanceFile(merging);
    if (earlier) combined = earlier + '\n\n' + text;
    fs.rmSync(merging, { force: true });
  }
  const file = path.join(runDir, GUIDANCE_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, asciiJson(guidanceMessage(combined)), 'utf8');
  fs.renameSync(tmp, file);
}
