import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(new URL(`../src/renderer/src/${p}`, import.meta.url), 'utf8');

describe('TabBar overflow', () => {
  const ui = src('components/ui.tsx');
  const activity = src('components/ActivityPanel.tsx');

  it("offers rows as the iOS overflow choice, next to the pop-up button, inside TabBar", () => {
    expect(ui).toMatch(/overflow\?: 'popup' \| 'sections'/);
    expect(ui).toMatch(/overflowRows = onIos && !sections && overflow === 'sections' && !fits/);
    // Android and the desktop keep what they had: the rows are iOS's.
    expect(ui).toMatch(/const popUp = onIos && !sections && !overflowRows && !fits/);
  });

  it('keeps measuring the segments while the rows show, so they come back when there is room', () => {
    expect(ui).toMatch(/overflowRows && tabs\.length <= SEGMENTS[\s\S]{0,200}probe/);
  });

  it("is what the Activity sheet asks for, without drawing rows or a bar of its own", () => {
    expect(activity).toMatch(/<TabBar[\s\S]*?overflow="sections"/);
    expect(activity).not.toMatch(/tab-sections/);
    expect(activity).not.toMatch(/<NavBar[^>]*back=\{[^}]*setTab/);
  });

  it('is registered with its reason in components.md and ios.md', () => {
    expect(src('components/components.md')).toMatch(/Option `overflow`/);
    expect(src('web/ios.md')).toContain("Tabs that don't fit");
  });
});
