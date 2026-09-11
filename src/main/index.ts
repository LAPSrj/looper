import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createEngine, type Engine } from '../engine/engine';
import { readWakeTimerPolicy } from '../engine/power-win';
import type { PowerAdapter } from '../engine/rest';
import type { EngineEvent, Settings } from '../shared/types';
import { convertWslPath, defaultDataDir } from '../engine/host';
import { readJson } from '../engine/store/fsutil';
import { FILE_KINDS, isLooperFileName, readLooperFile } from '../shared/files';
import { messagesToMarkdown } from '../shared/messages-md';
import { adjustImportedTaskPaths } from './import-paths';
import { registerIpc } from './ipc';

let win: BrowserWindow | null = null;
let engine: Engine | null = null;
let tray: Tray | null = null;
let quitting = false;

// The engine must survive anything the UI or a child process throws at it.
process.on('uncaughtException', (err) => {
  engine?.log.error(`uncaught exception: ${err.stack ?? err.message}`);
  if (!engine) console.error(err);
});
process.on('unhandledRejection', (reason) => {
  engine?.log.error(`unhandled rejection: ${String(reason)}`);
});

/** --hidden: start in the tray, without the main window (used by the login item). */
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    showWindow();
    // A double-clicked/“Open with” Looper document lands in the second
    // instance's argv while this instance holds the single-instance lock.
    const file = looperFileFromArgv(argv);
    if (file) void openLooperFile(file);
  });

  app.whenReady().then(() => {
    // Windows routes toasts by AppUserModelID; without it dev runs show nothing.
    // Dev runs get their own id so the dev Start Menu shortcut (see
    // scripts/register-notifications.js) can never hijack the packaged app's
    // taskbar identity.
    if (process.platform === 'win32') {
      app.setAppUserModelId(app.isPackaged ? 'com.lemorim.looper' : 'com.lemorim.looper.dev');
      if (!app.isPackaged) removeDevAumidHijackers();
    }
    engine = createEngine({
      dataDir: defaultDataDir(),
      ...(process.platform === 'win32' ? { power: createPowerAdapter() } : {}),
    });
    engine.start();
    engine.on((event) => {
      if (event.type === 'notify') showTaskNotification(event);
      else if (event.type === 'settings') tray?.setContextMenu(trayMenu());
      else if (event.type === 'rest') {
        if (event.disarmReason === 'user-wake') showRestDisarmNotification();
        tray?.setContextMenu(trayMenu());
        rebuildMenu();
      }
    });
    registerIpc(engine, {
      getWindow: () => win,
      openRunDetail: openRunDetailWindow,
      openMessages: openMessagesWindow,
      openMessageImage: openImageWindow,
      openEditor: openEditorWindow,
      openNoteEditor: openNoteEditorWindow,
      openFolderNoteEditor: openFolderNoteEditorWindow,
      openMoveToFolder: openMoveToFolderWindow,
      openNewFolder: openNewFolderWindow,
      openRenameFolder: openRenameFolderWindow,

      openEnvEditor: openEnvEditorWindow,
      openHarnessEditor: openHarnessEditorWindow,
      openModelEditor: openModelEditorWindow,
      openTemplateEditor: openTemplateEditorWindow,
      openTemplatePicker: openTemplatePickerWindow,
      openEditorFromTemplate: openEditorFromTemplateWindow,
      takeImportDraft,
      openLooperFile,
      updateTaskMenu,
    });
    // macOS keeps one global menu bar; elsewhere each window carries its own.
    if (process.platform === 'darwin') buildMenu();
    else Menu.setApplicationMenu(null);
    createTray();
    if (!startHidden) createWindow();
    // Launched by double-clicking a Looper document (file association).
    const fileArg = looperFileFromArgv(process.argv);
    if (fileArg) {
      if (!win) createWindow();
      void openLooperFile(fileArg);
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // macOS: the global menu bar follows the focused window — a window with its
  // own menu (run detail, messages) shows it; every other window shows the main menu.
  app.on('browser-window-focus', (_e, w) => {
    if (process.platform !== 'darwin') return;
    const own = macWindowMenus.get(w);
    if (own) Menu.setApplicationMenu(own);
    else rebuildMenu();
  });

  app.on('window-all-closed', () => {
    if (!tray || !engine?.settings.closeToTray) app.quit();
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

/**
 * Windows occasionally grows a stray Start Menu shortcut (seen as
 * "Electron.lnk") carrying the dev AUMID; with two shortcuts claiming the id,
 * the app resolver can pick the wrong one and the taskbar falls back to
 * electron.exe's icon. Delete any shortcut with our dev AUMID other than the
 * one scripts/register-notifications.js writes.
 */
function removeDevAumidHijackers(): void {
  const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.lnk') || name === 'Looper (dev).lnk') continue;
    const file = path.join(dir, name);
    try {
      if (shell.readShortcutLink(file).appUserModelId === 'com.lemorim.looper.dev') fs.rmSync(file);
    } catch {
      /* not a readable shortcut */
    }
  }
}

/** Electron power hooks handed to the engine's Rest Mode controller. */
function createPowerAdapter(): PowerAdapter {
  let blockerId: number | null = null;
  return {
    startBlocker() {
      if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) {
        blockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
    },
    stopBlocker() {
      if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
      blockerId = null;
    },
    onSuspend: (cb) => void powerMonitor.on('suspend', cb),
    onResume: (cb) => void powerMonitor.on('resume', cb),
    isOnBattery: () => powerMonitor.isOnBatteryPower(),
  };
}

/** Arm (with a wake-timer preflight) or disarm Rest Mode from a menu. */
async function toggleRestMode(): Promise<void> {
  if (!engine) return;
  if (engine.restState().armed) {
    engine.disarmRest();
    return;
  }
  // Wake timers disabled for the current power source mean the machine would
  // sleep and never wake for the schedule: warn before arming.
  const policy = await readWakeTimerPolicy();
  if (policy) {
    const onBattery = powerMonitor.isOnBatteryPower();
    if (onBattery ? !policy.dc : !policy.ac) {
      const r = await dialog.showMessageBox({
        type: 'warning',
        title: 'Looper',
        message: 'The computer will not wake on its own.',
        detail: `Windows wake timers are disabled while ${onBattery ? 'on battery' : 'plugged in'} (Power Options → Sleep → Allow wake timers). Rest Mode can put the computer to sleep, but scheduled tasks will not wake it.`,
        buttons: ['Start Anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      if (r.response !== 0) return;
    }
  }
  try {
    engine.armRest();
  } catch (err) {
    await dialog.showMessageBox({ type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'] });
  }
}

function restMenuItems(): Electron.MenuItemConstructorOptions[] {
  if (engine?.host !== 'windows') return [];
  const armed = engine.restState().armed;
  return [{ label: armed ? 'Stop &Rest Mode' : 'Start &Rest Mode', click: () => void toggleRestMode() }];
}

function showRestDisarmNotification(): void {
  if (!engine?.settings.notificationsEnabled || !Notification.isSupported()) return;
  if (BrowserWindow.getFocusedWindow()) return;
  new Notification({
    title: 'Looper',
    body: 'Rest Mode turned off — the computer was woken manually.',
    icon: appIcon,
  }).show();
}

const appIcon = path.join(__dirname, '../../assets/icon.png');
const trayIcon = process.platform === 'win32'
  ? path.join(__dirname, '../../assets/icon.ico')
  : appIcon;

/** macOS menu-bar icons are ~18pt; the full-size PNG would render huge there. */
function trayImage(): Electron.NativeImage {
  const img = nativeImage.createFromPath(trayIcon);
  return process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img;
}

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow();
  } else {
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

function trayMenu(): Menu {
  const notifOn = engine?.settings.notificationsEnabled ?? true;
  return Menu.buildFromTemplate([
    { label: 'Show Looper', click: showWindow },
    { type: 'separator' },
    {
      label: notifOn ? 'Disable Notifications' : 'Enable Notifications',
      click: () => {
        if (engine) engine.updateSettings({ notificationsEnabled: !engine.settings.notificationsEnabled });
      },
    },
    ...restMenuItems().map((item) => ({ ...item, label: String(item.label).replace('&', '') })),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function createTray(): void {
  // Linux desktops without a StatusNotifier host (e.g. stock GNOME) may have
  // no tray; a failure here must not take the app down. Close-to-tray checks
  // `tray` so a missing tray can never strand a hidden window.
  try {
    tray = new Tray(trayImage());
    tray.setToolTip('Looper');
    tray.on('double-click', showWindow);
    tray.setContextMenu(trayMenu());
  } catch (err) {
    tray = null;
    engine?.log.error(`tray unavailable: ${(err as Error).message}`);
  }
}

function showTaskNotification(e: Extract<EngineEvent, { type: 'notify' }>): void {
  if (!engine?.settings.notificationsEnabled || !Notification.isSupported()) return;
  // The user is already looking at the app: no toast.
  if (BrowserWindow.getFocusedWindow()) return;
  const toast = new Notification({ title: e.title, body: e.body, icon: appIcon });
  // A live run lands on the terminal; a finished one on the run log, the run
  // selected so its report is on screen.
  const view =
    e.kind === 'end' || e.kind === 'auto-paused' || e.kind === 'usage-limit' || e.kind === 'completed'
      ? 'log'
      : 'terminal';
  toast.on('click', () => openTaskView(e.taskId, e.runId, view));
  toast.show();
}

function openTaskView(taskId: string, runId: string, view: 'terminal' | 'log'): void {
  const payload = { type: 'open-task', taskId, runId, view };
  if (!win || win.isDestroyed()) {
    createWindow();
    // The renderer subscribes to ui:event after mount; give it a beat.
    win?.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('ui:event', payload);
      }, 300);
    });
    return;
  }
  showWindow();
  win.webContents.send('ui:event', payload);
}

/** Pre-paint window background; must match the CSS --bg for the active theme. */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#14161a' : '#f3f3f3';
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

/** macOS: windows that carry their own menu (run detail, messages). */
const macWindowMenus = new WeakMap<BrowserWindow, Menu>();

/** Drop the Windows mnemonic ampersands from labels, recursively. */
function stripMnemonics(items: Electron.MenuItemConstructorOptions[]): Electron.MenuItemConstructorOptions[] {
  return items.map((item) => ({
    ...item,
    ...(typeof item.label === 'string' ? { label: item.label.replace(/&/g, '') } : {}),
    ...(Array.isArray(item.submenu) ? { submenu: stripMnemonics(item.submenu) } : {}),
  }));
}

/** Fit a Windows-shaped template to the macOS menu bar: app menu first, Edit after File. */
function macTemplate(template: Electron.MenuItemConstructorOptions[]): Electron.MenuItemConstructorOptions[] {
  const [file, ...rest] = stripMnemonics(template);
  return [{ role: 'appMenu' }, file, { role: 'editMenu' }, ...rest];
}

/**
 * Attach a window's own menu: per-window on Windows/Linux; on macOS
 * (where BrowserWindow.setMenu does not exist) the global menu bar shows it
 * while the window is focused — see the browser-window-focus handler.
 */
function attachWindowMenu(child: BrowserWindow, template: Electron.MenuItemConstructorOptions[]): Menu {
  if (process.platform !== 'darwin') {
    const menu = Menu.buildFromTemplate(template);
    child.setMenu(menu);
    return menu;
  }
  const menu = Menu.buildFromTemplate(macTemplate(template));
  macWindowMenus.set(child, menu);
  child.on('closed', () => rebuildMenu());
  if (child.isFocused()) Menu.setApplicationMenu(menu);
  return menu;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Looper',
    icon: appIcon,
    backgroundColor: windowBackground(),
    autoHideMenuBar: false,
    webPreferences: webPreferences(),
  });
  win.on('close', (e) => {
    if (!quitting && tray && engine?.settings.closeToTray) {
      e.preventDefault();
      win?.hide();
      return;
    }
    for (const w of BrowserWindow.getAllWindows()) {
      if (w !== win && !w.isDestroyed()) w.close();
    }
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
  // The window may be the first ever (tray start): give it a menu right away;
  // the renderer's selection report refines it.
  buildMenu();
  loadRenderer(win);
}

function openChildWindow(
  hash: string,
  title: string,
  width: number,
  height: number,
  modalParent?: BrowserWindow | null,
  opts?: { minWidth?: number; minHeight?: number; resizable?: boolean },
): BrowserWindow {
  const parent = modalParent && !modalParent.isDestroyed() ? modalParent : undefined;
  const child = new BrowserWindow({
    width,
    height,
    minWidth: opts?.minWidth ?? 520,
    minHeight: opts?.minHeight ?? 420,
    title,
    icon: appIcon,
    backgroundColor: windowBackground(),
    maximizable: false,
    resizable: opts?.resizable ?? true,
    webPreferences: webPreferences(),
    ...(parent ? { parent, modal: true, minimizable: false } : {}),
  });
  // Detach the app menu entirely; hiding it would leave Alt able to summon it.
  child.removeMenu();
  // Links (e.g. in rendered markdown) open in the system browser, never a new app window.
  child.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRenderer(child, hash);
  return child;
}

interface MarkdownExportChoice {
  includeThinking: boolean;
  includeTools: boolean;
  plain: boolean;
}

/**
 * The Save-as-Markdown options, in a modal window shown after the save location
 * is chosen (the native save dialog cannot carry checkboxes). Resolves the
 * chosen options, or null when the window is dismissed without confirming.
 */
function promptMarkdownExport(parent: BrowserWindow, defaults: MarkdownExportChoice): Promise<MarkdownExportChoice | null> {
  return new Promise((resolve) => {
    const bit = (b: boolean): string => (b ? '1' : '0');
    const hash = `markdown-export/${bit(defaults.includeThinking)}/${bit(defaults.includeTools)}/${bit(defaults.plain)}`;
    const child = openChildWindow(hash, 'Export Options', 360, 260, parent, { minWidth: 320, minHeight: 220, resizable: false });
    let settled = false;
    const done = (value: MarkdownExportChoice | null): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('markdown-export:apply', onApply);
      resolve(value);
      if (!child.isDestroyed()) child.close();
    };
    const onApply = (e: Electron.IpcMainEvent, opts: MarkdownExportChoice): void => {
      if (BrowserWindow.fromWebContents(e.sender) !== child) return;
      done({ includeThinking: !!opts?.includeThinking, includeTools: !!opts?.includeTools, plain: !!opts?.plain });
    };
    ipcMain.on('markdown-export:apply', onApply);
    child.on('closed', () => done(null));
  });
}

function openRunDetailWindow(taskId: string, runId: string): void {
  const task = engine?.getTask(taskId);
  const title = task ? `${task.name} – ${runId}` : `Run ${runId}`;
  const hash = `run-detail/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}`;
  const child = new BrowserWindow({
    width: 800,
    height: 500,
    minWidth: 520,
    minHeight: 420,
    title,
    icon: appIcon,
    backgroundColor: windowBackground(),
    maximizable: true,
    webPreferences: webPreferences(),
  });
  // Links in rendered output open in the system browser, never a new app window.
  child.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  const send = (type: string) => {
    if (!child.isDestroyed()) child.webContents.send('ui:event', { type });
  };
  const openHostPath = async (p: string) => {
    if (process.platform === 'win32' && p.startsWith('/')) {
      const winPath = await convertWslPath(p, 'windows');
      if (winPath) { void shell.openPath(winPath); return; }
    }
    void shell.openPath(p);
  };
  const outputFile = (raw: boolean): string => {
    if (!engine) return '';
    const dir = engine.runDir(taskId, runId);
    const clean = path.join(dir, 'output.txt');
    return !raw && fs.existsSync(clean) ? clean : path.join(dir, 'output.log');
  };
  let rawChecked = false;
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        {
          label: 'Open &Output File',
          click: () => void openHostPath(outputFile(rawChecked)),
        },
        { type: 'separator' },
        {
          label: 'Open &Run Folder',
          click: () => { if (engine) void openHostPath(engine.runDir(taskId, runId)); },
        },
        {
          label: 'Open &Working Directory',
          enabled: !!task?.cwd,
          click: () => { if (task?.cwd) void openHostPath(task.cwd); },
        },
      ],
    },
    {
      label: '&View',
      submenu: [
        { id: 'raw-output', label: '&Raw Terminal Log', type: 'checkbox', checked: false, click: (item) => { rawChecked = item.checked; send('toggle-raw-output'); } },
      ],
    },
  ];
  attachWindowMenu(child, template);
  loadRenderer(child, hash);
}

function openMessagesWindow(taskId: string, runId: string, agentId?: string, label?: string): void {
  const task = engine?.getTask(taskId);
  const title = agentId
    ? label?.trim()
      ? `Subagent: ${label.trim().slice(0, 80)}`
      : `Subagent ${agentId}`
    : `Messages – ${task ? task.name : taskId} – ${runId}`;
  const child = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    title,
    icon: appIcon,
    backgroundColor: windowBackground(),
    maximizable: true,
    webPreferences: webPreferences(),
  });
  const send = (payload: unknown) => {
    if (!child.isDestroyed()) child.webContents.send('ui:event', payload);
  };
  // The Show toggles filter row categories; Filter… opens the filter window,
  // and its checkmark mirrors whether a filter is active (reported by the
  // renderer), not the click itself.
  let filterValue = '';
  const showItem = (id: string, label: string, key: string): Electron.MenuItemConstructorOptions => ({
    id,
    label,
    type: 'checkbox',
    checked: true,
    click: (item) => send({ type: 'messages-show', key, checked: item.checked }),
  });
  const openHostPath = async (p: string) => {
    if (process.platform === 'win32' && p.startsWith('/')) {
      const winPath = await convertWslPath(p, 'windows');
      if (winPath) {
        void shell.openPath(winPath);
        return;
      }
    }
    void shell.openPath(p);
  };
  // The export options window remembers the last choice for this window's lifetime.
  let exportOpts = { includeThinking: true, includeTools: true, plain: false };
  const saveMarkdown = async () => {
    if (!engine) return;
    try {
      const result = await engine.readMessages(taskId, runId, agentId, false);
      if (result.status !== 'ok' || result.rows.length === 0) {
        await dialog.showMessageBox(child, { type: 'error', title: 'Looper', message: 'There are no messages to save.', buttons: ['OK'] });
        return;
      }
      const picked = await dialog.showSaveDialog(child, {
        title: 'Save as Markdown',
        defaultPath: `${title.replace(/[\\/:*?"<>|]/g, '-')}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (picked.canceled || !picked.filePath) return;
      // The native save dialog can't hold checkboxes, so the options are a
      // follow-up window shown once the location is set.
      const chosen = await promptMarkdownExport(child, exportOpts);
      if (!chosen) return;
      exportOpts = chosen;
      const md = messagesToMarkdown(result.rows, { title, ...chosen });
      fs.writeFileSync(picked.filePath, md, 'utf8');
    } catch (err) {
      await dialog.showMessageBox(child, {
        type: 'error',
        title: 'Looper',
        message: 'Could not save the messages.',
        detail: (err as Error).message,
        buttons: ['OK'],
      });
    }
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: '&Save as Markdown…', accelerator: 'CmdOrCtrl+S', click: () => void saveMarkdown() },
        { type: 'separator' },
        {
          label: 'Open &Run Folder',
          click: () => {
            if (engine) void shell.openPath(engine.runDir(taskId, runId));
          },
        },
        {
          label: 'Open &Working Directory',
          enabled: !!task?.cwd,
          click: () => {
            if (task?.cwd) void openHostPath(task.cwd);
          },
        },
      ],
    },
    {
      label: '&View',
      submenu: [
        {
          label: '&Raw Messages',
          type: 'checkbox',
          checked: false,
          click: (item) => send({ type: 'messages-raw', checked: item.checked }),
        },
        { type: 'separator' },
        showItem('show-messages', 'Show &Messages', 'messages'),
        showItem('show-thinking', 'Show &Thinking', 'thinking'),
        showItem('show-tools', 'Show Tool &Usage', 'tools'),
        showItem('show-subagents', 'Show &Subagents', 'subagents'),
        { type: 'separator' },
        {
          id: 'filter',
          label: '&Filter…',
          type: 'checkbox',
          checked: false,
          accelerator: 'CmdOrCtrl+F',
          click: (item) => {
            item.checked = filterValue.trim() !== '';
            openChildWindow(`messages-filter/${encodeURIComponent(filterValue)}`, 'Filter', 420, 240, child, {
              minWidth: 360,
              minHeight: 220,
              resizable: false,
            });
          },
        },
      ],
    },
  ];
  const menu = attachWindowMenu(child, template);
  const onFilterState = (e: Electron.IpcMainEvent, filter: string) => {
    if (BrowserWindow.fromWebContents(e.sender) !== child) return;
    filterValue = String(filter ?? '');
    const item = menu.getMenuItemById('filter');
    if (item) item.checked = filterValue.trim() !== '';
  };
  ipcMain.on('messages:filter-state', onFilterState);
  child.on('closed', () => ipcMain.removeListener('messages:filter-state', onFilterState));
  child.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  const hash =
    `messages/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}/${agentId ? encodeURIComponent(agentId) : '-'}` +
    `/${encodeURIComponent(title)}`;
  loadRenderer(child, hash);
}

function openImageWindow(taskId: string, runId: string, rowId: string, agentId?: string, label?: string): void {
  const name = label?.trim() ? label.trim().slice(0, 80) : `${runId} row ${rowId}`;
  const child = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 420,
    minHeight: 320,
    title: `Image – ${name}`,
    icon: appIcon,
    backgroundColor: windowBackground(),
    maximizable: true,
    webPreferences: webPreferences(),
  });
  child.removeMenu();
  child.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  const hash =
    `image/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}/${agentId ? encodeURIComponent(agentId) : '-'}` +
    `/${encodeURIComponent(rowId)}/${encodeURIComponent(`Image – ${name}`)}`;
  loadRenderer(child, hash);
}

export function openEditorWindow(taskId?: string): void {
  openChildWindow(
    taskId ? `editor/${encodeURIComponent(taskId)}` : 'editor',
    taskId ? 'Edit Task — Looper' : 'New Task — Looper',
    780,
    700,
  );
}


function openNoteEditorWindow(taskId: string): void {
  openChildWindow(
    `note-editor/${encodeURIComponent(taskId)}`,
    'Guidance for Next Run — Looper',
    520,
    400,
    undefined,
    { minWidth: 460, minHeight: 340 },
  );
}

function openFolderNoteEditorWindow(folderId: string): void {
  openChildWindow(
    `note-editor-folder/${encodeURIComponent(folderId)}`,
    'Guidance for Next Runs — Looper',
    520,
    400,
    undefined,
    { minWidth: 460, minHeight: 340 },
  );
}

function openMoveToFolderWindow(taskId: string): void {
  openChildWindow(`move-to-folder/${encodeURIComponent(taskId)}`, 'Move to Folder — Looper', 460, 440, win);
}

function openNewFolderWindow(parentId?: string): void {
  const hash = parentId ? `folder-new/${encodeURIComponent(parentId)}` : 'folder-new';
  openChildWindow(hash, 'New Folder — Looper', 420, 300, win, {
    minWidth: 420,
    minHeight: 300,
    resizable: false,
  });
}

function openRenameFolderWindow(folderId: string): void {
  openChildWindow(`folder-rename/${encodeURIComponent(folderId)}`, 'Rename Folder — Looper', 420, 240, win, {
    minWidth: 420,
    minHeight: 240,
    resizable: false,
  });
}

function openSettingsWindow(): void {
  openChildWindow('settings', 'Settings — Looper', 720, 620, win);
}

function openTemplatesWindow(): void {
  openChildWindow('templates', 'Templates — Looper', 560, 520);
}

function openInstructionsWindow(): void {
  openChildWindow('instructions', 'Instructions', 800, 700);
}

function openEngineLogWindow(): void {
  const child = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    title: 'Engine Log',
    icon: appIcon,
    backgroundColor: windowBackground(),
    maximizable: true,
    webPreferences: webPreferences(),
  });
  child.removeMenu();
  child.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRenderer(child, 'engine-log');
}

function openAboutWindow(): void {
  openChildWindow('about', 'About', 360, 320, win, { minWidth: 360, minHeight: 320, resizable: false });
}

function openEnvEditorWindow(envId: string, isNew?: boolean, parent?: BrowserWindow | null): void {
  openChildWindow(
    `env-editor/${encodeURIComponent(envId)}${isNew ? '/new' : ''}`,
    isNew ? 'New Environment — Looper' : 'Edit Environment — Looper',
    700,
    560,
    parent,
  );
}

function openHarnessEditorWindow(
  envId: string,
  harnessId: string,
  isNew?: boolean,
  parent?: BrowserWindow | null,
): void {
  openChildWindow(
    `harness-editor/${encodeURIComponent(envId)}/${encodeURIComponent(harnessId)}${isNew ? '/new' : ''}`,
    isNew ? 'New Harness — Looper' : 'Edit Harness — Looper',
    640,
    620,
    parent,
  );
}

function openModelEditorWindow(
  envId: string,
  harnessId: string,
  index?: number,
  parent?: BrowserWindow | null,
): void {
  openChildWindow(
    `model-editor/${encodeURIComponent(envId)}/${encodeURIComponent(harnessId)}/${index === undefined ? 'new' : index}`,
    index === undefined ? 'New Model — Looper' : 'Edit Model — Looper',
    420,
    290,
    parent,
    { minWidth: 420, minHeight: 290, resizable: false },
  );
}

function openTemplateEditorWindow(templateId?: string, _parent?: BrowserWindow | null): void {
  openChildWindow(
    templateId ? `template-editor/${encodeURIComponent(templateId)}` : 'template-editor',
    templateId ? 'Edit Template — Looper' : 'New Template — Looper',
    780,
    700,
  );
}

function openTemplatePickerWindow(): void {
  openChildWindow('template-picker', 'New Task from Template — Looper', 480, 420, win);
}

function openEditorFromTemplateWindow(templateId: string): void {
  const child = openChildWindow(
    `editor-from-template/${encodeURIComponent(templateId)}`,
    'New Task — Looper',
    780,
    700,
  );
  // The picker is modal to main; closing it auto-focuses main.
  // Intercept that focus event and redirect to the editor.
  if (win && !win.isDestroyed()) {
    const redirect = () => { if (!child.isDestroyed()) child.focus(); };
    win.once('focus', redirect);
    child.once('closed', () => win?.removeListener('focus', redirect));
  }
}

/** Raw JSON of pending imports, keyed by the editor window that will consume it. */
const importDrafts = new Map<string, unknown>();

function takeImportDraft(key: string): unknown {
  const draft = importDrafts.get(key);
  importDrafts.delete(key);
  return draft ?? null;
}

/** Pick a .loopertask file and open a New Task editor prefilled from it. */
async function importTask(): Promise<void> {
  if (!win || win.isDestroyed()) return;
  const result = await dialog.showOpenDialog(win, {
    title: 'Import Task',
    filters: [{ name: FILE_KINDS.task.filterName, extensions: [FILE_KINDS.task.ext] }],
    properties: ['openFile'],
  });
  const file = result.canceled ? undefined : result.filePaths[0];
  if (file) await openLooperFile(file);
}

async function fileErrorBox(message: string, detail: string): Promise<void> {
  const opts: Electron.MessageBoxOptions = { type: 'error', title: 'Looper', message, detail, buttons: ['OK'] };
  if (win && !win.isDestroyed()) await dialog.showMessageBox(win, opts);
  else await dialog.showMessageBox(opts);
}

/** The last argument naming an existing Looper document (double-click / “Open with” / drop). */
function looperFileFromArgv(argv: string[]): string | undefined {
  for (let i = argv.length - 1; i > 0; i--) {
    const arg = argv[i];
    if (arg.startsWith('-') || !isLooperFileName(arg)) continue;
    if (fs.existsSync(arg)) return arg;
  }
  return undefined;
}

/**
 * Open a Looper document as if double-clicked: check the envelope, route by
 * its $type, and open the matching import editor prefilled from the payload.
 * The editor sanitizes field by field, so a bad payload yields empty/default
 * fields to fix rather than an error.
 */
async function openLooperFile(file: string): Promise<void> {
  if (!isLooperFileName(file)) return;
  let input: unknown;
  try {
    input = readJson<unknown>(file, undefined);
  } catch (err) {
    await fileErrorBox('Could not read the file.', (err as Error).message);
    return;
  }
  if (input === undefined) {
    await fileErrorBox('Could not read the file.', `File not found: ${file}`);
    return;
  }
  const doc = readLooperFile(input);
  if (!doc.ok) {
    if (doc.reason === 'newer') {
      await fileErrorBox(
        'This file was created by a newer version of Looper.',
        doc.app ? `Update Looper to version ${doc.app} or later to import it.` : 'Update Looper to import it.',
      );
    } else {
      await fileErrorBox('Could not import the file.', 'The file does not contain a Looper task or template.');
    }
    return;
  }
  let payload: Record<string, unknown> = doc.payload;
  // A task opened next to its script/files runs from that folder: dead paths
  // in cwd and the check command are re-pointed at the .loopertask's own dir.
  if (doc.kind === 'task' && engine) {
    try {
      payload = await adjustImportedTaskPaths(payload, file, engine.settings, engine.host);
    } catch {
      /* keep the payload as imported */
    }
  }
  const key = Math.random().toString(36).slice(2, 10);
  importDrafts.set(key, payload);
  if (doc.kind === 'task') openChildWindow(`editor-import/${key}`, 'New Task — Looper', 780, 700);
  else openChildWindow(`template-import/${key}`, 'New Template — Looper', 780, 700);
}

/** Send a UI command to the main window (menu accelerators act on the selected task there). */
function sendUi(type: string): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('ui:event', { type });
    win.focus();
  }
}

/** Last selection reported by the renderer, so out-of-band rebuilds (rest events) keep the Task menu state. */
let menuSelection: [
  boolean,
  boolean | undefined,
  boolean | undefined,
  string | undefined,
  boolean,
  boolean | undefined,
  boolean,
  boolean,
] = [false, undefined, undefined, undefined, false, undefined, false, false];

function updateTaskMenu(
  hasTask: boolean,
  taskEnabled?: boolean,
  taskPaused?: boolean,
  taskState?: string,
  hasNote?: boolean,
  canRunNow?: boolean,
  taskCompleted?: boolean,
  allowComplete?: boolean,
): void {
  menuSelection = [
    hasTask,
    taskEnabled,
    taskPaused,
    taskState,
    hasNote ?? false,
    canRunNow,
    taskCompleted ?? false,
    allowComplete ?? false,
  ];
  buildMenu(...menuSelection);
}

function rebuildMenu(): void {
  buildMenu(...menuSelection);
}

/** Persist a View-menu option; the settings event carries it to the renderer. */
function updateView(patch: Partial<Settings['view']>): void {
  if (!engine) return;
  engine.updateSettings({ view: { ...engine.settings.view, ...patch } });
}

function buildMenu(
  hasTask = false,
  taskEnabled?: boolean,
  taskPaused?: boolean,
  taskState?: string,
  hasNote = false,
  canRunNow?: boolean,
  taskCompleted = false,
  allowComplete = false,
): void {
  const active = taskState === 'running' || taskState === 'checking' || taskState === 'classifying';
  // The renderer knows the task's run cap; a task with room under it can still Run Now while active.
  const runNow = canRunNow ?? !active;
  const view: Settings['view'] = engine?.settings.view ?? {
    toolbar: true,
    statusBar: true,
    taskList: 'standard',
    showDisabledTasks: true,
    showCompletedTasks: true,
    showScheduledTasks: true,
    showManualTasks: true,
    autoOpenFolders: true,
    hideNoActionRuns: false,
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: '&New Task…', accelerator: 'CmdOrCtrl+N', click: () => openEditorWindow() },
        { label: 'New Task from &Template…', accelerator: 'CmdOrCtrl+Shift+N', click: () => openTemplatePickerWindow() },
        { label: 'New &Folder…', click: () => openNewFolderWindow() },
        { type: 'separator' },
        { label: '&Import Task…', click: () => void importTask() },
        { id: 'task-export', label: 'Ex&port Task…', enabled: hasTask, click: () => sendUi('export-task') },
        { type: 'separator' },
        { label: 'Temp&lates…', click: () => openTemplatesWindow() },
        { label: 'S&ettings…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
        // macOS: Quit lives in the app menu that macTemplate prepends.
        ...(process.platform === 'darwin'
          ? []
          : ([
              { type: 'separator' },
              ...restMenuItems(),
              ...(engine?.host === 'windows' ? [{ type: 'separator' } as Electron.MenuItemConstructorOptions] : []),
              { role: 'quit', label: 'E&xit' },
            ] as Electron.MenuItemConstructorOptions[])),
      ],
    },
    {
      label: '&Task',
      submenu: [
        { id: 'task-run-now', label: '&Run Now', accelerator: 'F5', enabled: hasTask && runNow, click: () => sendUi('run-now') },
        { id: 'task-stop', label: '&Stop Task', accelerator: 'Shift+F5', enabled: hasTask && active, click: () => sendUi('stop-task') },
        { id: 'task-pause-resume', label: taskPaused ? '&Resume' : '&Pause', accelerator: 'CmdOrCtrl+P', enabled: hasTask && taskState !== 'disabled' && !taskCompleted, click: () => sendUi('pause-resume') },
        { id: 'task-enable-disable', label: taskEnabled === false ? 'E&nable' : '&Disable', enabled: hasTask && !taskCompleted, click: () => sendUi('enable-disable') },
        { id: 'task-complete', label: taskCompleted ? 'Re&open' : 'C&omplete', enabled: hasTask && (taskCompleted || allowComplete), click: () => sendUi('complete-reopen') },
        { id: 'task-edit', label: '&Edit Task…', accelerator: 'CmdOrCtrl+E', enabled: hasTask, click: () => sendUi('edit-task') },
        { id: 'task-delete', label: 'De&lete Task', enabled: hasTask, click: () => sendUi('delete-task') },
        { type: 'separator' },
        { id: 'task-note', label: hasNote ? 'Edit &Guidance for Next Run…' : 'Add &Guidance for Next Run…', enabled: hasTask, click: () => sendUi('edit-note') },
        { id: 'task-note-clear', label: 'Clear Guidance', enabled: hasTask && hasNote, click: () => sendUi('clear-note') },
        { type: 'separator' },
        { id: 'task-move-folder', label: 'Move to &Folder…', enabled: hasTask, click: () => sendUi('move-to-folder') },
        { id: 'task-clear-runs', label: 'Clear Run &History…', enabled: hasTask && !active, click: () => sendUi('clear-runs') },
        { type: 'separator' },
        { id: 'task-terminal', label: 'Open Project in &Terminal', accelerator: 'CmdOrCtrl+T', enabled: hasTask, click: () => sendUi('open-terminal') },
        { id: 'task-work-folder', label: 'Open &Working Directory', enabled: hasTask, click: () => sendUi('open-work-folder') },
      ],
    },
    {
      label: '&View',
      submenu: [
        {
          label: 'Task &List',
          submenu: [
            { label: '&Standard', type: 'radio', checked: view.taskList !== 'compact', click: () => updateView({ taskList: 'standard' }) },
            { label: '&Compact', type: 'radio', checked: view.taskList === 'compact', click: () => updateView({ taskList: 'compact' }) },
            { type: 'separator' },
            { label: 'Show &Disabled Tasks', type: 'checkbox', checked: view.showDisabledTasks, click: (item) => updateView({ showDisabledTasks: item.checked }) },
            { label: 'Show Comp&leted Tasks', type: 'checkbox', checked: view.showCompletedTasks, click: (item) => updateView({ showCompletedTasks: item.checked }) },
            { label: 'Show S&cheduled Tasks', type: 'checkbox', checked: view.showScheduledTasks, click: (item) => updateView({ showScheduledTasks: item.checked }) },
            { label: 'Show &Manual Tasks', type: 'checkbox', checked: view.showManualTasks, click: (item) => updateView({ showManualTasks: item.checked }) },
            { type: 'separator' },
            { label: '&Open Folders Automatically', type: 'checkbox', checked: view.autoOpenFolders, click: (item) => updateView({ autoOpenFolders: item.checked }) },
          ],
        },
        {
          label: 'Task Lo&gs',
          submenu: [
            { label: 'Hide Runs with &No Action', type: 'checkbox', checked: view.hideNoActionRuns, click: (item) => updateView({ hideNoActionRuns: item.checked }) },
          ],
        },
        { type: 'separator' },
        { label: '&Toolbar', type: 'checkbox', checked: view.toolbar, click: (item) => updateView({ toolbar: item.checked }) },
        { label: 'Status &Bar', type: 'checkbox', checked: view.statusBar, click: (item) => updateView({ statusBar: item.checked }) },
      ],
    },
    {
      label: '&Advanced',
      submenu: [
        { label: 'Engine &Log', click: () => openEngineLogWindow() },
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
        { role: 'reload', label: '&Reload UI' },
        { role: 'toggleDevTools', label: 'Toggle &Developer Tools' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: '&Instructions', accelerator: 'F1', click: () => openInstructionsWindow() },
        { type: 'separator' },
        { label: '&About Looper', click: () => openAboutWindow() },
      ],
    },
  ];
  if (process.platform === 'darwin') {
    // Don't stomp the menu of a focused run-detail/messages window; the
    // browser-window-focus handler restores the main menu on the next switch.
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || !macWindowMenus.has(focused)) {
      Menu.setApplicationMenu(Menu.buildFromTemplate(macTemplate(template)));
    }
  } else if (win && !win.isDestroyed()) {
    win.setMenu(Menu.buildFromTemplate(template));
  }
}
