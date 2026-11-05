import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeEffective,
  claudeEntry,
  claudePermission,
  claudeServer,
  codexEffective,
  codexEntry,
  codexPermission,
  codexServer,
  parseJsonObject,
  parseTomlTable,
  putServer,
  putTomlServer,
  serverProblem,
  setClaudePermission,
  setCodexPermission,
  tomlHeaderPath,
  tomlServers,
} from '../src/shared/agent-config';
import { agentLocations, claudeProjectKey, readAgentSettings, writeAgentSettings, type AgentLocations } from '../src/engine/agent-files';
import { listMcpTools, stdioScript } from '../src/engine/mcp-tools';
import type { Environment, Harness } from '../src/shared/types';

describe('parsing', () => {
  it('names the line of a JSON error', () => {
    const r = parseJsonObject('{\n  "a": 1,\n  "b": \n}');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^Line 4: /);
    expect(parseJsonObject('[]').ok).toBe(false);
    expect(parseJsonObject('  ')).toEqual({ ok: true, value: {} });
  });
  it('names the line of a TOML error', () => {
    const r = parseTomlTable('a = 1\nb = [\n');
    expect(!r.ok && r.error).toMatch(/^Line 3: /);
  });
  it('reads table headers', () => {
    expect(tomlHeaderPath('[mcp_servers."my.srv".tools.open]  # x')).toEqual(['mcp_servers', 'my.srv', 'tools', 'open']);
    expect(tomlHeaderPath("[ mcp_servers . 'a b' ]")).toEqual(['mcp_servers', 'a b']);
    expect(tomlHeaderPath('a = [1]')).toBeNull();
  });
});

describe('servers', () => {
  it('round-trips a Claude Code entry and keeps the keys it does not show', () => {
    const s = claudeServer('user', 'gh', { command: 'npx', args: ['-y', 'x'], env: { A: '1' }, timeout: 5000 });
    expect(s.transport).toBe('stdio');
    expect(claudeEntry({ ...s, args: ['y'] })).toEqual({ type: 'stdio', command: 'npx', args: ['y'], env: { A: '1' }, timeout: 5000 });
    const h = claudeServer('project', 'web', { type: 'http', url: 'https://x/mcp', headers: { A: 'b' } });
    expect(claudeEntry({ ...h, transport: 'sse' })).toEqual({ type: 'sse', url: 'https://x/mcp', headers: { A: 'b' } });
  });
  it('turns a Codex server into the other transport without keys Codex would refuse', () => {
    const s = codexServer('user', 'c7', { command: 'npx', args: ['a'], env_vars: ['T'], startup_timeout_sec: 20 });
    expect(codexEntry({ ...s, transport: 'http', url: 'https://u' })).toEqual({ url: 'https://u', startup_timeout_sec: 20 });
  });
  it('puts a server in place, renames and removes it', () => {
    const map = { a: { command: 'x' }, b: { command: 'y' } };
    expect(Object.keys(putServer(map, 'a', 'z', { command: 'q' }))).toEqual(['z', 'b']);
    expect(Object.keys(putServer(map, null, 'c', { command: 'q' }))).toEqual(['a', 'b', 'c']);
    expect(Object.keys(putServer(map, 'b', 'b', null))).toEqual(['a']);
  });
  it('checks names, commands and URLs', () => {
    const s = claudeServer('user', 'a', { command: '' });
    expect(serverProblem('claude-code', s, [])).toMatch(/command/);
    expect(serverProblem('claude-code', { ...s, command: 'x' }, ['a'])).toMatch(/already/);
    expect(serverProblem('codex', { ...s, name: 'a.b', command: 'x' }, [])).toMatch(/letters/);
    expect(serverProblem('claude-code', { ...s, transport: 'http', url: 'ftp://x' }, [])).toMatch(/URL/);
  });
});

describe('config.toml, edited in place', () => {
  const text = [
    '# my settings',
    'model = "gpt-5"',
    '',
    '# the docs server',
    '[mcp_servers.docs]',
    'command = "npx"   # keep me? no: this table is rewritten',
    '',
    '[mcp_servers.docs.env]',
    'A = "1"',
    '',
    '# profiles',
    '[profiles.fast]',
    'model = "o4"',
    '',
  ].join('\n');

  it('replaces only the server tables and keeps comments around them', () => {
    const out = putTomlServer(text, 'docs', 'docs', { command: 'node', args: ['s.js'] });
    expect(out).toContain('# my settings');
    expect(out).toContain('# the docs server\n[mcp_servers.docs]\ncommand = "node"');
    expect(out).toContain('# profiles\n[profiles.fast]');
    expect(out).not.toContain('[mcp_servers.docs.env]');
    const doc = parseTomlTable(out);
    expect(doc.ok && tomlServers(doc.value)).toEqual({ docs: { command: 'node', args: ['s.js'] } });
  });
  it('adds a new server at the end and removes one', () => {
    const added = putTomlServer(text, null, 'gh', { url: 'https://gh' });
    expect(added.trimEnd().endsWith('[mcp_servers.gh]\nurl = "https://gh"')).toBe(true);
    const removed = putTomlServer(added, 'docs', 'docs', null);
    const doc = parseTomlTable(removed);
    expect(doc.ok && Object.keys(tomlServers(doc.value))).toEqual(['gh']);
    expect(removed).toContain('[profiles.fast]');
  });
  it('refuses a server written inline, which only the text can change', () => {
    expect(() => putTomlServer('mcp_servers = { a = { command = "x" } }\n', 'a', 'a', { command: 'y' })).toThrow(/Settings tab/);
  });
});

describe('Claude Code permissions', () => {
  it('reads and writes a server and a tool rule', () => {
    let s: Record<string, unknown> = { permissions: { allow: ['Bash(ls)'], deny: ['mcp__gh'] }, model: 'x' };
    expect(claudePermission(s, 'gh')).toBe('deny');
    s = setClaudePermission(s, 'gh', undefined, 'allow');
    expect(s.permissions).toEqual({ allow: ['Bash(ls)', 'mcp__gh__*'] });
    s = setClaudePermission(s, 'gh', 'create_issue', 'ask');
    expect(claudePermission(s, 'gh', 'create_issue')).toBe('ask');
    s = setClaudePermission(s, 'gh', undefined, 'default');
    s = setClaudePermission(s, 'gh', 'create_issue', 'default');
    expect(s).toEqual({ permissions: { allow: ['Bash(ls)'] }, model: 'x' });
    expect(setClaudePermission({ permissions: { allow: ['mcp__a__*'] } }, 'a', undefined, 'default')).toEqual({});
  });
  it('turns other characters of a name into "_"', () => {
    expect(setClaudePermission({}, 'my.server', 'get x', 'deny')).toEqual({ permissions: { deny: ['mcp__my_server__get_x'] } });
  });
  it('works out the result: deny, then ask, then allow, over every file', () => {
    const user = { permissions: { allow: ['mcp__gh__*'] } };
    const local = { permissions: { ask: ['mcp__gh__delete_repo'], deny: ['mcp__*__secret'] } };
    expect(claudeEffective([user, local], 'gh')).toBe('allow');
    expect(claudeEffective([user, local], 'gh', 'list')).toBe('allow');
    expect(claudeEffective([user, local], 'gh', 'delete_repo')).toBe('ask');
    expect(claudeEffective([user, local], 'gh', 'secret')).toBe('deny');
    // An allow glob counts only after a literal mcp__<server>__.
    expect(claudeEffective([{ permissions: { allow: ['mcp__*'] } }], 'gh', 'list')).toBe('default');
    expect(claudeEffective([{ permissions: { allow: ['mcp__gh__get_*'] } }], 'gh')).toBe('default');
  });
});

describe('Codex permissions', () => {
  it('maps the settings to enabled, approval modes and disabled_tools', () => {
    let e: Record<string, unknown> = { command: 'x' };
    e = setCodexPermission(e, undefined, 'ask');
    expect(e).toEqual({ command: 'x', default_tools_approval_mode: 'prompt' });
    e = setCodexPermission(e, 'open', 'allow');
    e = setCodexPermission(e, 'rm', 'deny');
    expect(codexPermission(e, 'open')).toBe('allow');
    expect(codexEffective(e, 'open')).toBe('allow');
    expect(codexEffective(e, 'other')).toBe('ask');
    expect(codexEffective(e, 'rm')).toBe('deny');
    e = setCodexPermission(e, undefined, 'deny');
    expect(e.enabled).toBe(false);
    expect(codexEffective(e, 'open')).toBe('deny');
    e = setCodexPermission(setCodexPermission(setCodexPermission(e, undefined, 'default'), 'open', 'default'), 'rm', 'default');
    expect(e).toEqual({ command: 'x' });
  });
});

// ---------- the files ----------

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-agent-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function locations(home: string, project?: string): Promise<AgentLocations> {
  return agentLocations('claude-code', { home, configDir: '', codexHome: '' }, project, async (p) => p);
}

describe('agent files', () => {
  it('finds the files under the home folder and the project', async () => {
    const loc = await locations('/h', '/p/x/');
    expect(loc.files['claude-user']?.host).toBe('/h/.claude/settings.json');
    expect(loc.claudeJson?.host).toBe('/h/.claude.json');
    expect(loc.files['mcp-json']?.host).toBe('/p/x/.mcp.json');
    expect(loc.projectKey).toBe('/p/x');
    const codex = await agentLocations('codex', { home: 'C:\\Users\\me', configDir: '', codexHome: '' }, 'C:\\repos\\a', async (p) => `/mnt/${p}`);
    expect(codex.files['codex-user']?.target).toBe('C:\\Users\\me\\.codex\\config.toml');
    expect(claudeProjectKey('c:\\repos\\a\\')).toBe('C:/repos/a');
  });

  it("reads and writes, changing only ~/.claude.json's server maps", async () => {
    const home = tmp();
    const project = path.join(home, 'proj');
    fs.mkdirSync(project);
    const claudeJson = { numStartups: 3, mcpServers: { a: { command: 'x' } }, projects: { [project]: { hasTrustDialogAccepted: true } } };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(claudeJson));
    const loc = await locations(home, project);
    const data = readAgentSettings(loc);
    expect(data.files.every((f) => f.text === null)).toBe(true);
    expect(data.claudeJson).toMatchObject({ user: { a: { command: 'x' } }, local: {} });

    const ok = await writeAgentSettings(
      loc,
      {
        files: [{ key: 'claude-local', base: null, text: '{\n  "permissions": { "allow": ["mcp__a__*"] }\n}\n' }],
        claudeJson: { user: { base: data.claudeJson!.user, servers: {} }, local: { base: {}, servers: { b: { type: 'http', url: 'https://b' } } } },
      },
      async () => false,
    );
    expect(ok).toBe(true);
    expect(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8')).toContain('mcp__a__*');
    const after = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(after).toEqual({ numStartups: 3, mcpServers: {}, projects: { [project]: { hasTrustDialogAccepted: true, mcpServers: { b: { type: 'http', url: 'https://b' } } } } });
  });

  it('asks before replacing a file that changed since it was read, and writes through a link', async () => {
    const home = tmp();
    const real = path.join(home, 'dotfiles-settings.json');
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(real, '{"a": 1}\n');
    fs.symlinkSync(real, path.join(home, '.claude', 'settings.json'));
    const loc = await locations(home);
    const asked: string[][] = [];
    const save = { files: [{ key: 'claude-user' as const, base: '{"a": 0}\n', text: '{"a": 2}\n' }] };
    expect(await writeAgentSettings(loc, save, async (p) => (asked.push(p), false))).toBe(false);
    expect(fs.readFileSync(real, 'utf8')).toBe('{"a": 1}\n');
    expect(await writeAgentSettings(loc, save, async () => true)).toBe(true);
    expect(asked[0][0]).toMatch(/settings\.json$/);
    expect(fs.lstatSync(path.join(home, '.claude', 'settings.json')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('{"a": 2}\n');
  });

  it('refuses text that does not parse', async () => {
    const loc = await locations(tmp());
    await expect(writeAgentSettings(loc, { files: [{ key: 'claude-user', base: null, text: '{,}' }] }, async () => true)).rejects.toThrow(/Line 1/);
  });
});

describe('MCP tools', () => {
  it('quotes the command and expands ${VAR} references for Claude Code', () => {
    const s = claudeServer('user', 'a', { command: 'npx', args: ["it's", '${TOKEN:-none}/x'], env: { K: '${HOME}' } });
    const script = stdioScript('posix', s, {}, '/w', true);
    expect(script).toContain(`__looper_a1='it'\\''s'`);
    expect(script).toContain(`__looper_a2=\${TOKEN:-'none'}'/x'`);
    expect(script).toContain('export K=${HOME}');
    expect(stdioScript('posix', s, {}, undefined, false)).toContain(`__looper_a2='\${TOKEN:-none}/x'`);
  });

  it.skipIf(process.platform === 'win32')('lists the tools of a stdio server', async () => {
    const dir = tmp();
    const server = path.join(dir, 'server.js');
    fs.writeFileSync(
      server,
      `const rl = require('readline').createInterface({ input: process.stdin });
       rl.on('line', (l) => {
         const m = JSON.parse(l);
         if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 't' } } }));
         if (m.method === 'tools/list' && !m.params.cursor) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'one', description: 'd' }], nextCursor: 'p2' } }));
         if (m.method === 'tools/list' && m.params.cursor) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: process.env.TOOL }] } }));
       });`,
    );
    const env: Environment = { id: 'e', name: 'Local', kind: 'local', shell: 'bash -c', harnesses: [] };
    const harness = { id: 'h', name: 'Claude Code', kind: 'claude-code', command: 'claude', args: [], env: {} } as Harness;
    const s = claudeServer('user', 't', { command: process.execPath, args: [server], env: { TOOL: '${NOPE:-two}' } });
    const tools = await listMcpTools(env, harness, 'linux', 'claude-code', s, dir, 15_000);
    expect(tools).toEqual([{ name: 'one', description: 'd' }, { name: 'two' }]);
    const bad = claudeServer('user', 'b', { command: 'looper-no-such-command-xyz' });
    await expect(listMcpTools(env, harness, 'linux', 'claude-code', bad, dir, 15_000)).rejects.toThrow(/stopped/);
  });
});
