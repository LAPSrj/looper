import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/engine/log';
import { MessagesService, TranscriptAccumulator, type SubagentMeta } from '../src/engine/messages';
import { subagentsOf } from '../src/engine/sessions';
import { runningText } from '../src/renderer/src/components/subagents';
import type { MessageRow } from '../src/shared/messages';
import { SettingsSchema } from '../src/shared/types';

const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
const service = () =>
  new MessagesService({ getTask: () => undefined, runDir: () => '', attachment: () => null, host: 'linux', settings: SettingsSchema.parse({}), log: new Logger() });

/** A session's subagents folder with each agent's meta file, as Claude Code writes them (2.1.33x). */
function session(metas: Record<string, Record<string, unknown>>): { transcript: string; write: (id: string, meta: Record<string, unknown>) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'looper-subagents-'));
  const transcript = join(dir, 'session.jsonl');
  mkdirSync(join(dir, 'session', 'subagents'), { recursive: true });
  const write = (id: string, meta: Record<string, unknown>) => writeFileSync(join(dir, 'session', 'subagents', `agent-${id}.meta.json`), JSON.stringify(meta));
  for (const [id, meta] of Object.entries(metas)) write(id, meta);
  return { transcript, write };
}

// A foreground web-fetch agent another subagent started: its meta as Claude Code leaves it once the agent ended.
const nested = { agentType: 'web-fetch', description: 'Fetch docs', toolUseId: 'repl_f1', parentAgentId: 'p1', requestShape: 'foreground', finished: true };

describe("a subagent's finished mark in Claude Code's meta file", () => {
  it('is read with the meta, and a meta read before the mark is read again until it has it', async () => {
    const s = session({ f1: nested, r1: { agentType: 'general-purpose', description: 'Build', toolUseId: 'repl_r1', requestShape: 'background' } });
    const messages = service();
    const first = await messages.subagentsAt(s.transcript);
    expect(Object.fromEntries(first.map((m) => [m.agentId, m.finished ?? false]))).toEqual({ f1: true, r1: false });
    s.write('r1', { agentType: 'general-purpose', description: 'Build', toolUseId: 'repl_r1', requestShape: 'background', finished: true });
    expect((await messages.subagentsAt(s.transcript)).find((m) => m.agentId === 'r1')?.finished).toBe(true);
  });

  it('makes a subagent with no call among the rows and no notification done, so the bar no longer counts it as running', () => {
    const metas: SubagentMeta[] = [
      { agentId: 'f1', toolUseId: 'repl_f1', type: 'web-fetch', description: 'Fetch docs', finished: true },
      { agentId: 'f2', toolUseId: 'repl_f2', type: 'web-fetch', description: 'Fetch more docs', finished: true },
      { agentId: 'r1', toolUseId: 'repl_r1', type: 'general-purpose', description: 'Build' },
    ];
    const subagents = subagentsOf(metas, [], undefined, undefined, { r1: 'running' });
    expect(subagents.map((a) => a.status)).toEqual(['done', 'done', 'running']);
    expect(runningText(subagents.map((a) => a.status), [])?.[0]).toBe('1 subagent running');
  });

  it("doesn't end one a notification says still runs (waiting on its own work, or woken by SendMessage)", () => {
    const meta: SubagentMeta = { agentId: 'w1', toolUseId: 'repl_w1', type: 'general-purpose', description: 'Wait', finished: true };
    expect(subagentsOf([meta], [], undefined, undefined, { w1: 'running' })[0].status).toBe('running');
  });
});

describe('a subagent a Code Mode script started', () => {
  const repl = (started: MessageRow[]): MessageRow => ({ id: 'repl1', kind: 'tool', tool: 'REPL', text: '', preview: 'REPL', toolUseId: 'toolu_repl', ts: '2026-11-23T00:48:30.654Z', started });
  const call = (r: Partial<MessageRow>): MessageRow => ({ id: 'c', kind: 'tool', tool: 'Agent', text: '', preview: 'Agent', ...r });

  it("takes its start from the script's call, so the list orders it by when it started", () => {
    const rows = [repl([call({ toolUseId: 'repl_a1', agentId: 'a1', ts: '2026-11-23T00:48:30.869Z', background: { id: 'a1', status: 'running' } })])];
    const [a] = subagentsOf([{ agentId: 'a1', toolUseId: 'repl_a1', type: 'general-purpose', description: 'Build' }], rows);
    expect(a.startedAt).toBe('2026-11-23T00:48:30.869Z');
  });

  it("is done by a foreground call's result, and a background one's notification decides", () => {
    const rows = [
      repl([
        call({ toolUseId: 'repl_f1', ts: '2026-11-23T01:00:00.000Z', result: 'Report' }),
        call({ toolUseId: 'repl_b1', agentId: 'b1', ts: '2026-11-23T01:00:01.000Z', background: { id: 'b1', status: 'completed' } }),
      ]),
    ];
    const metas: SubagentMeta[] = [
      { agentId: 'f1', toolUseId: 'repl_f1', type: 'web-fetch', description: 'Fetch' },
      { agentId: 'b1', toolUseId: 'repl_b1', type: 'general-purpose', description: 'Build' },
    ];
    expect(subagentsOf(metas, rows, undefined, undefined, { b1: 'running' }).map((a) => a.status)).toEqual(['done', 'running']);
  });

  it('keeps reading a top-level Agent call as before', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-t1', name: 'Agent', input: { description: 'Top' } }] } }));
    acc.addLine(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-t1', content: 'done' }] } }));
    expect(subagentsOf([{ agentId: 't1', toolUseId: 'tu-t1', type: 'general-purpose', description: 'Top' }], acc.rows)[0].status).toBe('done');
  });
});
