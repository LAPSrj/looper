import type { TaskRuntime } from '../../shared/types';
import { readJson, writeJsonAtomic } from './fsutil';

interface StateFile {
  version: 1;
  updatedAt: string;
  tasks: Record<string, TaskRuntime>;
}

/** Runtime snapshot on disk: lets the CLI show state and lets startup reconcile interrupted runs. */
export class StateStore {
  private timer: NodeJS.Timeout | null = null;
  private pending: Record<string, TaskRuntime> | null = null;

  constructor(private readonly file: string) {}

  load(): Record<string, TaskRuntime> {
    const data = readJson<StateFile>(this.file, { version: 1, updatedAt: '', tasks: {} });
    return data.tasks ?? {};
  }

  save(tasks: Record<string, TaskRuntime>): void {
    this.pending = tasks;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const data: StateFile = { version: 1, updatedAt: new Date().toISOString(), tasks: this.pending };
    this.pending = null;
    try {
      writeJsonAtomic(this.file, data);
    } catch {
      /* state file is advisory */
    }
  }
}
