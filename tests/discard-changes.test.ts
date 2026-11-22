import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discardQuestion, iosAlertButtons, materialDialogButtons } from '../src/renderer/src/web/dialog-flows';
import { Session, type SessionEnv, type ShellMessage } from '../src/renderer/src/web/session';

// An editor's unsaved changes on a phone: Cancel, a swipe down, Back and the backdrop ask before discarding them.
// HIG Sheets: "If people have unsaved changes in the sheet when they begin swiping to dismiss it, use an action sheet to
// let them confirm their action." Material 3 Dialogs: "a basic dialog should appear to confirm that they want to discard
// the unsaved changes." The desktop's Cancel discards without asking (Win32).
const SRC = path.join(__dirname, '..', 'src', 'renderer', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

describe('the question before discarding an editor\'s changes', () => {
  it('is an action sheet\'s buttons on iOS: Discard Changes first and red, Keep Editing last', () => {
    const spec = discardQuestion('ios');
    const { order, row, bold } = iosAlertButtons(spec);
    expect(row).toBe(false);
    expect(order.map((i) => spec.buttons[i])).toEqual(['Discard Changes', 'Keep Editing']);
    expect(spec.destructiveId).toBe(0);
    expect(bold).toBeNull();
  });

  it('is a basic dialog on Android: Keep editing, then Discard at the edge', () => {
    const spec = discardQuestion('android');
    const { order, stacked } = materialDialogButtons(spec);
    expect(stacked).toBe(false);
    expect(order.map((i) => spec.buttons[i])).toEqual(['Keep editing', 'Discard']);
  });

  it('is asked by the shell itself, which answers with the button chosen', async () => {
    const shell: ShellMessage[] = [];
    const env = { wsUrl: 'ws://localhost/api/ws', createSocket: () => ({}), storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, platform: 'ios', fetch: () => Promise.reject(new Error('no network')), visible: () => true };
    const session = new Session(env as unknown as SessionEnv);
    session.onShell((m) => shell.push(m));
    const asked = session.ask('w1', discardQuestion('ios'));
    const dialog = shell.find((m): m is Extract<ShellMessage, { t: 'dialog' }> => m.t === 'dialog');
    expect(dialog?.w).toBe('w1');
    // A second question while the first shows gets its cancel answer.
    expect(await session.ask('w1', discardQuestion('ios'))).toBe(1);
    session.dialogResult(dialog!.dialogId, { kind: 'message', response: 0, checkboxChecked: false });
    expect(await asked).toBe(0);
  });

  it('runs before every way a phone closes an editor with unsaved changes', () => {
    const shell = read('web', 'phone-shell.tsx');
    expect(shell).not.toMatch(/controller\.close\(sc\.win\.w\)\)/);
    expect(shell.match(/closeScreen\(controller, sc\)/g)?.length).toBe(3);
    expect(shell).toMatch(/if \(sc\.nav\?\.unsaved && sc\.nav\.cancel\) sc\.nav\.cancel\.run\(\);/);
    const actions = read('components', 'WindowActions.tsx');
    expect(actions).toMatch(/unsaved \? \(\) => void askDiscard\(\)\.then\(\(discard\) => discard && cancel\(\)\) : cancel/);
  });

  it('is asked by every editor: each window that confirms something says what it edits (draft) or whether it changed', () => {
    // Windows whose fields pick or ask rather than edit (a choice of folder, template or window, a filter, run options).
    const PICKERS = ['FilterApp.tsx', 'SelectWindowApp.tsx', 'BuilderSetupApp.tsx', 'WatchEventsApp.tsx', 'MoveToFolderApp.tsx', 'TemplatePickerApp.tsx', 'RunOptionsApp.tsx', 'MarkdownExportApp.tsx', 'web/DesktopFrame.tsx'];
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx$/.test(e.name) ? [path.join(d, e.name)] : []));
    const missing: string[] = [];
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      if (PICKERS.includes(rel)) continue;
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/<WindowActions\b[\s\S]*?\/>/g)) {
        if (/\b(confirm|wizard)=/.test(m[0]) && !/\b(draft|unsaved)=/.test(m[0])) missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });
});
