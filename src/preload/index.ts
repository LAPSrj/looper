import { contextBridge, ipcRenderer } from 'electron';
import type { LooperApi, UiEvent } from '../shared/api';
import type { EngineEvent } from '../shared/types';

const api: LooperApi = {
  info: () => ipcRenderer.invoke('info'),
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    save: (input) => ipcRenderer.invoke('tasks:save', input),
    remove: (id) => ipcRenderer.invoke('tasks:remove', id),

  },
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    save: (input) => ipcRenderer.invoke('templates:save', input),
    remove: (id) => ipcRenderer.invoke('templates:remove', id),
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
    output: (id, runId, raw) => ipcRenderer.invoke('runs:output', id, runId, raw),
    openDir: (id, runId) => ipcRenderer.invoke('runs:openDir', id, runId),
  },
  agent: {
    buffer: (id) => ipcRenderer.invoke('agent:buffer', id),
    write: (id, data) => ipcRenderer.send('agent:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('agent:resize', id, cols, rows),
  },
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  openRunDetail: (taskId, runId) => ipcRenderer.invoke('runDetail:open', taskId, runId),
  openEditor: (taskId) => ipcRenderer.invoke('editor:open', taskId),

  openEnvironmentEditor: (envId, isNew) => ipcRenderer.invoke('envEditor:open', envId, isNew),
  openHarnessEditor: (envId, harnessId, isNew) => ipcRenderer.invoke('harnessEditor:open', envId, harnessId, isNew),
  openModelEditor: (envId, harnessId, index) => ipcRenderer.invoke('modelEditor:open', envId, harnessId, index),
  openTemplateEditor: (templateId) => ipcRenderer.invoke('templateEditor:open', templateId),
  openTemplatePicker: () => ipcRenderer.invoke('templatePicker:open'),
  openEditorFromTemplate: (templateId) => ipcRenderer.invoke('editorFromTemplate:open', templateId),
  discardEnvironment: (envId) => ipcRenderer.send('envEditor:discard', envId),
  discardHarness: (envId, harnessId) => ipcRenderer.send('harnessEditor:discard', envId, harnessId),
  pickDirectory: (opts) => ipcRenderer.invoke('dialog:pickDir', opts.current, opts.flavor, opts.distro),
  listWslDistros: () => ipcRenderer.invoke('wsl:distros'),
  detectWslMountPrefix: (distro) => ipcRenderer.invoke('wsl:mountPrefix', distro),
  moveStoreFile: (store, targetFile) => ipcRenderer.invoke('store:move', store, targetFile),
  pickSaveFile: (opts) => ipcRenderer.invoke('dialog:pickSaveFile', opts.defaultPath, opts.filters),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  showError: (message) => ipcRenderer.invoke('dialog:error', message),
  confirm: (message) => ipcRenderer.invoke('dialog:confirm', message),
  reportSelection: (hasTask, taskEnabled, taskPaused, taskState) => ipcRenderer.send('ui:selection', hasTask, taskEnabled, taskPaused, taskState),
  showTaskContextMenu: (info) => ipcRenderer.send('context-menu:task', info),
  showRunContextMenu: (info) => ipcRenderer.send('context-menu:run', info),
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
