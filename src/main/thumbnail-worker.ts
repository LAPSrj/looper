import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { PNG } from 'pngjs';
import { decodeJpeg } from './thumbnail-jpeg';
import { isJpeg, jpegOrientation, pngSize, shrink, THUMBNAIL_MAX_PIXELS, upright, type Pixels } from './thumbnail-shrink';

export interface ThumbnailIn {
  id: number;
  file: string;
  height: number;
}
export interface ThumbnailOut {
  id: number;
  url: string | null;
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
  thumbnail(msg.file, msg.height).then(
    (url) => parentPort!.postMessage({ id: msg.id, url } satisfies ThumbnailOut),
    () => parentPort!.postMessage({ id: msg.id, url: null } satisfies ThumbnailOut),
  );
});
