import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeClaudeSettings, mergeSystemPrompt, readUserSettings } from '../src/engine/claude-settings';
import { renderMod } from '../src/engine/claude-mod';
import { Logger } from '../src/engine/log';
import { startAgent } from '../src/engine/steps/agent';
import type { RunContext } from '../src/engine/steps/common';
import { writeText } from '../src/engine/store/fsutil';
import { BashTarget, createTarget } from '../src/engine/target';
import { claudeArgsProblem, takeFlagValues } from '../src/shared/claude-args';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { SettingsSchema, TaskSchema } from '../src/shared/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};

describe('the user\'s Claude Code arguments', () => {
  it('finds every --settings in both forms and leaves the rest in order', () => {
    expect(takeFlagValues(['--verbose', '--settings', 'a.json', '--tools', 'Bash', '--settings={"x":1}'])).toEqual({
      values: ['a.json', '{"x":1}'],
      rest: ['--verbose', '--tools', 'Bash'],
    });
  });

  it('refuses at save what Looper sets, what a field sets, and what keeps the mod from loading', () => {
    expect(claudeArgsProblem(['--verbose', '--settings', 'x.json'], 'Arguments')).toBeNull();
    expect(claudeArgsProblem(['-p'], 'Arguments')).toBe('Arguments: Looper sets -p itself. Remove it.');
    expect(claudeArgsProblem(['--output-format=json'], 'Arguments')).toContain('Looper sets --output-format itself');
    expect(claudeArgsProblem(['--model', 'opus'], 'Arguments')).toBe('Arguments: --model has a field of its own. Remove it and set Model instead.');
    expect(claudeArgsProblem(['--dangerously-skip-permissions'], 'X')).toContain('set Permission mode instead');
    expect(claudeArgsProblem(['--bare'], 'X')).toContain("Looper can't run Claude Code with --bare");
    expect(claudeArgsProblem(['--settings', '{"a":'], 'X')).toContain("the JSON after --settings isn't valid");
    expect(claudeArgsProblem(['--settings', '[1]'], 'X')).toBeNull();
    expect(claudeArgsProblem(['--settings', '{"a":[1]}'], 'X')).toBeNull();
  });
});

describe('merging the user\'s settings into Looper\'s', () => {
  const looper = {
    permissions: { allow: ['Bash(looper-done:*)'] },
    sandbox: { excludedCommands: ['looper-done'] },
    enableAllProjectMcpServers: true,
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'looper-stop' }] }], SessionStart: [{ hooks: [{ type: 'command', command: 'looper-start' }] }] },
  };

  it('keeps both sides of the lists and hooks, and lets the user win elsewhere', () => {
    const merged = mergeClaudeSettings(looper, [
      {
        permissions: { allow: ['Bash(npm:*)'], defaultMode: 'acceptEdits' },
        enableAllProjectMcpServers: false,
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }], Notification: [{ hooks: [] }] },
        env: { A: '1' },
      },
    ]);
    expect(merged.permissions).toEqual({ allow: ['Bash(looper-done:*)', 'Bash(npm:*)'], defaultMode: 'acceptEdits' });
    expect(merged.sandbox).toEqual({ excludedCommands: ['looper-done'] });
    expect(merged.enableAllProjectMcpServers).toBe(false);
    expect(merged.env).toEqual({ A: '1' });
    const hooks = merged.hooks as Record<string, { hooks: { command: string }[] }[]>;
    expect(hooks.Stop.map((g) => g.hooks[0].command)).toEqual(['mine', 'looper-stop']);
    expect(hooks.SessionStart).toEqual(looper.hooks.SessionStart);
    expect(hooks.Notification).toEqual([{ hooks: [] }]);
  });

  it("refuses settings that turn off every hook", () => {
    expect(() => mergeClaudeSettings(looper, [{ disableAllHooks: true }])).toThrow(/disableAllHooks/);
  });

  it('reads inline JSON and files relative to the task folder, and names the argument it cannot read', async () => {
    const dir = tmp('looper-settings-');
    fs.writeFileSync(path.join(dir, 'mine.json'), '{"env":{"B":"2"}}');
    const place = { target: new BashTarget({ host: 'linux' }, undefined), cwd: dir };
    const read = await readUserSettings(['--settings', 'mine.json', '--settings={"env":{"C":"3"}}', '--verbose'], place);
    expect(read).toEqual({ rest: ['--verbose'], settings: [{ env: { B: '2' } }, { env: { C: '3' } }] });
    await expect(readUserSettings(['--settings', 'gone.json'], place)).rejects.toThrow(/^--settings gone\.json: ENOENT/);
    fs.writeFileSync(path.join(dir, 'bad.json'), '[1]');
    await expect(readUserSettings(['--settings', 'bad.json'], place)).rejects.toThrow('--settings bad.json: the settings must be a JSON object');
  });

  it("puts the user's system prompt after Looper's", () => {
    expect(mergeSystemPrompt('Looper footer', ['--append-system-prompt', 'Be brief.', '-x'])).toEqual({ text: 'Looper footer\n\nBe brief.', rest: ['-x'] });
    expect(mergeSystemPrompt(undefined, ['-x'])).toEqual({ text: undefined, rest: ['-x'] });
  });
});

describe('the mod', () => {
  it('bakes the session into the module, which parses as JavaScript', () => {
    const source = renderMod({
      files: { ready: '/r/mod.json', control: '/r/mod-control.json', turnEnd: '/r/turn-end.json', usage: '/r/usage.json', turn: '/r/turn.json' },
      inbox: ['/r/guidance.json'],
      userInbox: ['/r/guidance.json'],
      signalCommands: ['looper-done'],
      guardMessage: "a subagent can't",
      ask: { command: 'looper-ask', timeoutMs: 1000 },
      headless: false,
      prompted: true,
      windows: false,
    });
    expect(source).toContain('"/r/guidance.json"');
    expect(source).not.toContain('__CONFIG__');
    // An ES module: syntax-check it as one, with its export turned into a plain function.
    expect(() => new Function(source.replace('export function register', 'function register'))).not.toThrow();
  });

  it('hands the rows of the main conversation and the notes a conversation shows to the live folder, as the transcript will record them', async () => {
    const dir = tmp('looper-mod-live-');
    const live = path.join(dir, 'live');
    const module = path.join(dir, 'register.mjs');
    fs.writeFileSync(
      module,
      renderMod({
        files: { ready: path.join(dir, 'mod.json'), control: path.join(dir, 'c.json'), turnEnd: path.join(dir, 'turn-end.json'), usage: path.join(dir, 'u.json'), turn: path.join(dir, 't.json') },
        inbox: [],
        userInbox: [],
        signalCommands: [],
        guardMessage: '',
        headless: false,
        prompted: false,
        windows: false,
        live,
      }),
    );
    type Hook = ($: unknown, e: Record<string, unknown>, next: (e: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>;
    const hooks: Record<string, Hook> = {};
    const { register } = (await import(pathToFileURL(module).href)) as { register: (on: (name: string, hook: Hook) => void) => void };
    register((name, hook) => (hooks[name] = hook));
    const $ = {
      fs: { write: async (p: string, text: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, text)) },
      session: { usage: async () => ({}) },
    };
    let n = 0;
    const append = (door: string, origin: unknown, message: Record<string, unknown>, agentId?: string) =>
      hooks['session.append']($, { door, origin, uuid: `u${++n}`, message, ...(agentId ? { agentId } : {}) }, async (x) => ({ message: x.message, uuid: x.uuid }));
    const model = { kind: 'model', model: 'claude-x' };
    const synthetic = { kind: 'model', model: '<synthetic>' };
    const text = (t: string) => [{ type: 'text', text: t }];
    const turnEnd = (reason: string) => hooks['turn.complete']($, { reason, answer: '', isAborted: false, turnId: 't' }, async (x) => x);
    await hooks['turn.start']($, { turnId: 't' }, async (x) => x);
    await append('prompt', { kind: 'composer' }, { type: 'user', role: 'user', content: text('hi') }); // u1
    await append('response', model, { type: 'assistant', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] }); // u2
    await append('response', model, { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }] }); // u3
    await hooks['tool.call']($, { tool: 'Edit', tool_use_id: 't1', file_path: 'a.txt' }, async () => ({ result: { structuredPatch: [1] }, text: 'ok' }));
    await append('tool-result', { kind: 'tool', tool: 'Edit' }, { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }); // u4
    await append('tool-message', { kind: 'tool', tool: 'Skill' }, { type: 'user', role: 'user', isMeta: true, content: text('Base directory for this skill') }); // u5
    // Left out: what the engine adds that no conversation shows, a subagent's rows, and the plugin's own note, which poll writes.
    await append('attachment', { kind: 'engine' }, { type: 'attachment', name: 'date', content: text('today') }); // u6
    await append('response', model, { type: 'assistant', role: 'assistant', content: text('from a subagent') }, 'a1'); // u7
    await append('note', { kind: 'plugin' }, { type: 'user', role: 'user', content: text('a note') }); // u8
    // The notes a conversation reads, from the text the model gets.
    const notice = '<system-reminder>\n<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>\n</system-reminder>';
    await append('delivery', { kind: 'task-notification' }, { type: 'attachment', name: 'queued_command', content: text(notice) }); // u9
    await append('hook-context', { kind: 'hook', event: 'Stop' }, { type: 'attachment', name: 'hook_additional_context', content: text('Stop hook additional context: again') }); // u10
    await append('attachment', { kind: 'engine' }, { type: 'attachment', name: 'skill_listing', content: text('The skills:\n- a: one') }); // u11
    // A stand-in reply waits for the turn's end, which says it was the API error that ended the turn; the rows after it keep their place.
    await append('response', synthetic, { type: 'assistant', role: 'assistant', content: text('Prompt is too long') }); // u12
    await append('hook-context', { kind: 'hook', event: 'Stop' }, { type: 'attachment', name: 'hook_additional_context', content: text('after the error') }); // u13
    await turnEnd('error');
    // One the turn goes on past isn't an error.
    await append('response', synthetic, { type: 'assistant', role: 'assistant', content: text('No response requested.') }); // u14
    await append('prompt', { kind: 'composer' }, { type: 'user', role: 'user', content: text('next') }); // u15
    // A Code Mode script's call whose maker the mod can't read goes over as Claude Code copies it in, once the script has ended.
    await hooks['tool.call']($, { tool: 'Bash', tool_use_id: 'repl_1', command: 'ls' }, async () => ({ result: { stdout: 'a.txt' }, text: 'a.txt' }));
    await append('response', synthetic, { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'repl_1', name: 'Bash', input: { command: 'ls' } }] }); // u16
    await append('tool-result', { kind: 'tool', tool: 'Bash' }, { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'repl_1', content: '' }] }); // u17
    // One Claude Code raised for a script goes over as it starts and as it ends, and Claude Code's copies of it don't.
    const engine = <F extends object>(f: F) => Object.assign(f, { origin: { plugin: 'engine', tier: 'core' } });
    await hooks['tool.call']($, { tool: 'Read', tool_use_id: 'repl_2', file_path: 'b.txt' }, engine(async () => ({ result: { type: 'text', file: { content: 'B' } }, text: 'B' })));
    await append('response', synthetic, { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'repl_2', name: 'Read', input: { file_path: 'b.txt' } }] }); // u18
    await append('tool-result', { kind: 'tool', tool: 'Read' }, { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'repl_2', content: '' }] }); // u19
    await hooks['tool.call']($, { tool: 'Bash', tool_use_id: 'repl_3', command: 'false' }, engine(async () => ({ isError: true, result: 'exit 1', text: 'exit 1' })));
    // Each file's name ends in its row's id, or its call's, which the session step's sweep reads.
    const read = () =>
      fs.existsSync(live)
        ? fs.readdirSync(live).sort().map((f) => {
            const row = JSON.parse(fs.readFileSync(path.join(live, f), 'utf8'));
            const call = row.message?.content?.[0]?.id ?? row.message?.content?.[0]?.tool_use_id;
            expect(f).toMatch(new RegExp(row.uuid ? `^\\d+-\\d{9}-${row.uuid}\\.json$` : `^\\d+-\\d{9}-call-${call}\\.json$`));
            return row;
          })
        : [];
    for (let i = 0; i < 100 && read().length < 18; i++) await new Promise((r) => setTimeout(r, 20));
    const all = read();
    const rows = all.filter((r) => r.uuid);
    expect(rows.map((r) => r.uuid)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17']);
    expect(all.filter((r) => !r.uuid)).toEqual([
      expect.objectContaining({ type: 'assistant', isVirtual: true, liveScriptCall: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'tool_use', id: 'repl_2', name: 'Read', input: { file_path: 'b.txt' } }] } }),
      expect.objectContaining({ type: 'user', isVirtual: true, toolUseResult: { type: 'text', file: { content: 'B' } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'repl_2', content: '', is_error: false }] } }),
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [{ type: 'tool_use', id: 'repl_3', name: 'Bash', input: { command: 'false' } }] }) }),
      expect.objectContaining({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'repl_3', content: 'exit 1', is_error: true }] } }),
    ]);
    expect(all.at(-1).toolUseResult).toBeUndefined();
    const by = Object.fromEntries(rows.map((r) => [r.uuid, r]));
    expect(by.u1).toMatchObject({ type: 'user', isSidechain: false, message: { role: 'user', content: text('hi') } });
    expect(by.u3).toMatchObject({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 't1' }] } });
    // One response's blocks share its message id, as the transcript's do.
    expect(by.u2.message.id).toBe(by.u3.message.id);
    expect(by.u4.toolUseResult).toEqual({ structuredPatch: [1] });
    expect(by.u5.isMeta).toBe(true);
    expect(by.u9.attachment).toEqual({ type: 'queued_command', prompt: notice, commandMode: 'task-notification' });
    expect(by.u10.attachment).toEqual({ type: 'hook_additional_context', hookEvent: 'Stop', content: ['Stop hook additional context: again'] });
    expect(by.u11.attachment).toEqual({ type: 'skill_listing', content: 'The skills:\n- a: one' });
    expect(by.u12.isApiErrorMessage).toBe(true);
    expect(by.u14.isApiErrorMessage).toBeUndefined();
    expect(by.u14.message.id).not.toBe(by.u12.message.id);
    // The script's call is marked as the transcript marks it, so it goes under the REPL call; the model's own aren't.
    expect(by.u16).toMatchObject({ isVirtual: true, message: { content: [{ type: 'tool_use', id: 'repl_1' }] } });
    expect(by.u17).toMatchObject({ isVirtual: true, toolUseResult: { stdout: 'a.txt' } });
    expect(by.u3.isVirtual).toBeUndefined();
    expect(by.u4.isVirtual).toBeUndefined();
  });

  it("hands over a Stop hook's feedback, and a prompt typed mid-turn as typed", async () => {
    const dir = tmp('looper-mod-live-');
    const live = path.join(dir, 'live');
    const module = path.join(dir, 'register.mjs');
    fs.writeFileSync(
      module,
      renderMod({
        files: { ready: path.join(dir, 'mod.json'), control: path.join(dir, 'c.json'), turnEnd: path.join(dir, 'turn-end.json'), usage: path.join(dir, 'u.json'), turn: path.join(dir, 't.json') },
        inbox: [],
        userInbox: [],
        signalCommands: [],
        guardMessage: '',
        headless: false,
        prompted: false,
        windows: false,
        live,
      }),
    );
    type Hook = ($: unknown, e: Record<string, unknown>, next: (e: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>;
    const hooks: Record<string, Hook> = {};
    const { register } = (await import(pathToFileURL(module).href)) as { register: (on: (name: string, hook: Hook) => void) => void };
    register((name, hook) => (hooks[name] = hook));
    const $ = { fs: { write: async (p: string, text: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, text)) } };
    const append = (uuid: string, door: string, origin: unknown, message: Record<string, unknown>) =>
      hooks['session.append']($, { door, origin, uuid, message }, async (x) => ({ message: x.message, uuid: x.uuid }));
    await append('f1', 'note', { kind: 'engine' }, { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: 'Stop hook feedback:\nsay bye' }] });
    await hooks['prompt.submit']($, { text: 'also this', turnId: 't', wait: false, origin: { kind: 'composer' } }, async (x) => ({ text: x.text }));
    const wrapped = '<system-reminder>\nThe user sent a new message while you were working:\nalso this\n\nPlease address it.\n</system-reminder>';
    await append('q1', 'delivery', { kind: 'composer' }, { type: 'attachment', name: 'queued_command', content: [{ type: 'text', text: wrapped }] });
    // Each file's name ends in its row's id, which the session step's sweep reads.
    const read = () =>
      fs.existsSync(live)
        ? fs.readdirSync(live).sort().map((f) => {
            const row = JSON.parse(fs.readFileSync(path.join(live, f), 'utf8'));
            expect(f).toMatch(new RegExp(`^\\d+-\\d{9}-${row.uuid}\\.json$`));
            return row;
          })
        : [];
    for (let i = 0; i < 100 && read().length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    const [feedback, typed] = read();
    expect(feedback).toMatchObject({ type: 'user', uuid: 'f1', isMeta: true, message: { content: [{ type: 'text', text: 'Stop hook feedback:\nsay bye' }] } });
    expect(typed).toMatchObject({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: 'also this', commandMode: 'prompt' } });
  });
});

/** An interactive Claude Code run whose fake harness writes what the mod and hooks would. */
function makeCtx(fake: string, agent: Record<string, unknown> = {}, harnessArgs: string[] = []): RunContext {
  const root = tmp('looper-mod-run-');
  const harness = path.join(root, 'fake-claude');
  writeText(harness, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$LOOPER_RUN_DIR/argv.txt"\n${fake}\n`, 0o755);
  const runDir = path.join(root, 'run');
  fs.mkdirSync(path.join(runDir, 'bin'), { recursive: true });
  const settings = SettingsSchema.parse({
    signalPollMs: 50,
    environments: [
      {
        id: 'local',
        name: 'Local',
        kind: 'local',
        shell: 'bash -c',
        harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code', command: harness, args: harnessArgs }],
      },
    ],
  });
  const task = TaskSchema.parse({
    ...EXAMPLE_TASK,
    cwd: root,
    agent: { ...EXAMPLE_TASK.agent, harnessId: 'fake', mode: 'interactive', maxRuntimeMin: 1, ...agent },
  });
  return {
    task,
    runId: `r-${path.basename(root)}`,
    runDir,
    target: createTarget(task, { host: 'linux', settings }),
    settings,
    host: 'linux',
    log: new Logger(),
    vars: {},
  };
}

const MOD_READY = `printf '{"version":"1"}' > "$LOOPER_RUN_DIR/mod.json"; printf '{}' > "$LOOPER_RUN_DIR/session.json"`;

describe("the mod's messages for the agent", () => {
  it("ends the turn for the user's message once no tool call is working and sends it as their prompt, while Looper's own messages go along as notes", async () => {
    const dir = tmp('looper-mod-interrupt-');
    const user = path.join(dir, 'chat-message.json');
    const events = path.join(dir, 'events.json');
    const module = path.join(dir, 'register.mjs');
    fs.writeFileSync(
      module,
      renderMod({
        files: { ready: path.join(dir, 'mod.json'), control: path.join(dir, 'c.json'), turnEnd: path.join(dir, 'turn-end.json'), usage: path.join(dir, 'u.json'), turn: path.join(dir, 't.json') },
        inbox: [user, events],
        userInbox: [user],
        signalCommands: [],
        guardMessage: '',
        headless: false,
        prompted: false,
        windows: false,
      }),
    );
    type Hook = ($: unknown, e: Record<string, unknown>, next: (e: Record<string, unknown>) => unknown) => unknown;
    const hooks: Record<string, Hook> = {};
    const { register } = (await import(pathToFileURL(module).href)) as { register: (on: (name: string, hook: Hook) => void) => void };
    register((name, hook) => (hooks[name] = hook));
    let tick: () => Promise<void> = async () => {};
    const aborted: string[] = [];
    const prompts: unknown[] = [];
    const notes: string[] = [];
    const $ = {
      fs: {
        write: async (p: string, text: string) => fs.writeFileSync(p, text),
        read: async (p: string) => fs.readFileSync(p, 'utf8'),
        exists: async (p: string) => fs.existsSync(p),
      },
      process: { run: async (argv: string[]) => (fs.renameSync(argv[1], argv[2]), { exitCode: 0 }) },
      session: {
        id: async () => 's1',
        usage: async () => ({}),
        append: async (a: { message: { content: { text: string }[] } }) => (notes.push(a.message.content[0].text), { uuid: 'n1', message: a.message }),
      },
      clock: { every: (_ms: number, fn: () => Promise<void>) => (tick = fn) },
      turn: { abort: async (a: { turnId: string }) => void aborted.push(a.turnId) },
      prompt: { read: async () => ({ text: '', cursor: 0 }), submit: async (p: { text: string }) => (prompts.push(p), { text: p.text }) },
    };
    const pass = async (x: unknown) => x;
    await hooks['session.start']($, {}, pass);
    /** One request of turn `turnId`: whether it was sent, and what the hook answered. */
    const step = async (turnId: string, index: number) => {
      let sent = false;
      const stream = hooks['turn.step']($, { turnId, index }, () =>
        (async function* () {
          sent = true;
          return { turnId, index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null };
        })(),
      ) as AsyncGenerator<unknown, { toolUses: unknown[] }>;
      let r = await stream.next();
      while (!r.done) r = await stream.next();
      return { sent, answer: r.value };
    };
    const store = (door: string, content: unknown[]) => hooks['session.append']($, { door, origin: { kind: 'model', model: 'm' }, uuid: 'r' + Math.random(), message: { type: door === 'response' ? 'assistant' : 'user', content } }, async (x) => ({ message: (x as { message: unknown }).message, uuid: 'u' }));
    const call = (id: string, name: string) => store('response', [{ type: 'tool_use', id, name, input: {} }]);
    const result = (id: string) => store('tool-result', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

    await hooks['turn.start']($, { turnId: 't1' }, pass);
    expect((await step('t1', 0)).sent).toBe(true);
    await call('c1', 'Bash');
    fs.writeFileSync(user, JSON.stringify('also check the tests'));
    fs.writeFileSync(events, JSON.stringify('a related event'));
    // A command is running: the user's message waits, and Looper's event goes along with the next request.
    await tick();
    expect(aborted).toEqual([]);
    expect(fs.existsSync(user)).toBe(true);
    expect(notes).toEqual(['a related event']);
    // The command ended: before the next request, the message ends the turn and starts the next one.
    await result('c1');
    const between = await step('t1', 1);
    expect(between.sent).toBe(false);
    expect(between.answer.toolUses).toEqual([]);
    expect(aborted).toEqual(['t1']);
    expect(prompts).toEqual([{ text: 'also check the tests', asUser: true }]);
    expect(fs.existsSync(user)).toBe(false);
    await hooks['turn.complete']($, { reason: 'aborted', isAborted: true }, pass);
    const ended = () => JSON.parse(fs.readFileSync(path.join(dir, 'turn-end.json'), 'utf8')) as { aborted: boolean };
    // Ended to deliver the message, not stopped: the chat doesn't say "Stopped."
    expect(ended().aborted).toBe(false);

    // A turn waiting in Poll ends for the message at once.
    await hooks['turn.start']($, { turnId: 't2' }, pass);
    await step('t2', 0);
    await call('p1', 'Poll');
    fs.writeFileSync(user, JSON.stringify('stop after this file'));
    await tick();
    expect(aborted).toEqual(['t1', 't2']);
    expect(prompts).toEqual([
      { text: 'also check the tests', asUser: true },
      { text: 'stop after this file', asUser: true },
    ]);
    await hooks['turn.complete']($, { reason: 'aborted', isAborted: true }, pass);
    expect(ended().aborted).toBe(false);

    // Stop ends a turn as stopped.
    await hooks['turn.start']($, { turnId: 't3' }, pass);
    await step('t3', 0);
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ abort: 1 }));
    await tick();
    expect(aborted).toEqual(['t1', 't2', 't3']);
    await hooks['turn.complete']($, { reason: 'aborted', isAborted: true }, pass);
    expect(ended().aborted).toBe(true);
  });
  it('runs a message that begins with / as a slash command, and says so when Claude Code refuses it', async () => {
    const dir = tmp('looper-mod-command-');
    const user = path.join(dir, 'chat-message.json');
    const module = path.join(dir, 'register.mjs');
    fs.writeFileSync(
      module,
      renderMod({
        files: { ready: path.join(dir, 'mod.json'), control: path.join(dir, 'c.json'), turnEnd: path.join(dir, 'turn-end.json'), usage: path.join(dir, 'u.json'), turn: path.join(dir, 't.json') },
        inbox: [user],
        userInbox: [user],
        signalCommands: [],
        guardMessage: '',
        headless: false,
        prompted: false,
        windows: false,
      }),
    );
    type Hook = ($: unknown, e: Record<string, unknown>, next: (e: Record<string, unknown>) => unknown) => unknown;
    const hooks: Record<string, Hook> = {};
    const { register } = (await import(pathToFileURL(module).href)) as { register: (on: (name: string, hook: Hook) => void) => void };
    register((name, hook) => (hooks[name] = hook));
    let tick: () => Promise<void> = async () => {};
    const prompts: unknown[] = [];
    const commands: unknown[] = [];
    const notices: unknown[] = [];
    const $ = {
      fs: {
        write: async (p: string, text: string) => fs.writeFileSync(p, text),
        read: async (p: string) => fs.readFileSync(p, 'utf8'),
        exists: async (p: string) => fs.existsSync(p),
      },
      process: { run: async (argv: string[]) => (fs.renameSync(argv[1], argv[2]), { exitCode: 0 }) },
      session: { id: async () => 's1', usage: async () => ({}) },
      ui: { log: (text: string) => void notices.push(text) },
      clock: { every: (_ms: number, fn: () => Promise<void>) => (tick = fn) },
      turn: { abort: async () => {} },
      prompt: {
        read: async () => ({ text: '', cursor: 0 }),
        submit: async (p: { text: string }) => {
          if (p.text.startsWith('/')) throw new Error('a text beginning with / would run a command as the user');
          prompts.push(p);
          return { text: p.text };
        },
      },
      command: {
        run: async (c: { command: string }) => {
          if (c.command !== 'pick-up') throw new Error('looper: $.command.run: unknown command /' + c.command);
          commands.push(c);
          return {};
        },
      },
    };
    await hooks['session.start']($, {}, async (x: unknown) => x);

    fs.writeFileSync(user, JSON.stringify('/pick-up elio costs'));
    await tick();
    expect(commands).toEqual([{ command: 'pick-up', args: 'elio costs' }]);
    expect(prompts).toEqual([]);
    expect(fs.existsSync(user)).toBe(false);

    fs.writeFileSync(user, JSON.stringify('/pikc-up'));
    await tick();
    expect(notices).toEqual(['couldn\'t send "/pikc-up": unknown command /pikc-up']);

    fs.writeFileSync(user, JSON.stringify('plain words'));
    await tick();
    expect(prompts).toEqual([{ text: 'plain words', asUser: true }]);
  });
});

describe('a Claude Code run on the mod', () => {
  it("merges the harness's --settings and --append-system-prompt into Looper's, and passes neither on", async () => {
    const ctx = makeCtx(`${MOD_READY}; looper-done success "ok"; sleep 0.3; printf '{"last_assistant_message":"r"}' > "$LOOPER_STOP_FILE"; sleep 30`, {}, [
      '--settings',
      '{"env":{"MINE":"1"},"permissions":{"allow":["Bash(npm:*)"]}}',
      '--append-system-prompt',
      'Answer in French.',
    ]);
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('done');
    const settings = JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'settings.json'), 'utf8'));
    expect(settings.env).toEqual({ MINE: '1' });
    expect(settings.permissions.allow).toEqual(['Bash(looper-done:*)', 'Bash(looper-done)', 'Bash(npm:*)']);
    expect(settings.hooks.Stop).toBeDefined();
    const argv = fs.readFileSync(path.join(ctx.runDir, 'argv.txt'), 'utf8').split('\n');
    expect(argv.filter((a) => a === '--settings')).toHaveLength(1);
    expect(argv.filter((a) => a === '--append-system-prompt')).toHaveLength(1);
    expect(argv).toContain('--plugin-dir');
    expect(fs.readFileSync(path.join(ctx.runDir, 'system.txt'), 'utf8').endsWith('\n\nAnswer in French.')).toBe(true);
  }, 30_000);

  it('ends a usage limit that StopFailure reports, retrying after the reset the mod saw', async () => {
    const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const usage = JSON.stringify({ rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], cost: { usd: 0.42 } });
    const failure = JSON.stringify({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You have hit your limit" });
    const ctx = makeCtx(`${MOD_READY}; printf '%s' '${usage}' > "$LOOPER_RUN_DIR/usage.json"; sleep 1.5; printf '%s' '${failure}' > "$LOOPER_RUN_DIR/stop-failure.json"; sleep 30`);
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('error');
    expect(end.headline).toBe("You have hit your limit");
    expect(end.retryAtMs).toBe(Date.parse(resetsAt) + 60_000);
    expect(end.costUsd).toBe(0.42);
  }, 30_000);

  it('ends with the API error StopFailure reports, as Claude Code worded it', async () => {
    const failure = JSON.stringify({ error: 'model_not_found', last_assistant_message: "There is an issue with the selected model." });
    const ctx = makeCtx(`${MOD_READY}; sleep 1.5; printf '%s' '${failure}' > "$LOOPER_RUN_DIR/stop-failure.json"; sleep 30`);
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('error');
    expect(end.headline).toBe("There is an issue with the selected model.");
    expect(end.network).toBeUndefined();
    expect(end.environment).toBeUndefined();
  }, 30_000);

  it('Stop asks the mod to end the turn instead of typing Esc', async () => {
    const ctx = makeCtx(`${MOD_READY}; sleep 30`);
    const handle = await startAgent(ctx, { onData: () => {} });
    await new Promise((r) => setTimeout(r, 2500));
    handle.stopTurn();
    expect(JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'mod-control.json'), 'utf8'))).toEqual({ abort: 1 });
    expect(handle.turnOver).toBe(true);
    await handle.stop();
  }, 30_000);

  /** A fake that asks permission as the hook would, then copies Looper's answer where the test reads it. */
  const ASKS = (dir: string) =>
    [
      MOD_READY,
      'mkdir -p "$LOOPER_RUN_DIR/permissions"',
      `printf '%s' '{"tool_name":"Bash","tool_input":{"command":"rm -rf build"}}' > "$LOOPER_RUN_DIR/permissions/1.req"`,
      'for i in $(seq 200); do [ -e "$LOOPER_RUN_DIR/permissions/1.ans" ] || [ -e "$LOOPER_RUN_DIR/permissions/1.cancel" ] && break; sleep 0.05; done',
      `cp "$LOOPER_RUN_DIR/permissions/1.ans" '${dir}/answer.json' 2>/dev/null; [ -e "$LOOPER_RUN_DIR/permissions/1.cancel" ] && touch '${dir}/cancelled'`,
      'rm -f "$LOOPER_RUN_DIR/permissions/1.req"',
      'sleep 30',
    ].join('\n');

  it("relays a permission request to Looper, and the user's answer goes back to the hook", async () => {
    const dir = tmp('looper-perm-');
    const ctx = makeCtx(ASKS(dir));
    const seen: (string | null)[] = [];
    let handle: Awaited<ReturnType<typeof startAgent>> | undefined;
    handle = await startAgent(ctx, {
      onData: () => {},
      onPermission: (p) => {
        seen.push(p ? `${p.tool}: ${(p.input as { command: string }).command}` : null);
        if (p) expect(handle!.answerPermission(p.id, true)).toBe(true);
      },
    });
    const settings = JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(5 * 60 + 60);
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'answer.json')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'answer.json'), 'utf8'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(seen).toEqual(['Bash: rm -rf build', null]);
    expect(handle.permission).toBeNull();
    await handle.stop();
  }, 30_000);

  it('denies a permission request nobody answers in time, telling the agent why', async () => {
    const dir = tmp('looper-perm-');
    const ctx = makeCtx(ASKS(dir), { ask: { allowed: false, waitMin: 0.01 } });
    const handle = await startAgent(ctx, { onData: () => {} });
    // The hook's redirect creates the file before it writes it: wait for the whole answer.
    const answer = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'answer.json'), 'utf8'));
      } catch {
        return null;
      }
    };
    for (let i = 0; i < 100 && !answer(); i++) await new Promise((r) => setTimeout(r, 50));
    const decision = answer().hookSpecificOutput.decision;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain("Nobody answered this permission request within");
    await handle.stop();
  }, 30_000);

  it('lets the hook go once the call was answered in the terminal', async () => {
    const dir = tmp('looper-perm-');
    const toolEnd = JSON.stringify({ tool: 'Bash', key: 'rm -rf build' }).replace('{', '{"at":9999999999999,');
    const fake = ASKS(dir).replace('mkdir -p', `(sleep 1.5; printf '%s' '${toolEnd}' > "$LOOPER_RUN_DIR/tool-end.json") & mkdir -p`);
    const ctx = makeCtx(fake);
    const seen: (string | null)[] = [];
    const handle = await startAgent(ctx, { onData: () => {}, onPermission: (p) => seen.push(p?.id ?? null) });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'cancelled')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(path.join(dir, 'cancelled'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'answer.json'))).toBe(false);
    expect(seen).toEqual(['1', null]);
    await handle.stop();
  }, 30_000);

  it('ends at once with the report when the final Stop comes before the done signal is read', async () => {
    // looper-done, then the turn's Stop right after: both land within the two polls that read the done file.
    const ctx = makeCtx(`looper-done success "Fixed it"; printf '{"last_assistant_message":"The report."}' > "$LOOPER_STOP_FILE"; sleep 30`);
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('done');
    expect(end.body).toBe('The report.');
    expect(end.durationMs).toBeLessThan(10_000);
  }, 30_000);

  it('deletes each live file whose row the transcript has, with nobody reading the conversation, and the folder when the session ends', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const row = (n: number) => JSON.stringify({ type: 'assistant', uuid: id(n), message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } });
    const ctx = makeCtx(
      [
        MOD_READY,
        `printf '{"session_id":"s","transcript_path":"%s"}' "$LOOPER_RUN_DIR/t.jsonl" > "$LOOPER_RUN_DIR/session.json"`,
        'mkdir -p "$LOOPER_RUN_DIR/live"',
        `printf '%s' '${row(1)}' > "$LOOPER_RUN_DIR/live/1-000000001-${id(1)}.json"`,
        `printf '%s' '${row(2)}' > "$LOOPER_RUN_DIR/live/1-000000002-${id(2)}.json"`,
        `printf '%s\\n' '${row(1)}' > "$LOOPER_RUN_DIR/t.jsonl"`,
        'sleep 30',
      ].join('\n'),
    );
    const handle = await startAgent(ctx, { onData: () => {} });
    const live = path.join(ctx.runDir, 'live');
    const first = path.join(live, `1-000000001-${id(1)}.json`);
    for (let i = 0; i < 100 && !(fs.existsSync(live) && !fs.existsSync(first)); i++) await new Promise((r) => setTimeout(r, 100));
    expect(fs.readdirSync(live)).toEqual([`1-000000002-${id(2)}.json`]);
    await handle.stop();
    expect(fs.existsSync(live)).toBe(false);
  }, 30_000);

  it("takes the report from the mod's record when the session exits before its Stop hook", async () => {
    const turnEnd = JSON.stringify({ answer: 'The full report.', aborted: false });
    const ctx = makeCtx(`${MOD_READY}; looper-done success "Fixed it"; sleep 0.3; printf '%s' '${turnEnd}' > "$LOOPER_RUN_DIR/turn-end.json"; exit 0`);
    const end = await (await startAgent(ctx, { onData: () => {} })).finished;
    expect(end.reason).toBe('done');
    expect(end.headline).toBe('Fixed it');
    expect(end.body).toBe('The full report.');
  }, 30_000);
});
