import { execFile } from 'node:child_process';
import type { Environment, Harness } from '../shared/types';
import type { DiscoveredModel } from '../shared/model-update';
import { DEFAULT_SHELL } from '../shared/environments';
import type { HostKind } from './host';

const PROBE_TIMEOUT_MS = 30_000;
/** The codex catalog dump runs to hundreds of KB. */
const PROBE_MAX_BUFFER = 16 * 1024 * 1024;

const posixQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Which side of the WSL boundary the environment's commands run on. */
function envSide(env: Environment, host: HostKind): 'posix' | 'windows' {
  if (env.kind === 'windows') return 'windows';
  if (env.kind === 'wsl') return 'posix';
  return host === 'windows' ? 'windows' : 'posix';
}

/**
 * The human line of a failed probe's stderr. Drops bash's no-tty job-control
 * warnings and PowerShell's position/category decoration; bash prints the real
 * error last, PowerShell first.
 */
function stderrSummary(stderr: string, side: 'posix' | 'windows'): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(\+ |At line:|~+$|bash: cannot set terminal|bash: no job control)/.test(l));
  const line = side === 'windows' ? lines[0] : lines[lines.length - 1];
  return line?.slice(0, 300);
}

/**
 * Run a short probe script inside the environment and return its stdout.
 * POSIX targets go through the environment's shell (so PATH matches real
 * runs — nvm/bun installs included), crossing into WSL via wsl.exe when
 * needed; Windows targets run through powershell.exe (interop from WSL).
 */
function runProbe(env: Environment, host: HostKind, script: string): Promise<string> {
  const side = envSide(env, host);
  let argv: string[];
  if (side === 'windows') {
    argv = ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  } else {
    const shellParts = (env.shell?.trim() || DEFAULT_SHELL).split(/\s+/);
    const prefix =
      env.kind === 'wsl' ? (env.distro ? ['wsl.exe', '-d', env.distro, '--'] : ['wsl.exe', '--']) : [];
    argv = [...prefix, ...shellParts, script];
  }
  return new Promise((resolve, reject) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ENOENT') reject(new Error(`${argv[0]} is not available on this machine`));
          else if (err.killed) reject(new Error(`no answer after ${PROBE_TIMEOUT_MS / 1000}s`));
          else reject(new Error(stderrSummary(String(stderr ?? ''), side) || `probe exited with code ${e.code ?? '?'}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** `export K=V; ...` / `$env:K = 'V'; ...` prefix carrying the harness's env vars. */
function envPrefix(side: 'posix' | 'windows', vars: Record<string, string>): string {
  const entries = Object.entries(vars);
  if (side === 'posix') return entries.map(([k, v]) => `export ${k}=${posixQuote(v)}; `).join('');
  return entries.map(([k, v]) => `$env:${k} = ${psQuote(v)}; `).join('');
}

interface CodexCatalogModel {
  slug: string;
  display_name?: string;
  visibility?: string;
  priority?: number;
  deprecated?: unknown;
}

/** `codex debug models` renders the raw model catalog as JSON on stdout. */
async function discoverCodexModels(env: Environment, harness: Harness, host: HostKind): Promise<DiscoveredModel[]> {
  const side = envSide(env, host);
  const script = envPrefix(side, harness.env) + `${harness.command} debug models`;
  const out = await runProbe(env, host, script);
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`${harness.command} debug models returned no JSON`);
  const catalog = JSON.parse(out.slice(start)) as { models?: CodexCatalogModel[] };
  if (!Array.isArray(catalog.models)) throw new Error(`${harness.command} debug models: no models array`);
  return catalog.models
    .filter((m) => m.slug && m.visibility === 'list' && !m.deprecated)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => ({ id: m.slug, name: m.display_name || m.slug, main: true }));
}

/** Read the Claude Code OAuth token from the environment's credentials file. */
async function claudeOauthToken(env: Environment, harness: Harness, host: HostKind): Promise<string> {
  const side = envSide(env, host);
  const script =
    envPrefix(side, harness.env) +
    (side === 'posix'
      ? 'cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"'
      : 'if ($env:CLAUDE_CONFIG_DIR) { Get-Content -Raw -LiteralPath ($env:CLAUDE_CONFIG_DIR + \'\\.credentials.json\') } ' +
        'else { Get-Content -Raw -LiteralPath ($env:USERPROFILE + \'\\.claude\\.credentials.json\') }');
  const advice = 'log in with the claude CLI or set ANTHROPIC_API_KEY on the harness';
  let raw: string;
  try {
    raw = await runProbe(env, host, script);
  } catch {
    throw new Error(`no Claude Code login found in this environment — ${advice}`);
  }
  let token: string | undefined;
  try {
    const creds = JSON.parse(raw.slice(raw.indexOf('{'))) as { claudeAiOauth?: { accessToken?: string } };
    token = creds.claudeAiOauth?.accessToken;
  } catch {
    /* unreadable credentials file: same advice as a missing token */
  }
  if (!token) throw new Error(`the Claude Code login has no usable token — ${advice}`);
  return token;
}

const CLAUDE_FAMILY = /^claude-([a-z]+)/;

/**
 * claude has no catalog-dump command; the models API lists what the account
 * can use. It accepts the CLI's own subscription OAuth token (via the oauth
 * beta header) or a plain API key from the harness's env. Newest models come
 * first, so the first id per family is that family's main model.
 */
async function discoverClaudeModels(env: Environment, harness: Harness, host: HostKind): Promise<DiscoveredModel[]> {
  const apiKey = harness.env.ANTHROPIC_API_KEY;
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  if (apiKey) headers['x-api-key'] = apiKey;
  else {
    headers.authorization = `Bearer ${await claudeOauthToken(env, harness, host)}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }
  const base = harness.env.ANTHROPIC_BASE_URL?.replace(/\/$/, '') || 'https://api.anthropic.com';
  let res: Response;
  try {
    res = await fetch(`${base}/v1/models?limit=100`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (e) {
    const timedOut = (e as Error).name === 'TimeoutError';
    throw new Error(timedOut ? `no answer from ${base} after ${PROBE_TIMEOUT_MS / 1000}s` : `cannot reach ${base}`);
  }
  if (res.status === 401) throw new Error(apiKey ? 'the API key was rejected' : 'the Claude Code login was rejected — log in again with the claude CLI');
  if (!res.ok) throw new Error(`the models API answered with status ${res.status}`);
  const body = (await res.json()) as { data?: { id: string; display_name?: string }[] };
  if (!Array.isArray(body.data)) throw new Error('the models API answered without a model list');
  const seen = new Set<string>();
  return body.data.map((m) => {
    const family = CLAUDE_FAMILY.exec(m.id)?.[1];
    const main = family !== undefined && !seen.has(family);
    if (family) seen.add(family);
    return { id: m.id, name: m.display_name || m.id, main };
  });
}

/** The harness's current model catalog. Throws with a short reason on failure. */
export function discoverHarnessModels(env: Environment, harness: Harness, host: HostKind): Promise<DiscoveredModel[]> {
  switch (harness.kind) {
    case 'codex':
      return discoverCodexModels(env, harness, host);
    case 'claude-code':
      return discoverClaudeModels(env, harness, host);
    case 'custom':
      return Promise.reject(new Error('custom harnesses have no model catalog'));
  }
}
