import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { addonPaneKey, matchesSearch, type AddonInfo, type AddonPaneContent, type AddonPaneItem, type AddonRefresh } from '@shared/addons';
import { contextMenu } from '@shared/commands/build';
import type { CommandContext } from '@shared/commands/context';
import { useAddonList } from '../live-state';
import { isPhone } from '../web/page-nav';
import { refreshes } from './addon-screen-model';
import { popupCommands } from './command-surfaces';
import { GROUP_INDENT, GroupHeader } from './GroupHeader';
import { ItemText, useGroupedTree, type TreeRow } from './GroupedTree';
import { Group } from './phone/PhoneList';
import { PhoneRows } from './RowList';
import { EmptyState } from './EmptyState';
import { AddonNotRunning } from './AddonNotRunning';

export type AddonPaneState = { status: 'ready'; content: AddonPaneContent } | { status: 'error'; error: string };

/** A pane item picked in the sidebar; the main window shows its screen. */
export interface AddonSelection {
  addonId: string;
  pane: string;
  item: string;
}

/** The installed addons and their panes' items, kept current as addons start, stop and ask for a redraw. */
export function useAddons(): { addons: AddonInfo[]; panes: Record<string, AddonPaneState>; reload: (addonId: string) => void; loaded: boolean } {
  const { addons, loaded } = useAddonList();
  const [panes, setPanes] = useState<Record<string, AddonPaneState>>({});
  const current = useRef<AddonInfo[]>([]);

  /** The addon's panes, or with `only` (a refresh's) the ones it names. */
  const load = useCallback((a: AddonInfo, only?: AddonRefresh) => {
    if (a.status !== 'running') return;
    for (const p of a.panes) {
      if (!refreshes(only, { pane: p.id })) continue;
      const key = addonPaneKey(a.id, p.id);
      void window.looper.addons
        .pane(a.id, p.id)
        .then((content) => setPanes((m) => ({ ...m, [key]: { status: 'ready', content } })))
        .catch((e: Error) => setPanes((m) => ({ ...m, [key]: { status: 'error', error: e.message } })));
    }
  }, []);

  // The panes of an addon load when it first shows running, and again when it asks for a redraw.
  useEffect(() => {
    const prev = current.current;
    current.current = addons;
    for (const a of addons) {
      if (prev.find((x) => x.id === a.id)?.status !== 'running') load(a);
    }
  }, [addons, load]);

  useEffect(
    () =>
      window.looper.addons.onEvent((e) => {
        if (e.type !== 'refresh') return;
        const a = current.current.find((x) => x.id === e.addonId);
        if (a) load(a, e.only);
      }),
    [load],
  );

  const reload = useCallback((addonId: string) => {
    const a = current.current.find((x) => x.id === addonId);
    if (a) load(a);
  }, [load]);

  return { addons, panes, reload, loaded };
}

/**
 * An addon's Search box, while one of its panes can be searched: its prompt, the panes' own when
 * they agree. Null while none can.
 */
export function addonSearch(addon: AddonInfo | undefined, panes: Record<string, AddonPaneState>): { prompt?: string } | null {
  if (!addon) return null;
  const searches = addon.panes.flatMap((p) => {
    const state = panes[addonPaneKey(addon.id, p.id)];
    return state?.status === 'ready' && state.content.search ? [state.content.search] : [];
  });
  if (!searches.length) return null;
  const prompts = new Set(searches.map((s) => s.placeholder));
  return prompts.size === 1 ? { prompt: searches[0].placeholder } : {};
}

/** The items a pane shows for the addon's search: all of them in a pane that can't be searched. */
export function shownItems(state: AddonPaneState | undefined, query: string): AddonPaneItem[] {
  if (state?.status !== 'ready') return [];
  return state.content.search ? state.content.items.filter((it) => matchesSearch(it, query)) : state.content.items;
}

const paneState = (state: AddonPaneState | undefined) => (state?.status === 'ready' ? state.content.commands : undefined);

/** A pane header's right-click, or a long press on its title: the addon's commands placed in its panes. */
export function showPaneMenu(c: CommandContext, addonId: string, pane: string, state: AddonPaneState | undefined): void {
  const at: CommandContext = { ...c, addon: { id: addonId, panes: { pane, state: paneState(state) } } };
  popupCommands(at, contextMenu('addonPanes', at));
}

/** A pane item's right-click or long press: the commands placed on items, as they are for this one. */
export function showPaneItemMenu(c: CommandContext, addonId: string, pane: string, state: AddonPaneState | undefined, item: AddonPaneItem): void {
  const at: CommandContext = { ...c, addon: { id: addonId, panes: { pane, state: paneState(state) }, item: { pane, id: item.id, state: item.commands } } };
  popupCommands(at, contextMenu('addonItem', at));
}

/** An addon pane's body in the sidebar: its items, drawn like the task list's. */
export function AddonPaneList({
  addon,
  pane,
  state,
  selected,
  compact,
  query,
  onSelect,
  onMenu,
  onRetry,
  head,
}: {
  addon: AddonInfo;
  pane: string;
  state: AddonPaneState | undefined;
  selected: string | null;
  compact: boolean;
  /** What the addon's Search box holds; it filters a pane with `search`. */
  query: string;
  onSelect: (item: AddonPaneItem) => void;
  /** A right-click or long press on an item: the commands placed on items, for that one (it's selected first on the desktop). */
  onMenu: (item: AddonPaneItem) => void;
  onRetry: () => void;
  /** On a phone or tablet, above the sections (a pane's title when the addon has several). */
  head?: ReactNode;
}) {
  const total = state?.status === 'ready' ? state.content.items.length : 0;
  const all = shownItems(state, query);
  // While searching, every group with a match is open.
  const searching = state?.status === 'ready' && !!state.content.search && query.trim() !== '';
  const groupsKey = `addon-groups:${addonPaneKey(addon.id, pane)}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(groupsKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleGroup = ({ name }: { name: string }) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      try {
        localStorage.setItem(groupsKey, JSON.stringify([...next]));
      } catch {
        /* storage unavailable: the groups just don't stay collapsed */
      }
      return next;
    });
  // Ungrouped items first, then each group in the order it first appears.
  const groups: { name: string; items: AddonPaneItem[] }[] = [];
  const loose: AddonPaneItem[] = [];
  for (const it of all) {
    if (!it.group) {
      loose.push(it);
      continue;
    }
    const g = groups.find((x) => x.name === it.group);
    if (g) g.items.push(it);
    else groups.push({ name: it.group, items: [it] });
  }
  const prefix = `addon-${addon.id}-${pane}`;
  const item = (it: AddonPaneItem, depth: number): PaneRow => ({ kind: 'item', key: it.id, id: `${prefix}-${it.id}`, depth, item: it });
  // The rows in the order they show: the loose items at the top level, then each group's header and its items while it's open.
  const rows: PaneRow[] = [
    ...loose.map((it) => item(it, 0)),
    ...groups.flatMap((g, gi): PaneRow[] => {
      const open = searching || !collapsed.has(g.name);
      return [{ kind: 'group', key: g.name, id: `${prefix}-group-${gi}`, depth: 0, open, group: g }, ...(open ? g.items.map((it) => item(it, 1)) : [])];
    }),
  ];
  const t = useGroupedTree({
    rows,
    selected,
    onSelect,
    toggle: toggleGroup,
    onOpen: (it) => void window.looper.addons.event(addon.id, { source: { pane }, kind: 'open', id: it.id, item: it.id }),
    itemMenu: onMenu,
  });

  // A phone's or tablet's list is sections (PhoneRows): what stands in place of it is a section's row.
  const inList = (node: ReactNode) => (isPhone ? <Group>{node}</Group> : node);
  if (addon.status !== 'running' || !state) return inList(<AddonNotRunning addon={addon} />);
  if (state.status === 'error') {
    return inList(
      <EmptyState
        level="error"
        title={`${addon.name} can't list its items`}
        action={
          <button className="btn" onClick={onRetry}>
            Try Again
          </button>
        }
      >
        {state.error}
      </EmptyState>,
    );
  }
  if (!total) return inList(<EmptyState>{state.content.empty ?? 'Nothing here.'}</EmptyState>);
  if (!all.length) return inList(<EmptyState>No matches.</EmptyState>);

  const header = (r: Extract<PaneRow, { kind: 'group' }>) => (
    <GroupHeader
      key={`group:${r.key}`}
      {...t.groupProps(r)}
      as="li"
      name={r.group.name}
      count={r.group.items.length}
      className={`task-folder${t.activeGroup === r.key ? ' active' : ''}`}
    />
  );

  // A phone or tablet draws a list section for the loose items and one for each group, as every list of sections does
  // (PhoneRows): the group's name is the section's title, outside its card. Every group shows open: folding sections on
  // a phone is not decided (components.md rule 2). A tap opens the item, a long press shows its menu.
  if (isPhone) {
    return (
      <PhoneRows
        rows={[...loose, ...groups.flatMap((g) => g.items)]}
        rowKey={(it) => it.id}
        selected={selected}
        onOpen={(it) => t.pick(it)}
        onMenu={onMenu}
        empty={null}
        head={head}
        groupOf={(it) => it.group ?? ''}
        phoneRow={(it) => ({
          title: it.label,
          sub: it.mono && it.description ? <span className="mono">{it.description}</span> : it.description || undefined,
          tone: it.dimmed ? 'muted' : undefined,
          chevron: true,
        })}
      />
    );
  }

  return (
    <ul className={`task-list${compact ? ' compact' : ''}`} role="tree" aria-label={addon.name} {...t.listProps}>
      {rows.map((r) =>
        r.kind === 'group' ? (
          header(r)
        ) : (
          <li
            key={r.key}
            {...t.itemProps(r)}
            role="treeitem"
            aria-level={r.depth + 1}
            className={`task-item${r.key === selected ? ' selected' : ''}${r.item.dimmed ? ' disabled' : ''}`}
            style={r.depth ? { marginLeft: GROUP_INDENT } : undefined}
          >
            <ItemText name={r.item.label} sub={compact ? undefined : r.item.description} subClass={r.item.mono ? 'mono' : undefined} />
          </li>
        ),
      )}
    </ul>
  );
}

type PaneRow = TreeRow<{ name: string; items: AddonPaneItem[] }, AddonPaneItem>;
