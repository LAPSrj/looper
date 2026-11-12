import type { ReactNode } from 'react';
import { isPhone } from '../web/page-nav';

/**
 * A window's status bar: its facts at the start (each a span), and `end`'s after the space between, at the end.
 * A phone has none: what it says shows where it's needed there (a chat's Usage sheet).
 */
export function StatusBar({ children, end }: { children: ReactNode; end?: ReactNode }) {
  if (isPhone) return null;
  return (
    <div className="statusbar">
      {children}
      {end !== undefined && (
        <>
          <span className="spacer" />
          {end}
        </>
      )}
    </div>
  );
}
