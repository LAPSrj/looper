const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse "5m", "1h30m", "90s", "2d", "1.5h". A bare number is seconds.
 * Throws on anything else.
 */
export function parseDuration(input: string): number {
  const s = String(input).trim().toLowerCase();
  if (!s) throw new Error('empty duration');
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    total += parseFloat(m[1]) * UNIT_MS[m[2]];
    consumed += m[0].length;
  }
  if (consumed !== s.replace(/\s+/g, '').length && consumed !== s.length) {
    throw new Error(`invalid duration: "${input}"`);
  }
  if (total <= 0) throw new Error(`invalid duration: "${input}"`);
  return Math.round(total);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d${rh}h` : `${d}d`;
}
