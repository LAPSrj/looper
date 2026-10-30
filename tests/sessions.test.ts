import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { codexListSkills, isInterruptedRecord } from '../src/engine/chat';
import { ClaudeStreamAccumulator } from '../src/engine/builder/stream';
import { TranscriptAccumulator, type SubagentMeta } from '../src/engine/messages';
import { backgroundOf, latestLine, recentMessages, SessionHub, subagentsOf, type TerminalEntry } from '../src/engine/sessions';
import { Logger } from '../src/engine/log';
import { slashCommandsOf, usageLimitsOf, type ChatState } from '../src/shared/chat';
import type { MessageRow } from '../src/shared/messages';
import { parseTaskNotification, waitedText } from '../src/shared/sessions';
import { TaskSchema, type EngineEvent, type Project, type Task } from '../src/shared/types';

const line = (rec: unknown) => JSON.stringify(rec);

/** A background Bash call and its result as Claude records them, then its task notification. */
function backgroundTranscript(status: string): string[] {
  return [
    line({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests', run_in_background: true } }] },
    }),
    line({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: 'Command running in background with ID: b7. Output is being written to: /tmp/claude-1000/p/s/tasks/b7.output. You will be notified when it completes.',
          },
        ],
      },
      toolUseResult: { stdout: '', stderr: '', backgroundTaskId: 'b7' },
    }),
    line({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        prompt: `<task-notification>\n<task-id>b7</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>${status}</status>\n<summary>Background command "Run the tests" completed (exit code 0)</summary>\n</task-notification>`,
      },
    }),
  ];
}

describe('background work in a transcript', () => {
  it('marks a background command with its output file, and ends it with its task notification', () => {
    const acc = new TranscriptAccumulator();
    const [call, result, notification] = backgroundTranscript('completed');
    acc.addLine(call);
    acc.addLine(result);
    expect(acc.rows[0].background).toEqual({ id: 'b7', status: 'running', outputFile: '/tmp/claude-1000/p/s/tasks/b7.output' });
    expect(backgroundOf(acc.rows)).toEqual([
      expect.objectContaining({ id: 'b7', kind: 'command', label: 'Run the tests', command: 'npm test', status: 'running' }),
    ]);
    acc.addLine(notification);
    expect(acc.rows[0].background).toMatchObject({ status: 'completed', summary: 'Background command "Run the tests" completed (exit code 0)' });
  });

  it('marks a subagent launched in the background by its agent id', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { description: 'Audit docs', prompt: 'x' } }] } }));
    acc.addLine(
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'Launched.' }] },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a9', description: 'Audit docs' },
      }),
    );
    expect(acc.rows[0]).toMatchObject({ agentId: 'a9', background: { id: 'a9', status: 'running' } });
    expect(backgroundOf(acc.rows)[0]).toMatchObject({ kind: 'agent', label: 'Audit docs' });
  });

  it('ends a background subagent with the user message -p mode records, which is no prompt of the user', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu3', name: 'Agent', input: { description: 'List files', prompt: 'x' } }] } }));
    acc.addLine(
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu3', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a5', outputFile: '/tmp/t/a5.output' },
      }),
    );
    acc.addLine(
      line({
        type: 'user',
        message: { content: '<task-notification>\n<task-id>a5</task-id>\n<status>completed</status>\n<summary>Agent "List files" completed</summary>\n</task-notification>' },
      }),
    );
    expect(acc.rows).toHaveLength(1);
    expect(acc.rows[0].background).toEqual({ id: 'a5', status: 'completed', summary: 'Agent "List files" completed', outputFile: '/tmp/t/a5.output' });
  });

  it('reads the status of a task notification', () => {
    expect(parseTaskNotification('<task-id>x</task-id><status>failed</status>')).toEqual({ id: 'x', status: 'failed', summary: undefined });
    expect(parseTaskNotification('<task-id>x</task-id><status>killed</status>')?.status).toBe('stopped');
    expect(parseTaskNotification('no notification')).toBeNull();
  });
});

describe('subagents and the latest line', () => {
  const meta = (agentId: string, background = false): SubagentMeta => ({
    agentId,
    toolUseId: `tu-${agentId}`,
    type: 'Explore',
    description: `Look at ${agentId}`,
    background,
  });
  const row = (r: Partial<MessageRow>): MessageRow => ({ id: String(Math.random()), kind: 'tool', preview: '', text: '', ...r });

  it('is running until its Agent call has a result or its background notification says otherwise', () => {
    const rows = [
      row({ tool: 'Agent', agentId: 'a1', result: 'found it' }),
      row({ tool: 'Agent', agentId: 'a2', result: 'failed', resultError: true }),
      row({ tool: 'Agent', agentId: 'a3', background: { id: 'a3', status: 'completed' } }),
    ];
    expect(subagentsOf([meta('a1'), meta('a2'), meta('a3', true), meta('a4')], rows).map((s) => s.status)).toEqual([
      'done',
      'failed',
      'done',
      'running',
    ]);
  });

  it("names the tool while the agent works, and its last message once it's done", () => {
    const rows = [
      row({ kind: 'prompt', text: 'Fix it' }),
      row({ kind: 'agent', text: '**Looking** at it\nmore' }),
      row({ tool: 'Bash', preview: 'npm test' }),
    ];
    expect(latestLine(rows, true)).toBe('Bash npm test');
    expect(latestLine(rows, false)).toBe('Looking at it');
    expect(latestLine([row({ kind: 'prompt', text: 'Fix it' })], false)).toBeUndefined();
  });

  it('says how long something waited', () => {
    expect(waitedText(20_000)).toBe('now');
    expect(waitedText(5 * 60_000)).toBe('5 min');
    expect(waitedText(65 * 60_000)).toBe('1 h 5 min');
  });
});

describe("Claude's stream", () => {
  it('reads the usage limits from a rate limit event', () => {
    const limits = usageLimitsOf({
      type: 'rate_limit_event',
      rate_limit_info: {
        unifiedWindows: { five_hour: { utilization: 0.14, resetsAt: 1793322000 }, seven_day: { utilization: 0.3, resetsAt: 1793703600 } },
      },
    });
    expect(limits).toEqual({ fiveHour: { used: 0.14, resetsAt: 1793322000_000 }, sevenDay: { used: 0.3, resetsAt: 1793703600_000 } });
    expect(usageLimitsOf({ type: 'rate_limit_event', rate_limit_info: {} })).toBeNull();
  });

  it("lists the commands Claude names, with their descriptions and argument hints", () => {
    expect(
      slashCommandsOf([
        { name: 'review', description: 'Review the diff', argumentHint: '[pr]' },
        { name: 'clear', description: '' },
        { description: 'no name' },
      ]),
    ).toEqual([{ name: 'review', description: 'Review the diff', argumentHint: '[pr]' }, { name: 'clear', description: '' }]);
  });

  it("gives a dashboard card the agent's messages since the user's last one, as plain text, cut from the oldest", () => {
    const row = (kind: MessageRow['kind'], text: string, i: number): MessageRow => ({ id: String(i), kind, text, preview: '' });
    const rows = [row('prompt', 'Old ask', 0), row('agent', 'Old reply', 1), row('prompt', 'Fix the footer', 2), row('agent', 'I read **footer.css**.', 3), row('tool', '', 4), row('agent', 'Done.', 5)];
    expect(recentMessages(rows)).toEqual(['I read footer.css.', 'Done.']);
    expect(recentMessages([...rows, row('prompt', 'Next', 6)])).toEqual([]);
    const long = recentMessages([row('prompt', 'Go', 0), row('agent', 'a'.repeat(3000), 1), row('agent', 'b'.repeat(3000), 2)]);
    expect(long).toEqual([`…${'a'.repeat(1000)}`, 'b'.repeat(3000)]);
  });

  it('knows the record Claude adds when a turn is interrupted', () => {
    expect(isInterruptedRecord({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })).toBe(true);
    // Stopped while a tool call ran (Claude Code 2.1).
    expect(isInterruptedRecord({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })).toBe(true);
    expect(isInterruptedRecord({ type: 'user', message: { content: 'Fix it' } })).toBe(false);
  });

  it("keeps a subagent's messages out of the chat's conversation", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.addLine(line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Main' }] } }));
    acc.addLine(line({ type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'text', text: 'Sub' }] } }));
    expect(acc.rows.map((r) => r.text)).toEqual(['Main']);
  });
});

describe("Codex's skills", () => {
  it("lists the enabled skills from the app server's skills/list", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout });
    const methods: string[] = [];
    let buf = '';
    stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, nl)) as { id?: number; method: string };
        buf = buf.slice(nl + 1);
        methods.push(msg.method);
        if (msg.id === undefined) continue;
        const result =
          msg.method === 'skills/list'
            ? {
                data: [
                  {
                    cwd: '/w',
                    skills: [
                      { name: 'imagegen', description: 'Make images', enabled: true },
                      { name: 'old', description: 'Off', enabled: false },
                    ],
                  },
                ],
              }
            : {};
        stdout.write(JSON.stringify({ id: msg.id, result }) + '\n');
      }
    });
    await expect(codexListSkills(child as never, '/w')).resolves.toEqual([{ name: 'imagegen', description: 'Make images' }]);
    expect(methods).toEqual(['initialize', 'initialized', 'skills/list']);
  });
});

describe('the session hub', () => {
  const task = (id: string, projectId: string): Task =>
    ({ ...TaskSchema.parse({ id, name: id, environmentId: 'e', cwd: '/w', trigger: { mode: 'manual' }, agent: { prompt: 'x' } }), projectId }) as Task;
  const project = (id: string, name: string): Project => ({ id, name }) as Project;
  const chat = (over: Partial<ChatState>): ChatState => ({
    id: 'c1',
    taskId: 't1',
    taskName: 't1',
    harnessName: 'Claude Code',
    harnessKind: 'claude-code',
    settings: { permissionMode: '' },
    models: [],
    status: 'ready',
    history: [],
    rows: [{ id: '0', kind: 'prompt', text: 'Fix the footer', preview: '' }],
    permissions: [],
    queued: [],
    commands: [],
    commandPrefix: '/',
    startedAt: 1000,
    ...over,
  });

  function hub(opts: {
    chats?: ChatState[];
    terminals?: TerminalEntry[];
    dir?: string;
    now?: () => number;
    rows?: MessageRow[];
    cache?: { at?: number; ttlMs?: number };
  }) {
    const events: EngineEvent[] = [];
    const h = new SessionHub({
      chats: () => opts.chats ?? [],
      terminals: () => opts.terminals ?? [],
      findTask: (id) => task(id, 'p1'),
      projects: () => [project('p1', 'Website')],
      harnessOf: () => ({ kind: 'claude-code', name: 'Claude Code' }),
      runDir: () => opts.dir ?? '/nowhere',
      readRows: async () => ({ status: 'ok', rows: opts.rows ?? [], dropped: 0 }),
      subagents: async () => [],
      subagentStats: async () => null,
      contextTokens: async () => null,
      cacheUse: async () => opts.cache ?? {},
      terminalTitle: () => undefined,
      emit: (e) => events.push(e),
      log: new Logger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'looper-hub-')), 'log')),
      now: opts.now,
    });
    return { h, events };
  }

  it('groups a chat under its project and waits for the user once a turn ends, until they look', () => {
    let now = 5000;
    const c = chat({ turnEndedAt: 4000 });
    const { h } = hub({ chats: [c], now: () => now });
    const [s] = h.state().sessions;
    expect(s).toMatchObject({ groupName: 'Website', projectId: 'p1', title: 'Fix the footer', waiting: { reason: 'turn', since: 4000 } });
    now = 6000;
    h.seen('c1');
    expect(h.state().sessions[0].waiting).toBeUndefined();
  });

  it("waits on a chat's permission request until it's answered", () => {
    const { h } = hub({ chats: [chat({ status: 'working', permissions: [{ id: 'r1', tool: 'Bash', input: {} }] })] });
    expect(h.state().sessions[0]).toMatchObject({ waiting: { reason: 'permission', text: 'Wants to run a command' }, permissionId: 'r1' });
  });

  it("reads a terminal session's turns and notifications from its hook files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-hub-run-'));
    const write = (name: string, payload: unknown, at: number) => {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(payload));
      fs.utimesSync(path.join(dir, name), at / 1000, at / 1000);
    };
    const t0 = Date.now() - 60_000;
    const { h } = hub({ terminals: [{ id: 'r1', taskId: 't1', startedAt: t0, ended: false }], dir, pollMs: 0 } as never);
    write('prompt.json', { prompt: 'Fix it' }, t0 + 1000);
    await (h as unknown as { poll: () => Promise<void> }).poll();
    expect(h.state().sessions[0]).toMatchObject({ kind: 'terminal', status: 'working' });
    expect(h.state().sessions[0].waiting).toBeUndefined();
    write('notification.json', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, t0 + 2000);
    await (h as unknown as { poll: () => Promise<void> }).poll();
    expect(h.state().sessions[0].waiting).toMatchObject({ reason: 'permission', text: 'Claude needs your permission to use Bash' });
    write('stop.json', { last_assistant_message: 'All tests pass.' }, t0 + 3000);
    await (h as unknown as { poll: () => Promise<void> }).poll();
    expect(h.state().sessions[0]).toMatchObject({ status: 'ready', latest: 'All tests pass.', waiting: { reason: 'turn' } });
    write('notification.json', { notification_type: 'push_notification', message: 'Deploy finished' }, t0 + 4000);
    await (h as unknown as { poll: () => Promise<void> }).poll();
    expect(h.state().sessions[0].waiting).toMatchObject({ reason: 'notification', text: 'Deploy finished' });
  });

  it("ends a terminal session's turn when Stop sent Esc, or the user interrupted it in the terminal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-hub-run-'));
    const t0 = Date.now() - 60_000;
    fs.writeFileSync(path.join(dir, 'prompt.json'), '{}');
    fs.utimesSync(path.join(dir, 'prompt.json'), (t0 + 1000) / 1000, (t0 + 1000) / 1000);
    const poll = (h: SessionHub) => (h as unknown as { poll: () => Promise<void> }).poll();
    const terminals = [{ id: 'r1', taskId: 't1', startedAt: t0, ended: false }];

    const stopped = hub({ terminals, dir }).h;
    await poll(stopped);
    expect(stopped.state().sessions[0].status).toBe('working');
    stopped.stopped('r1');
    expect(stopped.state().sessions[0].status).toBe('ready');

    const rows: MessageRow[] = [{ id: '0', kind: 'prompt', text: '[Request interrupted by user]', preview: '', ts: new Date(t0 + 2000).toISOString() }];
    const interrupted = hub({ terminals, dir, rows }).h;
    await (interrupted as unknown as { readSession: (id: string, force: boolean) => Promise<void> }).readSession('r1', true);
    await poll(interrupted);
    expect(interrupted.state().sessions[0].status).toBe('ready');
  });

  it("gives a session's last reply and until when its prompt cache lasts", async () => {
    const { h } = hub({ chats: [chat({ turnEndedAt: 4000 })], cache: { at: 3000, ttlMs: 300_000 } });
    expect(h.state().sessions[0]).toMatchObject({ lastReplyAt: 4000 });
    await (h as unknown as { readSession: (id: string, force: boolean) => Promise<void> }).readSession('c1', true);
    expect(h.state().sessions[0]).toMatchObject({ lastReplyAt: 3000, cacheUntil: 303_000 });
  });

  it('records the usage limits Claude reports', () => {
    const { h } = hub({});
    h.setLimits({ fiveHour: { used: 0.2, resetsAt: 1 } });
    h.setLimits({ sevenDay: { used: 0.5, resetsAt: 2 } });
    expect(h.state().limits).toEqual({ fiveHour: { used: 0.2, resetsAt: 1 }, sevenDay: { used: 0.5, resetsAt: 2 } });
  });
});
