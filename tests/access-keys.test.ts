import { describe, expect, it } from 'vitest';
import { assignAccessKeys, NO_ACCESS_KEY } from '../src/renderer/src/components/access-key-assign';

// A dialog's access keys (Win32 dialog boxes: "Whenever possible, assign unique access keys to all interactive controls
// or their labels"; OK, Cancel and Close have none, since Enter and Esc are theirs). scratch/component-audit/tools/
// desktop.mjs presses Alt in every dialog of the built app and fails on a letter underlined twice.
const keysOf = (labels: string[]) => assignAccessKeys(labels).map((k) => k.key);

describe('access keys', () => {
  it('gives each label a different key', () => {
    const labels = ['Save', 'Apply', 'Task name', 'Status', 'Project', 'Working directory', 'Environment', 'Settings', 'Schedule', 'Start', 'Stop'];
    const keys = keysOf(labels).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(labels.length);
  });

  it('prefers the first letter of a word, in the order of priority, then any letter of the label', () => {
    expect(keysOf(['Save', 'Status', 'Show notifications'])).toEqual(['s', 't', 'n']);
    expect(keysOf(['Working directory', 'Default arguments'])).toEqual(['w', 'd']);
    const [k] = assignAccessKeys(['Model id']);
    expect(k).toEqual({ key: 'm', index: 0 });
    expect(assignAccessKeys(['Low', 'Large'])[1]).toEqual({ key: 'a', index: 1 });
  });

  it('leaves a label without a key once its letters are all taken', () => {
    expect(keysOf(['ab', 'ba', 'ab'])).toEqual(['a', 'b', '']);
  });

  it('never gives one to OK, Cancel or Close', () => {
    expect([...NO_ACCESS_KEY].sort()).toEqual(['Cancel', 'Close', 'OK']);
  });
});
