import { describe, expect, it } from 'vitest';
import { windowTitle } from '../src/shared/window-title';
import { ZOOM_STEPS, parseZooms, zoomKey, zoomStep } from '../src/main/platform/zoom-steps';

describe('windowTitle', () => {
  it('is the window kind alone, or the kind then the item it shows', () => {
    expect(windowTitle('Edit Project')).toBe('Edit Project');
    expect(windowTitle('Edit Project', 'Web app')).toBe('Edit Project – Web app');
  });

  it('ignores a blank item and trims the name', () => {
    expect(windowTitle('Edit Task', '   ')).toBe('Edit Task');
    expect(windowTitle('Edit Task', null)).toBe('Edit Task');
    expect(windowTitle('Edit Task', ' Issue triage ')).toBe('Edit Task – Issue triage');
  });
});

describe('zoomStep', () => {
  it('steps up and down through the levels and stops at the ends', () => {
    expect(zoomStep(1, 'in')).toBe(1.1);
    expect(zoomStep(1, 'out')).toBe(0.9);
    expect(zoomStep(ZOOM_STEPS[ZOOM_STEPS.length - 1], 'in')).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    expect(zoomStep(ZOOM_STEPS[0], 'out')).toBe(ZOOM_STEPS[0]);
  });

  it('goes back to 100% from any level', () => {
    expect(zoomStep(2, 'reset')).toBe(1);
    expect(zoomStep(0.5, 'reset')).toBe(1);
  });

  it('moves a factor between two levels to the next one in that direction', () => {
    expect(zoomStep(1.2, 'in')).toBe(1.25);
    expect(zoomStep(1.2, 'out')).toBe(1.1);
  });

  it('treats a bad factor as 100%', () => {
    expect(zoomStep(NaN, 'in')).toBe(1.1);
    expect(zoomStep(0, 'out')).toBe(0.9);
  });
});

describe('zoomKey', () => {
  it('knows the zoom keys, with the numpad and the shifted forms', () => {
    expect(zoomKey({ key: '=' })).toBe('in');
    expect(zoomKey({ key: '+' })).toBe('in');
    expect(zoomKey({ key: 'Add', code: 'NumpadAdd' })).toBe('in');
    expect(zoomKey({ key: '-' })).toBe('out');
    expect(zoomKey({ key: '_' })).toBe('out');
    expect(zoomKey({ key: 'Subtract', code: 'NumpadSubtract' })).toBe('out');
    expect(zoomKey({ key: '0' })).toBe('reset');
    expect(zoomKey({ key: 'a' })).toBeNull();
  });
});

describe('parseZooms', () => {
  it('keeps sensible factors by window kind and drops the rest', () => {
    expect(parseZooms({ zooms: { main: 1.25, sessions: 0.9, bad: 'x', huge: 50, same: 1, nan: null } })).toEqual({ main: 1.25, sessions: 0.9 });
    expect(parseZooms(null)).toEqual({});
    expect(parseZooms({ places: {} })).toEqual({});
  });
});
