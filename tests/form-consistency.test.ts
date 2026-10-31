import fs from 'node:fs';
import path from 'node:path';
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

  it('uses no other name for a field in any window', () => {
    const files = walk(path.join(__dirname, '..', 'src', 'renderer', 'src')).filter((f) => /\.tsx$/.test(f));
    const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/label="Working folder"|label="Shell environment variables"|label="Timezone"/);
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
    const main = src('main', 'index.ts');
    // Both windows' menus take the keys from the one table.
    expect(main.match(/accelerator: SHORTCUTS\.newChat/g)?.length).toBeGreaterThanOrEqual(2);
    expect(main.match(/accelerator: SHORTCUTS\.newTerminal/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('writes no well-known key, and none of the shared keys, as a literal in a menu', () => {
    const main = src('main', 'index.ts');
    // The literal accelerators of the menu templates and the shared ones the table gives.
    const literals = [...main.matchAll(/accelerator: '([^']+)'/g)].map((m) => m[1]);
    for (const k of WELL_KNOWN_KEYS) expect(literals, k).not.toContain(k);
    for (const k of Object.values(SHORTCUTS)) expect(literals, k).not.toContain(k);
    // Ctrl+P is Print everywhere else: Pause has its own key.
    expect(main).not.toMatch(/Pause[^\n]*CmdOrCtrl\+P/);
  });
});
