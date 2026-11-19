import { useCallback, useEffect, useRef, useState } from 'react';
import { addonPaneKey, matchesSearch, type AddonInfo, type AddonPaneContent, type AddonPaneItem } from '@shared/addons';
import { contextMenu } from '@shared/commands/build';
import type { CommandContext } from '@shared/commands/context';
import { useAddonList } from '../live-state';
import { platform } from '../platform';
import { isPhone } from '../web/page-nav';
import { popupCommands } from './command-surfaces';
import { GROUP_INDENT, GroupHeader } from './GroupHeader';
import { ItemText, useGroupedTree, type TreeRow } from './GroupedTree';
import { Icon } from './Icon';
import { ICONS } from './icons';
import { Row } from './phone/PhoneList';
import { InfoBar } from './ui';

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

  const load = useCallback((a: AddonInfo) => {
    if (a.status !== 'running') return;
    for (const p of a.panes) {
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
        if (a) load(a);
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

  if (addon.status === 'stopped') {
    return (
      <div className="addon-pane-note">
        <InfoBar
          stacked
          title={`${addon.name} stopped`}
          message={addon.error ?? ''}
          action={
            <button className="btn" onClick={() => void window.looper.addons.restart(addon.id)}>
              Restart
            </button>
          }
        />
      </div>
    );
  }
  if (addon.status === 'starting' || !state) return <div className="addon-pane-note muted">Starting…</div>;
  if (state.status === 'error') {
    return (
      <div className="addon-pane-note">
        <InfoBar
          stacked
          title={`${addon.name} couldn't list its items`}
          message={state.error}
          action={
            <button className="btn" onClick={onRetry}>
              Try Again
            </button>
          }
        />
      </div>
    );
  }
  if (!total) return <div className="addon-pane-note muted">{state.content.empty ?? 'Nothing here.'}</div>;

  if (!all.length) return <div className="addon-pane-note muted">No matches.</div>;

  const header = (r: Extract<PaneRow, { kind: 'group' }>) => (
    <GroupHeader
      key={`group:${r.key}`}
      {...t.groupProps(r)}
      as={isPhone ? 'div' : 'li'}
      inTree={!isPhone}
      name={r.group.name}
      count={r.group.items.length}
      className={`task-folder${t.activeGroup === r.key ? ' active' : ''}`}
    />
  );

  // A phone draws its rows as the system's list rows; a tap opens the item, a long press shows its menu.
  if (isPhone) {
    return (
      <div>
        {rows.map((r) =>
          r.kind === 'group' ? (
            header(r)
          ) : (
            <Row
              key={r.key}
              title={r.item.label}
              sub={r.item.description || undefined}
              tone={r.item.dimmed ? 'muted' : undefined}
              chevron
              selected={r.key === selected}
              onOpen={() => t.pick(r.item)}
              onMenu={() => onMenu(r.item)}
            />
          ),
        )}
      </div>
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
            <ItemText name={r.item.label} sub={compact ? undefined : r.item.description} />
          </li>
        ),
      )}
    </ul>
  );
}

type PaneRow = TreeRow<{ name: string; items: AddonPaneItem[] }, AddonPaneItem>;

/**
 * An instant Search box as the Windows guidelines draw one: a prompt inside
 * it instead of a label, the magnifying glass as a symbol (not a button) while
 * it's empty, and an "x" that clears it once there's text. Focusing it selects
 * what was typed before; Esc clears it.
 */
export function AddonSearchBox({
  value,
  onChange,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputRef?: (el: HTMLInputElement | null) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  // A click that focuses the box would undo the select-on-focus on mouse up.
  const justFocused = useRef(false);
  // A phone's search field keeps the magnifying glass at its start; on an iPhone, Cancel (an xmark in a glass circle) shows beside it while it has the focus.
  const [focused, setFocused] = useState(false);
  const prompt = placeholder ?? (isPhone ? 'Search' : 'Type to search');
  const glass = (
    <Icon size={14} className="addon-search-icon">
      {ICONS.search}
    </Icon>
  );
  const field = (
    <>
      {isPhone && glass}
      <input
        ref={(el) => {
          ref.current = el;
          inputRef?.(el);
        }}
        type="text"
        enterKeyHint={isPhone ? 'search' : undefined}
        aria-label={prompt}
        placeholder={prompt}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => {
          e.currentTarget.select();
          justFocused.current = true;
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onMouseUp={(e) => {
          if (justFocused.current) e.preventDefault();
          justFocused.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="addon-search-clear"
          aria-label="Clear"
          // The field keeps the focus: losing it would take Cancel away and move this button from under the finger.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
        >
          <Icon size={10} bold>
            {ICONS.close}
          </Icon>
        </button>
      ) : (
        !isPhone && glass
      )}
    </>
  );
  if (!isPhone) return <div className="addon-search">{field}</div>;
  return (
    <div className="addon-search">
      <span className="addon-search-field">{field}</span>
      {focused && platform === 'ios' && (
        <button
          type="button"
          className="addon-search-cancel"
          aria-label="Cancel"
          // Before the field's blur, which would take the button away first.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange('');
            ref.current?.blur();
          }}
        >
          <Icon size={17}>{ICONS.close}</Icon>
        </button>
      )}
    </div>
  );
}
