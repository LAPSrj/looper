import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import { createEngine, type Engine } from '../engine/engine';
import { defaultDataDir } from '../engine/host';
import { registerIpc } from './ipc';

let win: BrowserWindow | null = null;
let engine: Engine | null = null;
let quitting = false;

// The engine must survive anything the UI or a child process throws at it.
process.on('uncaughtException', (err) => {
  engine?.log.error(`uncaught exception: ${err.stack ?? err.message}`);
  if (!engine) console.error(err);
});
process.on('unhandledRejection', (reason) => {
  engine?.log.error(`unhandled rejection: ${String(reason)}`);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    engine = createEngine({ dataDir: defaultDataDir() });
    engine.start();
    registerIpc(engine, {
      getWindow: () => win,
      openEditor: openEditorWindow,
      openExample: openExampleEditorWindow,
    });
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting || !engine) return;
    event.preventDefault();
    quitting = true;
    engine
      .stop()
      .catch(() => undefined)
      .finally(() => app.quit());
  });
}

function webPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    sandbox: false,
    nodeIntegration: false,
  };
}

function loadRenderer(target: BrowserWindow, hash?: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void target.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : ''));
  } else {
    void target.loadFile(path.join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined);
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Looper',
    backgroundColor: '#14161a',
    autoHideMenuBar: false,
    webPreferences: webPreferences(),
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // A renderer crash must never take the engine down: just reload the UI.
  win.webContents.on('render-process-gone', (_e, details) => {
    engine?.log.error(`renderer gone (${details.reason}); reloading`);
    if (win && !win.isDestroyed()) win.webContents.reload();
  });
  loadRenderer(win);
}

function openChildWindow(hash: string, title: string, width: number, height: number): void {
  const child = new BrowserWindow({
    width,
    height,
    minWidth: 520,
    minHeight: 420,
    title,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });
  child.setMenuBarVisibility(false);
  loadRenderer(child, hash);
}

export function openEditorWindow(taskId?: string): void {
  openChildWindow(
    taskId ? `editor/${encodeURIComponent(taskId)}` : 'editor',
    taskId ? 'Edit Task — Looper' : 'New Task — Looper',
    780,
    940,
  );
}

function openExampleEditorWindow(): void {
  openChildWindow('editor-example', 'New Task — Looper', 780, 940);
}

function openSettingsWindow(): void {
  openChildWindow('settings', 'Settings — Looper', 660, 640);
}

/** Send a UI command to the main window (menu accelerators act on the selected task there). */
function sendUi(type: string): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('ui:event', { type });
    win.focus();
  }
}

function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        { label: '&New Task…', accelerator: 'CmdOrCtrl+N', click: () => openEditorWindow() },
        { label: 'New Task from E&xample…', click: () => openExampleEditorWindow() },
        { type: 'separator' },
        { label: 'S&ettings…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
        { type: 'separator' },
        {
          label: 'Open &Data Directory',
          click: () => {
            if (engine) void shell.openPath(engine.dataDir);
          },
        },
        {
          label: 'Open &Inbox Directory',
          click: () => {
            if (engine) void shell.openPath(engine.inboxDir());
          },
        },
        { type: 'separator' },
        { role: 'quit', label: 'E&xit' },
      ],
    },
    {
      label: '&Task',
      submenu: [
        { label: '&Run Now', accelerator: 'F5', click: () => sendUi('run-now') },
        { label: '&Stop Agent', accelerator: 'Shift+F5', click: () => sendUi('stop-agent') },
        { label: '&Pause / Resume', accelerator: 'CmdOrCtrl+P', click: () => sendUi('pause-resume') },
        { type: 'separator' },
        { label: '&Edit Task…', accelerator: 'CmdOrCtrl+E', click: () => sendUi('edit-task') },
        { label: '&Delete Task', click: () => sendUi('delete-task') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: '&Engine Log', accelerator: 'CmdOrCtrl+L', click: () => sendUi('toggle-log') },
        { type: 'separator' },
        { role: 'reload', label: '&Reload UI' },
        { role: 'toggleDevTools', label: 'Toggle &Developer Tools' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}
