/**
 * Looper's own document formats: `.loopertask` (an exported task) and
 * `.loopertpl` (an exported template). Both are pretty-printed JSON — the
 * definition's fields at the top level, plus a `$`-prefixed envelope:
 *
 *   $type     "looper/task" | "looper/template" — what the payload is
 *   $version  integer format version; bumped only on breaking changes
 *   $app      version of the Looper that wrote the file
 *
 * The envelope shape itself never changes, so any Looper — however old — can
 * read it and refuse a too-new file with a meaningful message instead of a
 * validation error. Additive payload changes (new optional fields) keep the
 * same $version; readers drop unknown fields.
 */

export type LooperFileKind = 'task' | 'template';

export const FILE_KINDS: Record<LooperFileKind, { ext: string; type: string; filterName: string }> = {
  task: { ext: 'loopertask', type: 'looper/task', filterName: 'Looper Task' },
  template: { ext: 'loopertpl', type: 'looper/template', filterName: 'Looper Template' },
};

export const FILE_VERSION = 1;

const EXT_RE = new RegExp(
  `\\.(${Object.values(FILE_KINDS)
    .map((k) => k.ext)
    .join('|')})$`,
  'i',
);

/** Whether a path/filename carries one of Looper's document extensions. */
export function isLooperFileName(name: string): boolean {
  return EXT_RE.test(name);
}

/** Wrap a definition for writing to disk. Envelope keys first, payload spread after. */
export function wrapLooperFile(kind: LooperFileKind, appVersion: string, payload: object): object {
  return { $type: FILE_KINDS[kind].type, $version: FILE_VERSION, $app: appVersion, ...payload };
}

export type ReadLooperFileResult =
  /** payload = the file minus its envelope keys, ready for the import sanitizer. */
  | { ok: true; kind: LooperFileKind; payload: Record<string, unknown> }
  /** `newer`: valid envelope but a format this build doesn't know; app = the writer's version. */
  | { ok: false; reason: 'not-looper' | 'newer'; app?: string };

/** Check the envelope of parsed file content and split off the payload. */
export function readLooperFile(input: unknown): ReadLooperFileResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'not-looper' };
  }
  const obj = input as Record<string, unknown>;
  const kind = (Object.keys(FILE_KINDS) as LooperFileKind[]).find((k) => FILE_KINDS[k].type === obj.$type);
  if (!kind) return { ok: false, reason: 'not-looper' };
  const version = obj.$version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'not-looper' };
  }
  if (version > FILE_VERSION) {
    return { ok: false, reason: 'newer', app: typeof obj.$app === 'string' ? obj.$app : undefined };
  }
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith('$')) payload[key] = value;
  }
  return { ok: true, kind, payload };
}
