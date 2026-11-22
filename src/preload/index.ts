import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createLooperApi, type LooperTransport } from '../shared/api-client';
import { isWebLink } from '../shared/links';

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

/**
 * A frame inside a window, where this preload runs too (nodeIntegrationInSubFrames): an HTML file Preview shows,
 * or a frame in it at any depth. Its page gets nothing from Looper. It opens nothing itself (PREVIEW_SANDBOX), so a
 * click the user makes on a web or mail link goes to main, which opens it in the browser once main has said the
 * frame is a previewed page's. This runs in the preload's own world: the page's scripts can't reach this listener,
 * and a click they make (click(), dispatchEvent) isn't trusted.
 */
function forwardPreviewLinks(): void {
  let preview = false;
  void ipcRenderer.invoke('preview:inPage').then((ok: unknown) => (preview = ok === true));
  addEventListener('click', (e) => {
    if (!preview || !e.isTrusted || e.defaultPrevented || e.button !== 0) return;
    const a = e.target instanceof Element ? e.target.closest('a[href],area[href]') : null;
    if (!a) return;
    let url: string;
    try {
      // An SVG link's href isn't a string.
      url = new URL(a.getAttribute('href') ?? '', document.baseURI).href;
    } catch {
      return;
    }
    // A link to a place in the same page moves there.
    if (!isWebLink(url) || (url.includes('#') && url.split('#')[0] === location.href.split('#')[0])) return;
    e.preventDefault();
    ipcRenderer.send('preview:open', url);
  });
}

if (process.isMainFrame) contextBridge.exposeInMainWorld('looper', createLooperApi(transport));
else forwardPreviewLinks();
