import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { PNG } from 'pngjs';
import { decodeJpeg } from './thumbnail-jpeg';
import { imageHeadSize, isJpeg, jpegOrientation, pngSize, shrink, THUMBNAIL_MAX_PIXELS, upright, type Pixels } from './thumbnail-shrink';

export interface ThumbnailIn {
  id: number;
  file: string;
  height: number;
  /** Only the image's size, read from the start of its file, not a thumbnail. */
  sizeOnly?: true;
}
export interface ThumbnailOut {
  id: number;
  url: string | null;
  /** For sizeOnly: the image's width and height as it shows; null when the file isn't a PNG or JPEG it can read. */
  size?: { width: number; height: number } | null;
}

/** How much of a file its size is read from: a JPEG's frame header comes after its EXIF, which holds a phone photo's preview. */
const SIZE_HEAD_BYTES = 256 * 1024;

/** A PNG's or JPEG's size as it shows, from the start of its file. */
async function headSize(file: string): Promise<{ width: number; height: number } | null> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(SIZE_HEAD_BYTES);
    const { bytesRead } = await fh.read(head, 0, SIZE_HEAD_BYTES, 0);
    return imageHeadSize(head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

const pngUrl = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`;

function encode(px: Pixels): string {
  const png = new PNG({ width: px.width, height: px.height });
  png.data = Buffer.from(px.data.buffer, px.data.byteOffset, px.data.byteLength);
  return pngUrl(PNG.sync.write(png));
}

/** A PNG or JPEG file as a thumbnail data URL; null when it's neither, or one this can't decode. */
async function thumbnail(file: string, height: number): Promise<string | null> {
  const bytes = await fs.promises.readFile(file);
  const size = pngSize(bytes);
  if (size) {
    if (size.width * size.height > THUMBNAIL_MAX_PIXELS) return null;
    // Short enough already: the file itself.
    if (size.height <= height) return pngUrl(bytes);
    const src = PNG.sync.read(bytes);
    return encode(shrink({ width: src.width, height: src.height, data: src.data }, height));
  }
  if (!isJpeg(bytes)) return null;
  const orientation = jpegOrientation(bytes);
  const px = decodeJpeg(bytes, height, orientation >= 5 ? 'width' : 'height', THUMBNAIL_MAX_PIXELS);
  return px && encode(shrink(upright(px, orientation), height));
}

parentPort?.on('message', (msg: ThumbnailIn) => {
  if (msg.sizeOnly) {
    headSize(msg.file).then(
      (size) => parentPort!.postMessage({ id: msg.id, url: null, size } satisfies ThumbnailOut),
      () => parentPort!.postMessage({ id: msg.id, url: null, size: null } satisfies ThumbnailOut),
    );
    return;
  }
  thumbnail(msg.file, msg.height).then(
    (url) => parentPort!.postMessage({ id: msg.id, url } satisfies ThumbnailOut),
    () => parentPort!.postMessage({ id: msg.id, url: null } satisfies ThumbnailOut),
  );
});
