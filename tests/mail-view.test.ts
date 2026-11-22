import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe("Now's message view is Gmail's on every device, on a white page", () => {
  const panel = read('src/renderer/src/components/ActivityPanel.tsx');
  const css = read('src/renderer/src/styles.css');
  const phone = read('src/renderer/src/phone.css');

  it('marks the body of a message so it gets the white page', () => {
    expect(panel).toContain('now-body-mail');
    expect(css).toMatch(/\.now-body\.now-body-mail \{[^}]*background: #fff;/);
  });

  it("has Gmail's dark surface in the dark theme", () => {
    expect(css).toMatch(/prefers-color-scheme: dark\) \{\s*\.now-body\.now-body-mail \{[^}]*background: #131314;/);
  });

  it('words a message as Gmail does on iOS too: "(no subject)" and "to"', () => {
    expect(panel).not.toContain('No Subject');
    expect(panel).not.toContain("'To: '");
  });

  it("doesn't repeat the thread's subject in a reply, and sets a reply heading's weight once", () => {
    expect(panel).not.toContain('Re: ${');
    const weights = [...phone.matchAll(/\.now-mail-subject[^{]*\{[^}]*font-weight/g)];
    expect(weights).toHaveLength(0);
  });

  it("keeps iOS Mail's hairlines out of the layout", () => {
    expect(phone).not.toMatch(/data-platform='ios'\] \.now-mail[^{]*\{[^}]*border-bottom/);
  });
});
