import { EventEmitter } from 'node:events';
import { validateTask } from '../../shared/validate';
import { DEFINITION_VERSION, migrateDefinition, type Definition } from '../../shared/migrate';
import type { Task } from '../../shared/types';
import { readJson, writeJsonAtomic } from './fsutil';
import { storeVersion } from './tasks';

interface TemplatesFile {
  version: number;
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
    const data = readJson<TemplatesFile>(this.file, { version: DEFINITION_VERSION, templates: [] });
    const version = storeVersion(data, this.file);
    this.templates.clear();
    for (let raw of data.templates ?? []) {
      if (version < DEFINITION_VERSION && raw && typeof raw === 'object') {
        raw = migrateDefinition(raw as unknown as Definition, version) as unknown as Task;
      }
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

  /** Persist a new template order. Unknown ids are ignored; missing known ids keep their relative order at the end. */
  reorder(ids: string[]): void {
    const next = new Map<string, Task>();
    for (const id of ids) {
      const t = this.templates.get(id);
      if (t) next.set(id, t);
    }
    for (const [id, t] of this.templates) if (!next.has(id)) next.set(id, t);
    this.templates = next;
    this.save();
    this.emit('change');
  }

  remove(id: string): boolean {
    if (!this.templates.has(id)) return false;
    this.templates.delete(id);
    this.save();
    this.emit('change');
    return true;
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: DEFINITION_VERSION, templates: this.list() });
  }
}
