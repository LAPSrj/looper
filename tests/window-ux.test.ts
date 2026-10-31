import { describe, expect, it } from 'vitest';
import { windowTitle } from '../src/shared/window-title';
import { fitContentHeight } from '../src/main/platform/placement';
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

describe('fitContentHeight', () => {
  const room = 800;

  it('sets the first fit exactly, shrinking a dialog with an empty band', () => {
    expect(fitContentHeight({ current: 545, wanted: 477.2, first: true, max: room })).toBe(478);
  });

  it('leaves a first fit that already matches', () => {
    expect(fitContentHeight({ current: 478, wanted: 477.5, first: true, max: room })).toBeNull();
  });

  it('only grows after the first fit, so a revealed field never brings a scroll bar back', () => {
    expect(fitContentHeight({ current: 478, wanted: 540, first: false, max: room })).toBe(540);
    expect(fitContentHeight({ current: 540, wanted: 478, first: false, max: room })).toBeNull();
  });

  it('never asks for more than the display has room for', () => {
    expect(fitContentHeight({ current: 500, wanted: 2000, first: true, max: room })).toBe(800);
    expect(fitContentHeight({ current: 800, wanted: 2000, first: false, max: room })).toBeNull();
  });

  it('ignores a measure that is not a height', () => {
    expect(fitContentHeight({ current: 500, wanted: 0, first: true, max: room })).toBeNull();
    expect(fitContentHeight({ current: 500, wanted: NaN, first: true, max: room })).toBeNull();
  });
});
