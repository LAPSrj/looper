import type { ReactNode } from 'react';
import { ICONS } from '../icons';

/** The tab bar's icons, drawn on a 24-point grid as the platforms' own are. */
const TAB_ICONS: Record<string, ReactNode> = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  projects: <path d="M2.5 18.5v-12a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5h9a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5Z" />,
  tasks: (
    <>
      <path d="m3.5 6 1.8 1.8L8.5 4.5M3.5 13l1.8 1.8 3.2-3.3M3.5 20l1.8 1.8" />
      <path d="M11.5 6.5h9M11.5 13.5h9M11.5 20.5h9" />
    </>
  ),
  sessions: (
    <>
      <path d="M2.5 4h12v8.5H7.5l-3.5 3v-3H2.5Z" />
      <path d="M17.5 8h4v8.5h-1.5v3l-3.5-3H10v-1.5" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18.5" cy="12" r="1.2" />
    </>
  ),
};

/** A view's 24 px icon; an addon's tab draws its ICONS entry, whose box is 16. */
export function TabIcon({ id, addonIcon }: { id: string; addonIcon?: string }) {
  const own = TAB_ICONS[id];
  return (
    <svg width="24" height="24" viewBox={own ? '0 0 24 24' : '0 0 16 16'} fill="none" stroke="currentColor" strokeWidth={own ? 1.6 : 1.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {own ?? (ICONS as Record<string, ReactNode>)[addonIcon ?? '']}
    </svg>
  );
}
