import { describe, expect, it } from 'vitest';
import {
  CLAUDE_NETWORK_RE,
  CLAUDE_RETRY_RE,
  NETWORK_ERROR_RE,
  SLEEP_SLACK_MS,
  classifyFailure,
  looksLikeNetworkError,
  sleptThrough,
} from '../src/engine/network';

// The Claude Code banner as a live offline run printed it (claude 2.1.258).
const CLAUDE_BANNER = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";

describe('NETWORK_ERROR_RE', () => {
  const positives: [string, string][] = [
    ['node code', 'Error: getaddrinfo ENOTFOUND api.anthropic.com'],
    ['node retryable dns', 'getaddrinfo EAI_AGAIN registry.npmjs.org'],
    ['node refused', 'connect ECONNREFUSED 127.0.0.1:8080'],
    ['node reset', 'read ECONNRESET'],
    ['node timeout', 'connect ETIMEDOUT 10.0.0.5:443'],
    ['node net unreachable', 'connect ENETUNREACH 2606:4700::1111:443'],
    ['node host unreachable', 'connect EHOSTUNREACH 192.168.1.9:22'],
    ['undici', 'TypeError: fetch failed'],
    ['curl', 'curl: (6) Could not resolve host: example.com'],
    ['curl connect', 'curl: (7) Failed to connect to github.com port 443'],
    ['git', 'fatal: unable to access: Connection timed out after 30001 ms'],
    ['wget', 'wget: connect: Network is unreachable'],
    ['glibc resolver', 'Temporary failure in name resolution'],
    ['go http', 'dial tcp: lookup api.github.com: no such host'],
    ['python urllib3', "NewConnectionError('<urllib3.connection.HTTPSConnection>: Failed to establish a new connection')"],
    ['python requests', 'Max retries exceeded with url: /v1/messages'],
    ['python socket', 'socket.gaierror: [Errno -2] Name or service not known'],
    ['dotnet', 'The remote name could not be resolved: api.anthropic.com'],
    ['powershell', 'Invoke-WebRequest : Unable to connect to the remote server'],
    ['windows resolver', 'No such host is known.'],
    ['claude banner', CLAUDE_BANNER],
  ];
  it.each(positives)('matches %s', (_name, text) => {
    expect(looksLikeNetworkError(text)).toBe(true);
  });

  const negatives: [string, string][] = [
    ['404', 'HTTP 404 Not Found'],
    ['401', '401 Unauthorized'],
    ['403', '403 Forbidden'],
    ['bad key', 'Invalid API key · Please run /login'],
    ['api error type', '{"type":"error","error":{"type":"authentication_error"}}'],
    ['usage limit', "You've hit your session limit · resets 5:50am (America/Sao_Paulo)"],
    ['stack trace', '    at Object.<anonymous> (/app/src/index.ts:12:5)'],
    ['prose', 'Refactored the connection pool and reworked the timeout handling'],
    ['longer code', 'ENOTFOUNDX is not an error code'],
    ['undefined', ''],
  ];
  it.each(negatives)('does not match %s', (_name, text) => {
    expect(looksLikeNetworkError(text)).toBe(false);
  });

  it('is case-insensitive but keeps the code boundaries', () => {
    expect(NETWORK_ERROR_RE.test('could not resolve host')).toBe(true);
    expect(NETWORK_ERROR_RE.test('XECONNREFUSED')).toBe(false);
    expect(looksLikeNetworkError(undefined)).toBe(false);
  });
});

describe('CLAUDE_NETWORK_RE', () => {
  it('matches the banner and keeps the rest of the line for the headline', () => {
    const m = CLAUDE_NETWORK_RE.exec(`some screen text\n${CLAUDE_BANNER}\n> `);
    expect(m?.[0]).toBe(CLAUDE_BANNER);
  });
  it('ignores network errors printed by the agent\'s own tools', () => {
    expect(CLAUDE_NETWORK_RE.test('curl: (7) Failed to connect to localhost port 3000: Connection refused')).toBe(false);
    expect(CLAUDE_NETWORK_RE.test('Error: connect ECONNREFUSED 127.0.0.1:5432')).toBe(false);
  });
});

describe('CLAUDE_RETRY_RE', () => {
  it('matches the interactive retry banner', () => {
    expect(CLAUDE_RETRY_RE.test(' · Retrying in 1s · attempt 1/10')).toBe(true);
    expect(CLAUDE_RETRY_RE.test('· Retrying in 38s · attempt 8/10')).toBe(true);
    expect(CLAUDE_RETRY_RE.test('Retrying in 9s   attempt 3/10')).toBe(true);
  });
  it('does not match ordinary text about retries', () => {
    expect(CLAUDE_RETRY_RE.test('retrying the failed step')).toBe(false);
  });
});

describe('classifyFailure', () => {
  const offline = async (): Promise<boolean> => false;
  const online = async (): Promise<boolean> => true;

  it('trusts the text without probing', async () => {
    let probed = false;
    const probe = async (): Promise<boolean> => {
      probed = true;
      return true;
    };
    expect(await classifyFailure({ text: CLAUDE_BANNER, mayBeNetwork: false, probe })).toBe(true);
    expect(probed).toBe(false);
  });

  it('probes only when the failure could be the network', async () => {
    expect(await classifyFailure({ text: 'exit 1', mayBeNetwork: true, probe: offline })).toBe(true);
    expect(await classifyFailure({ text: 'exit 1', mayBeNetwork: true, probe: online })).toBe(false);
    expect(await classifyFailure({ text: 'exit 1', mayBeNetwork: false, probe: offline })).toBe(false);
  });

  it('a probe that throws never blames the network', async () => {
    const boom = async (): Promise<boolean> => {
      throw new Error('probe broke');
    };
    expect(await classifyFailure({ mayBeNetwork: true, probe: boom })).toBe(false);
  });
});

describe('sleptThrough', () => {
  it('flags a duration far past the timeout, and nothing near it', () => {
    expect(sleptThrough(60_000 + SLEEP_SLACK_MS + 1, 60_000)).toBe(true);
    expect(sleptThrough(51_577_000, 60_000)).toBe(true); // a 60 s check "ran" 14.3 h across a sleep
    expect(sleptThrough(60_000 + SLEEP_SLACK_MS, 60_000)).toBe(false);
    expect(sleptThrough(61_000, 60_000)).toBe(false); // ordinary kill/teardown lag
  });
});
