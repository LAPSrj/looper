import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parseReplSnapshot, REPL_DATA_MARKER, replDataFiles, replDefinitions, replNames, replPrelude, replSnapshotScript, replStateNote, type ReplSnapshot } from '../src/engine/repl-state';

type Index = Extract<ReplSnapshot, { roots: string[] }>;

/** Runs the snapshot script in `ctx`, as Code Mode runs a script (top-level await), and reads what it wrote. */
async function snapshot(ctx: vm.Context, names: string[], limit?: number): Promise<{ index: Index; data: string }> {
  const written: Record<string, string> = {};
  ctx.write = async (p: string, text: string) => void (written[p] = text);
  ctx.setTimeout = setTimeout;
  await vm.runInContext(`(async () => {\n${replSnapshotScript(names, '/run/repl-snapshot.json', '/run/repl-data.json', 7, limit)}\n})()`, ctx);
  const index = parseReplSnapshot(written['/run/repl-snapshot.json'], 7);
  if (!index || 'error' in index) throw new Error('no snapshot');
  // The mod joins the parts in order, as it reads them.
  return { index, data: replDataFiles(index.parts).map((n) => written['/run/' + n]).join('') };
}

/** Runs the prelude in a fresh REPL, with the data where the mod puts it, as the new session's first script. */
async function restore(index: Index, data: string, ctx: vm.Context = vm.createContext({})) {
  const p = (await replPrelude(index))!;
  const message = vm.runInContext(p.script.replace(REPL_DATA_MARKER, () => data), ctx) as string;
  return { p, message, ctx };
}

/** A class of the REPL's own, as a tool result's is: made outside the scripts' realm. */
class HostThing {
  stdout = 'hi';
  text() {
    return this.stdout;
  }
}
const host = () => ({ tools: { ping: () => 'pong' } });

const SESSION = [
  'const keepMe = { a: 1, list: [2, 3] };',
  'function helperK(x) { return x + keepMe.a; }',
  'class Doubler { constructor(n) { this.n = n; } twice() { return this.n * 2; } }',
  'class Tally extends Map { total() { let t = 0; for (const v of this.values()) t += v; return t; } }',
  "const tally = new Tally([['a', 2], ['b', 3]]);",
  'const pair = new Doubler(4);',
  "const counter = new Map([[1, { deep: true }], ['k', new Set([1, 2])]]);",
  'const when = new Date(0);',
  'const badDate = new Date(NaN);',
  'const pattern = /ab+c/gi; pattern.lastIndex = 2;',
  'const huge = 2n ** 70n;',
  'const bytes = new Uint8Array([1, 2, 3, 250]);',
  'const view = new DataView(bytes.buffer, 1, 2);',
  'const nums = { nan: NaN, inf: -Infinity, neg: -0, none: undefined };',
  "const ring = { name: 'ring' }; ring.self = ring;",
  'const shared = { s: 1 }; const both = [shared, shared];',
  'const sparse = [1, , 3];',
  'const frozen = Object.freeze({ f: 1 });',
  'const lazy = { get twice() { return this.base * 2; }, base: 21 };',
  'const bare = Object.create(null); bare.x = 1;',
  'const child = Object.create(keepMe); child.own = true;',
  "class Oops extends Error { constructor(m) { super(m); this.name = 'Oops'; this.code = 7; } }",
  "const err = new Oops('bad thing');",
  'const done = Promise.resolve({ ok: 1 });',
  "const failedP = Promise.reject(new TypeError('nope')); failedP.catch(() => {});",
  'const pending = new Promise(() => {});',
  'const weak = new WeakMap();',
  'const box = { cache: new WeakMap(), n: 1 };',
  'function makeCounter() { let n = 0; return () => ++n; }',
  'const inc = makeCounter();',
  'const boundK = helperK.bind(null);',
  'const parse = JSON.parse;',
  "const sym = Symbol('mine');",
  "const regSym = Symbol.for('looper.test');",
  "const tagged = { [Symbol.for('looper.key')]: 'v' };",
  'const step = (function* () { yield 1; })();',
  "globalThis.shared2 = ['g'];",
  'let nothing;',
  'const pingRef = tools.ping;',
  'const out2 = hostOut;',
];

describe('the REPL state across a compaction', () => {
  it('finds the names the scripts defined, each where it was last defined', async () => {
    expect(await replNames(['const a = 1; let b; function c() { const d = 2 }', 'class E {}; globalThis.f = 1; const { g, h: [i] } = x; var await = 1', 'const a = 2; if (x == y) globalThis.z == 1'])).toEqual([
      'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'a',
    ]);
    expect(await replNames(['const __looperState = 1; let new1 = 2'])).toEqual(['new1']);
  });

  it('brings every kind of value back as it was, and says precisely what it could not', async () => {
    const old = vm.createContext({ ...host(), hostOut: new HostThing(), btoa, atob });
    vm.runInContext(SESSION.join('\n'), old);
    const { index, data } = await snapshot(old, await replNames(SESSION));
    expect(index.lost).toEqual([
      { name: 'pending', reason: "a promise that hadn't settled" },
      { name: 'weak', reason: "a WeakMap, whose contents can't be read" },
      { name: 'boundK', reason: 'a bound function' },
      { name: 'sym', reason: 'a symbol only the earlier session had' },
      { name: 'step', reason: 'a generator part-way through' },
    ].sort((a, b) => index.lost.findIndex((x) => x.name === a.name) - index.lost.findIndex((x) => x.name === b.name)));
    expect(new Set(index.lost.map((l) => l.name))).toEqual(new Set(['pending', 'weak', 'boundK', 'sym', 'step']));
    expect(index.changed).toEqual(
      expect.arrayContaining([
        { name: 'box.cache', reason: "a WeakMap, whose contents can't be read" },
        { name: 'out2', reason: 'came back as a plain object holding its values, without the methods of its class HostThing' },
      ]),
    );
    expect(index.functions.find((f) => f.path === 'inc')?.free).toEqual(['n']);
    expect(index.functions.filter((f) => f.path !== 'inc').every((f) => f.free.length === 0)).toBe(true);

    const { p, message, ctx } = await restore(index, data, vm.createContext({ ...host(), btoa, atob }));
    const run = (code: string) => vm.runInContext(code, ctx);
    expect(run('helperK(1)')).toBe(2);
    expect(run('keepMe')).toEqual({ a: 1, list: [2, 3] });
    expect(run('pair instanceof Doubler && pair.twice()')).toBe(8);
    expect(run('tally instanceof Tally && tally instanceof Map && tally.total() + tally.get("a")')).toBe(7);
    expect(run('counter.get(1).deep && counter.get("k") instanceof Set && counter.get("k").size')).toBe(2);
    expect(run('when.getTime() === 0 && Number.isNaN(badDate.getTime())')).toBe(true);
    expect(run('[pattern.source, pattern.flags, pattern.lastIndex]')).toEqual(['ab+c', 'gi', 2]);
    expect(run('huge === 2n ** 70n')).toBe(true);
    expect(run('[...bytes]')).toEqual([1, 2, 3, 250]);
    expect(run('view.getUint8(0) === 2 && view.buffer === bytes.buffer && view.byteLength')).toBe(2);
    expect(run('Number.isNaN(nums.nan) && nums.inf === -Infinity && Object.is(nums.neg, -0) && "none" in nums && nums.none === undefined')).toBe(true);
    expect(run('ring.self === ring && both[0] === both[1]')).toBe(true);
    expect(run('sparse.length === 3 && !(1 in sparse) && sparse[2]')).toBe(3);
    expect(run('Object.isFrozen(frozen) && lazy.twice')).toBe(42);
    expect(run('Object.getPrototypeOf(bare) === null && Object.getPrototypeOf(child) === keepMe && child.a + Number(child.own)')).toBe(2);
    expect(run('err instanceof Oops && err instanceof Error && [err.name, err.message, err.code, err.stack.split("\\n")[0]]')).toEqual(['Oops', 'bad thing', 7, 'Oops: bad thing']);
    expect(index.changed.filter((c) => c.name.startsWith('err'))).toEqual([]);
    expect(await run('done')).toEqual({ ok: 1 });
    await expect(run('failedP')).rejects.toThrow('nope');
    expect(run('box.n === 1 && box.cache === undefined')).toBe(true);
    expect(run('inc instanceof Function && makeCounter()()')).toBe(1);
    expect(run('parse === JSON.parse && pingRef === tools.ping')).toBe(true);
    expect(run('regSym === Symbol.for("looper.test") && tagged[Symbol.for("looper.key")]')).toBe('v');
    expect(run('shared2[0] + ("nothing" in globalThis)')).toBe('gtrue');
    expect(run('out2.stdout')).toBe('hi');
    expect(run('typeof pending + typeof weak + typeof sym')).toBe('undefinedundefinedundefined');
    expect(message).toMatch(/^Looper restored \d+ names from the earlier session's REPL as globals: keepMe, helperK, /);
    expect(p.changed).toEqual(expect.arrayContaining([{ name: 'inc', reason: 'it reads n, which only the code that made it could see' }]));
  });

  it('leaves the built-in prototypes alone when the REPL wraps their methods, as Code Mode does', async () => {
    const ctx = vm.createContext({});
    vm.runInContext(
      [
        "Object.defineProperty(Object.prototype, 'constructor', { get() { return Object; }, configurable: true });",
        "for (const k of ['getTime', 'toString']) { const f = Date.prototype[k]; Date.prototype[k] = function (...a) { return f.apply(this, a); }; }",
        "Array.prototype.at = function (i) { return this[i < 0 ? this.length + i : i]; };",
        'const plain = { a: 1 }; const when = new Date(0); const list = [1, 2];',
      ].join('\n'),
      ctx,
    );
    const { index, data } = await snapshot(ctx, ['plain', 'when', 'list']);
    expect([index.functions, index.changed, index.lost]).toEqual([[], [], []]);
    expect(data.length).toBeLessThan(200);
    const { ctx: next } = await restore(index, data);
    expect(vm.runInContext('[plain.a, when.getTime(), list.length]', next)).toEqual([1, 0, 2]);
  });

  it('keeps going past the size it can take, and says which names stayed behind', async () => {
    const ctx = vm.createContext({});
    vm.runInContext(`const v1 = 'y'.repeat(600000), v2 = v1 + 'z', v3 = v1 + 'w';`, ctx);
    const { index } = await snapshot(ctx, ['v1', 'v2', 'v3'], 1024 * 1024);
    expect(index.roots).toEqual(['v1', 'v2']);
    expect(index.lost).toEqual([{ name: 'v3', reason: 'past the 1 MB the REPL state can take' }]);
  });

  it('writes the data in parts the mod can read, without cutting a character in two', async () => {
    const ctx = vm.createContext({});
    // Two-unit characters at every position, so a part's end falls inside one unless it's moved.
    vm.runInContext("const smiles = 'a' + String.fromCodePoint(0x1f600).repeat(700000); const tail = 'end';", ctx);
    const { index, data } = await snapshot(ctx, ['smiles', 'tail']);
    expect(index.parts).toBe(2);
    const { ctx: next } = await restore(index, data);
    expect(vm.runInContext("smiles.length === 1400001 && [...smiles].slice(1).every((c) => c.length === 2) && tail", next)).toBe('end');
  });

  it('carries every byte of a buffer when the REPL has no btoa', async () => {
    const old = vm.createContext({});
    vm.runInContext('const all = new Uint8Array(256).map((_, i) => i); const odd = new Uint8Array([7, 8]);', old);
    const { index, data } = await snapshot(old, ['all', 'odd']);
    const { ctx } = await restore(index, data);
    expect(vm.runInContext('[...all].every((b, i) => b === i) && all.length === 256 && [...odd].join()', ctx)).toBe('7,8');
  });

  it("leaves out a function whose source doesn't parse, and restores the rest", async () => {
    const index: Index = { version: 2, id: 1, roots: ['broken', 'ok'], functions: [{ source: 'm() { return 1 } }', form: 1, path: 'broken', free: [] }], lost: [], changed: [], bytes: 0, parts: 1 };
    const data = JSON.stringify({ roots: [['broken', { '#': 0 }], ['ok', { '#': 1 }]], nodes: [{ t: 'f', f: 0 }, { t: 'a', l: 1, items: [1] }] });
    const { p, message, ctx } = await restore(index, data);
    expect(p.changed).toEqual([{ name: 'broken', reason: "its source doesn't parse, so it came back undefined" }]);
    expect(vm.runInContext('ok', ctx)).toEqual([1]);
    expect(message).toContain('These failed when restored: broken.');
  });

  it('finds the statement that made each name, for the agent to run again', async () => {
    const made = await replDefinitions(['const a = 1; let b = new Map([[1, 2]]);\nfunction c() {\n  return "}";\n}\nconst { d } = obj; // note', 'const a = 2'], ['a', 'b', 'c', 'd', 'none']);
    expect(Object.fromEntries(made)).toEqual({ a: 'const a = 2', b: 'let b = new Map([[1, 2]]);', c: 'function c() { return "}"; }', d: 'const { d } = obj;' });
  });

  it('tells the agent what came back, and how to rebuild what did not', () => {
    const all = { script: '', names: ['keepMe', 'helperK'], lost: [], changed: [] };
    expect(replStateNote(all)).toBe("This session's REPL starts with the earlier session's names keepMe, helperK as globals, restored by Looper.");
    const some = { script: '', names: ['box'], lost: [{ name: 'pending', reason: "a promise that hadn't settled" }], changed: [{ name: 'box.cache', reason: "a WeakMap, whose contents can't be read" }] };
    expect(replStateNote(some, new Map([['pending', 'const pending = fetchIt();'], ['box', 'const box = { cache: new WeakMap(), n: 1 };']]))).toBe(
      "This session's REPL starts with the earlier session's name box as globals, restored by Looper. These didn't come back as they were, so rebuild them if you need them: pending: a promise that hadn't settled, made by `const pending = fetchIt();`; box.cache: a WeakMap, whose contents can't be read, made by `const box = { cache: new WeakMap(), n: 1 };`.",
    );
    expect(replStateNote({ script: '', names: [], lost: [{ name: 'm', reason: 'a bound function' }], changed: [] })).toBe(
      "Looper couldn't restore any of the earlier session's REPL names. These didn't come back as they were, so rebuild them if you need them: m: a bound function.",
    );
  });

  it('has nothing to restore from an empty snapshot', async () => {
    expect(await replPrelude({ version: 2, id: 1, roots: [], functions: [], lost: [], changed: [], bytes: 0, parts: 1 })).toBeUndefined();
  });

  it('reads only the answer to its own request', () => {
    expect(parseReplSnapshot('{"version":2,"id":2,"roots":[],"functions":[],"lost":[],"changed":[]}', 3)).toBeNull();
    expect(parseReplSnapshot('{"version":2,"id":3,"error":"no REPL"}', 3)).toEqual({ version: 2, id: 3, error: 'no REPL' });
    expect(parseReplSnapshot('not json', 3)).toBeNull();
    expect(parseReplSnapshot('{"version":2,"id":3,"roots":["a",1],"functions":[{"source":"() => 1","form":0,"path":"a","free":["x",2]}],"lost":[{"name":"c"}],"changed":[],"bytes":9,"parts":2}', 3)).toEqual({
      version: 2,
      id: 3,
      roots: ['a'],
      functions: [{ source: '() => 1', form: 0, path: 'a', free: ['x'] }],
      lost: [],
      changed: [],
      bytes: 9,
      parts: 2,
    });
  });
});
