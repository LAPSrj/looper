import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { Engine } from '../engine/engine';
import { EXAMPLE_TASK } from '../shared/example-task';
import type { AppInfo } from '../shared/api';

export interface IpcHost {
  getWindow: () => BrowserWindow | null;
  openEditor: (taskId?: string) => void;
  openExample: () => void;
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
  ipcMain.handle('tasks:example', () => EXAMPLE_TASK);

  ipcMain.handle('runtime:list', () => engine.listRuntimes());
  ipcMain.handle('runtime:runNow', (_e, id: string) => engine.runNow(id));
  ipcMain.handle('runtime:pause', (_e, id: string) => engine.pause(id));
  ipcMain.handle('runtime:resume', (_e, id: string) => engine.resume(id));
  ipcMain.handle('runtime:stopAgent', (_e, id: string) => engine.stopAgent(id));

  ipcMain.handle('runs:list', (_e, id: string, limit?: number) => engine.listRuns(id, limit));
  ipcMain.handle('runs:output', (_e, id: string, runId: string) => engine.readOutput(id, runId));
  ipcMain.handle('runs:openDir', (_e, id: string, runId: string) => shell.openPath(engine.runDir(id, runId)));

  ipcMain.handle('agent:buffer', (_e, id: string) => engine.agentBuffer(id));
  ipcMain.on('agent:write', (_e, id: string, data: string) => engine.writeAgent(id, data));
  ipcMain.on('agent:resize', (_e, id: string, cols: number, rows: number) =>
    engine.resizeAgent(id, cols, rows),
  );

  ipcMain.handle('openPath', (_e, p: string) => shell.openPath(p));
  ipcMain.handle('editor:open', (_e, taskId?: string) => host.openEditor(taskId));
  ipcMain.handle('editor:open-example', () => host.openExample());
  ipcMain.handle('settings:update', (_e, patch: unknown) => engine.updateSettings(patch));

  engine.on((event) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('engine:event', event);
    }
  });
}
