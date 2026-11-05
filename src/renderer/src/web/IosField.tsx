import type { ReactNode } from 'react';

/** A cell of the iOS frame's own lists (ios.css): its label, then its text box. */
export function IosField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ios-cell ios-field">
      <span className="ios-cell-label">{label}</span>
      {children}
    </label>
  );
}
