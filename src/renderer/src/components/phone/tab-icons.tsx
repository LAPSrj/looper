import type { ReactNode } from 'react';

/**
 * The tab bar's icons, drawn on a 24-point grid as the platforms' own are. The shapes marked `fill` are filled on
 * iOS, which prefers filled symbols in a tab bar (phone.css); the checklist has no filled form.
 */
const TAB_ICONS: Record<string, ReactNode> = {
  dashboard: (
    <>
      <rect className="fill" x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect className="fill" x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect className="fill" x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect className="fill" x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  projects: <path className="fill" d="M2.5 18.5v-12a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5h9a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5Z" />,
  tasks: (
    <>
      <path d="m3.5 5 1.8 1.8 3.2-3.3M3.5 12l1.8 1.8 3.2-3.3M3.5 19l1.8 1.8 3.2-3.3" />
      <path d="M11.5 5.5h9M11.5 12.5h9M11.5 19.5h9" />
    </>
  ),
  sessions: (
    <>
      <path className="fill" d="M2.5 4h12v8.5H7.5l-3.5 3v-3H2.5Z" />
      <path d="M17.5 8h4v8.5h-1.5v3l-3.5-3H10v-1.5" />
    </>
  ),
  more: (
    <>
      <circle className="fill" cx="5.5" cy="12" r="1.2" />
      <circle className="fill" cx="12" cy="12" r="1.2" />
      <circle className="fill" cx="18.5" cy="12" r="1.2" />
    </>
  ),
};

/** A view's 24 px icon. */
export function TabIcon({ id }: { id: string }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {TAB_ICONS[id]}
    </svg>
  );
}
