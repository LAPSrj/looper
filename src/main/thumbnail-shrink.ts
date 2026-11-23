/** A bigger image isn't decoded for a thumbnail: 4 bytes a pixel would take hundreds of MB. */
export const THUMBNAIL_MAX_PIXELS = 50_000_000;

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 8 bits a channel, row by row. */
  data: Uint8Array;
}

/** A PNG's width and height from its header, without decoding it; null when it isn't a PNG. */
export function pngSize(head: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length < 24 || sig.some((b, i) => head[i] !== b)) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * `src` shrunk to `height` (width in proportion), each pixel the average of the block of source pixels it covers,
 * weighted by alpha so transparent pixels don't darken the edges. An image no taller is returned as it is.
 */
export function shrink(src: Pixels, height: number): Pixels {
  if (src.height <= height) return src;
  const width = Math.max(1, Math.round((src.width * height) / src.height));
  const out = new Uint8Array(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          const alpha = src.data[i + 3];
          r += src.data[i] * alpha;
          g += src.data[i + 1] * alpha;
          b += src.data[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}

/** Whether the bytes start as a JPEG file does. */
export const isJpeg = (head: Uint8Array): boolean => head.length > 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;

/**
 * A JPEG's EXIF orientation (1-8, 1 when it has none): how the camera says to turn the stored pixels to show them
 * upright. Phones store a portrait photo sideways with 6.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    // Start of scan: the image data, after every segment that could hold EXIF.
    if (marker === 0xda) break;
    const length = view.getUint16(at + 2);
    const tiff = at + 10;
    const isExif = marker === 0xe1 && length >= 8 && String.fromCharCode(...bytes.subarray(at + 4, at + 10)) === 'Exif\0\0';
    if (isExif && tiff + 8 <= bytes.length) {
      const little = bytes[tiff] === 0x49;
      const u16 = (o: number) => (o + 2 <= bytes.length ? view.getUint16(o, little) : 0);
      const ifd = tiff + (tiff + 8 <= bytes.length ? view.getUint32(tiff + 4, little) : 0);
      const entries = u16(ifd);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (u16(entry) === 0x0112) {
          const o = u16(entry + 8);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

/**
 * A JPEG's width and height as it shows (turned by its EXIF orientation), from its frame header, without decoding
 * it; null when it isn't a JPEG or `head` ends before the frame header.
 */
export function jpegSize(head: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(head)) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let at = 2;
  while (at + 9 <= head.length && head[at] === 0xff) {
    const marker = head[at + 1];
    // Start of scan or end of image: no frame header before them.
    if (marker === 0xda || marker === 0xd9) return null;
    // A frame header (SOF0 to SOF15; C4, C8 and CC are other segments) holds the height, then the width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = view.getUint16(at + 5);
      const width = view.getUint16(at + 7);
      if (!width || !height) return null;
      return jpegOrientation(head) >= 5 ? { width: height, height: width } : { width, height };
    }
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}

/** A PNG's or JPEG's size as it shows, from the start of its file; null for another kind, or a start too short. */
export const imageHeadSize = (head: Uint8Array): { width: number; height: number } | null => pngSize(head) ?? jpegSize(head);

/** `src` turned and mirrored as EXIF orientation `o` says, so it shows upright. */
export function upright(src: Pixels, o: number): Pixels {
  if (o <= 1 || o > 8) return src;
  const { width: w, height: h, data } = src;
  const sideways = o >= 5;
  const width = sideways ? h : w;
  const height = sideways ? w : h;
  const out = new Uint8Array(data.length);
  let d = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, d += 4) {
      // The stored pixel shown at (x, y).
      const sx = o === 2 || o === 3 ? w - 1 - x : o === 4 ? x : o === 5 || o === 6 ? y : w - 1 - y;
      const sy = o === 2 ? y : o === 3 || o === 4 ? h - 1 - y : o === 5 || o === 8 ? x : h - 1 - x;
      const s = (sy * w + sx) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width, height, data: out };
}
