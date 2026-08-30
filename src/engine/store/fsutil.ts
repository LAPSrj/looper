import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
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
