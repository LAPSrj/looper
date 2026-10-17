import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { LooperApi, UiEvent } from '../shared/api';
import type { EngineEvent } from '../shared/types';

/** The engine's message alone, without Electron's IPC framing, for errors shown to the user. */
const plainError = (e: Error): never => {
  throw new Error(e.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
};

const api: LooperApi = {
  info: () => ipcRenderer.invoke('info'),
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    save: (input, opts) => ipcRenderer.invoke('tasks:save', input, opts),
    remove: (id) => ipcRenderer.invoke('tasks:remove', id),
    export: (id) => ipcRenderer.invoke('tasks:export', id),
    reorder: (ids, folders, layout, parents) => ipcRenderer.invoke('tasks:reorder', ids, folders, layout, parents),
  },
  versions: {
    list: (taskId) => ipcRenderer.invoke('versions:list', taskId),
    detail: (taskId, n, compare) => ipcRenderer.invoke('versions:detail', taskId, n, compare).catch(plainError),
    restore: (taskId, n) => ipcRenderer.invoke('versions:restore', taskId, n).catch(plainError),
    open: (taskId) => ipcRenderer.invoke('versions:open', taskId),
    openDetail: (taskId, n, compare) => ipcRenderer.invoke('versions:openDetail', taskId, n, compare),
  },
  builder: {
    start: (setup) => ipcRenderer.invoke('builder:start', setup).catch(plainError),
    get: (id) => ipcRenderer.invoke('builder:get', id),
    send: (id, text) => ipcRenderer.send('builder:send', id, text),
    review: (id) => ipcRenderer.invoke('builder:review', id).catch(plainError),
    save: (id) => ipcRenderer.invoke('builder:save', id).catch(plainError),
    undo: (id) => ipcRenderer.invoke('builder:undo', id).catch(plainError),
    redo: (id) => ipcRenderer.invoke('builder:redo', id).catch(plainError),
    forTask: (taskId) => ipcRenderer.invoke('builder:forTask', taskId),
    loadVersion: (taskId, n) => ipcRenderer.invoke('builder:loadVersion', taskId, n).catch(plainError),
    editTask: (taskId) => ipcRenderer.invoke('builder:editTask', taskId),
    openNew: () => ipcRenderer.invoke('builder:openNew'),
    output: (id) => ipcRenderer.invoke('builder:output', id),
    write: (id, data) => ipcRenderer.send('builder:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('builder:resize', id, cols, rows),
  },
  recycleBin: {
    list: () => ipcRenderer.invoke('recycleBin:list'),
    // The engine's reason is shown to the user; drop Electron's IPC framing.
    restore: (id) =>
      ipcRenderer.invoke('recycleBin:restore', id).catch((e: Error) => {
        throw new Error(e.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
      }),
    delete: (id) =>
      ipcRenderer.invoke('recycleBin:delete', id).catch((e: Error) => {
        throw new Error(e.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
      }),
    empty: () => ipcRenderer.invoke('recycleBin:empty'),
  },
  folders: {
    list: () => ipcRenderer.invoke('folders:list'),
    layout: () => ipcRenderer.invoke('folders:layout'),
    add: (name, parentId) => ipcRenderer.invoke('folders:add', name, parentId),
    rename: (id, name) => ipcRenderer.invoke('folders:rename', id, name),
    remove: (id) => ipcRenderer.invoke('folders:remove', id),
  },
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    save: (input) => ipcRenderer.invoke('templates:save', input),
    remove: (id) => ipcRenderer.invoke('templates:remove', id),
    reorder: (ids) => ipcRenderer.invoke('templates:reorder', ids),
    export: (id) => ipcRenderer.invoke('templates:export', id),
    import: () => ipcRenderer.invoke('templates:import'),
  },
  runtime: {
    list: () => ipcRenderer.invoke('runtime:list'),
    runNow: (id) => ipcRenderer.invoke('runtime:runNow', id),
    pause: (id) => ipcRenderer.invoke('runtime:pause', id),
    resume: (id) => ipcRenderer.invoke('runtime:resume', id),
    complete: (id) => ipcRenderer.invoke('runtime:complete', id),
    reopen: (id) => ipcRenderer.invoke('runtime:reopen', id),
    stopTask: (id, runId) => ipcRenderer.invoke('runtime:stopTask', id, runId),
  },
  runs: {
    list: (id, limit) => ipcRenderer.invoke('runs:list', id, limit),
    output: (id, runId, raw) => ipcRenderer.invoke('runs:output', id, runId, raw),
    openDir: (id, runId) => ipcRenderer.invoke('runs:openDir', id, runId),
    clear: (id) => ipcRenderer.invoke('runs:clear', id),
    messages: (id, runId, agentId, raw) => ipcRenderer.invoke('runs:messages', id, runId, agentId, raw),
    messageImage: (id, runId, rowId, agentId) => ipcRenderer.invoke('runs:messageImage', id, runId, rowId, agentId),
  },
  agent: {
    buffer: (id, runId) => ipcRenderer.invoke('agent:buffer', id, runId),
    write: (id, data, runId) => ipcRenderer.send('agent:write', id, data, runId),
    resize: (id, cols, rows, runId) => ipcRenderer.send('agent:resize', id, cols, rows, runId),
  },
  restState: () => ipcRenderer.invoke('rest:state'),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  // webUtils resolves the dropped File to its on-disk path (File.path is gone).
  openLooperFile: (file) => ipcRenderer.invoke('file:openLooper', webUtils.getPathForFile(file)),
  readEngineLog: () => ipcRenderer.invoke('engineLog:read'),
  openTaskTerminal: (taskId, runId) => ipcRenderer.invoke('task:openTerminal', taskId, runId),
  // The engine's error is shown to the user; drop Electron's IPC framing.
  continueRun: (taskId, runId, guidance) =>
    ipcRenderer.invoke('run:continue', taskId, runId, guidance).catch((e: Error) => {
      throw new Error(e.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
    }),
  canGuideRun: (taskId, runId) => ipcRenderer.invoke('run:canGuide', taskId, runId),
  sendGuidance: (taskId, runId, text) =>
    ipcRenderer.invoke('run:guide', taskId, runId, text).catch((e: Error) => {
      throw new Error(e.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
    }),
  openTaskWorkFolder: (taskId) => ipcRenderer.invoke('task:openWorkFolder', taskId),
  openMessages: (taskId, runId, agentId, label) =>
    ipcRenderer.invoke('messages:open', taskId, runId, agentId, label),
  openMessageImage: (taskId, runId, rowId, agentId, label) =>
    ipcRenderer.invoke('messages:openImage', taskId, runId, rowId, agentId, label),
  openEditor: (taskId) => ipcRenderer.invoke('editor:open', taskId),
  openNoteEditor: (taskId) => ipcRenderer.invoke('noteEditor:open', taskId),
  openMoveToFolder: (taskId) => ipcRenderer.invoke('moveToFolder:open', taskId),

  openEnvironmentEditor: (envId, isNew) => ipcRenderer.invoke('envEditor:open', envId, isNew),
  openHarnessEditor: (envId, harnessId, isNew) => ipcRenderer.invoke('harnessEditor:open', envId, harnessId, isNew),
  openModelEditor: (envId, harnessId, index) => ipcRenderer.invoke('modelEditor:open', envId, harnessId, index),
  openModelUpdate: (envId, harnessId) => ipcRenderer.invoke('modelUpdate:open', envId, harnessId),
  // The discovery error is shown to the user; drop Electron's IPC framing
  // ("Error invoking remote method '…': Error: ") so only the message is left.
  discoverModels: (envId, harnessId) =>
    ipcRenderer.invoke('models:discover', envId, harnessId).catch((e: Error) => {
      throw new Error(e.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
    }),
  openTemplateEditor: (templateId) => ipcRenderer.invoke('templateEditor:open', templateId),
  openTemplatePicker: () => ipcRenderer.invoke('templatePicker:open'),
  openEditorFromTemplate: (templateId) => ipcRenderer.invoke('editorFromTemplate:open', templateId),
  importDraft: (key) => ipcRenderer.invoke('import:draft', key),
  discardEnvironment: (envId) => ipcRenderer.send('envEditor:discard', envId),
  discardHarness: (envId, harnessId) => ipcRenderer.send('harnessEditor:discard', envId, harnessId),
  pickDirectory: (opts) => ipcRenderer.invoke('dialog:pickDir', opts.current, opts.flavor, opts.distro),
  listWslDistros: () => ipcRenderer.invoke('wsl:distros'),
  detectWslMountPrefix: (distro) => ipcRenderer.invoke('wsl:mountPrefix', distro),
  moveStoreFile: (store, targetFile) => ipcRenderer.invoke('store:move', store, targetFile),
  pickSaveFile: (opts) => ipcRenderer.invoke('dialog:pickSaveFile', opts.defaultPath, opts.filters),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  getStartWithSystem: () => ipcRenderer.invoke('loginItem:get'),
  setStartWithSystem: (enabled) => ipcRenderer.invoke('loginItem:set', enabled),
  showError: (message) => ipcRenderer.invoke('dialog:error', message),
  confirm: (message) => ipcRenderer.invoke('dialog:confirm', message),
  reportSelection: (hasTask, taskEnabled, taskPaused, taskState, hasNote, canRunNow, taskCompleted, allowComplete) =>
    ipcRenderer.send(
      'ui:selection',
      hasTask,
      taskEnabled,
      taskPaused,
      taskState,
      hasNote,
      canRunNow,
      taskCompleted,
      allowComplete,
    ),
  showTaskContextMenu: (info) => ipcRenderer.send('context-menu:task', info),
  showFolderContextMenu: (info) => ipcRenderer.send('context-menu:folder', info),
  showRecycleBinContextMenu: () => ipcRenderer.send('context-menu:recycle-bin'),
  showVersionContextMenu: (info) => ipcRenderer.send('context-menu:version', info),
  showTasksEmptyContextMenu: () => ipcRenderer.send('context-menu:tasks-empty'),
  showPaneContextMenu: (info) => ipcRenderer.send('context-menu:pane', info),
  showRunContextMenu: (info) => ipcRenderer.send('context-menu:run', info),
  showMessageContextMenu: (info) => ipcRenderer.send('context-menu:message', info),
  reportMessagesFilter: (filter) => ipcRenderer.send('messages:filter-state', filter),
  applyMessagesFilter: (value) => ipcRenderer.send('messages:filter-apply', value),
  applyMarkdownExport: (opts) => ipcRenderer.send('markdown-export:apply', opts),
  applyRunOptions: (opts) => ipcRenderer.send('run-options:apply', opts),
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
