import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A switch row and a segmented control on phones, measured by npm run ui-check and scratch/component-audit/tools.
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'phone.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[2] ?? '';

describe('phone switch rows and segmented controls', () => {
  it('makes an iPhone switch row 52 high: the 28-high switch with 12 above and below (ios.md: Lists, Switch)', () => {
    expect(css).toMatch(/--pg-row-min: 52px;/);
    expect(rule("html.phone-window[data-platform='ios'] .form-group .checkbox-field")).toMatch(/padding-block: 12px;/);
  });

  it('makes an Android switch row a one-line list item, 56 dp with no gap between rows (Material 3 Lists)', () => {
    const android = rule("html.phone-window[data-platform='android'] .checkbox-field");
    expect(android).toMatch(/min-height: 56px;/);
    expect(android).toMatch(/margin: 0;/);
  });

  it('draws an iOS segmented control\'s labels 13.33/18 (ios.md: Segmented control)', () => {
    const seg = rule("html.phone-window[data-platform='ios'] .pg-segmented button");
    expect(seg).toMatch(/font-size: 13\.33px;/);
    expect(seg).toMatch(/line-height: 18px;/);
  });
});
