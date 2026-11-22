import { Fragment, memo, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import type { ChatState } from '@shared/chat';
import { harnessKindLabel } from '@shared/environments';
import type { MessageRow } from '@shared/messages';
import { Measured } from '../perf';
import { ChatRow, ToolGroup, type RowCtx } from './ChatRows';
import type { ChatItem } from './chat-groups';
import { firstBelow } from './kept-place';
import { atEnd, CARD_ITEMS, FIRST_ITEMS, readPlace, useKeepPlace, useNewestFirst, useStayAtEnd } from './newest-first';

/**
 * A run of a conversation's items under one heading (a chat's earlier sessions, then the chat itself). The first
 * part's heading shows while any of it is drawn; a later part's marks where it starts, so it shows where that is drawn.
 * `key` prefixes its items' keys, so the parts' ids may repeat.
 */
export interface ConversationPart {
  key: string;
  items: ChatItem[];
  heading?: string;
}

export interface ConversationHandle {
  /** The reader's own message went: draw the newest items if they aren't, and stay at the end. */
  toEnd(): void;
  /** Something moved the view (Find): don't pull it back to the end. */
  leaveEnd(): void;
}

const Items = memo(function Items({ items, ctx, prefix, card }: { items: ChatItem[]; ctx: RowCtx; prefix: string; card?: ReactNode }) {
  return (
    <>
      {items.map((item, i) =>
        item.kind === 'tools' ? (
          <ToolGroup key={prefix + item.rows[0].id} rows={item.rows} ctx={ctx} />
        ) : card && i === items.length - 1 ? (
          // The card takes the reply's width: both stretch to the wider of the two.
          <div className="chat-agent-group" key={prefix + item.row.id}>
            <ChatRow row={item.row} ctx={ctx} />
            {card}
          </div>
        ) : (
          <ChatRow key={prefix + item.row.id} row={item.row} ctx={ctx} />
        ),
      )}
    </>
  );
});

/** The first `count` items' elements: each item draws one, and the headings are the only others among them. */
const itemEls = (el: HTMLElement, count: number): Element[] =>
  [...el.children].filter((c) => !c.classList.contains('chat-divider')).slice(0, Math.max(0, count));

/** Where the scroller's view starts on the screen. */
const viewTop = (el: HTMLElement): number => el.getBoundingClientRect().top + el.clientTop;

/**
 * A conversation's scroller: its items (rows and tool groups), newest first, keeping a reader at the end there.
 * `endKey`: what changing brings a reader at the end back to it. `drawAll`: every item drawn, for a Find over
 * `scrollRef`. `card`: one of several on a dashboard, drawing only its newest items. `keepPlace`: where the reader
 * is comes back with the page (useKeepPlace). `replyCard`: a card under the newest item, beside the agent's reply
 * when that's what it is. `children`: what follows the newest item, drawn once it is.
 */
export function Conversation({
  id,
  parts,
  ctx,
  endKey,
  scrollRef: givenRef,
  drawAll = false,
  card = false,
  keepPlace = false,
  replyCard,
  onContextMenu,
  measure = 'Chat rows',
  ref,
  children,
}: {
  id: string;
  parts: ConversationPart[];
  ctx: RowCtx;
  endKey: string;
  scrollRef?: RefObject<HTMLDivElement | null>;
  drawAll?: boolean;
  card?: boolean;
  keepPlace?: boolean;
  replyCard?: ReactNode;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** What perf.log calls its rows' renders. */
  measure?: string;
  ref?: Ref<ConversationHandle>;
  children?: ReactNode;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const scrollRef = givenRef ?? ownRef;
  // A page coming back (a phone back from another app) puts the reader where they were; one opened anew starts at its end.
  const [place] = useState(() => (keepPlace ? readPlace(id) : null));
  const atBottom = useRef(!place || place.atEnd);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const kept = el && place && !place.atEnd ? itemEls(el, 1)[0] : undefined;
    if (el && kept) el.scrollTop += kept.getBoundingClientRect().top - viewTop(el) + place!.offset;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useStayAtEnd(scrollRef, atBottom, endKey);

  const total = parts.reduce((n, p) => n + p.items.length, 0);
  // A chat's history comes ahead of its own rows, read in after it opened: what's drawn stays the newest items.
  const lead = total - (parts.at(-1)?.items.length ?? 0);
  const { hidden, newer, onScroll: showMore, toEnd } = useNewestFirst(
    scrollRef,
    id,
    total,
    drawAll,
    card ? CARD_ITEMS : FIRST_ITEMS,
    place && !place.atEnd ? place.item : undefined,
    lead,
  );
  const end = total - newer;
  const savePlace = useKeepPlace(
    id,
    () => {
      const el = scrollRef.current;
      if (!el) return null;
      const els = itemEls(el, end - hidden);
      if (els.length === 0) return { item: hidden, offset: 0 };
      const top = viewTop(el);
      const i = firstBelow(els.length, (n) => els[n].getBoundingClientRect().bottom, top);
      return { item: hidden + i, offset: Math.round(top - els[i].getBoundingClientRect().top) };
    },
    atBottom,
    !keepPlace,
  );
  useImperativeHandle(
    ref,
    () => ({
      toEnd: () => {
        if (newer > 0) toEnd();
        atBottom.current = true;
      },
      leaveEnd: () => {
        atBottom.current = false;
      },
    }),
    [newer, toEnd],
  );

  // Each part's drawn items, the same array while they are, so its rows don't render again.
  const slices = useRef(new Map<string, { items: ChatItem[]; from: number; to: number; drawn: ChatItem[] }>());
  const drawnOf = (part: ConversationPart, from: number, to: number): ChatItem[] => {
    const was = slices.current.get(part.key);
    if (was && was.items === part.items && was.from === from && was.to === to) return was.drawn;
    const drawn = part.items.slice(from, to);
    slices.current.set(part.key, { items: part.items, from, to, drawn });
    return drawn;
  };
  const last = parts.at(-1)?.items.at(-1);
  const cardUnder = !!replyCard && newer === 0 && last?.kind === 'row' && last.row.kind === 'agent';

  let start = 0;
  const drawn = parts.map((part, n) => {
    const at = start;
    start += part.items.length;
    const items = drawnOf(part, Math.max(0, Math.min(hidden - at, part.items.length)), Math.max(0, Math.min(end - at, part.items.length)));
    const heading = !!part.heading && (n === 0 ? items.length > 0 : hidden <= at && end >= at);
    return (
      <Fragment key={part.key}>
        {heading && <div className="pane-title chat-divider">{part.heading}</div>}
        <Items items={items} ctx={ctx} prefix={part.key} card={cardUnder && n === parts.length - 1 ? replyCard : undefined} />
      </Fragment>
    );
  });

  return (
    <div
      className="chat-scroll"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        // The end of what's drawn is the conversation's end only once its newest item is drawn.
        atBottom.current = newer === 0 && atEnd(el);
        showMore(el);
        savePlace();
      }}
      onContextMenu={onContextMenu}
    >
      <Measured id={measure}>{drawn}</Measured>
      {/* What follows the newest item waits until it's drawn. */}
      {newer === 0 && !cardUnder && replyCard}
      {newer === 0 && children}
    </div>
  );
}

/** The description of the tool call still running (its `description` input), looking at the newest rows. */
function runningDescription(rows: readonly MessageRow[]): string | undefined {
  for (let i = rows.length - 1; i >= 0 && i >= rows.length - 20; i--) {
    const r = rows[i];
    if (r.kind !== 'tool' || r.result !== undefined) continue;
    const d = (r.input as { description?: unknown } | undefined)?.description;
    if (typeof d === 'string' && d.trim()) return d.trim();
  }
  return undefined;
}

/** The conversation's last line: what the agent is doing, or why the conversation ended. */
export function ChatStatus({ state }: { state: Pick<ChatState, 'harnessKind' | 'status' | 'error'> & { permissions?: readonly unknown[]; harnessName?: string; rows?: readonly MessageRow[] } }) {
  const harness = harnessKindLabel(state.harnessKind);
  if (state.permissions?.length) return <div className="chat-status chat-working muted">{harness} is waiting for your answer.</div>;
  if (state.status === 'working') {
    const doing = state.rows ? runningDescription(state.rows) : undefined;
    return <div className="chat-status chat-working muted">{doing ? `${state.harnessName ?? harness}: ${doing}` : `${harness} is working…`}</div>;
  }
  if (state.status === 'starting') return <div className="chat-status chat-working muted">Starting {harness}…</div>;
  if (state.status === 'ended') return <div className="chat-status chat-working error-text">{state.error ?? 'The session ended.'}</div>;
  return null;
}
