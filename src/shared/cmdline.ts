/**
 * Single-line, shell-style editing of argument lists and env vars: tokens are
 * whitespace-separated, single quotes are literal, double quotes allow \" and
 * \\ escapes. This is only a UI convenience — stored values stay arrays/maps
 * and are quoted properly for the real target shell at launch time.
 */

export type Tokenized = { ok: true; tokens: string[] } | { ok: false; error: string };

export function tokenize(line: string): Tokenized {
  const tokens: string[] = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    let tok = '';
    while (i < n && !/\s/.test(line[i])) {
      const c = line[i];
      if (c === "'") {
        const end = line.indexOf("'", i + 1);
        if (end < 0) return { ok: false, error: 'unterminated single quote' };
        tok += line.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        i++;
        while (i < n && line[i] !== '"') {
          if (line[i] === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
            tok += line[i + 1];
            i += 2;
          } else {
            tok += line[i];
            i++;
          }
        }
        if (i >= n) return { ok: false, error: 'unterminated double quote' };
        i++;
      } else {
        tok += c;
        i++;
      }
    }
    tokens.push(tok);
  }
  return { ok: true, tokens };
}

export function joinTokens(tokens: string[]): string {
  return tokens
    .map((t) => (t === '' || /[\s"']/.test(t) ? '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : t))
    .join(' ');
}

/** `{FOO: "a b"} -> FOO="a b"` */
export function envToLine(env: Record<string, string>): string {
  return joinTokens(Object.entries(env).map(([k, v]) => `${k}=${v}`));
}

/** `FOO="a b" BAR=1 -> {FOO: "a b", BAR: "1"}`. Returns an error message for a malformed line. */
export function lineToEnv(line: string): Record<string, string> | string {
  const parsed = tokenize(line);
  if (!parsed.ok) return parsed.error;
  const env: Record<string, string> = {};
  for (const tok of parsed.tokens) {
    const eq = tok.indexOf('=');
    if (eq <= 0) return `"${tok}" is not KEY=value`;
    env[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return env;
}
