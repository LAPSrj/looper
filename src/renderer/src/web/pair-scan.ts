interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

/** Whether this browser can open a camera (it needs a secure context: HTTPS or localhost). */
export const canScan = (): boolean => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/**
 * Reads a QR code from a playing video frame, or null. The browser's own
 * BarcodeDetector where it reads QR codes (Chrome on Android, macOS and ChromeOS;
 * Safari has it only behind a flag), otherwise jsQR, loaded only then.
 */
export async function createQrDecoder(): Promise<(video: HTMLVideoElement) => Promise<string | null>> {
  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (Detector && (await Detector.getSupportedFormats().catch(() => [] as string[])).includes('qr_code')) {
    const detector = new Detector({ formats: ['qr_code'] });
    return async (video) => (await detector.detect(video).catch(() => []))[0]?.rawValue ?? null;
  }
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    if (!ctx || !video.videoWidth) return null;
    const scale = Math.min(1, 640 / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    return jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}
