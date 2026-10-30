import { describe, expect, it } from 'vitest';
import { FONT_SIZES, KEY_ROW, StickyCtrl, ctrlChord, keySequence, stepFontSize } from '../src/renderer/src/components/terminal-keys';

describe('terminal key row', () => {
  it('sends Esc, Tab and the symbols as they are', () => {
    const plain = { ctrl: false, appCursor: false };
    expect(keySequence('esc', plain)).toBe('\x1b');
    expect(keySequence('tab', plain)).toBe('\t');
    expect(keySequence('|', plain)).toBe('|');
    expect(keySequence('~', plain)).toBe('~');
    expect(keySequence('/', plain)).toBe('/');
    expect(keySequence('-', plain)).toBe('-');
  });

  it('sends arrows in the cursor key mode the terminal is in', () => {
    expect(keySequence('up', { ctrl: false, appCursor: false })).toBe('\x1b[A');
    expect(keySequence('down', { ctrl: false, appCursor: false })).toBe('\x1b[B');
    expect(keySequence('right', { ctrl: false, appCursor: true })).toBe('\x1bOC');
    expect(keySequence('left', { ctrl: false, appCursor: true })).toBe('\x1bOD');
  });

  it("sends Ctrl+arrow in xterm's modified form", () => {
    expect(keySequence('left', { ctrl: true, appCursor: false })).toBe('\x1b[1;5D');
    expect(keySequence('up', { ctrl: true, appCursor: true })).toBe('\x1b[1;5A');
  });

  it('turns a typed character into its control code', () => {
    expect(ctrlChord('c')).toBe('\x03');
    expect(ctrlChord('C')).toBe('\x03');
    expect(ctrlChord('a')).toBe('\x01');
    expect(ctrlChord('z')).toBe('\x1a');
    expect(ctrlChord('[')).toBe('\x1b');
    expect(ctrlChord('\\')).toBe('\x1c');
    expect(ctrlChord('_')).toBe('\x1f');
    expect(ctrlChord('@')).toBe('\x00');
    expect(ctrlChord(' ')).toBe('\x00');
    expect(ctrlChord('?')).toBe('\x7f');
    // Not a control key, or more than one character (a paste, an autocorrected word): as it is.
    expect(ctrlChord('1')).toBe('1');
    expect(ctrlChord('ls')).toBe('ls');
    expect(keySequence('|', { ctrl: true, appCursor: false })).toBe('|');
    expect(keySequence('-', { ctrl: true, appCursor: false })).toBe('-');
  });

  it('holds a sticky Ctrl for exactly one key, typed or from the row', () => {
    const ctrl = new StickyCtrl();
    expect(ctrl.typed('c')).toBe('c');
    expect(ctrl.toggle()).toBe(true);
    expect(ctrl.active).toBe(true);
    expect(ctrl.typed('c')).toBe('\x03');
    expect(ctrl.active).toBe(false);
    expect(ctrl.typed('c')).toBe('c');

    ctrl.toggle();
    expect(ctrl.key('up', false)).toBe('\x1b[1;5A');
    expect(ctrl.key('up', false)).toBe('\x1b[A');

    // Tapped twice: let go without a key.
    ctrl.toggle();
    expect(ctrl.toggle()).toBe(false);
    expect(ctrl.typed('d')).toBe('d');
  });

  it('lists Esc, Tab, the arrows and | ~ / -', () => {
    expect(KEY_ROW.map(([k]) => k)).toEqual(['esc', 'tab', 'left', 'up', 'down', 'right', '|', '~', '/', '-']);
  });

  it('steps the font size through the list, stopping at its ends', () => {
    expect(stepFontSize(13, 1)).toBe(14);
    expect(stepFontSize(13, -1)).toBe(12);
    expect(stepFontSize(15, 1)).toBe(16);
    expect(stepFontSize(15, -1)).toBe(14);
    expect(stepFontSize(FONT_SIZES[0], -1)).toBe(FONT_SIZES[0]);
    expect(stepFontSize(FONT_SIZES.at(-1)!, 1)).toBe(FONT_SIZES.at(-1));
    expect(stepFontSize(40, -1)).toBe(FONT_SIZES.at(-1));
  });
});
