import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MessagesService,
  TranscriptAccumulator,
  TranscriptReader,
  endedSessions,
  readRunSessionId,
  readTranscriptRef,
} from '../src/engine/messages';
import { Logger } from '../src/engine/log';
import { endAgentSession } from '../src/engine/steps/agent';
import { guidanceMessage } from '../src/shared/messages';
import { SettingsSchema } from '../src/shared/types';

const rec = (obj: Record<string, unknown>) => JSON.stringify(obj);

const userPrompt = (text: string) =>
  rec({ type: 'user', timestamp: '2026-09-03T10:00:00.000Z', message: { role: 'user', content: text } });

const assistantBlock = (block: Record<string, unknown>) =>
  rec({ type: 'assistant', timestamp: '2026-09-03T10:00:01.000Z', message: { role: 'assistant', content: [block] } });

describe('TranscriptAccumulator', () => {
  it('turns prompt, text, thinking and tool_use records into rows', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(userPrompt('Do the thing.\nSecond line.'));
    acc.addLine(assistantBlock({ type: 'thinking', thinking: 'hmm, let me see' }));
    acc.addLine(assistantBlock({ type: 'text', text: 'On it.' }));
    acc.addLine(assistantBlock({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }));
    expect(acc.rows.map((r) => r.kind)).toEqual(['prompt', 'thinking', 'agent', 'tool']);
    expect(acc.rows[0].preview).toBe('Do the thing. Second line.');
    expect(acc.rows[3].tool).toBe('Bash');
    expect(acc.rows[3].preview).toBe('Run tests');
    expect(acc.rows[3].text).toContain('command: npm test');
  });

  it('attaches tool results (and the subagent id) to the tool row instead of adding a user row', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(assistantBlock({ type: 'tool_use', id: 'tu1', name: 'Task', input: { description: 'Explore', prompt: 'go' } }));
    acc.addLine(
      rec({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'found it' }] }] },
        toolUseResult: { agentId: 'abc1234' },
      }),
    );
    expect(acc.rows).toHaveLength(1);
    expect(acc.rows[0].result).toBe('found it');
    expect(acc.rows[0].agentId).toBe('abc1234');
    expect(acc.rows[0].resultError).toBeUndefined();
  });

  it('marks failed tool results', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(assistantBlock({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'false' } }));
    acc.addLine(
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'boom', is_error: true }] } }),
    );
    expect(acc.rows[0].resultError).toBe(true);
    expect(acc.rows[0].result).toBe('boom');
  });

  it("shows the user's guidance however the hooks handed it over", () => {
    const acc = new TranscriptAccumulator();
    const msg = guidanceMessage('use pnpm');
    // PostToolUse additionalContext, as claude 2.1.x records hook context.
    acc.addLine(
      rec({
        type: 'attachment',
        isSidechain: false,
        timestamp: '2026-10-02T10:00:00.000Z',
        attachment: { type: 'hook_additional_context', content: [msg], hookName: 'PostToolUse', hookEvent: 'PostToolUse' },
      }),
    );
    // A Stop-hook block, as claude records one (captured from a looper run, claude 2.1.282).
    acc.addLine(rec({ type: 'user', isMeta: true, message: { role: 'user', content: `Stop hook feedback:\n${guidanceMessage('and stop after')}` } }));
    // Typed into an idle interactive session.
    acc.addLine(userPrompt(guidanceMessage('one more\nthing')));
    // Other hook context and meta records stay hidden.
    acc.addLine(rec({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['Style violation…'] } }));
    acc.addLine(rec({ type: 'user', isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\nLooper: the turn ended without looper-done.' } }));
    expect(acc.rows.map((r) => [r.kind, r.text])).toEqual([
      ['guidance', 'use pnpm'],
      ['guidance', 'and stop after'],
      ['guidance', 'one more\nthing'],
    ]);
  });

  it('skips bookkeeping types, sidechain and meta records, and torn lines', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(rec({ type: 'ai-title', title: 'x' }));
    acc.addLine(rec({ type: 'attachment', message: { content: 'x' } }));
    acc.addLine(rec({ type: 'queue-operation' }));
    acc.addLine(rec({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sidechain' } }));
    acc.addLine(rec({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }));
    acc.addLine('{"type":"user","mess');
    expect(acc.rows).toHaveLength(0);
  });

  it('keeps sidechain records when reading a subagent transcript', () => {
    const acc = new TranscriptAccumulator({ sidechain: true });
    acc.addLine(rec({ type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } }));
    acc.addLine(rec({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }));
    expect(acc.rows.map((r) => r.kind)).toEqual(['prompt', 'agent']);
  });

  it('falls back to JSON for tool results whose blocks carry no text', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(assistantBlock({ type: 'tool_use', id: 'tu1', name: 'ToolSearch', input: { query: 'select:Read' } }));
    acc.addLine(
      rec({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'tool_reference', tool_name: 'Read' }] }],
        },
      }),
    );
    expect(acc.rows[0].result).toContain('tool_reference');
    expect(acc.rows[0].result).toContain('Read');
  });

  it('strips tag blocks from previews but keeps the full text', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(userPrompt('<system-reminder>noise</system-reminder>Real ask'));
    expect(acc.rows[0].preview).toBe('Real ask');
    expect(acc.rows[0].text).toContain('noise');
  });

  it('keeps image payloads engine-side and marks the row', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(assistantBlock({ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x/shot.png' } }));
    acc.addLine(
      rec({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }],
            },
          ],
        },
      }),
    );
    const row = acc.rows[0];
    expect(row.file).toBe('/x/shot.png');
    expect(row.image).toEqual({ mediaType: 'image/png' });
    expect(acc.images.get(row.id)).toEqual({ mediaType: 'image/png', data: 'aGVsbG8=' });
    // The row itself must not carry the payload.
    expect('data' in (row.image as object)).toBe(false);
  });

  it('keeps the structured input and the recorded patch for custom renders', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(
      assistantBlock({ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/x/a.md', old_string: 'a', new_string: 'b' } }),
    );
    acc.addLine(
      rec({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        toolUseResult: {
          filePath: '/x/a.md',
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
        },
      }),
    );
    const row = acc.rows[0];
    expect(row.input).toEqual({ file_path: '/x/a.md', old_string: 'a', new_string: 'b' });
    expect(row.patch).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]);
  });

  it('raw mode turns every line into a pretty-printed record row', () => {
    const acc = new TranscriptAccumulator({ raw: true });
    acc.addLine(rec({ type: 'queue-operation', timestamp: '2026-09-03T10:00:00.000Z' }));
    acc.addLine(userPrompt('hello'));
    acc.addLine('not json at all');
    expect(acc.rows).toHaveLength(3);
    expect(acc.rows[0].kind).toBe('raw');
    expect(acc.rows[0].tool).toBe('queue-operation');
    expect(acc.rows[0].text).toContain('"type": "queue-operation"');
    expect(acc.rows[1].tool).toBe('user');
    expect(acc.rows[2].text).toBe('not json at all');
  });

  it('marks classifier rows and prefixes their ids so a merged list cannot collide', () => {
    const acc = new TranscriptAccumulator({ source: 'classifier' });
    acc.addLine(userPrompt('should we act?'));
    acc.addLine(assistantBlock({ type: 'text', text: 'act: yes' }));
    expect(acc.rows.map((r) => r.id)).toEqual(['c0', 'c1']);
    expect(acc.rows.every((r) => r.source === 'classifier')).toBe(true);
  });

  it('drops oldest rows past the cap and keeps ids stable', () => {
    const acc = new TranscriptAccumulator();
    for (let i = 0; i < 1005; i++) acc.addLine(userPrompt(`msg ${i}`));
    expect(acc.rows).toHaveLength(1000);
    expect(acc.dropped).toBe(5);
    expect(acc.rows[0].id).toBe('5');
    expect(acc.rows[0].preview).toBe('msg 5');
  });
});

describe('TranscriptReader', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-messages-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads incrementally and completes a line torn across appends', async () => {
    const file = path.join(dir, 't.jsonl');
    const line1 = userPrompt('first');
    const line2 = assistantBlock({ type: 'text', text: 'réponse' }); // multi-byte survives the split
    fs.writeFileSync(file, line1 + '\n' + line2.slice(0, 10));
    const r = new TranscriptReader(file);
    await r.read();
    expect(r.acc.rows).toHaveLength(1);
    fs.appendFileSync(file, line2.slice(10) + '\n');
    await r.read();
    expect(r.acc.rows).toHaveLength(2);
    expect(r.acc.rows[1].text).toBe('réponse');
    await r.read(); // nothing new: no change
    expect(r.acc.rows).toHaveLength(2);
  });

  it('adds new lines once when two reads overlap', async () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, userPrompt('first') + '\n');
    const r = new TranscriptReader(file);
    await r.read();
    fs.appendFileSync(file, userPrompt('second') + '\n');
    await Promise.all([r.read(), r.read()]);
    expect(r.acc.rows.map((row) => row.preview)).toEqual(['first', 'second']);
  });

  it('throws when the file does not exist', async () => {
    const r = new TranscriptReader(path.join(dir, 'missing.jsonl'));
    await expect(r.read()).rejects.toThrow();
  });

  it('given candidates, reads whichever appears first and sticks to it', async () => {
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    const r = new TranscriptReader([a, b]);
    await expect(r.read()).rejects.toThrow(); // neither exists yet
    fs.writeFileSync(b, userPrompt('from b') + '\n');
    await r.read();
    expect(r.acc.rows[0].preview).toBe('from b');
    // A later-appearing first candidate must not switch the reader mid-stream.
    fs.writeFileSync(a, userPrompt('from a') + '\n');
    await r.read();
    expect(r.acc.rows).toHaveLength(1);
  });
});

describe('readTranscriptRef', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-messages-ref-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers session.json, falls back to stop.json, tolerates a BOM', () => {
    expect(readTranscriptRef(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'stop.json'), '﻿' + JSON.stringify({ transcript_path: '/x/stop.jsonl' }));
    expect(readTranscriptRef(dir)).toBe('/x/stop.jsonl');
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ transcript_path: '/x/session.jsonl' }));
    expect(readTranscriptRef(dir)).toBe('/x/session.jsonl');
  });

  it('skips a torn session.json in favor of a valid stop.json', () => {
    fs.writeFileSync(path.join(dir, 'session.json'), '{"transcript_pa');
    fs.writeFileSync(path.join(dir, 'stop.json'), JSON.stringify({ transcript_path: '/x/s.jsonl' }));
    expect(readTranscriptRef(dir)).toBe('/x/s.jsonl');
  });

  it('the classify- prefix reads the classifier session, never the agent one', () => {
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ transcript_path: '/x/agent.jsonl' }));
    expect(readTranscriptRef(dir, 'classify-')).toBeNull();
    fs.writeFileSync(path.join(dir, 'classify-session.json'), JSON.stringify({ transcript_path: '/x/cls.jsonl' }));
    expect(readTranscriptRef(dir, 'classify-')).toBe('/x/cls.jsonl');
    expect(readTranscriptRef(dir)).toBe('/x/agent.jsonl');
  });
});

describe('a run with context restarts', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-messages-restart-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A run dir as a claude agent leaves it: transcripts outside, session.json naming them. */
  function session(prefix: string, name: string, text: string): string {
    const transcript = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(transcript, [userPrompt(`${name} prompt`), assistantBlock({ type: 'text', text })].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'run', `${prefix}session.json`), JSON.stringify({ session_id: name, transcript_path: transcript }));
    return transcript;
  }

  it("files an ended session away, and the Messages view shows every session's conversation in order", async () => {
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    session('', 'first', 'first session works');
    fs.writeFileSync(path.join(runDir, 'done'), 'restart\nfull\n');
    fs.writeFileSync(path.join(runDir, 'stop-reminded'), '');
    fs.writeFileSync(path.join(runDir, 'codex-home'), '/home/x/.codex');
    fs.writeFileSync(path.join(runDir, 'notice.json'), '"waiting"');
    endAgentSession(runDir, 1);
    expect(fs.existsSync(path.join(runDir, 'done'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'stop-reminded'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'notice.json'))).toBe(false);
    expect(fs.readFileSync(path.join(runDir, 'session1-done'), 'utf8')).toBe('restart\nfull\n');
    // The launcher writes codex-home again; the ended session keeps a copy.
    expect(fs.readFileSync(path.join(runDir, 'codex-home'), 'utf8')).toBe('/home/x/.codex');
    expect(fs.readFileSync(path.join(runDir, 'session1-codex-home'), 'utf8')).toBe('/home/x/.codex');
    expect(endedSessions(runDir)).toEqual([1]);
    // The next session's files take the plain names; continuing the run resumes it.
    session('', 'second', 'second session finishes');
    expect(readRunSessionId(runDir, 'claude-code')).toBe('second');

    const service = new MessagesService({
      getTask: () => undefined,
      runDir: () => runDir,
      host: 'linux',
      settings: SettingsSchema.parse({}),
      log: new Logger(),
    });
    const res = await service.read('t1', 'r1');
    expect(res.status).toBe('ok');
    expect(res.rows.map((r) => [r.id, r.text])).toEqual([
      ['s1-0', 'first prompt'],
      ['s1-1', 'first session works'],
      ['0', 'second prompt'],
      ['1', 'second session finishes'],
    ]);
  });
});

describe('readRunSessionId', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-run-session-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('claude: the hook payload session_id, from session.json or stop.json', () => {
    expect(readRunSessionId(dir, 'claude-code')).toBeNull();
    fs.writeFileSync(path.join(dir, 'stop.json'), JSON.stringify({ session_id: 'sid-stop' }));
    expect(readRunSessionId(dir, 'claude-code')).toBe('sid-stop');
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ session_id: 'sid-start' }));
    expect(readRunSessionId(dir, 'claude-code')).toBe('sid-start');
  });

  it('claude: without a session_id the transcript filename is the id, Windows paths included', () => {
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ transcript_path: '/x/projects/p/abc-123.jsonl' }));
    expect(readRunSessionId(dir, 'claude-code')).toBe('abc-123');
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ transcript_path: 'C:\\x\\def-456.jsonl' }));
    expect(readRunSessionId(dir, 'claude-code')).toBe('def-456');
  });

  it('codex: the thread id; custom harnesses have no conversation', () => {
    expect(readRunSessionId(dir, 'codex')).toBeNull();
    fs.writeFileSync(path.join(dir, 'codex-session.json'), JSON.stringify({ thread_id: 'th-1' }));
    expect(readRunSessionId(dir, 'codex')).toBe('th-1');
    expect(readRunSessionId(dir, 'custom')).toBeNull();
  });
});
