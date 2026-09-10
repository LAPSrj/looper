import { Cron } from 'croner';
import { z } from 'zod';
import { TaskSchema, TemplateSchema, type Environment, type Task, type TaskInput } from './types';
import { cronTz } from './cron';
import { pathFlavor } from './environments';

/** Whether croner accepts the IANA timezone name (it only checks on nextRun). */
function validTimezone(tz: string): boolean {
  try {
    new Cron('* * * * *', cronTz(tz)).nextRun();
    return true;
  } catch {
    return false;
  }
}

export type ValidationResult =
  | { ok: true; task: Task }
  | { ok: false; errors: string[] };

/** Editor field labels by schema path; error messages show these, not raw paths. */
const FIELD_LABELS: Record<string, string> = {
  id: 'Task id',
  name: 'Task name',
  enabled: 'Status',
  folderId: 'Folder',
  schedule: 'Schedule',
  'schedule.cron': 'Cron expression',
  'schedule.timezone': 'Timezone',
  environmentId: 'Environment',
  cwd: 'Working directory',
  env: 'Extra environment variables',
  check: 'Check',
  'check.command': 'Check command',
  'check.timeoutSec': 'Check timeout',
  classifier: 'Classifier',
  'classifier.harnessId': 'Classifier harness',
  'classifier.model': 'Classifier model',
  'classifier.prompt': 'Classifier prompt',
  'classifier.mode': 'Classifier session type',
  'classifier.timeoutSec': 'Classifier timeout',
  agent: 'Agent',
  'agent.harnessId': 'Harness',
  'agent.model': 'Model',
  'agent.prompt': 'Agent prompt',
  'agent.extraArgs': 'Extra command-line arguments',
  'agent.mode': 'Session type',
  'agent.session': 'Conversation',
  'agent.sessionMaxRuns': 'New conversation after',
  'agent.permissionMode': 'Permission mode',
  'agent.maxRuntimeMin': 'Max runtime',
  'agent.idleGraceMin': 'Idle grace',
  'agent.onIdleTimeout': 'When idle too long',
  backoff: 'Auto-pause after',
  'backoff.maxConsecutiveErrors': 'Auto-pause after',
  maxConcurrentRuns: 'Simultaneous runs',
  notifications: 'Notifications',
  'notifications.networkErrors': 'Include network errors',
  note: 'Note',
};

/** Longest known prefix wins, so nested/indexed paths fall back to their section label. */
function fieldLabel(path: (string | number)[]): string {
  const parts = path.filter((p): p is string => typeof p === 'string');
  for (let i = parts.length; i > 0; i--) {
    const label = FIELD_LABELS[parts.slice(0, i).join('.')];
    if (label) return label;
  }
  return path.join('.') || 'Task';
}

/** Zod's wording for the common cases, translated for the editor's error dialog. */
function issueMessage(issue: z.ZodIssue): string {
  if (issue.code === z.ZodIssueCode.too_small && issue.type === 'string') return 'must not be empty';
  if (issue.code === z.ZodIssueCode.invalid_type && issue.received === 'undefined') return 'is required';
  return issue.message;
}

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
      errors: parsed.error.issues.map((i) => `${fieldLabel(i.path)}: ${issueMessage(i)}`),
    };
  }
  const task = parsed.data;
  const errors: string[] = [];
  if (task.schedule.cron) {
    try {
      new Cron(task.schedule.cron);
    } catch (e) {
      errors.push(`Cron expression: ${(e as Error).message}`);
    }
  }
  if (task.schedule.timezone && !validTimezone(task.schedule.timezone)) {
    errors.push(`Timezone: unknown timezone "${task.schedule.timezone}"`);
  }
  // One rolling conversation cannot be resumed by two runs at the same time.
  if (task.maxConcurrentRuns > 1 && task.agent.session === 'continue') {
    errors.push('Simultaneous runs: a continued conversation cannot be shared by overlapping runs');
  }
  if (environments && task.environmentId) {
    const env = environments.find((e) => e.id === task.environmentId);
    if (!env) {
      errors.push(`Environment: unknown environment "${task.environmentId}"`);
    } else {
      if (task.agent.harnessId && !env.harnesses.some((h) => h.id === task.agent.harnessId)) {
        errors.push(`Harness: environment "${env.name}" has no harness "${task.agent.harnessId}"`);
      }
      if (task.cwd) {
        const flavor = pathFlavor(env, host);
        if (flavor === 'windows' && /^\//.test(task.cwd)) {
          errors.push(`Working directory: environment "${env.name}" expects a Windows path (C:\\...)`);
        }
        if (flavor === 'posix' && /^[A-Za-z]:[\\/]/.test(task.cwd)) {
          errors.push(`Working directory: environment "${env.name}" expects a POSIX path (/home/...)`);
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
  // A one-off run note is transient state, never part of an imported definition.
  delete draft.note;
  if (draft.schedule.cron) {
    try {
      new Cron(draft.schedule.cron);
    } catch {
      draft.schedule.cron = '';
    }
  }
  if (draft.schedule.timezone && !validTimezone(draft.schedule.timezone)) {
    delete draft.schedule.timezone;
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
