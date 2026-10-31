import type { ReactNode } from 'react';
import type { HostPlace } from '../../../shared/remote-access';
import { ICONS } from '../components/icons';

/** The starting places' icons, as 16 px line paths (drawn by Icon on the desktop, larger on phones). */
export const PLACE_ICONS: Record<HostPlace, ReactNode> = {
  home: <path d="M2 7.5 8 2.5l6 5M3.5 6.3v7.2h3.2V10h2.6v3.5h3.2V6.3" />,
  desktop: (
    <>
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" />
      <path d="M8 11v2.5M5 13.5h6" />
    </>
  ),
  documents: <path d="M4 1.5h5l3 3v10H4ZM9 1.5v3h3M6 8h4M6 10.5h4" />,
  downloads: <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 11.5v2h11v-2" />,
  pictures: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <circle cx="5.5" cy="6" r="1.2" />
      <path d="m1.5 12 4-3.5 3 2.5 2-1.5 4 3" />
    </>
  ),
  music: (
    <>
      <path d="M6.5 12V3l7-1.5V10.5" />
      <circle cx="4.5" cy="12" r="2" />
      <circle cx="11.5" cy="10.5" r="2" />
    </>
  ),
  videos: (
    <>
      <rect x="1.5" y="3.5" width="9" height="9" rx="1" />
      <path d="m10.5 7 4-2.5v7l-4-2.5" />
    </>
  ),
  drive: (
    <>
      <rect x="1.5" y="5" width="13" height="6" rx="1" />
      <path d="M11.5 8h.01M4 8h4" />
    </>
  ),
  linux: ICONS.terminal,
  project: ICONS.folder,
};

/** A starting place's icon at phone size: the same line paths, drawn 28 px. */
export function PlaceGlyph({ place }: { place: HostPlace }) {
  return (
    <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PLACE_ICONS[place]}
    </svg>
  );
}
