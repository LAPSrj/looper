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
import { guidanceMessage, toolImageKey } from '../src/shared/messages';
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

  it("shows a slash command or skill as the user's /name and arguments, without the skill's content", () => {
    // As claude 2.1.x records `/edit-block Hero`: the command, then the skill's content as a meta record.
    const acc = new TranscriptAccumulator();
    acc.addLine(userPrompt('<command-message>edit-block</command-message>\n<command-name>/edit-block</command-name>\n<command-args>Hero</command-args>'));
    acc.addLine(
      rec({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /p/.claude/skills/edit-block\n\n# Edit Block' }] },
      }),
    );
    acc.addLine(userPrompt('<command-message>pick-up</command-message>\n<command-name>/pick-up</command-name>'));
    acc.addLine(userPrompt('<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>'));
    // Text that only mentions the tags stays as the user wrote it.
    acc.addLine(userPrompt('What does <command-name>/x</command-name> mean?'));
    expect(acc.rows.map((r) => [r.kind, r.text])).toEqual([
      ['prompt', '/edit-block Hero'],
      ['prompt', '/pick-up'],
      ['prompt', '/clear'],
      ['prompt', 'What does <command-name>/x</command-name> mean?'],
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
    // The row itself must not carry the payload, in its marker or its result text.
    expect('data' in (row.image as object)).toBe(false);
    expect(row.result).toBe('');
    // The tool_use id finds the image whatever list of rows the caller has.
    expect(row.toolUseId).toBe('tu1');
    expect(acc.toolImage('tu1')).toEqual({ mediaType: 'image/png', data: 'aGVsbG8=' });
    expect(acc.toolImage('nope')).toBeNull();
  });

  it("gives a Skill call the skill's content Claude Code adds after it", () => {
    // As claude 2.1.x records a Skill call: the call, "Launching skill: …", then a meta record naming the call.
    const acc = new TranscriptAccumulator();
    const skill = 'Base directory for this skill: /home/me/.claude/skills/pick-up\n\n# Pick up\n\nThe argument is ``.';
    acc.addLine(assistantBlock({ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'pick-up' } }));
    acc.addLine(rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Launching skill: pick-up' }] } }));
    acc.addLine(rec({ type: 'user', isMeta: true, sourceToolUseID: 'tu1', message: { role: 'user', content: [{ type: 'text', text: skill }] } }));
    // Without sourceToolUseID, a skill text right after a Skill call is that call's.
    acc.addLine(assistantBlock({ type: 'tool_use', id: 'tu2', name: 'Skill', input: { skill: 'run' } }));
    acc.addLine(rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'Launching skill: run' }] } }));
    acc.addLine(rec({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /tmp/run\n\nRun it.' } }));
    expect(acc.rows.map((r) => [r.kind, r.tool, r.result, r.skill])).toEqual([
      ['tool', 'Skill', 'Launching skill: pick-up', skill],
      ['tool', 'Skill', 'Launching skill: run', 'Base directory for this skill: /tmp/run\n\nRun it.'],
    ]);
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

  it('turns a delivered SendUserFile call into the agent sending files (claude 2.1.x transcript shape)', () => {
    const acc = new TranscriptAccumulator();
    const shots = '/mnt/c/Users/leand/AppData/Local/Temp/looper-round3/shots';
    acc.addLine(
      assistantBlock({
        type: 'tool_use',
        id: 'tu1',
        name: 'SendUserFile',
        input: { files: [`${shots}/a.png`, 'notes/report.pdf'], caption: 'Both views.', status: 'normal', display: 'render' },
      }),
    );
    expect(acc.rows[0].sent).toBeUndefined(); // not delivered yet
    acc.addLine(
      rec({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { tool_use_id: 'tu1', type: 'tool_result', content: `2 files delivered to user.\n  ${shots}/a.png → file_uuid: 940290c9\n  /home/u/p/notes/report.pdf → file_uuid: fd00ff37` },
          ],
        },
        toolUseResult: {
          caption: 'Both views.',
          display: 'render',
          attachments: [
            { path: `${shots}/a.png`, size: 89994, isImage: true, media_type: 'image/png', pathValidated: true, file_uuid: '940290c9' },
            { path: '/home/u/p/notes/report.pdf', size: 2048, isImage: false, media_type: 'application/pdf', pathValidated: true, file_uuid: 'fd00ff37' },
          ],
        },
      }),
    );
    expect(acc.rows).toHaveLength(1);
    const row = acc.rows[0];
    expect(row.kind).toBe('tool');
    expect(row.tool).toBe('SendUserFile');
    expect(row.preview).toBe('Both views.');
    expect(row.sent).toEqual({
      caption: 'Both views.',
      files: [
        { path: `${shots}/a.png`, name: 'a.png', inline: true, size: 89994 },
        { path: '/home/u/p/notes/report.pdf', name: 'report.pdf', inline: false, size: 2048 },
      ],
    });
  });

  it("falls back to the SendUserFile call's own files, shows display attach as a card, and leaves a failed call a tool call", () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(assistantBlock({ type: 'tool_use', id: 'tu1', name: 'SendUserFile', input: { files: ['out/chart.svg'], status: 'proactive', display: 'attach' } }));
    acc.addLine(rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '1 file delivered to user.' }] } }));
    acc.addLine(assistantBlock({ type: 'tool_use', id: 'tu2', name: 'SendUserFile', input: { files: ['missing.png'], status: 'normal' } }));
    acc.addLine(rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'File not found', is_error: true }] } }));
    expect(acc.rows[0].sent).toEqual({ files: [{ path: 'out/chart.svg', name: 'chart.svg', inline: false }] });
    expect(acc.rows[0].preview).toBe('chart.svg');
    expect(acc.rows[1].sent).toBeUndefined();
    expect(acc.rows[1].resultError).toBe(true);
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

  it("finds a tool call's image by its tool_use id in whichever session made the call", async () => {
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    const first = session('', 'first', 'reading');
    fs.appendFileSync(
      first,
      [
        assistantBlock({ type: 'tool_use', id: 'tu-img', name: 'Read', input: { file_path: '/x/a.png' } }),
        rec({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu-img', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] }],
          },
        }),
      ].join('\n') + '\n',
    );
    endAgentSession(runDir, 1);
    session('', 'second', 'next');
    const service = new MessagesService({
      getTask: () => undefined,
      runDir: () => runDir,
      host: 'linux',
      settings: SettingsSchema.parse({}),
      log: new Logger(),
    });
    expect(await service.readImage('t1', 'r1', toolImageKey('tu-img'))).toEqual({ mediaType: 'image/png', data: 'aGk=' });
    expect(await service.readImage('t1', 'r1', toolImageKey('tu-none'))).toBeNull();
    // A plain row id still names the row in its own session.
    expect(await service.readImage('t1', 'r1', 's1-2')).toEqual({ mediaType: 'image/png', data: 'aGk=' });
  });

  it("opens a workflow agent's conversation under its run's folder, and lists the session's workflow runs", async () => {
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    const transcript = session('', 'parent', 'starting a workflow');
    const wf = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents', 'workflows', 'wf_e83e0899-949');
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, 'journal.jsonl'), '{"type":"launched"}\n{"type":"started","key":"k","agentId":"a9a1cc7bb1018ff6b","label":"menus and power","phase":"Wave 1"}\n');
    fs.writeFileSync(path.join(wf, 'agent-a9a1cc7bb1018ff6b.jsonl'), [userPrompt('[Workflow harness — computed task] Move the menu'), assistantBlock({ type: 'text', text: 'Moving it' })].join('\n') + '\n');
    const service = new MessagesService({
      getTask: () => undefined,
      runDir: () => runDir,
      host: 'linux',
      settings: SettingsSchema.parse({}),
      log: new Logger(),
    });
    const res = await service.read('t1', 'r1', 'a9a1cc7bb1018ff6b');
    expect(res.status).toBe('ok');
    expect(res.rows.map((r) => r.text)).toEqual(['[Workflow harness — computed task] Move the menu', 'Moving it']);
    const runs = await service.workflows('t1', 'r1');
    expect(runs.map((r) => [r.runId, r.status, r.phases.map((p) => p.agents.map((a) => a.label))])).toEqual([['wf_e83e0899-949', 'running', [['menus and power']]]]);
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
