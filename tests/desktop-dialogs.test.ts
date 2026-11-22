import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Dialogs and editors on the desktop, against the Win32 UX guide and Looper's own choices (CLAUDE.md, Windows app
// conventions). scratch/component-audit/tools/desktop.mjs measures the same in the built app.
const SRC = path.join(__dirname, '..', 'src', 'renderer', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const rule = (css: string, selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[2] ?? '';

describe('dialogs on the desktop', () => {
  it('draws field labels semibold (CLAUDE.md: semibold field labels without colons)', () => {
    expect(rule(read('styles.css'), '.field-label')).toMatch(/font-weight: 600;/);
  });

  it('gives a window\'s commit buttons one width, at least 75 px (Win32 Command buttons)', () => {
    const actions = read('components', 'WindowActions.tsx');
    expect(actions).toMatch(/<div className="footer-commit">[\s\S]*btn\('Close'/);
    expect(rule(read('styles.css'), '.footer-commit')).toMatch(/grid-auto-columns: minmax\(75px, 1fr\);/);
  });

  it('sets several choices with check boxes, not buttons that stay pressed (Win32: don\'t use command buttons to set state)', () => {
    const ui = read('components', 'ui.tsx');
    const choices = ui.slice(ui.indexOf('export function CheckboxChoices'));
    expect(choices.slice(0, choices.indexOf('\n}\n'))).toMatch(/<CheckboxField/);
    expect(ui).not.toMatch(/aria-pressed/);
  });

  it('starts the focus on the body\'s first control when the window gave it to nothing else (Win32 dialog boxes)', () => {
    const actions = read('components', 'WindowActions.tsx');
    expect(actions).toMatch(/querySelector\('\.editor-body'\)\?\.querySelector<HTMLElement>\(FIRST_CONTROL\)\?\.focus\(\)/);
  });
});
