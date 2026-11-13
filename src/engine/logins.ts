import { loginStage, nextStageAt, type ClaudeLogin } from '../shared/logins';
import type { Environment, Harness, Settings } from '../shared/types';
import { envPrefix, envSide, runProbe } from './discover-models';
import type { HostKind } from './host';
import type { Logger } from './log';

/** How often the logins are read, and how often while one needs the user (so a login renewed outside Looper clears soon). */
const CHECK_MS = 6 * 3_600_000;
const WARNING_CHECK_MS = 10 * 60_000;
/** A failure or a changed harness reads them again this soon. */
const SOON_MS = 5_000;

export interface AuthStatus {
  loggedIn: boolean;
  loginExpiresAt?: string;
  configDirectory?: string;
}

export interface ClaudeLoginsDeps {
  settings: Settings;
  host: HostKind;
  log: Logger;
  emit: (logins: ClaudeLogin[]) => void;
  /** Tests answer for `claude auth status`. */
  status?: (env: Environment, harness: Harness) => Promise<AuthStatus>;
  now?: () => number;
}

const posixQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The harness's command line with its own arguments (an account profile among them) and `rest` after them. */
export function harnessCommand(side: 'posix' | 'windows', harness: Harness, rest: string): string {
  const quote = side === 'posix' ? posixQuote : psQuote;
  return [harness.command, ...harness.args.map(quote), rest].join(' ');
}

/** `claude auth status --json` in the harness's environment, with its arguments and variables. */
async function authStatus(env: Environment, harness: Harness, host: HostKind): Promise<AuthStatus> {
  const side = envSide(env, host);
  const out = await runProbe(env, host, envPrefix(side, harness.env) + harnessCommand(side, harness, 'auth status --json'));
  const start = out.indexOf('{');
  if (start < 0) throw new Error('auth status printed no JSON');
  const raw = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)) as Record<string, unknown>;
  return {
    loggedIn: raw.loggedIn === true,
    ...(typeof raw.loginExpiresAt === 'string' ? { loginExpiresAt: raw.loginExpiresAt } : {}),
    ...(typeof raw.configDirectory === 'string' ? { configDirectory: raw.configDirectory } : {}),
  };
}

/** The Claude Code harnesses whose login Looper watches: an API key in the harness's variables needs none. */
function watched(settings: Settings): { env: Environment; harness: Harness }[] {
  return settings.environments.flatMap((env) =>
    env.harnesses.filter((h) => h.kind === 'claude-code' && !h.env.ANTHROPIC_API_KEY).map((harness) => ({ env, harness })),
  );
}

const harnessKey = (environmentId: string, harnessId: string) => `${environmentId}|${harnessId}`;

/**
 * The Claude Code logins the harnesses start on. Claude Code says how long
 * each lasts (`claude auth status`), and Looper reads it after its start and
 * every few hours; a run or chat that fails for want of a login marks its
 * login until the login changes or something on it works again.
 */
export class ClaudeLogins {
  private logins: ClaudeLogin[] = [];
  /** The last answer for each harness: a check that fails keeps it. */
  private answers = new Map<string, { status: AuthStatus; at: number }>();
  /** When a run or chat on each harness failed for want of a login. */
  private failures = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checking = false;
  private again = false;
  private started = false;
  private emitted = '[]';

  constructor(private readonly d: ClaudeLoginsDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  start(): void {
    this.started = true;
    void this.check();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  state(): ClaudeLogin[] {
    return this.logins;
  }

  /** A run or chat on the harness failed because Claude Code had no login. */
  failed(environmentId: string, harnessId: string): void {
    const key = harnessKey(environmentId, harnessId);
    if (this.failures.has(key)) return;
    this.failures.set(key, this.now());
    this.d.log.warn(`Claude Code has no login for harness ${harnessId}: Log In shows on the dashboard`);
    this.publish();
    this.schedule(SOON_MS);
  }

  /** A run or chat on the harness worked: its login does. */
  worked(environmentId: string, harnessId: string): void {
    if (this.failures.delete(harnessKey(environmentId, harnessId))) this.publish();
  }

  /** The harnesses changed, or a login may have (Log In ended): read them again soon. */
  recheck(): void {
    if (this.started) this.schedule(SOON_MS);
  }

  private schedule(ms: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, ms);
  }

  async check(): Promise<void> {
    if (this.checking) {
      this.again = true;
      return;
    }
    this.checking = true;
    try {
      const list = watched(this.d.settings);
      await Promise.all(
        list.map(async ({ env, harness }) => {
          const key = harnessKey(env.id, harness.id);
          try {
            const status = await (this.d.status ?? ((e, h) => authStatus(e, h, this.d.host)))(env, harness);
            const before = this.answers.get(key)?.status;
            // Logged in again (a later end, or logged in at all): what failed before was the old login.
            if (status.loggedIn && (!before?.loggedIn || (before.loginExpiresAt !== status.loginExpiresAt && !!before.loginExpiresAt))) {
              this.failures.delete(key);
            }
            this.answers.set(key, { status, at: this.now() });
          } catch (err) {
            this.d.log.info(`cannot read the Claude Code login of harness ${harness.name} in ${env.name}: ${(err as Error).message}`);
          }
        }),
      );
      const live = new Set(list.map(({ env, harness }) => harnessKey(env.id, harness.id)));
      for (const k of [...this.answers.keys()]) if (!live.has(k)) this.answers.delete(k);
      for (const k of [...this.failures.keys()]) if (!live.has(k)) this.failures.delete(k);
      this.publish();
    } finally {
      this.checking = false;
    }
    if (this.again) {
      this.again = false;
      return this.check();
    }
    const now = this.now();
    // A stage that starts before the next read starts with a read of its own.
    const boundaries = this.logins.map((l) => nextStageAt(l, now)).filter((t): t is number => t !== null);
    const every = this.logins.some((l) => l.stage !== null) ? WARNING_CHECK_MS : CHECK_MS;
    this.schedule(Math.min(every, ...boundaries.map((t) => t - now + 1_000)));
  }

  /** The logins from the answers and failures, sent when they changed. */
  private publish(): void {
    const byKey = new Map<string, Omit<ClaudeLogin, 'stage'> & { names: string[]; envName: string }>();
    for (const { env, harness } of watched(this.d.settings)) {
      const hk = harnessKey(env.id, harness.id);
      const answer = this.answers.get(hk)?.status;
      const failedAt = this.failures.get(hk);
      // Nothing known and nothing failed: nothing to say about it.
      if (!answer && failedAt === undefined) continue;
      const key = `${env.id}|${answer?.configDirectory ?? harness.id}`;
      let login = byKey.get(key);
      if (!login) {
        const expires = answer?.loginExpiresAt ? Date.parse(answer.loginExpiresAt) : NaN;
        login = {
          key,
          environmentId: env.id,
          name: '',
          names: [],
          envName: env.name,
          harnessIds: [],
          loggedIn: answer?.loggedIn ?? false,
          ...(Number.isFinite(expires) ? { expiresAt: expires } : {}),
        };
        byKey.set(key, login);
      }
      login.harnessIds.push(harness.id);
      login.names.push(harness.name);
      if (failedAt !== undefined) login.failedAt = Math.min(login.failedAt ?? failedAt, failedAt);
    }
    const now = this.now();
    this.logins = [...byKey.values()].map(({ names, envName, ...l }) => ({ ...l, name: `${names.join(', ')} in ${envName}`, stage: loginStage(l, now) }));
    const json = JSON.stringify(this.logins);
    if (json === this.emitted) return;
    this.emitted = json;
    this.d.emit(this.logins);
  }
}
