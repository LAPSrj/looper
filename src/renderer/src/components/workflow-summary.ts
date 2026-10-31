// No DOM and no React: the unit tests (node tsconfig) load this file.

/** A workflow result that is a JSON object: its keys and values. */
function parseObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(t);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The field that says what the result is: "summary", then "paragraph", then the longest string. */
function mainField(obj: Record<string, unknown>): [string, string] | null {
  for (const key of ['summary', 'paragraph']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return [key, v];
  }
  let best: [string, string] | null = null;
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim() && (!best || v.length > best[1].length)) best = [key, v];
  }
  return best;
}

/** Its first line; a result that is indented JSON (its first line a lone "{" or "["), all of it on one line. */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line === '{' || line === '[' ? text.replace(/\s+/g, ' ').trim() : line;
}

/**
 * A result in one short line: for JSON, its summary, paragraph or longest
 * string field; for any other text, its first line.
 */
export function resultSummary(text: string): string {
  const obj = parseObject(text);
  const main = obj && mainField(obj);
  return main ? main[1].replace(/\s+/g, ' ').trim() : firstLine(text);
}

export type ResultParts =
  | { kind: 'text'; text: string }
  | {
      kind: 'object';
      /** The field to read as text (Markdown), and its name; absent when no field is a string. */
      main?: { key: string; text: string };
      /** Every other field. */
      rest: [string, unknown][];
    };

/** A result split for the Result section: the main text, the other fields, or plain text when it isn't a JSON object. */
export function resultParts(text: string): ResultParts {
  const obj = parseObject(text);
  if (!obj) return { kind: 'text', text };
  const main = mainField(obj);
  return {
    kind: 'object',
    ...(main ? { main: { key: main[0], text: main[1] } } : {}),
    rest: Object.entries(obj).filter(([k]) => k !== main?.[0]),
  };
}
