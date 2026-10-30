import { nativeImage, type NativeImage } from 'electron';
import { PWA_ICONS, type PwaIconName } from '../shared/remote-access';

/** Behind a maskable icon (and Apple's, which can't be transparent). */
const BACKGROUND = { r: 0xff, g: 0xff, b: 0xff };
/** A maskable icon's content stays in the middle 80% circle; the logo takes less so its corners do too. */
const MASKABLE_SCALE = 0.7;

/**
 * The logo on an opaque square: nativeImage can only resize, so the pixels are
 * blended here. toBitmap() is BGRA; Chromium keeps it premultiplied, which the
 * check below confirms before blending.
 */
function onBackground(logo: NativeImage, size: number): NativeImage {
  const inner = Math.round(size * MASKABLE_SCALE);
  const small = logo.resize({ width: inner, height: inner, quality: 'best' });
  const src = small.toBitmap();
  const { width: w, height: h } = small.getSize();
  let premultiplied = true;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (src[i] > a || src[i + 1] > a || src[i + 2] > a) {
      premultiplied = false;
      break;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = BACKGROUND.b;
    out[i + 1] = BACKGROUND.g;
    out[i + 2] = BACKGROUND.r;
    out[i + 3] = 255;
  }
  const ox = Math.floor((size - w) / 2);
  const oy = Math.floor((size - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = ((y + oy) * size + (x + ox)) * 4;
      const a = src[s + 3];
      for (let c = 0; c < 3; c++) {
        const fg = premultiplied ? src[s + c] : (src[s + c] * a) / 255;
        out[d + c] = Math.round(fg + (out[d + c] * (255 - a)) / 255);
      }
    }
  }
  return nativeImage.createFromBitmap(out, { width: size, height: size });
}

/** The home-screen icons from the app's icon, made on first request and kept. */
export function pwaIcons(iconPath: string): (name: PwaIconName) => Buffer | null {
  const cache = new Map<PwaIconName, Buffer | null>();
  let logo: NativeImage | null = null;
  return (name) => {
    if (cache.has(name)) return cache.get(name)!;
    logo ??= nativeImage.createFromPath(iconPath);
    const spec = PWA_ICONS[name];
    let png: Buffer | null = null;
    if (!logo.isEmpty()) {
      png = (spec.maskable ? onBackground(logo, spec.size) : logo.resize({ width: spec.size, height: spec.size, quality: 'best' })).toPNG();
    }
    cache.set(name, png);
    return png;
  };
}
