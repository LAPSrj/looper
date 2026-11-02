import { app, Menu as ElectronMenu, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Engine } from '../engine/engine';
import { convertWslPath, detectedDefaultWslDistro, detectSystemLocale, detectWslMountPrefix, listWslDistros } from '../engine/host';
import { REMOTE_CHANNELS, type HostFileView } from '../shared/remote-access';
import { copyIntoFolder, listDir, makeDir, type Flavor, type HostFilesDeps } from './platform/host-files';
import { discoverHarnessModels } from '../engine/discover-models';
import { FILE_KINDS, wrapLooperFile, type LooperFileKind } from '../shared/files';
import { folderSubtree } from '../shared/folders';
import { DESKTOP_ONLY, NOT_MOBILE } from '../shared/ui-platform';
import { projectTaskId } from '../shared/projects';
import { sessionGroupKey } from '../shared/sessions';
import { SENT_IMAGE_RE, fileImageId, fileImageKey, type MessageImage, type SentFileInfo } from '../shared/messages';

import type { AppInfo } from '../shared/api';
import type { BuilderSetup } from '../shared/builder';
import { attachmentName, type Attachment, type AttachmentInput, type ChatSettingMenu } from '../shared/chat';
import { HISTORY_COMMANDS, type HistoryCommand } from '../shared/history';
import type { PaneId } from '../shared/panes';
import type { RunFilter } from '../shared/runs';
import { TailnetHostnameSchema, type EngineEvent, type Task, type View } from '../shared/types';
import {
  allWindows,
  caller,
  ipc,
  openOnHost,
  openExternal,
  openPath,
  popupMenu,
  showItemInFolder,
  showMessageBox,
  showOpenDialog,
  showSaveDialog,
  windowOf,
  ofCaller,
  writeClipboard,
  type AppWindow,
} from './platform';
import { fitWindowHeight } from './platform/fit-window';
import { withAccessKeys } from './platform/menus';
import { projectMenuItems, type ProjectCommand } from './project-menu';
import type { RemoteAccess } from './remote-access';
import { paneMenuItems, projectsPaneMenuItems, singleMenuItems } from './view-menu';

/** Every context menu built here: each item gets an access key (withAccessKeys) unless its label has one. */
const Menu = {
  buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => ElectronMenu.buildFromTemplate(withAccessKeys(template)),
};

export interface IpcHost {
  getWindow: () => AppWindow | null;
  openMessages: (taskId: string, runId: string, agentId?: string, label?: string) => void;
  openMessageImage: (taskId: string, runId: string, rowId: string, agentId?: string, label?: string) => void;
  openEditor: (taskId?: string) => void;
  /** Modal step-selection window for a manual run; resolves whether a run started. */
  promptRunOptions: (taskId: string) => Promise<boolean>;
  openNoteEditor: (taskId: string) => void;
  /** Guidance window for continuing a finished run's conversation. */
  openContinueRun: (taskId: string, runId: string) => void;
  /** Guidance window for a run in flight: the agent gets the text mid-run. */
  openSendGuidance: (taskId: string, runId: string) => void;
  openFolderNoteEditor: (folderId: string) => void;
  openMoveToFolder: (taskId: string) => void;
  openNewFolder: (parentId?: string) => void;
  openRenameFolder: (folderId: string) => void;

  openEnvEditor: (envId: string, isNew?: boolean, parent?: AppWindow | null) => void;
  openHarnessEditor: (envId: string, harnessId: string, isNew?: boolean, parent?: AppWindow | null) => void;
  openModelEditor: (envId: string, harnessId: string, index?: number, parent?: AppWindow | null, copyOf?: number) => void;
  openModelUpdate: (envId?: string, harnessId?: string, parent?: AppWindow | null) => void;
  openTemplateEditor: (templateId?: string, parent?: AppWindow | null) => void;
  openTemplatePicker: () => void;
  openEditorFromTemplate: (templateId: string) => void;
  /** The task's Version History window (one per task). */
  openVersions: (taskId: string) => void;
  /** A version's View or Compare window. */
  openVersionDetail: (taskId: string, n: number, compare: boolean, parent: AppWindow | null) => void;
  /** The New Task with Agent setup window. */
  openBuilderSetup: () => void;
  /** Start a builder from its setup window, which then becomes the conversation. */
  startBuilder: (setupWindow: AppWindow | null, setup: BuilderSetup) => void;
  /** Edit with Agent: a builder on the task, or the one already open brought forward. */
  editWithAgent: (taskId: string) => Promise<void>;
  /** Create/Update: the import editor prefilled with the builder's draft. */
  reviewBuilder: (builderId: string) => void;
  /** The windows showing a builder (one per client at most), which alone get its events. */
  builderWindow: (builderId: string) => AppWindow[];
  /**
   * Open Project in Terminal / Continue in Terminal (with a run id): a Looper
   * terminal window or the system's terminal, as the setting says. Rejects
   * with the reason when the session can't start.
   */
  openTerminal: (taskId: string, runId?: string) => Promise<void>;
  /** The windows showing a terminal session (Sessions windows, or a Remote Control conversation's), which alone get its output. */
  terminalWindow: (sessionId: string) => AppWindow[];
  /** Open Project in Chat / Continue in Chat (with a run id). Rejects with the reason when the chat can't start. */
  openChat: (taskId: string, runId?: string) => Promise<void>;
  /** Fork from Here: a new chat with the conversation up to the row at `index`. Throws with the reason. */
  forkChat: (chatId: string, index: number) => void;
  /** Compact into New Chat: a new chat from the chat's messages, which takes its place. Rejects with the reason. */
  compactChat: (chatId: string) => Promise<void>;
  /** Continue Compacted: a new chat from the run's messages. Rejects with the reason. */
  compactRun: (taskId: string, runId: string) => Promise<void>;
  /** The Chats windows and single chat's windows showing the session, which alone get its chat and activity events. */
  sessionWindow: (sessionId: string) => AppWindow[];
  /** That Chats window now shows this session (null: the Overview). */
  showSession: (window: AppWindow | null, sessionId: string | null) => void;
  /** The chats that Chats window's dashboard shows as cards (none once it leaves the dashboard). */
  showCards: (window: AppWindow | null, chatIds: string[]) => void;
  /** Close Conversation: ends the chat or terminal session, asking first (over `from`) when it's working. */
  closeSession: (sessionId: string, from: AppWindow | null) => Promise<void>;
  /** Close All Conversations in a list group (sessionGroupKey), asking first over `from`. */
  closeSessionGroup: (group: string, from: AppWindow | null) => Promise<void>;
  /** Send to Chats; `group` (sessionGroupKey): with that list group's chats checked. */
  openSendToSessions: (group?: string) => void;
  /** The History window, opened or brought forward. */
  openHistory: () => void;
  /** That History window shows this conversation now (null: none): its menus act on it. */
  historySelect: (window: AppWindow | null, id: string | null) => void;
  /** A History window's command on a conversation, asking first over `from` when it may still be open elsewhere. Rejects with the reason. */
  historyRun: (from: AppWindow | null, id: string, command: HistoryCommand) => Promise<void>;
  /** A conversation's right-click menu in the History window. */
  historyMenu: (from: AppWindow | null, id: string) => void;
  /** The Chats window, opened or brought forward; `select` shows that session in it. */
  openSessions: (select?: string) => void;
  /** Open in New Window: the chat (or task run) alone in its own window, or that window brought forward. */
  openChatWindow: (sessionId: string) => void;
  /** A chat's Harness, Model, Effort or Permission Mode menu, as the Chat menu has them ('all': the four as submenus). */
  chatSettingMenu: (chatId: string, which: ChatSettingMenu | 'all') => Electron.MenuItemConstructorOptions[];
  /** A Remote Control conversation: an open one in a Looper terminal window (a chat or terminal it lists in the Chats window), an ended one in its run window. */
  openRemoteConversation: (id: string) => Promise<void>;
  openRemoteHelperEditor: (id: string, isNew: boolean, parent: AppWindow | null) => void;
  /** Remote Access, once it's created (after the engine). */
  remoteAccess: () => RemoteAccess | null;
  openRemoteAccessPair: (parent: AppWindow | null) => void;
  openRemoteAccessRename: (deviceId: string, parent: AppWindow | null) => void;
  /** Set Up's Finish: save the sources and machine name, turn Remote Access on, and with `pair` open Pair Device once it runs. */
  finishRemoteAccessSetup: (choice: { sources?: unknown; hostname?: unknown }, pair: boolean) => Promise<void>;
  /** A device's click on a task notification: what a click on the desktop's toast opens, on that device. */
  openNotification: (taskId: string, runId?: string) => void;
  /** The Edit Project window (no id = New Project). */
  openProjectEditor: (id?: string) => void;
  /** The New Task editor with the project picked. */
  openNewTaskIn: (projectId: string) => void;
  /** Other Folder…: a chat or terminal in a folder the user picks over `parent`, with no project. Rejects with the reason. */
  openInFolder: (kind: 'chat' | 'terminal', parent: AppWindow | null) => Promise<void>;
  takeImportDraft: (key: string) => unknown;
  openLooperFile: (file: string) => Promise<void>;
  updateTaskMenu: (
    hasTask: boolean,
    taskEnabled?: boolean,
    taskPaused?: boolean,
    taskState?: string,
    hasNote?: boolean,
    canRunNow?: boolean,
    taskCompleted?: boolean,
    allowComplete?: boolean,
    hasProject?: boolean,
  ) => void;
}

/** Height of an attachment's thumbnail in a chat message. */
const THUMBNAIL_HEIGHT = 160;

/** Files from a renderer, checked: pasted bytes, or the path of an existing file. */
function attachmentInputs(files: unknown): AttachmentInput[] {
  if (!Array.isArray(files)) return [];
  const out: AttachmentInput[] = [];
  for (const f of files as Record<string, unknown>[]) {
    const name = typeof f?.name === 'string' && f.name.trim() ? f.name : 'attachment';
    if (f?.data instanceof Uint8Array) {
      out.push({ name, data: f.data });
    } else if (typeof f?.path === 'string' && f.path) {
      try {
        if (fs.statSync(f.path).isFile()) out.push({ name, path: f.path });
      } catch {
        /* gone or unreadable: skipped */
      }
    }
  }
  return out;
}

export function registerIpc(engine: Engine, host: IpcHost): void {
  ipc.handle('info', (): AppInfo => ({
    version: app.getVersion(),
    dataDir: engine.dataDir,
    inboxDir: engine.inboxDir(),
    host: engine.host,
    locale: detectSystemLocale(),
    settings: engine.settings,
  }));

  ipc.handle('tasks:list', () => engine.listTasks());
  ipc.handle('tasks:save', (_e, input: unknown, opts?: { builderId?: string }) =>
    engine.saveTask(input, opts?.builderId ? { builderId: String(opts.builderId) } : undefined),
  );
  ipc.handle('versions:list', (_e, id: string) => engine.listVersions(id));
  ipc.handle('versions:detail', (_e, id: string, n: number, compare?: boolean) => engine.versionDetail(id, n, compare));
  ipc.handle('versions:restore', (_e, id: string, n: number) => engine.restoreVersion(id, n));
  ipc.handle('versions:open', (_e, id: string) => host.openVersions(id));
  ipc.handle('versions:openDetail', (e, id: string, n: number, compare: boolean) =>
    host.openVersionDetail(id, n, !!compare, windowOf(e)),
  );
  ipc.handle('builder:start', (e, setup: BuilderSetup) => host.startBuilder(windowOf(e), setup));
  ipc.handle('builder:get', (_e, id: string) => engine.getBuilder(id) ?? null);
  ipc.on('builder:send', (_e, id: string, text: string) => engine.sendBuilder(id, String(text ?? '')));
  ipc.handle('builder:review', (_e, id: string) => host.reviewBuilder(id));
  ipc.handle('builder:save', (_e, id: string) => engine.saveBuilder(id));
  ipc.handle('builder:undo', (_e, id: string) => engine.undoBuilder(id));
  ipc.handle('builder:redo', (_e, id: string) => engine.redoBuilder(id));
  ipc.handle('builder:forTask', (_e, taskId: string) => engine.builderForTask(taskId) ?? null);
  ipc.handle('builder:loadVersion', async (_e, taskId: string, n: number) => {
    const id = engine.builderForTask(taskId);
    if (!id) throw new Error("The task's Edit Task with Agent window was closed.");
    await engine.loadBuilderVersion(id, n);
    (ofCaller(host.builderWindow(id))[0] ?? host.builderWindow(id)[0])?.focus();
  });
  ipc.handle('builder:editTask', (_e, taskId: string) => host.editWithAgent(taskId));
  ipc.handle('builder:openNew', () => host.openBuilderSetup());
  ipc.handle('builder:output', (_e, id: string) => engine.builderOutput(id));
  ipc.on('builder:write', (_e, id: string, data: string) => engine.writeBuilder(id, data));
  ipc.on('builder:resize', (_e, id: string, cols: number, rows: number) => engine.resizeBuilder(id, cols, rows));
  ipc.handle('tasks:remove', (_e, id: string) => engine.removeTask(id));
  ipc.handle('recycleBin:list', () => engine.listRecycleBin());
  ipc.handle('recycleBin:restore', (_e, id: string) => engine.restoreTask(id));
  ipc.handle('recycleBin:delete', (_e, id: string) => engine.purgeTask(id));
  ipc.handle('recycleBin:empty', () => engine.emptyRecycleBin());
  /** Save dialog, then write the definition as a Looper document of the given kind. */
  const exportDocument = async (e: Electron.IpcMainInvokeEvent, kind: LooperFileKind, item?: Task): Promise<void> => {
    if (!item) return;
    const sender = windowOf(e);
    const { ext, filterName } = FILE_KINDS[kind];
    const options: Electron.SaveDialogOptions = {
      title: kind === 'task' ? 'Export Task' : 'Export Template',
      defaultPath: `${item.id}.${ext}`,
      filters: [{ name: filterName, extensions: [ext] }],
    };
    const result = await showSaveDialog(sender, options);
    if (result.canceled || !result.filePath) return;
    try {
      const doc = wrapLooperFile(kind, app.getVersion(), item);
      fs.writeFileSync(result.filePath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    } catch (err) {
      const opts: Electron.MessageBoxOptions = {
        type: 'error',
        title: 'Looper',
        message: kind === 'task' ? 'Could not export task.' : 'Could not export template.',
        detail: (err as Error).message,
        buttons: ['OK'],
      };
      await showMessageBox(sender, opts);
    }
  };
  ipc.handle('tasks:export', (e, id: string) => exportDocument(e, 'task', engine.getTask(id)));

  ipc.handle(
    'tasks:reorder',
    (
      _e,
      ids: string[],
      folders?: Record<string, string | null>,
      layout?: Record<string, string[]>,
      parents?: Record<string, string | null>,
    ) => engine.reorderTasks(ids, folders, layout, parents),
  );
  ipc.handle('folders:list', () => engine.listFolders());
  ipc.handle('folders:layout', () => engine.listLayout());
  ipc.handle('folders:add', (_e, name: string, parentId?: string) => engine.addFolder(name, parentId));
  ipc.handle('folders:rename', (_e, id: string, name: string) => engine.renameFolder(id, name));
  ipc.handle('folders:remove', (_e, id: string) => engine.removeFolder(id));

  ipc.handle('templates:list', () => engine.listTemplates());
  ipc.handle('templates:save', (_e, input: unknown) => engine.saveTemplate(input));
  ipc.handle('templates:remove', (_e, id: string) => engine.removeTemplate(id));
  ipc.handle('templates:reorder', (_e, ids: string[]) => engine.reorderTemplates(ids));
  ipc.handle('templates:export', (e, id: string) =>
    exportDocument(e, 'template', engine.listTemplates().find((t) => t.id === id)),
  );
  ipc.handle('templates:import', async (e) => {
    const sender = windowOf(e);
    const options: Electron.OpenDialogOptions = {
      title: 'Import Template',
      filters: [{ name: FILE_KINDS.template.filterName, extensions: [FILE_KINDS.template.ext] }],
      properties: ['openFile'],
    };
    const result = await showOpenDialog(sender, options);
    const file = result.canceled ? undefined : result.filePaths[0];
    if (file) await host.openLooperFile(file);
  });
  /** A Looper document dropped onto a window; behaves exactly like double-clicking it. */
  ipc.handle('file:openLooper', (_e, file: string) => host.openLooperFile(file));

  ipc.handle('rest:state', () => engine.restState());
  ipc.handle('prevent-sleep:state', () => engine.preventSleepState());

  ipc.handle('runtime:list', () => engine.listRuntimes());
  // With the setting on, the run is started by the Run Options window instead.
  ipc.handle('runtime:runNow', (_e, id: string) =>
    engine.settings.promptRunOptions ? host.promptRunOptions(id) : engine.runNow(id),
  );
  ipc.handle('runtime:pause', (_e, id: string) => engine.pause(id));
  ipc.handle('runtime:resume', (_e, id: string) => engine.resume(id));
  ipc.handle('runtime:complete', (_e, id: string) => engine.completeTask(id));
  ipc.handle('runtime:reopen', (_e, id: string) => engine.reopenTask(id));
  ipc.handle('runtime:stopTask', (_e, id: string, runId?: string) => engine.stopTask(id, undefined, runId));

  ipc.handle('runs:list', (_e, id: string, limit?: number) => engine.listRuns(id, limit));
  ipc.handle('runs:recent', (_e, limit: number, filter: RunFilter) => engine.recentRuns(limit, filter));
  ipc.handle('runs:output', (_e, id: string, runId: string, raw?: boolean) => engine.readOutput(id, runId, undefined, raw));
  ipc.handle('runs:openDir', (_e, id: string, runId: string) => openPath(engine.runDir(id, runId)));
  ipc.handle('runs:clear', (_e, id: string) => engine.clearRuns(id));
  ipc.handle('runs:messages', (_e, id: string, runId: string, agentId?: string, raw?: boolean) =>
    engine.readMessages(id, runId, agentId, raw),
  );
  ipc.handle('runs:messageImage', async (_e, id: string, runId: string, rowId: string, agentId?: string) => {
    // An image file the agent sent (SendUserFile) is read from disk; any other row's image is in the transcript.
    const sent = fileImageId(String(rowId));
    return sent !== null ? readSentImage(String(id), sent) : engine.readMessageImage(id, runId, rowId, agentId);
  });
  ipc.handle('messages:open', (_e, taskId: string, runId: string, agentId?: string, label?: string) =>
    host.openMessages(taskId, runId, agentId, label),
  );
  ipc.handle('messages:openImage', (_e, taskId: string, runId: string, rowId: string, agentId?: string, label?: string) =>
    host.openMessageImage(taskId, runId, rowId, agentId, label),
  );

  ipc.handle('engineLog:read', () => engine.readEngineLog());

  ipc.handle('task:openTerminal', (_e, id: string, runId?: string) => host.openTerminal(id, runId));
  ipc.handle('terminalSession:output', (_e, id: string) => engine.terminalSessionOutput(id));
  ipc.on('terminalSession:write', (_e, id: string, data: string) => engine.writeTerminalSession(id, data));
  ipc.on('terminalSession:resize', (_e, id: string, cols: number, rows: number) =>
    engine.resizeTerminalSession(id, cols, rows),
  );
  ipc.handle('terminalSession:attach', (_e, id: string, files: unknown) => engine.attachToTerminal(id, attachmentInputs(files)));
  ipc.on('context-menu:terminal', (e, id: string, hasSelection: boolean) => {
    const sender = windowOf(e);
    if (!sender) return;
    const send = (payload: unknown) => {
      if (!sender.isDestroyed()) sender.webContents.send('ui:event', payload);
    };
    const attachFiles = async () => {
      const r = await showOpenDialog(sender, { title: 'Attach Files', properties: ['openFile', 'multiSelections'] });
      if (r.canceled || r.filePaths.length === 0) return;
      const files = r.filePaths.map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, path: p }));
      send({ type: 'terminal-attached', text: engine.attachToTerminal(id, files) });
    };
    popupMenu(Menu.buildFromTemplate([
      { label: 'Copy', enabled: !!hasSelection, click: () => send({ type: 'terminal-copy' }) },
      { label: 'Paste', click: () => send({ type: 'terminal-paste' }) },
      { type: 'separator' },
      {
        label: 'Attach Files…',
        click: () =>
          void attachFiles().catch((err: unknown) => {
            void showMessageBox(sender, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'] });
          }),
      },
    ]), { window: sender });
  });

  ipc.handle('task:openChat', (_e, id: string, runId?: string) => host.openChat(id, runId));
  ipc.handle('chat:get', (_e, id: string) => engine.getChat(id) ?? null);
  ipc.on('chat:send', (_e, id: string, text: string, attachments: Attachment[]) => {
    // Only Looper's own copies: the renderer never makes the agent read any other file.
    const files = (Array.isArray(attachments) ? attachments : [])
      .filter((a) => engine.isAttachment(String(a?.path)))
      .map((a) => ({ name: String(a.name), path: String(a.path), image: !!a.image }));
    engine.sendChat(id, String(text ?? ''), files);
  });
  ipc.on('chat:answer', (_e, id: string, requestId: string, allow: boolean) => engine.answerChat(id, requestId, !!allow));
  ipc.handle('chat:stop', (_e, id: string) => engine.stopChat(String(id)));
  // A chat message's right-click menu; Quote and Edit as New Message hand text back to the window's message box.
  ipc.on(
    'context-menu:chat',
    (
      e,
      info: {
        chatId: string;
        taskId: string;
        selection?: string;
        quote?: boolean;
        text?: string;
        textLabel?: string;
        result?: string;
        file?: string;
        resend?: { text: string; attachments: Attachment[] };
        fork?: number;
      },
    ) => {
      const sender = windowOf(e);
      if (!sender) return;
      const groups: Electron.MenuItemConstructorOptions[][] = [];
      if (info.selection) {
        const selection = info.selection;
        groups.push([
          { label: 'Copy', click: () => writeClipboard(selection) },
          {
            label: 'Quote',
            // The chat window handles the key itself (ChatView), so a selection is quoted without the menu.
            accelerator: 'CmdOrCtrl+Shift+Q',
            registerAccelerator: false,
            enabled: !!info.quote,
            click: () => sender.webContents.send('ui:event', { type: 'chat-quote', chatId: String(info.chatId), text: selection }),
          },
        ]);
      }
      const copies: Electron.MenuItemConstructorOptions[] = [];
      if (info.text) copies.push({ label: info.textLabel ?? 'Copy Message', click: () => writeClipboard(info.text!) });
      if (info.result) copies.push({ label: 'Copy Result', click: () => writeClipboard(info.result!) });
      if (copies.length) groups.push(copies);
      if (info.file) {
        const file = info.file;
        groups.push([
          {
            label: 'Open File',
            click: () =>
              void openTargetPath(info.taskId, file).catch((err: unknown) => {
                void showMessageBox(sender, {
                  type: 'error',
                  title: 'Looper',
                  message: `Could not open ${file}.`,
                  detail: err instanceof Error ? err.message : String(err),
                  buttons: ['OK'],
                });
              }),
          },
          { label: 'Copy Path', click: () => writeClipboard(file) },
        ]);
      }
      const again: Electron.MenuItemConstructorOptions[] = [];
      if (info.resend) {
        const resend = info.resend;
        again.push({ label: 'Edit as New Message', click: () => sender.webContents.send('ui:event', { type: 'chat-edit', chatId: String(info.chatId), ...resend }) });
      }
      if (typeof info.fork === 'number') {
        const index = info.fork;
        again.push({
          label: 'Fork from Here',
          click: () => {
            try {
              host.forkChat(String(info.chatId), index);
            } catch (err) {
              void showMessageBox(sender, {
                type: 'error',
                title: 'Looper',
                message: err instanceof Error ? err.message : String(err),
                buttons: ['OK'],
              });
            }
          },
        });
      }
      if (again.length) groups.push(again);
      const items = groups.flatMap((g, i) => (i ? [{ type: 'separator' } as const, ...g] : g));
      if (items.length > 0) popupMenu(Menu.buildFromTemplate(items), { window: sender });
    },
  );
  ipc.handle('chat:attach', (_e, id: string, files: unknown) => engine.attachToChat(id, attachmentInputs(files)));
  /** The message box's Attach Files: pick files, then copy them in like dropped ones. */
  ipc.handle('chat:pickFiles', async (e, id: string) => {
    const sender = windowOf(e);
    const opts: Electron.OpenDialogOptions = { title: 'Attach Files', properties: ['openFile', 'multiSelections'] };
    const r = await showOpenDialog(sender, opts);
    if (r.canceled || r.filePaths.length === 0) return [];
    return engine.attachToChat(String(id), r.filePaths.map((p) => ({ name: path.basename(p), path: p })));
  });
  ipc.handle('chat:sendNow', (_e, id: string) => engine.sendNowChat(String(id)));
  ipc.handle('chat:compact', (_e, id: string) => host.compactChat(String(id)));
  ipc.handle('chat:unqueue', (_e, id: string, messageId: string) => engine.unqueueChat(String(id), String(messageId)) ?? null);
  ipc.on('chat:draft', (_e, id: string, text: string, attachments: Attachment[]) => {
    // As with chat:send, only Looper's own copies.
    const files = (Array.isArray(attachments) ? attachments : [])
      .filter((a) => engine.isAttachment(String(a?.path)))
      .map((a) => ({ name: String(a.name), path: String(a.path), image: !!a.image }));
    engine.setChatDraft(String(id), String(text ?? ''), files);
  });

  // ---------- the Chats window ----------

  ipc.handle('sessions:state', () => engine.sessionsState());
  ipc.handle('sessions:activity', (_e, id: string) => engine.sessionActivity(String(id)));
  ipc.on('sessions:show', (e, id: string | null) => host.showSession(windowOf(e), typeof id === 'string' ? id : null));
  ipc.on('sessions:seen', (_e, id: string) => engine.seenSession(String(id)));
  ipc.handle('sessions:close', (e, id: string) => host.closeSession(String(id), windowOf(e)));
  ipc.handle('sessions:stop', (_e, id: string) => engine.stopSession(String(id)));
  ipc.on('sessions:openSend', () => host.openSendToSessions());

  // ---------- the History window ----------

  ipc.handle('history:list', (_e, fresh: unknown) => engine.historyList(fresh === true));
  ipc.handle('history:search', (_e, query: unknown) => engine.historySearch(String(query ?? '')));
  ipc.handle('history:read', (_e, id: unknown, agentId?: unknown) => engine.historyRead(String(id), typeof agentId === 'string' ? agentId : undefined));
  ipc.handle('history:commands', (_e, id: unknown) => engine.historyCommands(String(id)));
  ipc.handle('history:run', (e, id: unknown, command: unknown) => {
    if (!HISTORY_COMMANDS.includes(command as HistoryCommand)) throw new Error(`unknown command ${String(command)}`);
    return host.historyRun(windowOf(e), String(id), command as HistoryCommand);
  });
  ipc.on('history:select', (e, id: unknown) => host.historySelect(windowOf(e), typeof id === 'string' && id ? id : null));
  ipc.on('context-menu:history', (e, id: unknown) => host.historyMenu(windowOf(e), String(id)));
  ipc.on('history:open', () => host.openHistory());
  ipc.on('sessions:openWindow', (_e, id?: unknown) => host.openSessions(typeof id === 'string' && id ? id : undefined));
  /** New Chat's or New Terminal's drop-down, under the button that asked: the projects, another folder, and New Project. */
  ipc.on('context-menu:new-session', (e, kind: string, x: number, y: number) => {
    const sender = windowOf(e);
    if (!sender) return;
    const terminal = kind === 'terminal';
    const open = terminal ? projectTerminal : projectChat;
    const items: Electron.MenuItemConstructorOptions[] = engine.listProjects().map((p) => ({
      label: p.name.replace(/&/g, '&&'),
      click: () => void open(p.id, sender),
    }));
    if (items.length > 0) items.push({ type: 'separator' });
    items.push(
      { label: 'Other &Folder…', click: () => void host.openInFolder(terminal ? 'terminal' : 'chat', sender).catch((err) => fail(sender, err)) },
      { label: 'New P&roject…', click: () => host.openProjectEditor() },
    );
    popupMenu(Menu.buildFromTemplate(items), { window: sender, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) });
  });
  /** The message box's Harness, Model, Effort and Permission Mode buttons, or the one button a narrow chat has for them ('all'). */
  ipc.on('context-menu:chat-setting', (e, chatId: string, which: string, x: number, y: number) => {
    const sender = windowOf(e);
    if (!sender || (which !== 'all' && which !== 'harness' && which !== 'model' && which !== 'effort' && which !== 'permission')) return;
    const items = host.chatSettingMenu(String(chatId), which);
    if (items.length) popupMenu(Menu.buildFromTemplate(items), { window: sender, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) });
  });
  ipc.on('sessions:send', (_e, ids: unknown, text: string) => {
    engine.sendToSessions(Array.isArray(ids) ? ids.map(String) : [], String(text ?? ''));
  });
  ipc.handle('sessions:backgroundOutput', (_e, id: string, taskId: string) => engine.backgroundOutput(String(id), String(taskId)));
  ipc.on('sessions:cards', (e, ids: unknown) => host.showCards(windowOf(e), Array.isArray(ids) ? ids.map(String) : []));
  // A session's right-click menu in the list, or on its dashboard card (`card`). A task run's agent can't be stopped or closed from here.
  ipc.on('context-menu:session', (e, id: string, card?: unknown) => {
    const sender = windowOf(e);
    const listed = engine.sessionsState().sessions;
    const s = listed.find((x) => x.id === id);
    if (!sender || !s) return;
    const run = s.kind === 'run';
    const harnessSession = engine.harnessSessionId(s.id);
    // A card's size stays across the window's reopenings; the closed sessions' ids go when one changes.
    const view = engine.settings.view;
    const big = view.sessions.bigCards.includes(s.id);
    const resize = () => {
      const bigCards = view.sessions.bigCards.filter((x) => x !== s.id && listed.some((l) => l.id === x));
      engine.updateSettings({ view: { ...view, sessions: { ...view.sessions, bigCards: big ? bigCards : [...bigCards, s.id] } } });
    };
    const items: Electron.MenuItemConstructorOptions[] = [
      ...(run
        ? []
        : [
            { label: 'Stop', enabled: s.status === 'working' || s.waiting?.reason === 'permission', click: () => void engine.stopSession(id) },
            { type: 'separator' } as const,
          ]),
      ...(card === true ? [{ label: big ? 'Normal Size' : 'Double Size', click: resize }, { type: 'separator' } as const] : []),
      ...(s.kind === 'terminal' ? [] : [{ label: 'Open in New Window', platforms: NOT_MOBILE, click: () => host.openChatWindow(id) }]),
      { label: 'Open Working Directory', platforms: DESKTOP_ONLY, click: () => void openTargetPath(s.taskId, engine.findSessionTask(s.taskId)?.cwd ?? '').catch(() => undefined) },
      { label: 'Copy Session ID', enabled: !!harnessSession, click: () => harnessSession && writeClipboard(harnessSession) },
      ...(run ? [] : [{ type: 'separator' } as const, { label: 'Close Conversation', click: () => void host.closeSession(id, sender) }]),
    ];
    popupMenu(Menu.buildFromTemplate(items), { window: sender });
  });
  // A list group's right-click menu: New Chat in its project, then its chats and terminal sessions, never its task runs.
  ipc.on('context-menu:session-group', (e, group: string) => {
    const sender = windowOf(e);
    const key = String(group);
    const listed = engine.sessionsState().sessions.filter((s) => s.kind !== 'run' && sessionGroupKey(s) === key);
    if (!sender) return;
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (engine.getProject(key)) items.push({ label: 'New &Chat', click: () => void projectChat(key, sender) });
    if (listed.length > 0) {
      const sendable = listed.some((s) => s.status !== 'ended' && !s.stopped);
      if (items.length > 0) items.push({ type: 'separator' });
      items.push(
        { label: 'Send to Chats…', enabled: sendable, click: () => host.openSendToSessions(key) },
        { type: 'separator' },
        { label: 'Close All Conversations', click: () => void host.closeSessionGroup(key, sender).catch((err) => fail(sender, err)) },
      );
    }
    if (items.length > 0) popupMenu(Menu.buildFromTemplate(items), { window: sender });
  });
  /** An image the agent read or wrote, as a thumbnail; only image files are read. */
  ipc.handle('sessions:fileThumbnail', async (_e, taskId: string, p: string) => {
    const file = String(p);
    if (!/\.(png|jpe?g|gif|webp)$/i.test(file)) return null;
    const hostPath = await targetToHost(String(taskId), file);
    const img = nativeImage.createFromPath(hostPath);
    if (img.isEmpty()) return null;
    const { height } = img.getSize();
    return (height > THUMBNAIL_HEIGHT ? img.resize({ height: THUMBNAIL_HEIGHT }) : img).toDataURL();
  });
  /** A file the agent sent (SendUserFile): its size, and a thumbnail when it's an image; null when it's gone. */
  ipc.handle('sessions:sentFile', async (_e, taskId: string, p: string): Promise<SentFileInfo | null> => {
    const file = String(p);
    const hostPath = await sentFileHostPath(String(taskId), file);
    let size: number;
    try {
      const st = await fs.promises.stat(hostPath);
      if (!st.isFile()) return null;
      size = st.size;
    } catch {
      return null;
    }
    const thumbnail = SENT_IMAGE_RE.test(file) ? await sentThumbnail(hostPath, size).catch(() => null) : null;
    return { size, ...(thumbnail ? { thumbnail } : {}) };
  });
  /**
   * Click on a file the agent sent. `image`: an image shown inline opens in
   * Looper's image window; a remote device and any other file get the path
   * shown or opened the way an attachment is (the device's file viewer, or the
   * default app on the computer).
   */
  ipc.handle('sessions:openFile', async (_e, taskId: string, runId: string, p: string, image: boolean) => {
    const file = String(p);
    const hostPath = await sentFileHostPath(String(taskId), file);
    // The image window reads the image whole: a bigger one opens in the default app.
    const st = await fs.promises.stat(hostPath).catch(() => null);
    if (image && !caller() && SENT_IMAGE_RE.test(file) && st && st.size <= SENT_IMAGE_MAX) {
      host.openMessageImage(String(taskId), String(runId), fileImageKey(file), undefined, path.basename(file.replace(/\\/g, '/')));
      return;
    }
    const err = await openPath(hostPath);
    if (err) throw new Error(err);
  });
  /** An attachment opens in its default app; nothing outside Looper's attachment copies does. */
  ipc.handle('attachment:open', async (_e, p: string) => {
    if (!engine.isAttachment(String(p))) return;
    const err = await openPath(String(p));
    if (err) throw new Error(err);
  });
  ipc.handle('attachment:thumbnail', (_e, p: string) => {
    if (!engine.isAttachment(String(p))) return null;
    const img = nativeImage.createFromPath(String(p));
    if (img.isEmpty()) return null;
    const { height } = img.getSize();
    return (height > THUMBNAIL_HEIGHT ? img.resize({ height: THUMBNAIL_HEIGHT }) : img).toDataURL();
  });
  ipc.handle('run:continue', (_e, id: string, runId: string, guidance: string) =>
    engine.continueRun(id, runId, guidance),
  );
  ipc.handle('run:canGuide', (_e, id: string, runId: string) => engine.canGuideRun(id, runId));
  ipc.handle('run:guide', (_e, id: string, runId: string, text: string) => engine.sendGuidance(id, runId, text));

  /** A target-native path (in the task's environment) as the host opens it, translated across the WSL boundary. */
  const targetToHost = async (taskId: string, p: string): Promise<string> => {
    const task = engine.findSessionTask(taskId);
    const env = task ? engine.settings.environments.find((x) => x.id === task.environmentId) : undefined;
    const distro = env?.kind === 'wsl' ? env.distro : undefined;
    if (process.platform === 'win32' && p.startsWith('/')) return (await convertWslPath(p, 'windows', distro)) ?? p;
    if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(p)) return (await convertWslPath(p, 'posix', distro)) ?? p;
    return p;
  };

  /** A file the agent sent, as the host opens it: a relative path is the session's folder's. */
  const sentFileHostPath = async (taskId: string, p: string): Promise<string> => {
    let file = p;
    if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(file)) {
      const cwd = engine.findSessionTask(taskId)?.cwd;
      if (cwd) file = (/^[A-Za-z]:/.test(cwd) ? path.win32 : path.posix).join(cwd, file);
    }
    return targetToHost(taskId, file);
  };

  const SENT_IMAGE_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  /** The largest sent image read whole: for the image window, and for a thumbnail nativeImage can't draw (GIF, WebP, SVG). */
  const SENT_IMAGE_MAX = 10_000_000;
  const SENT_THUMB_RAW_MAX = 4_000_000;

  /** A sent image file as a data URL for an <img>: PNG and JPEG shrunk to a thumbnail, the other types as they are when small enough. */
  const sentThumbnail = async (hostPath: string, size: number): Promise<string | null> => {
    const type = SENT_IMAGE_TYPES[path.extname(hostPath).slice(1).toLowerCase()];
    if (!type) return null;
    if (type === 'image/png' || type === 'image/jpeg') {
      const img = nativeImage.createFromPath(hostPath);
      if (!img.isEmpty()) {
        const { height } = img.getSize();
        return (height > THUMBNAIL_HEIGHT ? img.resize({ height: THUMBNAIL_HEIGHT }) : img).toDataURL();
      }
    }
    if (size > SENT_THUMB_RAW_MAX) return null;
    return `data:${type};base64,${(await fs.promises.readFile(hostPath)).toString('base64')}`;
  };

  /** The payload of a sent image file, for the image window; null when it's gone, too big or not an image. */
  const readSentImage = async (taskId: string, p: string): Promise<MessageImage | null> => {
    const mediaType = SENT_IMAGE_TYPES[path.extname(p.replace(/\\/g, '/')).slice(1).toLowerCase()];
    if (!mediaType) return null;
    try {
      const hostPath = await sentFileHostPath(taskId, p);
      if ((await fs.promises.stat(hostPath)).size > SENT_IMAGE_MAX) return null;
      return { mediaType, data: (await fs.promises.readFile(hostPath)).toString('base64') };
    } catch {
      return null;
    }
  };

  /** Open a target-native path (file or folder) on the host, translating across the WSL boundary. */
  const openTargetPath = async (taskId: string, p: string): Promise<void> => {
    const err = await openPath(await targetToHost(taskId, p));
    if (err) throw new Error(err);
  };

  ipc.handle('task:openWorkFolder', async (_e, id: string) => {
    const task = engine.findSessionTask(id);
    if (!task) return;
    await openTargetPath(id, task.cwd);
  });

  // ---------- projects ----------

  /** A failure shown over the window that asked. */
  const fail = (sender: AppWindow | null, err: unknown) => {
    const opts = { type: 'error' as const, title: 'Looper', message: (err as Error).message, buttons: ['OK'] };
    void showMessageBox(sender, opts);
  };
  const projectChat = (id: string, sender: AppWindow | null) => host.openChat(projectTaskId(id)).catch((err) => fail(sender, err));
  const projectTerminal = (id: string, sender: AppWindow | null) => host.openTerminal(projectTaskId(id)).catch((err) => fail(sender, err));
  const removeProject = async (id: string, sender: AppWindow | null) => {
    const project = engine.getProject(id);
    if (!project) return;
    const msg = { type: 'question' as const, title: 'Looper', message: `Delete the project "${project.name}"?`, detail: 'Its folder and files stay as they are.', buttons: ['Delete', 'Cancel'], noLink: true, defaultId: 1, cancelId: 1 };
    const { response } = await showMessageBox(sender, msg);
    if (response !== 0) return;
    try {
      engine.removeProject(id);
    } catch (err) {
      fail(sender, err);
    }
  };
  ipc.handle('projects:list', () => engine.listProjects());
  ipc.handle('projects:save', (_e, input: unknown) => engine.saveProject(input));
  ipc.handle('projects:remove', (e, id: string) => removeProject(String(id), windowOf(e)));
  ipc.handle('projects:reorder', (_e, ids: string[]) => engine.reorderProjects(Array.isArray(ids) ? ids.map(String) : []));
  ipc.handle('projects:openEditor', (_e, id?: string) => host.openProjectEditor(id ? String(id) : undefined));
  ipc.handle('projects:newTask', (_e, id: string) => host.openNewTaskIn(String(id)));
  ipc.handle('projects:newChat', (e, id: string) => projectChat(String(id), windowOf(e)));
  ipc.handle('projects:newTerminal', (e, id: string) => projectTerminal(String(id), windowOf(e)));
  // A project's menu; with no id, the Projects pane header's (its View options, then New Project).
  ipc.on('context-menu:project', (e, id: string) => {
    const sender = windowOf(e);
    if (!sender) return;
    const pid = String(id ?? '');
    if (!pid || !engine.getProject(pid)) {
      const update = (patch: Partial<View>) => engine.updateSettings({ view: { ...engine.settings.view, ...patch } });
      popupMenu(Menu.buildFromTemplate([
        ...projectsPaneMenuItems(engine.settings.view, update),
        { type: 'separator' },
        { label: 'New P&roject…', click: () => host.openProjectEditor() },
      ]), { window: sender });
      return;
    }
    const run: Record<ProjectCommand, () => void> = {
      'new-task': () => host.openNewTaskIn(pid),
      'new-chat': () => void projectChat(pid, sender),
      'new-terminal': () => void projectTerminal(pid, sender),
      edit: () => host.openProjectEditor(pid),
      'open-folder': () => void openTargetPath(projectTaskId(pid), engine.getProject(pid)?.cwd ?? '').catch((err) => fail(sender, err)),
      delete: () => void removeProject(pid, sender),
    };
    popupMenu(Menu.buildFromTemplate(projectMenuItems((command) => run[command]())), { window: sender });
  });

  // ---------- the Git tabs ----------

  const gitPath = (v: unknown): string => {
    const p = String(v ?? '');
    if (!p) throw new Error('No file was given.');
    return p;
  };
  ipc.handle('git:repos', () => engine.git.repoIds());
  ipc.handle('git:check', (_e, id: string) => engine.git.check(String(id)));
  ipc.handle('git:status', (_e, id: string) => engine.git.status(String(id)));
  ipc.handle('git:changeDiff', (_e, id: string, change: { path: unknown; origPath?: unknown; kind: unknown }, initial: boolean) =>
    engine.git.changeDiff(
      String(id),
      {
        path: gitPath(change?.path),
        ...(change?.origPath ? { origPath: String(change.origPath) } : {}),
        kind: change?.kind === 'untracked' ? 'untracked' : 'modified',
      },
      initial === true,
    ),
  );
  ipc.handle('git:log', (_e, id: string, skip: number, limit: number) => engine.git.log(String(id), Number(skip) || 0, Number(limit) || 200));
  ipc.handle('git:commit', (_e, id: string, hash: string) => engine.git.commit(String(id), String(hash)));
  ipc.handle('git:commitDiff', (_e, id: string, hash: string, p: string, origPath?: string) =>
    engine.git.commitDiff(String(id), String(hash), gitPath(p), origPath ? String(origPath) : undefined),
  );
  /** A file's right-click menu in a Git tab; `root` is the repository's, in the project's own path form. */
  ipc.on('context-menu:git-file', (e, info: { projectId: string; root: string; path: string; exists: boolean }) => {
    const sender = windowOf(e);
    if (!sender || !info?.path || !info.root) return;
    const taskId = projectTaskId(String(info.projectId));
    const full = `${String(info.root).replace(/[\\/]$/, '')}/${String(info.path)}`;
    popupMenu(Menu.buildFromTemplate([
      { label: '&Open File', enabled: info.exists, click: () => void openTargetPath(taskId, full).catch((err) => fail(sender, err)) },
      {
        label: 'Show in &Folder',
        platforms: DESKTOP_ONLY,
        enabled: info.exists,
        click: () => void targetToHost(taskId, full).then((p) => showItemInFolder(p)).catch((err) => fail(sender, err)),
      },
      { type: 'separator' },
      { label: '&Copy Path', click: () => writeClipboard(String(info.path)) },
    ]), { window: sender });
  });
  ipc.on('context-menu:git-commit', (e, info: { hash: string; subject: string }) => {
    const sender = windowOf(e);
    if (!sender || !info?.hash) return;
    popupMenu(Menu.buildFromTemplate([
      { label: 'Copy Commit &ID', click: () => writeClipboard(String(info.hash)) },
      { label: 'Copy &Subject', click: () => writeClipboard(String(info.subject ?? '')) },
    ]), { window: sender });
  });

  ipc.handle('agent:buffer', (_e, id: string, runId?: string) => engine.agentBuffer(id, runId));
  ipc.on('agent:write', (_e, id: string, data: string, runId?: string) => engine.writeAgent(id, data, runId));
  ipc.on('agent:resize', (_e, id: string, cols: number, rows: number, runId?: string) =>
    engine.resizeAgent(id, cols, rows, runId),
  );

  ipc.handle('openPath', (_e, p: string) => openPath(p));
  ipc.handle('editor:open', (_e, taskId?: string) => host.openEditor(taskId));
  ipc.handle('noteEditor:open', (_e, taskId: string) => host.openNoteEditor(taskId));
  ipc.handle('moveToFolder:open', (_e, taskId: string) => host.openMoveToFolder(taskId));

  ipc.handle('envEditor:open', (e, envId: string, isNew?: boolean) =>
    host.openEnvEditor(envId, isNew, windowOf(e)),
  );
  ipc.handle('harnessEditor:open', (e, envId: string, harnessId: string, isNew?: boolean) =>
    host.openHarnessEditor(envId, harnessId, isNew, windowOf(e)),
  );
  ipc.handle('modelEditor:open', (e, envId: string, harnessId: string, index?: number, copyOf?: number) =>
    host.openModelEditor(envId, harnessId, index, windowOf(e), copyOf),
  );
  ipc.handle('modelUpdate:open', (e, envId?: string, harnessId?: string) =>
    host.openModelUpdate(envId, harnessId, windowOf(e)),
  );
  ipc.handle('models:discover', (_e, envId: string, harnessId: string) => {
    const env = engine.settings.environments.find((x) => x.id === envId);
    const harness = env?.harnesses.find((h) => h.id === harnessId);
    if (!env || !harness) throw new Error('This harness no longer exists.');
    return discoverHarnessModels(env, harness, engine.host);
  });
  ipc.handle('templateEditor:open', (e, templateId?: string) =>
    host.openTemplateEditor(templateId, windowOf(e)),
  );
  ipc.handle('templatePicker:open', () => host.openTemplatePicker());
  ipc.handle('editorFromTemplate:open', (_e, templateId: string) =>
    host.openEditorFromTemplate(templateId),
  );
  ipc.handle('import:draft', (_e, key: string) => host.takeImportDraft(key));

  // Fired from `beforeunload` when a freshly created environment/harness is
  // closed without saving, so create-on-add leaves no junk behind. `send`
  // (not invoke): the window is going away and cannot await a reply.
  // ---------- Remote Control ----------

  ipc.handle('remote:state', () => engine.remoteState());
  ipc.handle('remote:lastMessage', (_e, id: string) => engine.remoteLastMessage(String(id)));
  ipc.handle('remote:open', (_e, id: string) => host.openRemoteConversation(String(id)));
  ipc.handle('remote:openHelperEditor', (e, id: string, isNew?: boolean) =>
    host.openRemoteHelperEditor(String(id), !!isNew, windowOf(e)),
  );
  // A new helper whose window closed without Create.
  ipc.on('remote:discard', (_e, id: string) => {
    try {
      const r = engine.settings.remote;
      engine.updateSettings({ remote: { ...r, helpers: r.helpers.filter((h) => h.id !== id) } });
    } catch (err) {
      engine.log.error(`discard remote helper ${id} failed: ${String(err)}`);
    }
  });
  // ---------- Remote Access ----------

  const remoteAccess = (): RemoteAccess => {
    const ra = host.remoteAccess();
    if (!ra) throw new Error('Remote Access isn\'t ready yet.');
    return ra;
  };
  ipc.handle('remoteAccess:state', () => remoteAccess().state());
  ipc.handle('remoteAccess:pairingCode', () => remoteAccess().newPairingCode());
  ipc.handle('remoteAccess:cancelPairing', () => remoteAccess().cancelPairing());
  ipc.handle('remoteAccess:removeDevice', (_e, id: string) => remoteAccess().removeDevice(String(id)));
  ipc.handle('remoteAccess:renameDevice', (_e, id: string, name: string) => remoteAccess().renameDevice(String(id), String(name)));
  ipc.handle('remoteAccess:suggestPort', () => remoteAccess().suggestPort());
  ipc.handle('remoteAccess:beginSignIn', (_e, hostname: unknown) => {
    const name = TailnetHostnameSchema.safeParse(hostname);
    if (!name.success) throw new Error('Use lowercase letters, digits and hyphens in the machine name.');
    return remoteAccess().beginSignIn(name.data);
  });
  ipc.handle('remoteAccess:endSignIn', () => remoteAccess().endSignIn());
  ipc.handle('remoteAccess:finishSetup', (_e, choice: unknown, pair: unknown) => {
    const c = choice && typeof choice === 'object' ? (choice as { sources?: unknown; hostname?: unknown }) : {};
    return host.finishRemoteAccessSetup({ sources: c.sources, hostname: c.hostname }, pair === true);
  });
  // The host side of a remote client's file browser, file viewer, Open on Host Computer and the downloads.
  const hostFiles: HostFilesDeps = {
    host: process.platform === 'win32' ? 'windows' : 'posix',
    places: () =>
      engine.listProjects().map((p) => {
        const env = engine.settings.environments.find((x) => x.id === p.environmentId);
        return { name: p.name, cwd: p.cwd, ...(env?.kind === 'wsl' && env.distro ? { distro: env.distro } : {}) };
      }),
    distros: listWslDistros,
    defaultDistro: detectedDefaultWslDistro,
    convert: convertWslPath,
    known: (k) => {
      try {
        return app.getPath(k);
      } catch {
        return undefined;
      }
    },
  };
  ipc.handle(REMOTE_CHANNELS.listDir, (_e, p?: string | null, flavor?: Flavor, distro?: string) => listDir(hostFiles, p, flavor, distro));
  ipc.handle(REMOTE_CHANNELS.makeDir, (_e, parent: unknown, name: unknown, flavor?: Flavor, distro?: string) => makeDir(hostFiles, parent, name, flavor, distro));
  /** A file's name for a device: an attachment copy's own name, without the stamp in front. */
  const fileName = (file: string): string => (engine.isAttachment(file) ? attachmentName(file) : path.basename(file.replace(/\\/g, '/')));
  ipc.handle(REMOTE_CHANNELS.view, (_e, p: unknown, maxBytes: unknown): HostFileView => {
    if (!caller()) throw new Error('Only a remote device can view a file this way.');
    const file = String(p);
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error(`${file} isn't a file.`);
    const name = fileName(file);
    const fits = typeof maxBytes === 'number' && st.size <= maxBytes;
    return { name, size: st.size, ...(fits ? { token: remoteAccess().offerDownload(file, name) } : {}) };
  });
  ipc.handle(REMOTE_CHANNELS.saveOnHost, (_e, p: unknown) => {
    if (!caller()) throw new Error('Only a remote device can download a file to the host computer.');
    return copyIntoFolder(p, app.getPath('downloads'), typeof p === 'string' ? fileName(p.trim()) : undefined);
  });
  ipc.handle(REMOTE_CHANNELS.openNotification, (_e, taskId: unknown, runId: unknown) => {
    if (typeof taskId !== 'string' || !taskId) return;
    host.openNotification(taskId, typeof runId === 'string' && runId ? runId : undefined);
  });
  ipc.handle(REMOTE_CHANNELS.openSession, (_e, id: unknown) => {
    if (typeof id === 'string' && id && engine.sessionKind(id)) host.openSessions(id);
  });
  ipc.handle(REMOTE_CHANNELS.openOnHost, async (_e, p: string) => {
    const err = await openOnHost(String(p));
    if (err) throw new Error(err);
  });
  ipc.handle(REMOTE_CHANNELS.download, (_e, p: string) => {
    const ctx = caller();
    if (!ctx) throw new Error('Only a remote device can download a file.');
    const file = String(p);
    if (!fs.statSync(file).isFile()) throw new Error(`${file} isn't a file.`);
    const name = fileName(file);
    ctx.client.send({ t: 'download', token: remoteAccess().offerDownload(file, name), name });
  });
  ipc.handle('remoteAccess:openPair', (e) => host.openRemoteAccessPair(windowOf(e)));
  ipc.handle('remoteAccess:openRename', (e, id: string) => host.openRemoteAccessRename(String(id), windowOf(e)));

  ipc.on('context-menu:remote-conversation', (e, id: string) => {
    const sender = windowOf(e);
    if (!sender) return;
    const state = engine.remoteState();
    const conv = state.conversations.find((c) => c.id === id);
    if (!conv) return;
    const open = conv.status !== 'ended';
    // A chat or Looper terminal it lists is the user's: it closes in its own window, and a chat goes on in a chat.
    const users = conv.source === 'chat' || conv.source === 'terminal';
    const restart = () => {
      try {
        engine.restartRemoteConversation(id);
      } catch (err) {
        void showMessageBox(sender, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'] });
      }
    };
    popupMenu(Menu.buildFromTemplate([
      { label: 'Open', click: () => void host.openRemoteConversation(id) },
      { label: 'Open in Browser', enabled: !!conv.link, click: () => conv.link && void openExternal(conv.link) },
      { label: 'Copy Link', enabled: !!conv.link, click: () => conv.link && writeClipboard(conv.link) },
      { type: 'separator' },
      {
        label: 'Restart',
        enabled: state.running && conv.source !== 'helper' && conv.source !== 'chat' && !(users && open) && conv.status !== 'waiting',
        click: restart,
      },
      { label: 'Stop', enabled: open && !users, click: () => engine.stopRemoteConversation(id) },
    ]), { window: sender });
  });

  ipc.on('envEditor:discard', (_e, envId: string) => {
    try {
      const s = engine.settings;
      if (s.environments.length <= 1 || !s.environments.some((x) => x.id === envId)) return;
      const environments = s.environments.filter((x) => x.id !== envId);
      engine.updateSettings({
        environments,
        ...(s.defaultEnvironmentId === envId ? { defaultEnvironmentId: environments[0].id } : {}),
      });
    } catch (err) {
      engine.log.error(`discard environment ${envId} failed: ${String(err)}`);
    }
  });
  ipc.on('harnessEditor:discard', (_e, envId: string, harnessId: string) => {
    try {
      const s = engine.settings;
      const env = s.environments.find((x) => x.id === envId);
      if (!env || env.harnesses.length <= 1 || !env.harnesses.some((h) => h.id === harnessId)) return;
      engine.updateSettings({
        environments: s.environments.map((x) =>
          x.id === envId ? { ...x, harnesses: x.harnesses.filter((h) => h.id !== harnessId) } : x,
        ),
      });
    } catch (err) {
      engine.log.error(`discard harness ${harnessId} failed: ${String(err)}`);
    }
  });
  ipc.handle('store:move', (_e, store: 'tasks' | 'templates', targetFile: string) =>
    engine.moveStoreFile(store, targetFile),
  );
  ipc.handle('settings:update', (_e, patch: unknown) => engine.updateSettings(patch));

  // Start-with-the-computer registration lives in the OS (login item / Run key),
  // not in settings.json. The args must match on get and set so Windows finds
  // the same registry entry; --hidden makes a login start go to the tray.
  // Only the packaged app registers: a dev run's execPath is the bare
  // electron.exe, which starts Electron's default window without the app path.
  const loginArgs = ['--hidden'];
  ipc.handle('loginItem:get', () => {
    if (!app.isPackaged) return false;
    try {
      return app.getLoginItemSettings({ args: loginArgs }).openAtLogin;
    } catch {
      return false; // not supported on this platform
    }
  });
  ipc.handle('loginItem:set', (_e, enabled: boolean) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, args: loginArgs });
  });

  ipc.handle(
    'dialog:pickSaveFile',
    async (e, defaultPath?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> => {
      const sender = windowOf(e);
      const options: Electron.SaveDialogOptions = {
        title: 'Choose File Location',
        ...(defaultPath ? { defaultPath } : {}),
        ...(filters ? { filters } : {}),
      };
      const result = await showSaveDialog(sender, options);
      return result.canceled ? null : result.filePath;
    },
  );
  ipc.on(
    'ui:selection',
    (
      _e,
      hasTask: boolean,
      taskEnabled?: boolean,
      taskPaused?: boolean,
      taskState?: string,
      hasNote?: boolean,
      canRunNow?: boolean,
      taskCompleted?: boolean,
      allowComplete?: boolean,
      hasProject?: boolean,
    ) =>
      host.updateTaskMenu(hasTask, taskEnabled, taskPaused, taskState, hasNote, canRunNow, taskCompleted, allowComplete, hasProject),
  );

  // A dialog's page measures its content and asks for a window that fits it.
  ipc.on('window:fit', (e, contentHeight: number) => fitWindowHeight(windowOf(e), contentHeight));

  ipc.handle('dialog:error', async (e, message: string, detail?: string) => {
    const sender = windowOf(e);
    const opts: Electron.MessageBoxOptions = { type: 'error', title: 'Looper', message, ...(detail ? { detail } : {}), buttons: ['OK'] };
    await showMessageBox(sender, opts);
  });
  ipc.handle('dialog:confirm', async (e, message: string) => {
    const sender = windowOf(e);
    const opts: Electron.MessageBoxOptions = { type: 'question', title: 'Looper', message, buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1 };
    const result = await showMessageBox(sender, opts);
    return result.response === 0;
  });

  // Native directory picker, translating between the host's path style and the
  // environment's native one (flavor). WSL paths cross via \\wsl.localhost\
  // UNC shares plus `wslpath` for drive-mount paths.
  ipc.handle(
    'dialog:pickDir',
    async (e, current?: string, flavor?: 'posix' | 'windows', distro?: string): Promise<string | null> => {
      const sender = windowOf(e);
      const hostFlavor = process.platform === 'win32' ? 'windows' : 'posix';
      const uncRoot = distro ? `\\\\wsl.localhost\\${distro}` : undefined;
      const cur = current?.trim();
      let defaultPath: string | undefined;
      if (!flavor || flavor === hostFlavor) {
        defaultPath = cur || undefined;
      } else if (flavor === 'posix') {
        // Seed a Windows picker inside the distro's UNC share.
        defaultPath = cur
          ? uncRoot
            ? uncRoot + cur.replace(/\//g, '\\')
            : await convertWslPath(cur, 'windows', distro)
          : (uncRoot ?? (await convertWslPath('/', 'windows', distro)));
      } else {
        // Windows-flavor cwd, POSIX host: seed the Linux picker with the mount path.
        defaultPath = cur ? await convertWslPath(cur, 'posix', distro) : undefined;
      }
      const options: Electron.OpenDialogOptions = {
        title: 'Select Working Directory',
        properties: ['openDirectory'],
        ...(defaultPath ? { defaultPath } : {}),
      };
      const result = await showOpenDialog(sender, options);
      const picked = result.canceled ? undefined : result.filePaths[0];
      if (!picked) return null;
      if (!flavor || flavor === hostFlavor) return picked;
      if (flavor === 'posix') {
        // \\wsl.localhost\<distro>\home\x (or \\wsl$\...) -> /home/x, no process spawn.
        const unc = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+(\\.*)?$/i.exec(picked);
        if (unc) return (unc[1] ?? '').replace(/\\/g, '/') || '/';
        return (await convertWslPath(picked, 'posix', distro)) ?? picked;
      }
      return (await convertWslPath(picked, 'windows', distro)) ?? picked;
    },
  );

  ipc.handle('wsl:distros', () => listWslDistros());
  ipc.handle('wsl:mountPrefix', (_e, distro?: string) => detectWslMountPrefix(distro));

  ipc.on('context-menu:task', (e, info: { enabled: boolean; completed: boolean; allowComplete: boolean; state?: string; held: boolean; hasNote: boolean; activeRuns?: number; maxRuns?: number }) => {
    const sender = windowOf(e);
    if (!sender) return;
    const active = info.state === 'running' || info.state === 'checking' || info.state === 'classifying';
    // A task allowed several simultaneous runs can start another until its cap.
    const canRun = !active || (info.activeRuns ?? 1) < (info.maxRuns ?? 1);
    const menu = Menu.buildFromTemplate([
      { label: 'Run Now', glyph: 'run', enabled: canRun, click: () => sender.webContents.send('ui:event', { type: 'run-now' }) },
      { label: 'Stop Task', glyph: 'stop', enabled: active, click: () => sender.webContents.send('ui:event', { type: 'stop-task' }) },
      { label: info.state === 'paused' ? 'Resume' : 'Pause', glyph: info.state === 'paused' ? 'resume' : 'pause', enabled: info.state !== 'disabled' && !info.completed, click: () => sender.webContents.send('ui:event', { type: 'pause-resume' }) },
      { label: info.enabled ? 'Disable' : 'Enable', enabled: !info.completed, click: () => sender.webContents.send('ui:event', { type: 'enable-disable' }) },
      {
        label: info.completed ? 'Reopen' : 'Complete',
        enabled: info.completed || info.allowComplete,
        click: () => sender.webContents.send('ui:event', { type: 'complete-reopen' }),
      },
      { label: 'Edit Task…', glyph: 'edit', click: () => sender.webContents.send('ui:event', { type: 'edit-task' }) },
      { label: 'Edit with Agent…', click: () => sender.webContents.send('ui:event', { type: 'edit-with-agent' }) },
      { label: 'Version History', click: () => sender.webContents.send('ui:event', { type: 'version-history' }) },
      { label: 'Delete Task', glyph: 'delete', click: () => sender.webContents.send('ui:event', { type: 'delete-task' }) },
      { type: 'separator' },
      { label: info.hasNote ? 'Edit Guidance for Next Run…' : 'Add Guidance for Next Run…', click: () => sender.webContents.send('ui:event', { type: 'edit-note' }) },
      { label: 'Clear Guidance', enabled: info.hasNote, click: () => sender.webContents.send('ui:event', { type: 'clear-note' }) },
      { type: 'separator' },
      { label: 'Move to Folder…', glyph: 'folder', click: () => sender.webContents.send('ui:event', { type: 'move-to-folder' }) },
      { label: 'Clear Run History…', enabled: !active, click: () => sender.webContents.send('ui:event', { type: 'clear-runs' }) },
      { type: 'separator' },
      { label: 'Open Project in Terminal', click: () => sender.webContents.send('ui:event', { type: 'open-terminal' }) },
      { label: 'Open Project in Chat', click: () => sender.webContents.send('ui:event', { type: 'open-chat' }) },
      { label: 'Open Working Directory', platforms: DESKTOP_ONLY, click: () => sender.webContents.send('ui:event', { type: 'open-work-folder' }) },
    ]);
    popupMenu(menu, { window: sender });
  });

  /** Delete Folder…: asks first, and with tasks inside offers to delete them too (unchecked, they move up to the folder's parent). */
  const deleteFolder = (sender: AppWindow, folderId: string) => {
    // Folder actions apply to the whole subtree: nested folders included.
    const subtree = () => folderSubtree(engine.listFolders(), folderId);
    const members = () => {
      const ids = subtree();
      return engine.listTasks().filter((t) => t.folderId && ids.has(t.folderId));
    };
    const name = engine.listFolders().find((f) => f.id === folderId)?.name ?? '?';
    const opts: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Looper',
      message: `Delete folder "${name}"?`,
      ...(members().length > 0 ? { checkboxLabel: 'Also delete tasks inside', checkboxChecked: false } : {}),
      buttons: ['Yes', 'No'],
      defaultId: 0,
      cancelId: 1,
    };
    void showMessageBox(sender, opts).then((r) => {
      if (r.response !== 0) return;
      if (r.checkboxChecked) {
        // Delete the whole subtree: every task in it, then every nested folder.
        for (const t of members()) engine.removeTask(t.id);
        for (const id of subtree()) if (id !== folderId) engine.removeFolder(id);
      }
      engine.removeFolder(folderId);
    });
  };

  // Folder header context menu. Bulk actions run directly against the engine;
  // Run All skips disabled tasks and tasks already at their run cap.
  ipc.on('context-menu:folder', (e, info: { folderId: string }) => {
    const sender = windowOf(e);
    if (!sender) return;
    // Folder actions apply to the whole subtree: nested folders included.
    const subtree = () => folderSubtree(engine.listFolders(), info.folderId);
    const members = () => {
      const ids = subtree();
      return engine.listTasks().filter((t) => t.folderId && ids.has(t.folderId));
    };
    const stateOf = (taskId: string) => engine.listRuntimes().find((rt) => rt.taskId === taskId)?.state;
    const hasMembers = members().length > 0;
    const forEachMember = (fn: (t: Task) => void) => {
      for (const t of members()) {
        try {
          fn(t);
        } catch (err) {
          engine.log.error(`folder action on ${t.id} failed: ${String(err)}`);
        }
      }
    };
    const menu = Menu.buildFromTemplate([
      {
        label: 'Run All Now',
        enabled: hasMembers,
        click: () =>
          forEachMember((t) => {
            const active = engine.listRuntimes().find((rt) => rt.taskId === t.id)?.runs.length ?? 0;
            if (t.enabled && active < t.maxConcurrentRuns) engine.runNow(t.id);
          }),
      },
      {
        label: 'Pause All',
        enabled: hasMembers,
        click: () => forEachMember((t) => { if (stateOf(t.id) !== 'disabled' && !t.completedAt) engine.pause(t.id); }),
      },
      {
        label: 'Resume All',
        enabled: hasMembers,
        click: () => forEachMember((t) => { if (stateOf(t.id) === 'paused') engine.resume(t.id); }),
      },
      {
        label: 'Enable All',
        enabled: hasMembers,
        click: () => forEachMember((t) => { if (!t.enabled && !t.completedAt) engine.saveTask({ ...t, enabled: true }); }),
      },
      {
        label: 'Disable All',
        enabled: hasMembers,
        click: () => forEachMember((t) => { if (t.enabled) engine.saveTask({ ...t, enabled: false }); }),
      },
      { type: 'separator' },
      {
        label: 'Add Guidance for Next Runs…',
        enabled: hasMembers,
        click: () => host.openFolderNoteEditor(info.folderId),
      },
      { type: 'separator' },
      {
        label: 'New Subfolder…',
        click: () => host.openNewFolder(info.folderId),
      },
      {
        label: 'Rename Folder…',
        click: () => host.openRenameFolder(info.folderId),
      },
      {
        label: 'Delete Folder…',
        click: () => deleteFolder(sender, info.folderId),
      },
    ]);
    popupMenu(menu, { window: sender });
  });

  // The folder commands the keyboard has in the task list (F2, Delete): the same flows as the menu's.
  ipc.on('folder:command', (e, folderId: string, command: string) => {
    const sender = windowOf(e);
    if (!sender || typeof folderId !== 'string') return;
    if (command === 'rename') host.openRenameFolder(folderId);
    else if (command === 'delete') deleteFolder(sender, folderId);
  });

  // A list window's row menu: the window names the items; a pick comes back as a 'list-menu' event carrying the same token.
  ipc.on('context-menu:list', (e, token: string, items: { id: string; label: string; enabled?: boolean }[]) => {
    const sender = windowOf(e);
    if (!sender || !Array.isArray(items)) return;
    popupMenu(
      Menu.buildFromTemplate(
        items.map((it) => ({
          label: String(it.label),
          enabled: it.enabled !== false,
          click: () => sender.webContents.send('ui:event', { type: 'list-menu', token: String(token), id: String(it.id) }),
        })),
      ),
      { window: sender },
    );
  });

  ipc.on('context-menu:recycle-bin', (e) => {
    const sender = windowOf(e);
    if (!sender) return;
    popupMenu(Menu.buildFromTemplate([
      { label: 'Restore', click: () => sender.webContents.send('ui:event', { type: 'bin-restore' }) },
      { label: 'Delete', click: () => sender.webContents.send('ui:event', { type: 'bin-delete' }) },
    ]), { window: sender });
  });

  ipc.on('context-menu:version', (e, info?: { builder?: boolean; current?: boolean }) => {
    const sender = windowOf(e);
    if (!sender) return;
    popupMenu(Menu.buildFromTemplate([
      { label: 'View…', click: () => sender.webContents.send('ui:event', { type: 'version-view' }) },
      { label: 'Compare with Current…', enabled: !info?.current, click: () => sender.webContents.send('ui:event', { type: 'version-compare' }) },
      { type: 'separator' },
      {
        label: info?.builder ? 'Edit with Agent' : 'Restore',
        enabled: !!info?.builder || !info?.current,
        click: () => sender.webContents.send('ui:event', { type: 'version-restore' }),
      },
    ]), { window: sender });
  });

  ipc.on('context-menu:tasks-empty', (e) => {
    const sender = windowOf(e);
    if (!sender) return;
    popupMenu(Menu.buildFromTemplate([{ label: 'New Folder…', click: () => host.openNewFolder() }]), { window: sender });
  });

  // A task list's header: its View-menu options (the pane's, or the single list's), then New Folder.
  ipc.on('context-menu:pane', (e, info: { pane?: PaneId }) => {
    const sender = windowOf(e);
    if (!sender) return;
    const view = engine.settings.view;
    const update = (patch: Partial<View>) => engine.updateSettings({ view: { ...engine.settings.view, ...patch } });
    popupMenu(Menu.buildFromTemplate([
      ...(info.pane ? paneMenuItems(view, info.pane, update) : singleMenuItems(view, update)),
      { type: 'separator' },
      { label: 'New Folder…', click: () => host.openNewFolder() },
    ]), { window: sender });
  });

  ipc.on(
    'context-menu:message',
    (e, info: { taskId: string; runId: string; agentId?: string; file?: string; text?: string; label?: string }) => {
      const sender = windowOf(e);
      if (!sender) return;
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (info.file) {
        const file = info.file;
        items.push({
          label: 'Open File',
          click: () =>
            void openTargetPath(info.taskId, file).catch((err: unknown) => {
              void showMessageBox(sender, {
                type: 'error',
                title: 'Looper',
                message: `Could not open ${file}.`,
                detail: err instanceof Error ? err.message : String(err),
                buttons: ['OK'],
              });
            }),
        });
        items.push({ label: 'Copy Path', click: () => writeClipboard(file) });
      }
      if (info.agentId) {
        if (items.length) items.push({ type: 'separator' });
        items.push({
          label: 'Open Subagent Conversation',
          click: () => host.openMessages(info.taskId, info.runId, info.agentId, info.label),
        });
      }
      if (info.text) {
        const text = info.text;
        if (items.length) items.push({ type: 'separator' });
        items.push({ label: 'Copy Content', click: () => writeClipboard(text) });
      }
      if (items.length > 0) popupMenu(Menu.buildFromTemplate(items), { window: sender });
    },
  );

  // The filter window hands its value to the parent conversation window and closes.
  ipc.on('messages:filter-apply', (e, value: string) => {
    const win = windowOf(e);
    const parent = win?.getParentWindow();
    if (parent && !parent.isDestroyed()) {
      parent.webContents.send('ui:event', { type: 'messages-filter', value: String(value ?? '') });
    }
    win?.close();
  });

  ipc.on('context-menu:run', (e, info: { taskId: string; runId: string; details: string }) => {
    const sender = windowOf(e);
    if (!sender) return;
    const canContinue = engine.canContinueRun(info.taskId, info.runId);
    const canGuide = engine.canGuideRun(info.taskId, info.runId);
    const showError = (err: unknown) =>
      void showMessageBox(sender, {
        type: 'error',
        title: 'Looper',
        message: err instanceof Error ? err.message : String(err),
        buttons: ['OK'],
      });
    const menu = Menu.buildFromTemplate([
      { label: 'Open', click: () => host.openMessages(info.taskId, info.runId) },
      { label: 'Copy Details', enabled: !!info.details, click: () => writeClipboard(info.details) },
      { type: 'separator' },
      {
        label: 'Send Guidance…',
        enabled: canGuide,
        click: () => host.openSendGuidance(info.taskId, info.runId),
      },
      {
        label: 'Continue in Terminal',
        enabled: canContinue.terminal,
        click: () => void host.openTerminal(info.taskId, info.runId).catch(showError),
      },
      {
        label: 'Continue in Chat',
        enabled: canContinue.chat,
        click: () => void host.openChat(info.taskId, info.runId).catch(showError),
      },
      {
        label: 'Continue Compacted',
        enabled: canContinue.compact,
        click: () => void host.compactRun(info.taskId, info.runId).catch(showError),
      },
      {
        label: 'Continue with Guidance…',
        enabled: canContinue.guidance,
        click: () => host.openContinueRun(info.taskId, info.runId),
      },
      { type: 'separator' },
      { label: 'Open Run Folder', platforms: DESKTOP_ONLY, click: () => void openPath(engine.runDir(info.taskId, info.runId)) },
      { label: 'Copy Run Folder Path', click: () => writeClipboard(engine.runDir(info.taskId, info.runId)) },
    ]);
    popupMenu(menu, { window: sender });
  });

  const sendTo = (windows: AppWindow[], event: EngineEvent) => {
    for (const w of windows) if (!w.isDestroyed()) w.webContents.send('engine:event', event);
  };
  broadcast = (event) => {
    // A builder's conversation goes to its own windows only: it is large and nobody else shows it.
    if (event.type === 'builder' || event.type === 'builder:data') {
      return sendTo(host.builderWindow(event.type === 'builder' ? event.state.id : event.id), event);
    }
    // A chat's whole conversation, and a session's activity, go only to the Sessions windows showing them.
    if (event.type === 'chat' || event.type === 'session:activity') {
      return sendTo(host.sessionWindow(event.type === 'chat' ? event.state.id : event.activity.id), event);
    }
    // Likewise a terminal session's output: only the windows showing it.
    if (event.type === 'terminal:data' || event.type === 'terminal:end') return sendTo(host.terminalWindow(event.id), event);
    sendTo(allWindows(), event);
  };
  engine.on((event) => broadcast(event));
}

let broadcast: (event: EngineEvent) => void = () => undefined;

/** Send an event to the windows the way engine events go; for events from outside the engine (Remote Access). */
export function broadcastEvent(event: EngineEvent): void {
  broadcast(event);
}
