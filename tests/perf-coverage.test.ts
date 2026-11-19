import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOOPER_TABS } from '../src/shared/main-tabs';
import { PHONE_TABS } from '../src/renderer/src/phone-nav';
import { MAIN_SCREENS, PHONE_SCREENS, PHONES, WINDOWS } from '../scripts/perf/screens.mjs';

const renderer = path.join(__dirname, '..', 'src', 'renderer', 'src');
const main = fs.readFileSync(path.join(renderer, 'main.tsx'), 'utf8');
/** A route with its placeholders filled, as check.mjs fills them. */
const filled = (hash: string) => hash.replace(/\{\w+\}/g, 'id');

describe('the performance check covers every screen (scripts/perf/check.mjs)', () => {
  it('opens every window route main.tsx has', () => {
    const literals = [...main.matchAll(/hash === '([^']+)'/g)].map((m) => m[1]);
    const patterns = [...main.matchAll(/^const \w+Match = \/(.+)\/\.exec\(hash\);$/gm)].map((m) => new RegExp(m[1]));
    expect(literals.length).toBeGreaterThan(15);
    expect(patterns.length).toBeGreaterThan(30);
    const hashes = WINDOWS.map((w) => filled(w.hash));
    for (const l of literals) expect(hashes, `the window at #${l}`).toContain(l);
    for (const p of patterns) expect(hashes.some((h) => p.test(h)), `a window matching ${p}`).toBe(true);
    // The main window, at no route.
    expect(hashes).toContain('');
  });

  it('opens each window at a route main.tsx has, not the main window by mistake', () => {
    const literals = new Set([...main.matchAll(/hash === '([^']+)'/g)].map((m) => m[1]));
    const patterns = [...main.matchAll(/^const \w+Match = \/(.+)\/\.exec\(hash\);$/gm)].map((m) => new RegExp(m[1]));
    for (const w of WINDOWS) {
      const h = filled(w.hash);
      if (h === '') continue;
      expect(literals.has(h) || patterns.some((p) => p.test(h)), `${w.name} (#${w.hash})`).toBe(true);
    }
  });

  it('opens each variant a route spells out: a new item and an existing one, a view and a compare', () => {
    const hashes = WINDOWS.map((w) => w.hash);
    for (const variant of ['/new', '/window', '/report', '/compare', '/view', 'copy-', 'send-guidance/', 'continue-run/']) {
      expect(hashes.some((h) => h.includes(variant)), variant).toBe(true);
    }
  });

  it('shows every main window tab and task tab', () => {
    const tabs = new Set(MAIN_SCREENS.map((s) => s.tab));
    for (const t of LOOPER_TABS) expect(tabs, t.id).toContain(t.id);
    const detail = fs.readFileSync(path.join(renderer, 'components', 'TaskDetail.tsx'), 'utf8');
    const detailTabs = /export type DetailTab = ([^;]+);/.exec(detail)![1].split('|').map((s) => s.trim().replace(/'/g, ''));
    for (const d of detailTabs) expect(MAIN_SCREENS.some((s) => s.detail === d), d).toBe(true);
    expect(MAIN_SCREENS.some((s) => s.addon)).toBe(true);
  });

  it("shows every phone tab and each kind of screen pushed over one, on iOS and Android", () => {
    expect(PHONES).toEqual(['ios', 'android']);
    const names = new Set(PHONE_SCREENS.map((s) => s.tab));
    for (const [, label] of PHONE_TABS) expect(names, label).toContain(label);
    const nav = fs.readFileSync(path.join(renderer, 'phone-nav.ts'), 'utf8');
    const kinds = [...(/export type PhoneScreen =([\s\S]+?);\n/.exec(nav)?.[1] ?? '').matchAll(/kind: '(\w+)'/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(3);
    for (const k of kinds) expect(PHONE_SCREENS.some((s) => s.push === k), k).toBe(true);
  });

  it('names each screen once', () => {
    for (const list of [WINDOWS, MAIN_SCREENS, PHONE_SCREENS]) {
      const names = list.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
