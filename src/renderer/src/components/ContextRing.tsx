import { useId } from 'react';
import type { UsageRing } from '@shared/sessions';
import { MINUTE, SECOND, useNow } from '../useNow';
import { FIVE_HOUR_MS, WEEK_MS, cachePassed, contextTone, usageTone, windowPassed } from './usage';

const R = 7;
const C = 2 * Math.PI * R;

/**
 * The context ring in an 18 x 18 box (centered at 9): a track, and an arc over it
 * that fills clockwise with the context (0..1; null draws the track only). The
 * session list's icon draws it; `.session-icon` colors it.
 */
export function ContextRing({ frac }: { frac: number | null }) {
  const tone = frac === null ? '' : contextTone(frac);
  return (
    <>
      <circle cx="9" cy="9" r={R} className="ring" fill="none" strokeWidth="2" />
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
        />
      )}
    </>
  );
}

const ORANGE = 'var(--pg-orange, var(--ios-orange, #ff9500))';
const RED = 'var(--pg-red, var(--ios-red, #ff383c))';
const TRACK = 0.14;

// The Usage glyph's layout in its 18-unit box, drawn at 22 pt (iOS) or 24 dp (Android).
const RING_R = 7.1;
const RING_W = 1.8;
const CACHE_DOT_R = 0.8;
/** The circle inside the ring that the bars and the halves share. */
const INNER_R = 4.9;
/** A bar is 2 pt wide at 22 pt. */
const BAR_W = 36 / 22;
const BAR_X = 0.3 + BAR_W / 2;
/** Each half's straight edge, 0.8 units clear of its bar. */
const EDGE_X = BAR_X + BAR_W / 2 + 0.8;
const CORNER = 0.6;
const TIME_OPACITY = 0.7;

const n = (v: number) => v.toFixed(2);
const at = (f: number): [number, number] => {
  const a = -Math.PI / 2 + f * 2 * Math.PI;
  return [9 + RING_R * Math.cos(a), 9 + RING_R * Math.sin(a)];
};

/**
 * One half's part below `passed` (0..1 of the circle's height), every corner
 * rounded: the part shrunk by CORNER, which the caller outlines CORNER thick with round joins.
 */
function timeHalf(side: 1 | -1, passed: number): string {
  const r = INNER_R - CORNER, x = 9 + side * (EDGE_X + CORNER), d = Math.sqrt(r * r - (x - 9) ** 2);
  const top = Math.min(9 + INNER_R - 2 * INNER_R * passed + CORNER, 9 + d - 0.01);
  const sweep = side > 0 ? 1 : 0;
  if (top <= 9 - d) return `M${n(x)} ${n(9 - d)}A${r} ${r} 0 0 ${sweep} ${n(x)} ${n(9 + d)}Z`;
  return `M${n(x)} ${n(top)}L${n(9 + side * Math.sqrt(r * r - (top - 9) ** 2))} ${n(top)}A${r} ${r} 0 0 ${sweep} ${n(x)} ${n(9 + d)}Z`;
}

/** A limit: its use as a bar beside the middle, and the time passed in its window as the half beside the bar. */
function Limit({ side, used, passed }: { side: 1 | -1; used: number; passed: number }) {
  const x = n(9 + side * BAR_X), h = Math.sqrt(INNER_R ** 2 - BAR_X ** 2);
  const bottom = 9 + h - BAR_W / 2, top = 9 - h + BAR_W / 2;
  const tone = usageTone(used);
  return (
    <>
      {passed > 0 && (
        <path d={timeHalf(side, passed)} fill="currentColor" stroke="currentColor" strokeWidth={2 * CORNER} strokeLinejoin="round" opacity={TIME_OPACITY} />
      )}
      <line x1={x} y1={n(bottom)} x2={x} y2={n(top)} stroke="currentColor" strokeOpacity={TRACK} strokeWidth={BAR_W} strokeLinecap="round" />
      {used > 0 && (
        <line
          x1={x}
          y1={n(bottom)}
          x2={x}
          y2={n(bottom - Math.min(1, used) * (bottom - top))}
          stroke={tone === 'critical' ? RED : tone === 'warning' ? ORANGE : 'currentColor'}
          strokeWidth={BAR_W}
          strokeLinecap="round"
        />
      )}
    </>
  );
}

/**
 * The Usage button's glyph, 18 x 18: the context as the ring, with the prompt
 * cache as a dot going around it until it expires; inside, the 5-hour (left) and
 * weekly (right) limits' use as two bars, and the time passed in each window as
 * the half beside its bar. It ticks on its own, so the window doesn't render with it.
 */
export function UsageGlyph({ ring }: { ring: UsageRing }) {
  const { context, fiveHour, sevenDay, cache } = ring;
  const now = useNow(cache && Date.now() < cache.until ? 10 * SECOND : MINUTE);
  const mask = `usage-${useId().replace(/[^\w-]/g, '')}`;
  const tone = context === null ? '' : contextTone(context);
  const ctx = context === null ? 0 : Math.min(1, context);
  const cached = cache ? cachePassed(cache, now) : null;
  const dot = cached === null ? null : at(cached);
  // On the context's arc the dot is a hole through the ring; on the track it's drawn.
  const hole = dot && cached! <= ctx;
  const color = tone === 'high' ? RED : tone === 'mid' ? ORANGE : 'currentColor';
  const [x0, y0] = at(0), [x1, y1] = at(Math.max(0.02, ctx));
  return (
    <>
      {hole && (
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18">
          <rect width="18" height="18" fill="#fff" />
          <circle cx={n(dot[0])} cy={n(dot[1])} r={CACHE_DOT_R} fill="#000" />
        </mask>
      )}
      <g mask={hole ? `url(#${mask})` : undefined}>
        <circle cx="9" cy="9" r={RING_R} fill="none" stroke="currentColor" strokeOpacity={TRACK} strokeWidth={RING_W} />
        {ctx >= 1 ? (
          <circle cx="9" cy="9" r={RING_R} fill="none" stroke={color} strokeWidth={RING_W} />
        ) : (
          ctx > 0 && (
            <path d={`M${n(x0)} ${n(y0)}A${RING_R} ${RING_R} 0 ${ctx > 0.5 ? 1 : 0} 1 ${n(x1)} ${n(y1)}`} fill="none" stroke={color} strokeWidth={RING_W} strokeLinecap="round" />
          )
        )}
      </g>
      {dot && !hole && <circle cx={n(dot[0])} cy={n(dot[1])} r={CACHE_DOT_R} fill="currentColor" />}
      {fiveHour && <Limit side={-1} used={fiveHour.used} passed={windowPassed(fiveHour, FIVE_HOUR_MS, now)} />}
      {sevenDay && <Limit side={1} used={sevenDay.used} passed={windowPassed(sevenDay, WEEK_MS, now)} />}
    </>
  );
}
