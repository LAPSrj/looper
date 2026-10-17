import type { Attachment } from '../../shared/chat';
import type { MessageRow } from '../../shared/messages';
import { TranscriptAccumulator } from '../messages';

type Rec = Record<string, unknown>;

function parse(line: string): Rec | null {
  try {
    const v: unknown = JSON.parse(line);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
  } catch {
    return null;
  }
}

/**
 * Claude's stream-json lines are transcript records under other names: a tool
 * result's details ride `tool_use_result` instead of `toolUseResult`. Renaming
 * it lets the transcript accumulator attach edit diffs as it does for runs.
 */
export class ClaudeStreamAccumulator extends TranscriptAccumulator {
  addLine(line: string): void {
    const rec = parse(line);
    if (rec && rec.tool_use_result !== undefined && rec.toolUseResult === undefined) {
      super.addLine(JSON.stringify({ ...rec, toolUseResult: rec.tool_use_result }));
      return;
    }
    super.addLine(line);
  }

  /** The user's message as a prompt row: stream-json never echoes what was sent on stdin. */
  addPrompt(text: string, attachments?: Attachment[]): void {
    const row = this.push({ kind: 'prompt', ts: new Date().toISOString(), text });
    if (attachments?.length) row.attachments = attachments;
  }

  /** Looper's own line in the conversation (why a turn failed). */
  addNote(text: string): void {
    this.push({ kind: 'agent', ts: new Date().toISOString(), text });
  }
}

/** `/bin/bash -lc 'cmd'` -> `cmd`: codex reports the spawned argv joined, wrapper included. */
export function unwrapShell(command: string): string {
  const m = /^(?:\S*[\\/])?(?:ba|z)?sh(?:\.exe)? -l?c (['"])([\s\S]*)\1$/.exec(command.trim());
  if (!m) return command;
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2].replace(/\\(["\\$`])/g, '$1');
}

/**
 * Folds `codex exec --json` events into display rows. The events name items
 * by id and report each one when it starts and when it completes, so a
 * command or file change shows while it runs and gets its result in place.
 * Shapes captured live from codex-cli (item types agent_message, reasoning,
 * command_execution, file_change, mcp_tool_call, web_search).
 */
export class CodexExecAccumulator extends TranscriptAccumulator {
  private byItem = new Map<string, MessageRow[]>();

  reset(): void {
    super.reset();
    this.byItem.clear();
  }

  addPrompt(text: string, attachments?: Attachment[]): void {
    const row = this.push({ kind: 'prompt', ts: new Date().toISOString(), text });
    if (attachments?.length) row.attachments = attachments;
  }

  /** Looper's own line in the conversation (why a turn failed). */
  addNote(text: string): void {
    this.push({ kind: 'agent', ts: new Date().toISOString(), text });
  }

  addLine(line: string): void {
    const rec = parse(line);
    if (!rec) return;
    const ts = new Date().toISOString();
    if (rec.type === 'item.started' || rec.type === 'item.updated' || rec.type === 'item.completed') {
      const item = rec.item as Rec | undefined;
      if (item) this.addItem(item, rec.type === 'item.completed', ts);
    } else if (rec.type === 'error' || rec.type === 'turn.failed') {
      const msg = rec.type === 'error' ? rec.message : (rec.error as Rec | undefined)?.message;
      if (typeof msg === 'string' && msg.trim()) this.push({ kind: 'agent', ts, text: `Error: ${msg}` });
    }
  }

  private addItem(item: Rec, done: boolean, ts: string): void {
    const id = typeof item.id === 'string' ? item.id : '';
    const known = id ? this.byItem.get(id) : undefined;
    switch (item.type) {
      case 'agent_message':
        if (done && typeof item.text === 'string' && item.text.trim()) this.push({ kind: 'agent', ts, text: item.text });
        return;
      case 'reasoning':
        if (done && typeof item.text === 'string' && item.text.trim()) this.push({ kind: 'thinking', ts, text: item.text });
        return;
      case 'command_execution': {
        const command = unwrapShell(typeof item.command === 'string' ? item.command : '');
        const row = known?.[0] ?? this.remember(id, [this.push({ kind: 'tool', ts, tool: 'Bash', text: command })]);
        row.input = { command };
        if (typeof item.aggregated_output === 'string' && (done || item.aggregated_output)) row.result = item.aggregated_output;
        if (done && ((typeof item.exit_code === 'number' && item.exit_code !== 0) || item.status === 'failed')) {
          row.resultError = true;
        }
        return;
      }
      case 'file_change': {
        if (known) {
          if (done && item.status === 'failed') for (const r of known) r.resultError = true;
          return;
        }
        const changes = Array.isArray(item.changes) ? (item.changes as Rec[]) : [];
        const rows = changes
          .filter((c) => typeof c?.path === 'string')
          .map((c) => {
            const tool = c.kind === 'add' ? 'Write' : c.kind === 'delete' ? 'Delete' : 'Edit';
            const row = this.push({ kind: 'tool', ts, tool, text: c.path as string, preview: c.path as string });
            row.file = c.path as string;
            row.input = { kind: c.kind };
            return row;
          });
        this.remember(id, rows);
        return;
      }
      case 'mcp_tool_call': {
        const name = [item.server, item.tool].filter((x) => typeof x === 'string').join('.');
        const args = item.arguments === undefined ? '' : JSON.stringify(item.arguments, null, 2);
        const row = known?.[0] ?? this.remember(id, [this.push({ kind: 'tool', ts, tool: name || 'mcp', text: args })]);
        if (done) {
          const result = item.result ?? item.error;
          if (result !== undefined) row.result = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          if (item.error || item.status === 'failed') row.resultError = true;
        }
        return;
      }
      case 'web_search': {
        if (known) return;
        const query = typeof item.query === 'string' ? item.query : '';
        this.remember(id, [this.push({ kind: 'tool', ts, tool: 'WebSearch', text: query })]);
        return;
      }
    }
  }

  private remember(id: string, rows: MessageRow[]): MessageRow {
    if (id) this.byItem.set(id, rows);
    return rows[0];
  }
}
