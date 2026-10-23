import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import type { Engine } from '../engine/engine';
import { convertWslPath, detectSystemLocale, detectWslMountPrefix, listWslDistros } from '../engine/host';
import { discoverHarnessModels } from '../engine/discover-models';
import { FILE_KINDS, wrapLooperFile, type LooperFileKind } from '../shared/files';
import { folderParents, folderSubtree } from '../shared/folders';
import { resolveEnvironment, resolveHarness } from '../shared/environments';

import type { AppInfo } from '../shared/api';
import type { BuilderSetup } from '../shared/builder';
import type { Attachment, AttachmentInput } from '../shared/chat';
import type { PaneId } from '../shared/panes';
import type { RunFilter } from '../shared/runs';
import type { Task, TaskFolder, View } from '../shared/types';
import { paneMenuItems, singleMenuItems } from './view-menu';

export interface IpcHost {
  getWindow: () => BrowserWindow | null;
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

  openEnvEditor: (envId: string, isNew?: boolean, parent?: BrowserWindow | null) => void;
  openHarnessEditor: (envId: string, harnessId: string, isNew?: boolean, parent?: BrowserWindow | null) => void;
  openModelEditor: (envId: string, harnessId: string, index?: number, parent?: BrowserWindow | null) => void;
  openModelUpdate: (envId?: string, harnessId?: string, parent?: BrowserWindow | null) => void;
  openTemplateEditor: (templateId?: string, parent?: BrowserWindow | null) => void;
  openTemplatePicker: () => void;
  openEditorFromTemplate: (templateId: string) => void;
  /** The task's Version History window (one per task). */
  openVersions: (taskId: string) => void;
  /** A version's View or Compare window. */
  openVersionDetail: (taskId: string, n: number, compare: boolean, parent: BrowserWindow | null) => void;
  /** The New Task with Agent setup window. */
  openBuilderSetup: () => void;
  /** Start a builder from its setup window, which then becomes the conversation. */
  startBuilder: (setupWindow: BrowserWindow | null, setup: BuilderSetup) => void;
  /** Edit with Agent: a builder on the task, or the one already open brought forward. */
  editWithAgent: (taskId: string) => Promise<void>;
  /** Create/Update: the import editor prefilled with the builder's draft. */
  reviewBuilder: (builderId: string) => void;
  /** The window of a builder, which alone gets its events. */
  builderWindow: (builderId: string) => BrowserWindow | undefined;
  /**
   * Open Project in Terminal / Continue in Terminal (with a run id): a Looper
   * terminal window or the system's terminal, as the setting says. Rejects
   * with the reason when the session can't start.
   */
  openTerminal: (taskId: string, runId?: string) => Promise<void>;
  /** The Looper terminal window of a session, which alone gets its events. */
  terminalWindow: (sessionId: string) => BrowserWindow | undefined;
  /** Open Project in Chat / Continue in Chat (with a run id). Rejects with the reason when the chat can't start. */
  openChat: (taskId: string, runId?: string) => Promise<void>;
  /** Fork from Here: a new chat window with the conversation up to the row at `index`. Throws with the reason. */
  forkChat: (chatId: string, index: number) => void;
  /** The window of a chat, which alone gets its events. */
  chatWindow: (chatId: string) => BrowserWindow | undefined;
  /** A Remote Control conversation: an open one in a Looper terminal window, an ended one in its run window. */
  openRemoteConversation: (id: string) => Promise<void>;
  openRemoteHelperEditor: (id: string, isNew: boolean, parent: BrowserWindow | null) => void;
  openRemoteProjectEditor: (id: string, isNew: boolean, parent: BrowserWindow | null) => void;
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
  ) => void;
}

/** Menu labels show `&` as a mnemonic marker: a literal one is doubled. */
const menuText = (s: string): string => s.replace(/&/g, '&&');

/** Menu items for picking a task: the sidebar's folders as submenus (empty ones left out), then the top-level tasks. */
function tasksByFolder(folders: TaskFolder[], tasks: Task[], pick: (t: Task) => void): Electron.MenuItemConstructorOptions[] {
  const parents = folderParents(folders);
  const containerOf = (t: Task) => (t.folderId && parents.has(t.folderId) ? t.folderId : '');
  const build = (container: string): Electron.MenuItemConstructorOptions[] => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    for (const f of folders) {
      if (parents.get(f.id) !== container) continue;
      const sub = build(f.id);
      if (sub.length) items.push({ label: menuText(f.name), submenu: sub });
    }
    for (const t of tasks) if (containerOf(t) === container) items.push({ label: menuText(t.name), click: () => pick(t) });
    return items;
  };
  return build('');
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
  ipcMain.handle('info', (): AppInfo => ({
    version: app.getVersion(),
    dataDir: engine.dataDir,
    inboxDir: engine.inboxDir(),
    host: engine.host,
    locale: detectSystemLocale(),
    settings: engine.settings,
  }));

  ipcMain.handle('tasks:list', () => engine.listTasks());
  ipcMain.handle('tasks:save', (_e, input: unknown, opts?: { builderId?: string }) =>
    engine.saveTask(input, opts?.builderId ? { builderId: String(opts.builderId) } : undefined),
  );
  ipcMain.handle('versions:list', (_e, id: string) => engine.listVersions(id));
  ipcMain.handle('versions:detail', (_e, id: string, n: number, compare?: boolean) => engine.versionDetail(id, n, compare));
  ipcMain.handle('versions:restore', (_e, id: string, n: number) => engine.restoreVersion(id, n));
  ipcMain.handle('versions:open', (_e, id: string) => host.openVersions(id));
  ipcMain.handle('versions:openDetail', (e, id: string, n: number, compare: boolean) =>
    host.openVersionDetail(id, n, !!compare, BrowserWindow.fromWebContents(e.sender)),
  );
  ipcMain.handle('builder:start', (e, setup: BuilderSetup) => host.startBuilder(BrowserWindow.fromWebContents(e.sender), setup));
  ipcMain.handle('builder:get', (_e, id: string) => engine.getBuilder(id) ?? null);
  ipcMain.on('builder:send', (_e, id: string, text: string) => engine.sendBuilder(id, String(text ?? '')));
  ipcMain.handle('builder:review', (_e, id: string) => host.reviewBuilder(id));
  ipcMain.handle('builder:save', (_e, id: string) => engine.saveBuilder(id));
  ipcMain.handle('builder:undo', (_e, id: string) => engine.undoBuilder(id));
  ipcMain.handle('builder:redo', (_e, id: string) => engine.redoBuilder(id));
  ipcMain.handle('builder:forTask', (_e, taskId: string) => engine.builderForTask(taskId) ?? null);
  ipcMain.handle('builder:loadVersion', async (_e, taskId: string, n: number) => {
    const id = engine.builderForTask(taskId);
    if (!id) throw new Error("The task's Edit Task with Agent window was closed.");
    await engine.loadBuilderVersion(id, n);
    host.builderWindow(id)?.focus();
  });
  ipcMain.handle('builder:editTask', (_e, taskId: string) => host.editWithAgent(taskId));
  ipcMain.handle('builder:openNew', () => host.openBuilderSetup());
  ipcMain.handle('builder:output', (_e, id: string) => engine.builderOutput(id));
  ipcMain.on('builder:write', (_e, id: string, data: string) => engine.writeBuilder(id, data));
  ipcMain.on('builder:resize', (_e, id: string, cols: number, rows: number) => engine.resizeBuilder(id, cols, rows));
  ipcMain.handle('tasks:remove', (_e, id: string) => engine.removeTask(id));
  ipcMain.handle('recycleBin:list', () => engine.listRecycleBin());
  ipcMain.handle('recycleBin:restore', (_e, id: string) => engine.restoreTask(id));
  ipcMain.handle('recycleBin:delete', (_e, id: string) => engine.purgeTask(id));
  ipcMain.handle('recycleBin:empty', () => engine.emptyRecycleBin());
  /** Save dialog, then write the definition as a Looper document of the given kind. */
  const exportDocument = async (e: Electron.IpcMainInvokeEvent, kind: LooperFileKind, item?: Task): Promise<void> => {
    if (!item) return;
    const sender = BrowserWindow.fromWebContents(e.sender);
    const { ext, filterName } = FILE_KINDS[kind];
    const options: Electron.SaveDialogOptions = {
      title: kind === 'task' ? 'Export Task' : 'Export Template',
      defaultPath: `${item.id}.${ext}`,
      filters: [{ name: filterName, extensions: [ext] }],
    };
    const result = sender ? await dialog.showSaveDialog(sender, options) : await dialog.showSaveDialog(options);
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
      if (sender) await dialog.showMessageBox(sender, opts);
      else await dialog.showMessageBox(opts);
    }
  };
  ipcMain.handle('tasks:export', (e, id: string) => exportDocument(e, 'task', engine.getTask(id)));

  ipcMain.handle(
    'tasks:reorder',
    (
      _e,
      ids: string[],
      folders?: Record<string, string | null>,
      layout?: Record<string, string[]>,
      parents?: Record<string, string | null>,
    ) => engine.reorderTasks(ids, folders, layout, parents),
  );
  ipcMain.handle('folders:list', () => engine.listFolders());
  ipcMain.handle('folders:layout', () => engine.listLayout());
  ipcMain.handle('folders:add', (_e, name: string, parentId?: string) => engine.addFolder(name, parentId));
  ipcMain.handle('folders:rename', (_e, id: string, name: string) => engine.renameFolder(id, name));
  ipcMain.handle('folders:remove', (_e, id: string) => engine.removeFolder(id));

  ipcMain.handle('templates:list', () => engine.listTemplates());
  ipcMain.handle('templates:save', (_e, input: unknown) => engine.saveTemplate(input));
  ipcMain.handle('templates:remove', (_e, id: string) => engine.removeTemplate(id));
  ipcMain.handle('templates:reorder', (_e, ids: string[]) => engine.reorderTemplates(ids));
  ipcMain.handle('templates:export', (e, id: string) =>
    exportDocument(e, 'template', engine.listTemplates().find((t) => t.id === id)),
  );
  ipcMain.handle('templates:import', async (e) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    const options: Electron.OpenDialogOptions = {
      title: 'Import Template',
      filters: [{ name: FILE_KINDS.template.filterName, extensions: [FILE_KINDS.template.ext] }],
      properties: ['openFile'],
    };
    const result = sender ? await dialog.showOpenDialog(sender, options) : await dialog.showOpenDialog(options);
    const file = result.canceled ? undefined : result.filePaths[0];
    if (file) await host.openLooperFile(file);
  });
  /** A Looper document dropped onto a window; behaves exactly like double-clicking it. */
  ipcMain.handle('file:openLooper', (_e, file: string) => host.openLooperFile(file));

  ipcMain.handle('rest:state', () => engine.restState());

  ipcMain.handle('runtime:list', () => engine.listRuntimes());
  // With the setting on, the run is started by the Run Options window instead.
  ipcMain.handle('runtime:runNow', (_e, id: string) =>
    engine.settings.promptRunOptions ? host.promptRunOptions(id) : engine.runNow(id),
  );
  ipcMain.handle('runtime:pause', (_e, id: string) => engine.pause(id));
  ipcMain.handle('runtime:resume', (_e, id: string) => engine.resume(id));
  ipcMain.handle('runtime:complete', (_e, id: string) => engine.completeTask(id));
  ipcMain.handle('runtime:reopen', (_e, id: string) => engine.reopenTask(id));
  ipcMain.handle('runtime:stopTask', (_e, id: string, runId?: string) => engine.stopTask(id, undefined, runId));

  ipcMain.handle('runs:list', (_e, id: string, limit?: number) => engine.listRuns(id, limit));
  ipcMain.handle('runs:recent', (_e, limit: number, filter: RunFilter) => engine.recentRuns(limit, filter));
  ipcMain.handle('runs:output', (_e, id: string, runId: string, raw?: boolean) => engine.readOutput(id, runId, undefined, raw));
  ipcMain.handle('runs:openDir', (_e, id: string, runId: string) => shell.openPath(engine.runDir(id, runId)));
  ipcMain.handle('runs:clear', (_e, id: string) => engine.clearRuns(id));
  ipcMain.handle('runs:messages', (_e, id: string, runId: string, agentId?: string, raw?: boolean) =>
    engine.readMessages(id, runId, agentId, raw),
  );
  ipcMain.handle('runs:messageImage', (_e, id: string, runId: string, rowId: string, agentId?: string) =>
    engine.readMessageImage(id, runId, rowId, agentId),
  );
  ipcMain.handle('messages:open', (_e, taskId: string, runId: string, agentId?: string, label?: string) =>
    host.openMessages(taskId, runId, agentId, label),
  );
  ipcMain.handle('messages:openImage', (_e, taskId: string, runId: string, rowId: string, agentId?: string, label?: string) =>
    host.openMessageImage(taskId, runId, rowId, agentId, label),
  );

  ipcMain.handle('engineLog:read', () => engine.readEngineLog());

  ipcMain.handle('task:openTerminal', (_e, id: string, runId?: string) => host.openTerminal(id, runId));
  ipcMain.handle('terminalSession:output', (_e, id: string) => engine.terminalSessionOutput(id));
  ipcMain.on('terminalSession:write', (_e, id: string, data: string) => engine.writeTerminalSession(id, data));
  ipcMain.on('terminalSession:resize', (_e, id: string, cols: number, rows: number) =>
    engine.resizeTerminalSession(id, cols, rows),
  );
  ipcMain.handle('terminalSession:attach', (_e, id: string, files: unknown) => engine.attachToTerminal(id, attachmentInputs(files)));
  ipcMain.on('context-menu:terminal', (e, id: string, hasSelection: boolean) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    const send = (payload: unknown) => {
      if (!sender.isDestroyed()) sender.webContents.send('ui:event', payload);
    };
    const attachFiles = async () => {
      const r = await dialog.showOpenDialog(sender, { title: 'Attach Files', properties: ['openFile', 'multiSelections'] });
      if (r.canceled || r.filePaths.length === 0) return;
      const files = r.filePaths.map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, path: p }));
      send({ type: 'terminal-attached', text: engine.attachToTerminal(id, files) });
    };
    Menu.buildFromTemplate([
      { label: 'Copy', enabled: !!hasSelection, click: () => send({ type: 'terminal-copy' }) },
      { label: 'Paste', click: () => send({ type: 'terminal-paste' }) },
      { type: 'separator' },
      {
        label: 'Attach Files…',
        click: () =>
          void attachFiles().catch((err: unknown) => {
            void dialog.showMessageBox(sender, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'] });
          }),
      },
    ]).popup({ window: sender });
  });

  ipcMain.handle('task:openChat', (_e, id: string, runId?: string) => host.openChat(id, runId));
  ipcMain.handle('chat:get', (_e, id: string) => engine.getChat(id) ?? null);
  ipcMain.on('chat:send', (_e, id: string, text: string, attachments: Attachment[]) => {
    // Only Looper's own copies: the renderer never makes the agent read any other file.
    const files = (Array.isArray(attachments) ? attachments : [])
      .filter((a) => engine.isAttachment(String(a?.path)))
      .map((a) => ({ name: String(a.name), path: String(a.path), image: !!a.image }));
    engine.sendChat(id, String(text ?? ''), files);
  });
  ipcMain.on('chat:answer', (_e, id: string, requestId: string, allow: boolean) => engine.answerChat(id, requestId, !!allow));
  ipcMain.handle('chat:stop', (_e, id: string) => engine.stopChat(String(id)));
  // A chat message's right-click menu; Edit as New Message hands the message back to the window's message box.
  ipcMain.on(
    'context-menu:chat',
    (
      e,
      info: {
        chatId: string;
        taskId: string;
        selection?: string;
        text?: string;
        textLabel?: string;
        result?: string;
        file?: string;
        resend?: { text: string; attachments: Attachment[] };
        fork?: number;
      },
    ) => {
      const sender = BrowserWindow.fromWebContents(e.sender);
      if (!sender) return;
      const groups: Electron.MenuItemConstructorOptions[][] = [];
      if (info.selection) groups.push([{ label: 'Copy', click: () => clipboard.writeText(info.selection!) }]);
      const copies: Electron.MenuItemConstructorOptions[] = [];
      if (info.text) copies.push({ label: info.textLabel ?? 'Copy Message', click: () => clipboard.writeText(info.text!) });
      if (info.result) copies.push({ label: 'Copy Result', click: () => clipboard.writeText(info.result!) });
      if (copies.length) groups.push(copies);
      if (info.file) {
        const file = info.file;
        groups.push([
          {
            label: 'Open File',
            click: () =>
              void openTargetPath(info.taskId, file).catch((err: unknown) => {
                void dialog.showMessageBox(sender, {
                  type: 'error',
                  title: 'Looper',
                  message: `Could not open ${file}.`,
                  detail: err instanceof Error ? err.message : String(err),
                  buttons: ['OK'],
                });
              }),
          },
          { label: 'Copy Path', click: () => clipboard.writeText(file) },
        ]);
      }
      const again: Electron.MenuItemConstructorOptions[] = [];
      if (info.resend) {
        const resend = info.resend;
        again.push({ label: 'Edit as New Message', click: () => sender.webContents.send('ui:event', { type: 'chat-edit', ...resend }) });
      }
      if (typeof info.fork === 'number') {
        const index = info.fork;
        again.push({
          label: 'Fork from Here',
          click: () => {
            try {
              host.forkChat(String(info.chatId), index);
            } catch (err) {
              void dialog.showMessageBox(sender, {
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
      if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: sender });
    },
  );
  ipcMain.handle('chat:attach', (_e, id: string, files: unknown) => engine.attachToChat(id, attachmentInputs(files)));
  /** An attachment opens in its default app; nothing outside Looper's attachment copies does. */
  ipcMain.handle('attachment:open', async (_e, p: string) => {
    if (!engine.isAttachment(String(p))) return;
    const err = await shell.openPath(String(p));
    if (err) throw new Error(err);
  });
  ipcMain.handle('attachment:thumbnail', (_e, p: string) => {
    if (!engine.isAttachment(String(p))) return null;
    const img = nativeImage.createFromPath(String(p));
    if (img.isEmpty()) return null;
    const { height } = img.getSize();
    return (height > THUMBNAIL_HEIGHT ? img.resize({ height: THUMBNAIL_HEIGHT }) : img).toDataURL();
  });
  ipcMain.handle('run:continue', (_e, id: string, runId: string, guidance: string) =>
    engine.continueRun(id, runId, guidance),
  );
  ipcMain.handle('run:canGuide', (_e, id: string, runId: string) => engine.canGuideRun(id, runId));
  ipcMain.handle('run:guide', (_e, id: string, runId: string, text: string) => engine.sendGuidance(id, runId, text));

  /** Open a target-native path (file or folder) on the host, translating across the WSL boundary. */
  const openTargetPath = async (taskId: string, p: string): Promise<void> => {
    const task = engine.getTask(taskId);
    const env = task ? engine.settings.environments.find((x) => x.id === task.environmentId) : undefined;
    const distro = env?.kind === 'wsl' ? env.distro : undefined;
    let hostPath = p;
    if (process.platform === 'win32' && p.startsWith('/')) {
      hostPath = (await convertWslPath(p, 'windows', distro)) ?? p;
    } else if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(p)) {
      hostPath = (await convertWslPath(p, 'posix', distro)) ?? p;
    }
    const err = await shell.openPath(hostPath);
    if (err) throw new Error(err);
  };

  ipcMain.handle('task:openWorkFolder', async (_e, id: string) => {
    const task = engine.getTask(id);
    if (!task) return;
    await openTargetPath(id, task.cwd);
  });

  ipcMain.handle('agent:buffer', (_e, id: string, runId?: string) => engine.agentBuffer(id, runId));
  ipcMain.on('agent:write', (_e, id: string, data: string, runId?: string) => engine.writeAgent(id, data, runId));
  ipcMain.on('agent:resize', (_e, id: string, cols: number, rows: number, runId?: string) =>
    engine.resizeAgent(id, cols, rows, runId),
  );

  ipcMain.handle('openPath', (_e, p: string) => shell.openPath(p));
  ipcMain.handle('editor:open', (_e, taskId?: string) => host.openEditor(taskId));
  ipcMain.handle('noteEditor:open', (_e, taskId: string) => host.openNoteEditor(taskId));
  ipcMain.handle('moveToFolder:open', (_e, taskId: string) => host.openMoveToFolder(taskId));

  ipcMain.handle('envEditor:open', (e, envId: string, isNew?: boolean) =>
    host.openEnvEditor(envId, isNew, BrowserWindow.fromWebContents(e.sender)),
  );
  ipcMain.handle('harnessEditor:open', (e, envId: string, harnessId: string, isNew?: boolean) =>
    host.openHarnessEditor(envId, harnessId, isNew, BrowserWindow.fromWebContents(e.sender)),
  );
  ipcMain.handle('modelEditor:open', (e, envId: string, harnessId: string, index?: number) =>
    host.openModelEditor(envId, harnessId, index, BrowserWindow.fromWebContents(e.sender)),
  );
  ipcMain.handle('modelUpdate:open', (e, envId?: string, harnessId?: string) =>
    host.openModelUpdate(envId, harnessId, BrowserWindow.fromWebContents(e.sender)),
  );
  ipcMain.handle('models:discover', (_e, envId: string, harnessId: string) => {
    const env = engine.settings.environments.find((x) => x.id === envId);
    const harness = env?.harnesses.find((h) => h.id === harnessId);
    if (!env || !harness) throw new Error('This harness no longer exists.');
    return discoverHarnessModels(env, harness, engine.host);
  });
  ipcMain.handle('templateEditor:open', (e, templateId?: string) =>
    host.openTemplateEditor(templateId, BrowserWindow.fromWebContents(e.sender)),
  );
  ipcMain.handle('templatePicker:open', () => host.openTemplatePicker());
  ipcMain.handle('editorFromTemplate:open', (_e, templateId: string) =>
    host.openEditorFromTemplate(templateId),
  );
  ipcMain.handle('import:draft', (_e, key: string) => host.takeImportDraft(key));

  // Fired from `beforeunload` when a freshly created environment/harness is
  // closed without saving, so create-on-add leaves no junk behind. `send`
  // (not invoke): the window is going away and cannot await a reply.
  // ---------- Remote Control ----------

  ipcMain.handle('remote:state', () => engine.remoteState());
  ipcMain.handle('remote:lastMessage', (_e, id: string) => engine.remoteLastMessage(String(id)));
  ipcMain.handle('remote:open', (_e, id: string) => host.openRemoteConversation(String(id)));
  ipcMain.handle('remote:openHelperEditor', (e, id: string, isNew?: boolean) =>
    host.openRemoteHelperEditor(String(id), !!isNew, BrowserWindow.fromWebContents(e.sender)),
  );
  ipcMain.handle('remote:openProjectEditor', (e, id: string, isNew?: boolean) =>
    host.openRemoteProjectEditor(String(id), !!isNew, BrowserWindow.fromWebContents(e.sender)),
  );
  // A new helper or folder project whose window closed without Create.
  ipcMain.on('remote:discard', (_e, kind: 'helper' | 'project', id: string) => {
    try {
      const r = engine.settings.remote;
      if (kind === 'helper') engine.updateSettings({ remote: { ...r, helpers: r.helpers.filter((h) => h.id !== id) } });
      else engine.updateSettings({ remote: { ...r, projects: r.projects.filter((p) => p.id !== id) } });
    } catch (err) {
      engine.log.error(`discard remote ${kind} ${id} failed: ${String(err)}`);
    }
  });
  // Add Task…: the Claude Code tasks not yet in the list, by folder; a pick adds the project right away.
  ipcMain.on('remote:addTaskMenu', (e) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    const r = engine.settings.remote;
    const listed = new Set(r.projects.flatMap((p) => (p.kind === 'task' ? [p.taskId] : [])));
    const claude = (t: Task) => {
      try {
        return resolveHarness(t, resolveEnvironment(t, engine.settings)).kind === 'claude-code';
      } catch {
        return false;
      }
    };
    const tasks = engine.listTasks().filter((t) => !listed.has(t.id) && claude(t));
    const pick = (t: Task) => {
      try {
        const rr = engine.settings.remote;
        const id = `p-${Math.random().toString(36).slice(2, 8)}`;
        engine.updateSettings({ remote: { ...rr, projects: [...rr.projects, { kind: 'task', id, taskId: t.id }] } });
      } catch (err) {
        void dialog.showMessageBox(sender, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'] });
      }
    };
    const items = tasksByFolder(engine.listFolders(), tasks, pick);
    Menu.buildFromTemplate(items.length ? items : [{ label: 'No other Claude Code tasks', enabled: false }]).popup({ window: sender });
  });
  ipcMain.on('context-menu:remote-conversation', (e, id: string) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    const state = engine.remoteState();
    const conv = state.conversations.find((c) => c.id === id);
    if (!conv) return;
    const open = conv.status !== 'ended';
    const restart = () => {
      try {
        engine.restartRemoteConversation(id);
      } catch (err) {
        void dialog.showMessageBox(sender, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'] });
      }
    };
    Menu.buildFromTemplate([
      { label: 'Open', click: () => void host.openRemoteConversation(id) },
      { label: 'Open in Browser', enabled: !!conv.link, click: () => conv.link && void shell.openExternal(conv.link) },
      { label: 'Copy Link', enabled: !!conv.link, click: () => conv.link && clipboard.writeText(conv.link) },
      { type: 'separator' },
      { label: 'Restart', enabled: state.running && conv.source !== 'helper' && conv.status !== 'waiting', click: restart },
      { label: 'Stop', enabled: open, click: () => engine.stopRemoteConversation(id) },
    ]).popup({ window: sender });
  });

  ipcMain.on('envEditor:discard', (_e, envId: string) => {
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
  ipcMain.on('harnessEditor:discard', (_e, envId: string, harnessId: string) => {
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
  ipcMain.handle('store:move', (_e, store: 'tasks' | 'templates', targetFile: string) =>
    engine.moveStoreFile(store, targetFile),
  );
  ipcMain.handle('settings:update', (_e, patch: unknown) => engine.updateSettings(patch));

  // Start-with-the-computer registration lives in the OS (login item / Run key),
  // not in settings.json. The args must match on get and set so Windows finds
  // the same registry entry; --hidden makes a login start go to the tray.
  // Only the packaged app registers: a dev run's execPath is the bare
  // electron.exe, which starts Electron's default window without the app path.
  const loginArgs = ['--hidden'];
  ipcMain.handle('loginItem:get', () => {
    if (!app.isPackaged) return false;
    try {
      return app.getLoginItemSettings({ args: loginArgs }).openAtLogin;
    } catch {
      return false; // not supported on this platform
    }
  });
  ipcMain.handle('loginItem:set', (_e, enabled: boolean) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, args: loginArgs });
  });

  ipcMain.handle(
    'dialog:pickSaveFile',
    async (e, defaultPath?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> => {
      const sender = BrowserWindow.fromWebContents(e.sender);
      const options: Electron.SaveDialogOptions = {
        title: 'Choose File Location',
        ...(defaultPath ? { defaultPath } : {}),
        ...(filters ? { filters } : {}),
      };
      const result = sender ? await dialog.showSaveDialog(sender, options) : await dialog.showSaveDialog(options);
      return result.canceled ? null : result.filePath;
    },
  );
  ipcMain.on(
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
    ) =>
      host.updateTaskMenu(hasTask, taskEnabled, taskPaused, taskState, hasNote, canRunNow, taskCompleted, allowComplete),
  );

  ipcMain.handle('dialog:error', async (e, message: string) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.MessageBoxOptions = { type: 'error', title: 'Looper', message, buttons: ['OK'] };
    if (sender) await dialog.showMessageBox(sender, opts);
    else await dialog.showMessageBox(opts);
  });
  ipcMain.handle('dialog:confirm', async (e, message: string) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.MessageBoxOptions = { type: 'question', title: 'Looper', message, buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1 };
    const result = sender ? await dialog.showMessageBox(sender, opts) : await dialog.showMessageBox(opts);
    return result.response === 0;
  });

  // Native directory picker, translating between the host's path style and the
  // environment's native one (flavor). WSL paths cross via \\wsl.localhost\
  // UNC shares plus `wslpath` for drive-mount paths.
  ipcMain.handle(
    'dialog:pickDir',
    async (e, current?: string, flavor?: 'posix' | 'windows', distro?: string): Promise<string | null> => {
      const sender = BrowserWindow.fromWebContents(e.sender);
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
      const result = sender ? await dialog.showOpenDialog(sender, options) : await dialog.showOpenDialog(options);
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

  ipcMain.handle('wsl:distros', () => listWslDistros());
  ipcMain.handle('wsl:mountPrefix', (_e, distro?: string) => detectWslMountPrefix(distro));

  ipcMain.on('context-menu:task', (e, info: { enabled: boolean; completed: boolean; allowComplete: boolean; state?: string; held: boolean; hasNote: boolean; activeRuns?: number; maxRuns?: number }) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    const active = info.state === 'running' || info.state === 'checking' || info.state === 'classifying';
    // A task allowed several simultaneous runs can start another until its cap.
    const canRun = !active || (info.activeRuns ?? 1) < (info.maxRuns ?? 1);
    const menu = Menu.buildFromTemplate([
      { label: 'Run Now', enabled: canRun, click: () => sender.webContents.send('ui:event', { type: 'run-now' }) },
      { label: 'Stop Task', enabled: active, click: () => sender.webContents.send('ui:event', { type: 'stop-task' }) },
      { label: info.state === 'paused' ? 'Resume' : 'Pause', enabled: info.state !== 'disabled' && !info.completed, click: () => sender.webContents.send('ui:event', { type: 'pause-resume' }) },
      { label: info.enabled ? 'Disable' : 'Enable', enabled: !info.completed, click: () => sender.webContents.send('ui:event', { type: 'enable-disable' }) },
      {
        label: info.completed ? 'Reopen' : 'Complete',
        enabled: info.completed || info.allowComplete,
        click: () => sender.webContents.send('ui:event', { type: 'complete-reopen' }),
      },
      { label: 'Edit Task…', click: () => sender.webContents.send('ui:event', { type: 'edit-task' }) },
      { label: 'Edit with Agent…', click: () => sender.webContents.send('ui:event', { type: 'edit-with-agent' }) },
      { label: 'Version History…', click: () => sender.webContents.send('ui:event', { type: 'version-history' }) },
      { label: 'Delete Task', click: () => sender.webContents.send('ui:event', { type: 'delete-task' }) },
      { type: 'separator' },
      { label: info.hasNote ? 'Edit Guidance for Next Run…' : 'Add Guidance for Next Run…', click: () => sender.webContents.send('ui:event', { type: 'edit-note' }) },
      { label: 'Clear Guidance', enabled: info.hasNote, click: () => sender.webContents.send('ui:event', { type: 'clear-note' }) },
      { type: 'separator' },
      { label: 'Move to Folder…', click: () => sender.webContents.send('ui:event', { type: 'move-to-folder' }) },
      { label: 'Clear Run History…', enabled: !active, click: () => sender.webContents.send('ui:event', { type: 'clear-runs' }) },
      { type: 'separator' },
      { label: 'Open Project in Terminal', click: () => sender.webContents.send('ui:event', { type: 'open-terminal' }) },
      { label: 'Open Project in Chat', click: () => sender.webContents.send('ui:event', { type: 'open-chat' }) },
      { label: 'Open Working Directory', click: () => sender.webContents.send('ui:event', { type: 'open-work-folder' }) },
    ]);
    menu.popup({ window: sender });
  });

  // Folder header context menu. Bulk actions run directly against the engine;
  // Run All skips disabled tasks and tasks already at their run cap.
  ipcMain.on('context-menu:folder', (e, info: { folderId: string }) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    // Folder actions apply to the whole subtree: nested folders included.
    const subtree = () => folderSubtree(engine.listFolders(), info.folderId);
    const members = () => {
      const ids = subtree();
      return engine.listTasks().filter((t) => t.folderId && ids.has(t.folderId));
    };
    const folderName = () => engine.listFolders().find((f) => f.id === info.folderId)?.name ?? '?';
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
        label: 'Delete Folder',
        click: () => {
          const count = members().length;
          const opts: Electron.MessageBoxOptions = {
            type: 'question',
            title: 'Looper',
            message: `Delete folder "${folderName()}"?`,
            // Unchecked, the folder's contents just move up to its parent.
            ...(count > 0
              ? {
                  checkboxLabel: 'Also delete tasks inside',
                  checkboxChecked: false,
                }
              : {}),
            buttons: ['Yes', 'No'],
            defaultId: 0,
            cancelId: 1,
          };
          void dialog.showMessageBox(sender, opts).then((r) => {
            if (r.response !== 0) return;
            if (r.checkboxChecked) {
              // Delete the whole subtree: every task in it, then every nested folder.
              for (const t of members()) engine.removeTask(t.id);
              for (const id of subtree()) if (id !== info.folderId) engine.removeFolder(id);
            }
            engine.removeFolder(info.folderId);
          });
        },
      },
    ]);
    menu.popup({ window: sender });
  });

  ipcMain.on('context-menu:recycle-bin', (e) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    Menu.buildFromTemplate([
      { label: 'Restore', click: () => sender.webContents.send('ui:event', { type: 'bin-restore' }) },
      { label: 'Delete', click: () => sender.webContents.send('ui:event', { type: 'bin-delete' }) },
    ]).popup({ window: sender });
  });

  ipcMain.on('context-menu:version', (e, info?: { builder?: boolean }) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    Menu.buildFromTemplate([
      { label: 'View…', click: () => sender.webContents.send('ui:event', { type: 'version-view' }) },
      { label: 'Compare with Current…', click: () => sender.webContents.send('ui:event', { type: 'version-compare' }) },
      { type: 'separator' },
      {
        label: info?.builder ? 'Edit with Agent' : 'Restore',
        click: () => sender.webContents.send('ui:event', { type: 'version-restore' }),
      },
    ]).popup({ window: sender });
  });

  ipcMain.on('context-menu:tasks-empty', (e) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    Menu.buildFromTemplate([{ label: 'New Folder…', click: () => host.openNewFolder() }]).popup({ window: sender });
  });

  // A task list's header: its View-menu options (the pane's, or the single list's), then New Folder.
  ipcMain.on('context-menu:pane', (e, info: { pane?: PaneId }) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    const view = engine.settings.view;
    const update = (patch: Partial<View>) => engine.updateSettings({ view: { ...engine.settings.view, ...patch } });
    Menu.buildFromTemplate([
      ...(info.pane ? paneMenuItems(view, info.pane, update) : singleMenuItems(view, update)),
      { type: 'separator' },
      { label: 'New Folder…', click: () => host.openNewFolder() },
    ]).popup({ window: sender });
  });

  ipcMain.on(
    'context-menu:message',
    (e, info: { taskId: string; runId: string; agentId?: string; file?: string; text?: string; label?: string }) => {
      const sender = BrowserWindow.fromWebContents(e.sender);
      if (!sender) return;
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (info.file) {
        const file = info.file;
        items.push({
          label: 'Open File',
          click: () =>
            void openTargetPath(info.taskId, file).catch((err: unknown) => {
              void dialog.showMessageBox(sender, {
                type: 'error',
                title: 'Looper',
                message: `Could not open ${file}.`,
                detail: err instanceof Error ? err.message : String(err),
                buttons: ['OK'],
              });
            }),
        });
        items.push({ label: 'Copy Path', click: () => clipboard.writeText(file) });
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
        items.push({ label: 'Copy Content', click: () => clipboard.writeText(text) });
      }
      if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: sender });
    },
  );

  // The filter window hands its value to the parent conversation window and closes.
  ipcMain.on('messages:filter-apply', (e, value: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const parent = win?.getParentWindow();
    if (parent && !parent.isDestroyed()) {
      parent.webContents.send('ui:event', { type: 'messages-filter', value: String(value ?? '') });
    }
    win?.close();
  });

  ipcMain.on('context-menu:run', (e, info: { taskId: string; runId: string; details: string }) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    const canContinue = engine.canContinueRun(info.taskId, info.runId);
    const canGuide = engine.canGuideRun(info.taskId, info.runId);
    const showError = (err: unknown) =>
      void dialog.showMessageBox(sender, {
        type: 'error',
        title: 'Looper',
        message: err instanceof Error ? err.message : String(err),
        buttons: ['OK'],
      });
    const menu = Menu.buildFromTemplate([
      { label: 'Open', click: () => host.openMessages(info.taskId, info.runId) },
      { label: 'Copy Details', enabled: !!info.details, click: () => clipboard.writeText(info.details) },
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
        label: 'Continue with Guidance…',
        enabled: canContinue.guidance,
        click: () => host.openContinueRun(info.taskId, info.runId),
      },
      { type: 'separator' },
      { label: 'Open Run Folder', click: () => void shell.openPath(engine.runDir(info.taskId, info.runId)) },
      { label: 'Copy Run Folder Path', click: () => clipboard.writeText(engine.runDir(info.taskId, info.runId)) },
    ]);
    menu.popup({ window: sender });
  });

  engine.on((event) => {
    // A builder's conversation goes to its own window only: it is large and nobody else shows it.
    if (event.type === 'builder' || event.type === 'builder:data') {
      const w = host.builderWindow(event.type === 'builder' ? event.state.id : event.id);
      if (w && !w.isDestroyed()) w.webContents.send('engine:event', event);
      return;
    }
    if (event.type === 'chat') {
      const w = host.chatWindow(event.state.id);
      if (w && !w.isDestroyed()) w.webContents.send('engine:event', event);
      return;
    }
    // Likewise a terminal session's output: only its window shows it.
    if (event.type === 'terminal:data' || event.type === 'terminal:end') {
      const w = host.terminalWindow(event.id);
      if (w && !w.isDestroyed()) w.webContents.send('engine:event', event);
      return;
    }
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('engine:event', event);
    }
  });
}
