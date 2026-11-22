import fs from 'node:fs';
import path from 'node:path';
import { findCodexRollout } from './messages';

/*
 * A conversation that goes on with another harness of the same kind, which
 * keeps its conversations in another folder (another CLAUDE_CONFIG_DIR or
 * CODEX_HOME): the harness resumes only a conversation in its own folder
 * ("No conversation found with session ID", checked with Claude Code 2.1.330
 * and Codex 0.163), so its transcript is copied there first.
 */

export type ConversationKind = 'claude-code' | 'codex';

/** The folder a transcript sits under, inside its harness's folder: Claude Code's projects/<folder>/, Codex's sessions/YYYY/MM/DD/. */
const ROOT: Record<ConversationKind, string> = { 'claude-code': 'projects', codex: 'sessions' };

const realDir = (dir: string): Promise<string> => fs.promises.realpath(dir).catch(() => path.resolve(dir));

/**
 * The newest transcript of conversation `id` in a harness's folder (`home`):
 * Claude Code's projects/<the project's folder>/<id>.jsonl, Codex's rollout;
 * null when it has none.
 */
export async function findConversation(kind: ConversationKind, home: string, id: string): Promise<string | null> {
  if (kind === 'codex') return findCodexRollout(path.join(home, 'sessions'), id);
  const projects = path.join(home, 'projects');
  const dirs = await fs.promises.readdir(projects).catch(() => [] as string[]);
  const found = await Promise.all(
    dirs.map(async (d) => {
      const file = path.join(projects, d, `${id}.jsonl`);
      const st = await fs.promises.stat(file).catch(() => null);
      return st?.isFile() ? { file, mtimeMs: st.mtimeMs } : null;
    }),
  );
  const newest = found.filter((f) => f !== null).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return newest?.file ?? null;
}

/** Copy a file unless the copy there is as new already (a harness only appends to a transcript). */
async function copyIfNewer(from: string, to: string): Promise<void> {
  const [src, dest] = await Promise.all([fs.promises.stat(from), fs.promises.stat(to).catch(() => null)]);
  if (dest && dest.mtimeMs >= src.mtimeMs && dest.size >= src.size) return;
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.cp(from, to, { force: true, preserveTimestamps: true });
}

/**
 * Copy a transcript (a host path) into another harness's folder (`toHome`),
 * at the same place under it, with Claude Code's folder of the session's
 * subagents and tool results beside it. Returns the copy's path; nothing is
 * copied when it's the same folder, or the copy there is as new.
 */
export async function copyTranscript(kind: ConversationKind, file: string, toHome: string): Promise<string> {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf(ROOT[kind]);
  if (at === -1) throw new Error(`${file} isn't in a ${ROOT[kind]} folder.`);
  const dest = path.join(toHome, ...parts.slice(at));
  if ((await realDir(path.dirname(file))) === (await realDir(path.dirname(dest)))) return dest;
  await copyIfNewer(file, dest);
  if (kind === 'claude-code') {
    const dir = file.slice(0, -'.jsonl'.length);
    const files = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile()) continue;
      const from = path.join(f.parentPath, f.name);
      await copyIfNewer(from, path.join(dest.slice(0, -'.jsonl'.length), path.relative(dir, from)));
    }
  }
  return dest;
}

/**
 * Conversation `id` moves from one harness's folder to another's: its
 * transcript is copied there when they're different folders. Nothing to copy
 * (the harness hasn't written it yet) leaves it to the harness to say.
 */
export async function copyConversation(kind: ConversationKind, id: string, fromHome: string, toHome: string): Promise<void> {
  if ((await realDir(fromHome)) === (await realDir(toHome))) return;
  const file = await findConversation(kind, fromHome, id);
  if (file) await copyTranscript(kind, file, toHome);
}
