import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { termTheme } from '../src/renderer/src/components/term-theme';

const src = path.join(__dirname, '..', 'src', 'renderer', 'src');
const read = (file: string) => fs.readFileSync(path.join(src, file), 'utf8');
const css = read('styles.css');

/** Every .tsx file under the renderer, as [relative path, text]. */
function tsxFiles(dir = src): [string, string][] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith('.tsx') ? [[path.relative(src, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8')] as [string, string]] : [];
  });
}

/** The body of the first rule whose selector line is exactly `selector`. */
function rule(selector: string): string {
  const found = css.indexOf(`\n${selector} {`);
  expect(found, `${selector} rule`).toBeGreaterThanOrEqual(0);
  const start = found + 1;
  return css.slice(start, css.indexOf('}', start));
}

describe('focus ring', () => {
  it('never falls back to the browser default (the orange ring)', () => {
    for (const file of ['styles.css', 'phone.css']) {
      const text = read(file);
      expect(text, file).not.toMatch(/outline:\s*(auto|-webkit-focus-ring-color)/);
      expect(text, file).not.toMatch(/-webkit-focus-ring-color/);
    }
  });

  it('is Looper\'s accent on anything focusable', () => {
    expect(rule(':where(:focus-visible)')).toMatch(/outline:\s*2px solid var\(--accent\)/);
  });

  it('stays visible on a checkbox: only text-like inputs turn their outline off', () => {
    expect(css).not.toMatch(/\.field input:focus/);
    expect(css).toContain(".field input:where(:not([type='checkbox'], [type='radio'])):focus");
  });
});

describe('native controls', () => {
  it('keeps the system checkboxes, radios, drop-down arrows, number spinners and date fields on desktop', () => {
    expect(css).not.toMatch(/html:not\(\.phone-window\) (input|select)/);
    expect(rule('.checkbox-field input[type="checkbox"],\n.checkbox-field input[type="radio"]')).toContain('width: auto');
  });

  it('styles disclosure triangles by element', () => {
    expect(rule('summary')).toContain('list-style: none');
    expect(css).toContain('summary::-webkit-details-marker');
  });

  it('gives the text controls outside a .field the text-box look', () => {
    const box = css.slice(css.indexOf('.field input:where(:not('), css.indexOf('}', css.indexOf('.field input:where(:not(')));
    expect(box).toContain('.send-sessions-text');
    expect(box).toContain('.pair-source');
  });

  it('shares the chevron path between the icons module and the disclosure triangle', () => {
    const icons = read('components/icons.tsx');
    const path = /CHEVRON_PATH = '([^']+)'/.exec(icons)?.[1];
    expect(path).toBeTruthy();
    expect(css).toContain(`d='${path}'`);
  });

  it('keeps the system disabled look for form fields: only a text box fades, and a group under its checkbox', () => {
    const token = /--disabled-opacity:\s*([\d.]+)/.exec(css)?.[1];
    expect(token).toBeTruthy();
    expect(rule('.btn:disabled')).toContain('opacity: var(--disabled-opacity)');
    expect(rule('.field input:disabled')).toContain('opacity: 0.55');
    // StepFields draws every group under a checkbox, stacked or in a row (Settings' stagger delays): one rule fades them.
    expect(rule('.step-fields.disabled')).toContain('opacity: 0.4');
    expect(rule('fieldset.step-fields.step-row')).toContain('display: flex');
    expect(css).not.toContain(':is(input, select, textarea):disabled');
    expect(css).not.toContain('> .field-label {\n  opacity');
  });

  it('phone switches are not text fields (the toggles are left out of the text-box rules)', () => {
    const phone = read('phone.css');
    expect(phone).not.toMatch(/\.field input,/);
    expect(phone).not.toMatch(/\.field input:focus,/);
  });
});

describe('tokens', () => {
  it('defines the radii, type sizes, shadows, layers, control height and terminal palette on :root', () => {
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    for (const name of [
      '--radius-control',
      '--radius-overlay',
      '--font-caption',
      '--font-body',
      '--shadow-flyout',
      '--shadow-dialog',
      '--z-menu',
      '--z-modal',
      '--z-toast',
      '--control-height',
      '--term-bg',
      '--term-fg',
      '--term-muted',
      '--term-prompt',
    ]) {
      expect(root, name).toContain(`${name}:`);
    }
  });

  it('uses them instead of one-off values', () => {
    expect(css).not.toMatch(/border-radius:\s*(3|6|10)px/);
    expect(css).not.toMatch(/font-size:\s*(11\.5|12\.5)px/);
    expect(css).not.toMatch(/box-shadow:\s*0 -?\d+px \d+px rgba/);
    expect(css).not.toMatch(/z-index:\s*[2-5]000/);
    // The terminal's palette is written once, in :root.
    for (const hex of ['#0f1115', '#d7dae0', '#8b919c', '#4cc38a']) {
      expect(css.split(hex).length - 1, hex).toBeLessThanOrEqual(2);
    }
  });

  it('has no badge styles (status is plain text)', () => {
    expect(css).not.toMatch(/\.badge/);
  });

  it('uses white-on-accent text only through --accent-fg', () => {
    expect(rule('::highlight(chat-find-current)')).toContain('color: var(--accent-fg)');
    expect(rule('.ws-msg-icon')).toContain('color: var(--accent-fg)');
  });
});

describe('buttons and the terminal', () => {
  it('makes a button as tall as a field, and a small one shorter', () => {
    expect(css).toMatch(/--control-height:\s*32px/);
    expect(rule('.btn')).toContain('min-height: var(--control-height)');
    expect(rule('.btn.small')).toMatch(/height: 24px/);
    expect(css).toMatch(/\.field input:where\(:not\(\[type='checkbox'\], \[type='radio'\]\)\),\n\.field select,\n\.pair-source \{\n\s+height: var\(--control-height\)/);
  });

  it('draws the terminal scrollbar dark', () => {
    expect(rule('.terminal')).toContain('color-scheme: dark');
  });

  it('reads xterm\'s colors from the --term tokens', () => {
    const tokens: Record<string, string> = { '--term-bg': ' #111 ', '--term-fg': '#eee', '--term-selection': '#333' };
    expect(termTheme((t) => tokens[t] ?? '')).toEqual({ background: '#111', foreground: '#eee', cursor: '#eee', selectionBackground: '#333' });
    expect(termTheme(() => '').background).toBe('#0f1115');
  });
});

describe('group headers and chevrons', () => {
  const files = tsxFiles();

  it('every group header is a GroupHeader', () => {
    for (const [file, text] of files) {
      if (file === 'components/GroupHeader.tsx') continue;
      // The classes only GroupHeader's callers pass along, and the old hand-written headers.
      if (/task-folder|session-group|group-header/.test(text)) {
        expect(text, file).toContain("from './GroupHeader'");
        expect(text, file).not.toMatch(/task-folder-name|session-group-name|task-folder-count|session-group-count/);
      }
    }
  });

  it('draws the folder chevron only in the icons module', () => {
    for (const [file, text] of files) {
      if (file === 'components/icons.tsx') continue;
      expect(text, file).not.toContain('M3.5 1.5');
    }
  });

  it('the task and project lists are a tree: folders and items are tree items with a level', () => {
    // Both lists draw the shared FolderTree.
    expect(read('components/TaskList.tsx')).toContain('<FolderTree');
    expect(read('components/ProjectList.tsx')).toContain('<FolderTree');
    const list = read('components/FolderTree.tsx');
    expect(list).toContain("role={showFolders ? 'tree' : 'listbox'}");
    expect(list).toContain("role={showFolders ? 'treeitem' : 'option'}");
    expect(list).toContain('aria-level={showFolders ? depth + 1 : undefined}');
    expect(list).toContain('level={depth + 1}');
    // GroupHeader itself says treeitem, expanded and level; outside a tree (a phone's plain list) it is a button.
    const header = read('components/GroupHeader.tsx');
    expect(header).toContain("role={inTree ? 'treeitem' : 'button'}");
    expect(header).toContain('aria-expanded={open}');
    expect(header).toContain('aria-level={inTree ? level : undefined}');
  });
});
