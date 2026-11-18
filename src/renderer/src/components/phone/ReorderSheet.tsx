import { useRef, useState, type ReactNode } from 'react';
import { moveKey } from '@shared/folders';
import { Group, Row, SwipeRow } from './PhoneList';
import { PhoneSheet } from './PhoneSheet';

export interface ReorderItem {
  key: string;
  title: ReactNode;
  sub?: ReactNode;
}

export interface ReorderSection {
  key: string;
  title?: string;
  items: ReorderItem[];
}

/** Near a scrolling list's edge, a dragged row scrolls it this far per move. */
const EDGE = 48;
const EDGE_STEP = 14;

/**
 * The edit mode of a phone's list: a long press already opens a row's menu, so
 * dragging a row needs a command to get here ("People appreciate being able to
 * reorder a list", HIG: Lists and tables). Rows move by their handles, by touch or
 * with the arrow keys, within their section, and each move saves as a desktop drop does.
 */
export function ReorderSheet({ title, sections, onReorder, onClose }: { title: string; sections: ReorderSection[]; onReorder: (section: string, keys: string[]) => void; onClose: () => void }) {
  const [orders, setOrders] = useState<Record<string, string[]>>(() => Object.fromEntries(sections.map((s) => [s.key, s.items.map((i) => i.key)])));
  const [dragging, setDragging] = useState<string | null>(null);
  const moved = useRef(false);
  const lists = useRef(new Map<string, HTMLElement>());

  const moveTo = (section: string, key: string, to: number) => {
    const order = orders[section];
    const from = order.indexOf(key);
    if (from === to || to < 0 || to >= order.length) return null;
    const next = moveKey(order, from, to);
    setOrders((o) => ({ ...o, [section]: next }));
    return next;
  };
  const dragOver = (section: string, key: string, y: number) => {
    const list = lists.current.get(section);
    if (!list) return;
    const scroller = list.closest('.pg-sheet-body');
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      if (y < box.top + EDGE) scroller.scrollTop -= EDGE_STEP;
      else if (y > box.bottom - EDGE) scroller.scrollTop += EDGE_STEP;
    }
    const rows = [...list.querySelectorAll('.pg-swipe')];
    const below = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return y < b.top + b.height / 2;
    });
    if (moveTo(section, key, below < 0 ? rows.length - 1 : below)) moved.current = true;
  };
  const byKey = (section: ReorderSection, key: string) => section.items.find((i) => i.key === key);

  return (
    <PhoneSheet title={title} onClose={onClose}>
      <div className="pg-rows pg-reorder">
        {sections.map((s) => (
          <div key={s.key} ref={(el) => void (el ? lists.current.set(s.key, el) : lists.current.delete(s.key))}>
            <Group title={s.title}>
              {orders[s.key].map((key, i) => {
                const item = byKey(s, key);
                if (!item) return null;
                return (
                  <SwipeRow key={key} className={dragging === key ? 'pg-reordering' : undefined}>
                    <Row
                      title={item.title}
                      sub={item.sub}
                      value={
                        <span
                          className="pg-reorder-handle"
                          role="button"
                          tabIndex={0}
                          aria-label={`Move ${typeof item.title === 'string' ? item.title : 'row'}`}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            moved.current = false;
                            setDragging(key);
                          }}
                          onPointerMove={(e) => {
                            if (dragging === key) dragOver(s.key, key, e.clientY);
                          }}
                          onPointerUp={() => {
                            setDragging(null);
                            if (moved.current) onReorder(s.key, orders[s.key]);
                          }}
                          onPointerCancel={() => setDragging(null)}
                          onContextMenu={(e) => e.preventDefault()}
                          onKeyDown={(e) => {
                            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                            e.preventDefault();
                            const next = moveTo(s.key, key, i + (e.key === 'ArrowUp' ? -1 : 1));
                            if (next) onReorder(s.key, next);
                          }}
                        >
                          <svg width="20" height="14" viewBox="0 0 20 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                            <path d="M2 2h16M2 7h16M2 12h16" />
                          </svg>
                        </span>
                      }
                    />
                  </SwipeRow>
                );
              })}
            </Group>
          </div>
        ))}
      </div>
    </PhoneSheet>
  );
}
