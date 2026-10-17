import type { Settings, Task } from '../shared/types';
import { tokenize } from '../shared/cmdline';
import { resolveEnvironment } from '../shared/environments';
import { convertWslPath, type HostKind } from './host';
import { createTarget } from './target';
import { joinTarget } from './target/paths';

/** Tokens that look like a path to one of the task's own files (scripts it runs). */
const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|py|js|mjs|cjs|ts|rb|pl|php|cmd|bat|jq|json|md|txt)$/i;

function looksLikePath(token: string): boolean {
  if (!token || token.startsWith('-') || token.includes('://') || token.includes('$')) return false;
  return token.includes('/') || token.includes('\\') || SCRIPT_EXT.test(token);
}

/**
 * Absolute, target-native paths a task refers to: path-like words in its
 * check, watcher and agent commands, and its prompts' {{file:}} tags. Some
 * may not exist (or be folders); readers skip those.
 */
export function referencedPaths(task: Task, kind: 'wsl' | 'windows'): string[] {
  const words: string[] = [];
  for (const command of [task.check?.command, task.trigger.watcher?.command, task.agent.command]) {
    if (!command) continue;
    const parsed = tokenize(command);
    if (parsed.ok) words.push(...parsed.tokens.filter(looksLikePath));
  }
  for (const prompt of [task.agent.prompt, task.classifier?.prompt]) {
    for (const m of (prompt ?? '').matchAll(/\{\{\s*file:([^}]*?)\s*\}\}/g)) words.push(m[1].trim());
  }
  const out = new Set<string>();
  for (const w of words) {
    if (w.startsWith('~')) continue; // the home dir is the target's to expand
    const absolute = kind === 'windows' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(w) : w.startsWith('/');
    out.add(absolute ? w : joinTarget(kind, task.cwd, w.replace(/^\.[\\/]/, '')));
  }
  return [...out];
}

/**
 * The host path of a target-native path, or undefined when Looper can't
 * reach it. The target translates directly where it can; a WSL environment
 * on the default distro needs wslpath, which the target can't call.
 */
export async function taskHostPath(task: Task, p: string, host: HostKind, settings: Settings): Promise<string | undefined> {
  try {
    return createTarget(task, { host, settings }).toHostPath(p);
  } catch {
    /* fall through to wslpath */
  }
  try {
    const env = resolveEnvironment(task, settings);
    if (host === 'windows' && env.kind === 'wsl') return await convertWslPath(p, 'windows', env.distro || undefined);
    if (host === 'wsl' && env.kind === 'windows') return await convertWslPath(p, 'posix');
  } catch {
    /* unreachable */
  }
  return undefined;
}
