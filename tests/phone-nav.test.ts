import { describe, expect, it } from 'vitest';
import {
  followSelection,
  initialPhoneNav,
  phoneTabForm,
  PHONE_TABS,
  EXPANDED_WIDTH,
  popScreen,
  pushScreen,
  rootScreen,
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

  describe('folder screens (the Tasks tab drilling down)', () => {
    const folder = (id: string) => ({ kind: 'folder' as const, id });

    it('pushes a folder over a folder, and Back goes up one level at a time', () => {
      let nav = selectTab(initialPhoneNav(), 'tasks');
      nav = pushScreen(nav, folder('dev'));
      nav = pushScreen(nav, folder('dev'));
      nav = pushScreen(nav, folder('nightly'));
      expect(nav.stacks.tasks).toEqual([folder('dev'), folder('nightly')]);
      expect(sameScreen(folder('a'), folder('a'))).toBe(true);
      expect(sameScreen(folder('a'), { kind: 'task', id: 'a' })).toBe(false);
      nav = popScreen(nav);
      expect(topScreen(nav)).toEqual(folder('dev'));
    });

    it('selects nothing while it shows, and the window’s empty selection does not take it away', () => {
      let nav = pushScreen(selectTab(initialPhoneNav(), 'tasks'), folder('dev'));
      expect(selectionOf(topScreen(nav))).toEqual(none);
      expect(followSelection(nav, none)).toBe(nav);
      const settled = settle(nav, none);
      expect(settled.nav.stacks.tasks).toEqual([folder('dev')]);
      nav = settled.nav;
    });

    it('a task opened in a folder comes back to the folder on Back, and deleting it does too', () => {
      let { nav } = settle(pushScreen(selectTab(initialPhoneNav(), 'tasks'), folder('dev')), task('t'));
      expect(nav.stacks.tasks).toEqual([folder('dev'), { kind: 'task', id: 't' }]);
      expect(followSelection(nav, none).stacks.tasks).toEqual([folder('dev')]);
      nav = popScreen(nav);
      const after = settle(nav, selectionOf(topScreen(nav)));
      expect(after.nav.stacks.tasks).toEqual([folder('dev')]);
    });

    it('tapping the Tasks tab again goes back to its top level', () => {
      let nav = pushScreen(pushScreen(selectTab(initialPhoneNav(), 'tasks'), folder('dev')), folder('nightly'));
      nav = selectTab(nav, 'tasks');
      expect(topScreen(nav)).toBeNull();
    });
  });
});

describe('iPad split view (list column and detail column)', () => {
  it('a row of the list column replaces the detail stack instead of going over it', () => {
    let nav = selectTab(initialPhoneNav(), 'tasks');
    nav = rootScreen(nav, { kind: 'folder', id: 'dev' });
    nav = pushScreen(nav, { kind: 'task', id: 'a' });
    expect(nav.stacks.tasks).toHaveLength(2);
    nav = followSelection(nav, task('b'), true);
    expect(nav.stacks.tasks).toEqual([{ kind: 'task', id: 'b' }]);
    nav = rootScreen(nav, { kind: 'folder', id: 'ops' });
    expect(nav.stacks.tasks).toEqual([{ kind: 'folder', id: 'ops' }]);
  });

  it('opening the row already shown changes nothing', () => {
    const nav = rootScreen(selectTab(initialPhoneNav(), 'projects'), { kind: 'project', id: 'p' });
    expect(rootScreen(nav, { kind: 'project', id: 'p' })).toBe(nav);
    expect(followSelection(nav, project('p'), true)).toBe(nav);
  });

  it('a selection from the detail column still pushes, and Back pops within it', () => {
    let nav = rootScreen(selectTab(initialPhoneNav(), 'projects'), { kind: 'project', id: 'p' });
    nav = followSelection(nav, task('t'));
    expect(nav.stacks.projects).toEqual([
      { kind: 'project', id: 'p' },
      { kind: 'task', id: 't' },
    ]);
    nav = popScreen(nav);
    expect(topScreen(nav)).toEqual({ kind: 'project', id: 'p' });
  });

  it('a cleared selection from the list column leaves a folder shown', () => {
    const nav = rootScreen(selectTab(initialPhoneNav(), 'tasks'), { kind: 'folder', id: 'dev' });
    expect(followSelection(nav, none, true)).toBe(nav);
  });
});

describe('how the views show', () => {
  it('has a fixed bar of Looper’s own views, then More', () => {
    expect(PHONE_TABS.map(([id]) => id)).toEqual(['dashboard', 'projects', 'tasks', 'sessions', 'more']);
  });

  it('puts an iPhone’s tabs in a bar and an iPad’s near the top', () => {
    expect(phoneTabForm('ios', 402, false)).toBe('bar');
    expect(phoneTabForm('ios', 1376, true)).toBe('top');
  });

  it('uses a bar on Android under 840 dp and a rail from 840 dp', () => {
    expect(EXPANDED_WIDTH).toBe(840);
    for (const width of [412, 800, 839]) expect(phoneTabForm('android', width, false)).toBe('bar');
    expect(phoneTabForm('android', 840, true)).toBe('rail');
    expect(phoneTabForm('android', 915, false)).toBe('rail');
  });

  it('gives an addon tab that was never opened an empty stack', () => {
    const nav = selectTab(initialPhoneNav(), 'addon/a/servers');
    expect(topScreen(nav)).toBeNull();
    expect(pushScreen(nav, { kind: 'task', id: 't' }).stacks['addon/a/servers']).toEqual([{ kind: 'task', id: 't' }]);
  });
});
