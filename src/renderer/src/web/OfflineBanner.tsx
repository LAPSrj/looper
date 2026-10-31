import { fmtClock } from '../format';
import { platform } from '../platform';
import type { Connection } from './connection';
import './offline.css';

/** A full-width row under the top bar while the computer can't be reached. */
export function OfflineBanner({ connection }: { connection: Connection }) {
  if (connection.connected || !connection.stale) return null;
  const { updatedAt, retry } = connection;
  return (
    <div className={`offline-banner ${platform}`} role="status">
      <svg className="offline-banner-icon" width="17" height="17" viewBox="0 0 17 17" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="8.5" fill="currentColor" />
        <path d="M8.5 4.4v4.6" style={{ stroke: 'var(--offline-mark)' }} strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8.5" cy="12.3" r="1.1" style={{ fill: 'var(--offline-mark)' }} />
      </svg>
      <span className="offline-banner-text">{updatedAt === null ? 'Not connected' : `Not connected. Updated ${fmtClock(updatedAt, Date.now())}`}</span>
      <button type="button" className="offline-banner-retry" onClick={retry}>
        Try Now
      </button>
    </div>
  );
}
