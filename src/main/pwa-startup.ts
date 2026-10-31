import { nativeImage } from 'electron';
import { startupBitmap, startupSize } from './remote-access/startup-bitmap';

const cache = new Map<string, Buffer>();

/** A launch screen of the home-screen app as PNG, made on first request and kept; null for a size no iPhone has. */
export function pwaStartup(width: number, height: number, dark: boolean): Buffer | null {
  const size = startupSize(width, height);
  if (!size) return null;
  const key = `${width}x${height}${dark ? 'd' : 'l'}`;
  let png = cache.get(key);
  if (!png) {
    const bitmap = startupBitmap(size, dark);
    png = nativeImage.createFromBitmap(bitmap.data, { width: bitmap.width, height: bitmap.height }).toPNG();
    cache.set(key, png);
  }
  return png;
}
