import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createEngine, type Engine } from '../engine/engine';
import type { Settings } from '../shared/types';
import { convertWslPath, defaultDataDir } from '../engine/host';
import { readJson } from '../engine/store/fsutil';
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
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(() => {
    engine = createEngine({ dataDir: defaultDataDir() });
    engine.start();
    registerIpc(engine, {
      getWindow: () => win,
      openRunDetail: openRunDetailWindow,
      openEditor: openEditorWindow,
      openNoteEditor: openNoteEditorWindow,

      openEnvEditor: openEnvEditorWindow,
      openHarnessEditor: openHarnessEditorWindow,
      openModelEditor: openModelEditorWindow,
      openTemplateEditor: openTemplateEditorWindow,
      openTemplatePicker: openTemplatePickerWindow,
      openEditorFromTemplate: openEditorFromTemplateWindow,
      takeImportDraft,
      updateTaskMenu,
    });
    Menu.setApplicationMenu(null);
    createTray();
    if (!startHidden) createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!engine?.settings.closeToTray) app.quit();
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

const appIcon = path.join(__dirname, '../../build/icon.png');
const trayIcon = process.platform === 'win32'
  ? path.join(__dirname, '../../build/icon.ico')
  : appIcon;

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow();
  } else {
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(trayIcon));
  tray.setToolTip('Looper');
  tray.on('double-click', showWindow);
  const menu = Menu.buildFromTemplate([
    { label: 'Show Looper', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
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
    if (!quitting && engine?.settings.closeToTray) {
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
  const menu = Menu.buildFromTemplate([
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
  ]);
  child.setMenu(menu);
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

function openSettingsWindow(): void {
  openChildWindow('settings', 'Settings — Looper', 720, 620, win);
}

function openTemplatesWindow(): void {
  openChildWindow('templates', 'Templates — Looper', 560, 520);
}

function openInstructionsWindow(): void {
  openChildWindow('instructions', 'Instructions', 800, 700);
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

/**
 * Pick a task JSON file and open a New Task editor prefilled from it. The
 * editor sanitizes field by field, so a bad file yields empty/default fields
 * to fix rather than an error.
 */
async function importTask(): Promise<void> {
  if (!win || win.isDestroyed()) return;
  const result = await dialog.showOpenDialog(win, {
    title: 'Import Task',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  const file = result.canceled ? undefined : result.filePaths[0];
  if (!file) return;
  let input: unknown;
  try {
    input = readJson<unknown>(file, undefined);
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Looper',
      message: 'Could not read the task file.',
      detail: (err as Error).message,
      buttons: ['OK'],
    });
    return;
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Looper',
      message: 'Could not import task.',
      detail: 'The file does not contain a task object.',
      buttons: ['OK'],
    });
    return;
  }
  const key = Math.random().toString(36).slice(2, 10);
  importDrafts.set(key, input);
  openChildWindow(`editor-import/${key}`, 'New Task — Looper', 780, 700);
}

/** Send a UI command to the main window (menu accelerators act on the selected task there). */
function sendUi(type: string): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('ui:event', { type });
    win.focus();
  }
}

function updateTaskMenu(hasTask: boolean, taskEnabled?: boolean, taskPaused?: boolean, taskState?: string, hasNote?: boolean): void {
  buildMenu(hasTask, taskEnabled, taskPaused, taskState, hasNote);
}

/** Persist a View-menu option; the settings event carries it to the renderer. */
function updateView(patch: Partial<Settings['view']>): void {
  if (!engine) return;
  engine.updateSettings({ view: { ...engine.settings.view, ...patch } });
}

function buildMenu(hasTask = false, taskEnabled?: boolean, taskPaused?: boolean, taskState?: string, hasNote = false): void {
  const active = taskState === 'running' || taskState === 'checking' || taskState === 'classifying';
  const view: Settings['view'] = engine?.settings.view ?? {
    toolbar: true,
    statusBar: true,
    taskList: 'standard',
    showDisabledTasks: true,
    showScheduledTasks: true,
    showManualTasks: true,
    hideNoActionRuns: false,
  };
  const menu = Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        { label: '&New Task…', accelerator: 'CmdOrCtrl+N', click: () => openEditorWindow() },
        { label: 'New Task from &Template…', accelerator: 'CmdOrCtrl+Shift+N', click: () => openTemplatePickerWindow() },
        { type: 'separator' },
        { label: '&Import Task…', click: () => void importTask() },
        { id: 'task-export', label: 'Ex&port Task…', enabled: hasTask, click: () => sendUi('export-task') },
        { type: 'separator' },
        { label: 'Temp&lates…', click: () => openTemplatesWindow() },
        { label: 'S&ettings…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
        { type: 'separator' },
        { role: 'quit', label: 'E&xit' },
      ],
    },
    {
      label: '&Task',
      submenu: [
        { id: 'task-run-now', label: '&Run Now', accelerator: 'F5', enabled: hasTask && !active, click: () => sendUi('run-now') },
        { id: 'task-stop-agent', label: '&Stop Agent', accelerator: 'Shift+F5', enabled: hasTask && taskState === 'running', click: () => sendUi('stop-agent') },
        { id: 'task-pause-resume', label: taskPaused ? '&Resume' : '&Pause', accelerator: 'CmdOrCtrl+P', enabled: hasTask && taskState !== 'disabled', click: () => sendUi('pause-resume') },
        { id: 'task-enable-disable', label: taskEnabled === false ? '&Enable' : '&Disable', enabled: hasTask, click: () => sendUi('enable-disable') },
        { type: 'separator' },
        { id: 'task-note', label: hasNote ? 'Edit &Guidance for Next Run…' : 'Add &Guidance for Next Run…', enabled: hasTask, click: () => sendUi('edit-note') },
        { id: 'task-note-clear', label: 'Clear Guidance', enabled: hasTask && hasNote, click: () => sendUi('clear-note') },
        { type: 'separator' },
        { id: 'task-terminal', label: 'Open Project in &Terminal', accelerator: 'CmdOrCtrl+T', enabled: hasTask, click: () => sendUi('open-terminal') },
        { id: 'task-work-folder', label: 'Open &Working Directory', enabled: hasTask, click: () => sendUi('open-work-folder') },
        { type: 'separator' },
        { id: 'task-edit', label: '&Edit Task…', accelerator: 'CmdOrCtrl+E', enabled: hasTask, click: () => sendUi('edit-task') },
        { id: 'task-clear-runs', label: 'Clear Run &History…', enabled: hasTask && !active, click: () => sendUi('clear-runs') },
        { id: 'task-delete', label: '&Delete Task', enabled: hasTask, click: () => sendUi('delete-task') },
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
            { label: 'Show S&cheduled Tasks', type: 'checkbox', checked: view.showScheduledTasks, click: (item) => updateView({ showScheduledTasks: item.checked }) },
            { label: 'Show &Manual Tasks', type: 'checkbox', checked: view.showManualTasks, click: (item) => updateView({ showManualTasks: item.checked }) },
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
  ]);
  if (win && !win.isDestroyed()) win.setMenu(menu);
}
