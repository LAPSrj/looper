import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { barModel, dismissFor, type Dismiss } from '../src/renderer/src/web/nav-bar-model';

const noop = () => {};
const close: Dismiss = { kind: 'close', run: noop };
const back: Dismiss = { kind: 'back', run: noop };

describe('a bar’s buttons (barModel)', () => {
  it('leads with the page’s Back, else its Cancel, else the container’s own Back or Close', () => {
    expect(barModel({ title: 't', back: noop, cancel: { run: noop }, dismiss: close }).lead?.kind).toBe('back');
    expect(barModel({ title: 't', cancel: { run: noop }, dismiss: back }).lead).toMatchObject({ kind: 'cancel', label: 'Cancel' });
    expect(barModel({ title: 't', dismiss: back }).lead).toMatchObject({ kind: 'back', label: 'Back' });
    expect(barModel({ title: 't', dismiss: close }).lead).toMatchObject({ kind: 'close', label: 'Close' });
    expect(barModel({ title: 't', dismiss: null }).lead).toBeNull();
    expect(barModel({ title: 't', dismiss: null, menu: noop }).lead?.kind).toBe('menu');
    expect(barModel({ title: 't', back: noop, dismiss: null, menu: noop }).lead?.kind).toBe('back');
  });

  it('keeps Cancel’s own label and state, and runs its handler', () => {
    let ran = false;
    const lead = barModel({ title: 't', cancel: { label: 'Discard', disabled: true, run: () => (ran = true) }, dismiss: close }).lead;
    expect(lead).toMatchObject({ kind: 'cancel', label: 'Discard', disabled: true });
    lead?.run();
    expect(ran).toBe(true);
  });

  it('gives Confirm its label (Save when it has none), and strips Electron’s &-mnemonics', () => {
    expect(barModel({ title: '&File', confirm: { run: noop }, dismiss: null })).toMatchObject({ title: 'File', confirm: { label: 'Save' } });
    expect(barModel({ title: 't', confirm: { label: '&Create', disabled: true, run: noop }, dismiss: null }).confirm).toMatchObject({ label: 'Create', disabled: true });
    expect(barModel({ title: 't', dismiss: null }).confirm).toBeNull();
  });
});

describe('what closes a container (dismissFor)', () => {
  const run = { back: () => 'back', close: () => 'close' };
  it('goes back from a pushed screen, closes a sheet or dialog, and has no button on the root or a bottom sheet', () => {
    expect(dismissFor('push', run)?.kind).toBe('back');
    for (const p of ['page-sheet', 'form-sheet', 'full-dialog', 'dialog'] as const) expect(dismissFor(p, run)?.kind, p).toBe('close');
    expect(dismissFor('root', run)).toBeNull();
    expect(dismissFor('bottom-sheet', run)).toBeNull();
  });
});

const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', ...p), 'utf8');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe('one bar component', () => {
  it('is the only caller of usePageNav: a screen reports its bar with NavBar', () => {
    const root = path.join(__dirname, '..', 'src', 'renderer', 'src');
    const callers = walk(root)
      .filter((f) => /\.tsx?$/.test(f) && fs.readFileSync(f, 'utf8').includes('usePageNav('))
      .map((f) => path.relative(root, f).replaceAll('\\', '/'));
    expect(callers.sort()).toEqual(['components/NavBar.tsx', 'web/page-nav.ts']);
  });

  it('draws every bar row through NavBarRow: the frames, their own sheets and a page’s sheet write none by hand', () => {
    for (const file of [['web', 'IosFrame.tsx'], ['web', 'AndroidFrame.tsx'], ['components', 'phone', 'PhoneSheet.tsx']]) {
      const text = src(...file);
      expect(text, file.join('/')).not.toMatch(/className="(ios-bar-row|md-bar-row)/);
    }
    expect(src('components', 'phone', 'PhoneSheet.tsx')).toContain('<NavBar');
  });
});
