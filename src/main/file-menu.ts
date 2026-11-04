import { CHAT_COMMANDS } from '../shared/commands/chat';
import { commandMenu } from './command-menu';

type MenuItem = Electron.MenuItemConstructorOptions;

/** What File's New items open. */
export interface FileNewActions {
  newProject: () => void;
  newTask: () => void;
  newTaskFromTemplate: () => void;
  newTaskWithAgent: () => void;
  newFolder: () => void;
}

/**
 * File's New items, in a main window and the Chats window: New Project; New
 * Task (blank, from a template, with the agent); New Chat with `chatItems`
 * (null: no New Chat); and New Folder, which chats don't have. `inChats`: the
 * Chats tab or window, where a terminal session takes Ctrl+N, so the task
 * items show no keys there and New Folder is off.
 */
export function fileNewItems(actions: FileNewActions, chatItems: MenuItem[] | null, inChats: boolean): MenuItem[] {
  const key = (accelerator: string) => (inChats ? {} : { accelerator });
  return [
    { id: 'new-project', label: 'New P&roject…', glyph: 'newProject', click: actions.newProject },
    {
      id: 'new-task-menu',
      label: '&New Task',
      glyph: 'newTask',
      submenu: [
        { id: 'new-task', label: '&Blank Task…', ...key('CmdOrCtrl+N'), click: actions.newTask },
        { id: 'new-task-template', label: 'From &Template…', ...key('CmdOrCtrl+Shift+N'), click: actions.newTaskFromTemplate },
        { id: 'new-task-agent', label: 'With A&gent…', click: actions.newTaskWithAgent },
      ],
    },
    ...(chatItems ? [{ id: 'new-chat-menu', label: 'New &Chat', glyph: 'newChat', submenu: chatItems }] : []),
    { id: 'new-folder', label: 'New &Folder…', glyph: 'folder', enabled: !inChats, click: actions.newFolder },
  ];
}

/**
 * New Chat's items: on the Chats tab or window (`shown`), a chat and a terminal
 * in the shown conversation's project first (their keys are the page's, so a
 * terminal session keeps Ctrl+T), then the pickers (`pickers`: a Chat and a
 * Terminal submenu of the projects and another folder).
 */
export function newChatItems(
  shown: { project: { id: string; name: string } | undefined; chat: (projectId: string) => void; terminal: (projectId: string) => void } | null,
  pickers: MenuItem[],
): MenuItem[] {
  if (!shown) return pickers;
  const { project } = shown;
  return [
    ...commandMenu(CHAT_COMMANDS, 'new', {
      newChatInProject: { label: project && `Chat in ${project.name}`, enabled: !!project, click: () => project && shown.chat(project.id) },
      newTerminalInProject: { label: project && `Terminal in ${project.name}`, enabled: !!project, click: () => project && shown.terminal(project.id) },
    }),
    { type: 'separator' },
    ...pickers,
  ];
}
