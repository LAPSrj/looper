import { describe, expect, it } from 'vitest';
import { CommandText } from '../src/engine/command-text';

const textOf = async (chunks: string[], cols = 80, rows = 10, resize?: { at: number; cols: number; rows: number }): Promise<string> => {
  let text = '';
  const t = new CommandText(cols, rows, (s) => (text += s));
  chunks.forEach((c, i) => {
    if (resize && resize.at === i) t.resize(resize.cols, resize.rows);
    t.write(c);
  });
  await t.end();
  return text;
};

describe('the text of a command run in a pseudo-terminal', () => {
  it('reads ConPTY output as the lines the command printed', async () => {
    // Recorded from wsl.exe under ConPTY (40 columns, 10 rows): a 100-character line, then more lines than the screen holds, a hidden prompt answered, and color.
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}\r\n`).join('');
    const raw =
      '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H' +
      'A'.repeat(100) +
      '\r\n\x1b]0;C:\\Windows\\System32\\wsl.exe\x07\x1b[?25hsecond\r\n' +
      lines +
      'Password:\x1b[1C\r\ngot:secret\r\n\x1b[31mred \x1b[mplain\x1b[K\r\n';
    const text = await textOf([raw.slice(0, 150), raw.slice(150, 400), raw.slice(400)], 40, 10);
    const want = ['A'.repeat(100), 'second', ...Array.from({ length: 40 }, (_, i) => `line${i + 1}`), 'Password:', 'got:secret', 'red plain'];
    expect(text).toBe(want.join('\n') + '\n');
  });

  it("leaves out ConPTY's repaint after a resize, and keeps what a carriage return left", async () => {
    // Recorded: resized to 60x8 and 90x12 before the command printed.
    const raw = [
      '\x1b[?9001h\x1b[?1004h',
      '\x1b[?25l\x1b[2J\x1b[m\x1b[H\r\n\r\n\r\n\r\n\r\n\r\n\r\n\x1b[H\x1b]0;wsl.exe\x07\x1b[?25h',
      '\x1b[?25l' + '\x1b[K\r\n'.repeat(11) + '\x1b[K\x1b[H\x1b[?25h',
      'before1\r\nbefore2\r\nprogress 10%\rprogress 99%\r\ncol1\x1b[6Ccol2\r\n\r\nafter1\r\n',
    ];
    const text = await textOf(raw, 120, 32, { at: 1, cols: 60, rows: 8 });
    expect(text).toBe('before1\nbefore2\nprogress 99%\ncol1      col2\n\nafter1\n');
  });

  it('keeps every line of output far longer than the screen and its scrollback', async () => {
    const n = 25_000;
    const chunks: string[] = [];
    for (let i = 0; i < n; i += 500) chunks.push(Array.from({ length: 500 }, (_, k) => `row ${i + k}\r\n`).join(''));
    const text = await textOf(chunks, 80, 24);
    const rows = text.trimEnd().split('\n');
    expect(rows.length).toBe(n);
    expect(rows[0]).toBe('row 0');
    expect(rows[n - 1]).toBe(`row ${n - 1}`);
  });
});
