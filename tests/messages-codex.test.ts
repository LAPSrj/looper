import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAccumulator, TranscriptReader, findCodexRollout, readCodexRef } from '../src/engine/messages';

// Fixture shapes captured live from a codex-cli 0.154.0 rollout
// (~/.codex/sessions/…/rollout-…-<thread id>.jsonl), trimmed to the essentials.

const rec = (type: string, payload: Record<string, unknown>, ts = '2026-09-13T19:06:00.000Z') =>
  JSON.stringify({ timestamp: ts, ordinal: 0, type, payload });

const userText = (text: string) =>
  rec('response_item', { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text }] });

const agentText = (text: string, phase = 'final_answer') =>
  rec('response_item', { type: 'message', id: 'm2', role: 'assistant', phase, content: [{ type: 'output_text', text }] });

const item = (item: Record<string, unknown>) =>
  rec('event_msg', { type: 'item_completed', thread_id: 't', turn_id: 'u', item });

describe('CodexAccumulator', () => {
  it('renders prompts, agent messages and executed commands', () => {
    const acc = new CodexAccumulator();
    acc.addLine(userText('Create tick.txt with "tock".'));
    acc.addLine(agentText('I’ll create it and verify.', 'commentary'));
    acc.addLine(
      item({
        type: 'CommandExecution',
        id: 'exec-1',
        command: ['/bin/bash', '-lc', 'test "$(< tick.txt)" = tock && looper-done success ok'],
        status: 'completed',
        stdout: '',
        stderr: '',
        aggregated_output: '',
        exit_code: 0,
      }),
    );
    acc.addLine(agentText('Created `tick.txt`.'));
    expect(acc.rows.map((r) => r.kind)).toEqual(['prompt', 'agent', 'tool', 'agent']);
    expect(acc.rows[2].tool).toBe('Bash');
    expect(acc.rows[2].text).toContain('looper-done success ok');
    expect((acc.rows[2].input as { command: string }).command).toContain('test "$(< tick.txt)"');
    expect(acc.rows[2].resultError).toBeUndefined();
  });

  it('keeps command output and marks failures', () => {
    const acc = new CodexAccumulator();
    acc.addLine(
      item({
        type: 'CommandExecution',
        command: ['powershell.exe', '-Command', 'looper-done success x'],
        status: 'failed',
        aggregated_output: 'looper-done : not recognized',
        exit_code: 1,
      }),
    );
    expect(acc.rows[0].result).toBe('looper-done : not recognized');
    expect(acc.rows[0].resultError).toBe(true);
    expect(acc.rows[0].text).toBe('looper-done success x');
  });

  it('renders a FileChange add as a Write row with the content', () => {
    const acc = new CodexAccumulator();
    acc.addLine(
      item({
        type: 'FileChange',
        changes: { '/ws/tick.txt': { type: 'add', content: 'tock\n' } },
        status: 'completed',
        stdout: 'Success. Updated the following files:\nA tick.txt\n',
      }),
    );
    expect(acc.rows).toHaveLength(1);
    expect(acc.rows[0]).toMatchObject({ kind: 'tool', tool: 'Write', file: '/ws/tick.txt' });
    expect((acc.rows[0].input as { content: string }).content).toBe('tock\n');
  });

  it('renders a FileChange update as an Edit row with parsed diff hunks', () => {
    const acc = new CodexAccumulator();
    // unified_diff shape captured live (codex-cli 0.154.0).
    acc.addLine(
      item({
        type: 'FileChange',
        changes: {
          '/ws/list.txt': {
            type: 'update',
            unified_diff: '@@ -2,4 +2,3 @@\n bravo\n-charlie\n+charlie-two\n delta\n-echo\n',
            move_path: null,
          },
        },
        status: 'completed',
        stdout: 'Success. Updated the following files:\nM /ws/list.txt\n',
      }),
    );
    expect(acc.rows).toHaveLength(1);
    const row = acc.rows[0];
    expect(row).toMatchObject({ kind: 'tool', tool: 'Edit', file: '/ws/list.txt', preview: '/ws/list.txt' });
    expect(row.patch).toEqual([
      {
        oldStart: 2,
        oldLines: 4,
        newStart: 2,
        newLines: 3,
        lines: [' bravo', '-charlie', '+charlie-two', ' delta', '-echo'],
      },
    ]);
  });

  it('shows a rename in the Edit row preview', () => {
    const acc = new CodexAccumulator();
    acc.addLine(
      item({
        type: 'FileChange',
        changes: {
          '/ws/a.txt': { type: 'update', unified_diff: '@@ -1 +1 @@\n-x\n+y\n', move_path: '/ws/b.txt' },
        },
        status: 'completed',
      }),
    );
    expect(acc.rows[0].preview).toBe('/ws/a.txt → /ws/b.txt');
    expect(acc.rows[0].input).toEqual({ move_path: '/ws/b.txt' });
  });

  it('skips injected context, developer records, duplicates and bookkeeping', () => {
    const acc = new CodexAccumulator();
    acc.addLine(userText('<environment_context>\n  <cwd>/ws</cwd>\n</environment_context>'));
    acc.addLine(rec('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'skills' }] }));
    // Messages ride response_item; the item_completed copies must not duplicate them.
    acc.addLine(item({ type: 'UserMessage', content: [{ type: 'text', text: 'dupe' }] }));
    acc.addLine(item({ type: 'AgentMessage', content: [{ type: 'Text', text: 'dupe' }], phase: 'final_answer' }));
    acc.addLine(item({ type: 'Reasoning', summary_text: [], raw_content: [] }));
    acc.addLine(rec('session_meta', { id: 't' }));
    acc.addLine(rec('world_state', { full: true }));
    acc.addLine(rec('turn_context', { turn_id: 'u' }));
    acc.addLine(rec('token_usage_record', {}));
    acc.addLine(rec('event_msg', { type: 'task_complete', last_agent_message: 'x' }));
    acc.addLine('{"timestamp":"torn');
    expect(acc.rows).toHaveLength(0);
  });

  it('shows reasoning summaries as thinking rows, and skips encrypted-only reasoning', () => {
    const acc = new CodexAccumulator();
    acc.addLine(rec('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan the file write.' }] }));
    acc.addLine(rec('response_item', { type: 'reasoning', summary: [], encrypted_content: 'gAAAA…' }));
    expect(acc.rows.map((r) => r.kind)).toEqual(['thinking']);
    expect(acc.rows[0].text).toBe('Plan the file write.');
  });

  it('prefixes classifier rows like the claude accumulator does', () => {
    const acc = new CodexAccumulator({ source: 'classifier' });
    acc.addLine(agentText('{"act":false,"reason":"nothing to do"}'));
    expect(acc.rows[0].id.startsWith('c')).toBe(true);
    expect(acc.rows[0].source).toBe('classifier');
  });
});

describe('codex refs and rollout lookup', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-codexmsg-'));
    dirs.push(d);
    return d;
  };

  it('readCodexRef needs both the thread id and the codex home', () => {
    const runDir = tmp();
    expect(readCodexRef(runDir)).toBeNull();
    fs.writeFileSync(path.join(runDir, 'codex-session.json'), JSON.stringify({ thread_id: '01a0-thread' }));
    expect(readCodexRef(runDir)).toBeNull();
    fs.writeFileSync(path.join(runDir, 'codex-home'), '/home/me/.codex');
    expect(readCodexRef(runDir)).toEqual({ threadId: '01a0-thread', codexHome: '/home/me/.codex' });
    // The classifier step keeps its own pair.
    expect(readCodexRef(runDir, 'classify-')).toBeNull();
  });

  it('findCodexRollout matches the thread id in the dated tree, newest first', async () => {
    const home = tmp();
    const day = path.join(home, 'sessions', '2026', '09', '13');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-2026-09-13T11-23-06-01a0-thread.jsonl'), '');
    fs.writeFileSync(path.join(day, 'rollout-2026-09-13T11-24-00-01a0-other.jsonl'), '');
    expect(await findCodexRollout(path.join(home, 'sessions'), '01a0-thread')).toBe(
      path.join(day, 'rollout-2026-09-13T11-23-06-01a0-thread.jsonl'),
    );
    expect(await findCodexRollout(path.join(home, 'sessions'), 'missing')).toBeNull();
    expect(await findCodexRollout(path.join(home, 'nowhere'), '01a0-thread')).toBeNull();
  });

  it('TranscriptReader in codex format tails a rollout incrementally', async () => {
    const dir = tmp();
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(file, userText('Do it.') + '\n');
    const reader = new TranscriptReader(file, {}, 'codex');
    await reader.read();
    expect(reader.acc.rows.map((r) => r.kind)).toEqual(['prompt']);
    fs.appendFileSync(file, agentText('Done.') + '\n');
    await reader.read();
    expect(reader.acc.rows.map((r) => r.kind)).toEqual(['prompt', 'agent']);
    expect(reader.acc.rows[1].text).toBe('Done.');
  });
});
