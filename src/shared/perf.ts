/** A gap between frames this long blocks input (RAIL's 50 ms input budget). */
export const FREEZE_MS = 50;

/** One slow moment a window measured, sent to the computer for perf.log. */
export interface PerfEntry {
  /** freeze: the main thread was blocked; frames: an activity dropped frames. */
  kind: 'freeze' | 'frames';
  /** freeze: how long it was blocked; frames: how long the activity lasted. */
  ms: number;
  /** The window's route and title. */
  screen: string;
  /** The input before it, as "tap Send 12 ms before". */
  input?: string;
  /** The display's measured frame interval. */
  frameMs?: number;
  frames?: number;
  dropped?: number;
  worstMs?: number;
  /** What React rendered during it, as "Chat rows 760 ms ×2". */
  renders?: string[];
  /** The desktop's long-animation-frame scripts, as "DIV.onclick 760 ms". */
  scripts?: string[];
  /** Entries left out since the last one sent, to keep the log small. */
  skipped?: number;
}

const MAX_TEXT = 120;
const MAX_ITEMS = 6;

const text = (v: unknown): string | null => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .slice(0, MAX_ITEMS)
        .map(text)
        .filter((s): s is string => !!s)
    : [];

const fmtMs = (ms: number): string => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

/** The log line for an entry from a page, or null when it isn't one. */
export function perfLine(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  const ms = num(e.ms);
  const screen = text(e.screen);
  if ((e.kind !== 'freeze' && e.kind !== 'frames') || ms === null || screen === null) return null;
  const parts: string[] = [];
  if (e.kind === 'freeze') parts.push(`freeze ${fmtMs(ms)}`);
  else {
    const frames = num(e.frames) ?? 0;
    const dropped = num(e.dropped) ?? 0;
    const frameMs = num(e.frameMs);
    const worst = num(e.worstMs);
    const pct = frames > 0 ? Math.round((dropped / frames) * 100) : 0;
    parts.push(
      `frames ${fmtMs(ms)}: ${Math.round(dropped)} of ${Math.round(frames)} dropped (${pct}%)` +
        (frameMs !== null ? ` at ${frameMs.toFixed(1)} ms` : '') +
        (worst !== null ? `, worst ${fmtMs(worst)}` : ''),
    );
  }
  parts.push(`screen ${screen || '(none)'}`);
  const input = text(e.input);
  if (input) parts.push(`input ${input}`);
  const renders = list(e.renders);
  if (renders.length) parts.push(`renders ${renders.join(', ')}`);
  const scripts = list(e.scripts);
  if (scripts.length) parts.push(`scripts ${scripts.join(', ')}`);
  const skipped = num(e.skipped);
  if (skipped) parts.push(`${Math.round(skipped)} more left out`);
  return parts.join(' | ');
}
