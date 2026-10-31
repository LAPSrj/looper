import { Component, useLayoutEffect, type ReactNode } from 'react';

/**
 * Rendered beside a window's lazy app inside the same Suspense boundary: its
 * layout effect runs only once that app's code has loaded and committed, not
 * for the empty fallback, so `onReady` means the window's real content is in.
 */
export function WindowReady({ onReady }: { onReady: () => void }) {
  useLayoutEffect(() => {
    onReady();
  }, [onReady]);
  return null;
}

/** A window whose code couldn't load (its chunk missing offline) or that failed to render says so, and still counts as ready, so the phone shell shows it. */
export class WindowBoundary extends Component<{ onFailed: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onFailed();
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty window-failed">
        <p>This window couldn't load.</p>
        <button className="btn" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
