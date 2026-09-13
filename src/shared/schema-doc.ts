import { z } from 'zod';
import { PERMISSION_MODES } from './environments';
import { TaskSchema } from './types';

/**
 * Machine-readable field reference generated from the task schema
 * (`looper schema`), so it can never drift from the code. One entry per
 * field, dotted paths; `required` only when the author must provide a value
 * (no default and not optional). A field inside an optional section is
 * required only once that section is present.
 */
export interface FieldDoc {
  path: string;
  type: string;
  required?: true;
  /** The effective default, with nested defaults filled in. */
  default?: unknown;
  /** Allowed values (enums; also the permission-mode union — see permissionModes for the per-kind lists). */
  values?: string[];
  pattern?: string;
}

function typeName(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) {
    return schema._def.checks.some((c) => c.kind === 'int') ? 'integer' : 'number';
  }
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodEnum) return 'enum';
  if (schema instanceof z.ZodArray) return `${typeName(schema.element as z.ZodTypeAny)}[]`;
  if (schema instanceof z.ZodRecord) return `record<${typeName(schema._def.valueType as z.ZodTypeAny)}>`;
  if (schema instanceof z.ZodObject) return 'object';
  return 'unknown';
}

function walk(schema: z.ZodTypeAny, path: string, out: FieldDoc[]): void {
  let inner = schema;
  let optional = false;
  let hasDefault = false;
  while (inner instanceof z.ZodDefault || inner instanceof z.ZodOptional) {
    if (inner instanceof z.ZodDefault) hasDefault = true;
    else optional = true;
    inner = inner._def.innerType as z.ZodTypeAny;
  }
  if (path) {
    const doc: FieldDoc = { path, type: typeName(inner) };
    if (!optional && !hasDefault) doc.required = true;
    if (hasDefault) {
      const parsed = schema.safeParse(undefined);
      if (parsed.success) doc.default = parsed.data;
    }
    if (inner instanceof z.ZodEnum) doc.values = [...(inner.options as string[])];
    if (inner instanceof z.ZodString) {
      const regex = inner._def.checks.find((c) => c.kind === 'regex');
      if (regex && regex.kind === 'regex') doc.pattern = regex.regex.source;
    }
    out.push(doc);
  }
  if (inner instanceof z.ZodObject) {
    for (const [key, sub] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
      walk(sub, path ? `${path}.${key}` : key, out);
    }
  }
}

export function describeSchema(schema: z.ZodTypeAny): FieldDoc[] {
  const out: FieldDoc[] = [];
  walk(schema, '', out);
  return out;
}

/** The `looper schema` payload: the task's field list plus the per-kind permission modes. */
export function taskSchemaDoc(): {
  task: FieldDoc[];
  permissionModes: Record<string, { value: string; label: string }[]>;
} {
  const task = describeSchema(TaskSchema);
  // The schema keeps permissionMode an open string (custom harnesses ignore
  // it); surface the union here and the per-kind lists below.
  const mode = task.find((f) => f.path === 'agent.permissionMode');
  if (mode) mode.values = [...new Set(Object.values(PERMISSION_MODES).flat().map(([v]) => v))];
  return {
    task,
    permissionModes: Object.fromEntries(
      Object.entries(PERMISSION_MODES).map(([kind, modes]) => [kind, modes.map(([value, label]) => ({ value, label }))]),
    ),
  };
}
