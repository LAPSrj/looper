import { Cron } from 'croner';
import { TaskSchema, type Environment, type Task } from './types';
import { pathFlavor } from './environments';

export type ValidationResult =
  | { ok: true; task: Task }
  | { ok: false; errors: string[] };

/**
 * Schema validation plus the checks zod cannot express (schedule syntax, and —
 * when the configured environments are provided — environment/harness
 * references and the cwd path style; the host is needed to decide the path
 * style of `local` environments).
 */
export function validateTask(input: unknown, environments?: Environment[], host?: string): ValidationResult {
  const parsed = TaskSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const task = parsed.data;
  const errors: string[] = [];
  try {
    new Cron(task.schedule.cron);
  } catch (e) {
    errors.push(`schedule.cron: ${(e as Error).message}`);
  }
  if (environments) {
    const env = environments.find((e) => e.id === task.environmentId);
    if (!env) {
      errors.push(`environmentId: unknown environment "${task.environmentId}"`);
    } else {
      if (task.agent.harnessId && !env.harnesses.some((h) => h.id === task.agent.harnessId)) {
        errors.push(`agent.harnessId: environment "${env.name}" has no harness "${task.agent.harnessId}"`);
      }
      const flavor = pathFlavor(env, host);
      if (flavor === 'windows' && /^\//.test(task.cwd)) {
        errors.push(`cwd: environment "${env.name}" expects a Windows path (C:\\...)`);
      }
      if (flavor === 'posix' && /^[A-Za-z]:[\\/]/.test(task.cwd)) {
        errors.push(`cwd: environment "${env.name}" expects a POSIX path (/home/...)`);
      }
    }
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
