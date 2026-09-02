import { Cron } from 'croner';
import { z } from 'zod';
import { TaskSchema, TemplateSchema, type Environment, type Task, type TaskInput } from './types';
import { pathFlavor } from './environments';

export type ValidationResult =
  | { ok: true; task: Task }
  | { ok: false; errors: string[] };

interface ValidateOpts {
  template?: boolean;
}

/**
 * Schema validation plus the checks zod cannot express (schedule syntax, and —
 * when the configured environments are provided — environment/harness
 * references and the cwd path style; the host is needed to decide the path
 * style of `local` environments).
 *
 * When `opts.template` is set, empty fields are allowed — templates are
 * intentionally incomplete, filled in when a task is created from them.
 */
export function validateTask(input: unknown, environments?: Environment[], host?: string, opts?: ValidateOpts): ValidationResult {
  const parsed = (opts?.template ? TemplateSchema : TaskSchema).safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const task = parsed.data;
  const errors: string[] = [];
  if (task.schedule.cron) {
    try {
      new Cron(task.schedule.cron);
    } catch (e) {
      errors.push(`schedule.cron: ${(e as Error).message}`);
    }
  }
  if (environments && task.environmentId) {
    const env = environments.find((e) => e.id === task.environmentId);
    if (!env) {
      errors.push(`environmentId: unknown environment "${task.environmentId}"`);
    } else {
      if (task.agent.harnessId && !env.harnesses.some((h) => h.id === task.agent.harnessId)) {
        errors.push(`agent.harnessId: environment "${env.name}" has no harness "${task.agent.harnessId}"`);
      }
      if (task.cwd) {
        const flavor = pathFlavor(env, host);
        if (flavor === 'windows' && /^\//.test(task.cwd)) {
          errors.push(`cwd: environment "${env.name}" expects a Windows path (C:\\...)`);
        }
        if (flavor === 'posix' && /^[A-Za-z]:[\\/]/.test(task.cwd)) {
          errors.push(`cwd: environment "${env.name}" expects a POSIX path (/home/...)`);
        }
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, task };
}

export interface ImportDraftOpts {
  environments: Environment[];
  host?: string;
  defaultEnvironmentId: string;
  /** Ids already in use; a colliding id is blanked so the editor derives a fresh one. */
  existingIds?: string[];
}

/**
 * Build an editor draft from untrusted JSON (File → Import Task). Every field
 * that passes its own schema is kept; anything missing or invalid falls back
 * to the schema default, an empty string, or is dropped, so the user fixes
 * the draft in the editor instead of being shown an error.
 */
export function importTaskDraft(input: unknown, opts: ImportDraftOpts): TaskInput {
  const draft = sanitize(TaskSchema, input) as TaskInput;
  delete draft.createdAt;
  delete draft.updatedAt;
  if (draft.schedule.cron) {
    try {
      new Cron(draft.schedule.cron);
    } catch {
      draft.schedule.cron = '';
    }
  }
  const env = opts.environments.find((e) => e.id === draft.environmentId);
  if (!env) draft.environmentId = opts.defaultEnvironmentId;
  const known = env ?? opts.environments.find((e) => e.id === opts.defaultEnvironmentId);
  if (known) {
    const hasHarness = (id?: string) => !id || known.harnesses.some((h) => h.id === id);
    if (!hasHarness(draft.agent.harnessId)) delete draft.agent.harnessId;
    if (draft.classifier && !hasHarness(draft.classifier.harnessId)) delete draft.classifier.harnessId;
    if (draft.cwd) {
      const flavor = pathFlavor(known, opts.host);
      if (flavor === 'windows' && /^\//.test(draft.cwd)) draft.cwd = '';
      if (flavor === 'posix' && /^[A-Za-z]:[\\/]/.test(draft.cwd)) draft.cwd = '';
    }
  }
  if (opts.existingIds?.includes(draft.id)) draft.id = '';
  return draft;
}

/** Field-by-field lenient parse: valid leaves are kept, the rest get defaults. */
function sanitize(schema: z.ZodTypeAny, value: unknown): unknown {
  let inner = schema;
  let optional = false;
  let hasDefault = false;
  while (inner instanceof z.ZodDefault || inner instanceof z.ZodOptional) {
    if (inner instanceof z.ZodDefault) hasDefault = true;
    else optional = true;
    inner = inner._def.innerType as z.ZodTypeAny;
  }
  if (inner instanceof z.ZodObject) {
    let obj = value;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      if (optional && !hasDefault) return undefined;
      obj = {};
    }
    const out: Record<string, unknown> = {};
    for (const [key, sub] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
      const v = sanitize(sub, (obj as Record<string, unknown>)[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (hasDefault) return schema.safeParse(undefined).data;
  if (optional) return undefined;
  if (inner instanceof z.ZodString) return '';
  if (inner instanceof z.ZodArray) return [];
  return undefined;
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
