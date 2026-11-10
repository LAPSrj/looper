import wasmUrl from '@cwasm/jpeg-turbo/jpeg-turbo.wasm?inline';
import type { Pixels } from './thumbnail-shrink';

/**
 * JPEG decoding for thumbnails: libjpeg-turbo built to WebAssembly, so it runs in the worker on every OS. It decodes
 * straight at 1/8, 1/4 or 1/2 size, which for a phone photo was 4-5 times faster than decoding it whole and kept the
 * worker at 70-130 MB instead of 400-750 MB.
 */

interface TurboJpeg {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  tjInitDecompress(): number;
  tjDecompressHeader3(handle: number, src: number, size: number, width: number, height: number, subsamp: number, colorspace: number): number;
  tjDecompress2(handle: number, src: number, size: number, dst: number, width: number, pitch: number, height: number, format: number, flags: number): number;
  tjDestroy(handle: number): number;
}

const TJPF_RGBA = 7;

let module: WebAssembly.Module | null = null;
let turbo: TurboJpeg | null = null;

function instance(): TurboJpeg {
  module ??= new WebAssembly.Module(Buffer.from(wasmUrl.slice(wasmUrl.indexOf(',') + 1), 'base64'));
  // libjpeg reports a bad file by longjmp, which this build turns into a throw: decode() then drops the instance.
  const fail = (): never => {
    throw new Error('libjpeg-turbo stopped');
  };
  const wasi = { environ_sizes_get: () => 0, environ_get: fail, proc_exit: fail, fd_close: fail, fd_seek: fail, fd_write: fail };
  turbo ??= new WebAssembly.Instance(module, { env: { setjmp: () => 0, longjmp: fail }, wasi_snapshot_preview1: wasi }).exports as unknown as TurboJpeg;
  return turbo;
}

/**
 * `bytes` decoded at the smallest of libjpeg's scales whose `side` ('height', or 'width' for a photo stored on its
 * side) is still at least `atLeast` px; null when it isn't a JPEG this decodes, or would be over `maxPixels`.
 */
export function decodeJpeg(bytes: Uint8Array, atLeast: number, side: 'width' | 'height', maxPixels: number): Pixels | null {
  const tj = instance();
  let src = 0;
  let handle = 0;
  let out = 0;
  try {
    src = tj.malloc(bytes.byteLength);
    new Uint8Array(tj.memory.buffer, src, bytes.byteLength).set(bytes);
    handle = tj.tjInitDecompress();
    const meta = tj.malloc(16);
    const ok = tj.tjDecompressHeader3(handle, src, bytes.byteLength, meta, meta + 4, meta + 8, meta + 12) === 0;
    const [width, height] = new Uint32Array(tj.memory.buffer, meta, 2);
    tj.free(meta);
    if (!ok || !width || !height) return null;
    let denom = 8;
    while (denom > 1 && Math.ceil((side === 'width' ? width : height) / denom) < atLeast) denom /= 2;
    const w = Math.ceil(width / denom);
    const h = Math.ceil(height / denom);
    if (w * h > maxPixels) return null;
    out = tj.malloc(w * h * 4);
    if (!out || tj.tjDecompress2(handle, src, bytes.byteLength, out, w, w * 4, h, TJPF_RGBA, 0) !== 0) return null;
    return { width: w, height: h, data: new Uint8Array(tj.memory.buffer, out, w * h * 4).slice() };
  } catch {
    // Its memory may be left half-used: the next image gets a fresh instance.
    turbo = null;
    return null;
  } finally {
    if (turbo) {
      if (out) tj.free(out);
      if (handle) tj.tjDestroy(handle);
      if (src) tj.free(src);
    }
  }
}
