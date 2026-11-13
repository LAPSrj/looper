// Relative imports only: the main process, the renderer and the unit tests all load it.

/** ending: it ends within days; any-day: it can end any day now; needed: Claude Code has no usable login. */
export type LoginStage = 'ending' | 'any-day' | 'needed';

/** A Claude Code login that harnesses start on, as `claude auth status` reports it. */
export interface ClaudeLogin {
  /** The environment and Claude Code's config directory in it: harnesses that share both share the login. */
  key: string;
  environmentId: string;
  /** The harnesses on it and their environment: "Work in WSL". */
  name: string;
  /** The harnesses on it; Log In runs the first one's. */
  harnessIds: string[];
  loggedIn: boolean;
  /** The latest it ends (ms since the epoch); it can end up to LOGIN_EARLY_MS before. */
  expiresAt?: number;
  /** When a run or chat on it failed because Claude Code had no login; unset once it works again. */
  failedAt?: number;
  /** What it needs from the user now (loginStage when it was sent); null while nothing does. */
  stage: LoginStage | null;
}

const DAY = 86_400_000;
/** Claude Code says a login ends "between <its expiry − 3 days> and <its expiry>". */
export const LOGIN_EARLY_MS = 3 * DAY;
/** The warning starts this long before the earliest the login can end. */
export const LOGIN_NOTICE_MS = 3 * DAY;

/** What the login needs from the user at `now`. A login that was never there (no expiry known, nothing failed) needs nothing. */
export function loginStage(l: Omit<ClaudeLogin, 'stage'>, now: number): LoginStage | null {
  if (l.failedAt !== undefined) return 'needed';
  if (l.expiresAt === undefined) return null;
  if (!l.loggedIn || now >= l.expiresAt) return 'needed';
  if (now >= l.expiresAt - LOGIN_EARLY_MS) return 'any-day';
  if (now >= l.expiresAt - LOGIN_EARLY_MS - LOGIN_NOTICE_MS) return 'ending';
  return null;
}

/** When loginStage next changes on its own, with time passing; null when it won't. */
export function nextStageAt(l: Omit<ClaudeLogin, 'stage'>, now: number): number | null {
  if (l.failedAt !== undefined || l.expiresAt === undefined || !l.loggedIn) return null;
  const at = [l.expiresAt - LOGIN_EARLY_MS - LOGIN_NOTICE_MS, l.expiresAt - LOGIN_EARLY_MS, l.expiresAt].find((t) => t > now);
  return at ?? null;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const day = (ms: number): string => dayFormat.format(ms);

export function loginProblem(l: ClaudeLogin, stage: LoginStage): string {
  if (stage === 'needed' || l.expiresAt === undefined) return 'Claude Code needs you to log in again.';
  if (stage === 'any-day') return `The Claude Code login can end any day now, by ${day(l.expiresAt)}.`;
  return `The Claude Code login ends between ${day(l.expiresAt - LOGIN_EARLY_MS)} and ${day(l.expiresAt)}.`;
}

/** A Needs attention row for a login. */
export interface LoginRow {
  login: ClaudeLogin;
  stage: LoginStage;
  level: 'error' | 'warning';
  problem: string;
}

/** The logins that need the user, the ones Claude Code can't use first. */
export function loginRows(logins: readonly ClaudeLogin[]): LoginRow[] {
  const rows: LoginRow[] = [];
  for (const login of logins) {
    const { stage } = login;
    if (stage) rows.push({ login, stage, level: stage === 'needed' ? 'error' : 'warning', problem: loginProblem(login, stage) });
  }
  return rows.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

/** What Clear remembers a row by: a later stage, or the login renewed, is a new row. */
export const loginRowKey = (r: LoginRow): string => `login|${r.login.key}|${r.stage}|${r.login.expiresAt ?? ''}`;

/**
 * Claude Code's error when it has no usable login, as a chat's or run's error
 * shows it: "Please run /login · API Error: 401 Invalid authentication
 * credentials", "Not logged in · Please run /login", "OAuth token revoked ·
 * Please run /login". Its warning before the end ("· run /login to renew")
 * doesn't match.
 */
export const LOGIN_FAILED_RE = /Please run \/login · API Error|· Please run \/login/;
