/**
 * Undo a unified diff: given a file's content after the diff was applied,
 * return its content before. Null when the content doesn't match what the
 * diff produced (something else changed the file since).
 */
export function unapplyUnifiedDiff(after: string, diff: string): string | null {
  const hunks: { newStart: number; oldLines: string[]; newLines: string[] }[] = [];
  let current: (typeof hunks)[number] | null = null;
  for (const line of diff.split('\n')) {
    const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (head) {
      current = { newStart: Number(head[1]), oldLines: [], newLines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith(' ')) {
      current.oldLines.push(line.slice(1));
      current.newLines.push(line.slice(1));
    } else if (line.startsWith('-')) current.oldLines.push(line.slice(1));
    else if (line.startsWith('+')) current.newLines.push(line.slice(1));
  }
  if (hunks.length === 0) return null;
  const lines = after.split('\n');
  // Last hunk first, so the earlier hunks' line numbers stay valid.
  for (const h of [...hunks].reverse()) {
    // A hunk adding to an empty file starts at line 0.
    const at = Math.max(0, h.newStart - 1);
    for (let i = 0; i < h.newLines.length; i++) {
      if (lines[at + i] !== h.newLines[i]) return null;
    }
    lines.splice(at, h.newLines.length, ...h.oldLines);
  }
  return lines.join('\n');
}

/** One file change codex recorded in its session file. */
export interface CodexFileChange {
  type: string;
  unified_diff?: string;
}

/**
 * A file's content before a run of codex edits, from its content now and the
 * edits codex recorded for it, oldest first. undefined = the edits don't lead
 * to the content now (a shell command changed the file too), so the history
 * can't say; null = codex created the file.
 */
export function contentBeforeCodexEdits(now: string | null, changes: CodexFileChange[]): string | null | undefined {
  if (changes.length === 0) return undefined;
  if (changes[0].type === 'add') return null;
  if (now === null) return undefined;
  let content = now;
  for (const c of [...changes].reverse()) {
    if (c.type !== 'update' || c.unified_diff === undefined) return undefined;
    const before = unapplyUnifiedDiff(content, c.unified_diff);
    if (before === null) return undefined;
    content = before;
  }
  return content;
}

/**
 * The file changes in a codex session file (rollout JSONL), per path in the
 * order they happened. Only completed changes count.
 */
export function codexFileChanges(rollout: string): Map<string, CodexFileChange[]> {
  const out = new Map<string, CodexFileChange[]>();
  for (const line of rollout.split('\n')) {
    if (!line.includes('"FileChange"')) continue;
    let rec: { type?: string; payload?: { type?: string; item?: { type?: string; status?: string; changes?: Record<string, CodexFileChange> } } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const item = rec.payload?.item;
    if (rec.type !== 'event_msg' || rec.payload?.type !== 'item_completed' || item?.type !== 'FileChange') continue;
    if (item.status !== 'completed' || !item.changes) continue;
    for (const [p, change] of Object.entries(item.changes)) {
      const list = out.get(p) ?? [];
      list.push(change);
      out.set(p, list);
    }
  }
  return out;
}
