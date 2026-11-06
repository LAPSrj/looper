import { useEffect, useMemo, useRef, useState } from 'react';
import { engineLogSource } from '@shared/addons';
import { capFirst, fmtDate, fmtTime } from './format';
import { DataTable, type DataCol } from './components/DataTable';
import { ListDetail, selectsFirstRow } from './components/ListDetail';

interface LogEntry {
  ts: string;
  level: string;
  message: string;
}

const LOG_COLS: readonly DataCol<LogEntry>[] = [
  { label: 'Date', width: 92, cell: (en) => fmtDate(en.ts) },
  { label: 'Time', width: 76, cell: (en) => fmtTime(en.ts) },
  { label: 'Level', width: 64, cell: (en) => capFirst(en.level) },
  { label: 'Message', cell: (en) => en.message.split('\n')[0], title: (en) => en.message },
];

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \[(debug|info|warn|error)\] (.*)$/;

/** One entry per timestamped line; untimestamped lines (stack traces) continue the previous entry. */
function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (m) entries.push({ ts: m[1], level: m[2], message: m[3] });
    else if (line && entries.length > 0) entries[entries.length - 1].message += '\n' + line;
  }
  return entries;
}

const POLL_MS = 2000;

interface Hidden {
  sources: string[];
  levels: string[];
}

const shown = (h: Hidden) => (en: LogEntry) => !h.levels.includes(en.level) && !h.sources.includes(engineLogSource(en.message));

export function EngineLogApp() {
  const [all, setAll] = useState<LogEntry[]>([]);
  // The View menu's choices: everything shows until it hides something.
  const [hidden, setHidden] = useState<Hidden>({ sources: [], levels: [] });
  const entries = useMemo(() => all.filter(shown(hidden)), [all, hidden]);
  const [selected, setSelected] = useState<number | null>(null);
  // The selection is the tail's until a row is picked: on a phone or tablet only a pick opens a line.
  const [followsTail, setFollowsTail] = useState(true);
  const lastTextRef = useRef<string | null>(null);
  const stateRef = useRef({ count: 0, selected: null as number | null, hidden, opened: false });
  stateRef.current = { count: entries.length, selected, hidden, opened: !selectsFirstRow && !followsTail };

  useEffect(() => {
    document.title = 'Engine Log';
    let cancelled = false;
    const load = async () => {
      const text = await window.looper.readEngineLog();
      if (cancelled || text === lastTextRef.current) return;
      lastTextRef.current = text;
      const next = parseLog(text);
      const { count, selected: sel, hidden: h, opened } = stateRef.current;
      const visible = next.filter(shown(h)).length;
      setAll(next);
      // Follow the tail unless the user moved off the last entry, or opened it to read.
      if (!opened && (sel === null || sel === count - 1 || sel >= visible)) {
        setSelected(visible > 0 ? visible - 1 : null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // A change in the View menu lists a different set of entries: select its last one.
  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type !== 'engine-log-view') return;
        const h = { sources: e.hiddenSources, levels: e.hiddenLevels };
        const visible = parseLog(lastTextRef.current ?? '').filter(shown(h)).length;
        setHidden(h);
        setSelected(visible > 0 ? visible - 1 : null);
      }),
    [],
  );

  const current = selected === null ? null : (entries[selected] ?? null);

  return (
    <div className="run-detail-app">
      <ListDetail
        panes={{ axis: 'y', initial: 65, unit: '%', min: 15, max: 85 }}
        open={!followsTail && current !== null}
        onClose={() => {
          setFollowsTail(true);
          setSelected(entries.length > 0 ? entries.length - 1 : null);
        }}
        detailTitle={current ? capFirst(current.level) : undefined}
        empty="Select a line"
        list={
          <DataTable
            cols={LOG_COLS}
            rows={entries}
            rowKey={(_en, i) => String(i)}
            idPrefix="line"
            storageKey="engine-log"
            rowClass={(en) => `level-${en.level}`}
            selected={followsTail && !selectsFirstRow ? null : selected === null ? null : String(selected)}
            onSelect={(_en, i) => {
              setFollowsTail(false);
              setSelected(i);
            }}
            copyText={(en) => en.message}
            empty="No log entries."
            phoneRow={(en) => ({
              title: en.message.split('\n')[0],
              sub: `${fmtDate(en.ts)} ${fmtTime(en.ts)} · ${capFirst(en.level)}`,
              tone: en.level === 'error' ? 'error' : en.level === 'warn' ? 'warning' : en.level === 'debug' ? 'muted' : undefined,
            })}
          />
        }
        detail={<div className="runlog-result">{current ? <pre className="output">{current.message}</pre> : <div className="runlog-result-empty muted">Select a line</div>}</div>}
      />
    </div>
  );
}
