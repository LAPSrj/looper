/** What a tab strip's tabs say and do, apart from the DOM: the roles, ids, names and keys the ARIA tabs pattern asks for. */

import type { ReactNode } from 'react';

export type TabStatus = 'running' | 'done' | 'failed' | 'waiting';

export const STATUS_WORD: Record<TabStatus, string> = { running: 'running', done: 'done', failed: 'failed', waiting: 'waiting' };

export interface TabItem {
  id: string;
  label: string;
  /** Drawn before the label (an Icon). */
  icon?: ReactNode;
  /** Drawn as a StatusMark before the label, and named after the label ("Explorer, running"). */
  status?: TabStatus;
  /** The full name, when the label is cut short. */
  title?: string;
  /** A close button after the tab; Delete closes it too. */
  onClose?: () => void;
  /** A divider after this tab (the conversation, before its subagents). */
  dividerAfter?: boolean;
}

/** The color most samples have (the first of those tied); null with none. */
export function mostCommon(colors: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const c of colors) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: string | null = null;
  let most = 0;
  for (const [c, n] of counts) {
    if (n > most) {
      best = c;
      most = n;
    }
  }
  return best;
}

/** Whether a computed background-color paints nothing (transparent, or alpha 0). */
export const isClear = (color: string): boolean => color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);

/** A tab's accessible name: the label, then its status word. */
export const tabName = (label: string, status?: TabStatus): string => (status ? `${label}, ${STATUS_WORD[status]}` : label);

/** An id-reference-safe form of a tab id (ids such as "survey:src" or with spaces). */
const token = (id: string): string => id.replace(/\s+/g, '_');

export const tabDomId = (idBase: string, id: string): string => `${idBase}-tab-${token(id)}`;
export const panelDomId = (idBase: string, id: string): string => `${idBase}-panel-${token(id)}`;

/** The tab that holds the strip's one Tab stop: the active one, or the first when none of them is. */
export const tabStop = (ids: readonly string[], active: string): string | undefined => (ids.includes(active) ? active : ids[0]);

export interface TabAria {
  role: 'tab';
  id?: string;
  'aria-selected': boolean;
  'aria-controls'?: string;
  'aria-label'?: string;
  tabIndex: 0 | -1;
}

/** The ARIA attributes of one tab. */
export function tabAria(ids: readonly string[], tab: TabItem, active: string, idBase?: string): TabAria {
  return {
    role: 'tab',
    ...(idBase ? { id: tabDomId(idBase, tab.id), 'aria-controls': panelDomId(idBase, tab.id) } : {}),
    'aria-selected': tab.id === active,
    ...(tab.status ? { 'aria-label': tabName(tab.label, tab.status) } : {}),
    tabIndex: tabStop(ids, active) === tab.id ? 0 : -1,
  };
}

interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/**
 * The tab a key in the strip moves to (and selects, as Windows tab controls
 * do): Left and Right, wrapping, Home and End. Null for any other key.
 */
export function tabKeyTarget(ids: readonly string[], active: string, e: KeyLike): string | null {
  if (ids.length === 0 || e.ctrlKey || e.altKey || e.metaKey) return null;
  const at = Math.max(0, ids.indexOf(active));
  switch (e.key) {
    case 'ArrowRight':
      return ids[(at + 1) % ids.length];
    case 'ArrowLeft':
      return ids[(at - 1 + ids.length) % ids.length];
    case 'Home':
      return ids[0];
    case 'End':
      return ids[ids.length - 1];
    default:
      return null;
  }
}

/** The tab Ctrl+Tab (Ctrl+Shift+Tab: the one before) cycles to, wrapping; null for any other key. */
export function ctrlTabTarget(ids: readonly string[], active: string, e: KeyLike): string | null {
  if (ids.length === 0 || !e.ctrlKey || e.altKey || e.metaKey || e.key !== 'Tab') return null;
  const at = Math.max(0, ids.indexOf(active));
  return ids[(at + (e.shiftKey ? -1 : 1) + ids.length) % ids.length];
}
