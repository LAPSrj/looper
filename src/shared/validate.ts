import { Cron } from 'croner';
import { TaskSchema, type Task } from './types';
import { parseDuration } from './duration';

export type ValidationResult =
  | { ok: true; task: Task }
  | { ok: false; errors: string[] };

/** Schema validation plus the checks zod cannot express (schedule syntax). */
export function validateTask(input: unknown): ValidationResult {
  const parsed = TaskSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const task = parsed.data;
  const errors: string[] = [];
  if ('every' in task.schedule) {
    try {
      parseDuration(task.schedule.every);
    } catch (e) {
      errors.push(`schedule.every: ${(e as Error).message}`);
    }
  } else {
    try {
      new Cron(task.schedule.cron);
    } catch (e) {
      errors.push(`schedule.cron: ${(e as Error).message}`);
    }
  }
  if (task.target.kind === 'windows' && /^\//.test(task.cwd)) {
    errors.push('cwd: windows target expects a Windows path (C:\\...)');
  }
  if (task.target.kind === 'wsl' && /^[A-Za-z]:[\\/]/.test(task.cwd)) {
    errors.push('cwd: wsl target expects a Linux path (/home/...)');
  }
  return errors.length ? { ok: false, errors } : { ok: true, task };
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}
