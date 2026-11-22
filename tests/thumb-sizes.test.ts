import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// A message's thumbnail is drawn at its size from its first frame (components/thumb-sizes.ts): drawn before its size
// was known, it grew when it loaded, and above the reader that pushed what they read.
const src = (file: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8');

describe('a message’s thumbnail', () => {
  it('is fitted in the size styles.css draws it at most', () => {
    const css = /\.chat-thumb img \{([^}]*)\}/.exec(src('styles.css'))?.[1] ?? '';
    const ts = src('components/thumb-sizes.ts');
    expect(css).toContain(`max-width: ${/const MAX_WIDTH = (\d+);/.exec(ts)?.[1]}px`);
    expect(css).toContain(`max-height: ${/const MAX_HEIGHT = (\d+);/.exec(ts)?.[1]}px`);
  });

  it('is drawn with its width and height, so its message doesn’t grow when it loads', () => {
    expect(src('components/ChatRows.tsx')).toMatch(/<img src=\{thumb\.src\} alt=\{name\} width=\{thumb\.width\} height=\{thumb\.height\} \/>/);
  });

  it('is fetched before the older items holding it are drawn', () => {
    expect(src('components/Conversation.tsx')).toContain('return prefetchThumbs(items, ctx.taskId);');
  });
});
