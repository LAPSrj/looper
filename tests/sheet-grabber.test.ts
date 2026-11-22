import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextDetent } from '../src/renderer/src/components/phone/sheet-detents';

// ios.md, Sheets: "Include a grabber in a resizable sheet. A grabber shows people that they can drag the sheet to resize
// it; they can also tap it to cycle through the detents" (HIG Sheets). npm run ui-check measures the same in the built app.
const SRC = path.join(__dirname, '..', 'src', 'renderer', 'src');
const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx$/.test(e.name) ? [path.join(d, e.name)] : []));

describe('a sheet’s grabber', () => {
  it('is drawn only by PhoneSheet, the one sheet with two heights', () => {
    const drawing = walk(SRC)
      .filter((f) => /className=\{?[`'"][^`'"]*grabber/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f).replace(/\\/g, '/'));
    expect(drawing).toEqual(['components/phone/PhoneSheet.tsx']);
    const sheet = fs.readFileSync(path.join(SRC, 'components', 'phone', 'PhoneSheet.tsx'), 'utf8');
    expect(sheet).toMatch(/data-detents="medium large"/);
  });

  it('is a labeled button that says whether the sheet is at its large height', () => {
    const sheet = fs.readFileSync(path.join(SRC, 'components', 'phone', 'PhoneSheet.tsx'), 'utf8');
    const grabber = sheet.match(/<(\w+)\s[^>]*className="pg-sheet-grabber"[^>]*>/s)?.[0] ?? '';
    expect(grabber.startsWith('<button')).toBe(true);
    expect(grabber).toMatch(/aria-label=/);
    expect(grabber).toMatch(/aria-expanded=\{detent === 'large'\}/);
    // The handle's drag doesn't skip it, so dragging from the grabber still resizes the sheet.
    expect(sheet).toMatch(/skip: 'button:not\(\.pg-sheet-grabber\)'/);
  });

  it('moves the sheet to its other height on a tap', () => {
    expect(nextDetent('medium')).toBe('large');
    expect(nextDetent('large')).toBe('medium');
  });
});
