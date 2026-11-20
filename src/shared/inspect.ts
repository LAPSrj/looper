/**
 * A value as Node's util.inspect prints it, as Code Mode prints a script's result: objects with bare keys,
 * single-quoted strings, a long string split into 'a' + 'b', Map and Set, and markers such as [Object] or
 * [Function: f], which stay text. Null when the text isn't one value.
 */
export function parseInspected(text: string): { value: unknown } | null {
  const s = text.trim();
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError(`not a value at ${i}`);
  };
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const at = (re: RegExp): string | null => {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const quoted = (): string => {
    const q = s[i++];
    let out = '';
    while (i < s.length && s[i] !== q) {
      if (s[i] !== '\\') {
        out += s[i++];
        continue;
      }
      const e = s[i + 1];
      i += 2;
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === 'r') out += '\r';
      else if (e === 'b') out += '\b';
      else if (e === 'f') out += '\f';
      else if (e === 'v') out += '\v';
      else if (e === '0') out += '\0';
      else if (e === 'x' || e === 'u') {
        const hex = e === 'x' ? s.slice(i, i + 2) : s[i] === '{' ? s.slice(i + 1, s.indexOf('}', i)) : s.slice(i, i + 4);
        if (!/^[\da-f]+$/i.test(hex)) fail();
        out += String.fromCodePoint(parseInt(hex, 16));
        i += e === 'u' && s[i] === '{' ? hex.length + 2 : hex.length;
      } else out += e;
    }
    if (s[i] !== q) fail();
    i++;
    return out;
  };
  // A long string comes as 'first part' +\n 'next part'.
  const string = (): string => {
    let out = quoted();
    for (;;) {
      const back = i;
      ws();
      if (s[i] !== '+') {
        i = back;
        return out;
      }
      i++;
      ws();
      if (!`'"\``.includes(s[i])) fail();
      out += quoted();
    }
  };
  const key = (): string => {
    if (`'"\``.includes(s[i])) return quoted();
    if (s[i] === '[') return at(/\[[^\]\n]*\]/y) ?? fail();
    return at(/[\w$]+/y) ?? fail();
  };
  /** The entries between braces: `key: value`, `key => value` (a Map's), or bare values (a Set's). */
  const braces = (kind: 'object' | 'map' | 'set'): unknown => {
    i++;
    const obj: Record<string, unknown> = {};
    const list: unknown[] = [];
    for (;;) {
      ws();
      if (s[i] === '}') {
        i++;
        return kind === 'set' ? list : obj;
      }
      if (s.startsWith('...', i)) list.push(at(/\.\.\. \d+ more (?:items?|properties|entries)/y) ?? fail());
      else if (kind === 'set') list.push(value());
      else if (kind === 'map') {
        const k = value();
        ws();
        if (!s.startsWith('=>', i)) fail();
        i += 2;
        obj[typeof k === 'string' ? k : JSON.stringify(k)] = value();
      } else {
        const k = key();
        ws();
        if (s[i] !== ':') fail();
        i++;
        obj[k] = value();
      }
      ws();
      if (s[i] === ',') i++;
      else if (s[i] !== '}') fail();
    }
  };
  const array = (): unknown[] => {
    i++;
    const list: unknown[] = [];
    for (;;) {
      ws();
      if (s[i] === ']') {
        i++;
        return list;
      }
      list.push(s.startsWith('...', i) ? (at(/\.\.\. \d+ more items?/y) ?? fail()) : s.startsWith('<', i) ? (at(/<\d+ empty items?>/y) ?? fail()) : value());
      ws();
      if (s[i] === ',') i++;
      else if (s[i] !== ']') fail();
    }
  };
  const value = (): unknown => {
    ws();
    if (at(/<ref \*\d+> /y)) ws();
    const c = s[i];
    if (c === '{') return braces('object');
    if (c === '[') return at(/\[(?:Object|Array|Function|AsyncFunction|GeneratorFunction|class|Circular|Getter|Setter|Symbol)\b[^\]\n]*\]/y) ?? array();
    if (c === "'" || c === '"' || c === '`') return string();
    const date = at(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/y);
    if (date) return date;
    const num = at(/-?(?:Infinity|NaN|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?)(?![\w$])/y);
    if (num) return num.endsWith('n') ? num : Number(num.replace(/_/g, ''));
    const word = at(/[A-Za-z_$][\w$]*/y) ?? fail();
    if (word === 'true' || word === 'false') return word === 'true';
    if (word === 'null') return null;
    if (word === 'undefined') return undefined;
    // A class's instance: Map(2) { 'a' => 1 }, Set(1) { 1 }, Foo { a: 1 }, Uint8Array(3) [ 1, 2, 3 ].
    at(/\(\d+\)/y);
    ws();
    if (s[i] === '{') return braces(word === 'Map' ? 'map' : word === 'Set' ? 'set' : 'object');
    if (s[i] === '[') return array();
    return fail();
  };
  try {
    const v = value();
    ws();
    return i === s.length ? { value: v } : null;
  } catch {
    return null;
  }
}
