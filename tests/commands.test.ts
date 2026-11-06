import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandMenu, commandMenuItem } from '../src/main/command-menu';
import { serializeMenu } from '../src/main/platform/menus';
import { projectMenuItems } from '../src/main/project-menu';
import { taskContextMenuItems } from '../src/main/task-menu';
import { CHAT_COMMANDS, CHAT_MORE_GROUPS } from '../src/shared/commands/chat';
import { PROJECT_COMMANDS } from '../src/shared/commands/project';
import { TASK_COMMANDS, TASK_MORE_GROUPS } from '../src/shared/commands/task';
import { plainLabel, type Catalog, type Command } from '../src/shared/commands/types';
import { showsOn } from '../src/shared/ui-platform';
import { commandToolbar, type ToolbarItem } from '../src/renderer/src/components/toolbar-model';
import { composeMore } from '../src/renderer/src/web/more-menu';

type Item = Electron.MenuItemConstructorOptions;

const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
/** The source from `start` to the end of its block (the first line that is `end`). */
const block = (text: string, start: string, end = '\n}\n'): string => {
  const at = text.indexOf(start);
  expect(at, start).toBeGreaterThanOrEqual(0);
  return text.slice(at, text.indexOf(end, at));
};

/** The catalogs, with the More menu groups of the screens that list them. */
const CATALOGS: [string, Catalog, readonly string[]][] = [
  ['chat', CHAT_COMMANDS, CHAT_MORE_GROUPS],
  ['task', TASK_COMMANDS, TASK_MORE_GROUPS],
  ['project', PROJECT_COMMANDS, TASK_MORE_GROUPS],
];

const shape = (items: Item[]) =>
  items.map((i) => (i.type === 'separator' ? '-' : [i.id, i.label, i.accelerator, i.glyph, i.platforms, i.registerAccelerator]));

describe('the command catalogs', () => {
  it('place every command on a phone, or hide it with a reason', () => {
    for (const [name, catalog, groups] of CATALOGS) {
      for (const [key, c] of Object.entries(catalog)) {
        const where = `${name}.${key}`;
        expect(c.menu || c.toolbar, `${where} has a menu item or a toolbar button`).toBeTruthy();
        if ('hidden' in c.mobile) expect(c.mobile.hidden.trim().length, `${where}'s reason`).toBeGreaterThan(10);
        else {
          expect(groups, where).toContain(c.mobile.group);
          // A command the platform marks keep off a phone says so with a reason, not a group.
          expect(showsOn(c.platforms, 'mobile'), `${where} is placed on a phone but marked off it`).toBe(true);
        }
      }
    }
  });

  it('give each menu item and toolbar button one id', () => {
    for (const [name, catalog] of CATALOGS) {
      const menus = Object.values(catalog).flatMap((c) => (c.menu ? [c.menu.id] : []));
      const buttons = Object.values(catalog).flatMap((c) => (c.toolbar ? [c.toolbar.id] : []));
      expect(new Set(menus).size, name).toBe(menus.length);
      expect(new Set(buttons).size, name).toBe(buttons.length);
    }
  });

  it('mark what destroys or cuts something off', () => {
    const marked = CATALOGS.flatMap(([name, catalog]) => Object.entries(catalog).flatMap(([key, c]) => (c.destructive ? [`${name}.${key}`] : [])));
    expect(marked).toEqual(['chat.close', 'chat.stop', 'chat.closeAll', 'task.stop', 'task.noteClear', 'task.clearRuns', 'task.delete', 'project.delete']);
  });
});

describe('menus built from the catalogs', () => {
  it('build the Task menu as it was: labels, keys, glyphs, separators and the second states', () => {
    const b = { click: () => {} };
    const menu = (alt: boolean) =>
      commandMenu(TASK_COMMANDS, 'task', {
        runNow: b,
        stop: b,
        pauseResume: { ...b, alt },
        enableDisable: { ...b, alt },
        complete: { ...b, alt },
        edit: b,
        editAgent: b,
        versions: b,
        delete: b,
        note: { ...b, alt },
        noteClear: b,
        moveFolder: b,
        clearRuns: b,
        workFolder: b,
      });
    expect(shape(menu(false))).toEqual([
      ['task-run-now', '&Run Now', 'F5', 'run', undefined, undefined],
      ['task-stop', '&Stop Task', 'Shift+F5', 'stop', undefined, undefined],
      ['task-pause-resume', '&Pause', 'F7', 'pause', undefined, undefined],
      ['task-enable-disable', '&Disable', undefined, 'power', undefined, undefined],
      ['task-complete', 'C&omplete', undefined, 'complete', undefined, undefined],
      ['task-edit', '&Edit Task…', 'CmdOrCtrl+E', 'edit', undefined, undefined],
      ['task-edit-agent', 'Edit with &Agent…', undefined, undefined, undefined, undefined],
      ['task-versions', '&Version History', undefined, undefined, undefined, undefined],
      ['task-delete', 'De&lete Task', undefined, 'delete', undefined, undefined],
      '-',
      ['task-note', 'Add &Guidance for Next Run…', undefined, 'guidance', undefined, undefined],
      ['task-note-clear', 'Clear Guidance', undefined, undefined, undefined, undefined],
      '-',
      ['task-move-folder', 'Move to &Folder…', undefined, 'folder', undefined, undefined],
      ['task-clear-runs', 'Clear Run &History…', undefined, undefined, undefined, undefined],
      '-',
      ['task-work-folder', 'Open &Working Directory', undefined, undefined, undefined, undefined],
    ]);
    const other = menu(true);
    expect(other.filter((i) => i.type !== 'separator').map((i) => [i.label, i.glyph]).filter((_x, n) => [2, 3, 4, 9].includes(n))).toEqual([
      ['&Resume', 'resume'],
      ['E&nable', 'power'],
      ['Re&open', 'complete'],
      ['Edit &Guidance for Next Run…', 'guidance'],
    ]);
    expect(menu(false).find((i) => i.id === 'task-delete')!.destructive).toBe(true);
  });

  it('build the Chat menu, the Chats window’s File items and Find as they were', () => {
    const b = { click: () => {} };
    const chat = commandMenu(CHAT_COMMANDS, 'chat', {
      stop: b,
      sendNow: b,
      restart: b,
      harness: { submenu: [] },
      model: { submenu: [] },
      effort: { submenu: [] },
      permissionMode: { submenu: [] },
      compact: b,
      rename: b,
      autoContinue: { ...b, checked: true },
      copySessionId: b,
    });
    expect(chat.find((i) => i.id === 'chat-auto-continue')).toMatchObject({ type: 'checkbox', checked: true });
    expect(shape(chat)).toEqual([
      ['chat-stop', '&Stop', 'Esc', 'stopChat', undefined, false],
      ['chat-send-now', 'Send &Now', 'CmdOrCtrl+Enter', 'sendNow', undefined, undefined],
      ['chat-restart', '&Restart Agent', undefined, 'restartAgent', undefined, undefined],
      '-',
      ['chat-harness', '&Harness', undefined, undefined, undefined, undefined],
      ['chat-model', '&Model', undefined, undefined, undefined, undefined],
      ['chat-effort', '&Effort', undefined, undefined, undefined, undefined],
      ['chat-permission-mode', '&Permission Mode', undefined, undefined, undefined, undefined],
      '-',
      ['chat-compact', '&Compact into New Chat', undefined, 'compact', undefined, undefined],
      ['chat-rename', 'Ren&ame…', 'F2', undefined, undefined, false],
      ['chat-auto-continue', 'Continue &When Limit Resets', undefined, undefined, undefined, undefined],
      ['chat-copy-session-id', 'Copy Session &ID', undefined, 'copy', undefined, undefined],
    ]);
    const file = (single: boolean) =>
      commandMenu(CHAT_COMMANDS, 'file', {
        attach: b,
        saveMarkdown: b,
        openInNewWindow: single ? null : b,
        openWorkFolder: b,
        sendToChats: single ? null : b,
        close: b,
        closeAll: single ? null : b,
      });
    expect(shape(file(false))).toEqual([
      ['chat-attach', '&Attach Files…', 'CmdOrCtrl+O', 'attach', undefined, undefined],
      ['chat-save-markdown', '&Save as Markdown…', 'CmdOrCtrl+S', undefined, undefined, undefined],
      '-',
      ['chat-open-window', 'Open in &New Window', undefined, undefined, ['desktop', 'web'], undefined],
      ['chat-work-folder', 'Open &Working Directory', undefined, undefined, undefined, undefined],
      ['chat-send-to-chats', 'Send to C&hats…', undefined, 'bullhorn', undefined, undefined],
      '-',
      ['chat-close', 'Close C&onversation', 'CmdOrCtrl+W', 'closeChat', undefined, false],
      ['chat-close-all', 'Close A&ll Conversations', undefined, undefined, undefined, undefined],
    ]);
    // A single chat's window: only what is about its chat.
    expect(file(true).map((i) => i.id ?? '-')).toEqual(['chat-attach', 'chat-save-markdown', '-', 'chat-work-folder', '-', 'chat-close']);
    expect(shape(commandMenu(CHAT_COMMANDS, 'edit', { find: b }))).toEqual([['chat-find', '&Find…', 'CmdOrCtrl+F', 'search', undefined, undefined]]);
  });

  it('build the task’s context menu from the catalog, in its own order, with the Task menu’s items', () => {
    const info = { enabled: true, completed: false, allowComplete: true, state: 'idle', held: false, hasNote: false };
    const sent: string[] = [];
    const items = taskContextMenuItems(info, (type) => sent.push(type));
    expect(shape(items)).toEqual([
      ['task-run-now', '&Run Now', 'F5', 'run', undefined, undefined],
      ['task-stop', '&Stop Task', 'Shift+F5', 'stop', undefined, undefined],
      ['task-pause-resume', '&Pause', 'F7', 'pause', undefined, undefined],
      ['task-enable-disable', '&Disable', undefined, 'power', undefined, undefined],
      ['task-complete', 'C&omplete', undefined, 'complete', undefined, undefined],
      ['task-edit', '&Edit Task…', 'CmdOrCtrl+E', 'edit', undefined, undefined],
      ['task-edit-agent', 'Edit with &Agent…', undefined, undefined, undefined, undefined],
      ['task-versions', '&Version History', undefined, undefined, undefined, undefined],
      ['task-delete', 'De&lete Task', undefined, 'delete', undefined, undefined],
      '-',
      ['task-note', 'Add &Guidance for Next Run…', undefined, 'guidance', undefined, undefined],
      ['task-note-clear', 'Clear Guidance', undefined, undefined, undefined, undefined],
      '-',
      ['task-move-folder', 'Move to &Folder…', undefined, 'folder', undefined, undefined],
      ['task-clear-runs', 'Clear Run &History…', undefined, undefined, undefined, undefined],
      '-',
      [undefined, 'Open Project in Terminal', undefined, undefined, undefined, undefined],
      [undefined, 'Open Project in Chat', undefined, undefined, undefined, undefined],
      ['task-work-folder', 'Open &Working Directory', undefined, undefined, undefined, undefined],
    ]);
    // Each catalog command's item is the Task menu's, its destructive mark included; only the project's two are the menu's own.
    const byId = new Map<string, Command>(Object.values(TASK_COMMANDS).map((c) => [c.menu.id, c]));
    for (const it of items.filter((i) => i.id)) expect(it.destructive, it.id).toBe(byId.get(it.id!)!.destructive);
    expect(items.filter((i) => i.destructive).map((i) => i.id)).toEqual(['task-stop', 'task-delete', 'task-note-clear', 'task-clear-runs']);
    expect(items.filter((i) => i.type !== 'separator' && !i.id).map((i) => i.label)).toEqual(['Open Project in Terminal', 'Open Project in Chat']);
    // The enabled rules: idle, with nothing to clear.
    expect(items.filter((i) => i.enabled === false).map((i) => i.id)).toEqual(['task-stop', 'task-note-clear']);
    for (const it of items) (it.click as (() => void) | undefined)?.();
    expect(sent).toEqual([
      'run-now', 'stop-task', 'pause-resume', 'enable-disable', 'complete-reopen', 'edit-task', 'edit-with-agent', 'version-history', 'delete-task',
      'edit-note', 'clear-note', 'move-to-folder', 'clear-runs', 'open-terminal', 'open-chat', 'open-work-folder',
    ]);
    // The second states, and a running task at its cap of runs.
    const other = taskContextMenuItems({ ...info, enabled: false, completed: true, state: 'paused', hasNote: true }, () => {});
    expect(other.filter((i) => ['task-pause-resume', 'task-enable-disable', 'task-complete', 'task-note'].includes(i.id ?? '')).map((i) => [i.label, i.glyph])).toEqual([
      ['&Resume', 'resume'],
      ['E&nable', 'power'],
      ['Re&open', 'complete'],
      ['Edit &Guidance for Next Run…', 'guidance'],
    ]);
    const running = taskContextMenuItems({ ...info, state: 'running', activeRuns: 1, maxRuns: 1 }, () => {});
    expect(running.filter((i) => i.enabled === false).map((i) => i.id)).toEqual(['task-run-now', 'task-note-clear', 'task-clear-runs']);
  });

  it('names the shown project in a label the binding gives', () => {
    expect(commandMenuItem(CHAT_COMMANDS.newChatInProject, { label: 'Chat in Web app' }).label).toBe('Chat in Web app');
    expect(commandMenuItem(CHAT_COMMANDS.newChatInProject, {}).label).toBe('Chat in Project');
  });

  it('builds the Project menu as it was, with a separator after New Terminal', () => {
    expect(shape(projectMenuItems(() => {}))).toEqual([
      ['project-new-task', 'New &Task…', undefined, 'newTask', undefined, undefined],
      ['project-new-chat', 'New &Chat', undefined, 'newChat', undefined, undefined],
      ['project-new-terminal', 'New Ter&minal', undefined, 'terminal', undefined, undefined],
      '-',
      ['project-edit', '&Edit Project…', undefined, 'edit', undefined, undefined],
      ['project-folder', 'Open &Folder', undefined, undefined, undefined, undefined],
      ['project-delete', '&Delete Project…', undefined, 'delete', undefined, undefined],
    ]);
  });

  it('sends the destructive mark to the phone with the menu', () => {
    const item = commandMenuItem(TASK_COMMANDS.delete, {});
    const { items } = serializeMenu({ items: [{ ...item, submenu: null }] as never });
    expect(items[0]).toMatchObject({ key: 'task-delete', label: 'Delete Task', icon: 'delete', destructive: true });
  });

  it('fails the typecheck when a menu or toolbar command has no binding', () => {
    // @ts-expect-error: the Edit menu's Find has no binding.
    expect(() => commandMenu(CHAT_COMMANDS, 'edit', {})).not.toThrow();
    // @ts-expect-error: the edit group's Open Working Directory has no binding.
    expect(() => commandToolbar(TASK_COMMANDS, 'edit', { edit: { run: null } })).not.toThrow();
  });
});

describe('toolbars built from the catalogs', () => {
  const run = () => {};
  const view = (items: ToolbarItem[]) => items.map((i) => [i.id, i.label, i.shortcut, i.icon, i.platforms]);

  it('take the menu label without its & and "…", the key as a hint, and the icon', () => {
    expect(view(commandToolbar(TASK_COMMANDS, 'edit', { edit: { run }, workFolder: { run } }))).toEqual([
      ['edit-task', 'Edit Task', 'Ctrl+E', 'edit', undefined],
      ['open-work-folder', 'Open Working Directory', undefined, 'openFolder', undefined],
    ]);
    expect(view(commandToolbar(TASK_COMMANDS, 'task', { runNow: { run }, stop: { run }, pauseResume: { run, alt: true }, enableDisable: { run }, complete: { run }, note: { run } }))).toEqual([
      ['run-now', 'Run Now', 'F5', 'run', undefined],
      ['stop-task', 'Stop Task', 'Shift+F5', 'stop', undefined],
      ['pause-resume', 'Resume', 'F7', 'resume', undefined],
      ['enable-disable', 'Disable', undefined, 'power', undefined],
      ['complete-reopen', 'Complete', undefined, 'complete', undefined],
      ['edit-note', 'Add Guidance for Next Run', undefined, 'guidance', undefined],
    ]);
    expect(view(commandToolbar(CHAT_COMMANDS, 'views', { dashboard: { run }, history: { run }, sendToChats: { run } }))).toEqual([
      ['dashboard', 'Dashboard', undefined, 'dashboard', undefined],
      ['history', 'History', undefined, 'history', undefined],
      ['send-to-chats', 'Send to Chats', undefined, 'bullhorn', undefined],
    ]);
    // A chat's Esc; a terminal's goes to the agent, so its tooltip names none.
    expect(commandToolbar(CHAT_COMMANDS, 'session', { stop: { run, shortcut: false }, sendNow: { run }, restart: { run }, compact: { run }, close: { run }, openWorkFolder: { run } }).map((i) => i.shortcut)).toEqual([
      undefined,
      'Ctrl+Enter',
      undefined,
      undefined,
      'Ctrl+W',
      undefined,
    ]);
    expect(plainLabel('Fish && Chips…')).toBe('Fish & Chips');
  });

  it('carry the destructive mark into the phone’s More menu', () => {
    const items = commandToolbar(CHAT_COMMANDS, 'session', { stop: { run }, sendNow: { run }, restart: { run }, compact: { run }, close: { run }, openWorkFolder: { run } });
    expect(items.filter((i) => i.destructive).map((i) => i.id)).toEqual(['stop', 'close-conversation']);
    const more = composeMore({ toolbar: [{ id: 'session', items }], menu: [], more: [[{ toolbar: 'close-conversation' }]] });
    expect(more.items).toMatchObject([{ label: 'Close Conversation', destructive: true }]);
  });
});

describe('no command outside the catalogs', () => {
  // Menu item ids of the Chats window's, the Task menu's and the Project menu's commands are the catalogs'.
  // Listed here with why, any that aren't catalog commands: none.
  const NOT_CATALOG: Record<string, string> = {};

  it('writes no chat-, task- or project- menu item id in the menu code', () => {
    for (const file of [['main', 'index.ts'], ['main', 'file-menu.ts'], ['main', 'project-menu.ts'], ['main', 'task-menu.ts']]) {
      const ids = [...src(...file).matchAll(/id: '((?:chat|task|project)-[\w-]+)'/g)].map((m) => m[1]).filter((id) => !(id in NOT_CATALOG));
      expect(ids, file.join('/')).toEqual([]);
    }
  });

  it('writes no item of its own into the Chat and Task menus or the Chats window’s File items', () => {
    const index = src('main', 'index.ts');
    expect([...block(index, 'function chatMenu(').matchAll(/label: /g)].length).toBe(1); // the menu's own, &Chat
    expect([...block(index, "id: 'task',", 'as Electron.MenuItemConstructorOptions').matchAll(/label: /g)].length).toBe(1); // &Task
    expect(block(index, 'const fileItems = ', '});\n')).not.toMatch(/label: /);
  });

  it('builds the Chats and Tasks toolbars’ buttons only through commandToolbar', () => {
    const groups = [
      block(src('renderer', 'src', 'SessionsApp.tsx'), 'export function sessionsToolbarGroups('),
      block(src('renderer', 'src', 'components', 'TaskToolbar.tsx'), 'export function taskToolbarGroups('),
      block(src('renderer', 'src', 'components', 'phone', 'TerminalKeys.tsx'), 'toolbar={[', ']}'),
    ];
    const buttonIds = CATALOGS.flatMap(([, c]) => Object.values(c).flatMap((x) => (x.toolbar ? [x.toolbar.id] : [])));
    for (const body of groups) {
      expect(body).not.toMatch(/\bicon: /);
      expect([...body.matchAll(/items: /g)].length).toBe([...body.matchAll(/items: commandToolbar\(/g)].length);
      for (const id of buttonIds) expect(body).not.toContain(`id: '${id}'`);
    }
  });
});
