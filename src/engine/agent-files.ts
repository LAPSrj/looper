import fs from 'node:fs';
import path from 'node:path';
import type { Environment, Harness } from '../shared/types';
import {
  fileProblem,
  jsonServers,
  jsonText,
  parseJsonObject,
  type AgentFileKey,
  type AgentKind,
  type AgentSettingsData,
  type AgentSettingsSave,
  type McpServerMap,
} from '../shared/agent-config';
import { envPrefix, envSide, runProbe } from './discover-models';
import type { HostKind } from './host';
import { transcriptHostPath } from './messages';

/*
 * The agents' settings files in an environment (Claude Code's settings.json
 * files and ~/.claude.json, Codex's config.toml, a project's .mcp.json):
 * where they are, reading them, and writing what the Agent Settings window
 * changed. ~/.claude.json is Claude Code's own state, which it rewrites often:
 * only its MCP server maps are read and written, from a fresh read.
 */

/** A file's path in the environment's own form (shown) and as Looper's process opens it. */
export interface AgentPath {
  target: string;
  host: string;
}

export interface AgentLocations {
  kind: AgentKind;
  files: Partial<Record<AgentFileKey, AgentPath>>;
  claudeJson?: AgentPath;
  /** The project's folder as ~/.claude.json's `projects` keys it (a Windows path with "/"); unset without a project. */
  projectKey?: string;
}

/** Where the environment's harness keeps its files: the home folder, and CLAUDE_CONFIG_DIR and CODEX_HOME when set. */
export interface AgentHome {
  home: string;
  configDir: string;
  codexHome: string;
}

/**
 * Ask the environment (through its shell, as the harness's runs start, with the harness's
 * variables) for its home folder and Claude Code's and Codex's config folders.
 */
export async function probeAgentHome(env: Environment, harness: Harness, host: HostKind): Promise<AgentHome> {
  const side = envSide(env, host);
  const script =
    envPrefix(side, harness.env) +
    (side === 'posix'
      ? `printf 'H=%s\\nC=%s\\nX=%s\\n' "$HOME" "\${CLAUDE_CONFIG_DIR:-}" "\${CODEX_HOME:-}"`
      : "'H=' + $env:USERPROFILE; 'C=' + $env:CLAUDE_CONFIG_DIR; 'X=' + $env:CODEX_HOME");
  const out = await runProbe(env, host, script);
  const value = (key: string) => out.split(/\r?\n/).reverse().find((l) => l.startsWith(`${key}=`))?.slice(2).trim() ?? '';
  const home = value('H');
  if (!home) throw new Error(`Looper couldn't tell the home folder of the environment "${env.name}".`);
  return { home, configDir: value('C'), codexHome: value('X') };
}

const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

/** A path in the environment's own form, with more parts. */
function joinIn(windows: boolean, base: string, ...parts: string[]): string {
  return (windows ? path.win32 : path.posix).join(base, ...parts);
}

/** The project's folder as ~/.claude.json keys it: Windows paths with "/", no trailing separator. */
export function claudeProjectKey(cwd: string): string {
  const trimmed = cwd.length > 1 ? cwd.replace(/[\\/]+$/, '') : cwd;
  return isWindowsPath(trimmed) ? trimmed.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`) : trimmed;
}

/** The key ~/.claude.json's `projects` already has for the folder (Windows paths compared without case), or the folder's own. */
function projectEntryKey(projects: Record<string, unknown>, key: string): string {
  if (key in projects) return key;
  if (!/^[A-Za-z]:\//.test(key)) return key;
  return Object.keys(projects).find((k) => claudeProjectKey(k).toLowerCase() === key.toLowerCase()) ?? key;
}

/**
 * Where the files are, for the harness's kind: each folder in the environment's own form, made a host path
 * by `toHost` (which crosses the WSL boundary). `projectCwd`: the project's folder, when the window is a project's.
 */
export async function agentLocations(
  kind: AgentKind,
  home: AgentHome,
  projectCwd: string | undefined,
  toHost: (targetDir: string) => Promise<string | undefined>,
): Promise<AgentLocations> {
  const windows = isWindowsPath(home.home);
  const hostPath = async (dir: string, ...parts: string[]): Promise<AgentPath> => {
    const hostDir = await toHost(dir);
    if (!hostDir) throw new Error(`Looper can't reach ${dir} from this computer.`);
    return { target: joinIn(windows, dir, ...parts), host: path.join(hostDir, ...parts) };
  };
  const files: Partial<Record<AgentFileKey, AgentPath>> = {};
  const loc: AgentLocations = { kind, files };
  if (kind === 'claude-code') {
    const configDir = home.configDir || joinIn(windows, home.home, '.claude');
    files['claude-user'] = await hostPath(configDir, 'settings.json');
    loc.claudeJson = home.configDir ? await hostPath(home.configDir, '.claude.json') : await hostPath(home.home, '.claude.json');
    if (projectCwd) {
      files['claude-project'] = await hostPath(projectCwd, '.claude', 'settings.json');
      files['claude-local'] = await hostPath(projectCwd, '.claude', 'settings.local.json');
      files['mcp-json'] = await hostPath(projectCwd, '.mcp.json');
      loc.projectKey = claudeProjectKey(projectCwd);
    }
  } else {
    files['codex-user'] = await hostPath(home.codexHome || joinIn(windows, home.home, '.codex'), 'config.toml');
    if (projectCwd) files['codex-project'] = await hostPath(projectCwd, '.codex', 'config.toml');
  }
  return loc;
}

/** A host path as Looper's process opens it (the probe's output is in the environment's own form). */
export function hostPathOf(host: HostKind, env: Environment): (p: string) => Promise<string | undefined> {
  return (p) => transcriptHostPath(p, host, env.kind === 'wsl' ? env.distro : undefined);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** ~/.claude.json as an object ({} when it doesn't exist); throws when it can't be read as one. */
function readClaudeJson(file: string): Record<string, unknown> {
  const text = readText(file);
  if (text === null) return {};
  const parsed = parseJsonObject(text);
  if (!parsed.ok) throw new Error(`${file} has an error. ${parsed.error}`);
  return parsed.value;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The project's MCP servers in ~/.claude.json (local scope). */
function localServers(obj: Record<string, unknown>, projectKey: string): McpServerMap {
  const projects = isObject(obj.projects) ? obj.projects : {};
  const entry = projects[projectEntryKey(projects, projectKey)];
  return isObject(entry) ? jsonServers(entry) : {};
}

/** The files' text, and ~/.claude.json's server maps. */
export function readAgentSettings(loc: AgentLocations): AgentSettingsData {
  const files = (Object.entries(loc.files) as [AgentFileKey, AgentPath][]).map(([key, p]) => ({ key, path: p.target, text: readText(p.host) }));
  const data: AgentSettingsData = { kind: loc.kind, files };
  if (loc.claudeJson) {
    const obj = readClaudeJson(loc.claudeJson.host);
    data.claudeJson = { path: loc.claudeJson.target, user: jsonServers(obj), local: loc.projectKey ? localServers(obj, loc.projectKey) : null };
  }
  return data;
}

/**
 * Write a file without ever leaving it torn: a temporary file next to it, renamed over it. A symbolic link
 * (a dotfiles setup) keeps pointing at its file, which is the one written, and the file keeps its permissions.
 */
export function writeFileAtomic(file: string, text: string): void {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    /* not there yet */
  }
  fs.mkdirSync(path.dirname(real), { recursive: true });
  let mode: number | undefined;
  try {
    mode = fs.statSync(real).mode & 0o777;
  } catch {
    /* a new file */
  }
  const tmp = `${real}.looper-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, real);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const sameServers = (a: McpServerMap | null, b: McpServerMap | null): boolean => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/**
 * Write what the window changed. A file that changed on disk since the window read it (Claude Code
 * adds a permission rule, the user edits it elsewhere) is overwritten only once `confirmOverwrite`
 * agrees, asked once for all of them. Resolves false when it didn't.
 */
export async function writeAgentSettings(
  loc: AgentLocations,
  save: AgentSettingsSave,
  confirmOverwrite: (paths: string[]) => Promise<boolean>,
): Promise<boolean> {
  const writes: { file: AgentPath; text: string }[] = [];
  const changed: string[] = [];
  for (const f of save.files ?? []) {
    const file = loc.files[f.key];
    if (!file) throw new Error(`This window doesn't edit ${f.key}.`);
    const text = String(f.text);
    const problem = fileProblem(f.key, text);
    if (problem) throw new Error(`${file.target}: ${problem}`);
    if (readText(file.host) !== f.base) changed.push(file.target);
    writes.push({ file, text });
  }
  const cj = save.claudeJson;
  if (cj && (cj.user || cj.local)) {
    if (!loc.claudeJson) throw new Error("This window doesn't edit ~/.claude.json.");
    if (cj.local && !loc.projectKey) throw new Error('Local MCP servers need a project.');
    const obj = readClaudeJson(loc.claudeJson.host);
    if ((cj.user && !sameServers(jsonServers(obj), cj.user.base)) || (cj.local && loc.projectKey && !sameServers(localServers(obj, loc.projectKey), cj.local.base))) {
      changed.push(loc.claudeJson.target);
    }
  }
  if (changed.length && !(await confirmOverwrite(changed))) return false;
  for (const w of writes) writeFileAtomic(w.file.host, w.text);
  if (cj && loc.claudeJson && (cj.user || cj.local)) {
    // Read again right before writing: Claude Code may have written it while the question was up.
    const obj = readClaudeJson(loc.claudeJson.host);
    if (cj.user) {
      if (Object.keys(cj.user.servers).length || 'mcpServers' in obj) obj.mcpServers = cj.user.servers;
    }
    if (cj.local && loc.projectKey) {
      const projects = isObject(obj.projects) ? obj.projects : {};
      const key = projectEntryKey(projects, loc.projectKey);
      const entry = isObject(projects[key]) ? (projects[key] as Record<string, unknown>) : null;
      if (entry || Object.keys(cj.local.servers).length) {
        projects[key] = { ...(entry ?? {}), mcpServers: cj.local.servers };
        obj.projects = projects;
      }
    }
    writeFileAtomic(loc.claudeJson.host, jsonText(obj));
  }
  return true;
}
