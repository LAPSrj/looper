import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptAccumulator } from '../src/engine/messages';
import {
  LineTail,
  SessionWorkflows,
  parseFinalState,
  parseJournalLine,
  parseScriptMeta,
  workflowAgentTranscript,
  workflowLaunchesOf,
} from '../src/engine/workflows';
import { elapsedMs, openWorkflow, tabStatus, workflowAgents, workflowCounts, workflowPhaseStatus, type WorkflowRun } from '../src/shared/workflows';

// Fixtures are trimmed copies of a live run's files (claude 2.1.314, run wf_e83e0899-949, 2026-10-30).

const line = (rec: unknown) => JSON.stringify(rec);
const RUN = 'wf_e83e0899-949';

/** The script's head as Claude Code saved it; the briefs after meta are cut. */
const SCRIPT = `export const meta = {
  name: 'looper-round-3',
  description: 'Implement the 41 open Round 3 items from 21.txt in Looper across 9 lanes, then integrate and verify',
  phases: [
    { title: 'Wave 1', detail: 'menus and power, Remote Control, web dialogs, Now tab, Chats window' },
    { title: 'Wave 2', detail: 'Remote Access core, pairing UI, main window lists, window placement' },
    { title: 'Integrate', detail: 'typecheck, tests, build, per-item check' },
  ],
}

const COMMON = \`You are one of several agents implementing Leandro's "Round 3" list for Looper, the Windows-first Electron + React app in /home/leandro/repos/looper (CLAUDE.md files are already loaded for you).\`

phase('Wave 1')
`;

const JOURNAL = [
  '{"type":"launched"}',
  '{"type":"started","key":"v2:d8a9","agentId":"a9a1cc7bb1018ff6b","label":"menus and power","phase":"Wave 1"}',
  '{"type":"started","key":"v2:af0f","agentId":"a01cfbb19d3fd7c60","label":"Remote Control","phase":"Wave 1"}',
  '{"type":"started","key":"v2:7466","agentId":"ab89de4b745de9463","label":"web dialogs","phase":"Wave 1"}',
];

const META: Record<string, unknown> = {
  a9a1cc7bb1018ff6b: { agentType: 'workflow-subagent', isBuiltIn: true, description: 'menus and power', workflowPhase: 'Wave 1', spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true, model: 'opus' },
  a01cfbb19d3fd7c60: { agentType: 'workflow-subagent', isBuiltIn: true, description: 'Remote Control', workflowPhase: 'Wave 1', spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true, model: 'opus' },
  ab89de4b745de9463: { agentType: 'workflow-subagent', isBuiltIn: true, description: 'web dialogs', workflowPhase: 'Wave 1', spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true, model: 'opus' },
};

const prompt = (agentId: string) =>
  line({ type: 'user', isSidechain: true, agentId, timestamp: '2026-10-31T00:52:50.950Z', message: { role: 'user', content: '[Workflow harness — computed task] You are one of several agents…' } });

const toolUse = (agentId: string, name: string, input: unknown, ts: string, cacheRead = 37559) =>
  line({
    type: 'assistant',
    isSidechain: true,
    agentId,
    effort: 'high',
    timestamp: ts,
    message: {
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'tool_use', id: `toolu_${ts}`, name, input, caller: { type: 'direct' } }],
      usage: { input_tokens: 2, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 1971, output_tokens: 98 },
    },
  });

/** How a failed agent's transcript ends (seen in wf_ca37fe8c-c75): a synthetic API error message. */
const apiError = (agentId: string) =>
  line({
    type: 'assistant',
    isSidechain: true,
    agentId,
    timestamp: '2026-10-20T08:57:47.607Z',
    isApiErrorMessage: true,
    error: 'rate_limit',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your weekly limit · resets 4am (America/Vancouver)" }] },
  });

let root: string;
let transcript: string;
let runDir: string;

const T0 = Date.parse('2026-10-31T00:52:50.909Z');
const setTime = (file: string, ms: number) => fs.utimesSync(file, ms / 1000, ms / 1000);
const write = (file: string, text: string, ms?: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (ms !== undefined) setTime(file, ms);
};
const append = (file: string, lines: string[], ms?: number) => {
  fs.appendFileSync(file, lines.map((l) => l + '\n').join(''));
  if (ms !== undefined) setTime(file, ms);
};

/** A session with the live run as it stood five minutes in: three agents started, none finished. */
function liveRun(): void {
  write(path.join(root, 's1', 'workflows', 'scripts', `looper-round-3-${RUN}.js`), SCRIPT);
  write(path.join(runDir, 'journal.jsonl'), JOURNAL.map((l) => l + '\n').join(''), T0);
  for (const [id, meta] of Object.entries(META)) write(path.join(runDir, `agent-${id}.meta.json`), JSON.stringify(meta), T0 + 50);
  write(
    path.join(runDir, 'agent-a9a1cc7bb1018ff6b.jsonl'),
    [prompt('a9a1cc7bb1018ff6b'), toolUse('a9a1cc7bb1018ff6b', 'Bash', { command: 'rg -n "restMenuItems" src/main/index.ts', description: 'Search menu code in main index' }, '2026-10-31T00:52:52.410Z')]
      .map((l) => l + '\n')
      .join(''),
    T0 + 90_000,
  );
  write(path.join(runDir, 'agent-a01cfbb19d3fd7c60.jsonl'), prompt('a01cfbb19d3fd7c60') + '\n', T0 + 60_000);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-wf-'));
  transcript = path.join(root, 's1.jsonl');
  fs.writeFileSync(transcript, '');
  runDir = path.join(root, 's1', 'subagents', 'workflows', RUN);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('the script meta', () => {
  it("reads the name, description and phases of the live run's script without running it", () => {
    expect(parseScriptMeta(SCRIPT)).toEqual({
      name: 'looper-round-3',
      description: 'Implement the 41 open Round 3 items from 21.txt in Looper across 9 lanes, then integrate and verify',
      phases: [
        { title: 'Wave 1', detail: 'menus and power, Remote Control, web dialogs, Now tab, Chats window' },
        { title: 'Wave 2', detail: 'Remote Access core, pairing UI, main window lists, window placement' },
        { title: 'Integrate', detail: 'typecheck, tests, build, per-item check' },
      ],
    });
  });

  it('reads quoted keys, escapes and comments, and leaves out what only running the script would tell', () => {
    const meta = parseScriptMeta(`// a workflow
export const meta = {
  "name": 'it\\'s-a-run', // the name
  description: \`computed \${2 + 2}\`,
  /* phases */ phases: [{ title: "One" }, { title: PHASE_TWO }, { detail: 'no title' }, { title: \`Three\` },],
  extra: compute({ a: [1, 2] }),
}`);
    expect(meta).toEqual({ name: "it's-a-run", phases: [{ title: 'One' }, { title: 'Three' }] });
  });

  it('is null for a script with no meta or one it cannot read', () => {
    expect(parseScriptMeta("phase('x')")).toBeNull();
    expect(parseScriptMeta("export const meta = { name: 'x', phases: [ }")).toBeNull();
  });
});

describe('the journal', () => {
  it('reads each kind of record the live and finished runs have', () => {
    expect(parseJournalLine(JOURNAL[0])).toEqual({ type: 'launched' });
    expect(parseJournalLine(JOURNAL[1])).toEqual({ type: 'started', key: 'v2:d8a9', agentId: 'a9a1cc7bb1018ff6b', label: 'menus and power', phase: 'Wave 1' });
    // Older runs leave out label and phase; meta.json has them.
    expect(parseJournalLine('{"type":"started","key":"v2:fa8d","agentId":"ace0ce7603330d82d"}')).toEqual({ type: 'started', key: 'v2:fa8d', agentId: 'ace0ce7603330d82d' });
    expect(parseJournalLine('{"type":"result","key":"v2:1","agentId":"a1","result":{"items":[]}}')).toEqual({ type: 'result', key: 'v2:1', agentId: 'a1', result: { items: [] } });
    expect(parseJournalLine('{"type":"failed","key":"v2:1","agentId":"a1"}')).toEqual({ type: 'failed', key: 'v2:1', agentId: 'a1' });
  });

  it('skips torn lines, unknown types and agent ids that are no file name', () => {
    expect(parseJournalLine('{"type":"started","key":"v2')).toBeNull();
    expect(parseJournalLine('{"type":"other","agentId":"a1"}')).toBeNull();
    expect(parseJournalLine('{"type":"failed","agentId":"../x"}')).toBeNull();
  });
});

describe("the parent's Workflow call", () => {
  it('names the run, task and script from the tool result', () => {
    const acc = new TranscriptAccumulator();
    acc.addLine(line({ type: 'assistant', timestamp: '2026-10-31T00:52:47.094Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Workflow', input: { script: SCRIPT } }] } }));
    acc.addLine(
      line({
        type: 'user',
        timestamp: '2026-10-31T00:52:49.942Z',
        message: {
          content: [
            {
              tool_use_id: 'tu1',
              type: 'tool_result',
              content: `Workflow launched in background. Task ID: wsv0hjytx\nSummary: Implement the 41 open Round 3 items\nTranscript dir: /home/leandro/.claude-creds/work/projects/-home-leandro-repos-looper/ddc4d6eb/subagents/workflows/${RUN}\nScript file: /home/leandro/.claude-creds/work/projects/-home-leandro-repos-looper/ddc4d6eb/workflows/scripts/looper-round-3-${RUN}.js\n(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "…"} to iterate.)`,
              is_error: false,
            },
          ],
        },
        toolUseResult: { status: 'async_launched', taskId: 'wsv0hjytx', taskType: 'local_workflow', workflowName: 'looper-round-3', runId: RUN },
      }),
    );
    expect(workflowLaunchesOf(acc.rows)).toEqual([
      {
        runId: RUN,
        taskId: 'wsv0hjytx',
        transcriptDir: `/home/leandro/.claude-creds/work/projects/-home-leandro-repos-looper/ddc4d6eb/subagents/workflows/${RUN}`,
        scriptPath: `/home/leandro/.claude-creds/work/projects/-home-leandro-repos-looper/ddc4d6eb/workflows/scripts/looper-round-3-${RUN}.js`,
        summary: 'Implement the 41 open Round 3 items',
        // The row's time is the call's.
        at: Date.parse('2026-10-31T00:52:47.094Z'),
        // The row tracks the call as background work until its task notification.
        status: 'running',
      },
    ]);
  });

  it("takes the run's status from the row's background state", () => {
    const rows = [
      {
        id: '0',
        kind: 'tool' as const,
        tool: 'Workflow',
        preview: '',
        text: '',
        result: `Workflow launched in background. Task ID: w2\nTranscript dir: /x/subagents/workflows/${RUN}`,
        background: { id: 'w2', status: 'completed' as const },
      },
    ];
    expect(workflowLaunchesOf(rows)[0]).toMatchObject({ runId: RUN, taskId: 'w2', status: 'completed' });
  });
});

describe("a session's workflow runs", () => {
  it('shows a live run: its phases from the script, each agent with label, model, start and latest tool call', async () => {
    liveRun();
    const [run] = await new SessionWorkflows(transcript).read({ detail: true });
    expect(run).toMatchObject({ runId: RUN, name: 'looper-round-3', status: 'running', startedAt: T0 + 50, logs: [] });
    expect(run.endedAt).toBeUndefined();
    expect(run.phases.map((p) => [p.title, p.agents.length])).toEqual([
      ['Wave 1', 3],
      ['Wave 2', 0],
      ['Integrate', 0],
    ]);
    expect(run.phases[0].detail).toBe('menus and power, Remote Control, web dialogs, Now tab, Chats window');
    expect(run.phases[0].agents[0]).toEqual({
      agentId: 'a9a1cc7bb1018ff6b',
      label: 'menus and power',
      phase: 'Wave 1',
      model: 'opus',
      modelId: 'claude-opus-5-5',
      effort: 'high',
      contextTokens: 2 + 37559 + 1971,
      status: 'running',
      startedAt: T0 + 50,
      lastTool: { name: 'Bash', preview: 'Search menu code in main index' },
    });
    // No transcript yet: still listed, from the journal and its meta file.
    expect(run.phases[0].agents[2]).toMatchObject({ label: 'web dialogs', status: 'running', model: 'opus' });
    expect(workflowCounts(run)).toEqual({ total: 3, running: 3, done: 0, failed: 0, stopped: 0 });
    expect(workflowPhaseStatus(run.phases[0])).toBe('running');
    expect(workflowPhaseStatus(run.phases[1])).toBe('waiting');
  });

  it('reads no agent transcript for a session that is not on screen, except why one failed', async () => {
    liveRun();
    const wf = new SessionWorkflows(transcript);
    const [run] = await wf.read();
    expect(run.phases[0].agents[0].lastTool).toBeUndefined();
    expect(run.phases[0].agents[0].modelId).toBeUndefined();
    append(path.join(runDir, 'agent-a01cfbb19d3fd7c60.jsonl'), [apiError('a01cfbb19d3fd7c60')], T0 + 300_000);
    append(path.join(runDir, 'journal.jsonl'), ['{"type":"failed","key":"v2:af0f","agentId":"a01cfbb19d3fd7c60"}'], T0 + 300_000);
    const [again] = await wf.read();
    expect(again.phases[0].agents[1]).toMatchObject({ status: 'failed', error: "You've hit your weekly limit · resets 4am (America/Vancouver)" });
    expect(again.phases[0].agents[0].lastTool).toBeUndefined();
  });

  it('follows the run as its files grow: new tool calls, results, failures and the next phase', async () => {
    liveRun();
    const wf = new SessionWorkflows(transcript);
    await wf.read({ detail: true });
    append(path.join(runDir, 'agent-a9a1cc7bb1018ff6b.jsonl'), [toolUse('a9a1cc7bb1018ff6b', 'Edit', { file_path: '/repo/src/main/index.ts' }, '2026-10-31T00:59:00.000Z', 50_000)], T0 + 400_000);
    append(path.join(runDir, 'agent-a01cfbb19d3fd7c60.jsonl'), [apiError('a01cfbb19d3fd7c60')], T0 + 300_000);
    append(
      path.join(runDir, 'journal.jsonl'),
      [
        '{"type":"result","key":"v2:d8a9","agentId":"a9a1cc7bb1018ff6b","result":{"items":[{"item":2,"status":"done","summary":"Moved Recycle Bin"}],"decisions":[],"checks":"typecheck clean"}}',
        '{"type":"failed","key":"v2:af0f","agentId":"a01cfbb19d3fd7c60"}',
        '{"type":"started","key":"v2:9","agentId":"a5910cd3fc3a85c55","label":"pairing UI","phase":"Wave 2"}',
      ],
      T0 + 400_000,
    );
    write(path.join(runDir, 'agent-a5910cd3fc3a85c55.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'pairing UI', workflowPhase: 'Wave 2', model: 'sonnet' }), T0 + 400_000);

    const [run] = await wf.read({ detail: true });
    const [menus, remote, web] = run.phases[0].agents;
    expect(menus).toMatchObject({ status: 'done', startedAt: T0 + 50, endedAt: T0 + 400_000, lastTool: { name: 'Edit', preview: '/repo/src/main/index.ts' }, contextTokens: 2 + 50_000 + 1971 });
    expect(JSON.parse(menus.result!)).toEqual({ items: [{ item: 2, status: 'done', summary: 'Moved Recycle Bin' }], decisions: [], checks: 'typecheck clean' });
    expect(remote).toMatchObject({ status: 'failed', endedAt: T0 + 300_000, error: "You've hit your weekly limit · resets 4am (America/Vancouver)" });
    expect(web.status).toBe('running');
    expect(run.phases[1].agents.map((a) => [a.label, a.model, a.status])).toEqual([['pairing UI', 'sonnet', 'running']]);
    expect(workflowPhaseStatus(run.phases[0])).toBe('running');
    expect(elapsedMs(menus, T0 + 999_999)).toBe(400_000 - 50);
    expect(elapsedMs(web, T0 + 1050)).toBe(1000);
  });

  it('shows a finished run from its final state: status, end, logs, result, and each agent\'s tokens and tool calls', async () => {
    liveRun();
    append(path.join(runDir, 'journal.jsonl'), ['{"type":"result","key":"v2:d8a9","agentId":"a9a1cc7bb1018ff6b","result":"menus done"}'], T0 + 500_000);
    write(
      path.join(root, 's1', 'workflows', `${RUN}.json`),
      JSON.stringify({
        runId: RUN,
        timestamp: new Date(T0 + 500_006).toISOString(),
        taskId: 'wsv0hjytx',
        script: SCRIPT,
        result: { reports: [], integration: { fixes: [] } },
        agentCount: 3,
        logs: ['Wave 1 finished: 3 of 5 lanes reported'],
        durationMs: 500_000,
        summary: 'Implement the 41 open Round 3 items',
        workflowName: 'looper-round-3',
        status: 'completed',
        startTime: T0,
        phases: [{ title: 'Wave 1' }, { title: 'Wave 2' }, { title: 'Integrate' }],
        defaultModel: 'claude-opus-5-5',
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'Wave 1' },
          { type: 'workflow_agent', index: 1, label: 'menus and power', phaseIndex: 1, phaseTitle: 'Wave 1', agentId: 'a9a1cc7bb1018ff6b', model: 'claude-opus-5-5', state: 'done', startedAt: T0 + 14, attempt: 1, lastToolName: 'Bash', lastToolSummary: 'npm run typecheck', tokens: 185379, toolCalls: 22, durationMs: 253241, resultPreview: 'menus done' },
          { type: 'workflow_agent', index: 2, label: 'Remote Control', phaseIndex: 1, phaseTitle: 'Wave 1', agentId: 'a01cfbb19d3fd7c60', model: 'claude-opus-5-5', state: 'done', startedAt: T0 + 15, tokens: 1000, toolCalls: 3, durationMs: 100_000, resultPreview: 'remote done' },
          { type: 'workflow_agent', index: 3, label: 'web dialogs', phaseIndex: 1, phaseTitle: 'Wave 1', agentId: 'ab89de4b745de9463', model: 'claude-opus-5-5', state: 'done', startedAt: T0 + 16, tokens: 2000, toolCalls: 4, durationMs: 200_000, resultPreview: 'web done' },
        ],
        totalTokens: 188379,
        totalToolCalls: 29,
      }),
    );
    const [run] = await new SessionWorkflows(transcript).read({ detail: true });
    expect(run).toMatchObject({ status: 'completed', taskId: 'wsv0hjytx', startedAt: T0, endedAt: T0 + 500_000, logs: ['Wave 1 finished: 3 of 5 lanes reported'] });
    expect(JSON.parse(run.result!)).toEqual({ reports: [], integration: { fixes: [] } });
    expect(run.phases[0].agents[0]).toMatchObject({ status: 'done', startedAt: T0 + 14, endedAt: T0 + 14 + 253241, tokens: 185379, toolCalls: 22, result: 'menus done', modelId: 'claude-opus-5-5' });
    // The journal had no result for these two; the final state has.
    expect(run.phases[0].agents.slice(1).map((a) => [a.status, a.result])).toEqual([
      ['done', 'remote done'],
      ['done', 'web done'],
    ]);
  });

  it("stops a killed run's unfinished agents", async () => {
    liveRun();
    write(
      path.join(root, 's1', 'workflows', `${RUN}.json`),
      JSON.stringify({
        runId: RUN,
        timestamp: new Date(T0 + 8099).toISOString(),
        status: 'killed',
        error: 'Error: Workflow aborted\n    at S (/$bunfs/root/chunk-v92rkx11.js:80:5368)',
        startTime: T0,
        durationMs: 8099,
        logs: [],
        workflowProgress: [{ type: 'workflow_agent', label: 'menus and power', agentId: 'a9a1cc7bb1018ff6b', state: 'progress', startedAt: T0 + 14 }],
      }),
    );
    const [run] = await new SessionWorkflows(transcript).read();
    expect(run).toMatchObject({ status: 'stopped', error: 'Error: Workflow aborted', endedAt: T0 + 8099 });
    expect(workflowCounts(run)).toMatchObject({ running: 0, stopped: 3 });
    // Its transcript's last change is no later than the run's end.
    expect(run.phases[0].agents[0]).toMatchObject({ status: 'stopped', startedAt: T0 + 14, endedAt: T0 + 8099 });
    expect(run.phases[0].agents[1]).toMatchObject({ status: 'stopped', endedAt: T0 + 8099 });
  });

  it("treats a run resumed after its final state was written as running again, and its parent's call as the authority", async () => {
    liveRun();
    write(path.join(root, 's1', 'workflows', `${RUN}.json`), JSON.stringify({ runId: RUN, timestamp: new Date(T0 - 60_000).toISOString(), status: 'completed', logs: ['old'] }));
    const wf = new SessionWorkflows(transcript);
    // The journal changed after the old final state: the run was resumed.
    expect((await wf.read())[0]).toMatchObject({ status: 'running', logs: [] });
    const launch = { runId: RUN, transcriptDir: runDir, taskId: 'w3' };
    expect((await wf.read({ launches: [{ ...launch, status: 'running' }] }))[0]).toMatchObject({ status: 'running', taskId: 'w3' });
    expect((await wf.read({ launches: [{ ...launch, status: 'failed' }] }))[0]).toMatchObject({ status: 'failed' });
  });

  it('marks a run with no end recorded as stopped once its session ended', async () => {
    liveRun();
    const [run] = await new SessionWorkflows(transcript).read({ sessionEnded: true });
    expect(run.status).toBe('stopped');
    expect(run.phases[0].agents.every((a) => a.status === 'stopped')).toBe(true);
  });

  it('names the run by its id and lists agents without a phase when the script and phases are unknown', async () => {
    write(path.join(runDir, 'journal.jsonl'), '{"type":"launched"}\n{"type":"started","key":"k","agentId":"ace0ce7603330d82d"}\n', T0);
    write(path.join(runDir, 'agent-ace0ce7603330d82d.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'scope' }), T0);
    const [run] = await new SessionWorkflows(transcript).read();
    expect(run.name).toBe(RUN);
    expect(run.phases).toEqual([{ title: '', agents: [expect.objectContaining({ label: 'scope', status: 'running' })] }]);
  });

  it('has no runs for a session that never ran a workflow', async () => {
    expect(await new SessionWorkflows(transcript).read()).toEqual([]);
  });
});

describe("a workflow agent's transcript", () => {
  it('is found under its run for the message view, and only for a file-name-safe id', async () => {
    liveRun();
    expect(await workflowAgentTranscript(transcript, 'a9a1cc7bb1018ff6b')).toBe(path.join(runDir, 'agent-a9a1cc7bb1018ff6b.jsonl'));
    expect(await workflowAgentTranscript(transcript, 'a0000000000000000')).toBeNull();
    expect(await workflowAgentTranscript(transcript, '../s1')).toBeNull();
  });
});

describe('the final state', () => {
  it('is null for a file that is not one', () => {
    expect(parseFinalState({ status: 'completed' })).toBeNull();
    expect(parseFinalState([])).toBeNull();
  });
});

describe('reading a growing file', () => {
  it("takes only the end on the first read, without the end's cut first line, then what was appended", async () => {
    const file = path.join(root, 'grow.jsonl');
    fs.writeFileSync(file, 'aaaaaaaaaa\nbbbb\ncc\n');
    const tail = new LineTail(file, 8);
    expect(await tail.read()).toEqual(['cc']);
    fs.appendFileSync(file, 'dd\nee');
    expect(await tail.read()).toEqual(['dd']);
    fs.appendFileSync(file, 'e\n');
    expect(await tail.read()).toEqual(['eee']);
    expect(await tail.read()).toEqual([]);
  });
});

describe('the shared helpers', () => {
  it("finds the open run and agent for the workflow's tab, and gives states a tab dot like a subagent's", () => {
    const agent = (agentId: string, status: 'running' | 'done' | 'failed' | 'stopped') => ({ agentId, label: `L${agentId}`, status });
    const run: WorkflowRun = {
      runId: RUN,
      name: 'looper-round-3',
      status: 'running',
      phases: [
        { title: 'Wave 1', agents: [agent('a1', 'done'), agent('a2', 'running'), agent('a3', 'stopped')] },
        { title: 'Wave 2', agents: [agent('a4', 'failed')] },
      ],
      logs: [],
    };
    expect(workflowAgents(run).map((a) => a.agentId)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(openWorkflow([run], { runId: RUN, agentId: null })).toEqual({ run, agent: null });
    expect(openWorkflow([run], { runId: RUN, agentId: 'a4' })?.agent?.label).toBe('La4');
    // An agent the run no longer lists leaves its overview open; a run that's gone closes the view.
    expect(openWorkflow([run], { runId: RUN, agentId: 'zz' })).toEqual({ run, agent: null });
    expect(openWorkflow([run], { runId: 'wf_gone', agentId: null })).toBeNull();
    expect(openWorkflow([run], null)).toBeNull();
    expect(['running', 'completed', 'done', 'failed', 'stopped'].map((s) => tabStatus(s as 'running'))).toEqual(['running', 'done', 'done', 'failed', 'done']);
  });

  it('counts nothing for a run without agents', () => {
    const run: WorkflowRun = { runId: RUN, name: 'x', status: 'running', phases: [{ title: 'A', agents: [] }], logs: [] };
    expect(workflowCounts(run).total).toBe(0);
    expect(elapsedMs({}, 5)).toBeUndefined();
  });
});
