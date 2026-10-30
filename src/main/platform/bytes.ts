import type { EncodedBytes } from '../../shared/remote-access';

const isEncoded = (v: object): v is EncodedBytes =>
  typeof (v as EncodedBytes).$bytes === 'string' && Object.keys(v).length === 1;

/** Turn every `{ $bytes }` in a client's arguments back into a Uint8Array, as Electron's IPC delivers them. */
export function decodeBytes(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decodeBytes);
  if (isEncoded(v)) {
    const b = Buffer.from(v.$bytes, 'base64');
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = decodeBytes(x);
  return out;
}

/**
 * Turn every Uint8Array in a value for a client into `{ $bytes }`. Objects
 * without any are passed back as they are, so a large engine event isn't copied.
 * An object met again (referenced twice) gets the same encoding; one inside
 * itself (a cycle) is left as it is, and JSON refuses it later.
 */
export function encodeBytes(v: unknown, done = new WeakMap<object, unknown>()): unknown {
  if (!v || typeof v !== 'object') return v;
  if (v instanceof Uint8Array) return { $bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') } satisfies EncodedBytes;
  if (done.has(v)) return done.get(v);
  done.set(v, v);
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    v.forEach((x, i) => {
      const e = encodeBytes(x, done);
      if (e !== x) (out ??= v.slice())[i] = e;
    });
    done.set(v, out ?? v);
    return out ?? v;
  }
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
  let out: Record<string, unknown> | null = null;
  for (const [k, x] of Object.entries(v)) {
    const e = encodeBytes(x, done);
    if (e !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = e;
  }
  done.set(v, out ?? v);
  return out ?? v;
}
