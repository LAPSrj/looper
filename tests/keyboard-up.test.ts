import { describe, expect, it } from 'vitest';
import { editingIn, keyboardUp, tallestTracker } from '../src/renderer/src/web/keyboard-up';

describe('keyboardUp', () => {
  it('sees the keyboard when a Home Screen app shrinks innerHeight with it', () => {
    const tallest = tallestTracker();
    // 932 pt tall at rest; with the keyboard iOS reports innerHeight 873 and a visible 560.
    expect(tallest(430, 932)).toBe(932);
    expect(keyboardUp(tallest(430, 873), 560, true)).toBe(true);
    // innerHeight shrunk all the way to the visible height: only the remembered 932 shows the keyboard.
    expect(keyboardUp(tallest(430, 780), 780, true)).toBe(true);
  });

  it('needs a field with the focus, so a shorter iPad window isn’t a keyboard', () => {
    const tallest = tallestTracker();
    tallest(1024, 1366);
    expect(keyboardUp(tallest(1024, 900), 900, false)).toBe(false);
    expect(keyboardUp(tallest(1024, 1366), 1300, true)).toBe(false);
  });

  it('keeps the tallest height for each width apart (portrait and landscape)', () => {
    const tallest = tallestTracker();
    tallest(430, 932);
    expect(tallest(932, 430)).toBe(430);
    expect(keyboardUp(tallest(932, 430), 250, true)).toBe(true);
  });
});

describe('editingIn', () => {
  it('finds a text field through iframes and leaves buttons and read-only fields out', () => {
    expect(editingIn({ activeElement: { tagName: 'TEXTAREA' } })).toBe(true);
    expect(editingIn({ activeElement: { tagName: 'TEXTAREA', readOnly: true } })).toBe(false);
    expect(editingIn({ activeElement: { tagName: 'INPUT', type: 'search' } })).toBe(true);
    expect(editingIn({ activeElement: { tagName: 'INPUT', type: 'checkbox' } })).toBe(false);
    expect(editingIn({ activeElement: { tagName: 'BUTTON' } })).toBe(false);
    expect(editingIn({ activeElement: { tagName: 'IFRAME', contentDocument: { activeElement: { tagName: 'DIV', isContentEditable: true } } } })).toBe(true);
    expect(editingIn({ activeElement: { tagName: 'IFRAME', contentDocument: null } })).toBe(false);
    expect(editingIn(null)).toBe(false);
  });
});
