import { describe, expect, it } from 'vitest';
import {
  followSelection,
  initialPhoneNav,
  phoneTabs,
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
  const servers = ['addon/a/servers', 'Servers'] as const;
  const logs = ['addon/b/logs', 'Logs'] as const;
  const addons = (n: number) => Array.from({ length: n }, (_, i) => [`addon/x/${i}`, `Addon ${i}`] as const);
  const ids = (tabs: readonly (readonly [string, string])[]) => tabs.map(([id]) => id);
  const VIEWS = ['dashboard', 'projects', 'tasks', 'sessions'];

  describe('on iOS', () => {
    it('fits one addon tab as the fifth', () => {
      const t = phoneTabs([servers], 'ios', 402, false);
      expect(t.form).toBe('bar');
      expect(ids(t.shown)).toEqual([...VIEWS, 'addon/a/servers']);
      expect(t.more).toEqual([]);
    });

    it('makes the trailing tab More when they do not fit an iPhone', () => {
      const t = phoneTabs([servers, logs], 'ios', 402, false);
      expect(ids(t.shown)).toEqual([...VIEWS, 'more']);
      expect(t.more).toEqual([servers, logs]);
      expect(t.menu).toBeNull();
    });

    it('shows every tab near the top of an iPad that has room', () => {
      const t = phoneTabs([servers, logs], 'ios', 1376, true);
      expect(t.form).toBe('top');
      expect(ids(t.shown)).toEqual([...VIEWS, 'addon/a/servers', 'addon/b/logs']);
      expect(t.more).toEqual([]);
    });

    it('moves only what does not fit under More on an iPad', () => {
      const t = phoneTabs(addons(12), 'ios', 1032, true);
      expect(ids(t.shown).at(-1)).toBe('more');
      expect(ids(t.shown).slice(0, 4)).toEqual(VIEWS);
      expect(t.shown.length - 1 + t.more.length).toBe(16);
      expect(t.shown.length).toBeGreaterThan(5);
    });
  });

  describe('on Android', () => {
    it('uses a bar for up to five views under 840 dp', () => {
      for (const width of [412, 800]) {
        const t = phoneTabs([servers], 'android', width, false);
        expect(t.form).toBe('bar');
        expect(ids(t.shown)).toEqual([...VIEWS, 'addon/a/servers']);
        expect(t.menu).toBeNull();
      }
    });

    it('uses a rail from 840 dp', () => {
      expect(phoneTabs([], 'android', 840, true).form).toBe('rail');
      expect(phoneTabs([], 'android', 915, false).form).toBe('rail');
    });

    it('hides more than five views behind the menu icon in a compact window, with no bar and no More tab', () => {
      const t = phoneTabs([servers, logs], 'android', 412, false);
      expect(t.form).toBe('none');
      expect(t.shown).toEqual([]);
      expect(t.more).toEqual([]);
      expect(ids(t.menu!)).toEqual([...VIEWS, 'addon/a/servers', 'addon/b/logs']);
    });

    it('takes the rail for more than five views in a medium window', () => {
      const t = phoneTabs([servers, logs], 'android', 800, false);
      expect(t.form).toBe('rail');
      expect(t.shown).toHaveLength(6);
      expect(t.menu).toBeNull();
    });

    it('keeps seven in the rail and all of them behind the menu icon beyond that', () => {
      const t = phoneTabs(addons(4), 'android', 1280, true);
      expect(t.shown).toHaveLength(7);
      expect(t.menu).toHaveLength(8);
    });
  });

  it('gives an addon tab that was never opened an empty stack', () => {
    const nav = selectTab(initialPhoneNav(), 'addon/a/servers');
    expect(topScreen(nav)).toBeNull();
    expect(pushScreen(nav, { kind: 'task', id: 't' }).stacks['addon/a/servers']).toEqual([{ kind: 'task', id: 't' }]);
  });
});
