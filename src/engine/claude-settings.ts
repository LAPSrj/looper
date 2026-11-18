import fs from 'node:fs';
import { takeFlagValues } from '../shared/claude-args';
import type { Target } from './target';
import { joinTarget } from './target/paths';

type Settings = Record<string, unknown>;

const isObject = (v: unknown): v is Settings => !!v && typeof v === 'object' && !Array.isArray(v);

/** Lists both sides add to: the user's entries and Looper's (its helpers' permissions, the project's MCP servers). */
const COMBINED_LISTS = [
  'permissions.allow',
  'permissions.deny',
  'permissions.ask',
  'permissions.additionalDirectories',
  'sandbox.excludedCommands',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
];

/** `hooks`: each event's groups, the user's first, then Looper's. */
function mergeHooks(base: Settings, over: Settings): Settings {
  const out: Settings = { ...over };
  for (const [event, groups] of Object.entries(base)) {
    const theirs = out[event];
    out[event] = Array.isArray(theirs) && Array.isArray(groups) ? [...theirs, ...groups] : groups;
  }
  return out;
}

function mergeInto(base: Settings, over: Settings, at: string): Settings {
  const out: Settings = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const keyPath = at ? `${at}.${key}` : key;
    const mine = out[key];
    if (keyPath === 'hooks' && isObject(mine) && isObject(value)) out[key] = mergeHooks(mine, value);
    else if (COMBINED_LISTS.includes(keyPath) && Array.isArray(mine) && Array.isArray(value)) out[key] = [...new Set([...mine, ...value])];
    else if (isObject(mine) && isObject(value)) out[key] = mergeInto(mine, value, keyPath);
    else out[key] = value;
  }
  return out;
}

/**
 * Looper's settings for a Claude Code session with the user's (`--settings`
 * values, in order) merged in: the user's values win, the lists in
 * COMBINED_LISTS and each hook event get both sides' entries. Throws when the
 * user's settings turn every hook off, which Looper can't run without.
 */
export function mergeClaudeSettings(looper: Settings, users: readonly Settings[]): Settings {
  let out = looper;
  for (const user of users) {
    if (user.disableAllHooks === true) {
      throw new Error('--settings turns off every hook (disableAllHooks), and Looper needs its hooks to follow the session. Remove disableAllHooks.');
    }
    out = mergeInto(out, user, '');
  }
  return out;
}

/** Where a user's `--settings` value names a file: the host path of it, read relative to the task's folder. */
function settingsHostPath(value: string, target: Target, cwd: string): string {
  const absolute = target.kind === 'windows' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) : value.startsWith('/');
  return target.toHostPath(absolute ? value : joinTarget(target.kind, cwd, value));
}

function parseSettings(value: string, text: string): Settings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`--settings ${value}: not valid JSON (${(e as Error).message})`);
  }
  if (!isObject(parsed)) throw new Error(`--settings ${value}: the settings must be a JSON object`);
  return parsed;
}

/** Where a session reads the user's settings files from. */
export interface SettingsPlace {
  target: Target;
  /** The task's working directory as the target sees it: relative paths start there. */
  cwd: string;
}

const isJson = (value: string): boolean => value.trim().startsWith('{');

/**
 * The user's Claude Code arguments without their `--settings`, and those
 * settings read: inline JSON, or a file. Throws, naming the argument, when one
 * can't be read or isn't a JSON object.
 */
export async function readUserSettings(args: readonly string[], place: SettingsPlace): Promise<{ rest: string[]; settings: Settings[] }> {
  const { values, rest } = takeFlagValues(args);
  const settings: Settings[] = [];
  for (const value of values) {
    if (isJson(value)) {
      settings.push(parseSettings('<JSON>', value));
      continue;
    }
    let text: string;
    try {
      text = await fs.promises.readFile(settingsHostPath(value, place.target, place.cwd), 'utf8');
    } catch (e) {
      throw new Error(`--settings ${value}: ${(e as Error).message}`);
    }
    settings.push(parseSettings(value, text));
  }
  return { rest, settings };
}

/**
 * readUserSettings for a launcher written synchronously (a terminal session's):
 * only a settings file the user names is read, once per launch.
 */
export function readUserSettingsSync(args: readonly string[], place: SettingsPlace): { rest: string[]; settings: Settings[] } {
  const { values, rest } = takeFlagValues(args);
  const settings = values.map((value) => {
    if (isJson(value)) return parseSettings('<JSON>', value);
    let text: string;
    try {
      text = fs.readFileSync(settingsHostPath(value, place.target, place.cwd), 'utf8');
    } catch (e) {
      throw new Error(`--settings ${value}: ${(e as Error).message}`);
    }
    return parseSettings(value, text);
  });
  return { rest, settings };
}

/**
 * Looper's system prompt with the user's `--append-system-prompt` values
 * after it, and the arguments left without them: Claude Code keeps only the
 * last one given.
 */
export function mergeSystemPrompt(looper: string | undefined, args: readonly string[]): { text: string | undefined; rest: string[] } {
  const { values, rest } = takeFlagValues(args, '--append-system-prompt');
  const parts = [looper, ...values].filter((p): p is string => !!p && !!p.trim());
  return { text: parts.length ? parts.join('\n\n') : undefined, rest };
}
