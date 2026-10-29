import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../src/engine/store/projects';
import { TaskStore } from '../src/engine/store/tasks';
import { agentArgs, deriveTask, folderName, projectHarnessIn, sameFolder, taskEnv } from '../src/shared/projects';
import { EnvironmentSchema, type Environment, type Task } from '../src/shared/types';

const envs: Environment[] = [
  EnvironmentSchema.parse({
    id: 'wsl',
    name: 'WSL',
    kind: 'wsl',
    harnesses: [
      { id: 'claude', name: 'Claude Code', kind: 'claude-code', command: 'claude' },
      { id: 'codex', name: 'Codex', kind: 'codex', command: 'codex' },
    ],
  }),
  EnvironmentSchema.parse({
    id: 'wsl2',
    name: 'WSL (zsh)',
    kind: 'wsl',
    harnesses: [
      { id: 'codex2', name: 'Codex', kind: 'codex', command: 'codex' },
      { id: 'claude2', name: 'Claude Code', kind: 'claude-code', command: 'claude' },
    ],
  }),
];

const input = (id: string, cwd: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  trigger: { mode: 'manual' as const },
  environmentId: 'wsl',
  cwd,
  agent: { prompt: 'go' },
  ...extra,
});

function stores(file = join(mkdtempSync(join(tmpdir(), 'looper-projects-')), 'tasks.json')) {
  const projects = new ProjectStore(join(file, '..', 'projects.json'), () => envs, 'linux');
  const tasks = new TaskStore(file, () => envs, 'linux', undefined, projects);
  projects.load();
  tasks.load();
  // As the engine does: a changed project's tasks take its values.
  projects.on('change', (p: { id: string }, kind: string) => {
    if (kind !== 'remove') tasks.rederive(p.id);
  });
  return { projects, tasks, file };
}

describe('projects', () => {
  it('files a task with a new folder under a project made from it, named after the folder', () => {
    const { projects, tasks } = stores();
    const t = tasks.upsert(input('a', '/home/me/site/', { agent: { prompt: 'go', harnessId: 'codex' } }));
    expect(projects.list()).toHaveLength(1);
    const p = projects.list()[0];
    expect(p).toMatchObject({ id: 'site', name: 'site', environmentId: 'wsl', cwd: '/home/me/site', harnessId: 'codex', remote: false });
    expect(t).toMatchObject({ projectId: 'site', cwd: '/home/me/site', overrideEnvironment: false, overrideAgent: false });
  });

  it("puts a second task of the folder in the same project, keeping agent settings other than the project's as an override", () => {
    const { projects, tasks } = stores();
    tasks.upsert(input('a', '/home/me/site'));
    const b = tasks.upsert(input('b', '/home/me/site', { agent: { prompt: 'go', harnessId: 'codex' } }));
    const c = tasks.upsert(input('c', '/home/me/site', { agent: { prompt: 'go', harnessId: 'claude' } }));
    expect(projects.list()).toHaveLength(1);
    expect(b).toMatchObject({ projectId: 'site', overrideAgent: true, agent: { harnessId: 'codex' } });
    // The environment's first harness is the project's own, named or not.
    expect(c.overrideAgent).toBe(false);
  });

  it("moves a project's tasks with it, except the values a task overrides", () => {
    const { projects, tasks } = stores();
    tasks.upsert(input('a', '/home/me/site'));
    tasks.upsert(input('b', '/home/me/site', { agent: { prompt: 'go', harnessId: 'codex' } }));
    const changed: string[] = [];
    tasks.on('change', (t: Task) => changed.push(t.id));
    expect(projects.get('site')!.harnessId).toBe('claude');
    projects.upsert({ ...projects.get('site')!, cwd: '/home/me/website', environmentId: 'wsl2', harnessId: 'claude2' });
    expect(changed.sort()).toEqual(['a', 'b']);
    expect(tasks.get('a')).toMatchObject({ cwd: '/home/me/website', environmentId: 'wsl2', agent: { harnessId: 'claude2' } });
    // b's own harness isn't in the new environment, so it follows the project too.
    expect(tasks.get('b')).toMatchObject({ cwd: '/home/me/website', environmentId: 'wsl2', overrideAgent: false, agent: { harnessId: 'claude2' } });
    // A save of the task as listed (the windows' { ...task, enabled }) changes nothing else.
    const a = tasks.get('a')!;
    tasks.upsert({ ...a, enabled: false });
    expect(tasks.get('a')).toMatchObject({ projectId: 'site', cwd: '/home/me/website', enabled: false });
  });

  it("gives a task the project's session type, model, effort and permission mode until it overrides them", () => {
    const { projects, tasks } = stores();
    tasks.upsert(input('a', '/home/me/site', { agent: { prompt: 'go', model: 'opus', mode: 'headless', permissionMode: 'plan' } }));
    expect(projects.get('site')).toMatchObject({ model: 'opus', mode: 'headless', permissionMode: 'plan' });
    // A folder's next task with other settings keeps them as an override.
    const b = tasks.upsert(input('b', '/home/me/site', { agent: { prompt: 'go', model: 'sonnet', mode: 'headless', permissionMode: 'plan' } }));
    expect(b).toMatchObject({ overrideAgent: true, agent: { model: 'sonnet' } });
    projects.upsert({ ...projects.get('site')!, model: 'haiku', mode: 'interactive', permissionMode: 'acceptEdits', effort: 'high' });
    expect(tasks.get('a')!.agent).toMatchObject({ model: 'haiku', mode: 'interactive', permissionMode: 'acceptEdits', effort: 'high' });
    expect(tasks.get('b')!.agent).toMatchObject({ model: 'sonnet', mode: 'headless', permissionMode: 'plan' });
    // Turning the override off takes the project's settings back.
    tasks.upsert({ ...tasks.get('b')!, overrideAgent: false });
    expect(tasks.get('b')!.agent).toMatchObject({ model: 'haiku', mode: 'interactive', permissionMode: 'acceptEdits', effort: 'high' });
  });

  it("gives a task in another environment the defaults when the project's harness kind isn't there", () => {
    const { projects, tasks } = stores();
    tasks.upsert(input('a', '/home/me/site', { agent: { prompt: 'go', model: 'opus', permissionMode: 'plan' } }));
    const onlyCodex = { ...envs[1], id: 'codex-only', harnesses: [envs[1].harnesses[0]] };
    envs.push(onlyCodex);
    try {
      const a = tasks.upsert({ ...tasks.get('a')!, overrideEnvironment: true, environmentId: 'codex-only' });
      expect(a.agent.permissionMode).toBe('auto');
      expect([a.agent.harnessId, a.agent.model]).toEqual([undefined, undefined]);
      expect(projects.get('site')!.model).toBe('opus');
    } finally {
      envs.pop();
    }
  });

  it("copies the project's arguments and variables into its tasks, under the task's own", () => {
    const { projects, tasks } = stores();
    tasks.upsert(input('a', '/home/me/site', { env: { SHARED: 'task' }, agent: { prompt: 'go', extraArgs: ['--task'] } }));
    projects.upsert({ ...projects.get('site')!, extraArgs: ['--project'], env: { SHARED: 'project', ONLY_PROJECT: '1' } });
    const a = tasks.get('a')!;
    expect(agentArgs(a)).toEqual(['--project', '--task']);
    expect(taskEnv(a)).toEqual({ SHARED: 'task', ONLY_PROJECT: '1' });
    // The task's own stay its own: the project's never move into them.
    expect([a.env, a.agent.extraArgs]).toEqual([{ SHARED: 'task' }, ['--task']]);
  });

  it('keeps an overridden environment when the project changes its own', () => {
    const { projects, tasks } = stores();
    tasks.upsert(input('a', '/home/me/site'));
    tasks.upsert({ ...tasks.get('a')!, overrideEnvironment: true, environmentId: 'wsl2' });
    projects.upsert({ ...projects.get('site')!, model: 'opus' });
    expect(tasks.get('a')).toMatchObject({ environmentId: 'wsl2', overrideEnvironment: true });
    projects.upsert({ ...projects.get('site')!, environmentId: 'wsl2', harnessId: 'claude2' });
    projects.upsert({ ...projects.get('site')!, environmentId: 'wsl', harnessId: 'claude' });
    expect(tasks.get('a')!.environmentId).toBe('wsl2');
  });

  it("moves a task saved with another folder to that folder's project", () => {
    const { projects, tasks } = stores();
    tasks.upsert(input('a', '/home/me/site'));
    tasks.upsert({ ...tasks.get('a')!, cwd: '/home/me/blog' });
    expect(projects.list().map((p) => p.id).sort()).toEqual(['blog', 'site']);
    expect(tasks.get('a')).toMatchObject({ projectId: 'blog', cwd: '/home/me/blog' });
  });

  it('loads a version 2 file, making one project per folder, and finds the same projects on the next load', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'looper-projects-')), 'tasks.json');
    writeFileSync(
      file,
      JSON.stringify({ version: 2, tasks: [input('a', '/home/me/site'), input('b', '/home/me/site/'), input('c', '/home/me/blog')] }),
    );
    const first = stores(file);
    expect(first.projects.list().map((p) => p.id)).toEqual(['site', 'blog']);
    expect(first.tasks.list().map((t) => t.projectId)).toEqual(['site', 'site', 'blog']);
    const again = stores(file);
    expect(again.projects.list()).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(file, '..', 'projects.json'), 'utf8')).projects).toHaveLength(2);
  });

  it('restores a deleted task whose project is gone into a new project for its folder', () => {
    const { projects, tasks } = stores();
    tasks.upsert(input('a', '/home/me/site'));
    tasks.remove('a');
    projects.remove('site');
    expect(tasks.restore('a')).toMatchObject({ projectId: 'site', cwd: '/home/me/site' });
    expect(projects.list()).toHaveLength(1);
  });

  it("refuses a second project for a folder, and a folder of the other environment's kind", () => {
    const { projects } = stores();
    projects.upsert(projects.draft('wsl', '/home/me/site'));
    expect(() => projects.upsert({ ...projects.draft('wsl', '/home/me/site/'), id: 'other' })).toThrow(/already has this folder/);
    expect(() => projects.upsert(projects.draft('wsl', 'C:\\work'))).toThrow(/expects a POSIX path/);
  });
});

describe('project helpers', () => {
  const project = { id: 'p', name: 'p', environmentId: 'wsl', cwd: '/home/me/p', harnessId: 'codex', permissionMode: 'auto', mode: 'interactive' as const, extraArgs: [], env: {}, remote: false };

  it('compares folders without trailing separators, and Windows ones without case', () => {
    expect(sameFolder('/home/me/site/', '/home/me/site')).toBe(true);
    expect(sameFolder('/home/me/Site', '/home/me/site')).toBe(false);
    expect(sameFolder('C:\\Work\\Site\\', 'c:\\work\\site')).toBe(true);
    expect(folderName('/home/me/site/')).toBe('site');
    expect(folderName('C:\\Work\\Site')).toBe('Site');
  });

  it("gives a task in another environment the project's harness of the same kind there", () => {
    expect(projectHarnessIn(project, 'wsl', envs)).toBe('codex');
    expect(projectHarnessIn(project, 'wsl2', envs)).toBe('codex2');
    expect(projectHarnessIn({ ...project, harnessId: undefined }, 'wsl2', envs)).toBe('claude2');
  });

  it("derives a task's folder, environment and harness from its project unless it overrides them", () => {
    const task = { ...input('a', '/elsewhere'), environmentId: 'wsl2', agent: { prompt: 'go', harnessId: 'claude2' } } as unknown as Task;
    expect(deriveTask({ ...task, overrideEnvironment: false, overrideAgent: false }, project, envs)).toMatchObject({
      projectId: 'p',
      cwd: '/home/me/p',
      environmentId: 'wsl',
      agent: { harnessId: 'codex' },
    });
    expect(deriveTask({ ...task, overrideEnvironment: true, overrideAgent: false }, project, envs)).toMatchObject({
      environmentId: 'wsl2',
      agent: { harnessId: 'codex2' },
    });
    expect(deriveTask({ ...task, overrideEnvironment: true, overrideAgent: true }, project, envs).agent.harnessId).toBe('claude2');
  });
});
