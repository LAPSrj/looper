import { describe, expect, it } from 'vitest';
import { CASCADE, cascade, fitToDisplays, parsePlaces, placeKey, placeMode, restoredBounds, type Rect } from '../src/main/platform/placement';

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
// A second display to the right, 150% scaling: 2560x1440 physical is 1707x960 DIPs.
const right = { workArea: { x: 1920, y: 0, width: 1707, height: 920 } };

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

describe('placeKey', () => {
  it('keys a window by its route, not the item it shows', () => {
    expect(placeKey('')).toBe('main');
    expect(placeKey('settings')).toBe('settings');
    expect(placeKey('editor/abc')).toBe('editor');
    expect(placeKey('messages/t/r/-/Title')).toBe('messages');
    expect(placeKey('terminal/s1/Title')).toBe('terminal');
  });

  it('tells the Chats window from a single chat window', () => {
    expect(placeKey('sessions')).toBe('sessions');
    expect(placeKey('sessions/abc')).toBe('sessions');
    expect(placeKey('sessions/abc/window')).toBe('chat');
  });

  it('gives every route of the same editor one place', () => {
    for (const h of ['editor', 'editor-in/p1', 'editor-from-template/t1', 'editor-import/k/update/builder/b']) expect(placeKey(h)).toBe('editor');
    expect(placeKey('template-import/k')).toBe('template-editor');
    expect(placeKey('project-new')).toBe(placeKey('project/p1'));
  });

  it('keys addon windows by addon and screen', () => {
    expect(placeKey('addon/servers/list/%7B%7D/Servers')).toBe('addon/servers/list');
    expect(placeKey('addon/servers/settings/%7B%7D/Settings')).toBe('addon/servers/settings');
  });
});

describe('placeMode', () => {
  it('restores bounds for modeless windows, size for modal ones', () => {
    expect(placeMode(false, true)).toBe('bounds');
    expect(placeMode(false, false)).toBe('position');
    expect(placeMode(true, true)).toBe('size');
    expect(placeMode(true, false)).toBe('none');
  });
});

describe('fitToDisplays', () => {
  it('keeps bounds that are on a display', () => {
    expect(fitToDisplays(rect(100, 80, 800, 600), [primary])).toEqual(rect(100, 80, 800, 600));
    expect(fitToDisplays(rect(2000, 50, 900, 700), [primary, right])).toEqual(rect(2000, 50, 900, 700));
  });

  it('drops bounds whose display is gone', () => {
    expect(fitToDisplays(rect(2000, 50, 900, 700), [primary])).toBeNull();
    expect(fitToDisplays(rect(-1500, 100, 900, 700), [primary, right])).toBeNull();
  });

  it('drops bounds whose title bar shows too little to grab', () => {
    // Only 40 px of the title bar on the primary display.
    expect(fitToDisplays(rect(1880, 100, 800, 600), [primary])).toBeNull();
    // Title bar below the work area.
    expect(fitToDisplays(rect(100, 1030, 800, 600), [primary])).toBeNull();
  });

  it('keeps a window partly off the screen when its title bar is on it', () => {
    expect(fitToDisplays(rect(1500, 600, 800, 600), [primary])).toEqual(rect(1500, 600, 800, 600));
  });

  it('brings a title bar above the work area down into it', () => {
    expect(fitToDisplays(rect(100, -10, 800, 600), [primary])).toEqual(rect(100, 0, 800, 600));
  });

  it('shrinks a window bigger than its display and moves it onto it', () => {
    // Saved on a 1920x1040 display, now on one at 150% scaling: fewer DIPs.
    expect(fitToDisplays(rect(1950, 20, 1900, 1000), [primary, right])).toEqual(rect(1920, 0, 1707, 920));
  });

  it('picks the display showing most of a window that spans two', () => {
    const fitted = fitToDisplays(rect(1700, 0, 1200, 1000), [primary, right]);
    // Most of it is on the right display, which is 920 tall: it shrinks to that height and moves onto it.
    expect(fitted).toEqual(rect(1920, 0, 1200, 920));
  });

  it('rejects malformed bounds', () => {
    expect(fitToDisplays(rect(Number.NaN, 0, 800, 600), [primary])).toBeNull();
    expect(fitToDisplays(rect(0, 0, 0, 600), [primary])).toBeNull();
  });
});

describe('cascade', () => {
  it('steps past open windows at the same spot', () => {
    const b = rect(100, 100, 800, 600);
    expect(cascade(b, [])).toEqual(b);
    expect(cascade(b, [rect(100, 100, 500, 500)])).toEqual(rect(100 + CASCADE, 100 + CASCADE, 800, 600));
    expect(cascade(b, [rect(100, 100, 1, 1), rect(100 + CASCADE, 100 + CASCADE, 1, 1)])).toEqual(rect(100 + 2 * CASCADE, 100 + 2 * CASCADE, 800, 600));
  });
});

describe('restoredBounds', () => {
  const current = rect(560, 220, 800, 600);

  it('restores bounds for a modeless window', () => {
    expect(restoredBounds({ saved: rect(2100, 40, 1000, 700), mode: 'bounds', current, displays: [primary, right] })).toEqual(
      rect(2100, 40, 1000, 700),
    );
  });

  it('cascades from an open window of the same kind', () => {
    expect(
      restoredBounds({ saved: rect(100, 100, 800, 600), mode: 'bounds', current, displays: [primary], taken: [rect(100, 100, 800, 600)] }),
    ).toEqual(rect(100 + CASCADE, 100 + CASCADE, 800, 600));
  });

  it('restores only the position of a fixed-size window', () => {
    expect(restoredBounds({ saved: rect(300, 200, 999, 999), mode: 'position', current, displays: [primary] })).toEqual(rect(300, 200, 800, 600));
  });

  it('centers a resizable modal dialog on its parent at its saved size', () => {
    expect(
      restoredBounds({ saved: rect(5000, 5000, 400, 300), mode: 'size', current, displays: [primary], parent: rect(100, 100, 1000, 800) }),
    ).toEqual(rect(400, 350, 400, 300));
  });

  it('keeps a centered dialog on the parent display', () => {
    // The parent sits at the right display's top: the dialog can't go above it.
    expect(
      restoredBounds({ saved: rect(0, 0, 600, 900), mode: 'size', current, displays: [primary, right], parent: rect(2000, 0, 800, 400) }),
    ).toEqual(rect(2100, 0, 600, 900));
  });

  it('restores nothing for a fixed-size modal dialog', () => {
    expect(restoredBounds({ saved: rect(0, 0, 400, 300), mode: 'none', current, displays: [primary] })).toBeNull();
  });

  it('falls back to the default place when the saved one is off every display', () => {
    expect(restoredBounds({ saved: rect(4000, 40, 1000, 700), mode: 'bounds', current, displays: [primary, right] })).toBeNull();
  });
});

describe('parsePlaces', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(
      parsePlaces({
        version: 1,
        places: {
          main: { bounds: rect(1, 2, 3, 4), maximized: true },
          chat: { bounds: rect(1, 2, 3, 4) },
          bad: { bounds: { x: 1, y: 2, width: 'wide', height: 4 } },
          worse: 7,
        },
      }),
    ).toEqual({ main: { bounds: rect(1, 2, 3, 4), maximized: true }, chat: { bounds: rect(1, 2, 3, 4), maximized: false } });
  });

  it('reads nothing from a file of another shape', () => {
    expect(parsePlaces(null)).toEqual({});
    expect(parsePlaces([])).toEqual({});
    expect(parsePlaces({ places: 'x' })).toEqual({});
  });
});
