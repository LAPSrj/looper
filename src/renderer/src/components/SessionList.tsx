import type { SessionSummary } from '@shared/sessions';
import { waitedText } from '@shared/sessions';

/** Status and context in one icon: the ring fills with the context, the dot says what the agent is doing. */
export function SessionIcon({ s }: { s: SessionSummary }) {
  const frac = s.context?.window ? Math.min(1, s.context.tokens / s.context.window) : null;
  const r = 7;
  const c = 2 * Math.PI * r;
  const state = s.waiting && s.waiting.reason !== 'turn' ? 'waiting' : s.waiting?.reason === 'turn' ? 'done' : s.status;
  return (
    <svg className={`session-icon ${state}`} width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} className="ring" fill="none" strokeWidth="2" />
      {frac !== null && (
        <circle
          cx="9"
          cy="9"
          r={r}
          className={`fill${frac >= 0.8 ? ' high' : frac >= 0.5 ? ' mid' : ''}`}
          fill="none"
          strokeWidth="2"
          strokeDasharray={`${frac * c} ${c}`}
          transform="rotate(-90 9 9)"
        />
      )}
      <circle cx="9" cy="9" r="3" className="core" />
    </svg>
  );
}

/** A session's status as a few words. */
export function statusText(s: SessionSummary): string {
  if (s.status === 'starting') return 'Starting';
  if (s.status === 'working') return 'Working';
  if (s.status === 'ended') return 'Ended';
  return 'Ready';
}

function Row({
  s,
  selected,
  sub,
  onSelect,
}: {
  s: SessionSummary;
  selected: boolean;
  sub: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      className={`session-row${selected ? ' selected' : ''}${s.waiting?.reason === 'turn' ? ' unread' : ''}`}
      onClick={() => onSelect(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect(s.id);
        window.looper.sessions.showContextMenu(s.id);
      }}
    >
      <SessionIcon s={s} />
      <div className="session-row-text">
        <div className="session-title">{s.title}</div>
        <div className="session-sub">{sub}</div>
      </div>
    </div>
  );
}

/** The sessions waiting for the user, the one that waited longest first. */
export const waitingOf = (sessions: SessionSummary[]): SessionSummary[] =>
  sessions.filter((s) => s.waiting).sort((a, b) => a.waiting!.since - b.waiting!.since);

/** The key a group's collapsed state is saved under. */
const WAITING_KEY = '@waiting';

/** A group's header: a chevron and its name; a click opens or closes it. */
function GroupHeader({ name, open, count, onToggle }: { name: string; open: boolean; count: number; onToggle: () => void }) {
  return (
    <div className="session-group" onClick={onToggle} role="button" aria-expanded={open}>
      <svg
        className={`chev${open ? ' open' : ''}`}
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3.5 1.5 7 5l-3.5 3.5" />
      </svg>
      <span className="session-group-name">{name}</span>
      {!open && <span className="session-group-count">{count}</span>}
    </div>
  );
}

/**
 * The Sessions window's list: Waiting for you, then each project's sessions,
 * each group closable. Up and Down move through the sessions shown, and a
 * click on the empty space below shows the dashboard.
 */
export function SessionList({
  sessions,
  selected,
  now,
  collapsed,
  onToggle,
  onSelect,
}: {
  sessions: SessionSummary[];
  selected: string | null;
  now: number;
  /** The closed groups' keys: a project's id, or its name without one. */
  collapsed: string[];
  onToggle: (key: string) => void;
  onSelect: (id: string | null) => void;
}) {
  const waiting = waitingOf(sessions);
  const groups: { key: string; name: string; items: SessionSummary[] }[] = [];
  for (const s of sessions) {
    const key = s.projectId ?? s.groupName;
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(s);
    else groups.push({ key, name: s.groupName, items: [s] });
  }
  const isOpen = (key: string) => !collapsed.includes(key);
  const visible = groups.filter((g) => isOpen(g.key)).flatMap((g) => g.items);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    if (visible.length === 0) return;
    e.preventDefault();
    const at = visible.findIndex((s) => s.id === selected);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? visible.length - 1 : e.key === 'ArrowDown' ? Math.min(visible.length - 1, at + 1) : Math.max(0, at - 1);
    onSelect(visible[next].id);
  };
  const terminal = (s: SessionSummary) => (s.kind === 'terminal' ? 'Terminal · ' : '');
  return (
    <div
      className="session-list"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
    >
      {waiting.length > 0 && (
        <>
          <GroupHeader name="Waiting for you" open={isOpen(WAITING_KEY)} count={waiting.length} onToggle={() => onToggle(WAITING_KEY)} />
          {isOpen(WAITING_KEY) &&
            waiting.map((s) => (
              <Row
                key={`w-${s.id}`}
                s={s}
                selected={selected === s.id}
                sub={`${s.waiting!.text} · ${waitedText(now - s.waiting!.since)}`}
                onSelect={onSelect}
              />
            ))}
        </>
      )}
      {groups.map((g) => (
        <div key={g.key}>
          <GroupHeader name={g.name} open={isOpen(g.key)} count={g.items.length} onToggle={() => onToggle(g.key)} />
          {isOpen(g.key) &&
            g.items.map((s) => (
              <Row key={s.id} s={s} selected={selected === s.id} sub={terminal(s) + (s.latest ?? statusText(s))} onSelect={onSelect} />
            ))}
        </div>
      ))}
      {sessions.length === 0 && <div className="empty session-empty">No sessions are open.</div>}
    </div>
  );
}
