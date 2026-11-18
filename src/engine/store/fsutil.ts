import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Copy a file (bytes, or a host file) into `dir` as `<prefix>-<its own name>`,
 * off the main thread, and return the copy's path. The name loses its folder
 * and the characters Windows refuses.
 */
export async function copyAttachment(
  dir: string,
  prefix: string,
  name: string,
  from: { data: Uint8Array } | { file: string },
): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const safe = path.basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'attachment';
  const file = path.join(dir, `${prefix}-${safe}`);
  if ('data' in from) await fs.promises.writeFile(file, from.data);
  else await fs.promises.copyFile(from.file, file);
  return file;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

/** Write via temp file + rename so a crash mid-write never leaves a torn file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** writeJsonAtomic without holding the thread on the disk; compact, for files only Looper reads. */
export async function writeJsonAtomicAsync(file: string, data: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.promises.rename(tmp, file);
}

export function writeText(file: string, text: string, mode?: number): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, { encoding: 'utf8', mode });
}

export function tail(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return '…' + text.slice(text.length - max);
}

export function fileExists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}
