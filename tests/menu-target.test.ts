import { describe, expect, it } from 'vitest';
import { MenuTarget } from '../src/renderer/src/menu-target';

describe('the task a context menu is open for', () => {
  it('acts on the selected task when no row was long-pressed', () => {
    const t = new MenuTarget();
    expect(t.take('selected')).toBe('selected');
    expect(t.take<string | null>(null)).toBeNull();
  });

  it('a long-pressed row’s task takes the command, not the selection', () => {
    const t = new MenuTarget();
    t.set('pressed');
    expect(t.current).toBe('pressed');
    expect(t.take('selected')).toBe('pressed');
  });

  it('the command uses the target up: the next one acts on the selection again', () => {
    const t = new MenuTarget();
    t.set('pressed');
    t.take('selected');
    expect(t.take('selected')).toBe('selected');
  });

  it('a menu dismissed without a command leaves no target behind', () => {
    const t = new MenuTarget();
    t.set('pressed');
    t.clear();
    expect(t.take('selected')).toBe('selected');
  });

  it('a new press replaces the last one', () => {
    const t = new MenuTarget();
    t.set('first');
    t.set('second');
    expect(t.take(null)).toBe('second');
  });
});
