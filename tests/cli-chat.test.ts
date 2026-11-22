import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/engine/engine';
import { levelProblem } from '../src/shared/cli-levels';
import { TaskSchema } from '../src/shared/types';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A headless Claude Code that logs its arguments and each message, and answers every one. */
function fakeClaude(dir: string): string {
  const js = join(dir, 'fake-claude.mjs');
  writeFileSync(
    js,
    `
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const dir = ${JSON.stringify(dir)};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
fs.appendFileSync(path.join(dir, 'argv'), process.argv.slice(2).join(' ') + '\\n');
// It ends with its input, so a test that stops early leaves nothing running.
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    return;
  }
  if (m.type !== 'user') return;
  fs.appendFileSync(path.join(dir, 'received'), m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('') + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
  out({ ...m, parent_tool_use_id: null, isReplay: true });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'hello' }] } });
  out({ type: 'result', subtype: 'success', result: 'hello' });
}).on('close', () => process.exit(0));
`,
  );
  const sh = join(dir, 'fake-claude');
  writeFileSync(sh, `#!/bin/sh\nexec node '${js}' "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

describe('looper chat in the engine', { timeout: 120_000 }, () => {
  let engine: Engine | null = null;
  let dataDir = '';
  afterEach(async () => {
    await engine?.stop();
    engine = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts a chat in the folder's project with the message, its title and model, listed, and shown only with open", async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'looper-engine-'));
    const dir = mkdtempSync(join(tmpdir(), 'looper-chat-'));
    const shown: string[] = [];
    engine = createEngine({ dataDir, authStatus: async () => Promise.reject(new Error('not asked in tests')), showChat: (id) => shown.push(id) });
    engine.start();
    engine.updateSettings({
      environments: engine.settings.environments.map((e) =>
        e.id === 'local' ? { ...e, shell: 'bash -c', harnesses: [{ id: 'fake', name: 'Fake', kind: 'claude-code' as const, command: fakeClaude(dir) }] } : e,
      ),
    });
    engine.saveProject({ name: 'Work', environmentId: 'local', harnessId: 'fake', cwd: dir, mode: 'headless' });

    /** Looper's answer to a command, or the reason it refused it. */
    const ask = async (method: string, params: Record<string, unknown> = {}) => engine!.request(method, params).catch((e: Error) => refused(e.message));
    const refused = (reason: string) => ({ status: 'rejected', reason });

    const first = (await ask('chat', { folder: dir, text: 'look at the build', title: 'Build check', model: 'opus' })) as string;
    const [id, line] = first.split('\n');
    expect(line).toBe(`Started a chat in Work (${dir}).`);
    expect(engine.sessionKind(id)).toBe('chat');
    await until(() => existsSync(join(dir, 'received')), 'the agent to get the message');
    expect(readFileSync(join(dir, 'received'), 'utf8')).toBe('look at the build\n');
    expect(readFileSync(join(dir, 'argv'), 'utf8')).toMatch(/--model opus/);
    await until(() => engine!.getChat(id)?.title === 'Build check', 'the title');
    expect(shown).toEqual([]);

    const secondId = ((await ask('chat', { folder: dir, text: 'and the tests', open: true })) as string).split('\n')[0];
    expect(shown).toEqual([secondId]);
    expect(secondId).not.toBe(id);

    expect(await ask('chat', { folder: join(dir, 'missing'), text: 'hi' })).toEqual(refused(`${join(dir, 'missing')} isn't a folder.`));
    expect(await ask('chat', { folder: dir, text: '  ' })).toEqual(refused('text must be given'));
    expect(await ask('chat', { folder: dir, text: 'hi', open: 'yes' })).toEqual(refused('open must be true or false'));

    engine.saveTask(TaskSchema.parse({ id: 't1', name: 'T1', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } }));
    engine.saveTask(TaskSchema.parse({ id: 't2', name: 'T2', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } }));
    // The commands that change a task, which every level allows.
    engine.updateSettings({ cliCommands: 'basic' });
    expect(await ask('pause', { taskId: 't1', reason: 'holiday' })).toBe('Paused "T1".');
    expect(engine.listRuntimes().find((r) => r.taskId === 't1')?.pausedReason).toBe('holiday');
    expect(await ask('resume', { taskId: 't1' })).toBe('Resumed "T1".');
    expect(await ask('disable', { taskId: 't2' })).toBe('Disabled "T2".');
    expect(engine.getTask('t2')?.enabled).toBe(false);
    expect(await ask('enable', { taskId: 't2' })).toBe('Enabled "T2".');
    expect(await ask('stop', { taskId: 't2' })).toEqual(refused('"T2" has no run in progress.'));
    expect(await ask('pause', { taskId: 'nope' })).toEqual(refused('No task has the id nope.'));
    const t3 = { name: 'T3', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } };
    expect(await ask('task-add', { task: t3 })).toBe('t3');
    expect(engine.getTask('t3')?.name).toBe('T3');
    expect(await ask('task-add', { task: t3 })).toEqual(refused('task t3 already exists: pass --update to change it, or give the new task another id'));
    expect(await ask('task-add', { task: { ...t3, name: 'T3 again', id: 't3' }, update: true })).toBe('t3');
    expect(engine.getTask('t3')?.name).toBe('T3 again');
    expect(await ask('remove', { taskId: 't3' })).toBe('Moved "T3 again" to the Recycle Bin.');
    engine.updateSettings({ cliCommands: 'standard' });
    expect(await ask('purge', { taskId: 't3' })).toBe('Deleted "T3 again" and its run history for good.');

    const sessions = (await ask('sessions')) as { id: string; kind: string; title: string; project: string }[];
    expect(sessions.map((s) => [s.id, s.kind, s.project])).toEqual(expect.arrayContaining([[id, 'chat', 'Work'], [secondId, 'chat', 'Work']]));

    expect(await ask('send', { ids: [id, 'nope'], text: 'never sent' })).toEqual(refused('No open chat, terminal session or run in progress has the id nope.'));
    expect(await ask('send', { ids: [id], text: 'and the docs' })).toBe('Sent to the chat "Build check".');
    await until(() => readFileSync(join(dir, 'received'), 'utf8').includes('and the docs'), 'the sent message');
    expect(readFileSync(join(dir, 'received'), 'utf8')).not.toContain('never sent');

    expect(await ask('rename', { id: secondId, name: 'Tests' })).toBe('Renamed the chat "Tests".');
    await until(() => engine!.getChat(secondId)?.title === 'Tests', 'the new name');
    expect(await ask('queue', { id })).toEqual([]);
    expect(await ask('configure', { id })).toEqual(refused('give a model, an effort, auto compact, a permission mode or a harness'));
    expect(await ask('configure', { id, effort: 'high' })).toBe('Set the effort of the chat "Build check".');
    expect(await ask('configure', { id, autoCompact: 'on' })).toBe('Set the auto compact of the chat "Build check".');
    expect(engine!.getChat(id)?.settings.autoCompact).toBe(true);
    expect(await ask('configure', { id, autoCompact: 'default' })).toBe('Set the auto compact of the chat "Build check".');
    expect(engine!.getChat(id)?.settings.autoCompact).toBeUndefined();
    expect(await ask('configure', { id, autoCompact: 'sometimes' })).toEqual(refused('auto compact is on, off or default'));
    const transcript = (await ask('transcript', { id })) as { title: string; rows: { text: string }[] };
    expect(transcript.title).toBe('Build check');
    expect(transcript.rows.some((r) => r.text.includes('look at the build'))).toBe(true);

    // Task History's list: the runs only, which a task or a result filter also asks for. T1 and T2 have no runs, and the chats aren't task runs.
    expect(await ask('history', { runs: true })).toEqual([]);
    expect(await ask('history', { task: 't1', result: 'success', hideSkipped: true, hideNoAction: true })).toEqual([]);
    expect(((await ask('history')) as { source: string }[]).some((h) => h.source === 'run')).toBe(false);

    expect(await ask('nope')).toEqual(refused("This Looper can't answer nope: it needs a newer Looper, or the desktop app (looper serve has no windows, addons or paired devices)."));
    expect(await ask('settings', { key: 'environments.nope' })).toEqual(refused('The settings have no environments.nope.'));
    expect(((await ask('settings', { key: 'environments' })) as { id: string }[]).map((e) => e.id)).toContain('local');

    const [folderId] = ((await ask('folder-add', { name: 'Ops' })) as string).split('\n');
    expect(await ask('move', { taskId: 't1', folder: 'Ops' })).toBe('Moved "T1" to the folder "Ops".');
    expect(engine.getTask('t1')?.folderId).toBe(folderId);
    expect(await ask('folder-remove', { folder: folderId })).toBe('Deleted the folder "Ops"; its tasks moved to the top level.');
    expect(engine.getTask('t1')?.folderId).toBeUndefined();

    expect(await ask('note', { taskId: 't1', note: 'check the cert' })).toBe('Set the guidance for the next run of "T1".');
    expect(engine.getTask('t1')?.note).toEqual({ text: 'check the cert', runsLeft: 1 });
    expect(await ask('note', { taskId: 't1', note: '' })).toBe('Cleared the guidance for the next run of "T1".');
    expect(engine.getTask('t1')?.note).toBeUndefined();

    expect(await ask('path', { id: 't1' })).toBe(dir);
    expect(await ask('path', { id, runDir: true })).toBe(engine.runDir(engine.getChat(id)!.taskId, id));
    expect(await ask('path', { id: '../x' })).toEqual(refused("id isn't an id: ../x"));

    const [templateId] = ((await ask('template-import', { template: { name: 'Tpl', trigger: { mode: 'manual' }, environmentId: 'local', cwd: dir, agent: { harnessId: 'fake', mode: 'headless', prompt: 'x' } } })) as string).split('\n');
    expect(templateId).toBe('tpl');
    expect(await ask('templates')).toEqual([{ id: 'tpl', name: 'Tpl' }]);
    expect(await ask('template-import', { template: { id: 'tpl', name: 'Again' } })).toEqual(refused('A template already has the id tpl: give this one another id.'));
    expect(await ask('template-remove', { id: templateId })).toBe('Deleted the template "Tpl".');

    engine.removeTask('t2');
    expect(((await ask('bin')) as { id: string }[]).map((b) => b.id)).toEqual(['t2']);
    expect(await ask('restore', { taskId: 't2' })).toBe('Restored "T2".');
    expect(await ask('purge', { taskId: 't2' })).toEqual(refused('No task in the Recycle Bin has the id t2.'));
    expect(Array.isArray(await ask('attention'))).toBe(true);

    // Each level refuses what's above it, and the app enforces it, not only the command-line tool.
    expect(await ask('environment-save', { environment: { name: 'Box' } })).toEqual(refused(levelProblem('extended', 'standard')));
    expect(await ask('configure', { id, permissionMode: 'plan' })).toEqual(refused(levelProblem('unrestricted', 'standard')));
    engine.updateSettings({ cliCommands: 'basic' });
    expect(await ask('sessions')).toEqual(refused(levelProblem('standard', 'basic')));
    engine.updateSettings({ cliCommands: 'unrestricted' });

    const [envId] = ((await ask('environment-save', { environment: { name: 'Box' } })) as string).split('\n');
    expect(engine.settings.environments.find((e) => e.id === envId)).toMatchObject({ name: 'Box', kind: 'local', harnesses: [{ name: 'Claude Code', kind: 'claude-code' }] });
    expect(await ask('environment-save', { id: envId, environment: { name: 'Box 2' } })).toBe(`${envId}\nSaved the environment "Box 2".`);
    const [harnessId] = ((await ask('harness-save', { environmentId: envId, harness: { name: 'Codex', kind: 'codex', command: 'codex' } })) as string).split('\n');
    expect(await ask('harness-remove', { environmentId: envId, id: harnessId })).toBe('Removed the harness "Codex" from "Box 2".');
    const last = engine.settings.environments.find((e) => e.id === envId)!.harnesses[0].id;
    expect(await ask('harness-remove', { environmentId: envId, id: last })).toEqual(refused('An environment needs at least one harness, so the last one of "Box 2" can\'t be removed.'));
    expect(await ask('environment-remove', { id: envId })).toBe('Removed the environment "Box 2".');

    const folder = mkdtempSync(join(tmpdir(), 'looper-project-'));
    const [projectId] = ((await ask('project-save', { project: { cwd: folder, extraArgs: ['--dangerously-skip-permissions'] } })) as string).split('\n');
    expect(engine.getProject(projectId)).toMatchObject({ cwd: folder, name: basename(folder), environmentId: 'local', extraArgs: [] });
    expect(await ask('project-save', { id: projectId, project: { name: 'Side' } })).toBe(`${projectId}\nSaved the project "Side".`);

    const chatsBefore = engine.settings.chats;
    expect(await ask('settings-set', { key: 'chats.confirmClose', value: !chatsBefore.confirmClose })).toBe('Set chats.confirmClose.');
    expect(engine.settings.chats).toEqual({ ...chatsBefore, confirmClose: !chatsBefore.confirmClose });

    const permissions = join(engine.runDir(engine.getChat(id)!.taskId, id), 'permissions');
    writeFileSync(join(permissions, 'req-1.req'), JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), 'utf8');
    await until(() => engine!.getChat(id)?.permissions.length === 1, 'the permission request');
    expect(await ask('allow', { id })).toBe('Allowed the Bash call in the chat "Build check".');
    expect(existsSync(join(permissions, 'req-1.ans'))).toBe(true);
    expect(engine.getChat(id)?.permissions).toEqual([]);
    expect(await ask('deny', { id })).toEqual(refused('The chat "Build check" isn\'t waiting on a permission answer.'));
    engine.updateSettings({ cliCommands: 'standard' });

    const { runId } = (await ask('run', { taskId: 't1' })) as { runId: string };
    expect(runId).toMatch(/\S/);
    // The fake agent may finish the run before the end arrives.
    const stopped = await ask('end', { id: runId });
    expect([`Stopped the run ${runId} of "T1".`, refused(`No open chat, terminal session, run or task has the id ${runId}.`)]).toContainEqual(stopped);
    await until(() => !engine!.listRuntimes().some((r) => r.runs.some((x) => x.runId === runId)), 'the run to end');

    expect(await ask('end', { id })).toBe('Closed the chat "Build check".');
    expect(engine.sessionKind(id)).toBeUndefined();
    expect(await ask('end', { id })).toEqual(refused(`No open chat, terminal session, run or task has the id ${id}.`));
    expect(await ask('end', { id: 't2' })).toEqual(refused('"T2" has no run in progress.'));
    expect(await ask('close-all')).toBe('Closed 1 conversation.');
    expect(engine.sessionKind(secondId)).toBeUndefined();

  });
});
