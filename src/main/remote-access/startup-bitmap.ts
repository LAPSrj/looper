/**
 * The launch screens of an installed iPhone app: one portrait image per
 * device size, which iOS shows between the tap and the first paint. They match
 * the first screen (the grouped background, an empty top bar and an empty tab
 * bar) and carry no text, as Apple's launch guidance asks.
 */

export interface StartupSize {
  /** The screen in CSS points, and its pixel ratio. */
  width: number;
  height: number;
  ratio: number;
  /** Status bar and navigation bar height, and the tab bar with the home indicator below it, in points. */
  top: number;
  bottom: number;
}

const island = { top: 59 + 44, bottom: 49 + 34 };
const notch = { top: 47 + 44, bottom: 49 + 34 };
const oldNotch = { top: 44 + 44, bottom: 49 + 34 };
const home = { top: 20 + 44, bottom: 49 };

/** The iPhones that run iOS 17 and later, by screen size (several models share one). */
export const STARTUP_SIZES: readonly StartupSize[] = [
  { width: 440, height: 956, ratio: 3, ...island },
  { width: 430, height: 932, ratio: 3, ...island },
  { width: 420, height: 912, ratio: 3, ...island },
  { width: 402, height: 874, ratio: 3, ...island },
  { width: 393, height: 852, ratio: 3, ...island },
  { width: 428, height: 926, ratio: 3, ...notch },
  { width: 390, height: 844, ratio: 3, ...notch },
  { width: 414, height: 896, ratio: 3, ...oldNotch },
  { width: 375, height: 812, ratio: 3, ...oldNotch },
  { width: 414, height: 896, ratio: 2, ...oldNotch },
  { width: 414, height: 736, ratio: 3, ...home },
  { width: 375, height: 667, ratio: 2, ...home },
];

export const startupPixels = (s: StartupSize): { width: number; height: number } => ({ width: s.width * s.ratio, height: s.height * s.ratio });

/** The size whose image is `width` x `height` pixels. */
export const startupSize = (width: number, height: number): StartupSize | undefined =>
  STARTUP_SIZES.find((s) => s.width * s.ratio === width && s.height * s.ratio === height);

export const startupName = (s: StartupSize, dark: boolean): string => {
  const { width, height } = startupPixels(s);
  return `${width}x${height}-${dark ? 'dark' : 'light'}.png`;
};

// The iOS grouped background and bars (ios.css: --ios-grouped, --ios-bar, --ios-sep).
const LIGHT = { bg: [0xf2, 0xf2, 0xf7], bar: [0xf9, 0xf9, 0xf9], sep: [0xc8, 0xc8, 0xcc] } as const;
const DARK = { bg: [0x00, 0x00, 0x00], bar: [0x16, 0x16, 0x17], sep: [0x3a, 0x3a, 0x3c] } as const;

/** The image as BGRA pixels, which Electron's nativeImage.createFromBitmap takes. */
export function startupBitmap(s: StartupSize, dark: boolean): { data: Buffer; width: number; height: number } {
  const { width, height } = startupPixels(s);
  const c = dark ? DARK : LIGHT;
  const data = Buffer.alloc(width * height * 4);
  const rows = (from: number, to: number, [r, g, b]: readonly number[]) => {
    for (let y = Math.max(0, from); y < Math.min(height, to); y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = b;
        data[i + 1] = g;
        data[i + 2] = r;
        data[i + 3] = 255;
      }
    }
  };
  rows(0, height, c.bg);
  const top = s.top * s.ratio;
  const bottom = s.bottom * s.ratio;
  rows(0, top, c.bar);
  rows(top, top + 1, c.sep);
  rows(height - bottom, height, c.bar);
  rows(height - bottom, height - bottom + 1, c.sep);
  return { data, width, height };
}
