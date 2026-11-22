import type { CSSProperties } from 'react';

/** A note in place of a preview's content (Loading…, an error), styled inline: the phone frames and the desktop have different stylesheets. */
export const NOTE: CSSProperties = { margin: 'auto', padding: 24, textAlign: 'center', opacity: 0.6 };

/** A preview that fills the viewer and scrolls itself. */
export const FILL: CSSProperties = { flex: 1, minHeight: 0, minWidth: 0, alignSelf: 'stretch', display: 'flex', flexDirection: 'column' };
