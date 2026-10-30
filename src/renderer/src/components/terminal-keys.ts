// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.

/** The keys a phone's keyboard lacks, in the row above it. */
export type TermKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right' | '|' | '~' | '/' | '-';

export const KEY_ROW: readonly (readonly [TermKey, string])[] = [
  ['esc', 'Esc'],
  ['tab', 'Tab'],
  ['left', '←'],
  ['up', '↑'],
  ['down', '↓'],
  ['right', '→'],
  ['|', '|'],
  ['~', '~'],
  ['/', '/'],
  ['-', '-'],
];

const ARROW: Record<'up' | 'down' | 'left' | 'right', string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/**
 * What a key of the row sends. Arrows follow the terminal's cursor key mode
 * (application mode: ESC O A, as full-screen programs ask for), and with Ctrl
 * held send xterm's modified form (ESC [ 1 ; 5 A).
 */
export function keySequence(key: TermKey, opts: { ctrl: boolean; appCursor: boolean }): string {
  switch (key) {
    case 'esc':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      if (opts.ctrl) return `\x1b[1;5${ARROW[key]}`;
      return `\x1b${opts.appCursor ? 'O' : '['}${ARROW[key]}`;
    default:
      return opts.ctrl ? ctrlChord(key) : key;
  }
}

/**
 * A typed character with Ctrl held: letters and @[\]^_ become their control
 * codes (Ctrl+C is 0x03), space is NUL and ? is DEL. Anything else, and any
 * longer input (a paste, a word from autocorrect), goes as it is.
 */
export function ctrlChord(data: string): string {
  if (data.length !== 1) return data;
  const c = data.charCodeAt(0);
  if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c - 0x60);
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c - 0x40);
  if (data === ' ') return '\x00';
  if (data === '?') return '\x7f';
  return data;
}

/**
 * The sticky Ctrl key: tapped, it holds for the next key (from the row or the
 * keyboard), then lets go; tapped again first, it lets go without one.
 */
export class StickyCtrl {
  private held = false;

  get active(): boolean {
    return this.held;
  }

  toggle(): boolean {
    this.held = !this.held;
    return this.held;
  }

  /** What the terminal is sent for typed input: Ctrl applied once, if held. */
  typed(data: string): string {
    if (!this.held) return data;
    this.held = false;
    return ctrlChord(data);
  }

  /** What a key of the row sends: Ctrl applied once, if held. */
  key(key: TermKey, appCursor: boolean): string {
    const ctrl = this.held;
    this.held = false;
    return keySequence(key, { ctrl, appCursor });
  }
}

/** Font size steps for the terminal (no pinch zoom): the smallest still readable on a phone, up to large. */
export const FONT_SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20] as const;

export function stepFontSize(current: number, dir: 1 | -1): number {
  const at = FONT_SIZES.findIndex((s) => s >= current);
  const i = at === -1 ? FONT_SIZES.length - 1 : FONT_SIZES[at] === current ? at + dir : dir === 1 ? at : at - 1;
  return FONT_SIZES[Math.max(0, Math.min(FONT_SIZES.length - 1, i))];
}
