// What an addon's screen does with its nodes and values, without drawing them: AddonScreen.tsx draws, the unit tests check this.
// Relative imports only: the unit tests load it too (tsconfig.node.json).
import type { AddonField, AddonListRow, AddonNode, AddonProp, AddonRefresh, AddonValue } from '../../../shared/addons';

export type Values = Record<string, AddonValue>;

/** Every field of a screen, inside rows, sections and tabs too. */
export function fieldsOf(nodes: AddonNode[]): AddonField[] {
  return nodes.flatMap((n) =>
    n.type === 'field'
      ? [n]
      : n.type === 'row'
        ? n.items
        : n.type === 'section'
          ? fieldsOf(n.body)
          : n.type === 'tabs'
            ? n.items.flatMap((t) => fieldsOf(t.body))
            : [],
  );
}

/** Every property of a screen, inside sections and tabs too. */
export function propsOf(nodes: AddonNode[]): AddonProp[] {
  return nodes.flatMap((n) =>
    n.type === 'props' ? n.items : n.type === 'section' ? propsOf(n.body) : n.type === 'tabs' ? n.items.flatMap((t) => propsOf(t.body)) : [],
  );
}

/** A list or a checklist: a section of its own, never in a group of fields. */
export const standsAlone = (n: AddonNode): boolean => n.type === 'field' && (n.input === 'list' || n.input === 'checklist');

/** A node that takes the room its place has (a list beside its detail, a diff): the screen around it doesn't scroll. */
export const fillsScreen = (n: AddonNode): boolean => n.type === 'listDetail' || n.type === 'diff';

/** A screen's nodes in order: each run of fields and rows together (a FormGroup), every other node alone. */
export function fieldRuns(nodes: AddonNode[]): { at: number; fields: boolean; nodes: AddonNode[] }[] {
  const runs: { at: number; fields: boolean; nodes: AddonNode[] }[] = [];
  nodes.forEach((n, at) => {
    const fields = (n.type === 'field' && !standsAlone(n)) || n.type === 'row';
    const last = runs[runs.length - 1];
    if (fields && last?.fields) last.nodes.push(n);
    else runs.push({ at, fields, nodes: [n] });
  });
  return runs;
}

/** A field's value before the addon or the user gives one. */
export const emptyValue = (f: AddonField): AddonValue =>
  f.input === 'checkbox'
    ? false
    : f.input === 'number'
      ? 0
      : f.input === 'checklist'
        ? []
        : f.input === 'list'
          ? (f.options?.[0]?.value ?? '')
          : '';

/** A checklist's checked values that are still among its options. */
const stillOffered = (f: AddonField, v: AddonValue): string[] | null =>
  Array.isArray(v) ? v.filter((x) => !!f.options?.some((o) => o.value === x)) : null;

/**
 * Fields keep what the user typed across redraws; only fields new to the screen take the addon's value.
 * A list whose selected row is gone selects the addon's value again, or its first row; a checklist keeps
 * the checks of the options it still has.
 */
export function mergeValues(prev: Values, fields: AddonField[]): Values {
  const next: Values = {};
  for (const f of fields) {
    const had = f.id in prev;
    if (f.input === 'checklist') {
      const kept = had ? stillOffered(f, prev[f.id]) : null;
      next[f.id] = kept ?? stillOffered(f, f.value ?? []) ?? [];
      continue;
    }
    const kept = had && (f.input !== 'list' || !!f.options?.some((o) => o.value === prev[f.id]));
    next[f.id] = kept ? prev[f.id] : (f.value ?? emptyValue(f));
  }
  return next;
}

/** A required field without a value: an empty text, or a checklist with nothing checked. */
export function isMissing(f: AddonField, v: AddonValue | undefined): boolean {
  if (!f.required) return false;
  if (v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}

/** A checklist's value with `value` checked or not, in the options' order. */
export function toggleChecked(f: AddonField, current: AddonValue | undefined, value: string, on: boolean): string[] {
  const set = new Set(Array.isArray(current) ? current : []);
  if (on) set.add(value);
  else set.delete(value);
  return (f.options ?? []).map((o) => o.value).filter((v) => set.has(v));
}

/**
 * The row a `listDetail` shows selected: the one picked (`picked`, kept by id across redraws), else the
 * node's `selected`, else the first on the desktop (`firstRow`) and none on a phone. `picked` null: the
 * phone went back to the list. A picked row that's gone gives way to the first on the desktop, to none on a phone.
 */
export function listSelection(items: AddonListRow[], selected: string | undefined, picked: string | null | undefined, firstRow: boolean): AddonListRow | undefined {
  if (picked === null) return undefined;
  const find = (id: string | undefined) => (id === undefined ? undefined : items.find((r) => r.id === id));
  if (picked !== undefined) return find(picked) ?? (firstRow ? items[0] : undefined);
  return find(selected) ?? (firstRow ? items[0] : undefined);
}

/** What a list's rows are now, for sending `more` once until they change. */
export const rowsKey = (items: AddonListRow[]): string => `${items.length}\n${items[items.length - 1]?.id ?? ''}`;

/** About this far (px) from a list's end, scrolling asks the addon for more rows. */
export const MORE_WITHIN_PX = 300;

/** A list scrolled near its end. */
export const nearEnd = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight < MORE_WITHIN_PX;

/**
 * Whether an addon's `refresh` draws this again: without `only` (or with none of its parts given),
 * everything; with it, the screens of its views, its panes, and the project tabs' titles with `projectTabs`.
 */
export function refreshes(only: AddonRefresh | undefined, what: { view: string } | { pane: string } | { projectTabs: true }): boolean {
  if (!only || (only.views === undefined && only.panes === undefined && only.projectTabs === undefined)) return true;
  if ('view' in what) return !!only.views?.includes(what.view);
  if ('pane' in what) return !!only.panes?.includes(what.pane);
  return !!only.projectTabs;
}
