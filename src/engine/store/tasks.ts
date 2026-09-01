import { EventEmitter } from 'node:events';
import { validateTask } from '../../shared/validate';
import type { Environment, Task } from '../../shared/types';
import { readJson, writeJsonAtomic } from './fsutil';

interface TasksFile {
  version: 1;
  tasks: Task[];
}

export class TaskStore extends EventEmitter {
  private tasks = new Map<string, Task>();

  constructor(
    private file: string,
    /** Current environments, so environment/harness references are checked on load and save. */
    private readonly environments?: () => Environment[],
    private readonly host?: string,
  ) {
    super();
  }

  setFile(file: string): void {
    this.file = file;
    this.load();
  }

  load(): void {
    const data = readJson<TasksFile>(this.file, { version: 1, tasks: [] });
    this.tasks.clear();
    for (const raw of data.tasks ?? []) {
      const v = validateTask(raw, this.environments?.(), this.host);
      if (v.ok) this.tasks.set(v.task.id, v.task);
      else this.emit('invalid', raw, v.errors);
    }
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** Validate + persist. Throws with the joined error list on invalid input. */
  upsert(input: unknown): Task {
    const v = validateTask(input, this.environments?.(), this.host);
    if (!v.ok) throw new Error(v.errors.join('; '));
    const now = new Date().toISOString();
    const existing = this.tasks.get(v.task.id);
    const task: Task = {
      ...v.task,
      createdAt: existing?.createdAt ?? v.task.createdAt ?? now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.save();
    this.emit('change', task, existing ? 'update' : 'create', existing);
    return task;
  }

  patch(id: string, patch: Partial<Task>): Task {
    const existing = this.tasks.get(id);
    if (!existing) throw new Error(`unknown task ${id}`);
    return this.upsert({ ...existing, ...patch, id });
  }

  remove(id: string): boolean {
    const existing = this.tasks.get(id);
    if (!existing) return false;
    this.tasks.delete(id);
    this.save();
    this.emit('change', existing, 'remove');
    return true;
  }

  private save(): void {
    const data: TasksFile = { version: 1, tasks: this.list() };
    writeJsonAtomic(this.file, data);
  }
}
