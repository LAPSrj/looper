import { useLayoutEffect } from 'react';
import { platform } from '../platform';
import './offline.css';

/** The phone's first screen when the computer doesn't answer and nothing from an earlier launch is kept. */
export function Waiting({ onRetry }: { onRetry: () => void }) {
  // The page behind it takes its color by a class, not html:has(), which made every desktop window check its
  // whole document's style each time an element was added (237 times going back to a dashboard of chats).
  useLayoutEffect(() => {
    if (platform !== 'ios') return;
    document.documentElement.classList.add('offline-waiting-ios');
    return () => document.documentElement.classList.remove('offline-waiting-ios');
  }, []);
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
