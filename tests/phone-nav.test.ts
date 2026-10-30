import { describe, expect, it } from 'vitest';
import {
  followSelection,
  initialPhoneNav,
  popScreen,
  pushScreen,
  sameScreen,
  screenOf,
  selectTab,
  selectionOf,
  showTabRoot,
  topScreen,
  type MainSelection,
  type PhoneNav,
} from '../src/renderer/src/phone-nav';

const none: MainSelection = { task: null, project: null, addon: null };
const task = (id: string): MainSelection => ({ ...none, task: id });
const project = (id: string): MainSelection => ({ ...none, project: id });

/**
 * The phone view's two effects, run until they settle: the shown screen
 * becomes the window's selection, and a selection made elsewhere pushes or
 * pops a screen.
 */
function settle(nav: PhoneNav, sel: MainSelection): { nav: PhoneNav; sel: MainSelection } {
  for (let i = 0; i < 5; i++) {
    const shown = selectionOf(topScreen(nav));
    const next = followSelection(nav, sel);
    if (next === nav && JSON.stringify(shown) === JSON.stringify(sel)) return { nav, sel };
    nav = next;
    sel = selectionOf(topScreen(nav));
  }
  throw new Error('did not settle');
}

describe('phone navigation', () => {
  it('starts on the dashboard with nothing shown', () => {
    const nav = initialPhoneNav();
    expect(nav.tab).toBe('dashboard');
    expect(topScreen(nav)).toBeNull();
    expect(selectionOf(topScreen(nav))).toEqual(none);
  });

  it('pushes a screen once, and Back goes to the screen under it', () => {
    let nav = selectTab(initialPhoneNav(), 'projects');
    nav = pushScreen(nav, { kind: 'project', id: 'p' });
    nav = pushScreen(nav, { kind: 'project', id: 'p' });
    nav = pushScreen(nav, { kind: 'task', id: 't' });
    expect(nav.stacks.projects).toHaveLength(2);
    nav = popScreen(nav);
    expect(topScreen(nav)).toEqual({ kind: 'project', id: 'p' });
    nav = popScreen(popScreen(nav));
    expect(topScreen(nav)).toBeNull();
  });

  it('keeps each tab its own stack; tapping the shown tab goes back to its list', () => {
    let nav = selectTab(initialPhoneNav(), 'tasks');
    nav = pushScreen(nav, { kind: 'task', id: 'a' });
    nav = selectTab(nav, 'projects');
    expect(topScreen(nav)).toBeNull();
    nav = selectTab(nav, 'tasks');
    expect(topScreen(nav)).toEqual({ kind: 'task', id: 'a' });
    nav = selectTab(nav, 'tasks');
    expect(topScreen(nav)).toBeNull();
  });

  it('a selection made elsewhere pushes its screen; the desktop order decides which', () => {
    expect(screenOf({ task: 't', project: 'p', addon: null })).toEqual({ kind: 'task', id: 't' });
    expect(screenOf({ task: null, project: 'p', addon: { addonId: 'a', pane: 'x', item: 'i' } })).toEqual({ kind: 'project', id: 'p' });
    const { nav, sel } = settle(selectTab(initialPhoneNav(), 'tasks'), task('t'));
    expect(nav.stacks.tasks).toEqual([{ kind: 'task', id: 't' }]);
    expect(sel).toEqual(task('t'));
  });

  it('a task opened from a project comes back to the project on Back', () => {
    let { nav, sel } = settle(selectTab(initialPhoneNav(), 'projects'), project('p'));
    // The task's row in the project is tapped: the window selects the task (the project clears).
    ({ nav, sel } = settle(nav, task('t')));
    expect(nav.stacks.projects).toEqual([
      { kind: 'project', id: 'p' },
      { kind: 'task', id: 't' },
    ]);
    nav = popScreen(nav);
    ({ nav, sel } = settle(nav, selectionOf(topScreen(nav))));
    expect(sel).toEqual(project('p'));
    expect(topScreen(nav)).toEqual({ kind: 'project', id: 'p' });
  });

  it('a shown task that is deleted (selection cleared) takes its screen away', () => {
    let { nav } = settle(selectTab(initialPhoneNav(), 'tasks'), task('t'));
    nav = followSelection(nav, none);
    expect(topScreen(nav)).toBeNull();
  });

  it('switching tabs selects what the other tab shows', () => {
    let { nav } = settle(selectTab(initialPhoneNav(), 'tasks'), task('t'));
    nav = selectTab(nav, 'dashboard');
    expect(selectionOf(topScreen(nav))).toEqual(none);
    // The window catches up, and nothing is pushed back.
    const after = settle(nav, none);
    expect(after.nav.tab).toBe('dashboard');
    expect(after.nav.stacks.tasks).toEqual([{ kind: 'task', id: 't' }]);
  });

  it('View → Dashboard empties the dashboard tab and shows it', () => {
    let nav = pushScreen(initialPhoneNav(), { kind: 'task', id: 'x' });
    nav = selectTab(nav, 'projects');
    nav = showTabRoot(nav, 'dashboard');
    expect(nav.tab).toBe('dashboard');
    expect(topScreen(nav)).toBeNull();
  });

  it('compares addon screens by addon, pane and item', () => {
    const a = { kind: 'addon' as const, addonId: 'a', pane: 'p', item: '1' };
    expect(sameScreen(a, { ...a })).toBe(true);
    expect(sameScreen(a, { ...a, item: '2' })).toBe(false);
    expect(sameScreen(a, { kind: 'task', id: '1' })).toBe(false);
    expect(sameScreen(null, null)).toBe(true);
  });
});
