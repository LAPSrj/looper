import { uiHere } from './web/page-nav';

/** A button's label with its keyboard shortcut ("Stop (Esc)"); a phone has no keys, and VoiceOver would read them out. */
export const withShortcut = (label: string, keys: string): string => (uiHere === 'mobile' ? label : `${label} (${keys})`);
