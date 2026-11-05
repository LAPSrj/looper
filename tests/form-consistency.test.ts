import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AGENT_LABELS, agentRows, type AgentField } from '../src/renderer/src/components/agent-fields-model';
import { SHORTCUTS, WELL_KNOWN_KEYS, hint } from '../src/shared/shortcuts';

const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

/** The order every editor shows the agent fields in. */
const ORDER: AgentField[] = ['name', 'cwd', 'environment', 'harness', 'model', 'effort', 'mode', 'permission'];

describe('agent fields', () => {
  const editors = {
    project: { name: true, models: true, mode: true, permission: true },
    helper: { name: true, models: true, mode: false, permission: false },
    builder: { name: false, models: true, mode: false, permission: false },
    // A custom harness has no models, efforts or permission modes.
    customProject: { name: true, models: false, mode: true, permission: false },
  };

  it('shows them in one order in every editor, whichever it leaves out', () => {
    for (const [editor, shown] of Object.entries(editors)) {
      const flat = agentRows(shown).flat();
      expect(flat, editor).toEqual(ORDER.filter((f) => flat.includes(f)));
    }
  });

  it('puts the same fields side by side in every editor', () => {
    expect(agentRows(editors.project)).toEqual([['name'], ['cwd'], ['environment', 'harness'], ['model', 'effort'], ['mode', 'permission']]);
    expect(agentRows(editors.helper)).toEqual([['name'], ['cwd'], ['environment', 'harness'], ['model', 'effort']]);
    expect(agentRows(editors.builder)).toEqual([['cwd'], ['environment', 'harness'], ['model', 'effort']]);
    expect(agentRows(editors.customProject)).toEqual([['name'], ['cwd'], ['environment', 'harness'], ['mode']]);
  });

  it('names each field once', () => {
    expect(Object.values(AGENT_LABELS)).toEqual(['Name', 'Working directory', 'Environment', 'Harness', 'Model', 'Effort', 'Session type', 'Permission mode']);
    expect(new Set(Object.values(AGENT_LABELS)).size).toBe(ORDER.length);
  });

  it('is the only place the project, helper and builder editors draw them', () => {
    for (const file of ['ProjectEditorApp.tsx', 'RemoteEditorApps.tsx', 'BuilderSetupApp.tsx']) {
      const text = src('renderer', 'src', file);
      expect(text, file).toContain('<AgentFields');
      expect(text, file).not.toMatch(/label="(Environment|Harness|Model|Effort|Session type|Permission mode|Working directory)"/);
    }
  });

  it('draws the task editor\'s folder, environment, agent and classifier fields with AgentFields', () => {
    const text = src('renderer', 'src', 'components', 'TaskEditor.tsx');
    expect(text.match(/<AgentFields/g)?.length).toBe(4);
    expect(text).not.toMatch(/label="(Working directory|Environment|Harness|Model|Model id|Effort|Session type|Permission mode)"/);
  });

  it('uses no other name for a field in any window', () => {
    const files = walk(path.join(__dirname, '..', 'src', 'renderer', 'src')).filter((f) => /\.tsx$/.test(f));
    const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/label="Working folder"|label="Shell environment variables"|label="Timezone"/);
  });
});

describe('form elements', () => {
  const renderer = path.join(__dirname, '..', 'src', 'renderer', 'src');
  const files = walk(renderer)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => [path.relative(renderer, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')] as const);
  /** The shared form components draw these; no window writes them by hand. */
  const SHARED = new Set(['components/ui.tsx']);

  it('draws checkboxes, groups under a checkbox, input rows and toggle buttons only through the shared components', () => {
    for (const [file, text] of files) {
      if (SHARED.has(file)) continue;
      expect(text, file).not.toMatch(/className=["{`][^"}`]*\b(checkbox-field|stagger-fields|step-fields|browse-row|input-row|day-toggle|form-group|inline-field|checkbox-note)\b/);
      expect(text, file).not.toMatch(/className="row"/);
      // A label for a control is a Field (a value shown under a caption keeps a span).
      expect(text, file).not.toMatch(/<label className="field(-label)?"/);
    }
  });

  it('draws a form\'s controls with TextInput, TextArea, NumberInput and SelectInput, which set them up for a phone', () => {
    // Message boxes and the browser frames' own dialogs keep their own: Enter sends there, and they have no Field.
    const OWN = new Set(['components/ui.tsx', 'components/Composer.tsx', 'components/MessageBox.tsx', 'components/Transcript.tsx', 'components/AddonPane.tsx', 'BuilderApp.tsx', 'SessionsApp.tsx']);
    for (const [file, text] of files) {
      if (OWN.has(file) || file.startsWith('web/')) continue;
      expect(text, file).not.toMatch(/<(input|textarea|select)\b/);
    }
  });

  it('draws the iOS frame\'s own text cells with IosField', () => {
    for (const [file, text] of files) {
      if (file !== 'web/IosField.tsx') expect(text, file).not.toContain('className="ios-cell ios-field"');
    }
  });

  it('keeps every field of a form in a FormGroup, which an iPhone draws as one card', () => {
    /** What draws a form row; a RadioField outside a group has a header and a card of its own. */
    const ROWS = new Set(['Field', 'NumberField', 'CheckboxField', 'FieldRow', 'StepFields', 'InlineField', 'InputRow', 'AgentFields', 'ActiveHours', 'SourceRows']);
    const tagName = (n: ts.JsxOpeningLikeElement) => n.tagName.getText();
    for (const [file, text] of files) {
      if (!file.endsWith('.tsx')) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const check = (n: ts.Node, inForm: boolean) => {
        let form = inForm;
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
          const open = ts.isJsxElement(n) ? n.openingElement : n;
          if (tagName(open) === 'FormGroup') return;
          if (form) expect(ROWS.has(tagName(open)) ? tagName(open) : '', `${file}: ${tagName(open)} outside a FormGroup`).toBe('');
          const cls = open.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === 'className');
          if (cls && /"form\b/.test(cls.getText())) form = true;
        }
        ts.forEachChild(n, (c) => check(c, form));
      };
      check(source, false);
    }
  });

  it('draws an iPhone form\'s card from its FormGroup, not from fields being next to each other', () => {
    const css = fs.readFileSync(path.join(renderer, 'phone.css'), 'utf8');
    expect(css).not.toMatch(/:is\(\.field, \.checkbox-field\)\s*\+/);
    expect(css).not.toMatch(/:has\(\+ :is\(\.field, \.checkbox-field\)\)/);
    // A row's layout comes from Field (field-one-line), not from a look at its children.
    expect(css).not.toMatch(/\.field:has\(/);
  });

  it('draws a list\'s buttons with ListButton, which a phone turns into rows or leaves to the row\'s menu', () => {
    for (const [file, text] of files) {
      if (file === 'components/SelectList.tsx') continue;
      for (const [block] of text.matchAll(/<ListActions\b[\s\S]*?<\/ListActions>/g)) {
        expect(block, file).not.toMatch(/<button\b/);
      }
    }
  });

  it('gives a list that has row commands no way to skip them on a phone: the row\'s menu holds what its selection buttons do', () => {
    for (const [file, text] of files) {
      if (!/<ListButton\s+row\b/.test(text)) continue;
      expect(text, `${file}: a row button with no menu`).toMatch(/\bmenu=\{/);
    }
  });

  it('draws an iPhone form\'s values in one color and size, from the shared row metrics', () => {
    const css = fs.readFileSync(path.join(renderer, 'phone.css'), 'utf8');
    expect(css).toMatch(/\.form-group \.input-suffix \.suffix \{[^}]*color: var\(--pg-label-2\);[^}]*font-size: calc\(17 \* var\(--u\)\);/);
    expect(css).toMatch(/\.select-value \{[^}]*color: var\(--pg-label-2\);/);
    expect(css).toMatch(/\.pg-row \{\s*position: relative;\s*min-height: var\(--pg-row-min\);\s*padding: var\(--pg-row-y\) 16px;/);
    expect(css).not.toMatch(/\.env-(list|item)\b/);
  });

  it('keeps no styles for the hand-written versions', () => {
    for (const sheet of ['styles.css', 'phone.css', 'web/desktop-device.css']) {
      const css = fs.readFileSync(path.join(renderer, sheet), 'utf8');
      expect(css, sheet).not.toMatch(/\.(stagger-fields|browse-row|addon-file|radio-list)\b/);
    }
  });

  it('shows an editor window\'s Loading… and "no longer exists" through EmptyWindow', () => {
    for (const [file, text] of files) {
      expect(text, file).not.toMatch(/className="empty">This [^<]*no longer/);
      // A window with window actions is a form window (panes keep their own Loading… text).
      if (/<WindowActions\b/.test(text) && !SHARED.has(file)) expect(text, file).not.toMatch(/className="empty">Loading…/);
    }
  });

  it('draws every window\'s footer buttons through WindowActions', () => {
    for (const [file, text] of files) expect(text, file).not.toMatch(/\b(EditorFooter|CloseFooter|DialogFooter)\b/);
  });

  it('writes the footer row by hand only in WindowActions, the browser frame\'s message box and the pairing page', () => {
    // The message box keeps Electron's own button list; the pairing page shows before any window.
    const HAND = new Set(['components/WindowActions.tsx', 'web/DesktopFrame.tsx', 'web/PairPage.tsx']);
    for (const [file, text] of files) {
      if (!HAND.has(file)) expect(text, file).not.toContain('className="editor-footer"');
    }
  });

  it('leaves Esc and Enter to WindowActions: no other useDialogKeys call passes onSave or onCancel', () => {
    const OWN = new Set(['components/WindowActions.tsx']);
    for (const [file, text] of files) {
      if (OWN.has(file)) continue;
      for (const [call] of text.matchAll(/useDialogKeys\s*(?:<[^>]*>)?\(\{[\s\S]*?\}\)/g)) {
        expect(call, file).not.toMatch(/\b(onSave|onCancel)\b/);
      }
    }
  });

  it('has one short random id helper', () => {
    for (const [file, text] of files) {
      if (file === 'rid.ts') continue;
      expect(text, file).not.toContain('Math.random().toString(36)');
    }
  });
});

describe('shortcuts', () => {
  it('gives each shared command its own key, none of them a well-known one', () => {
    const keys = Object.values(SHORTCUTS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(WELL_KNOWN_KEYS as readonly string[]).not.toContain(k);
    expect(hint(SHORTCUTS.newTerminal)).toBe('Ctrl+Shift+T');
  });

  it('keeps New Chat on Ctrl+T and New Terminal on Ctrl+Shift+T in the main window and the Chats window', () => {
    expect(SHORTCUTS.newChat).toBe('CmdOrCtrl+T');
    expect(SHORTCUTS.newTerminal).toBe('CmdOrCtrl+Shift+T');
    // The menus of both windows (index.ts, and the Chats commands' catalog) take the keys from the one table.
    const main = src('main', 'index.ts') + src('shared', 'commands', 'chat.ts');
    expect(main.match(/accelerator: SHORTCUTS\.newChat/g)?.length).toBeGreaterThanOrEqual(2);
    expect(main.match(/accelerator: SHORTCUTS\.newTerminal/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('writes no well-known key, and none of the shared keys, as a literal in a menu', () => {
    const main = ['index.ts', 'file-menu.ts'].map((f) => src('main', f)).join('') + ['chat.ts', 'task.ts', 'project.ts'].map((f) => src('shared', 'commands', f)).join('');
    // The literal accelerators of the menu templates and the shared ones the table gives.
    const literals = [...main.matchAll(/accelerator: '([^']+)'/g)].map((m) => m[1]);
    for (const k of WELL_KNOWN_KEYS) expect(literals, k).not.toContain(k);
    for (const k of Object.values(SHORTCUTS)) expect(literals, k).not.toContain(k);
    // Ctrl+P is Print everywhere else: Pause has its own key.
    expect(main).not.toMatch(/Pause[^\n]*CmdOrCtrl\+P/);
  });
});
