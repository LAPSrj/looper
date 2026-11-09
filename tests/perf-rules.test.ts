import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'src');
const files = (dir: string, ext: RegExp): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name), ext) : ext.test(e.name) ? [path.join(dir, e.name)] : []));
const rel = (f: string) => path.relative(RENDERER, f).replace(/\\/g, '/');

describe('performance rules (CLAUDE.md, Performance)', () => {
  it('pages take engine events through events.ts alone', () => {
    // On the desktop each listener of the preload's gets its own copy of every event across contextBridge,
    // and a chat's events only make sense applied in order by events.ts (shared/chat-delta.ts).
    const offenders = files(RENDERER, /\.tsx?$/)
      .filter((f) => rel(f) !== 'events.ts')
      .filter((f) => /window\.looper\.onEvent\(/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no stylesheet puts :has() on the whole document', () => {
    // html:has(…) made every inserted element recheck the whole document's style.
    const offenders = files(RENDERER, /\.css$/).flatMap((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /(^|[\s,(])(html|body|:root)(\.[\w-]+|\[[^\]]*\])*:has\(/.test(line))
        .map(({ i }) => `${rel(f)}:${i + 1}`),
    );
    expect(offenders).toEqual([]);
  });
});
