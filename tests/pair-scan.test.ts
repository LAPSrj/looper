import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { create } from 'qrcode';
import { codeFromQr } from '../src/renderer/src/web/pair-link';

describe('codeFromQr', () => {
  it('takes the code from a pairing link', () => {
    expect(codeFromQr('https://host.tail1234.ts.net/pair#ABCD2345')).toBe('ABCD2345');
    expect(codeFromQr('http://localhost:49152/pair#ABCD2345')).toBe('ABCD2345');
  });

  it('normalizes case, spaces and dashes', () => {
    expect(codeFromQr('https://h.example/pair#abcd-2345')).toBe('ABCD2345');
    expect(codeFromQr('https://h.example/pair#ABCD%202345')).toBe('ABCD2345');
  });

  it('refuses anything else', () => {
    expect(codeFromQr('ABCD2345')).toBeNull();
    expect(codeFromQr('https://h.example/')).toBeNull();
    expect(codeFromQr('https://h.example/pair')).toBeNull();
    expect(codeFromQr('https://h.example/other#ABCD2345')).toBeNull();
    expect(codeFromQr('https://h.example/pair#%E0%A4%A')).toBeNull();
    expect(codeFromQr('https://h.example/pair#AB$CD')).toBeNull();
  });
});

describe('jsQR on a pairing QR code', () => {
  it('decodes what the Pair Device window draws', () => {
    const link = 'https://host.tail1234.ts.net/pair#ABCD2345';
    const { modules } = create(link, { errorCorrectionLevel: 'M' });
    const scale = 6;
    const quiet = 4;
    const size = (modules.size + quiet * 2) * scale;
    const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const mx = Math.floor(x / scale) - quiet;
        const my = Math.floor(y / scale) - quiet;
        if (mx >= 0 && my >= 0 && mx < modules.size && my < modules.size && modules.get(mx, my)) {
          const i = (y * size + x) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
        }
      }
    }
    const text = jsQR(rgba, size, size)?.data;
    expect(text).toBe(link);
    expect(codeFromQr(text!)).toBe('ABCD2345');
  });
});
