// Relative imports only: the main process, the renderer and the unit tests all load the catalogs.
import type { SessionKind } from '../sessions';
import { SHORTCUTS } from '../shortcuts';
import { NOT_MOBILE } from '../ui-platform';
import type { Command } from './types';

/** The menus these commands are in: Chat, the Chats window's File and Edit, File → New Chat's shown-project items, and its project pickers. */
export type ChatMenu = 'chat' | 'file' | 'edit' | 'new' | 'pickers';
/** The Chats toolbar's groups, and the phone terminal's text size. */
export type ChatToolbarGroup = 'new' | 'views' | 'session' | 'panes' | 'terminal-text';
/** A conversation screen's More menu, in this order. */
export const CHAT_MORE_GROUPS = ['conversation', 'sessions', 'close'] as const;
export type ChatMoreGroup = (typeof CHAT_MORE_GROUPS)[number];

type ChatCommand = Command<ChatMenu, ChatToolbarGroup, ChatMoreGroup, SessionKind>;

const SETTINGS_PANEL = 'Set in the Usage panel, which the bar’s usage ring opens.';

/**
 * The commands of a conversation in the Chats window (and the main window's
 * Chats tab). The phone's More menu lists them in this order, by group.
 */
export const CHAT_COMMANDS = {
  // ---- on a phone, in More's order ----
  find: {
    label: '&Find…',
    icon: 'search',
    accelerator: 'CmdOrCtrl+F',
    menu: { id: 'chat-find', in: 'edit', group: 'find' },
    mobile: { group: 'conversation', kinds: ['chat'] },
  },
  saveMarkdown: {
    label: '&Save as Markdown…',
    accelerator: 'CmdOrCtrl+S',
    menu: { id: 'chat-save-markdown', in: 'file', group: 'conversation' },
    mobile: { group: 'conversation', kinds: ['chat', 'run'] },
  },
  rename: {
    // Not Re&name or &Rename: Send &Now and &Restart Agent have those letters.
    label: 'Ren&ame…',
    accelerator: 'F2',
    pageKey: true,
    menu: { id: 'chat-rename', in: 'chat', group: 'conversation' },
    mobile: { group: 'conversation', kinds: ['chat'] },
  },
  autoContinue: {
    label: 'Continue &When Limit Resets',
    menu: { id: 'chat-auto-continue', in: 'chat', group: 'conversation' },
    mobile: { group: 'conversation', kinds: ['chat'] },
  },
  copySessionId: {
    label: 'Copy Session &ID',
    icon: 'copy',
    menu: { id: 'chat-copy-session-id', in: 'chat', group: 'conversation' },
    mobile: { group: 'conversation', kinds: ['chat'] },
  },
  // A terminal on a phone has these in its toolbar (TerminalKeys.tsx); a computer's keyboard zooms instead.
  textSmaller: {
    label: 'Smaller Text',
    toolbar: { id: 'terminal-text-smaller', group: 'terminal-text' },
    mobile: { group: 'conversation', kinds: ['terminal'] },
  },
  textLarger: {
    label: 'Larger Text',
    toolbar: { id: 'terminal-text-larger', group: 'terminal-text' },
    mobile: { group: 'conversation', kinds: ['terminal'] },
  },
  restart: {
    label: '&Restart Agent',
    icon: 'restartAgent',
    menu: { id: 'chat-restart', in: 'chat', group: 'turn' },
    toolbar: { id: 'restart-agent', group: 'session' },
    mobile: { group: 'conversation', kinds: ['chat', 'terminal'] },
  },
  compact: {
    label: '&Compact into New Chat',
    icon: 'compact',
    menu: { id: 'chat-compact', in: 'chat', group: 'conversation' },
    toolbar: { id: 'compact', group: 'session' },
    mobile: { group: 'conversation', kinds: ['chat'] },
  },
  newChatInProject: {
    label: 'Chat in Project',
    icon: 'newChat',
    accelerator: SHORTCUTS.newChat,
    pageKey: true,
    menu: { id: 'chat-new-in-project', in: 'new', group: 'project' },
    mobile: { group: 'sessions' },
  },
  sendToChats: {
    label: 'Send to C&hats…',
    icon: 'bullhorn',
    menu: { id: 'chat-send-to-chats', in: 'file', group: 'open' },
    toolbar: { id: 'send-to-chats', group: 'views' },
    mobile: { group: 'sessions' },
  },
  close: {
    label: 'Close C&onversation',
    icon: 'closeChat',
    accelerator: 'CmdOrCtrl+W',
    pageKey: true,
    destructive: true,
    menu: { id: 'chat-close', in: 'file', group: 'close' },
    toolbar: { id: 'close-conversation', group: 'session' },
    mobile: { group: 'close' },
  },

  // ---- not on a phone ----
  // Esc, as in Claude Code's own terminal: it ends the agent's turn. The window handles the key itself, so Esc in the find bar closes that instead.
  stop: {
    label: '&Stop',
    icon: 'stopChat',
    accelerator: 'Esc',
    pageKey: true,
    destructive: true,
    menu: { id: 'chat-stop', in: 'chat', group: 'turn' },
    toolbar: { id: 'stop', group: 'session' },
    mobile: { hidden: 'A chat’s message box has its own Stop, and a terminal’s or a task run’s is a bar button.' },
  },
  // The queued messages go now: the agent's turn ends first.
  sendNow: {
    label: 'Send &Now',
    icon: 'sendNow',
    accelerator: 'CmdOrCtrl+Enter',
    menu: { id: 'chat-send-now', in: 'chat', group: 'turn' },
    toolbar: { id: 'send-now', group: 'session' },
    mobile: { hidden: 'The message box has Send Now.' },
  },
  // Submenus built from the chat's state (chatSettingItems).
  harness: { label: '&Harness', menu: { id: 'chat-harness', in: 'chat', group: 'settings' }, mobile: { hidden: SETTINGS_PANEL } },
  model: { label: '&Model', menu: { id: 'chat-model', in: 'chat', group: 'settings' }, mobile: { hidden: SETTINGS_PANEL } },
  effort: { label: '&Effort', menu: { id: 'chat-effort', in: 'chat', group: 'settings' }, mobile: { hidden: SETTINGS_PANEL } },
  permissionMode: { label: '&Permission Mode', menu: { id: 'chat-permission-mode', in: 'chat', group: 'settings' }, mobile: { hidden: SETTINGS_PANEL } },
  // Chat-only: in a terminal these keys belong to the agent.
  attach: {
    label: '&Attach Files…',
    icon: 'attach',
    accelerator: 'CmdOrCtrl+O',
    menu: { id: 'chat-attach', in: 'file', group: 'conversation' },
    mobile: { hidden: 'The message box has Attach Files.' },
  },
  openInNewWindow: {
    label: 'Open in &New Window',
    platforms: NOT_MOBILE,
    menu: { id: 'chat-open-window', in: 'file', group: 'open' },
    mobile: { hidden: 'Opens a window beside the others: a computer’s.' },
  },
  openWorkFolder: {
    label: 'Open &Working Directory',
    icon: 'openFolder',
    menu: { id: 'chat-work-folder', in: 'file', group: 'open', glyph: false },
    toolbar: { id: 'open-work-folder', group: 'session' },
    mobile: { group: 'conversation' },
  },
  closeAll: {
    label: 'Close A&ll Conversations',
    destructive: true,
    menu: { id: 'chat-close-all', in: 'file', group: 'close' },
    mobile: { hidden: 'Not about the conversation shown: a phone’s More has only what applies to it.' },
  },
  newTerminalInProject: {
    label: 'Terminal in Project',
    icon: 'terminal',
    accelerator: SHORTCUTS.newTerminal,
    pageKey: true,
    menu: { id: 'chat-new-terminal-in-project', in: 'new', group: 'project' },
    mobile: { hidden: 'The Chats list’s bar has New Terminal; a conversation’s More starts a chat only.' },
  },
  // File → New Chat's pickers: a submenu each of the projects, then another folder (sessionNewMenus).
  newChatPicker: {
    label: '&Chat',
    icon: 'newChat',
    menu: { id: 'chat-new-chat', in: 'pickers', group: 'pickers' },
    mobile: { hidden: 'The Chats list’s New Chat button opens this list.' },
  },
  newTerminalPicker: {
    label: '&Terminal',
    icon: 'terminal',
    menu: { id: 'chat-new-terminal', in: 'pickers', group: 'pickers' },
    mobile: { hidden: 'The Chats list’s New Terminal button opens this list.' },
  },
  // The toolbar's split buttons: the shown conversation's project, or a list of projects.
  newChat: {
    label: 'New Chat',
    icon: 'newChat',
    accelerator: SHORTCUTS.newChat,
    toolbar: { id: 'new-chat', group: 'new' },
    mobile: { hidden: 'The Chats list’s bar has New Chat, and a conversation’s More has Chat in its project (newChatInProject).' },
  },
  newTerminal: {
    label: 'New Terminal',
    icon: 'terminal',
    accelerator: SHORTCUTS.newTerminal,
    toolbar: { id: 'new-terminal', group: 'new' },
    mobile: { hidden: 'The Chats list’s bar has New Terminal.' },
  },
  dashboard: {
    label: 'Dashboard',
    icon: 'dashboard',
    toolbar: { id: 'dashboard', group: 'views' },
    mobile: { hidden: 'Back leads to the Chats list, whose Overview is the dashboard.' },
  },
  history: {
    label: 'History',
    icon: 'history',
    toolbar: { id: 'history', group: 'views' },
    mobile: { hidden: 'Not about the conversation shown: it’s in the Chats list’s More, from the toolbar.' },
  },
  activityPane: {
    label: 'Activity Pane',
    icon: 'activity',
    platforms: NOT_MOBILE,
    toolbar: { id: 'activity-pane', group: 'panes' },
    mobile: { hidden: 'A phone shows the activity in a sheet, from its bar’s Activity button.' },
  },
} as const satisfies Record<string, ChatCommand>;

export type ChatCommandName = keyof typeof CHAT_COMMANDS;
