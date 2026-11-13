import { describe, expect, it, vi } from 'vitest';
import { ClaudeLogins, harnessCommand, type AuthStatus } from '../src/engine/logins';
import { Logger } from '../src/engine/log';
import { HeadlessStream } from '../src/engine/steps/session';
import { LOGIN_EARLY_MS, LOGIN_FAILED_RE, LOGIN_NOTICE_MS, loginRowKey, loginRows, loginStage, nextStageAt, type ClaudeLogin } from '../src/shared/logins';
import { SettingsSchema, type Environment, type Harness } from '../src/shared/types';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const EXPIRES = NOW + 30 * DAY;

const harness = (id: string, env: Record<string, string> = {}, kind: Harness['kind'] = 'claude-code'): Harness =>
  ({ id, name: id, kind, command: 'claude', args: [], env }) as Harness;

const wsl: Environment = {
  id: 'wsl',
  name: 'WSL',
  kind: 'local',
  harnesses: [
    harness('Claude'),
    harness('Opus'),
    harness('Work', { CLAUDE_CONFIG_DIR: '/home/u/.claude-work' }),
    harness('Key', { ANTHROPIC_API_KEY: 'sk-x' }),
    harness('Codex', {}, 'codex'),
  ],
};

function setup(answers: Record<string, AuthStatus | Error>) {
  const settings = SettingsSchema.parse({ environments: [wsl], defaultEnvironmentId: 'wsl' });
  let now = NOW;
  const emit = vi.fn<(l: ClaudeLogin[]) => void>();
  const asked: string[] = [];
  const logins = new ClaudeLogins({
    settings,
    host: 'linux',
    log: new Logger(),
    emit,
    now: () => now,
    status: async (_env, h) => {
      asked.push(h.id);
      const a = answers[h.id];
      if (a instanceof Error) throw a;
      return a;
    },
  });
  return { logins, emit, asked, setNow: (t: number) => (now = t) };
}

const iso = (ms: number) => new Date(ms).toISOString();
const home = { loggedIn: true, loginExpiresAt: iso(EXPIRES), configDirectory: '/home/u/.claude' };
const work = { loggedIn: true, loginExpiresAt: iso(EXPIRES + DAY), configDirectory: '/home/u/.claude-work' };

describe('Claude Code logins', () => {
  it('asks each Claude Code harness without an API key, and puts harnesses on one config directory on one login', async () => {
    const s = setup({ Claude: home, Opus: home, Work: work });
    await s.logins.check();
    expect(s.asked.sort()).toEqual(['Claude', 'Opus', 'Work']);
    expect(s.logins.state()).toEqual([
      { key: 'wsl|/home/u/.claude', environmentId: 'wsl', name: 'Claude, Opus in WSL', harnessIds: ['Claude', 'Opus'], loggedIn: true, expiresAt: EXPIRES, stage: null },
      { key: 'wsl|/home/u/.claude-work', environmentId: 'wsl', name: 'Work in WSL', harnessIds: ['Work'], loggedIn: true, expiresAt: EXPIRES + DAY, stage: null },
    ]);
  });

  it('sends the logins only when they change, and keeps the last answer when a read fails', async () => {
    const answers: Record<string, AuthStatus | Error> = { Claude: home, Opus: home, Work: work };
    const s = setup(answers);
    await s.logins.check();
    await s.logins.check();
    expect(s.emit).toHaveBeenCalledTimes(1);
    answers.Work = new Error('wsl.exe is not there');
    await s.logins.check();
    expect(s.emit).toHaveBeenCalledTimes(1);
    expect(s.logins.state()).toHaveLength(2);
  });

  it('warns from six days before the end, says any day in the last three, and needs a login after it', async () => {
    const s = setup({ Claude: home, Opus: home, Work: work });
    const stage = async (at: number) => {
      s.setNow(at);
      await s.logins.check();
      return s.logins.state()[0].stage;
    };
    expect(await stage(EXPIRES - LOGIN_EARLY_MS - LOGIN_NOTICE_MS - 1)).toBeNull();
    expect(await stage(EXPIRES - LOGIN_EARLY_MS - LOGIN_NOTICE_MS)).toBe('ending');
    expect(await stage(EXPIRES - LOGIN_EARLY_MS)).toBe('any-day');
    expect(await stage(EXPIRES)).toBe('needed');
  });

  it('marks a login that failed a run until something on it works or Claude Code logs in again', async () => {
    const answers: Record<string, AuthStatus | Error> = { Claude: home, Opus: home, Work: work };
    const s = setup(answers);
    await s.logins.check();
    s.logins.failed('wsl', 'Opus');
    expect(s.logins.state()[0]).toMatchObject({ stage: 'needed', failedAt: NOW });
    s.logins.worked('wsl', 'Opus');
    expect(s.logins.state()[0].stage).toBeNull();

    s.logins.failed('wsl', 'Opus');
    await s.logins.check();
    expect(s.logins.state()[0].stage).toBe('needed');
    answers.Claude = answers.Opus = { ...home, loginExpiresAt: iso(EXPIRES + 10 * DAY) };
    await s.logins.check();
    expect(s.logins.state()[0].stage).toBeNull();
  });

  it('shows a harness that failed before its first read as needing a login', () => {
    const s = setup({});
    s.logins.failed('wsl', 'Work');
    expect(s.logins.state()).toEqual([
      { key: 'wsl|Work', environmentId: 'wsl', name: 'Work in WSL', harnessIds: ['Work'], loggedIn: false, failedAt: NOW, stage: 'needed' },
    ]);
  });
});

describe('a login stage', () => {
  const login = { key: 'k', environmentId: 'e', name: 'Claude in WSL', harnessIds: ['h'], loggedIn: true, expiresAt: EXPIRES };

  it('needs nothing for a login Claude Code never had', () => {
    expect(loginStage({ ...login, loggedIn: false, expiresAt: undefined }, NOW)).toBeNull();
    expect(loginStage({ ...login, loggedIn: false }, NOW)).toBe('needed');
  });

  it('changes next at the start of the following stage', () => {
    expect(nextStageAt(login, NOW)).toBe(EXPIRES - LOGIN_EARLY_MS - LOGIN_NOTICE_MS);
    expect(nextStageAt(login, EXPIRES - LOGIN_EARLY_MS)).toBe(EXPIRES);
    expect(nextStageAt(login, EXPIRES)).toBeNull();
    expect(nextStageAt({ ...login, failedAt: NOW }, NOW)).toBeNull();
  });

  it('lists the logins that need the user, the unusable ones first, and a later stage is a new row for Clear', () => {
    const ending: ClaudeLogin = { ...login, key: 'a', stage: 'ending' };
    const needed: ClaudeLogin = { ...login, key: 'b', stage: 'needed' };
    const rows = loginRows([{ ...login, key: 'c', stage: null }, ending, needed]);
    expect(rows.map((r) => [r.login.key, r.level])).toEqual([
      ['b', 'error'],
      ['a', 'warning'],
    ]);
    expect(rows[0].problem).toBe('Claude Code needs you to log in again.');
    expect(rows[1].problem).toMatch(/^The Claude Code login ends between /);
    expect(loginRowKey(rows[1])).not.toBe(loginRowKey(loginRows([{ ...ending, stage: 'any-day' }])[0]));
  });
});

describe("Claude Code's error for a missing login", () => {
  it('matches the errors, and not the warning before the end', () => {
    expect(LOGIN_FAILED_RE.test('Please run /login · API Error: 401 Invalid authentication credentials')).toBe(true);
    expect(LOGIN_FAILED_RE.test('Not logged in · Please run /login')).toBe(true);
    expect(LOGIN_FAILED_RE.test('OAuth token revoked · Please run /login')).toBe(true);
    expect(LOGIN_FAILED_RE.test('⚠ Your login expires in 3 days · run /login to renew')).toBe(false);
  });

  it('ends a headless run as a missing login, from its API error or its result', () => {
    const a = new HeadlessStream();
    a.feed(
      JSON.stringify({
        type: 'assistant',
        is_api_error_message: true,
        message: { content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }] },
      }),
    );
    expect(a.loginFailed).toBe(true);
    const b = new HeadlessStream();
    b.feed(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }));
    expect(b.loginFailed).toBe(true);
    const c = new HeadlessStream();
    c.feed(JSON.stringify({ type: 'result', is_error: false, result: 'Done. Please run /login · API Error is what the user saw.' }));
    expect(c.loginFailed).toBe(false);
  });
});

describe("Log In's command", () => {
  it("runs the harness with its own arguments, quoted for the environment's shell", () => {
    const h = { ...harness('Work'), command: 'claude', args: ["--settings=it's.json"] };
    expect(harnessCommand('posix', h, 'auth login')).toBe(`claude '--settings=it'\\''s.json' auth login`);
    expect(harnessCommand('windows', h, 'auth login')).toBe(`claude '--settings=it''s.json' auth login`);
  });
});
