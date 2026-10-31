/** What a missing `--term-*` token in styles.css falls back to (the values `:root` defines). */
const TERM_FALLBACK = { bg: '#0f1115', fg: '#d7dae0', selection: '#3a4252' };

/** The terminal's colors from the `--term-*` tokens in styles.css, so the CSS-drawn terminals and xterm share one palette. */
export function termTheme(read: (token: string) => string): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const token = (name: string, fallback: string) => read(name).trim() || fallback;
  const foreground = token('--term-fg', TERM_FALLBACK.fg);
  return {
    background: token('--term-bg', TERM_FALLBACK.bg),
    foreground,
    cursor: foreground,
    selectionBackground: token('--term-selection', TERM_FALLBACK.selection),
  };
}
