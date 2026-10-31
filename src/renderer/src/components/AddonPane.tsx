import { useCallback, useEffect, useRef, useState } from 'react';
import { addonPaneKey, matchesSearch, type AddonInfo, type AddonPaneContent, type AddonPaneItem } from '@shared/addons';
import { isPhone, usePageNav } from '../web/page-nav';
import { addonMore, addonToolbarGroups, AddonScreenView } from './AddonScreen';
import { GROUP_INDENT, GroupHeader } from './GroupHeader';
import { useDragResize, useListNav } from './hooks';
import { listContextMenu } from './list-nav';
import { Toolbar } from './Toolbar';
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
  const [addons, setAddons] = useState<AddonInfo[]>([]);
  // False until the first list answers: an empty list before that is a placeholder, not "no addons".
  const [loaded, setLoaded] = useState(false);
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

  useEffect(() => {
    void window.looper.addons
      .list()
      .then((list) => {
        current.current = list;
        setAddons(list);
        list.forEach(load);
      })
      .finally(() => setLoaded(true));
    return window.looper.addons.onEvent((e) => {
      if (e.type === 'addons') {
        const prev = current.current;
        current.current = e.addons;
        setAddons(e.addons);
        setLoaded(true);
        for (const a of e.addons) {
          if (prev.find((x) => x.id === a.id)?.status !== 'running') load(a);
        }
      } else if (e.type === 'refresh') {
        const a = current.current.find((x) => x.id === e.addonId);
        if (a) load(a);
      }
    });
  }, [load]);

  const reload = useCallback((addonId: string) => {
    const a = current.current.find((x) => x.id === addonId);
    if (a) load(a);
  }, [load]);

  return { addons, panes, reload, loaded };
}

/** An addon pane's body in the sidebar: its items, drawn like the task list's. */
export function AddonPaneList({
  addon,
  pane,
  state,
  selected,
  compact,
  query,
  onQuery,
  searchInList = true,
  onSelect,
  onRetry,
}: {
  addon: AddonInfo;
  pane: string;
  state: AddonPaneState | undefined;
  selected: string | null;
  compact: boolean;
  /** What the pane's search box holds (a pane with `search`). */
  query: string;
  onQuery: (query: string) => void;
  /** Off: the window draws the Search box elsewhere (its toolbar), and the list only filters. */
  searchInList?: boolean;
  onSelect: (item: AddonPaneItem) => void;
  onRetry: () => void;
}) {
  const total = state?.status === 'ready' ? state.content.items.length : 0;
  const all = state?.status === 'ready' ? state.content.items.filter((it) => matchesSearch(it, query)) : [];
  // While searching, every group with a match is open.
  const searching = query.trim() !== '';
  const groupsKey = `addon-groups:${addonPaneKey(addon.id, pane)}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(groupsKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleGroup = (name: string) =>
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
  // What the arrow keys move through: the rows that show.
  const isCollapsed = (name: string) => !searching && collapsed.has(name);
  const rowId = (id: string) => `addon-${addon.id}-${pane}-${id}`;
  const groupRowId = (name: string) => `addon-${addon.id}-${pane}-group-${groups.findIndex((g) => g.name === name)}`;
  const open = (it: AddonPaneItem) =>
    void window.looper.addons.event(addon.id, { source: { pane }, kind: 'open', id: it.id, item: it.id });
  // The rows the keyboard visits, in the order they show: the loose items, then each group's header and its items while it's open.
  type NavRow = { kind: 'group'; name: string } | { kind: 'item'; it: AddonPaneItem };
  const rows: NavRow[] = [
    ...loose.map((it) => ({ kind: 'item' as const, it })),
    ...groups.flatMap((g): NavRow[] => [
      { kind: 'group', name: g.name },
      ...(isCollapsed(g.name) ? [] : g.items.map((it) => ({ kind: 'item' as const, it }))),
    ]),
  ];
  // The active row is the selected item, or the header the keyboard last stopped on.
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const groupAt = activeGroup === null ? -1 : rows.findIndex((r) => r.kind === 'group' && r.name === activeGroup);
  const index = groupAt >= 0 ? groupAt : selected === null ? -1 : rows.findIndex((r) => r.kind === 'item' && r.it.id === selected);
  const idAt = (r: NavRow) => (r.kind === 'group' ? groupRowId(r.name) : rowId(r.it.id));
  const pick = (it: AddonPaneItem) => {
    setActiveGroup(null);
    onSelect(it);
  };
  const showItemMenu = (it: AddonPaneItem) => {
    if (it.menu?.length) window.looper.addons.showMenu(addon.id, pane, it.menu, { item: it.id });
  };
  const nav = useListNav({
    count: rows.length,
    index,
    onIndex: (i) => {
      const r = rows[i];
      if (r.kind === 'group') return setActiveGroup(r.name);
      pick(r.it);
    },
    onActivate: (i) => {
      const r = rows[i];
      if (r.kind === 'group') toggleGroup(r.name);
      else open(r.it);
    },
    onMenu: (i) => {
      const r = rows[i];
      if (r.kind === 'item') showItemMenu(r.it);
    },
    tree: {
      expanded: (i) => {
        const r = rows[i];
        return r.kind === 'group' ? !isCollapsed(r.name) : undefined;
      },
      set: (i, wanted) => {
        const r = rows[i];
        if (r.kind === 'group' && !isCollapsed(r.name) !== wanted) toggleGroup(r.name);
      },
      // Loose items sit at the top level; a grouped item is inside the header above it.
      parent: (i) => {
        const r = rows[i];
        if (r.kind === 'group') return -1;
        for (let j = i - 1; j >= 0; j--) if (rows[j].kind === 'group') return loose.some((l) => l.id === r.it.id) ? -1 : j;
        return -1;
      },
    },
    scrollToId: index >= 0 ? idAt(rows[index]) : null,
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

  const searchBox = state.content.search && searchInList && (
    <AddonSearchBox value={query} onChange={onQuery} placeholder={state.content.search.placeholder} />
  );
  if (!all.length) {
    return (
      <>
        {searchBox}
        <div className="addon-pane-note muted">No matches.</div>
      </>
    );
  }

  const row = (it: AddonPaneItem, grouped: boolean) => (
        <li
          key={it.id}
          id={rowId(it.id)}
          role="treeitem"
          aria-level={grouped ? 2 : 1}
          aria-selected={it.id === selected}
          className={`task-item${it.id === selected ? ' selected' : ''}${it.dimmed ? ' disabled' : ''}`}
          style={grouped ? { marginLeft: GROUP_INDENT } : undefined}
          onClick={() => pick(it)}
          onDoubleClick={() => open(it)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            pick(it);
            showItemMenu(it);
          }}
        >
          <div className="task-item-row">
            <span className="task-name">{it.label}</span>
          </div>
          {!compact && it.description && (
            <div className="task-item-sub" title={it.description}>
              {it.description}
            </div>
          )}
        </li>
  );

  return (
    <>
    {searchBox}
    <ul
      className={`task-list${compact ? ' compact' : ''}`}
      role="tree"
      aria-label={addon.name}
      tabIndex={0}
      onKeyDown={nav}
      aria-activedescendant={index >= 0 ? idAt(rows[index]) : undefined}
      // The keyboard's menu request (Shift+F10, the Menu key) lands on the list: it opens the active item's menu.
      onContextMenu={(e) =>
        listContextMenu(e, index, (i) => {
          const r = rows[i];
          if (r.kind === 'item') showItemMenu(r.it);
        })
      }
    >
      {loose.map((it) => row(it, false))}
      {groups.map((g) => {
        const open = !isCollapsed(g.name);
        return [
          <GroupHeader
            key={`group:${g.name}`}
            id={groupRowId(g.name)}
            as="li"
            name={g.name}
            open={open}
            count={g.items.length}
            className={`task-folder${activeGroup === g.name ? ' active' : ''}`}
            onToggle={() => {
              setActiveGroup(g.name);
              toggleGroup(g.name);
            }}
          />,
          ...(open ? g.items.map((it) => row(it, true)) : []),
        ];
      })}
    </ul>
    </>
  );
}

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
  // A phone's search field (iOS's look): the magnifying glass stays at its start, and Cancel shows beside it while it has the focus.
  const [focused, setFocused] = useState(false);
  const prompt = placeholder ?? (isPhone ? 'Search' : 'Type to search');
  const glass = (
    <svg className="addon-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.3 10.3 3.2 3.2" />
    </svg>
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
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
            <path d="m2 2 6 6M8 2 2 8" />
          </svg>
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
      {focused && (
        <button
          type="button"
          className="addon-search-cancel"
          // Before the field's blur, which would take the button away first.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange('');
            ref.current?.blur();
          }}
        >
          Cancel
        </button>
      )}
    </div>
  );
}

/**
 * A tool window showing an addon pane: its list on the left, the selected
 * item's screen on the right, as the main window shows a task. Right-clicking
 * the list's empty space opens the pane's menu.
 */
export function AddonPaneWindowApp({ addonId, pane, title }: { addonId: string; pane: string; title: string }) {
  const { addons, panes, reload } = useAddons();
  const [selected, setSelected] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState(280);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const appRef = useRef<HTMLDivElement>(null);
  const onDividerDown = useDragResize({
    axis: 'x',
    containerRef: appRef,
    onDrag: (x, rect) => setListWidth(Math.max(180, Math.min(rect.width * 0.6, x))),
  });

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(
    () =>
      window.looper.addons.onEvent((e) => {
        if (e.type === 'select' && e.addonId === addonId && e.pane === pane) setSelected(e.item);
      }),
    [addonId, pane],
  );

  const addon = addons.find((a) => a.id === addonId);
  const state = panes[addonPaneKey(addonId, pane)];
  const content = state?.status === 'ready' ? state.content : undefined;
  const item = content?.items.find((it) => it.id === selected);

  const menuBarKey = JSON.stringify(content?.menuBar ?? null);
  // The selected item's own menu decides which of its commands the menu bar and toolbar offer.
  const itemKey = JSON.stringify(item ? { id: item.id, menu: item.menu } : null);
  useEffect(() => {
    window.looper.addons.setMenuBar(addonId, { pane }, JSON.parse(menuBarKey), JSON.parse(itemKey) ?? undefined);
  }, [addonId, pane, menuBarKey, itemKey]);

  const paneButtons = content?.toolbar ?? [];
  const paneGroups = addonToolbarGroups(
    paneButtons,
    { selected: item ?? null, onClick: (id, confirm) => void window.looper.addons.event(addonId, { source: { pane }, kind: 'click', id, item: item?.id }, confirm) },
    'pane',
  );
  usePageNav(content?.mobileMore ? { more: addonMore(content.mobileMore) } : null);

  // Ctrl+E goes to the Search box, its standard shortcut in Windows.
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'e' && searchRef.current) {
        e.preventDefault();
        searchRef.current.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app-shell">
      {/* The window's toolbar: the pane's buttons, then the selected item's screen's, and the Search box at its right. A phone's More menu has the buttons. */}
      {(paneButtons.length > 0 || item || content?.search) && (
        <Toolbar groups={paneGroups} className="addon-toolbar">
          <span className="toolbar-slot" ref={setToolbarSlot} />
          {content?.search && (
            <AddonSearchBox
              value={query}
              onChange={setQuery}
              placeholder={content.search.placeholder}
              inputRef={(el) => {
                searchRef.current = el;
              }}
            />
          )}
        </Toolbar>
      )}
      <div className={addon && item ? 'app' : 'app no-item'} ref={appRef} style={{ gridTemplateColumns: `${listWidth}px 5px 1fr` }}>
        <aside
          className="sidebar"
          onContextMenu={(e) => {
            e.preventDefault();
            const menu = state?.status === 'ready' ? state.content.menu : undefined;
            if (menu?.length) window.looper.addons.showMenu(addonId, pane, menu, {});
          }}
        >
          {addon ? (
            <AddonPaneList
              addon={addon}
              pane={pane}
              state={state}
              selected={selected}
              compact={false}
              query={query}
              onQuery={setQuery}
              searchInList={false}
              onSelect={(it) => setSelected(it.id)}
              onRetry={() => reload(addonId)}
            />
          ) : (
            <div className="addon-pane-note muted">This addon isn't installed.</div>
          )}
        </aside>
        <div className="sidebar-divider" onMouseDown={onDividerDown} />
        <main className="main">
          {addon && item ? (
            <AddonScreenView
              key={`${item.view}/${JSON.stringify(item.params ?? {})}`}
              addonId={addonId}
              addonName={addon.name}
              view={item.view}
              params={item.params ?? {}}
              mode="main"
              toolbarSlot={toolbarSlot}
              toolbarSep={paneButtons.length > 0}
            />
          ) : null}
        </main>
      </div>
      {/* iOS puts a screen's search in a bottom toolbar of its own (HIG: Search fields), which rises with the keyboard. */}
      {isPhone && content?.search && (
        <div className="addon-search-bar">
          <AddonSearchBox value={query} onChange={setQuery} placeholder={content.search.placeholder} />
        </div>
      )}
    </div>
  );
}
