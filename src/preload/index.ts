import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createLooperApi, type LooperTransport } from '../shared/api-client';

const transport: LooperTransport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Dropped or picked files go by path; a pasted image has none, so its bytes go instead.
  files: (files) =>
    Promise.all(
      files.map(async (f) => {
        const path = webUtils.getPathForFile(f);
        return path ? { name: f.name || path, path } : { name: f.name || 'pasted-image.png', data: new Uint8Array(await f.arrayBuffer()) };
      }),
    ),
  // webUtils resolves the dropped File to its on-disk path (File.path is gone).
  filePath: async (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('looper', createLooperApi(transport));
