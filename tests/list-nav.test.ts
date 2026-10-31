import { describe, expect, it, vi } from 'vitest';
import { enterPressesDefault, isMenuKey, listContextMenu, listNavKey, parentIndex, type KeyLike, type ListNavModel } from '../src/renderer/src/components/list-nav';
import { withAccessKeys } from '../src/main/platform/menus';

/** A key event that records what the list did to it. */
const key = (k: string, extra: Partial<KeyLike> = {}) => {
  const e = { key: k, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
  return e;
};

/** A tree of rows: [folder A (open), a1, a2, folder B (closed), c (top level)]. */
const rows = [
  { id: 'A', depth: 0, open: true as boolean | undefined },
  { id: 'a1', depth: 1, open: undefined },
  { id: 'a2', depth: 1, open: undefined },
  { id: 'B', depth: 0, open: false as boolean | undefined },
  { id: 'c', depth: 0, open: undefined },
];

function model(index: number, over: Partial<ListNavModel> = {}) {
  const calls: string[] = [];
  const m: ListNavModel = {
    count: rows.length,
    index,
    onIndex: (i) => calls.push(`index ${rows[i].id}`),
    onActivate: (i) => calls.push(`activate ${rows[i].id}`),
    onDelete: (i) => calls.push(`delete ${rows[i].id}`),
    onRename: (i) => calls.push(`rename ${rows[i].id}`),
    onMenu: (i) => calls.push(`menu ${rows[i].id}`),
    tree: {
      expanded: (i) => rows[i].open,
      set: (i, open) => calls.push(`${open ? 'open' : 'close'} ${rows[i].id}`),
      parent: (i) => parentIndex(rows.map((r) => r.depth), i),
    },
    ...over,
  };
  return { m, calls };
}

const press = (index: number, k: string, extra: Partial<KeyLike> = {}, over: Partial<ListNavModel> = {}) => {
  const { m, calls } = model(index, over);
  const e = key(k, extra);
  const handled = listNavKey(e, m);
  return { handled, calls, e };
};

describe('listNavKey: movement', () => {
  it('moves with the arrows, Home and End, and from no selection starts at the first row', () => {
    expect(press(1, 'ArrowDown').calls).toEqual(['index a2']);
    expect(press(1, 'ArrowUp').calls).toEqual(['index A']);
    expect(press(-1, 'ArrowDown').calls).toEqual(['index A']);
    expect(press(2, 'Home').calls).toEqual(['index A']);
    expect(press(2, 'End').calls).toEqual(['index c']);
    expect(press(4, 'ArrowDown').calls).toEqual(['index c']);
    expect(press(0, 'ArrowUp').calls).toEqual(['index A']);
  });

  it('does nothing in an empty list', () => {
    const { m } = model(-1, { count: 0 });
    expect(listNavKey(key('ArrowDown'), m)).toBe(false);
    expect(listNavKey(key('Delete'), m)).toBe(false);
  });

  it('leaves keys with Ctrl, Alt or Meta to the window', () => {
    for (const mod of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      const r = press(1, 'ArrowDown', { [mod]: true });
      expect(r.handled).toBe(false);
      expect(r.e.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe('listNavKey: commands', () => {
  it('Enter activates the active row and stops the key; without an action it leaves Enter alone', () => {
    const r = press(1, 'Enter');
    expect(r.calls).toEqual(['activate a1']);
    expect(r.e.stopPropagation).toHaveBeenCalled();
    const none = press(1, 'Enter', {}, { onActivate: undefined });
    expect(none.handled).toBe(false);
    expect(none.e.preventDefault).not.toHaveBeenCalled();
  });

  it('Delete and F2 act on the active row only when there is one and the list has the command', () => {
    expect(press(1, 'Delete').calls).toEqual(['delete a1']);
    expect(press(3, 'F2').calls).toEqual(['rename B']);
    expect(press(-1, 'Delete').handled).toBe(false);
    expect(press(1, 'Delete', {}, { onDelete: undefined }).handled).toBe(false);
    expect(press(1, 'F2', {}, { onRename: undefined }).handled).toBe(false);
  });

  it('Shift+F10 and the Menu key open the active row\'s menu', () => {
    expect(press(2, 'F10', { shiftKey: true }).calls).toEqual(['menu a2']);
    expect(press(0, 'ContextMenu').calls).toEqual(['menu A']);
    // F10 alone is the window's (the menu bar), and with no row nothing opens.
    expect(press(2, 'F10').handled).toBe(false);
    expect(press(-1, 'ContextMenu').handled).toBe(false);
    expect(isMenuKey({ key: 'F10', shiftKey: true, ctrlKey: true })).toBe(false);
  });
});

describe('listNavKey: folders', () => {
  it('Left closes an open folder, and on any other row goes to its folder', () => {
    expect(press(0, 'ArrowLeft').calls).toEqual(['close A']);
    expect(press(2, 'ArrowLeft').calls).toEqual(['index A']);
    // A closed folder and a top-level row have nowhere to go.
    expect(press(3, 'ArrowLeft').handled).toBe(false);
    expect(press(4, 'ArrowLeft').handled).toBe(false);
  });

  it('Right opens a closed folder, and on an open one goes to its first row', () => {
    expect(press(3, 'ArrowRight').calls).toEqual(['open B']);
    expect(press(0, 'ArrowRight').calls).toEqual(['index a1']);
    expect(press(1, 'ArrowRight').handled).toBe(false);
  });

  it('Space toggles a folder and is left alone on a plain row', () => {
    expect(press(0, ' ').calls).toEqual(['close A']);
    expect(press(3, ' ').calls).toEqual(['open B']);
    expect(press(1, ' ').handled).toBe(false);
  });

  it('a list that is not a tree ignores Left, Right and Space', () => {
    for (const k of ['ArrowLeft', 'ArrowRight', ' ']) expect(press(0, k, {}, { tree: undefined }).handled).toBe(false);
  });

  it('finds a row\'s folder from the depths', () => {
    const depths = rows.map((r) => r.depth);
    expect(parentIndex(depths, 1)).toBe(0);
    expect(parentIndex(depths, 2)).toBe(0);
    expect(parentIndex(depths, 0)).toBe(-1);
    expect(parentIndex(depths, 4)).toBe(-1);
    expect(parentIndex([0, 1, 2, 2, 1], 3)).toBe(1);
  });
});

describe('listContextMenu', () => {
  const ev = (over: { target?: unknown; button?: number } = {}) => {
    const list = {};
    return { target: list, currentTarget: list, button: 0, preventDefault: vi.fn(), ...over };
  };

  it('opens the active row\'s menu for the keyboard\'s request (button 0), the list\'s own menu for a right click', () => {
    const onRow = vi.fn();
    const onEmpty = vi.fn();
    // Well after any key the earlier tests pressed.
    const later = () => Date.now() + 60_000;
    listContextMenu(ev(), 2, onRow, onEmpty, later);
    expect(onRow).toHaveBeenCalledWith(2);
    listContextMenu(ev({ button: 2 }), 2, onRow, onEmpty, later);
    expect(onEmpty).toHaveBeenCalledTimes(1);
    // No active row: the list's own menu.
    listContextMenu(ev(), -1, onRow, onEmpty, later);
    expect(onEmpty).toHaveBeenCalledTimes(2);
    expect(onRow).toHaveBeenCalledTimes(1);
  });

  it('leaves a row\'s own right click to the row', () => {
    const onRow = vi.fn();
    const e = ev({ target: {} });
    listContextMenu(e, 1, onRow);
    expect(onRow).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('does not answer twice when the key itself already opened the menu', () => {
    let t = 1_000_000;
    const { m } = model(2);
    const opened: number[] = [];
    m.onMenu = (i) => opened.push(i);
    listNavKey(key('ContextMenu'), m, () => t);
    const onRow = vi.fn();
    t += 50;
    listContextMenu(ev(), 2, onRow, undefined, () => t);
    expect(opened).toEqual([2]);
    expect(onRow).not.toHaveBeenCalled();
    // A request a while later is a new one.
    t += 5000;
    listContextMenu(ev(), 2, onRow, undefined, () => t);
    expect(onRow).toHaveBeenCalledWith(2);
  });
});

describe('enterPressesDefault', () => {
  it('lets Enter press the default button except where it means something else', () => {
    expect(enterPressesDefault({ tagName: 'INPUT' })).toBe(true);
    expect(enterPressesDefault({ tagName: 'DIV' })).toBe(true);
    expect(enterPressesDefault({ tagName: 'UL' })).toBe(true);
    expect(enterPressesDefault(null)).toBe(true);
    for (const tag of ['TEXTAREA', 'BUTTON', 'SELECT', 'A', 'SUMMARY']) expect(enterPressesDefault({ tagName: tag })).toBe(false);
    expect(enterPressesDefault({ tagName: 'DIV', isContentEditable: true })).toBe(false);
  });
});

describe('withAccessKeys', () => {
  const label = (items: { label?: string }[]) => items.map((i) => i.label);

  it('gives each item the first letter no other item of the menu uses', () => {
    expect(label(withAccessKeys([{ label: 'Run Now' }, { label: 'Rename…' }, { label: 'Remove' }, { label: 'Delete' }]))).toEqual([
      '&Run Now',
      'R&ename…',
      'Re&move',
      '&Delete',
    ]);
  });

  it('prefers the first letter of a later word over a letter in the middle', () => {
    expect(label(withAccessKeys([{ label: 'Open File' }, { label: 'Open Folder' }]))).toEqual(['&Open File', 'Open &Folder']);
  });

  it('keeps labels that have their own key, roles and separators, and never reuses a key an item already has', () => {
    const out = withAccessKeys([
      { label: 'E&dit' },
      { label: 'Delete' },
      { label: 'Copy', role: 'copy' },
      { type: 'separator' },
      { label: 'Fish && Chips' },
    ]);
    expect(label(out)).toEqual(['E&dit', 'D&elete', 'Copy', undefined, 'Fish && Chips']);
  });

  it('does the same in a submenu and does not change what it is given', () => {
    const template = [{ label: 'Sort', submenu: [{ label: 'Name' }, { label: 'Number' }] }];
    const out = withAccessKeys(template);
    expect(out[0].label).toBe('&Sort');
    expect(label(out[0].submenu as { label?: string }[])).toEqual(['&Name', 'N&umber']);
    expect(template[0].label).toBe('Sort');
  });

  it('leaves an item without a free letter alone', () => {
    expect(label(withAccessKeys([{ label: 'A' }, { label: 'A' }]))).toEqual(['&A', 'A']);
  });
});
