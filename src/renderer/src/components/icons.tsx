import type { ReactNode } from 'react';
import type { AddonIconName } from '@shared/addons';

/** SVG paths of Looper's 16 px line icons (drawn by Icon), shared by the task toolbar and addon toolbars. */
export const ICONS: Record<AddonIconName | 'dashboard' | 'resume' | 'power' | 'complete' | 'guidance', ReactNode> = {
  dashboard: (
    <>
      <rect x="2.5" y="2.5" width="4" height="4" rx="0.5" />
      <rect x="9.5" y="2.5" width="4" height="4" rx="0.5" />
      <rect x="2.5" y="9.5" width="4" height="4" rx="0.5" />
      <rect x="9.5" y="9.5" width="4" height="4" rx="0.5" />
    </>
  ),
  run: <path d="M4.5 2.8v10.4L13 8Z" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  resume: <path d="M3.5 3.5v9M6.5 3.2 13.5 8l-7 4.8Z" />,
  power: (
    <>
      <path d="M8 2v5.5" />
      <path d="M11.5 4.2a5 5 0 1 1-7 0" />
    </>
  ),
  complete: (
    <>
      <path d="M8 14.5A6.5 6.5 0 1 1 8 1.5a6.5 6.5 0 0 1 0 13Z" />
      <path d="m5 8 2.2 2.2L11 6" />
    </>
  ),
  guidance: <path d="M2.5 3.5h11v7.5H7l-3 2.5v-2.5H2.5Z" />,
  edit: <path d="m11.3 2.7 2 2L5.5 12.5l-2.8.8.8-2.8Z" />,
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="m4 6 2.5 2L4 10M8.5 10.5h3.5" />
    </>
  ),
  folder: <path d="M1.5 12.5v-8a1 1 0 0 1 1-1h3.2L7 5h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />,
  add: <path d="M8 3v10M3 8h10" />,
  delete: <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.8 9h6.4l.8-9" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" />,
  open: <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />,
  key: (
    <>
      <circle cx="5" cy="11" r="2.5" />
      <path d="m6.8 9.2 6.2-6.2M11 5l1.5 1.5M9.5 6.5 11 8" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="7" width="10" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.3 10.3 3.2 3.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
};
