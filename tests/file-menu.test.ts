import { describe, expect, it, vi } from 'vitest';
import { fileNewItems, newChatItems, type FileNewActions } from '../src/main/file-menu';
import { SHORTCUTS } from '../src/shared/shortcuts';

type Item = Electron.MenuItemConstructorOptions;

const actions = (): FileNewActions => ({
  newProject: vi.fn(),
  newTask: vi.fn(),
  newTaskFromTemplate: vi.fn(),
  newTaskWithAgent: vi.fn(),
  newFolder: vi.fn(),
});
const labels = (items: Item[]) => items.map((i) => (i.type === 'separator' ? '-' : i.label));
const sub = (items: Item[], id: string) => items.find((i) => i.id === id)!.submenu as Item[];
const pickers: Item[] = [
  { id: 'chat-new-chat', label: '&Chat', submenu: [] },
  { id: 'chat-new-terminal', label: '&Terminal', submenu: [] },
];

describe('File → New', () => {
  it('has New Project, New Task, New Chat and New Folder at the top, the task items in a submenu with their keys', () => {
    const a = actions();
    const items = fileNewItems(a, pickers, false);
    expect(labels(items)).toEqual(['New P&roject…', '&New Task', 'New &Chat', 'New &Folder…']);
    const task = sub(items, 'new-task-menu');
    expect(task.map((i) => [i.id, i.label, i.accelerator])).toEqual([
      ['new-task', '&Blank Task…', 'CmdOrCtrl+N'],
      ['new-task-template', 'From &Template…', 'CmdOrCtrl+Shift+N'],
      ['new-task-agent', 'With A&gent…', undefined],
    ]);
    expect(items.find((i) => i.id === 'new-folder')!.enabled).toBe(true);
    (task[1].click as () => void)();
    expect(a.newTaskFromTemplate).toHaveBeenCalled();
  });

  it('keeps the task keys off and New Folder disabled on the Chats tab or window', () => {
    const items = fileNewItems(actions(), pickers, true);
    expect(sub(items, 'new-task-menu').map((i) => i.accelerator)).toEqual([undefined, undefined, undefined]);
    expect(items.find((i) => i.id === 'new-folder')!.enabled).toBe(false);
  });

  it('leaves New Chat out when there are no chat items (a phone’s main window)', () => {
    expect(labels(fileNewItems(actions(), null, false))).toEqual(['New P&roject…', '&New Task', 'New &Folder…']);
  });

  it('puts the shown project’s chat and terminal first in New Chat, with the page’s keys, then the pickers', () => {
    const chat = vi.fn();
    const items = newChatItems({ project: { id: 'p1', name: 'Web app' }, chat, terminal: vi.fn() }, pickers);
    expect(labels(items)).toEqual(['Chat in Web app', 'Terminal in Web app', '-', '&Chat', '&Terminal']);
    expect(items.slice(0, 2).map((i) => [i.id, i.accelerator, i.registerAccelerator])).toEqual([
      ['chat-new-in-project', SHORTCUTS.newChat, false],
      ['chat-new-terminal-in-project', SHORTCUTS.newTerminal, false],
    ]);
    (items[0].click as () => void)();
    expect(chat).toHaveBeenCalledWith('p1');
  });

  it('disables the shown project’s items when no conversation shows, and has only the pickers elsewhere', () => {
    const items = newChatItems({ project: undefined, chat: vi.fn(), terminal: vi.fn() }, pickers);
    expect(items.slice(0, 2).map((i) => [i.label, i.enabled])).toEqual([
      ['Chat in Project', false],
      ['Terminal in Project', false],
    ]);
    expect(newChatItems(null, pickers)).toBe(pickers);
  });
});
