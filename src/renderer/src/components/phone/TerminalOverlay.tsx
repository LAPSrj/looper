/** The terminal and the view that covers it, between the notices above and the key row below. */
export const TERMINAL_STAGE: React.CSSProperties = { flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' };

/**
 * What covers a terminal on a phone while its session is on the way: a spinner
 * and "Starting…". React markup over the terminal, not text typed into it.
 */
export function TerminalOverlay() {
  return (
    <div className="terminal-empty" role="status">
      <span className="pg-spinner" aria-hidden="true" />
      <span className="terminal-empty-title">Starting…</span>
    </div>
  );
}
