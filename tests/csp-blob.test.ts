import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// @silurus/ooxml decodes a deck's SVGs, audio and video through blob: URLs (URL.createObjectURL), and iOS draws decks on the page.
const policies: Record<string, string> = {
  'index.html (desktop and the served page)': fs.readFileSync('src/renderer/index.html', 'utf8'),
  'the remote server header': fs.readFileSync('src/main/remote-access/server.ts', 'utf8'),
};

describe.each(Object.entries(policies))('CSP in %s', (_name, text) => {
  it('lets images and media come from blob:, and nothing wider', () => {
    const img = /img-src ([^;"]*)/.exec(text)?.[1];
    const media = /media-src ([^;"]*)/.exec(text)?.[1];
    expect(img?.trim().split(/\s+/)).toEqual(["'self'", 'data:', 'blob:']);
    expect(media?.trim().split(/\s+/)).toEqual(["'self'", 'blob:']);
  });
});
