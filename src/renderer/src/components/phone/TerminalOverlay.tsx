import { Icon } from '../Icon';
import { ICONS } from '../icons';

/** The terminal and the view that covers it, between the notices above and the key row below. */
export const TERMINAL_STAGE: React.CSSProperties = { flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' };

/**
 * What covers a terminal on a phone while it has nothing to show: a spinner and
 * "Starting…" while its session is on the way, or an empty view (icon, title,
 * a button when there's something to start) when there's none. React markup
 * over the terminal, not text typed into it.
 */
export function TerminalOverlay({ kind, title, message, action }: { kind: 'starting' | 'empty'; title?: string; message?: string; action?: { label: string; run: () => void } }) {
  if (kind === 'starting') {
    return (
      <div className="terminal-empty" role="status">
        <span className="pg-spinner" aria-hidden="true" />
        <span className="terminal-empty-title">Starting…</span>
      </div>
    );
  }
  return (
    <div className="terminal-empty">
      <span className="terminal-empty-icon" aria-hidden="true">
        <Icon>{ICONS.terminal}</Icon>
      </span>
      <span className="terminal-empty-title">{title ?? 'No Agent Session'}</span>
      {message && <span className="terminal-empty-message">{message}</span>}
      {action && (
        <button className="btn primary" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
