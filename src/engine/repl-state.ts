import vm from 'node:vm';

/**
 * Code Mode's REPL state, carried from one Claude Code session to the next
 * when a chat is compacted. The old session's mod runs replSnapshotScript in
 * its REPL: it walks what each name holds as a graph (shared references and
 * cycles stay shared, instances keep their class, Map, Set, Date, RegExp,
 * BigInt, typed arrays and the numbers JSON can't hold keep their kind),
 * writes it to the data file, and writes an index of the names, the functions'
 * source and what couldn't move. The new session's mod sends replPrelude, with
 * the data file put in at REPL_DATA_MARKER, as its first REPL call. A REPL
 * can't run code from a string (eval and new Function are refused), so the
 * functions go over as code of the prelude's own. Looper reads only the index;
 * the walk and the data stay in Claude Code's process.
 */

/** The run-dir files: the snapshot script the engine writes, the index and data it writes, and the new session's prelude. */
export const REPL_FILES = { script: 'repl-snapshot.js', snapshot: 'repl-snapshot.json', data: 'repl-data.json', prelude: 'repl-prelude.js' } as const;

/** The data's files, in order: the snapshot writes it in parts, since the mod reads at most 4 MiB a file. */
export const replDataFiles = (parts: number): string[] => Array.from({ length: Math.max(1, parts) }, (_, i) => (i ? `${REPL_FILES.data}.${i}` : REPL_FILES.data));

/** Past this much state, by the snapshot's count, the names still to come stay behind. */
export const REPL_STATE_MAX_BYTES = 64 * 1024 * 1024;
/** Where the prelude takes the snapshot's data: the mod puts the data files' text, joined, in its place. */
export const REPL_DATA_MARKER = '/*LOOPER_DATA*/null';
/** Names a message lists, at most. */
const LISTED_NAMES = 40;
/** Script code scanned between two turns of the event loop: each step stays under a millisecond. */
const SLICE_CHARS = 32_000;
/** Function source checked, or scripts searched for statements, between two turns: each costs more per character than the name scan. */
const CHECK_SLICE_CHARS = 16_000;

/** A function the snapshot found: its source, whether it reads as an expression (0) or a method (1), where, and the outer names it reads. */
export interface ReplFunction {
  source: string;
  form: 0 | 1;
  path: string;
  free: string[];
}

export interface ReplSkipped {
  name: string;
  reason: string;
}

/** The snapshot's index: the names that came over, the functions' source, and what didn't come over as it was; or why it didn't run. */
export type ReplSnapshot =
  | { version: 2; id: number; roots: string[]; functions: ReplFunction[]; lost: ReplSkipped[]; changed: ReplSkipped[]; bytes: number; parts: number }
  | { version: 2; id: number; error: string };

/** Words a script can't read as a name: one would keep the whole script from parsing. */
const RESERVED = new Set(
  (
    'await break case catch class const continue debugger default delete do else enum export extends false finally for function if ' +
    'implements import in instanceof interface let new null package private protected public return static super switch this throw true ' +
    'try typeof var void while with yield arguments eval undefined NaN Infinity'
  ).split(' '),
);

const DECLARED = /\b(?:const|let|var|class|function\*?)\s+([A-Za-z_$][\w$]*)|\bglobalThis\.([A-Za-z_$][\w$]*)\s*=(?!=)/g;
/** A destructuring declaration's pattern, whose identifiers are names too. */
const PATTERN = /\b(?:const|let|var)\s*([[{][^=;]*?[\]}])\s*=/g;
const IDENT = /[A-Za-z_$][\w$]*/g;
const NAME = /^[A-Za-z_$][\w$]*$/;

const usable = (name: string) => NAME.test(name) && !RESERVED.has(name) && !name.startsWith('__looper');
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The names a REPL's scripts may have left defined, in the order each was last
 * defined. Inner names come too, and the snapshot skips whatever isn't defined
 * at the top.
 */
export async function replNames(scripts: readonly string[]): Promise<string[]> {
  const order = new Set<string>();
  const add = (name: string) => {
    if (!usable(name)) return;
    order.delete(name);
    order.add(name);
  };
  let scanned = 0;
  for (const code of scripts) {
    for (const m of code.matchAll(DECLARED)) add(m[1] ?? m[2]);
    for (const m of code.matchAll(PATTERN)) for (const id of m[1].matchAll(IDENT)) add(id[0]);
    scanned += code.length;
    if (scanned >= SLICE_CHARS) {
      scanned = 0;
      await nextTurn();
    }
  }
  return [...order];
}

/** Statement text shown, at most. */
const STATEMENT_MAX_CHARS = 400;

/** The statement that starts at `start`: to a semicolon or line end outside brackets, strings and comments. */
function statementAt(code: string, start: number): string {
  let depth = 0;
  let i = start;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '\x60') {
      const q = c;
      i++;
      while (i < code.length && code[i] !== q) i += code[i] === '\\' ? 2 : 1;
    } else if (c === '/' && code[i + 1] === '/') {
      break;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ';' || c === '\n')) {
      if (c === ';') i++;
      break;
    }
    i++;
  }
  const text = code.slice(start, i).replace(/\s+/g, ' ').trim();
  return text.length > STATEMENT_MAX_CHARS ? text.slice(0, STATEMENT_MAX_CHARS).trimEnd() + ' …' : text;
}

/** For each of `names`, the statement in the scripts that last defined it, so the agent can run it again. */
export async function replDefinitions(scripts: readonly string[], names: Iterable<string>): Promise<Map<string, string>> {
  const wanted = new Set(names);
  const found = new Map<string, string>();
  if (!wanted.size) return found;
  let scanned = 0;
  for (const code of scripts) {
    for (const m of code.matchAll(DECLARED)) {
      const name = m[1] ?? m[2];
      if (wanted.has(name)) found.set(name, statementAt(code, m.index));
    }
    for (const m of code.matchAll(PATTERN)) for (const id of m[1].matchAll(IDENT)) if (wanted.has(id[0])) found.set(id[0], statementAt(code, m.index));
    scanned += code.length;
    if (scanned >= CHECK_SLICE_CHARS) {
      scanned = 0;
      await nextTurn();
    }
  }
  return found;
}

/** The walk the old session's REPL runs (see the top of the file). */
const SNAPSHOT_RUNTIME = String.raw`async (reads, names, outFile, dataFile, id, limit) => {
  const nameSet = new Set(names);
  // The names defined at the top: a name the scan found inside a function isn't one, and a function that reads it closes over it.
  const defined = new Set();
  // The classes the scripts defined at the top: an instance of any other class is one of the REPL's own, or a class Looper can't make again.
  const ownClasses = new Set();
  for (const [name, read] of reads) { try { const v = read(); defined.add(name); if (typeof v === 'function') ownClasses.add(v); } catch {} }
  // The REPL's own built-in prototypes: Code Mode wraps their methods, so a native check can't tell them apart.
  const DEFAULT_PROTOS = new Set();
  for (const C of ['Object', 'Function', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'Promise', 'ArrayBuffer', 'DataView', 'Number', 'String', 'Boolean', 'BigInt', 'Symbol', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']) {
    try { const c = globalThis[C]; if (typeof c === 'function' && c.prototype) DEFAULT_PROTOS.add(c.prototype); } catch {}
  }
  const nodes = [];
  const ids = new Map();
  const queue = [];
  let qi = 0;
  const fns = [];
  const lost = [];
  const changed = [];
  const promises = [];
  let bytes = 0;
  const NATIVE = /\{\s*\[native code\]\s*\}\s*$/;
  const EXPR = /^(?:async\s+)?(?:function\b|class\b|\(|[A-Za-z_$][\w$]*\s*=>)/;
  const WELL_KNOWN = ['iterator', 'asyncIterator', 'hasInstance', 'isConcatSpreadable', 'match', 'matchAll', 'replace', 'search', 'species', 'split', 'toPrimitive', 'toStringTag', 'unscopables'];
  const ENV = new Set(['$', 'edit', 'write', 'file', 'sleep', 'preview', 'log', 'self', 'running', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'atob', 'btoa', 'searchTools', 'describeTool', 'tools', 'globalThis']);
  const KW = new Set('break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static enum await implements package protected interface private public arguments async of get set undefined NaN Infinity eval target meta'.split(' '));
  const tagOf = (v) => Object.prototype.toString.call(v);
  const isObj = (v) => (typeof v === 'object' && v !== null) || typeof v === 'function';
  const sourceOf = (f) => { try { return Function.prototype.toString.call(f); } catch { return ''; } };
  const native = (f) => NATIVE.test(sourceOf(f));
  const sub = (path, key) => (typeof key === 'symbol' ? path + '[' + String(key.description) + ']' : /^[A-Za-z_$][\w$]*$/.test(key) ? path + '.' + key : path + '[' + JSON.stringify(key) + ']');
  const lose = (path, why) => { (/[.[]/.test(path) ? changed : lost).push({ name: path, reason: why }); return { t: 'x' }; };
  let globals = null;
  const globalPath = (f) => {
    if (!globals) {
      globals = new Map();
      const see = (v, p) => { if (isObj(v) && !globals.has(v)) globals.set(v, p); };
      let keys = [];
      try { keys = Object.getOwnPropertyNames(globalThis).filter((k) => !nameSet.has(k)); } catch {}
      const top = [];
      for (const k of keys) { let d; try { d = Object.getOwnPropertyDescriptor(globalThis, k); } catch { continue; } if (d && 'value' in d) { see(d.value, [k]); top.push([k, d.value]); } }
      for (const [k, v] of top) {
        if (!isObj(v) || v === globalThis) continue;
        let inner = [];
        try { inner = Object.getOwnPropertyNames(v); } catch { continue; }
        for (const k2 of inner) { let d; try { d = Object.getOwnPropertyDescriptor(v, k2); } catch { continue; } if (d && 'value' in d) see(d.value, [k, k2]); }
      }
    }
    return globals.get(f);
  };
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const toB64 = (u) => {
    if (typeof btoa === 'function') { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); }
    const parts = [];
    let i = 0;
    for (; i + 2 < u.length; i += 3) { const n = (u[i] << 16) | (u[i + 1] << 8) | u[i + 2]; parts.push(B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]); }
    const r = u.length - i;
    if (r === 1) { const n = u[i] << 16; parts.push(B64[n >> 18] + B64[(n >> 12) & 63] + '=='); }
    else if (r === 2) { const n = (u[i] << 16) | (u[i + 1] << 8); parts.push(B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '='); }
    return parts.join('');
  };
  // The source without strings, comments and regular expressions, keeping template literals' expressions.
  const skeleton = (src) => {
    let out = '';
    let prev = '';
    let depth = 0;
    const tpl = [];
    const n = src.length;
    let i = 0;
    const inTemplate = (j) => {
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\x60') { out += ' 0 '; prev = '0'; return j + 1; }
        if (d === '$' && src[j + 1] === '{') { tpl.push(depth); out += ' ( '; prev = '('; return j + 2; }
        j++;
      }
      return j;
    };
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
      if (c === "'" || c === '"') { i++; while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } i++; out += ' 0 '; prev = '0'; continue; }
      if (c === '\x60') { i = inTemplate(i + 1); continue; }
      if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /\b(?:return|typeof|case|in|of|void|delete|new|throw|yield|await)\s*$/.test(out))) {
        i++;
        let cls = false;
        while (i < n) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '\n') break; if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; i++; }
        i++;
        while (i < n && /[a-z]/.test(src[i])) i++;
        out += ' 0 ';
        prev = '0';
        continue;
      }
      if (c === '{') depth++;
      if (c === '}') {
        if (tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); out += ' ) '; i = inTemplate(i + 1); continue; }
        depth--;
      }
      out += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
    return out;
  };
  // The names a function's source reads that it doesn't declare and that aren't globals or the earlier session's names.
  const freeNames = (src) => {
    let s;
    try { s = skeleton(src); } catch { return []; }
    const declared = new Set();
    const ID = /[A-Za-z_$][\w$]*/g;
    for (const m of s.matchAll(/\b(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of s.matchAll(/\b(?:const|let|var)\s*[[{]([^=;]*)[\]}]\s*=/g)) for (const x of m[1].matchAll(ID)) declared.add(x[0]);
    for (const m of s.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) for (const x of m[1].matchAll(ID)) declared.add(x[0]);
    for (const m of s.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
    for (const m of s.matchAll(/\bcatch\s*\(([^)]*)\)/g)) for (const x of m[1].matchAll(ID)) declared.add(x[0]);
    for (const m of s.matchAll(/(?:^|[{,;}\n])\s*(?:static\s+|async\s+|get\s+|set\s+|\*\s*)*#?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) declared.add(m[1]);
    if (/^\s*class\b/.test(s)) for (const m of s.matchAll(/(?:^|[;{}\n])\s*(?:static\s+)?#?([A-Za-z_$][\w$]*)\s*(?:=(?![=>])|;)/g)) declared.add(m[1]);
    const free = new Set();
    for (const m of s.matchAll(/(^|[^\w$#])([A-Za-z_$][\w$]*)/g)) {
      const name = m[2];
      const at = m.index + m[1].length;
      if (KW.has(name) || declared.has(name) || free.has(name)) continue;
      if (s[at - 1] === '.' && s[at - 2] !== '.') continue;
      if (/^\s*:(?!:)/.test(s.slice(at + name.length, at + name.length + 3))) continue;
      if (defined.has(name)) continue;
      let global = false;
      try { global = name in globalThis; } catch {}
      if (!global) free.add(name);
    }
    return [...free];
  };
  const enc = (v, path) => {
    switch (typeof v) {
      case 'string': bytes += v.length + 2; return v;
      case 'boolean': return v;
      case 'number': return Object.is(v, -0) ? { $: '-0' } : v !== v ? { $: 'NaN' } : v === Infinity ? { $: 'Inf' } : v === -Infinity ? { $: '-Inf' } : v;
      case 'undefined': return { $: 'u' };
      case 'bigint': return { $: 'n', v: String(v) };
      case 'symbol': {
        const k = Symbol.keyFor(v);
        if (k !== undefined) return { $: 's', k };
        for (const w of WELL_KNOWN) if (Symbol[w] === v) return { $: 'ws', k: w };
        lose(path, 'a symbol only the earlier session had');
        return { $: 'x' };
      }
    }
    if (v === null) return null;
    let i = ids.get(v);
    if (i === undefined) { i = nodes.length; nodes.push(null); ids.set(v, i); queue.push([v, i, path]); }
    return { '#': i };
  };
  const props = (o, path, skip, enumerableOnly) => {
    const list = [];
    let keys;
    try { keys = Reflect.ownKeys(o); } catch { return list; }
    for (const key of keys) {
      if (skip && skip(key)) continue;
      let d;
      try { d = Object.getOwnPropertyDescriptor(o, key); } catch { continue; }
      if (!d || (enumerableOnly && !d.enumerable)) continue;
      const p = sub(path, key);
      let k = key;
      if (typeof key === 'symbol') { k = enc(key, p); if (k && k.$ === 'x') continue; }
      const flags = (d.enumerable ? '' : 'e') + (d.configurable ? '' : 'c') + ('value' in d && !d.writable ? 'w' : '');
      if ('value' in d) list.push([k, enc(d.value, p), flags]);
      else if (d.get && (!(d.get instanceof Function) || native(d.get)) && !globalPath(d.get)) {
        // A built-in accessor (an error's stack) can't go over as code: its value does.
        let v;
        try { v = d.get.call(o); } catch { continue; }
        list.push([k, enc(v, p), flags]);
      } else list.push([k, { g: d.get ? enc(d.get, p) : null, s: d.set ? enc(d.set, p) : null }, flags, 1]);
    }
    return list;
  };
  // An object's prototype: none to set for its kind's own, its class when the scripts defined it, or another object;
  // { lost } for an instance of a class Looper can't make again.
  const protoOf = (o, path, builtin) => {
    let p;
    try { p = Object.getPrototypeOf(o); } catch { return undefined; }
    if (p === null) return { n: 1 };
    if (DEFAULT_PROTOS.has(p)) return undefined;
    let pp = null;
    try { pp = Object.getPrototypeOf(p); } catch {}
    // Another realm's Object.prototype, as a tool result's object has.
    if (pp === null && !builtin) return undefined;
    let c;
    try { c = p.constructor; } catch {}
    let ctorProto = false;
    try { ctorProto = typeof c === 'function' && c.prototype === p; } catch {}
    if (ctorProto && ownClasses.has(c)) return { c: enc(c, path + '.constructor') };
    if (builtin) return undefined;
    if (ctorProto) return { lost: String((c && c.name) || 'it had') };
    return { o: enc(p, path + '.__proto__') };
  };
  // An instance of a class Looper can't make again: the values its class's getters give, which its methods would have read.
  const classValues = (o, path) => {
    const list = [];
    const seen = new Set();
    try { for (const k of Reflect.ownKeys(o)) seen.add(k); } catch {}
    let q;
    try { q = Object.getPrototypeOf(o); } catch {}
    while (q && !DEFAULT_PROTOS.has(q)) {
      let next = null;
      try { next = Object.getPrototypeOf(q); } catch {}
      if (next === null) break;
      let keys = [];
      try { keys = Object.getOwnPropertyNames(q); } catch {}
      for (const k of keys) {
        if (k === 'constructor' || seen.has(k)) continue;
        let d;
        try { d = Object.getOwnPropertyDescriptor(q, k); } catch { continue; }
        if (!d || !d.get) continue;
        seen.add(k);
        let v;
        try { v = d.get.call(o); } catch { continue; }
        if (typeof v !== 'function') list.push([k, enc(v, sub(path, k)), '']);
      }
      q = next;
    }
    return list;
  };
  const indexKey = (k) => typeof k === 'string' && /^\d+$/.test(k);
  const build = (o, id, path) => {
    if (typeof o === 'function') {
      // A built-in or one of the REPL's own goes by where it is among the globals; the scripts' own go over as their source.
      const g = globalPath(o);
      if (g) return { t: 'g', w: g };
      const source = sourceOf(o);
      if (!(o instanceof Function)) return lose(path, "one of the REPL's own functions");
      if (NATIVE.test(source)) return lose(path, String(o.name || '').startsWith('bound ') ? 'a bound function' : 'a built-in function');
      const f = fns.length;
      fns.push({ source, form: EXPR.test(source) ? 0 : 1, path, free: freeNames(source) });
      bytes += source.length;
      const n = { t: 'f', f };
      const pr = props(o, path, (k) => k === 'length' || k === 'name' || k === 'prototype' || k === 'arguments' || k === 'caller', true);
      if (pr.length) n.pr = pr;
      let proto;
      try { proto = o.prototype; } catch {}
      if (isObj(proto)) { const pp = props(proto, path + '.prototype', (k) => k === 'constructor', true); if (pp.length) n.pp = pp; }
      return n;
    }
    const tag = tagOf(o);
    let n;
    let skip;
    if (Array.isArray(o)) {
      n = { t: 'a', l: o.length };
      if (o.length <= 100000) { n.items = []; for (let i = 0; i < o.length; i++) n.items.push(Object.prototype.hasOwnProperty.call(o, i) ? enc(o[i], path + '[' + i + ']') : { $: 'h' }); }
      else { n.sp = []; for (const k of Object.keys(o)) if (indexKey(k)) n.sp.push([Number(k), enc(o[k], path + '[' + k + ']')]); }
      skip = (k) => k === 'length' || indexKey(k);
    } else {
      switch (tag) {
        case '[object Map]': {
          n = { t: 'm', e: [] };
          Map.prototype.forEach.call(o, (v, k) => n.e.push([enc(k, path + '.keys()'), enc(v, path + '.get(' + (typeof k === 'string' || typeof k === 'number' ? JSON.stringify(k) : '...') + ')')]));
          break;
        }
        case '[object Set]': n = { t: 's', e: [] }; Set.prototype.forEach.call(o, (v) => n.e.push(enc(v, path + '.values()'))); break;
        case '[object Date]': n = { t: 'd', v: enc(Date.prototype.getTime.call(o), path) }; break;
        case '[object RegExp]': n = { t: 'r', s: String(o.source), f: String(o.flags), li: Number(o.lastIndex) || 0 }; skip = (k) => k === 'lastIndex'; break;
        case '[object ArrayBuffer]': { const b = toB64(new Uint8Array(o)); bytes += b.length; n = { t: 'ab', b }; break; }
        case '[object DataView]': n = { t: 'dv', b: enc(o.buffer, path + '.buffer'), o: o.byteOffset, l: o.byteLength }; break;
        case '[object Promise]': promises.push([o, id, path]); return { t: 'x' };
        case '[object WeakMap]': case '[object WeakSet]': case '[object WeakRef]': case '[object FinalizationRegistry]':
          return lose(path, 'a ' + tag.slice(8, -1) + ", whose contents can't be read");
        case '[object Generator]': case '[object AsyncGenerator]': return lose(path, 'a generator part-way through');
        case '[object SharedArrayBuffer]': return lose(path, 'a SharedArrayBuffer');
        case '[object Error]': n = { t: 'err', n: String(o.name) }; break;
        default:
          if (typeof o === 'object' && (tag === '[object Number]' || tag === '[object String]' || tag === '[object Boolean]' || tag === '[object BigInt]' || tag === '[object Symbol]')) {
            n = { t: 'box', v: enc(o.valueOf(), path) };
            skip = (k) => k === 'length' || indexKey(k);
            break;
          }
          if (ArrayBuffer.isView(o)) { n = { t: 'ta', k: tag.slice(8, -1), b: enc(o.buffer, path + '.buffer'), o: o.byteOffset, l: o.length }; skip = indexKey; break; }
          if (tag.endsWith(' Iterator]')) return lose(path, 'an iterator part-way through');
          n = { t: 'o' };
      }
    }
    let pr = props(o, path, skip);
    const p = protoOf(o, path, n.t !== 'o');
    if (p && p.lost !== undefined) {
      pr = pr.concat(classValues(o, path));
      changed.push({ name: path, reason: 'came back as a plain object holding its values, without the methods of its class ' + p.lost });
    } else if (p) n.p = p;
    if (pr.length) n.pr = pr;
    try { if (Object.isFrozen(o)) n.i = 'f'; else if (Object.isSealed(o)) n.i = 's'; else if (!Object.isExtensible(o)) n.i = 'p'; } catch {}
    return n;
  };
  const drain = () => {
    while (qi < queue.length) {
      const [o, i, path] = queue[qi++];
      let n;
      try { n = build(o, i, path); } catch (e) { n = lose(path, "couldn't be read (" + String((e && e.message) || e) + ')'); }
      if (nodes[i] === null) nodes[i] = n;
    }
  };
  const settle = async () => {
    while (promises.length) {
      const [p, i, path] = promises.shift();
      const waiting = {};
      let r = waiting;
      try { r = await Promise.race([Promise.resolve(p).then((v) => ({ v }), (e) => ({ e })), new Promise((res) => setTimeout(() => res(waiting), 0))]); } catch {}
      if (r === waiting) nodes[i] = lose(path, "a promise that hadn't settled");
      else nodes[i] = 'v' in r ? { t: 'pr', v: enc(r.v, path) } : { t: 'pr', e: enc(r.e, path) };
      drain();
    }
  };
  const roots = [];
  for (const [name, read] of reads) {
    let v;
    try { v = read(); } catch { continue; }
    let env = false;
    try {
      if (name in globalThis && globalThis[name] === v) { const d = Object.getOwnPropertyDescriptor(globalThis, name); env = ENV.has(name) || !d || !d.enumerable; }
    } catch {}
    if (env) continue;
    if (bytes > limit) { lost.push({ name, reason: 'past the ' + Math.round(limit / 1048576) + ' MB the REPL state can take' }); continue; }
    roots.push([name, enc(v, name)]);
    drain();
  }
  drain();
  await settle();
  const kept = roots.filter(([, e]) => !(e && e.$ === 'x') && !(e && typeof e === 'object' && '#' in e && nodes[e['#']] && nodes[e['#']].t === 'x')).map(([n]) => n);
  const data = JSON.stringify({ roots, nodes });
  // In parts the mod can read (it reads at most 4 MiB a file): a part of 1 Mi UTF-16 units is at most 3 MiB of UTF-8, and no
  // part ends inside a surrogate pair.
  const PART = 1048576;
  let parts = 0;
  for (let at = 0; parts === 0 || at < data.length; parts++) {
    let end = Math.min(data.length, at + PART);
    const c = data.charCodeAt(end - 1);
    if (end < data.length && c >= 0xd800 && c <= 0xdbff) end--;
    await write(dataFile + (parts ? '.' + parts : ''), data.slice(at, end));
    at = end;
  }
  await write(outFile, JSON.stringify({ version: 2, id, roots: kept, functions: fns, lost, changed, bytes: data.length, parts }));
}`;

/**
 * The script the old session's REPL runs: it reads each name and writes the
 * data to `dataOut` and the index to `out`, the index last, so a reader that has
 * the index has the data whole.
 */
export function replSnapshotScript(names: readonly string[], out: string, dataOut: string, id: number, limit = REPL_STATE_MAX_BYTES): string {
  const kept = names.filter(usable);
  const reads = kept.map((name) => `[${JSON.stringify(name)}, () => ${name}]`).join(',\n');
  return [
    `await (${SNAPSHOT_RUNTIME})([${reads}], ${JSON.stringify(kept)}, ${JSON.stringify(out)}, ${JSON.stringify(dataOut)}, ${id}, ${limit});`,
    "'Looper saved the REPL state.'",
  ].join('\n');
}

/** What puts the data back: the functions first, then every value, then each name as a global. */
const RESTORE_RUNTIME = String.raw`(makers, data) => {
  const restored = [];
  const failed = [];
  let parts = 0;
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.roots)) return { restored, failed, parts };
  const { roots, nodes } = data;
  const fnVal = [];
  const fnOk = [];
  const fnRoots = new Map();
  const ref = (e) => (e !== null && typeof e === 'object' && '#' in e ? e['#'] : -1);
  for (const [name, e] of roots) {
    const i = ref(e);
    if (i >= 0 && nodes[i] && nodes[i].t === 'f') { const list = fnRoots.get(nodes[i].f) || []; list.push(name); fnRoots.set(nodes[i].f, list); }
  }
  // Functions first, again while any more come back: a class that extends another needs that one defined.
  for (let again = true; again; ) {
    again = false;
    for (let f = 0; f < makers.length; f++) {
      if (fnOk[f] || typeof makers[f] !== 'function') continue;
      try {
        fnVal[f] = makers[f]();
        fnOk[f] = true;
        again = true;
        for (const name of fnRoots.get(f) || []) globalThis[name] = fnVal[f];
      } catch {}
    }
  }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const fromB64 = (s) => {
    if (typeof atob === 'function') { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
    const T = new Uint8Array(128);
    for (let i = 0; i < 64; i++) T[B64.charCodeAt(i)] = i;
    const len = s.length - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
    const u = new Uint8Array(Math.floor((len * 3) / 4));
    let j = 0;
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < len; i++) {
      acc = ((acc << 6) | T[s.charCodeAt(i)]) & 0xffffff;
      bits += 6;
      if (bits >= 8) { bits -= 8; u[j++] = (acc >> bits) & 255; }
    }
    return u;
  };
  const made = [];
  const done = [];
  const dec = (e) => {
    if (e === null || typeof e !== 'object') return e;
    if ('#' in e) return get(e['#']);
    switch (e.$) {
      case 'u': return undefined;
      case '-0': return -0;
      case 'NaN': return NaN;
      case 'Inf': return Infinity;
      case '-Inf': return -Infinity;
      case 'n': return BigInt(e.v);
      case 's': return Symbol.for(e.k);
      case 'ws': return Symbol[e.k];
    }
    return undefined;
  };
  const protoFrom = (p) => (p.n ? null : p.c ? dec(p.c).prototype : dec(p.o));
  const shell = (n) => {
    switch (n.t) {
      case 'f': return fnVal[n.f];
      case 'g': { let v = globalThis; for (const k of n.w) v = v == null ? v : v[k]; return v; }
      case 'o': return n.p ? Object.create(protoFrom(n.p)) : {};
      case 'a': return new Array(n.l);
      case 'm': return new Map();
      case 's': return new Set();
      case 'd': return new Date(dec(n.v));
      case 'r': { const r = new RegExp(n.s, n.f); r.lastIndex = n.li; return r; }
      case 'ab': return fromB64(n.b).buffer;
      case 'ta': return new globalThis[n.k](dec(n.b), n.o, n.l);
      case 'dv': return new DataView(dec(n.b), n.o, n.l);
      case 'err': { const E = /Error$/.test(n.n) && typeof globalThis[n.n] === 'function' ? globalThis[n.n] : Error; return new E(); }
      case 'box': return Object(dec(n.v));
      case 'pr': { if ('v' in n) return Promise.resolve(dec(n.v)); const p = Promise.reject(dec(n.e)); p.catch(() => {}); return p; }
    }
    return undefined;
  };
  const get = (i) => {
    if (done[i]) return made[i];
    done[i] = true;
    const n = nodes[i];
    try {
      made[i] = shell(n);
      if (n.p && n.t !== 'o' && made[i] !== undefined && made[i] !== null) Object.setPrototypeOf(made[i], protoFrom(n.p));
    } catch { made[i] = undefined; parts++; }
    return made[i];
  };
  const keyOf = (k) => (typeof k === 'string' ? k : dec(k));
  const define = (target, list) => {
    for (const [k, e, flags, accessor] of list) {
      try {
        const d = { enumerable: !flags.includes('e'), configurable: !flags.includes('c') };
        if (accessor) { d.get = e.g ? dec(e.g) : undefined; d.set = e.s ? dec(e.s) : undefined; }
        else { d.value = dec(e); d.writable = !flags.includes('w'); }
        Object.defineProperty(target, keyOf(k), d);
      } catch { parts++; }
    }
  };
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const v = get(i);
    if (v === undefined || v === null || n.t === 'g') continue;
    try {
      if (n.t === 'a') {
        if (n.sp) for (const [k, e] of n.sp) v[k] = dec(e);
        else for (let k = 0; k < n.items.length; k++) { const e = n.items[k]; if (!(e && e.$ === 'h')) v[k] = dec(e); }
      } else if (n.t === 'm') for (const [k, e] of n.e) v.set(dec(k), dec(e));
      else if (n.t === 's') for (const e of n.e) v.add(dec(e));
      if (n.pr) define(v, n.pr);
      if (n.pp && v.prototype) define(v.prototype, n.pp);
      if (n.i === 'f') Object.freeze(v);
      else if (n.i === 's') Object.seal(v);
      else if (n.i === 'p') Object.preventExtensions(v);
    } catch { parts++; }
  }
  for (const [name, e] of roots) {
    const i = ref(e);
    if ((e && e.$ === 'x') || (i >= 0 && nodes[i] && nodes[i].t === 'x')) continue;
    if (i >= 0 && nodes[i] && nodes[i].t === 'f' && !fnOk[nodes[i].f]) { failed.push(name); continue; }
    try { globalThis[name] = dec(e); restored.push(name); } catch { failed.push(name); }
  }
  return { restored, failed, parts };
}`;

/** Whether a function's source parses in the form the prelude puts it in, so one that doesn't can't keep the rest from coming back. */
function parses(code: string): boolean {
  try {
    new vm.Script(code);
    return true;
  } catch {
    return false;
  }
}

export interface ReplPrelude {
  /** The script the new session's REPL runs first, with REPL_DATA_MARKER where the data goes. */
  script: string;
  /** The names it brings back, in order. */
  names: string[];
  /** What stays behind, and what comes back other than it was, with why. */
  lost: ReplSkipped[];
  changed: ReplSkipped[];
}

const listed = (items: string[]) =>
  items.length > LISTED_NAMES ? `${items.slice(0, LISTED_NAMES).join(', ')} and ${items.length - LISTED_NAMES} more` : items.join(', ');

/**
 * What the new session's REPL runs first: each function as code of its own,
 * then the runtime that rebuilds the values from the data and sets each name
 * as a global, then a message saying what came back. Undefined when the
 * snapshot found nothing at all. It checks the functions' source a slice at a
 * time, so each step stays short.
 */
export async function replPrelude(snapshot: Extract<ReplSnapshot, { roots: string[] }>): Promise<ReplPrelude | undefined> {
  if (!snapshot.roots.length && !snapshot.lost.length && !snapshot.changed.length) return undefined;
  const kept = new Set(snapshot.roots);
  const changed = [...snapshot.changed];
  const lines = [
    'const __looperMethod = (o) => { const k = Reflect.ownKeys(o)[0]; const d = Object.getOwnPropertyDescriptor(o, k); return d.value !== undefined ? d.value : d.get || d.set; };',
    'const __looperMake = [];',
  ];
  let checked = 0;
  for (const [i, fn] of snapshot.functions.entries()) {
    const wrapped = fn.form === 0 ? `(${fn.source}\n)` : `({ ${fn.source}\n})`;
    if (!parses(wrapped)) {
      changed.push({ name: fn.path, reason: "its source doesn't parse, so it came back undefined" });
    } else {
      lines.push(`__looperMake[${i}] = () => ${fn.form === 0 ? wrapped : `__looperMethod(${wrapped})`};`);
      const outside = fn.free.filter((n) => !kept.has(n));
      if (outside.length) changed.push({ name: fn.path, reason: `it reads ${outside.join(', ')}, which only the code that made it could see` });
    }
    checked += fn.source.length;
    if (checked >= CHECK_SLICE_CHARS) {
      checked = 0;
      await nextTurn();
    }
  }
  const notes = [...snapshot.lost, ...changed].map((s) => `${s.name} (${s.reason})`);
  lines.push(
    `const __looperResult = (${RESTORE_RUNTIME})(__looperMake, ${REPL_DATA_MARKER});`,
    `const __looperList = (names) => (names.length > ${LISTED_NAMES} ? names.slice(0, ${LISTED_NAMES}).join(', ') + ' and ' + (names.length - ${LISTED_NAMES}) + ' more' : names.join(', '));`,
    `const __looperNotes = ${JSON.stringify(notes)};`,
    "'Looper restored ' + __looperResult.restored.length + \" names from the earlier session's REPL as globals\" + (__looperResult.restored.length ? ': ' + __looperList(__looperResult.restored) : '') + '.' +",
    "  (__looperResult.failed.length ? ' These failed when restored: ' + __looperList(__looperResult.failed) + '.' : '') +",
    "  (__looperResult.parts ? ' ' + __looperResult.parts + \" parts of them couldn't be put back.\" : '') +",
    "  (__looperNotes.length ? ' Not as they were: ' + __looperList(__looperNotes) + '.' : '')",
  );
  return { script: lines.join('\n'), names: snapshot.roots, lost: snapshot.lost, changed };
}

/**
 * What the compacted conversation tells the agent about its REPL: the names
 * the new session starts with, and each thing that didn't come back as it
 * was, with the statement that made it (`made`, by name) so the agent can run
 * it again. Short when everything came back. When the REPL waits for a script
 * (a mode that asks for permission), the prelude's own message reaches only
 * the mod, so this is how the agent learns it.
 */
export function replStateNote(prelude: ReplPrelude, made: ReadonlyMap<string, string> = new Map()): string {
  const kept = prelude.names.length
    ? `This session's REPL starts with the earlier session's ${prelude.names.length === 1 ? 'name' : 'names'} ${listed(prelude.names)} as globals, restored by Looper.`
    : "Looper couldn't restore any of the earlier session's REPL names.";
  const items = [...prelude.lost, ...prelude.changed];
  if (!items.length) return kept;
  const told = new Set<string>();
  const shown = items.slice(0, LISTED_NAMES).map((s) => {
    const root = s.name.split(/[.[]/)[0];
    const how = told.has(root) ? undefined : made.get(root);
    told.add(root);
    return `${s.name}: ${s.reason}${how ? `, made by \`${how}\`` : ''}`;
  });
  const more = items.length > LISTED_NAMES ? `, and ${items.length - LISTED_NAMES} more` : '';
  return `${kept} These didn't come back as they were, so rebuild them if you need them: ${shown.join('; ')}${more}.`;
}

/** What a snapshot index holds when it answers request `id`; null for anything else. */
export function parseReplSnapshot(text: string, id: number): ReplSnapshot | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const d = data as Record<string, unknown> | null;
  if (!d || d.version !== 2 || d.id !== id) return null;
  if (typeof d.error === 'string') return { version: 2, id, error: d.error };
  if (!Array.isArray(d.roots) || !Array.isArray(d.functions) || !Array.isArray(d.lost) || !Array.isArray(d.changed)) return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const skipped = (v: unknown[]) =>
    (v as Record<string, unknown>[])
      .filter((s) => !!s && typeof s.name === 'string' && typeof s.reason === 'string')
      .map((s): ReplSkipped => ({ name: s.name as string, reason: s.reason as string }));
  const functions = (d.functions as Record<string, unknown>[]).map(
    (f): ReplFunction => ({
      source: typeof f?.source === 'string' ? f.source : '',
      form: f?.form === 1 ? 1 : 0,
      path: typeof f?.path === 'string' ? f.path : '',
      free: strings(f?.free),
    }),
  );
  const parts = typeof d.parts === 'number' && d.parts >= 1 ? Math.floor(d.parts) : 1;
  return { version: 2, id, roots: strings(d.roots), functions, lost: skipped(d.lost), changed: skipped(d.changed), bytes: typeof d.bytes === 'number' ? d.bytes : 0, parts };
}
