import { useEffect, useRef, useState } from 'react';
import { HISTORY_PAGE, NO_HISTORY_COMMANDS, type HistoryCommands, type HistoryConversation, type HistoryFolderFilter, type HistoryItem, type HistoryList as HistoryListResult, type HistoryRunFilter } from '@shared/history';
import type { MessageRow } from '@shared/messages';
import { EmptyState } from './EmptyState';
import { SubagentTabs } from './SubagentIcon';
import { TranscriptView } from './Transcript';
import { subscribe } from '../events';
import { reportError } from '../report-error';

/**
 * The History window's list, as a project's Chats tab shows it too: what the
 * engine knows at once, then, with `scan` on opening and on each `refreshes`,
 * what the folders hold now. The latest load wins, and each call's list shows
 * as the engine reads it (history-progress), so the first conversations show
 * while the rest are read. Show More reads the next page. `runs` lists Task History's task runs instead of the
 * conversations (they're all in the engine's index, so there's no folder to scan).
 */
export function useHistoryList({ ready, runs, folder, refreshes, scan }: { ready: boolean; runs?: HistoryRunFilter; folder: HistoryFolderFilter; refreshes: number; scan: boolean }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const loads = useRef(0);
  const freshDone = useRef(scan ? 0 : refreshes);
  const scanning = useRef(false);
  /** The current load's calls, by request number: what each one's list so far does. */
  const progress = useRef(new Map<number, (l: HistoryListResult) => void>());
  /** The filters the last load listed with, and the list it shows. */
  const lastFilters = useRef('');
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const runsKey = JSON.stringify(runs ?? null);

  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type === 'history-progress') progress.current.get(e.request)?.(e.list);
      }),
    [],
  );

  useEffect(() => {
    if (!ready) return;
    const n = ++loads.current;
    const o = { limit, folder, ...(runsKey === 'null' ? {} : { runs: JSON.parse(runsKey) as HistoryRunFilter }) };
    // A filter or Show More while the folders are read waits for them too, so it doesn't list the old files.
    const fresh = scan && (refreshes !== freshDone.current || scanning.current);
    freshDone.current = refreshes;
    let freshIn = false;
    // How many conversations show now: a list on its way never shows fewer than that. With the same
    // filters (Show More, Refresh) the list already shown counts; a filter changed lists other conversations.
    const filters = JSON.stringify([runsKey, folder]);
    let shown = filters === lastFilters.current ? (itemsRef.current?.length ?? -1) : -1;
    lastFilters.current = filters;
    const take = (l: HistoryListResult, partial: boolean) => {
      if (n !== loads.current) return;
      shown = l.items.length;
      setItems(l.items);
      setMore(partial || l.more);
      // A list on its way ends in a greyed Loading… where Show More goes, until the rest is read.
      if (partial) setLoadingMore(true);
    };
    const quickReq = n * 2;
    const freshReq = n * 2 + 1;
    progress.current.clear();
    progress.current.set(quickReq, (l) => {
      if (!freshIn && l.items.length > shown) take(l, true);
    });
    progress.current.set(freshReq, (l) => {
      if (!freshIn && l.items.length > shown) take(l, true);
    });
    const quick = window.looper.history.list({ ...o, fresh: false, request: quickReq }).then((l) => {
      if (!freshIn && l.items.length >= shown) take(l, false);
    }, reportError);
    if (!fresh) {
      void quick.finally(() => n === loads.current && setLoadingMore(false));
      return;
    }
    scanning.current = true;
    void window.looper.history
      .list({ ...o, fresh: true, request: freshReq })
      .then((l) => {
        freshIn = true;
        take(l, false);
      }, reportError)
      .finally(() => {
        scanning.current = false;
        if (n === loads.current) setLoadingMore(false);
      });
  }, [ready, runsKey, folder, limit, refreshes, scan]);

  const showMore = () => {
    setLoadingMore(true);
    setLimit((l) => l + HISTORY_PAGE);
  };
  return { items, more, loadingMore, showMore };
}

/**
 * The selected conversation of a History list, read only: its rows, its
 * subagents' (the one followed), and which commands it offers, read again
 * when a chat or terminal opens or closes on a conversation.
 */
export function useHistoryConversation(selected: string | null) {
  const [conv, setConv] = useState<HistoryConversation | null>(null);
  const [follow, setFollow] = useState<string | null>(null);
  const [subRows, setSubRows] = useState<MessageRow[]>([]);
  const [commands, setCommands] = useState<HistoryCommands>(NO_HISTORY_COMMANDS);
  const [nowPos, setNowPos] = useState<number | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const loadCommands = () => {
    const id = selectedRef.current;
    if (!id) return setCommands(NO_HISTORY_COMMANDS);
    void window.looper.history.commands(id).then((c) => {
      if (selectedRef.current === id) setCommands(c);
    });
  };

  // A chat or terminal opening or closing on a conversation changes what Continue offers.
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === 'sessions') loadCommands();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    setConv(null);
    setFollow(null);
    setNowPos(null);
    loadCommands();
    if (!selected) return;
    void window.looper.history.read(selected).then((c) => {
      if (selectedRef.current === selected) setConv(c ?? { rows: [], subagents: [] });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // A subagent's conversation, in its tab.
  useEffect(() => {
    setSubRows([]);
    setNowPos(null);
    if (!follow || !selected) return;
    void window.looper.history.read(selected, follow).then((c) => {
      if (selectedRef.current === selected) setSubRows(c?.rows ?? []);
    });
  }, [follow, selected]);

  return { conv, follow, setFollow, subRows, commands, nowPos, setNowPos };
}

/** A History list's selected conversation, read only, with its subagents' tabs and Continue in Chat. */
export function HistoryDetail({
  item,
  conv,
  follow,
  onFollow,
  subRows,
  commands,
}: {
  item: HistoryItem;
  conv: HistoryConversation | null;
  follow: string | null;
  onFollow: (agentId: string | null) => void;
  subRows: MessageRow[];
  commands: HistoryCommands;
}) {
  const subagents = conv?.subagents ?? [];
  const followed = subagents.find((a) => a.agentId === follow);
  const ctx = { taskId: item.taskId ?? '', runId: item.runId ?? '' };
  return (
    <main className="sessions-center">
      {!conv ? (
        <EmptyState>Loading…</EmptyState>
      ) : (
        <>
          {subagents.length > 0 && <SubagentTabs agents={subagents} follow={follow} onFollow={onFollow} />}
          {follow && followed ? (
            <TranscriptView key={`${item.id}:${follow}`} taskId={ctx.taskId} runId={ctx.runId} rows={subRows} waitingText="The subagent has no messages." rowMenu={false} />
          ) : (
            <TranscriptView key={item.id} taskId={ctx.taskId} runId={ctx.runId} rows={conv.rows} scriptCalls={conv.scriptCalls} waitingText={item.source === 'run' ? 'The run has no conversation.' : 'The conversation has no messages.'} rowMenu={false} />
          )}
          {commands.chat && (
            <div className="history-continue">
              <button className="btn primary" onClick={() => void window.looper.history.run(item.id, 'chat').catch(reportError)}>
                Continue in Chat
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
