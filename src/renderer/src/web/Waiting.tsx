import { platform } from '../platform';
import './offline.css';

/** The phone's first screen when the computer doesn't answer and nothing from an earlier launch is kept. */
export function Waiting({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={`offline-waiting ${platform}`}>
      <div className="offline-waiting-body">
        <h1>Can't Reach Looper</h1>
        <p>Trying again…</p>
        <button type="button" onClick={onRetry}>
          Try Again
        </button>
      </div>
    </div>
  );
}
