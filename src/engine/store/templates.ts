import { EventEmitter } from 'node:events';
import { validateTask } from '../../shared/validate';
import type { Task } from '../../shared/types';
import { readJson, writeJsonAtomic } from './fsutil';

interface TemplatesFile {
  version: 1;
  templates: Task[];
}

export class TemplateStore extends EventEmitter {
  private templates = new Map<string, Task>();

  constructor(private file: string) {
    super();
  }

  setFile(file: string): void {
    this.file = file;
    this.load();
  }

  load(): void {
    const data = readJson<TemplatesFile>(this.file, { version: 1, templates: [] });
    this.templates.clear();
    for (const raw of data.templates ?? []) {
      const v = validateTask(raw, undefined, undefined, { template: true });
      if (v.ok) this.templates.set(v.task.id, v.task);
      else this.emit('invalid', raw, v.errors);
    }
  }

  list(): Task[] {
    return [...this.templates.values()];
  }

  get(id: string): Task | undefined {
    return this.templates.get(id);
  }

  upsert(input: unknown): Task {
    const v = validateTask(input, undefined, undefined, { template: true });
    if (!v.ok) throw new Error(v.errors.join('; '));
    const now = new Date().toISOString();
    const existing = this.templates.get(v.task.id);
    const template: Task = {
      ...v.task,
      createdAt: existing?.createdAt ?? v.task.createdAt ?? now,
      updatedAt: now,
    };
    this.templates.set(template.id, template);
    this.save();
    this.emit('change');
    return template;
  }

  remove(id: string): boolean {
    if (!this.templates.has(id)) return false;
    this.templates.delete(id);
    this.save();
    this.emit('change');
    return true;
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: 1, templates: this.list() });
  }
}
