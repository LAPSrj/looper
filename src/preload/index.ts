import { contextBridge, ipcRenderer } from 'electron';
import type { LooperApi, UiEvent } from '../shared/api';
import type { EngineEvent } from '../shared/types';

const api: LooperApi = {
  info: () => ipcRenderer.invoke('info'),
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    save: (input) => ipcRenderer.invoke('tasks:save', input),
    remove: (id) => ipcRenderer.invoke('tasks:remove', id),
    example: () => ipcRenderer.invoke('tasks:example'),
  },
  runtime: {
    list: () => ipcRenderer.invoke('runtime:list'),
    runNow: (id) => ipcRenderer.invoke('runtime:runNow', id),
    pause: (id) => ipcRenderer.invoke('runtime:pause', id),
    resume: (id) => ipcRenderer.invoke('runtime:resume', id),
    stopAgent: (id) => ipcRenderer.invoke('runtime:stopAgent', id),
  },
  runs: {
    list: (id, limit) => ipcRenderer.invoke('runs:list', id, limit),
    output: (id, runId) => ipcRenderer.invoke('runs:output', id, runId),
    openDir: (id, runId) => ipcRenderer.invoke('runs:openDir', id, runId),
  },
  agent: {
    buffer: (id) => ipcRenderer.invoke('agent:buffer', id),
    write: (id, data) => ipcRenderer.send('agent:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('agent:resize', id, cols, rows),
  },
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  openEditor: (taskId) => ipcRenderer.invoke('editor:open', taskId),
  onEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: EngineEvent) => cb(ev);
    ipcRenderer.on('engine:event', listener);
    return () => ipcRenderer.removeListener('engine:event', listener);
  },
  onUi: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: UiEvent) => cb(ev);
    ipcRenderer.on('ui:event', listener);
    return () => ipcRenderer.removeListener('ui:event', listener);
  },
};

contextBridge.exposeInMainWorld('looper', api);
