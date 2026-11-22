import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { codexListSkills, isInterruptedRecord } from '../src/engine/chat';
import { ClaudeStreamAccumulator } from '../src/engine/builder/stream';
import { TranscriptAccumulator, type SubagentMeta } from '../src/engine/messages';
import { backgroundOf, latestLine, recentMessages, SessionHub, subagentsOf, type RunEntry, type TerminalEntry } from '../src/engine/sessions';
import { backgroundStoppedNote } from '../src/engine/claude-mod';
import { Logger } from '../src/engine/log';
import { slashCommandsOf, usageLimitsOf, type ChatState } from '../src/shared/chat';
import type { MessageRow } from '../src/shared/messages';
import { canToggleUnread, isUnread, parseTaskNotification, waitedText, type SlashCommand } from '../src/shared/sessions';
import { TaskSchema, type EngineEvent, type Project, type Task } from '../src/shared/types';
import type { WorkflowLaunch } from '../src/engine/workflows';
import type { WorkflowRun } from '../src/shared/workflows';

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

  it("ends a command Looper's mod stopped from when its note is stored, before the agent reads it, and shows no message for it", () => {
    for (const acc of [new TranscriptAccumulator(), new ClaudeStreamAccumulator()]) {
      const [call, result] = backgroundTranscript('completed');
      acc.addLine(call);
      acc.addLine(result);
      const note = backgroundStoppedNote('b7', 'npm test');
      // As claude 2.1.330 records a plugin's note on an idle session: held until the next request, then sent.
      acc.addLine(line({ type: 'attachment', uuid: 'n1', attachment: { type: 'plugin_note', plugin: 'looper', rowUuid: 'n1', content: [], heldContent: [note] } }));
      expect(acc.rows[0].background).toMatchObject({ status: 'stopped', summary: 'Task "npm test" was stopped by the user' });
      acc.addLine(line({ type: 'attachment', uuid: 'n1', attachment: { type: 'plugin_note', plugin: 'looper', rowUuid: 'n1', content: [note], sentAs: 'beside' } }));
      expect(acc.rows.map((r) => r.kind)).toEqual(['tool']);
      expect(backgroundOf(acc.rows)[0].status).toBe('stopped');
    }
  });

  it('ends a command a headless chat stopped with stop_task from its stream event, which says nothing else about how it ended', () => {
    const acc = new ClaudeStreamAccumulator();
    const [call, result] = backgroundTranscript('completed');
    acc.addLine(call);
    acc.addLine(result);
    // A foreground call's event and a completion leave it as it is: only a stop counts (claude 2.1.330).
    acc.addLine(line({ type: 'system', subtype: 'task_notification', task_id: 'b9', status: 'completed', summary: 'Run 40-second sleep' }));
    acc.addLine(line({ type: 'system', subtype: 'task_notification', task_id: 'b7', status: 'completed', summary: 'Run the tests' }));
    expect(acc.rows[0].background?.status).toBe('running');
    acc.addLine(line({ type: 'system', subtype: 'task_notification', task_id: 'b7', status: 'stopped', summary: 'Run the tests', output_file: '/tmp/claude-1000/p/s/tasks/b7.output' }));
    expect(acc.rows[0].background).toEqual({ id: 'b7', status: 'stopped', outputFile: '/tmp/claude-1000/p/s/tasks/b7.output' });
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

  it("tracks a Workflow call by its task id, and ends it with the workflow's task notification", () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu4', name: 'Workflow', input: { scriptPath: '/s/wf.js' } }] } }));
    acc.addLine(
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu4', content: 'Workflow launched in background. Task ID: wsv0\nSummary: Do it\nTranscript dir: /p/s/subagents/workflows/wf_e8-949' }] },
        toolUseResult: { status: 'async_launched', taskId: 'wsv0', taskType: 'local_workflow', workflowName: 'round', runId: 'wf_e8-949' },
      }),
    );
    expect(acc.rows[0].background).toEqual({ id: 'wsv0', status: 'running' });
    acc.addLine(
      line({
        type: 'user',
        message: { content: '<task-notification>\n<task-id>wsv0</task-id>\n<status>completed</status>\n<summary>Dynamic workflow "Do it" completed</summary>\n<result>{}</result>\n</task-notification>' },
      }),
    );
    expect(acc.rows[0].background).toMatchObject({ status: 'completed', summary: 'Dynamic workflow "Do it" completed' });
    expect(backgroundOf(acc.rows)).toEqual([expect.objectContaining({ id: 'wsv0', kind: 'workflow', label: 'Do it', workflowRunId: 'wf_e8-949', status: 'completed' })]);
  });

  /** A Monitor's events and ends as Claude Code queues them (claude 2.1.325). */
  const monitorNote = (id: string, body: string) =>
    line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: `<task-notification>\n<task-id>${id}</task-id>\n${body}\n</task-notification>` } });

  it('tracks a Monitor by its task id: its events leave it running, and its end or its expiry ends it', () => {
    const acc = new TranscriptAccumulator();
    for (const [id, task] of [['tu5', 'bm1'], ['tu6', 'bm2']]) {
      acc.addLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Monitor', input: { command: 'tail -f log', description: `Watch ${task}`, timeout_ms: 1800000 } }] } }));
      acc.addLine(
        line({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Monitor started (task ${task}, expires in 30m unless the source ends first). You will be notified on each event.` }] },
          toolUseResult: { taskId: task, timeoutMs: 1800000, persistent: false },
        }),
      );
    }
    expect(backgroundOf(acc.rows)).toEqual([
      expect.objectContaining({ id: 'bm2', kind: 'monitor', label: 'Watch bm2', command: 'tail -f log', status: 'running' }),
      expect.objectContaining({ id: 'bm1', kind: 'monitor', label: 'Watch bm1', status: 'running' }),
    ]);
    acc.addLine(monitorNote('bm1', '<summary>Monitor event: "Watch bm1"</summary>\n<event>line 1</event>'));
    expect(acc.rows[0].background?.status).toBe('running');
    acc.addLine(
      monitorNote('bm1', '<tool-use-id>tu5</tool-use-id>\n<output-file>/tmp/claude-1000/p/s/tasks/bm1.output</output-file>\n<status>completed</status>\n<summary>Monitor "Watch bm1" stream ended</summary>\n<event>line 2</event>'),
    );
    expect(acc.rows[0].background).toEqual({ id: 'bm1', status: 'completed', summary: 'Monitor "Watch bm1" stream ended', outputFile: '/tmp/claude-1000/p/s/tasks/bm1.output' });
    acc.addLine(monitorNote('bm2', '<summary>Monitor event: "Watch bm2"</summary>\n<event>[Monitor expired after 30m with no events delivered. Re-arm it if you still need the watch.]</event>'));
    expect(acc.rows[1].background).toEqual({ id: 'bm2', status: 'completed', summary: 'Monitor expired after 30m with no events delivered' });
  });

  it("lists the background work a Code Mode script started, from its REPL row, as the mod hands its calls over and as the transcript copies them", () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'REPL', input: { code: 'await tools.Monitor({…})' } }] } }));
    acc.addLine(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: '(dispatched #1)' }] } }));
    const call = { type: 'tool_use', id: 'repl_m', name: 'Monitor', input: { command: 'node listen.mjs', description: 'Slack replies' } };
    const tur = { taskId: 'bgs', timeoutMs: 1800000, persistent: false };
    acc.addParsed({ type: 'assistant', isVirtual: true, liveScriptCall: true, message: { role: 'assistant', model: '<synthetic>', content: [call] } });
    acc.addParsed({ type: 'user', isVirtual: true, liveScriptCall: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'repl_m', content: '' }] }, toolUseResult: tur });
    expect(acc.rows).toHaveLength(1);
    expect(backgroundOf(acc.rows)).toEqual([expect.objectContaining({ id: 'bgs', kind: 'monitor', label: 'Slack replies', status: 'running' })]);
    acc.addLine(monitorNote('bgs', '<summary>Monitor event: "Slack replies"</summary>\n<event>[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]</event>'));
    // The script ended: the transcript's copies of its call change nothing.
    acc.addLine(line({ type: 'attachment', attachment: { type: 'poll_events', envelopes: ['<event nonce="a" kind="repl-eval" at="2026-11-20T01:00:01.000Z" eval="1" ms="5" status="settled">\n<result>{}</result>\n</event>'] } }));
    acc.addLine(line({ type: 'assistant', isVirtual: true, timestamp: '2026-11-20T01:00:01.004Z', message: { role: 'assistant', model: '<synthetic>', content: [call] } }));
    acc.addLine(line({ type: 'user', isVirtual: true, timestamp: '2026-11-20T01:00:01.004Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'repl_m', content: '' }] }, toolUseResult: tur }));
    expect(backgroundOf(acc.rows)).toEqual([expect.objectContaining({ id: 'bgs', status: 'completed', summary: 'Monitor expired after 30m with 1 event delivered' })]);
  });

  it('reads the status of a task notification', () => {
    expect(parseTaskNotification('<task-id>x</task-id><status>failed</status>')).toEqual({ id: 'x', status: 'failed', summary: undefined });
    expect(parseTaskNotification('<task-id>x</task-id><status>killed</status>')?.status).toBe('stopped');
    expect(parseTaskNotification('no notification')).toBeNull();
    expect(parseTaskNotification('<task-id>x</task-id><summary>Monitor event: "w"</summary><event>tick</event>')).toBeNull();
  });
});

describe('subagents and the latest line', () => {
  const meta = (agentId: string): SubagentMeta => ({
    agentId,
    toolUseId: `tu-${agentId}`,
    type: 'Explore',
    description: `Look at ${agentId}`,
  });
  const row = (r: Partial<MessageRow>): MessageRow => ({ id: String(Math.random()), kind: 'tool', preview: '', text: '', ...r });

  it('is running until its Agent call has a result or its background notification says otherwise', () => {
    const rows = [
      row({ tool: 'Agent', agentId: 'a1', result: 'found it' }),
      row({ tool: 'Agent', agentId: 'a2', result: 'failed', resultError: true }),
      row({ tool: 'Agent', agentId: 'a3', background: { id: 'a3', status: 'completed' } }),
    ];
    expect(subagentsOf([meta('a1'), meta('a2'), meta('a3'), meta('a4')], rows).map((s) => s.status)).toEqual([
      'done',
      'failed',
      'done',
      'running',
    ]);
  });

  it("takes the start from its Agent call and the context window of the model its transcript names", () => {
    const rows = [row({ tool: 'Agent', toolUseId: 'tu-a1', ts: '2026-11-04T10:00:00.000Z' })];
    const stats = new Map([['a1', { model: 'claude-haiku-5-5', tokens: 50_000 }]]);
    const [a] = subagentsOf([meta('a1')], rows, stats, { 'claude-haiku-5-5': 200_000 });
    expect(a).toMatchObject({ status: 'running', startedAt: '2026-11-04T10:00:00.000Z', contextTokens: 50_000, contextWindow: 200_000 });
    expect(subagentsOf([meta('a1')], rows, stats)[0].contextWindow).toBeUndefined();
  });

  it("previews the agent's last text message since the user's, never a tool call", () => {
    const rows = [
      row({ kind: 'prompt', text: 'Fix it' }),
      row({ kind: 'agent', text: '**Looking** at it\nmore' }),
      row({ tool: 'Bash', preview: 'npm test', result: 'ok' }),
    ];
    expect(latestLine(rows)).toBe('Looking at it');
    expect(latestLine([row({ kind: 'agent', text: 'Old reply' }), row({ kind: 'prompt', text: 'Fix it' }), row({ tool: 'Read', preview: 'a.ts' })])).toBeUndefined();
    expect(latestLine([row({ kind: 'prompt', text: 'Fix it' })])).toBeUndefined();
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
  const project = (id: string, name: string, cwd = '/w'): Project => ({ id, name, cwd }) as Project;
  const chat = (over: Partial<ChatState>): ChatState => ({
    id: 'c1',
    taskId: 't1',
    taskName: 't1',
    environmentId: 'e',
    harnessId: 'claude',
    harnessName: 'Claude Code',
    harnessKind: 'claude-code',
    harnesses: [{ id: 'claude', name: 'Claude Code', kind: 'claude-code' }],
    harnessLocked: false,
    settings: { permissionMode: '' },
    autoCompactDefault: { enabled: false, percent: 90 },
    models: [],
    status: 'ready',
    history: [],
    rows: [{ id: '0', kind: 'prompt', text: 'Fix the footer', preview: '' }],
    permissions: [],
    queued: [],
    commands: [],
    commandPrefix: '/',
    runningCommands: 0,
    startedAt: 1000,
    autoContinue: false,
    ...over,
  });

  function hub(opts: {
    chats?: ChatState[];
    terminals?: TerminalEntry[];
    runs?: RunEntry[];
    dir?: string;
    now?: () => number;
    rows?: MessageRow[];
    /** A task run's guidance its agent hasn't picked up yet, as its transcript is read. */
    guidance?: () => string | undefined;
    commands?: SlashCommand[];
    cache?: { at?: number; ttlMs?: number };
    workflows?: (opts: { launches?: WorkflowLaunch[]; detail?: boolean; sessionEnded?: boolean }) => WorkflowRun[];
  }) {
    const events: EngineEvent[] = [];
    const h = new SessionHub({
      chats: () => opts.chats ?? [],
      terminals: () => opts.terminals ?? [],
      runs: () => opts.runs ?? [],
      findTask: (id) => task(id, 'p1'),
      projects: () => [project('p1', 'Website'), project('p2', 'Site', '/site/')],
      harnessOf: (t) =>
        t.agent.harnessId === 'codex' ? { kind: 'codex', name: 'Codex', limitsKey: 'e/codex' } : { kind: 'claude-code', name: 'Claude Code', limitsKey: 'e/claude' },
      runDir: () => opts.dir ?? '/nowhere',
      readRows: async () => ({ status: 'ok', rows: opts.rows ?? [], pendingGuidance: opts.guidance?.(), commands: opts.commands }),
      subagents: async () => [],
      subagentStats: async () => null,
      workflows: async (_taskId, _runId, o) => opts.workflows?.(o) ?? [],
      contextTokens: async () => null,
      cacheUse: async () => opts.cache ?? {},
      terminalTitle: () => undefined,
      emit: (e) => events.push(e),
      log: new Logger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'looper-hub-')), 'log')),
      now: opts.now,
    });
    return { h, events };
  }

  it('shows a chat out of its usage limit until the reset, then restored until the user looks', () => {
    let now = 5000;
    const c = chat({ turnEndedAt: 4000, limit: { at: 4000, resetsAt: 10_000 }, title: 'My name' });
    const { h } = hub({ chats: [c], now: () => now });
    expect(h.state().sessions[0]).toMatchObject({ title: 'My name', limit: { resetsAt: 10_000 } });
    expect(h.state().sessions[0].limit?.restored).toBeUndefined();
    now = 10_000;
    expect(h.state().sessions[0].limit).toEqual({ resetsAt: 10_000, restored: true });
    h.seen('c1');
    expect(h.state().sessions[0].limit).toBeUndefined();
  });

  it("keeps Group Chats By None's dragged order while it runs, a closed chat's id dropping out", () => {
    const chats = [chat({ id: 'c1' }), chat({ id: 'c2', startedAt: 2000 })];
    const { h } = hub({ chats });
    expect(h.state().order).toEqual([]);
    h.reorder(['c2', 'c1', 'c2']);
    expect(h.state().order).toEqual(['c2', 'c1']);
    chats.pop();
    expect(h.state().order).toEqual(['c1']);
  });

  it('keeps a chat with no reset time out of its limit until its next message', () => {
    const { h } = hub({ chats: [chat({ limit: { at: 4000 } })], now: () => 99_999_999 });
    expect(h.state().sessions[0].limit).toEqual({});
  });

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

  it('shows a chat the user marked unread as a finished turn again, until they open it', () => {
    let now = 5000;
    const { h } = hub({ chats: [chat({ turnEndedAt: 4000 })], now: () => now });
    expect(h.state().sessions[0].waiting).toMatchObject({ reason: 'turn' });
    h.seen('c1');
    expect(h.state().sessions[0].waiting).toBeUndefined();
    now = 6000;
    h.markUnread('c1');
    expect(h.state().sessions[0].waiting).toMatchObject({ reason: 'turn', since: 6000, unread: true });
    // A second look in the same millisecond or a later one clears it, and a later mark brings it back.
    now = 7000;
    h.seen('c1');
    expect(h.state().sessions[0].waiting).toBeUndefined();
    now = 8000;
    h.markUnread('c1');
    expect(h.state().sessions[0].waiting).toMatchObject({ unread: true });
  });

  it('decides from the summary whether Mark as Unread or Mark as Read applies', () => {
    let now = 5000;
    const read = hub({ chats: [chat({ turnEndedAt: 4000, status: 'ready' })], now: () => now });
    // A finished turn nobody has looked at is unread: Mark as Read applies, and it marks it seen.
    let [s] = read.h.state().sessions;
    expect([isUnread(s), canToggleUnread(s)]).toEqual([true, true]);
    read.h.seen('c1');
    // Read and ready: Mark as Unread applies, and brings it back as "Marked as unread".
    now = 6000;
    [s] = read.h.state().sessions;
    expect([isUnread(s), canToggleUnread(s)]).toEqual([false, true]);
    read.h.markUnread('c1');
    [s] = read.h.state().sessions;
    expect([isUnread(s), canToggleUnread(s), s.waiting?.text]).toEqual([true, true, 'Marked as unread']);
    // Working: its next turn is news anyway, so it can't be marked; a permission request is bold on its own.
    const working = hub({ chats: [chat({ status: 'working' })], now: () => now }).h.state().sessions[0];
    expect([isUnread(working), canToggleUnread(working)]).toEqual([false, false]);
    const asking = hub({ chats: [chat({ status: 'working', permissions: [{ id: 'r1', tool: 'Bash', input: {} }] })], now: () => now }).h.state().sessions[0];
    expect([asking.waiting?.reason, isUnread(asking), canToggleUnread(asking)]).toEqual(['permission', false, false]);
    // A chat that ended unseen is unread (it can be marked read); one that ended and was seen can't be marked unread.
    const ended = hub({ chats: [chat({ status: 'ended' })], now: () => now });
    [s] = ended.h.state().sessions;
    expect([isUnread(s), canToggleUnread(s)]).toEqual([true, true]);
    now = 7000;
    ended.h.seen('c1');
    [s] = ended.h.state().sessions;
    expect([isUnread(s), canToggleUnread(s)]).toEqual([false, false]);
    // A task run's agent has no Mark as Unread.
    expect(canToggleUnread({ ...s, kind: 'run', status: 'ready' })).toBe(false);
    expect(canToggleUnread(undefined)).toBe(false);
  });

  it('marks a chat whose turn ended on an API error as failed with its text, until the user looks', () => {
    let now = 9000;
    const limit = "You've hit your 5-hour limit · resets 12:10am (America/Vancouver)";
    const c = chat({
      turnEndedAt: 4000,
      rows: [
        { id: '0', kind: 'prompt', text: 'Fix the footer', preview: '' },
        { id: '1', kind: 'error', text: limit, preview: '', ts: new Date(5000).toISOString() },
      ],
    });
    const { h } = hub({ chats: [c], now: () => now });
    expect(h.state().sessions[0]).toMatchObject({ status: 'ready', latest: limit, waiting: { reason: 'error', text: limit, since: 5000 } });
    now = 10_000;
    h.seen('c1');
    const seen = h.state().sessions[0];
    expect(seen.waiting).toBeUndefined();
    expect(seen.latest).toBe(limit);
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

  it('sends the activity of every session a Sessions window shows, on any device', async () => {
    const { h, events } = hub({ chats: [chat({ id: 'c1' }), chat({ id: 'c2' })] });
    h.watch(['c1', 'c2']);
    await new Promise((r) => setTimeout(r, 0));
    const shown = () => events.flatMap((e) => (e.type === 'session:activity' ? [e.activity.id] : []));
    expect(new Set(shown())).toEqual(new Set(['c1', 'c2']));
    events.length = 0;
    h.watch(['c2']);
    await (h as unknown as { poll: () => Promise<void> }).poll();
    expect(shown()).not.toContain('c1');
  });

  it("gives a session on screen its workflow runs, from the Workflow calls in its conversation", async () => {
    const rows: MessageRow[] = [
      {
        id: '0',
        kind: 'tool',
        tool: 'Workflow',
        preview: '',
        text: '',
        result: 'Workflow launched in background. Task ID: w1\nSummary: Do the round\nTranscript dir: /c/s/subagents/workflows/wf_1-a',
        background: { id: 'w1', status: 'running' },
      },
    ];
    const run: WorkflowRun = { runId: 'wf_1-a', name: 'round', status: 'running', phases: [], logs: [] };
    const asked: { launches?: WorkflowLaunch[]; sessionEnded?: boolean }[] = [];
    const { h } = hub({ chats: [chat({ id: 'c1', status: 'ended' })], rows, workflows: (o) => (asked.push(o), [run]) });
    await (h as unknown as { readSession: (id: string, force: boolean) => Promise<void> }).readSession('c1', true);
    expect(h.activity('c1')?.workflows).toEqual([run]);
    expect(asked[0]).toMatchObject({ launches: [{ runId: 'wf_1-a', taskId: 'w1', status: 'running' }], sessionEnded: true });
    expect(h.activity('c1')?.background).toEqual([{ id: 'w1', kind: 'workflow', label: 'Do the round', workflowRunId: 'wf_1-a', status: 'running' }]);
  });

  it("gives a session's last reply and until when its prompt cache lasts", async () => {
    const { h } = hub({ chats: [chat({ turnEndedAt: 4000 })], cache: { at: 3000, ttlMs: 300_000 } });
    expect(h.state().sessions[0]).toMatchObject({ lastReplyAt: 4000 });
    await (h as unknown as { readSession: (id: string, force: boolean) => Promise<void> }).readSession('c1', true);
    expect(h.state().sessions[0]).toMatchObject({ lastReplyAt: 3000, cacheUntil: 303_000 });
  });

  it("lists a task run's agent under its project, with its conversation as the activity, waiting while it holds", async () => {
    const run: RunEntry = { id: 'r9', taskId: 't1', startedAt: 1000, held: false, question: null };
    const rows: MessageRow[] = [
      { id: '0', kind: 'prompt', text: 'Do the task', preview: '' },
      { id: '1', kind: 'agent', text: 'Checking the logs', preview: '' },
      { id: '2', kind: 'tool', tool: 'Bash', text: '', preview: 'tail log' },
    ];
    const { h } = hub({ runs: [run], rows, now: () => 5000 });
    await (h as unknown as { readSession: (id: string, force: boolean) => Promise<void> }).readSession('r9', true);
    expect(h.state().sessions[0]).toMatchObject({ kind: 'run', title: 't1', groupName: 'Website', status: 'working', latest: 'Checking the logs' });
    expect(h.runTask('r9')).toBe('t1');
    expect(h.activity('r9')?.rows).toHaveLength(3);
    run.question = 'Which branch?';
    expect(h.state().sessions[0]).toMatchObject({ status: 'ready', waiting: { reason: 'notification', text: 'Waiting for your answer', since: 5000 } });
    // Its turn over (Stop in its message box, or at its prompt): ready for the next guidance, nobody waited on.
    run.question = null;
    run.turnOver = true;
    expect(h.state().sessions[0].status).toBe('ready');
    expect(h.state().sessions[0].waiting).toBeUndefined();
  });

  it('gives a session’s skills on their own, without the rest of its activity (a terminal card’s message box)', async () => {
    const commands: SlashCommand[] = [{ name: 'review', description: 'Review the diff.' }];
    const run: RunEntry = { id: 'r9', taskId: 't1', startedAt: 1000, held: false, question: null };
    const { h } = hub({ runs: [run], commands });
    expect(h.commands('r9')).toEqual([]);
    await (h as unknown as { readSession: (id: string, force: boolean) => Promise<void> }).readSession('r9', true);
    expect(h.commands('r9')).toEqual(commands);
  });

  it("gives a task run's message box its skills and its agent's harness and settings, a delegated agent's own", async () => {
    const commands: SlashCommand[] = [{ name: 'review', description: 'Review the diff.' }];
    const t1 = task('t1', 'p1');
    const run: RunEntry = { id: 'r9', taskId: 't1', startedAt: 1000, held: false, question: null };
    const { h } = hub({ runs: [run], commands });
    await (h as unknown as { readSession: (id: string, force: boolean) => Promise<void> }).readSession('r9', true);
    expect(h.activity('r9')).toMatchObject({
      commands,
      agent: { harnessName: 'Claude Code', harnessKind: 'claude-code', commandPrefix: '/', settings: { permissionMode: t1.agent.permissionMode ?? '' } },
    });
    const own = { ...t1, agent: { ...t1.agent, harnessId: 'codex', model: 'gpt-5.5', effort: 'high', permissionMode: 'auto' } } as Task;
    run.delegate = { title: 'Fix the form', task: own };
    expect(h.activity('r9')?.agent).toMatchObject({
      harnessName: 'Codex',
      harnessKind: 'codex',
      commandPrefix: '$',
      settings: { model: 'gpt-5.5', effort: 'high', permissionMode: 'auto' },
    });
  });

  it("lists a delegated agent's run by its title, on its own harness, under the project or folder it works in, and its parent's questions aren't the user's", async () => {
    const own = { ...task('t1', 'p1'), cwd: '/site', agent: { ...task('t1', 'p1').agent, harnessId: 'codex' } } as Task;
    const run: RunEntry = { id: 'r7', taskId: 't1', startedAt: 1000, held: false, question: null, delegate: { title: 'Fix the form', task: own } };
    const { h } = hub({ runs: [run], now: () => 5000 });
    expect(h.state().sessions[0]).toMatchObject({
      kind: 'run',
      title: 'Fix the form',
      startedBy: 't1',
      projectId: 'p2',
      groupName: 'Site',
      harnessName: 'Codex',
      limitsKey: 'e/codex',
      status: 'working',
    });
    expect(h.runTask('r7')).toBe('t1');
    run.question = 'Which branch?';
    expect(h.state().sessions[0]).toMatchObject({ status: 'working', question: 'Which branch?' });
    expect(h.state().sessions[0].waiting).toBeUndefined();
    run.held = true;
    expect(h.state().sessions[0]).toMatchObject({ status: 'ready', waiting: { reason: 'notification', text: 'Waiting for you' } });
    // A folder that's no project's: under the folder, as a chat opened there with Other Folder… is.
    run.delegate = { title: 'Fix the form', task: { ...own, cwd: '/elsewhere' } };
    const elsewhere = h.state().sessions[0];
    expect(elsewhere.groupName).toBe('/elsewhere');
    expect(elsewhere.projectId).toBeUndefined();
  });

  it("sends a watched task run's conversation as its activity, kept current while it runs (a dashboard card's)", async () => {
    const run: RunEntry = { id: 'r9', taskId: 't1', startedAt: 1000, held: false, question: null };
    const rows: MessageRow[] = [{ id: '0', kind: 'prompt', text: 'Do the task', preview: '' }];
    let guidance: string | undefined;
    const { h, events } = hub({ runs: [run], rows, guidance: () => guidance });
    const sent = () => events.flatMap((e) => (e.type === 'session:activity' && e.activity.id === 'r9' ? [e.activity.rows?.map((r) => r.id)] : []));
    const poll = () => (h as unknown as { poll: () => Promise<void> }).poll();
    h.watch(['r9']);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent()).toEqual([['0']]);
    rows.push({ id: '1', kind: 'agent', text: 'Checking the logs', preview: '' });
    await poll();
    await poll();
    expect(sent()).toEqual([['0'], ['0', '1']]);
    // Guidance sent from the card shows at the end while the agent hasn't picked it up, though no row came.
    guidance = 'Also list the closed duplicates';
    await poll();
    await poll();
    expect(events.filter((e) => e.type === 'session:activity').at(-1)).toMatchObject({ activity: { pendingGuidance: 'Also list the closed duplicates' } });
    expect(sent()).toHaveLength(3);
    // Out of view, it isn't sent any more.
    h.watch([]);
    rows.push({ id: '2', kind: 'agent', text: 'Done', preview: '' });
    await poll();
    await poll();
    expect(sent()).toHaveLength(3);
  });

  it('records the usage limits Claude reports for each harness apart, and tells each session its harness', () => {
    const terminal: TerminalEntry = { id: 'x1', taskId: 't1', startedAt: 1000, ended: false };
    const { h } = hub({ chats: [chat({ environmentId: 'w', harnessId: 'work' })], terminals: [terminal] });
    h.setLimits('w/work', { fiveHour: { used: 0.2, resetsAt: 1 } });
    h.setLimits('w/work', { sevenDay: { used: 0.5, resetsAt: 2 } });
    h.setLimits('e/claude', { sevenDay: { used: 0.9, resetsAt: 3 } });
    expect(h.state().limits).toEqual({
      'w/work': { fiveHour: { used: 0.2, resetsAt: 1 }, sevenDay: { used: 0.5, resetsAt: 2 } },
      'e/claude': { sevenDay: { used: 0.9, resetsAt: 3 } },
    });
    expect(Object.fromEntries(h.state().sessions.map((s) => [s.id, s.limitsKey]))).toEqual({ c1: 'w/work', x1: 'e/claude' });
  });
});
