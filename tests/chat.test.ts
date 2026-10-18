import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MAX_INLINE_IMAGE,
  claudeContextWindow,
  claudeUserMessage,
  codexForkThread,
  forkTurnId,
  imageMediaType,
  needsNewProcess,
  permissionAnswer,
  permissionModeRequest,
  withFileList,
} from '../src/engine/chat';
import { codexWindowOfLine } from '../src/engine/context';
import { TranscriptAccumulator } from '../src/engine/messages';
import { RunStore } from '../src/engine/store/runs';
import { BashTarget } from '../src/engine/target';
import { chatTitle, contextText, forkPoint, formatTokens, type ChatInfo } from '../src/shared/chat';
import type { MessageRow } from '../src/shared/messages';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'looper-chat-'));

describe('chat messages', () => {
  it('lists the files the agent reads by path after the text', () => {
    expect(withFileList('Look at these', [])).toBe('Look at these');
    expect(withFileList('Look at these', ['/a/spec.pdf', '/a/notes.txt'])).toBe(
      'Look at these\n\nAttached files (read them from these paths):\n- /a/spec.pdf\n- /a/notes.txt',
    );
    expect(withFileList('', ['/a/spec.pdf'])).toBe('Attached files (read them from these paths):\n- /a/spec.pdf');
  });

  it('sends images inside the message and other files, or oversized images, by path', () => {
    const files: Record<string, Buffer> = {
      '/h/small.png': Buffer.from('png-bytes'),
      '/h/huge.jpg': Buffer.alloc(MAX_INLINE_IMAGE + 1),
    };
    const msg = claudeUserMessage(
      'What is this?',
      [
        { name: 'small.png', path: '/h/small.png', image: true },
        { name: 'huge.jpg', path: '/h/huge.jpg', image: true },
        { name: 'spec.pdf', path: '/h/spec.pdf', image: false },
      ],
      (p) => `/target${p}`,
      (p) => files[p],
    ) as { message: { content: Record<string, unknown>[] } };
    expect(msg.message.content).toEqual([
      {
        type: 'text',
        text: 'What is this?\n\nAttached files (read them from these paths):\n- /target/h/huge.jpg\n- /target/h/spec.pdf',
      },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png-bytes').toString('base64') } },
    ]);
  });

  it('sends an image alone without an empty text block', () => {
    const msg = claudeUserMessage('', [{ name: 'a.webp', path: '/h/a.webp', image: true }], (p) => p, () => Buffer.from('x')) as {
      message: { content: { type: string }[] };
    };
    expect(msg.message.content.map((b) => b.type)).toEqual(['image']);
  });

  it('knows the image types the agents can see', () => {
    expect(imageMediaType('/x/Shot.PNG')).toBe('image/png');
    expect(imageMediaType('/x/photo.jpeg')).toBe('image/jpeg');
    expect(imageMediaType('/x/doc.pdf')).toBeUndefined();
  });

  it("answers claude's permission hook in its decision format", () => {
    expect(JSON.parse(permissionAnswer(true, { command: 'ls' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { command: 'ls' } } },
    });
    expect(JSON.parse(permissionAnswer(false, {})).hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: 'The user denied this in Looper.',
    });
  });
});

describe('chat settings', () => {
  it("switches claude's permission mode with a control request ('' is the default mode)", () => {
    expect(JSON.parse(permissionModeRequest('mode-1', 'acceptEdits'))).toEqual({
      type: 'control_request',
      request_id: 'mode-1',
      request: { subtype: 'set_permission_mode', mode: 'acceptEdits' },
    });
    expect(JSON.parse(permissionModeRequest('mode-2', '')).request.mode).toBe('default');
  });

  it('needs a new claude process for a new model, effort or Bypass, and not for another mode', () => {
    const launched = { model: 'opus', effort: 'medium', bypass: false };
    const s = { model: 'opus', effort: 'medium', permissionMode: 'auto' };
    expect(needsNewProcess(launched, { ...s, permissionMode: 'plan' }, 'medium')).toBe(false);
    expect(needsNewProcess(launched, { ...s, model: 'sonnet' }, 'medium')).toBe(true);
    expect(needsNewProcess(launched, s, 'high')).toBe(true);
    expect(needsNewProcess(launched, { ...s, permissionMode: 'bypassPermissions' }, 'medium')).toBe(true);
    // Started with Bypass, it switches to and from it in place.
    expect(needsNewProcess({ ...launched, bypass: true }, { ...s, permissionMode: 'bypassPermissions' }, 'medium')).toBe(false);
  });

  it("reads the context window from claude's result, by the model the init named", () => {
    const result = {
      type: 'result',
      modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1_000_000 }, 'claude-haiku-5-5': { contextWindow: 200_000 } },
    };
    expect(claudeContextWindow(result, 'claude-haiku-5-5')).toBe(200_000);
    expect(claudeContextWindow({ modelUsage: { m: { contextWindow: 400_000 } } }, undefined)).toBe(400_000);
    expect(claudeContextWindow(result, undefined)).toBeUndefined();
    expect(claudeContextWindow({ type: 'result' }, 'x')).toBeUndefined();
  });

  it("reads codex's context window from a token_count line", () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20914 }, model_context_window: 258400 } },
    });
    expect(codexWindowOfLine(line)).toBe(258400);
    expect(codexWindowOfLine('{"type":"event_msg","payload":{"type":"token_count","info":null}}')).toBeNull();
  });

  it('shows the context as tokens of the window', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(42_310)).toBe('42k');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(contextText({ tokens: 42_310, window: 1_000_000 })).toBe('42k of 1M context (4%)');
    expect(contextText({ tokens: 42_310 })).toBe('42k context');
  });

  it("titles a chat with its first message's first line", () => {
    expect(chatTitle([{ id: '1', kind: 'agent', text: 'hi', preview: '' }, { id: '2', kind: 'prompt', text: 'Fix the footer\nthen deploy', preview: '' }])).toBe(
      'Fix the footer',
    );
    expect(chatTitle([{ id: '1', kind: 'prompt', text: '', preview: '', attachments: [{ name: 'a.png', path: '/a.png', image: true }] }])).toBe('a.png');
    expect(chatTitle([{ id: '1', kind: 'prompt', text: 'Reply with **pong** in `code`', preview: '' }])).toBe('Reply with pong in code');
    expect(chatTitle([])).toBe('Untitled chat');
  });
});

describe('chat runs', () => {
  const info: ChatInfo = { harnessKind: 'claude-code', title: 'Fix the footer', settings: { model: 'opus', permissionMode: 'auto' } };

  it('keeps a chat in its run folder, and lists the runs that are chats', () => {
    const store = new RunStore(tmp());
    store.createRunDir('t1', '20261001-100000-aaaa');
    store.createRunDir('t1', '20261002-100000-bbbb');
    store.createRunDir('t1', '20261003-100000-cccc');
    store.writeChatInfo('t1', '20261001-100000-aaaa', info);
    store.writeChatInfo('t1', '20261003-100000-cccc', { ...info, forkedFrom: '20261001-100000-aaaa' });
    expect(store.listChatRunIds('t1')).toEqual(['20261001-100000-aaaa', '20261003-100000-cccc']);
    expect(store.readChatInfo('t1', '20261003-100000-cccc')?.forkedFrom).toBe('20261001-100000-aaaa');
    expect(store.readChatInfo('t1', '20261002-100000-bbbb')).toBeNull();
    expect(store.listChatRunIds('t2')).toEqual([]);
  });
});

describe('Fork from Here', () => {
  const row = (id: string, kind: MessageRow['kind'], text: string, uuid?: string): MessageRow => ({ id, kind, text, preview: '', ...(uuid ? { uuid } : {}) });
  const rows = [
    row('0', 'prompt', 'first'),
    row('1', 'agent', 'one', 'u1'),
    row('2', 'tool', 'ls', 'u2'),
    row('3', 'agent', 'two', 'u3'),
    row('4', 'prompt', 'second'),
    row('5', 'agent', 'three', 'u5'),
  ];

  it('forks claude at any of its messages, and a message of the user before it, with the message as a draft', () => {
    expect(forkPoint(rows, 1, 'claude-code', false)).toEqual({ at: rows[1], keep: 2 });
    expect(forkPoint(rows, 4, 'claude-code', false)).toEqual({ at: rows[3], keep: 4, draft: rows[4] });
    // The first message: a new conversation with the message in the box.
    expect(forkPoint(rows, 0, 'claude-code', false)).toEqual({ keep: 0, draft: rows[0] });
    expect(forkPoint(rows, 2, 'claude-code', false)).toBeNull();
    // Looper's own lines (no transcript id) aren't in the conversation.
    expect(forkPoint([row('0', 'prompt', 'hi'), row('1', 'agent', 'Stopped.')], 1, 'claude-code', false)).toBeNull();
  });

  it("forks codex only where a turn ends, and not in a turn that's still running", () => {
    expect(forkPoint(rows, 1, 'codex', false)).toBeNull();
    expect(forkPoint(rows, 3, 'codex', false)).toEqual({ at: rows[3], keep: 4 });
    expect(forkPoint(rows, 5, 'codex', false)).toEqual({ at: rows[5], keep: 6 });
    expect(forkPoint(rows, 5, 'codex', true)).toBeNull();
    expect(forkPoint(rows, 4, 'codex', true)).toEqual({ at: rows[3], keep: 4, draft: rows[4] });
  });

  it("finds the codex turn by the agent message's text and how often it came before", () => {
    const turns = [
      { id: 't1', items: [{ type: 'userMessage' }, { type: 'agentMessage', text: 'OK' }] },
      { id: 't2', items: [{ type: 'agentMessage', text: 'Looking…' }, { type: 'agentMessage', text: 'OK\n' }] },
    ];
    expect(forkTurnId(turns, 'OK', 1)).toBe('t1');
    expect(forkTurnId(turns, 'OK', 2)).toBe('t2');
    expect(forkTurnId(turns, 'OK', 3)).toBeNull();
    expect(forkTurnId(turns, 'missing', 1)).toBeNull();
  });

  /** A stand-in for `codex app-server`: answers each request from `answers` by method. */
  const fakeServer = (answers: Record<string, (params: Record<string, unknown>) => unknown>) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout });
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let buf = '';
    stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, nl)) as { id?: number; method: string; params: Record<string, unknown> };
        buf = buf.slice(nl + 1);
        calls.push({ method: msg.method, params: msg.params });
        if (msg.id === undefined) continue;
        const answer = answers[msg.method];
        // A notification first, as the server sends them unasked.
        stdout.write(JSON.stringify({ method: 'thread/status/changed', params: {} }) + '\n');
        stdout.write(
          JSON.stringify(answer ? { id: msg.id, result: answer(msg.params) } : { id: msg.id, error: { message: `no ${msg.method}` } }) + '\n',
        );
      }
    });
    return { child, calls };
  };

  it("forks a codex thread through the turn over the app server's JSON-RPC, reading every page of turns", async () => {
    const { child, calls } = fakeServer({
      initialize: () => ({}),
      'thread/turns/list': (p) =>
        p.cursor
          ? { data: [{ id: 'turn-2', items: [{ type: 'agentMessage', text: 'DONE' }] }], nextCursor: null }
          : { data: [{ id: 'turn-1', items: [{ type: 'agentMessage', text: 'OK' }] }], nextCursor: 'page-2' },
      'thread/fork': (p) => ({ thread: { id: `fork-of-${String(p.threadId)}-through-${String(p.lastTurnId)}` } }),
    });
    await expect(codexForkThread(child as never, 'thread-a', 'DONE', 1)).resolves.toBe('fork-of-thread-a-through-turn-2');
    expect(calls.map((c) => c.method)).toEqual(['initialize', 'initialized', 'thread/turns/list', 'thread/turns/list', 'thread/fork']);
  });

  it("rejects with the reason when the thread doesn't have the message, or the server fails", async () => {
    const missing = fakeServer({ initialize: () => ({}), 'thread/turns/list': () => ({ data: [], nextCursor: null }) });
    await expect(codexForkThread(missing.child as never, 'thread-a', 'DONE', 1)).rejects.toThrow("doesn't have this message");
    const failing = fakeServer({ initialize: () => ({}) });
    await expect(codexForkThread(failing.child as never, 'thread-a', 'DONE', 1)).rejects.toThrow('no thread/turns/list');
    const silent = { stdin: new PassThrough(), stdout: new PassThrough(), on: () => undefined };
    await expect(codexForkThread(silent as never, 'thread-a', 'DONE', 1, 50)).rejects.toThrow("didn't answer in time");
  });

  it("keeps claude's message ids on the rows, to fork at", () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(JSON.stringify({ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hi' } }));
    acc.addLine(JSON.stringify({ type: 'assistant', uuid: 'u-2', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }));
    expect(acc.rows.map((r) => r.uuid)).toEqual(['u-1', 'u-2']);
  });
});

describe('attachments', () => {
  it('copies files under the task with a stamp, and prunes them with the run logs', () => {
    const store = new RunStore(tmp());
    const src = path.join(tmp(), 'notes.txt');
    fs.writeFileSync(src, 'hello');
    const a = store.saveAttachment('t1', 'notes.txt', { file: src });
    const b = store.saveAttachment('t1', 'bad:name?.png', { data: Buffer.from('img') });
    expect(fs.readFileSync(a, 'utf8')).toBe('hello');
    expect(RunStore.attachmentName(a)).toBe('notes.txt');
    expect(RunStore.attachmentName(b)).toBe('bad_name_.png');
    expect(path.dirname(a)).toBe(store.attachmentsDir('t1'));
    // An hour from now: both are older than that.
    expect(store.pruneAttachments('t1', Date.now() + 3_600_000)).toBe(2);
    expect(fs.readdirSync(store.attachmentsDir('t1'))).toEqual([]);
  });

  it('keeps attachments newer than the cutoff', () => {
    const store = new RunStore(tmp());
    store.saveAttachment('t1', 'a.png', { data: Buffer.from('x') });
    expect(store.pruneAttachments('t1', Date.now() - 3_600_000)).toBe(0);
  });
});

describe('permission hook (bash)', () => {
  it('hands the request over as a file and prints the answer Looper writes', async () => {
    const dir = tmp();
    const queue = path.join(dir, 'permissions');
    const script = path.join(dir, 'hook');
    fs.writeFileSync(script, new BashTarget({ host: 'linux' }, undefined).renderPermissionHook(queue));
    const child = spawn('bash', [script], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.end('{"tool_name":"Bash","tool_input":{"command":"ls"}}');
    // Looper's side: wait for the request, then answer it.
    let req: string | undefined;
    for (let i = 0; i < 50 && !req; i++) {
      await new Promise((r) => setTimeout(r, 100));
      req = fs.existsSync(queue) ? fs.readdirSync(queue).find((f) => f.endsWith('.req')) : undefined;
    }
    expect(req).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(queue, req!), 'utf8')).tool_name).toBe('Bash');
    fs.writeFileSync(path.join(queue, req!.replace(/\.req$/, '.ans')), permissionAnswer(true, { command: 'ls' }));
    const code = await new Promise((r) => child.on('close', r));
    expect(code).toBe(0);
    expect(JSON.parse(out).hookSpecificOutput.decision.behavior).toBe('allow');
    expect(fs.readdirSync(queue)).toEqual([]);
  });
});
