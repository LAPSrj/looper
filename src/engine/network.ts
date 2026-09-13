import dns from 'node:dns';
import net from 'node:net';

/**
 * Telling "the computer was offline" apart from "the job failed". A run that
 * only failed because the network dropped is not the task's fault: it must not
 * count toward the auto-pause streak and, by default, must not toast.
 *
 * Two signals feed the verdict: the text a failed step printed, and — when the
 * text says nothing either way — a live connectivity probe. Nothing here ever
 * throws; an inconclusive answer is always "not the network".
 */

/**
 * What an unreachable network looks like across the tools an agent runs:
 * Node/libuv codes, curl/git/gh/wget, Go, Python urllib3, PowerShell/.NET, and
 * Claude Code's own banner. The short codes are word-bounded so neither
 * `ENOTFOUNDX` nor ordinary prose can match; HTTP-level failures (404, 401,
 * invalid key) are deliberately absent — those are answers from a server that
 * was perfectly reachable.
 */
export const NETWORK_ERROR_RE = new RegExp(
  [
    // Node / libuv.
    String.raw`\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b`,
    String.raw`\bgetaddrinfo\b`,
    String.raw`\bfetch\s+failed\b`,
    // curl / git / gh / wget / Go.
    String.raw`could\s+not\s+resolve\s+host`,
    String.raw`failed\s+to\s+connect\s+to`,
    String.raw`connection\s+timed\s+out`,
    String.raw`network\s+is\s+unreachable`,
    String.raw`temporary\s+failure\s+in\s+name\s+resolution`,
    String.raw`no\s+such\s+host`,
    String.raw`\bdial\s+tcp\b`,
    // Python (urllib3 / requests).
    String.raw`NewConnectionError`,
    String.raw`max\s+retries\s+exceeded`,
    String.raw`name\s+or\s+service\s+not\s+known`,
    // PowerShell / .NET.
    String.raw`the\s+remote\s+name\s+could\s+not\s+be\s+resolved`,
    String.raw`unable\s+to\s+connect\s+to\s+the\s+remote\s+server`,
    // Rust reqwest (codex).
    String.raw`error\s+sending\s+request`,
    // Claude Code.
    String.raw`can['’]t\s+reach\s+the\s+API\s+server`,
  ].join('|'),
  'i',
);

/**
 * Claude Code's interactive retry banner, e.g. "· Retrying in 9s · attempt
 * 3/10". It means the API is unreachable *right now* — but claude keeps
 * retrying for about three minutes and often recovers, so this never ends a
 * session on its own; it only explains a timer that fired while it was up.
 */
export const CLAUDE_RETRY_RE = /retrying\s+in\s+\d+\s*s\b[\s·•-]*attempt\s+\d+\s*\/\s*\d+/i;

/**
 * Claude Code's own "the API is out of reach" banner (rest of the line kept
 * for the headline). This is the only network pattern a *session* may be
 * blamed on: an agent's tool output can legitimately contain ECONNREFUSED and
 * friends (a curl it ran against a dead server) without the harness itself
 * having lost the API.
 */
export const CLAUDE_NETWORK_RE = /(?:API\s+Error:\s*)?can['’]t\s+reach\s+the\s+API\s+server[^\n]*/i;

export function looksLikeNetworkError(text: string | undefined): boolean {
  return !!text && NETWORK_ERROR_RE.test(text);
}

/** Probed host: the one every claude run needs. */
const PROBE_HOST = 'api.anthropic.com';
const PROBE_PORT = 443;
const PROBE_TIMEOUT_MS = 3000;
/** A cycle asks several times within seconds; one answer serves them all. */
const PROBE_CACHE_MS = 10_000;

let cached: { at: number; online: boolean } | null = null;
let override: (() => Promise<boolean>) | null = null;

/** Replace the real probe (tests must never touch the network); null restores it. */
export function setConnectivityProbe(fn: (() => Promise<boolean>) | null): void {
  override = fn;
  cached = null;
}

function withTimeout(p: Promise<boolean>): Promise<boolean> {
  return Promise.race([p, new Promise<boolean>((r) => setTimeout(() => r(false), PROBE_TIMEOUT_MS).unref?.())]);
}

function lookupOk(): Promise<boolean> {
  return withTimeout(dns.promises.lookup(PROBE_HOST).then(() => true, () => false));
}

/** DNS can be cached or hijacked by a captive portal, so a real socket is the second opinion. */
function connectOk(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: PROBE_HOST, port: PROBE_PORT });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** True when the machine can reach the API. Cached for PROBE_CACHE_MS. */
export async function probeConnectivity(opts: { now?: () => number } = {}): Promise<boolean> {
  const at = (opts.now ?? Date.now)();
  if (cached && at - cached.at < PROBE_CACHE_MS) return cached.online;
  const online = override ? await override() : (await Promise.all([lookupOk(), connectOk()])).some(Boolean);
  cached = { at, online };
  return online;
}

/**
 * A step that "ran" this far past its own timeout can only have spanned a
 * system sleep: awake, the runner force-finishes within seconds of the timer.
 * The slack is generous so kill/teardown lag can never blame a real overrun
 * on sleep.
 */
export const SLEEP_SLACK_MS = 120_000;

export function sleptThrough(durationMs: number, timeoutMs: number): boolean {
  return durationMs > timeoutMs + SLEEP_SLACK_MS;
}

/**
 * Did this failure happen because the computer was offline? The text decides
 * when it names a network failure; otherwise a step that *could* have been the
 * network (spawn failure, non-zero exit, timeout) is probed. A probe that
 * itself blows up proves nothing, so it reads as "not the network".
 */
export async function classifyFailure(input: {
  text?: string;
  mayBeNetwork: boolean;
  probe?: () => Promise<boolean>;
}): Promise<boolean> {
  if (looksLikeNetworkError(input.text)) return true;
  if (!input.mayBeNetwork) return false;
  try {
    return !(await (input.probe ? input.probe() : probeConnectivity()));
  } catch {
    return false;
  }
}
