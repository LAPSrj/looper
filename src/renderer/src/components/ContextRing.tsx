import type { CSSProperties } from 'react';
import { contextTone, usageTone } from './usage';

const R = 7;
const C = 2 * Math.PI * R;

/** Inline paint for a ring drawn where the stylesheet's `.session-icon` rules don't reach (the frame's bar). */
export interface RingPaint {
  track?: CSSProperties;
  fill?: CSSProperties;
}

/**
 * The context ring in an 18 x 18 box (centered at 9): a track, and an arc over it
 * that fills clockwise with the context (0..1; null draws the track only). The
 * session list's icon and the Usage button draw it; `.session-icon` colors it.
 */
export function ContextRing({ frac, paint }: { frac: number | null; paint?: RingPaint }) {
  const tone = frac === null ? '' : contextTone(frac);
  return (
    <>
      <circle cx="9" cy="9" r={R} className="ring" fill="none" strokeWidth="2" style={paint?.track} />
      {frac !== null && (
        <circle
          cx="9"
          cy="9"
          r={R}
          className={`fill${tone ? ` ${tone}` : ''}`}
          fill="none"
          strokeWidth="2"
          strokeLinecap="butt"
          strokeDasharray={`${frac * C} ${C}`}
          transform="rotate(-90 9 9)"
          style={paint?.fill}
        />
      )}
    </>
  );
}

const DISC_R = 4;
const PIE_R = DISC_R / 2;

/**
 * A disc inside the ring that fills with a limit's use (0..1), as a pie from
 * twelve o'clock: a faint disc, and a wedge over it colored by `usageTone`.
 */
export function UsageDisc({ used, wedge }: { used: number; wedge: string }) {
  const c = 2 * Math.PI * PIE_R;
  return (
    <>
      <circle cx="9" cy="9" r={DISC_R} fill="currentColor" fillOpacity="0.2" stroke="none" />
      <circle
        cx="9"
        cy="9"
        r={PIE_R}
        fill="none"
        stroke={wedge}
        strokeWidth={DISC_R}
        strokeLinecap="butt"
        strokeDasharray={`${Math.min(1, used) * c} ${c}`}
        transform="rotate(-90 9 9)"
      />
    </>
  );
}

const ORANGE = 'var(--pg-orange, var(--ios-orange, #ff9500))';
const RED = 'var(--pg-red, var(--ios-red, #ff383c))';

/** The Usage button's glyph, 18 x 18: the context ring with the 5-hour use as a disc inside. */
export function UsageGlyph({ context, used }: { context: number | null; used: number | null }) {
  const tone = context === null ? '' : contextTone(context);
  const limit = used === null ? 'normal' : usageTone(used);
  return (
    <>
      <ContextRing
        frac={context}
        paint={{
          track: { stroke: 'currentColor', strokeOpacity: 0.3 },
          fill: { stroke: tone === 'high' ? RED : tone === 'mid' ? ORANGE : 'currentColor' },
        }}
      />
      {used !== null && <UsageDisc used={used} wedge={limit === 'critical' ? RED : limit === 'warning' ? ORANGE : 'currentColor'} />}
    </>
  );
}
