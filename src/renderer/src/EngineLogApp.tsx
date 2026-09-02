import { useEffect, useRef, useState } from 'react';
import { capFirst, fmtDate, fmtTime } from './format';
import { useDragResize, useListNav } from './components/hooks';

interface LogEntry {
  ts: string;
  level: string;
  message: string;
}

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

export function EngineLogApp() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [splitPct, setSplitPct] = useState(65);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastTextRef = useRef<string | null>(null);
  const stateRef = useRef({ count: 0, selected: null as number | null });
  stateRef.current = { count: entries.length, selected };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const text = await window.looper.readEngineLog();
      if (cancelled || text === lastTextRef.current) return;
      lastTextRef.current = text;
      const next = parseLog(text);
      const { count, selected: sel } = stateRef.current;
      setEntries(next);
      // Follow the tail unless the user moved off the last entry.
      if (sel === null || sel === count - 1 || sel >= next.length) {
        setSelected(next.length > 0 ? next.length - 1 : null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const current = selected === null ? null : (entries[selected] ?? null);
  const nav = useListNav({
    count: entries.length,
    index: selected ?? -1,
    onIndex: (i) => setSelected(i),
    scrollToId: selected !== null ? `line-${selected}` : null,
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'c' && current) {
      void navigator.clipboard.writeText(current.message);
      e.preventDefault();
      return;
    }
    nav(e);
  };

  const onDragStart = useDragResize({
    axis: 'y',
    containerRef,
    onDrag: (y, rect) => setSplitPct(Math.max(15, Math.min(85, (y / rect.height) * 100))),
  });

  return (
    <div className="run-detail-app" ref={containerRef}>
      <div className="run-detail-table-wrap" style={{ height: `${splitPct}%` }} tabIndex={0} onKeyDown={onKeyDown}>
        <table className="runlog-table">
          <colgroup>
            <col style={{ width: 92 }} />
            <col style={{ width: 76 }} />
            <col style={{ width: 64 }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Date</th>
              <th>Time</th>
              <th>Level</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((en, i) => (
              <tr
                key={i}
                id={`line-${i}`}
                className={`level-${en.level}${selected === i ? ' selected' : ''}`}
                onClick={() => setSelected(i)}
              >
                <td>{fmtDate(en.ts)}</td>
                <td>{fmtTime(en.ts)}</td>
                <td>{capFirst(en.level)}</td>
                <td title={en.message}>{en.message.split('\n')[0]}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No log entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="run-detail-divider" onMouseDown={onDragStart} />
      <div className="run-detail-output" style={{ height: `calc(${100 - splitPct}% - 5px)` }}>
        {current ? (
          <pre className="output">{current.message}</pre>
        ) : (
          <div className="run-detail-empty muted">Select a line</div>
        )}
      </div>
    </div>
  );
}
