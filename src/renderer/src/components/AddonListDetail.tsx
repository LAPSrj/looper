import { useEffect, useRef, type ReactNode } from 'react';
import type { AddonButton, AddonListRow, AddonNode } from '@shared/addons';
import { isPhone } from '../web/page-nav';
import { listSelection, nearEnd, rowsKey } from './addon-screen-model';
import { EmptyState } from './EmptyState';
import { ListDetail, selectsFirstRow } from './ListDetail';
import { NavBar } from './NavBar';
import { DetailRowText, RowList, showRowMenu, type ListMenuItem } from './RowList';
import { Group } from './phone/PhoneList';

export type ListDetailNode = Extract<AddonNode, { type: 'listDetail' }>;

/**
 * An addon's `listDetail` node, drawn as the Git tab draws its changes: the
 * rows (a name, its line under it, a value at the end as plain text), and the
 * selected row's `detail` screen beside them, under them where `stack` (a
 * narrow place, or a detail inside another), pushed over them on a phone. Its
 * `head` (a commit's message) is a tab of its own before the rows, and a
 * section above them on a phone.
 */
export function AddonListDetail({
  node,
  picked,
  onPick,
  stack,
  busy,
  onMenuPick,
  onMore,
  onPushed,
  detail,
  head,
}: {
  node: ListDetailNode;
  /** The node's `head`, drawn. */
  head?: ReactNode;
  /** The row picked, by id; undefined: none yet (the node's `selected` or the first), null: back on the list (a phone). */
  picked: string | null | undefined;
  onPick: (id: string | null) => void;
  stack: boolean;
  busy: boolean;
  /** One of the node's `menu` buttons picked for a row. */
  onMenuPick: (b: AddonButton, row: AddonListRow) => void;
  /** Scrolled near the end of the rows it has, while it has `more`: once until the rows change. */
  onMore: () => void;
  onPushed?: (pushed: boolean) => void;
  /** The row's detail screen. */
  detail: (row: AddonListRow) => ReactNode;
}) {
  const current = listSelection(node.items, node.selected, picked, selectsFirstRow);
  const asked = useRef('');
  const menu = node.menu ?? [];
  const items = (row: AddonListRow): ListMenuItem[] =>
    menu.map((b) => ({ label: b.label, enabled: !b.disabled && !busy, ...(b.danger ? { destructive: true as const } : {}), run: () => onMenuPick(b, row) }));

  // With no rows (its `empty` showing) or gone, nothing covers the screen.
  const listShows = !(node.items.length === 0 && node.empty !== undefined);
  useEffect(() => {
    if (!listShows) onPushed?.(false);
  }, [listShows, onPushed]);
  useEffect(() => () => onPushed?.(false), [onPushed]);
  if (!listShows) return <EmptyState>{node.empty}</EmptyState>;
  const open = !!current?.detail;
  return (
    <ListDetail
      panes={{ axis: stack ? 'y' : 'x', initial: stack ? 160 : 360 }}
      tabs={stack || head ? { list: node.label, detail: 'Details', ...(head && node.head ? { head: { label: node.head.label, body: <div className="detail-head">{head}</div> } } : {}) } : undefined}
      open={open}
      onClose={() => onPick(null)}
      detailTitle={current?.title}
      backLabel={node.label}
      onPushed={onPushed}
      empty={node.detailEmpty ?? ''}
      list={
        <RowList
          listClass="detail-rows"
          rowClass="detail-row"
          label={node.label}
          idPrefix={`addon-row-${node.id}`}
          rows={node.items}
          rowKey={(r) => r.id}
          selected={current?.id ?? null}
          onSelect={(r) => onPick(r.id)}
          onMenu={menu.length ? (r) => showRowMenu(items(r)) : undefined}
          onListScroll={(e) => {
            const key = rowsKey(node.items);
            if (!node.more || asked.current === key || !nearEnd(e.currentTarget)) return;
            asked.current = key;
            onMore();
          }}
          empty=""
          head={
            isPhone && head && node.head ? (
              <Group title={node.head.label}>
                <div className="pg-result">{head}</div>
              </Group>
            ) : undefined
          }
          row={(r) => <DetailRowText title={r.title} value={r.value} sub={r.subtitle} mono={r.mono} />}
          phoneRow={(r) => ({
            title: r.title,
            sub: r.subtitle && (r.mono ? <span className="pg-oneline mono">{r.subtitle}</span> : r.subtitle),
            value: r.value,
            chevron: !!r.detail,
          })}
        />
      }
      detail={
        current?.detail && (
          <>
            {/* A phone's pushed row: its menu is the screen's More menu. */}
            {isPhone && menu.length > 0 && <NavBar order={40} toolbar={[{ id: `addon-row-${node.id}`, items: items(current).map((m, i) => ({ id: menu[i].id, label: m.label, enabled: m.enabled, ...(m.destructive ? { destructive: true as const } : {}), run: m.run })) }]} />}
            {detail(current)}
          </>
        )
      }
    />
  );
}
