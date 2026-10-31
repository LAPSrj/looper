import type { TabStatus } from './tabs-model';

/**
 * A state as a small mark: a turning arc while it runs, a check when it's done,
 * an exclamation mark when it failed, the arc standing still when it waits.
 * Its colors keep 3:1 against the tab and list backgrounds in both themes. It's
 * hidden from assistive technology: whoever uses it names the state in words.
 */
export function StatusMark({ status }: { status: TabStatus }) {
  return (
    <svg className={`status-mark ${status}`} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {status === 'done' ? (
        <path d="m3.5 8.5 3 3 6-7" />
      ) : status === 'failed' ? (
        <>
          <path d="M8 3v6" />
          <circle cx="8" cy="12.4" r="0.6" fill="currentColor" />
        </>
      ) : (
        <circle className="status-mark-arc" cx="8" cy="8" r="5.6" strokeDasharray="26 36" />
      )}
    </svg>
  );
}
