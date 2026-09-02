import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import fs from 'node:fs';
import type { Engine } from '../engine/engine';
import { convertWslPath, detectWslMountPrefix, listWslDistros } from '../engine/host';

import type { AppInfo } from '../shared/api';

export interface IpcHost {
  getWindow: () => BrowserWindow | null;
  openRunDetail: (taskId: string, runId: string) => void;
  openEditor: (taskId?: string) => void;

  openEnvEditor: (envId: string, isNew?: boolean, parent?: BrowserWindow | null) => void;
  openHarnessEditor: (envId: string, harnessId: string, isNew?: boolean, parent?: BrowserWindow | null) => void;
  openModelEditor: (envId: string, harnessId: string, index?: number, parent?: BrowserWindow | null) => void;
  openTemplateEditor: (templateId?: string, parent?: BrowserWindow | null) => void;
  openTemplatePicker: () => void;
  openEditorFromTemplate: (templateId: string) => void;
  takeImportDraft: (key: string) => unknown;
  updateTaskMenu: (hasTask: boolean, taskEnabled?: boolean, taskPaused?: boolean, taskState?: string) => void;
}

export function registerIpc(engine: Engine, host: IpcHost): void {
  ipcMain.handle('info', (): AppInfo => ({
    version: app.getVersion(),
    dataDir: engine.dataDir,
    inboxDir: engine.inboxDir(),
    host: engine.host,
    settings: engine.settings,
  }));

  ipcMain.handle('tasks:list', () => engine.listTasks());
  ipcMain.handle('tasks:save', (_e, input: unknown) => engine.saveTask(input));
  ipcMain.handle('tasks:remove', (_e, id: string) => engine.removeTask(id));
  ipcMain.handle('tasks:export', async (e, id: string) => {
    const task = engine.getTask(id);
    if (!task) return;
    const sender = BrowserWindow.fromWebContents(e.sender);
    const options: Electron.SaveDialogOptions = {
      title: 'Export Task',
      defaultPath: `${task.id}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const result = sender ? await dialog.showSaveDialog(sender, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return;
    const data = { ...task };
    delete data.createdAt;
    delete data.updatedAt;
    try {
      fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (err) {
      const opts: Electron.MessageBoxOptions = {
        type: 'error',
        title: 'Looper',
        message: 'Could not export task.',
        detail: (err as Error).message,
        buttons: ['OK'],
      };
      if (sender) await dialog.showMessageBox(sender, opts);
      else await dialog.showMessageBox(opts);
    }
  });

  ipcMain.handle('templates:list', () => engine.listTemplates());
  ipcMain.handle('templates:save', (_e, input: unknown) => engine.saveTemplate(input));
  ipcMain.handle('templates:remove', (_e, id: string) => engine.removeTemplate(id));

  ipcMain.handle('runtime:list', () => engine.listRuntimes());
  ipcMain.handle('runtime:runNow', (_e, id: string) => engine.runNow(id));
  ipcMain.handle('runtime:pause', (_e, id: string) => engine.pause(id));
  ipcMain.handle('runtime:resume', (_e, id: string) => engine.resume(id));
  ipcMain.handle('runtime:stopAgent', (_e, id: string) => engine.stopAgent(id));

  ipcMain.handle('runs:list', (_e, id: string, limit?: number) => engine.listRuns(id, limit));
  ipcMain.handle('runs:output', (_e, id: string, runId: string, raw?: boolean) => engine.readOutput(id, runId, undefined, raw));
  ipcMain.handle('runs:openDir', (_e, id: string, runId: string) => shell.openPath(engine.runDir(id, runId)));

  ipcMain.handle('agent:buffer', (_e, id: string) => engine.agentBuffer(id));
  ipcMain.on('agent:write', (_e, id: string, data: string) => engine.writeAgent(id, data));
  ipcMain.on('agent:resize', (_e, id: string, cols: number, rows: number) =>
    engine.resizeAgent(id, cols, rows),
  );

  ipcMain.handle('openPath', (_e, p: string) => shell.openPath(p));
  ipcMain.handle('runDetail:open', (_e, taskId: string, runId: string) => host.openRunDetail(taskId, runId));
  ipcMain.handle('editor:open', (_e, taskId?: string) => host.openEditor(taskId));

  ipcMain.handle('envEditor:open', (e, envId: string, isNew?: boolean) =>
    host.openEnvEditor(envId, isNew, BrowserWindow.fromWebContents(e.sender)),
  );
  ipcMain.handle('harnessEditor:open', (e, envId: string, harnessId: string, isNew?: boolean) =>
    host.openHarnessEditor(envId, harnessId, isNew, BrowserWindow.fromWebContents(e.sender)),
  );
  ipcMain.handle('modelEditor:open', (e, envId: string, harnessId: string, index?: number) =>
    host.openModelEditor(envId, harnessId, index, BrowserWindow.fromWebContents(e.sender)),
  );
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
  ipcMain.on('ui:selection', (_e, hasTask: boolean, taskEnabled?: boolean, taskPaused?: boolean, taskState?: string) => host.updateTaskMenu(hasTask, taskEnabled, taskPaused, taskState));

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

  ipcMain.on('context-menu:task', (e, info: { enabled: boolean; state?: string; held: boolean }) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    const active = info.state === 'running' || info.state === 'checking' || info.state === 'classifying';
    const menu = Menu.buildFromTemplate([
      { label: 'Run Now', enabled: !active, click: () => sender.webContents.send('ui:event', { type: 'run-now' }) },
      { label: 'Stop Agent', enabled: info.state === 'running', click: () => sender.webContents.send('ui:event', { type: 'stop-agent' }) },
      { label: info.state === 'paused' ? 'Resume' : 'Pause', enabled: info.state !== 'disabled', click: () => sender.webContents.send('ui:event', { type: 'pause-resume' }) },
      { label: info.enabled ? 'Disable' : 'Enable', click: () => sender.webContents.send('ui:event', { type: 'enable-disable' }) },
      { type: 'separator' },
      { label: 'Edit Task…', click: () => sender.webContents.send('ui:event', { type: 'edit-task' }) },
      { label: 'Delete Task', click: () => sender.webContents.send('ui:event', { type: 'delete-task' }) },
    ]);
    menu.popup({ window: sender });
  });

  ipcMain.on('context-menu:run', (e, info: { taskId: string; runId: string; details: string }) => {
    const sender = BrowserWindow.fromWebContents(e.sender);
    if (!sender) return;
    const menu = Menu.buildFromTemplate([
      { label: 'Copy Details', enabled: !!info.details, click: () => clipboard.writeText(info.details) },
      { label: 'View Details', click: () => host.openRunDetail(info.taskId, info.runId) },
    ]);
    menu.popup({ window: sender });
  });

  engine.on((event) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('engine:event', event);
    }
  });
}
