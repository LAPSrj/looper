import type { Task } from './types';

/** The note a guidance window saves (none for an empty text), or why it can't. */
export function guidanceNote(text: string, runsLeft: number): { note: Task['note'] } | { problem: string } {
  const trimmed = text.trim();
  if (!trimmed) return { note: undefined };
  if (!Number.isInteger(runsLeft) || runsLeft < 1) return { problem: 'Applies to next: must be a whole number of runs, at least 1.' };
  return { note: { text: trimmed, runsLeft } };
}
