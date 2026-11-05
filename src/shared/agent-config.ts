import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

/*
 * The agents' own settings files, as the Agent Settings window edits them:
 * Claude Code's settings.json files, its MCP servers (~/.claude.json and a
 * project's .mcp.json), and Codex's config.toml. Pure functions on the files'
 * text and parsed objects: main reads and writes the files, the window keeps
 * one draft per file and changes it through these.
 */

export type AgentKind = 'claude-code' | 'codex';

/** A file the window edits as text (its MCP servers and permission rules included). */
export type AgentFileKey =
  /** Claude Code's user settings: ~/.claude/settings.json (CLAUDE_CONFIG_DIR/settings.json). */
  | 'claude-user'
  /** A project's shared Claude Code settings: .claude/settings.json. */
  | 'claude-project'
  /** A project's personal Claude Code settings: .claude/settings.local.json. */
  | 'claude-local'
  /** A project's MCP servers: .mcp.json. */
  | 'mcp-json'
  /** Codex's user config: ~/.codex/config.toml (CODEX_HOME/config.toml). */
  | 'codex-user'
  /** A project's Codex config: .codex/config.toml. */
  | 'codex-project';

export interface AgentFile {
  key: AgentFileKey;
  /** The file's path in the environment's own form, for showing. */
  path: string;
  /** null: the file doesn't exist (yet). */
  text: string | null;
}

/** Which agent settings the window edits: an environment's harness, for the user or for one project. */
export interface AgentSettingsScope {
  envId: string;
  harnessId: string;
  projectId?: string;
}

/** What the Agent Settings window loads. */
export interface AgentSettingsData {
  kind: AgentKind;
  files: AgentFile[];
  /**
   * Claude Code: the MCP servers in ~/.claude.json (CLAUDE_CONFIG_DIR/.claude.json), the only part of
   * that file the window sees: `user` at its top level, `local` under the project's entry (null without a project).
   */
  claudeJson?: { path: string; user: McpServerMap; local: McpServerMap | null };
}

/** What Save writes: each changed file's new text (with the text it had when loaded), and ~/.claude.json's changed server maps. */
export interface AgentSettingsSave {
  files: { key: AgentFileKey; base: string | null; text: string }[];
  claudeJson?: { user?: { base: McpServerMap; servers: McpServerMap }; local?: { base: McpServerMap | null; servers: McpServerMap } };
}

export type McpServerMap = Record<string, Record<string, unknown>>;

/**
 * Where an MCP server is defined. Claude Code: `user` (~/.claude.json, every project), `local` (~/.claude.json,
 * this project, only you), `project` (.mcp.json, shared). Codex: `user` (~/.codex/config.toml), `project` (.codex/config.toml).
 */
export type McpScope = 'user' | 'local' | 'project';

export type McpTransport = 'stdio' | 'http' | 'sse';

/** An MCP server as the server window edits it. */
export interface McpServer {
  scope: McpScope;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  /** The entry as its file has it: the keys the window doesn't show are written back as they were. */
  raw: Record<string, unknown>;
}

export const MCP_SCOPE_LABELS: Record<AgentKind, Partial<Record<McpScope, string>>> = {
  'claude-code': { user: 'User', local: 'Local', project: 'Project' },
  codex: { user: 'User', project: 'Project' },
};

/** The file a scope's servers live in. Claude Code's user and local servers are in ~/.claude.json, which has no key. */
export function scopeFile(kind: AgentKind, scope: McpScope): AgentFileKey | null {
  if (kind === 'codex') return scope === 'project' ? 'codex-project' : 'codex-user';
  return scope === 'project' ? 'mcp-json' : null;
}

// ---------- parsing ----------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Line and column (1-based) of an offset in the text. */
function lineAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** Where JSON text stops being valid, and why (JSON.parse's message doesn't always say where). */
function jsonErrorAt(text: string): { offset: number; reason: string } {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i])) i++;
  };
  const fail = (reason: string): never => {
    throw { offset: i, reason };
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') return void i++;
      for (;;) {
        ws();
        if (text[i] !== '"') fail(text[i] === '}' ? 'a comma before "}"' : 'expected a property name in double quotes');
        string();
        ws();
        if (text[i] !== ':') fail('expected ":" after the property name');
        i++;
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') return void i++;
        else fail('expected "," or "}"');
      }
    } else if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return void i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') return void i++;
        else fail('expected "," or "]"');
      }
    } else if (c === '"') string();
    else {
      const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
      if (!m) fail(i >= text.length ? 'the text ends too early' : `unexpected "${c}"`);
      i += m![0].length;
    }
  };
  const string = () => {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\n') fail('a string runs past the end of its line');
      i += text[i] === '\\' ? 2 : 1;
    }
    if (i >= text.length) fail('a string has no closing quote');
    i++;
  };
  try {
    value();
    ws();
    if (i < text.length) fail('more text after the end of the JSON');
  } catch (e) {
    if (e && typeof e === 'object' && 'offset' in e) return e as { offset: number; reason: string };
    throw e;
  }
  return { offset: 0, reason: 'not valid JSON' };
}

/** A JSON file's text as an object, or why it isn't one ("Line 3: …"). Empty text is an empty object. */
export function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const at = jsonErrorAt(text);
    return { ok: false, error: `Line ${lineAt(text, at.offset).line}: ${at.reason}.` };
  }
  if (!isObject(value)) return { ok: false, error: 'Line 1: the file must hold one JSON object ({ … }).' };
  return { ok: true, value };
}

/** A TOML file's text as a table, or why it isn't one ("Line 3: …"). */
export function parseTomlTable(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseToml(text) as Record<string, unknown> };
  } catch (e) {
    const err = e as Error & { line?: number };
    const reason = err.message.replace(/^Invalid TOML document: /, '').split('\n')[0];
    return { ok: false, error: `Line ${err.line ?? 1}: ${reason}` };
  }
}

/** Whether a file is TOML (Codex) or JSON (Claude Code). */
export const isTomlFile = (key: AgentFileKey): boolean => key === 'codex-user' || key === 'codex-project';

/** Why the file's text can't be saved, or null. */
export function fileProblem(key: AgentFileKey, text: string): string | null {
  const parsed = isTomlFile(key) ? parseTomlTable(text) : parseJsonObject(text);
  return parsed.ok ? null : parsed.error;
}

/** JSON as the agents write it: two spaces, a final newline. */
export const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// ---------- MCP servers ----------

const stringMap = (v: unknown): Record<string, string> =>
  isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' || typeof x === 'number').map(([k, x]) => [k, String(x)])) : {};
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/** An entry of a Claude Code mcpServers map. */
export function claudeServer(scope: McpScope, name: string, raw: Record<string, unknown>): McpServer {
  const type = typeof raw.type === 'string' ? raw.type : '';
  const transport: McpTransport = type === 'sse' ? 'sse' : type === 'http' || type === 'streamable-http' || (!type && typeof raw.url === 'string' && !raw.command) ? 'http' : 'stdio';
  return {
    scope,
    name,
    transport,
    command: typeof raw.command === 'string' ? raw.command : '',
    args: stringList(raw.args),
    env: stringMap(raw.env),
    url: typeof raw.url === 'string' ? raw.url : '',
    headers: stringMap(raw.headers),
    raw,
  };
}

/** An entry of Codex's [mcp_servers] table. */
export function codexServer(scope: McpScope, name: string, raw: Record<string, unknown>): McpServer {
  const transport: McpTransport = typeof raw.url === 'string' && typeof raw.command !== 'string' ? 'http' : 'stdio';
  return {
    scope,
    name,
    transport,
    command: typeof raw.command === 'string' ? raw.command : '',
    args: stringList(raw.args),
    env: stringMap(raw.env),
    url: typeof raw.url === 'string' ? raw.url : '',
    headers: stringMap(raw.http_headers),
    raw,
  };
}

const withoutKeys = (raw: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(raw).filter(([k]) => !keys.includes(k)));

/** The server as Claude Code's mcpServers entry: the edited keys over the ones it had. */
export function claudeEntry(s: McpServer): Record<string, unknown> {
  if (s.transport === 'stdio') {
    const rest = withoutKeys(s.raw, ['type', 'command', 'args', 'env', 'url', 'headers', 'headersHelper', 'oauth']);
    return { type: 'stdio', command: s.command, args: s.args, ...(Object.keys(s.env).length ? { env: s.env } : {}), ...rest };
  }
  const rest = withoutKeys(s.raw, ['type', 'command', 'args', 'env', 'url', 'headers']);
  return { type: s.transport, url: s.url, ...(Object.keys(s.headers).length ? { headers: s.headers } : {}), ...rest };
}

/** Keys Codex accepts only for one transport (it refuses an entry that mixes them). */
const CODEX_STDIO_KEYS = ['command', 'args', 'env', 'env_vars', 'cwd'];
const CODEX_HTTP_KEYS = ['url', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'http_headers_helper', 'auth', 'oauth', 'oauth_resource', 'scopes'];

/** The server as Codex's [mcp_servers.<name>] table: the edited keys over the ones it had. */
export function codexEntry(s: McpServer): Record<string, unknown> {
  if (s.transport === 'stdio') {
    const rest = withoutKeys(s.raw, [...CODEX_STDIO_KEYS, ...CODEX_HTTP_KEYS]);
    const keep = Object.fromEntries(Object.entries(s.raw).filter(([k]) => k === 'env_vars' || k === 'cwd'));
    return { command: s.command, ...(s.args.length ? { args: s.args } : {}), ...(Object.keys(s.env).length ? { env: s.env } : {}), ...keep, ...rest };
  }
  const rest = withoutKeys(s.raw, [...CODEX_STDIO_KEYS, ...CODEX_HTTP_KEYS]);
  const keep = Object.fromEntries(Object.entries(s.raw).filter(([k]) => CODEX_HTTP_KEYS.includes(k) && k !== 'url' && k !== 'http_headers'));
  return { url: s.url, ...(Object.keys(s.headers).length ? { http_headers: s.headers } : {}), ...keep, ...rest };
}

/** Why a server can't be saved as it is, or null. `taken`: the names of the scope's other servers. */
export function serverProblem(kind: AgentKind, s: McpServer, taken: string[]): string | null {
  const name = s.name.trim();
  if (!name) return 'The server needs a name.';
  if (taken.includes(name)) return `There's already a server named "${name}" in this scope.`;
  if (kind === 'codex' && !/^[A-Za-z0-9_-]+$/.test(name)) return 'A Codex server name can have only letters, digits, "-" and "_".';
  if (s.transport === 'stdio' && !s.command.trim()) return 'The server needs a command.';
  if (s.transport !== 'stdio' && !/^https?:\/\/\S+$/i.test(s.url.trim())) return 'The server needs a URL that starts with http:// or https://.';
  return null;
}

/** The mcpServers map of a parsed JSON file (.mcp.json), or {}. */
export function jsonServers(obj: Record<string, unknown>): McpServerMap {
  return isObject(obj.mcpServers) ? (Object.fromEntries(Object.entries(obj.mcpServers).filter(([, v]) => isObject(v))) as McpServerMap) : {};
}

/** The map with server `oldName` removed and `entry` put as `name` at its place (at the end for a new one); a null entry removes it. */
export function putServer(map: McpServerMap, oldName: string | null, name: string, entry: Record<string, unknown> | null): McpServerMap {
  const out: McpServerMap = {};
  let placed = false;
  for (const [k, v] of Object.entries(map)) {
    if (k === oldName) {
      if (entry) out[name] = entry;
      placed = true;
    } else if (k !== name || !entry) out[k] = v;
  }
  if (!placed && entry) out[name] = entry;
  return out;
}

/** The [mcp_servers] table of a parsed config.toml, or {}. */
export function tomlServers(doc: Record<string, unknown>): McpServerMap {
  return isObject(doc.mcp_servers) ? (Object.fromEntries(Object.entries(doc.mcp_servers).filter(([, v]) => isObject(v))) as McpServerMap) : {};
}

// ---------- config.toml tables, edited in place ----------

/** A table header's key path: `[a."b.c".d]` → ['a', 'b.c', 'd']; null when it isn't a header. */
export function tomlHeaderPath(line: string): string[] | null {
  const m = /^\s*\[(\[?)(.*?)\]\1\s*(?:#.*)?$/.exec(line);
  if (!m) return null;
  const src = m[2];
  const parts: string[] = [];
  let i = 0;
  while (i < src.length) {
    while (src[i] === ' ' || src[i] === '\t') i++;
    let part = '';
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      try {
        part = JSON.parse(src.slice(i, j + 1)) as string;
      } catch {
        return null;
      }
      i = j + 1;
    } else if (src[i] === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return null;
      part = src.slice(i + 1, j);
      i = j + 1;
    } else {
      const m2 = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
      if (!m2) return null;
      part = m2[0];
      i += part.length;
    }
    parts.push(part);
    while (src[i] === ' ' || src[i] === '\t') i++;
    if (i < src.length) {
      if (src[i] !== '.') return null;
      i++;
    }
  }
  return parts.length ? parts : null;
}

/** Each table of the text: its key path and its lines [start, end) — the comments and blank lines right above the next header go with that one. */
function tomlTables(lines: string[]): { path: string[]; start: number; end: number }[] {
  const headers: { path: string[]; line: number }[] = [];
  let inString: '"""' | "'''" | null = null;
  lines.forEach((line, n) => {
    if (!inString) {
      const path = tomlHeaderPath(line);
      if (path) {
        headers.push({ path, line: n });
        return;
      }
    }
    for (const m of line.matchAll(/"""|'''/g)) {
      const q = m[0] as '"""' | "'''";
      if (!inString) inString = q;
      else if (inString === q) inString = null;
    }
  });
  return headers.map((h, i) => {
    let end = i + 1 < headers.length ? headers[i + 1].line : lines.length;
    while (end > h.line + 1 && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
    return { path: h.path, start: h.line, end };
  });
}

/**
 * config.toml with server `oldName` (null: none) replaced by `entry` named `name`, or removed (entry null).
 * Only that server's tables change: the rest of the file, comments included, stays as it was.
 * Throws when the server isn't in tables of its own (an inline table or dotted keys), which only the text editor can change.
 */
export function putTomlServer(text: string, oldName: string | null, name: string, entry: Record<string, unknown> | null): string {
  const parsed = parseTomlTable(text);
  if (!parsed.ok) throw new Error(`config.toml has an error. ${parsed.error}`);
  const existing = tomlServers(parsed.value);
  const lines = text.split('\n');
  const tables = tomlTables(lines);
  const owned = (n: string) => tables.filter((t) => t.path.length >= 2 && t.path[0] === 'mcp_servers' && t.path[1] === n);
  const replaced = oldName !== null ? owned(oldName) : [];
  // A server of another name being replaced (a rename onto a taken name) is the caller's to refuse.
  if (oldName !== null && existing[oldName] && replaced.length === 0) {
    throw new Error(`config.toml defines the server "${oldName}" in a way only the Settings tab can change (not in a [mcp_servers.${oldName}] table of its own).`);
  }
  if (entry && name !== oldName && existing[name]) throw new Error(`There's already a server named "${name}" in config.toml.`);
  const drop = new Set<number>();
  for (const t of replaced) for (let n = t.start; n < t.end; n++) drop.add(n);
  const at = replaced.length ? replaced[0].start : -1;
  const block = entry ? stringifyToml({ mcp_servers: { [name]: entry } }).replace(/\n+$/, '').split('\n') : [];
  const out: string[] = [];
  lines.forEach((line, n) => {
    if (n === at && block.length) out.push(...block);
    if (!drop.has(n)) out.push(line);
  });
  if (at < 0 && block.length) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    if (out.length) out.push('');
    out.push(...block, '');
  }
  const result = out.join('\n').replace(/\n{3,}/g, '\n\n');
  const check = parseTomlTable(result);
  if (!check.ok) throw new Error(`Looper couldn't change config.toml without breaking it (${check.error}); change it on the Settings tab.`);
  return result;
}

// ---------- permissions ----------

/** A server's or tool's permission setting: no rule of its own (`default`), allow without asking, always ask, or deny. Codex also has `writes`: ask before tools that change things. */
export type McpPermission = 'default' | 'allow' | 'ask' | 'deny' | 'writes';

/** Claude Code's permission rules turn a server's or tool's name's characters other than letters, digits, "_" and "-" into "_". */
export const ruleName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_');

const ruleLists = ['deny', 'ask', 'allow'] as const;
type RuleList = (typeof ruleLists)[number];

/** The rules of a settings file's permissions.allow, .ask and .deny. */
function rulesOf(settings: Record<string, unknown>, list: RuleList): string[] {
  const p = settings.permissions;
  if (!isObject(p) || !Array.isArray(p[list])) return [];
  return (p[list] as unknown[]).filter((r): r is string => typeof r === 'string').map((r) => r.trim());
}

/** The rules that are exactly this server's (every tool) or this tool's. */
function ownRules(server: string, tool?: string): string[] {
  const s = ruleName(server);
  return tool === undefined ? [`mcp__${s}`, `mcp__${s}__*`] : [`mcp__${s}__${ruleName(tool)}`];
}

/** The setting a settings file gives the server (tool unset) or the tool, by its own rules alone. */
export function claudePermission(settings: Record<string, unknown>, server: string, tool?: string): McpPermission {
  const own = ownRules(server, tool);
  for (const list of ruleLists) if (rulesOf(settings, list).some((r) => own.includes(r))) return list;
  return 'default';
}

/** The settings file with the server's (tool unset) or tool's own rules replaced by one for `perm` (none for `default`). */
export function setClaudePermission(settings: Record<string, unknown>, server: string, tool: string | undefined, perm: McpPermission): Record<string, unknown> {
  const own = ownRules(server, tool);
  const permissions: Record<string, unknown> = isObject(settings.permissions) ? { ...settings.permissions } : {};
  for (const list of ruleLists) {
    const had = Array.isArray(permissions[list]) ? (permissions[list] as unknown[]) : null;
    let next = (had ?? []).filter((r) => !(typeof r === 'string' && own.includes(r.trim())));
    if (perm === list) next = [...next, tool === undefined ? `mcp__${ruleName(server)}__*` : own[0]];
    if (next.length) permissions[list] = next;
    else if (had) delete permissions[list];
  }
  const out = { ...settings };
  if (Object.keys(permissions).length) out.permissions = permissions;
  else delete out.permissions;
  return out;
}

const globRe = (glob: string): RegExp => new RegExp(`^${glob.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** Whether a rule of `list` covers the tool (tool unset: every tool of the server). */
function ruleCovers(rule: string, list: RuleList, server: string, tool?: string): boolean {
  if (rule.includes('(')) return false; // Claude Code skips an mcp__ rule with parentheses
  const s = ruleName(server);
  if (rule === `mcp__${s}`) return true;
  // A tool name no glob of a narrower set matches stands for "every tool".
  const full = `mcp__${s}__${tool === undefined ? '\u0001' : ruleName(tool)}`;
  if (rule.includes('*')) {
    if (list === 'allow' && !rule.startsWith(`mcp__${s}__`)) return false;
    return globRe(rule).test(full);
  }
  return tool !== undefined && rule === full;
}

/**
 * What Claude Code does on the tool's calls (tool unset: on the server's tools) under all these settings files' rules:
 * deny, then ask, then allow, the first that has a matching rule; `default` when none has (it asks).
 */
export function claudeEffective(files: Record<string, unknown>[], server: string, tool?: string): McpPermission {
  for (const list of ruleLists) if (files.some((f) => rulesOf(f, list).some((r) => ruleCovers(r, list, server, tool)))) return list;
  return 'default';
}

const CODEX_MODES: Record<string, McpPermission> = { approve: 'allow', prompt: 'ask', writes: 'writes', auto: 'default' };
const CODEX_VALUES: Partial<Record<McpPermission, string>> = { allow: 'approve', ask: 'prompt', writes: 'writes' };

/** The setting a Codex server entry gives itself (tool unset) or one of its tools. */
export function codexPermission(entry: Record<string, unknown>, tool?: string): McpPermission {
  if (tool === undefined) {
    if (entry.enabled === false) return 'deny';
    return CODEX_MODES[String(entry.default_tools_approval_mode ?? 'auto')] ?? 'default';
  }
  if (stringList(entry.disabled_tools).includes(tool)) return 'deny';
  const tools = isObject(entry.tools) ? entry.tools : {};
  const own = isObject(tools[tool]) ? (tools[tool] as Record<string, unknown>).approval_mode : undefined;
  return CODEX_MODES[String(own ?? 'auto')] ?? 'default';
}

/** The Codex server entry with its own (tool unset) or a tool's setting changed. */
export function setCodexPermission(entry: Record<string, unknown>, tool: string | undefined, perm: McpPermission): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  if (tool === undefined) {
    if (perm === 'deny') out.enabled = false;
    else delete out.enabled;
    const value = CODEX_VALUES[perm];
    if (value) out.default_tools_approval_mode = value;
    else if (perm !== 'deny') delete out.default_tools_approval_mode;
    return out;
  }
  const disabled = stringList(out.disabled_tools).filter((t) => t !== tool);
  if (perm === 'deny') disabled.push(tool);
  if (disabled.length) out.disabled_tools = disabled;
  else delete out.disabled_tools;
  if (perm !== 'deny' && Array.isArray(out.enabled_tools) && !stringList(out.enabled_tools).includes(tool)) out.enabled_tools = [...stringList(out.enabled_tools), tool];
  const tools: Record<string, unknown> = isObject(out.tools) ? { ...out.tools } : {};
  const own: Record<string, unknown> = isObject(tools[tool]) ? { ...(tools[tool] as Record<string, unknown>) } : {};
  const value = CODEX_VALUES[perm];
  if (value) own.approval_mode = value;
  else delete own.approval_mode;
  if (Object.keys(own).length) tools[tool] = own;
  else delete tools[tool];
  if (Object.keys(tools).length) out.tools = tools;
  else delete out.tools;
  return out;
}

/** What Codex does on the tool's calls (tool unset: the server's default). An allow-list (enabled_tools) without the tool hides it. */
export function codexEffective(entry: Record<string, unknown>, tool?: string): McpPermission {
  const server = codexPermission(entry);
  if (server === 'deny' || tool === undefined) return server;
  if (Array.isArray(entry.enabled_tools) && !stringList(entry.enabled_tools).includes(tool)) return 'deny';
  const own = codexPermission(entry, tool);
  return own === 'default' ? server : own;
}

/** What the server window edits: a server of the Agent Settings window's draft (a new one has an empty name). */
export interface McpServerRequest {
  kind: AgentKind;
  server: McpServer;
  isNew: boolean;
  /** The scopes it can be in (Local and Project only with a project). */
  scopes: McpScope[];
  /** Each scope's other servers' names. */
  taken: Partial<Record<McpScope, string[]>>;
}

/** A tool an MCP server offers. */
export interface McpTool {
  name: string;
  description?: string;
}
