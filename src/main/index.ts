import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createEngine, type Engine } from '../engine/engine';
import { describeHolder, EngineLock, liveHolder, TAKEOVER_WAIT_MS, type LockHolder } from '../engine/lock';
import { readWakeTimerPolicy } from '../engine/power-win';
import type { PowerAdapter } from '../engine/rest';
import { ViewSchema, type EngineEvent, type Settings } from '../shared/types';
import type { BuilderSetup } from '../shared/builder';
import { projectTaskId } from '../shared/projects';
import type { ChatSettings, ChatState } from '../shared/chat';
import { EFFORT_LEVELS, PERMISSION_MODES } from '../shared/environments';
import { convertWslPath, defaultDataDir } from '../engine/host';
import { readJson } from '../engine/store/fsutil';
import { FILE_KINDS, isAddonFileName, isLooperFileName, readLooperFile } from '../shared/files';
import { messagesToMarkdown } from '../shared/messages-md';
import { adjustImportedTaskPaths } from './import-paths';
import { AddonHost } from './addon-host';
import { addonPanesMenu, addonToolbarsMenu, addonToolsMenu, installAddonFile, registerAddonIpc, sendAddonEvent, type AddonUiDeps } from './addons';
import { ENGINE_LOG_LOOPER, engineLogAddonSource, type EngineLogLevel } from '../shared/addons';
import { broadcastEvent, registerIpc } from './ipc';
import {
  callerMainWindow,
  caller,
  ipc,
  isRemote,
  newWindow,
  notifyClients,
  ofCaller,
  openPath,
  remoteMainWindows,
  runAs,
  setWindowMenu,
  showMessageBox,
  showOpenDialog,
  showSaveDialog,
  useRemoteClients,
  windowOf,
  WindowSlots,
  writeClipboard,
  type AppWindow,
  type RemoteWindow,
} from './platform';
import { RemoteAccess } from './remote-access';
import { pwaIcons } from './pwa-icons';
import type { RemoteAccessPhase } from '../shared/remote-access';
import { taskListMenu } from './view-menu';

let win: BrowserWindow | null = null;
let engine: Engine | null = null;
let addons: AddonHost | null = null;
let tray: Tray | null = null;
let quitting = false;
/** Whether Remote Control was on at its last event: the menus change only when this does. */
let remoteRunning = false;
let remoteAccess: RemoteAccess | null = null;
/** Remote Access's phase at its last event: the menu changes only when this does. */
let remoteAccessPhase: RemoteAccessPhase = 'off';

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

  app.whenReady().then(async () => {
    // Windows routes toasts by AppUserModelID; without it dev runs show nothing.
    // Dev runs get their own id so the dev Start Menu shortcut (see
    // scripts/register-notifications.js) can never hijack the packaged app's
    // taskbar identity.
    if (process.platform === 'win32') {
      app.setAppUserModelId(app.isPackaged ? 'com.lemorim.looper' : 'com.lemorim.looper.dev');
      if (!app.isPackaged) removeDevAumidHijackers();
    }
    const dataDir = defaultDataDir();
    if (!(await claimDataDir(dataDir))) {
      quitting = true;
      app.quit();
      return;
    }
    engine = createEngine({
      dataDir,
      ...(process.platform === 'win32' ? { power: createPowerAdapter() } : {}),
    });
    engine.start();
    engine.on((event) => {
      if (event.type === 'notify') showTaskNotification(event);
      else if (event.type === 'projects') tray?.setContextMenu(trayMenu());
      else if (event.type === 'sessions') void remoteAccess?.sessionsChanged(event.state.sessions, !!engine?.settings.notificationsEnabled);
      else if (event.type === 'settings') {
        applyRemoteAccess();
        tray?.setContextMenu(trayMenu());
        // The View menu follows the view settings, which a pane header's context menu also changes.
        rebuildMenu();
      }
      else if (event.type === 'rest') {
        if (event.disarmReason === 'user-wake') showRestDisarmNotification();
        tray?.setContextMenu(trayMenu());
        rebuildMenu();
      } else if (event.type === 'remote' && event.state.running !== remoteRunning) {
        // Start/Stop Remote Control and the Rest Mode item follow it.
        remoteRunning = event.state.running;
        tray?.setContextMenu(trayMenu());
        rebuildMenu();
      }
    });
    // Start with Looper turned it on before the listener above was there.
    remoteRunning = engine.remoteState().running;
    registerIpc(engine, {
      getWindow: () => win,
      openMessages: openMessagesWindow,
      openMessageImage: openImageWindow,
      openEditor: openEditorWindow,
      promptRunOptions,
      openNoteEditor: openNoteEditorWindow,
      openContinueRun: openContinueRunWindow,
      openSendGuidance: openSendGuidanceWindow,
      openFolderNoteEditor: openFolderNoteEditorWindow,
      openMoveToFolder: openMoveToFolderWindow,
      openNewFolder: openNewFolderWindow,
      openRenameFolder: openRenameFolderWindow,

      openEnvEditor: openEnvEditorWindow,
      openHarnessEditor: openHarnessEditorWindow,
      openModelEditor: openModelEditorWindow,
      openModelUpdate: openModelUpdateWindow,
      openTemplateEditor: openTemplateEditorWindow,
      openTemplatePicker: openTemplatePickerWindow,
      openEditorFromTemplate: openEditorFromTemplateWindow,
      openVersions: openVersionsWindow,
      openVersionDetail: openVersionDetailWindow,
      openBuilderSetup: openBuilderSetupWindow,
      startBuilder: startBuilderInWindow,
      editWithAgent,
      reviewBuilder,
      builderWindow: (id) => (builderWindows.get(id) ?? []).filter((w) => !w.isDestroyed()),
      openTerminal,
      terminalWindow: (id) => [...terminalWindows.all(id), ...sessionWindowsShowing(id)],
      openChat,
      forkChat,
      sessionWindow: sessionWindowsShowing,
      showSession,
      closeSession: (id) => closeSessionAsk(id),
      openSendToSessions: openSendToSessionsWindow,
      openSessions: (select) => openSessionsWindow(select),
      chatSettingMenu,
      openRemoteConversation,
      openRemoteHelperEditor,
      remoteAccess: () => remoteAccess,
      openRemoteAccessPair: openRemoteAccessPairWindow,
      openRemoteAccessRename: openRemoteAccessRenameWindow,
      openNotification,
      openProjectEditor,
      openNewTaskIn,
      takeImportDraft,
      openLooperFile,
      updateTaskMenu,
    });
    const eng = engine;
    remoteAccess = new RemoteAccess({
      dataDir: eng.dataDir,
      log: eng.log,
      settings: () => eng.settings.remoteAccess,
      version: app.getVersion(),
      ipc,
      icon: pwaIcons(appIcon),
      emit: (state) => {
        broadcastEvent({ type: 'remote-access', state });
        if (state.phase !== remoteAccessPhase) {
          remoteAccessPhase = state.phase;
          rebuildMenu();
        }
      },
    });
    useRemoteClients(remoteAccess.clients);
    // A new browser tab's main window gets the main window's menu bar.
    remoteAccess.clients.onMainWindow((w) => {
      buildRemoteMenu(w);
      reopenRescuedBuilders(w);
    });
    applyRemoteAccess();
    addons = new AddonHost({
      dir: path.join(engine.dataDir, 'addons'),
      host: engine.host,
      appVersion: app.getVersion(),
      log: engine.log,
      onChange: (list) => {
        sendAddonEvent({ type: 'addons', addons: list });
        rebuildMenu();
      },
      onRefresh: (addonId) => sendAddonEvent({ type: 'refresh', addonId }),
      disabled: () => engine?.settings.disabledAddons ?? [],
      setDisabled: (ids) => engine?.updateSettings({ disabledAddons: ids }),
      runs: () => engine?.settings.addonRuns ?? {},
      setRuns: (runs) => engine?.updateSettings({ addonRuns: runs }),
      environments: () => ({
        environments: engine?.settings.environments ?? [],
        defaultEnvironmentId: engine?.settings.defaultEnvironmentId ?? '',
      }),
    });
    registerAddonIpc(addonDeps());
    addons.start();
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
  // own menu (run, subagent) shows it; every other window shows the main menu.
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
    void confirmQuit().then((ok) => {
      if (!ok || quitting || !engine) return;
      quitting = true;
      addons?.dispose();
      Promise.all([engine.stop(), remoteAccess?.dispose()])
        .catch(() => undefined)
        .finally(() => {
          engineLock?.release();
          app.quit();
        });
    });
  });
}

let engineLock: EngineLock | null = null;

/**
 * Take the data dir's engine lock. When another engine is running on the
 * same folder, ask first: Take Over makes that one stop (it notices at its
 * next heartbeat) and waits for it to, Quit leaves it running. False = quit.
 */
async function claimDataDir(dataDir: string): Promise<boolean> {
  const holder = liveHolder(dataDir);
  if (holder) {
    const r = await showMessageBox(undefined, {
      type: 'question',
      title: 'Looper',
      message: 'Looper is already running on this data folder.',
      detail:
        `It's ${describeHolder(holder)}. Running both would run every task twice. ` +
        'Take Over stops that one, along with any runs it has going.',
      buttons: ['Take Over', 'Quit'],
      noLink: true,
      defaultId: 1,
      cancelId: 1,
    });
    if (r.response !== 0) return false;
  }
  engineLock = new EngineLock(dataDir, 'desktop', (by) => void onLockLost(by));
  engineLock.acquire();
  if (holder) await new Promise((r) => setTimeout(r, TAKEOVER_WAIT_MS));
  return true;
}

/** Another engine took the data dir over: stop running tasks here and quit. */
async function onLockLost(by: LockHolder | null): Promise<void> {
  quitting = true;
  await Promise.all([engine?.stop(), remoteAccess?.dispose()]).catch(() => undefined);
  await showMessageBox(undefined, {
    type: 'error',
    title: 'Looper',
    message: 'Another Looper took over this data folder.',
    detail: `${by ? `It's ${describeHolder(by)}. ` : ''}This Looper stopped its runs and quits.`,
    buttons: ['OK'],
  });
  app.quit();
}

/**
 * The confirmation quitting needs now, or null when it can go ahead: what it
 * would stop that the confirmQuit setting asks about, plus any terminal
 * session still running in a Looper window. A task with a run in flight
 * counts as running even when its watcher is up as well.
 */
function quitWarning(): { message: string; detail: string } | null {
  if (!engine) return null;
  const ask = engine.settings.confirmQuit;
  // Someone is typing into a terminal session or a chat: always ask, whatever the setting says about runs.
  const terminals = engine.runningTerminalSessions();
  const chats = engine.busyChats();
  const remote = engine.usedRemoteConversations();
  const rts = ask.runs ? engine.listRuntimes() : [];
  const running = rts.filter((rt) => rt.runs.length > 0).length;
  const watching = ask.watchers ? rts.filter((rt) => rt.runs.length === 0 && rt.watcher !== null).length : 0;
  if (running === 0 && watching === 0 && terminals === 0 && chats === 0 && remote === 0) return null;
  const message: string[] = [];
  const stops: string[] = [];
  if (terminals > 0) {
    message.push(terminals === 1 ? 'A terminal session is still open.' : `${terminals} terminal sessions are still open.`);
    stops.push(terminals === 1 ? 'the session' : 'the sessions');
  }
  if (remote > 0) {
    message.push(remote === 1 ? 'A Remote Control conversation is still open.' : `${remote} Remote Control conversations are still open.`);
    stops.push(remote === 1 ? 'the conversation' : 'the conversations');
  }
  if (chats > 0) {
    message.push(chats === 1 ? 'An agent in a chat is still working.' : `Agents in ${chats} chats are still working.`);
    stops.push(chats === 1 ? 'the chat' : 'the chats');
  }
  if (running > 0) {
    message.push(running === 1 ? 'A task is still running.' : `${running} tasks are still running.`);
    stops.push(running === 1 ? 'its run' : 'their runs');
  }
  if (watching > 0) {
    message.push(watching === 1 ? 'A task is watching for events.' : `${watching} tasks are watching for events.`);
    stops.push(watching === 1 ? 'the watcher until Looper starts again' : 'the watchers until Looper starts again');
  }
  return { message: message.join(' '), detail: `Quitting Looper stops ${stops.join(' and ')}.` };
}

/** Set once a quit was confirmed against active runs, so no quit path asks twice. */
let quitConfirmed = false;
let quitPrompting = false;

/**
 * True = go ahead and quit. With runs in flight (and, when the setting asks,
 * watchers up) the user decides: Quit stops them (the engine ends every
 * session on the way out), Cancel keeps the app running. Every quit path
 * funnels through here — the main window's X, File → Exit, the tray's Quit.
 */
async function confirmQuit(): Promise<boolean> {
  if (!(await settleAllBuilders())) return false;
  if (quitConfirmed) return true;
  const warning = quitWarning();
  if (!warning) return true;
  if (quitPrompting) return false; // a second quit while the dialog is up
  quitPrompting = true;
  try {
    const opts: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Looper',
      message: warning.message,
      detail: warning.detail,
      buttons: ['Quit', 'Cancel'],
      noLink: true,
      defaultId: 1,
      cancelId: 1,
    };
    const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
    const r = await showMessageBox(parent, opts);
    if (r.response === 0) quitConfirmed = true;
    return r.response === 0;
  } finally {
    quitPrompting = false;
  }
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
      const r = await showMessageBox(undefined, {
        type: 'warning',
        title: 'Looper',
        message: 'The computer will not wake on its own.',
        detail: `Windows wake timers are disabled while ${onBattery ? 'on battery' : 'plugged in'} (Power Options → Sleep → Allow wake timers). Rest Mode can put the computer to sleep, but scheduled tasks will not wake it.`,
        buttons: ['Start Anyway', 'Cancel'],
        noLink: true,
        defaultId: 1,
        cancelId: 1,
      });
      if (r.response !== 0) return;
    }
  }
  try {
    engine.armRest();
  } catch (err) {
    await showMessageBox(undefined, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'] });
  }
}

function restMenuItems(): Electron.MenuItemConstructorOptions[] {
  if (engine?.host !== 'windows') return [];
  const armed = engine.restState().armed;
  // A sleeping computer drops Remote Control's sessions: Rest Mode waits until it stops.
  const enabled = armed || !engine.remoteState().running;
  return [{ label: armed ? 'Stop &Rest Mode' : 'Start &Rest Mode', enabled, click: () => void toggleRestMode() }];
}

/** Advanced → Remote Control → Start/Stop: for this run of Looper only. */
async function toggleRemote(): Promise<void> {
  if (!engine) return;
  if (!engine.remoteState().running) {
    engine.startRemote();
    if (engine.settings.remote.helpers.length === 0 && !engine.listProjects().some((p) => p.remote)) {
      await showMessageBox(undefined, {
        type: 'info',
        title: 'Looper',
        message: 'Remote Control is on, but no helper or project keeps a conversation open yet.',
        detail:
          'Add a helper in Advanced → Remote Control → Settings, or check "Keep a Remote Control conversation open" in a project\'s Edit Project window.',
        buttons: ['OK'],
      });
    }
    return;
  }
  const used = engine.usedRemoteConversations();
  if (used > 0) {
    const r = await showMessageBox(undefined, {
      type: 'question',
      title: 'Looper',
      message: used === 1 ? 'A Remote Control conversation is still open.' : `${used} Remote Control conversations are still open.`,
      detail: 'Stopping Remote Control ends every one of its sessions.',
      buttons: ['Stop', 'Cancel'],
      noLink: true,
      defaultId: 1,
      cancelId: 1,
    });
    if (r.response !== 0) return;
  }
  engine.stopRemote();
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
  // A project opens a new chat there: right-click, then the project.
  const projects: Electron.MenuItemConstructorOptions[] = (engine?.listProjects() ?? []).map((p) => ({
    label: menuText(p.name),
    click: () => openProjectChat(p.id),
  }));
  return Menu.buildFromTemplate([
    ...(projects.length ? [...projects, { type: 'separator' } as Electron.MenuItemConstructorOptions] : []),
    { label: 'Show Looper', click: showWindow },
    { label: 'Show Sessions', click: () => openSessionsWindow() },
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

/** Where a click on a task toast lands. */
interface ToastTarget {
  taskId: string;
  runId: string;
  view: 'terminal' | 'runs' | 'run-window' | 'question';
}

/**
 * A toast delivers its click only while its object is alive, and a toast can
 * sit in the Windows notification center long after it popped up, so each one
 * is kept until it is clicked. The oldest are dropped past the cap.
 */
const liveToasts = new Set<Notification>();
const MAX_LIVE_TOASTS = 100;

/** Where recent toasts lead, by task and run: a device's copy of a toast is clicked there, and opens the same. */
const toastTargets = new Map<string, ToastTarget>();
const toastKey = (taskId: string, runId: string | undefined): string => `${taskId}\n${runId ?? '-'}`;

function showTaskNotification(e: Extract<EngineEvent, { type: 'notify' }>): void {
  if (!engine?.settings.notificationsEnabled) return;
  // A run that ended badly opens its run window on the report, and a question
  // opens it where the answer is typed; another finished run lands on the
  // Runs tab with the run selected; a live run on the terminal.
  const hasRun = e.runId !== '-';
  const view: ToastTarget['view'] =
    e.kind === 'question'
      ? 'question'
      : e.problem && hasRun
      ? 'run-window'
      : e.kind === 'end' || e.kind === 'auto-paused' || e.kind === 'usage-limit' || e.kind === 'completed'
        ? 'runs'
        : 'terminal';
  const target: ToastTarget = { taskId: e.taskId, runId: e.runId, view };
  toastTargets.delete(toastKey(e.taskId, e.runId));
  toastTargets.set(toastKey(e.taskId, e.runId), target);
  if (toastTargets.size > MAX_LIVE_TOASTS) toastTargets.delete(toastTargets.keys().next().value!);
  // Every connected device shows it too, whether or not the desktop's toast is skipped below.
  notifyClients({ title: e.title, body: e.body, ...(e.taskId ? { taskId: e.taskId } : {}), ...(e.runId && e.runId !== '-' ? { runId: e.runId } : {}) });
  // The user is already looking at the app: no toast. A question waits only so
  // long, so it is skipped only while its run window, where it's answered, is focused.
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && (e.kind !== 'question' || focused.webContents.getURL().includes(`#${runWindowHash(e.taskId, e.runId)}/`))) return;
  // The paired devices not looking at Looper get the same toast as a push notification.
  void remoteAccess?.pushToast({ title: e.title, body: e.body, ...(e.taskId ? { taskId: e.taskId } : {}), ...(e.runId && e.runId !== '-' ? { runId: e.runId } : {}) });
  if (!Notification.isSupported()) return;
  const toast = new Notification({ title: e.title, body: e.body, icon: appIcon });
  liveToasts.add(toast);
  if (liveToasts.size > MAX_LIVE_TOASTS) liveToasts.delete(liveToasts.values().next().value!);
  toast.on('click', () => {
    liveToasts.delete(toast);
    openToastTarget(target);
  });
  toast.show();
}

/** A device's click on its copy of a toast (it runs as that device, so the windows open there). */
function openNotification(taskId: string, runId?: string): void {
  openToastTarget(toastTargets.get(toastKey(taskId, runId)) ?? { taskId, runId: runId ?? '-', view: runId ? 'runs' : 'terminal' });
}

function openToastTarget(t: ToastTarget): void {
  if (t.view === 'run-window' || t.view === 'question') {
    openMessagesWindow(t.taskId, t.runId, undefined, undefined, t.view === 'run-window');
    return;
  }
  openTaskView(t.taskId, t.runId, t.view);
}

function openTaskView(taskId: string, runId: string, view: 'terminal' | 'runs'): void {
  const payload = { type: 'open-task', taskId, runId, view };
  if (caller()) {
    const main = mainWin();
    if (main) {
      main.focus();
      main.webContents.send('ui:event', payload);
    }
    return;
  }
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

function loadRenderer(target: AppWindow, hash?: string): void {
  if (isRemote(target)) {
    target.load(hash ?? '');
    return;
  }
  if (!(target instanceof BrowserWindow)) return;
  if (process.env.ELECTRON_RENDERER_URL) {
    void target.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : ''));
  } else {
    void target.loadFile(path.join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined);
  }
}

/** macOS: windows that carry their own menu (run, subagent). */
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
function attachWindowMenu(child: AppWindow, template: Electron.MenuItemConstructorOptions[]): Menu {
  // A remote window shows its own menu bar on every host.
  if (process.platform !== 'darwin' || !(child instanceof BrowserWindow)) {
    const menu = Menu.buildFromTemplate(template);
    setWindowMenu(child, menu);
    return menu;
  }
  const menu = Menu.buildFromTemplate(macTemplate(template));
  macWindowMenus.set(child, menu);
  child.on('closed', () => rebuildMenu());
  if (child.isFocused()) Menu.setApplicationMenu(menu);
  return menu;
}

/** Swap a window's own menu for a new one (attachWindowMenu set the first). */
function replaceWindowMenu(child: AppWindow, template: Electron.MenuItemConstructorOptions[]): void {
  if (process.platform !== 'darwin' || !(child instanceof BrowserWindow)) {
    setWindowMenu(child, Menu.buildFromTemplate(template));
    return;
  }
  const menu = Menu.buildFromTemplate(macTemplate(template));
  macWindowMenus.set(child, menu);
  if (child.isFocused()) Menu.setApplicationMenu(menu);
}

/** The desktop's main window; a browser tab's comes with its connection. */
function createWindow(): void {
  win = newWindow(
    {
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: 'Looper',
      icon: appIcon,
      backgroundColor: windowBackground(),
      autoHideMenuBar: false,
      webPreferences: webPreferences(),
    },
    '',
    { desktop: true },
  ) as BrowserWindow;
  win.on('close', (e) => {
    if (!quitting && tray && engine?.settings.closeToTray) {
      e.preventDefault();
      win?.hide();
      return;
    }
    // Closing the main window closes the task builders: each asks about its unsaved changes first.
    if (!quitting && [...builderWindows.keys()].some((id) => !settledBuilders.has(id))) {
      e.preventDefault();
      void settleAllBuilders().then((ok) => {
        if (ok && win && !win.isDestroyed()) win.close();
      });
      return;
    }
    // Closing the main window quits the app: when quitting needs a
    // confirmation, ask before the window is gone — a cancel must leave it standing.
    if (!quitting && !quitConfirmed && quitWarning()) {
      e.preventDefault();
      void confirmQuit().then((ok) => {
        if (ok && win && !win.isDestroyed()) win.close();
      });
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
  modalParent?: AppWindow | null,
  /** contentSize: width/height (and the minimums) size the page, not the frame around it. desktop: on the computer, whoever asks. */
  opts?: { minWidth?: number; minHeight?: number; resizable?: boolean; contentSize?: boolean; desktop?: boolean },
): AppWindow {
  const parent = modalParent && !modalParent.isDestroyed() ? modalParent : undefined;
  const child = newWindow(
    {
      width,
      height,
      useContentSize: opts?.contentSize ?? false,
      minWidth: opts?.minWidth ?? 520,
      minHeight: opts?.minHeight ?? 420,
      title,
      icon: appIcon,
      backgroundColor: windowBackground(),
      maximizable: false,
      resizable: opts?.resizable ?? true,
      webPreferences: webPreferences(),
      ...(parent ? { parent, modal: true, minimizable: false } : {}),
    },
    hash,
    opts?.desktop ? { desktop: true } : undefined,
  );
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
function promptMarkdownExport(parent: AppWindow, defaults: MarkdownExportChoice): Promise<MarkdownExportChoice | null> {
  return new Promise((resolve) => {
    const bit = (b: boolean): string => (b ? '1' : '0');
    const hash = `markdown-export/${bit(defaults.includeThinking)}/${bit(defaults.includeTools)}/${bit(defaults.plain)}`;
    const child = openChildWindow(hash, 'Export Options', 360, 260, parent, { minWidth: 320, minHeight: 220, resizable: false });
    let settled = false;
    const done = (value: MarkdownExportChoice | null): void => {
      if (settled) return;
      settled = true;
      ipc.removeListener('markdown-export:apply', onApply);
      resolve(value);
      if (!child.isDestroyed()) child.close();
    };
    const onApply = (e: Electron.IpcMainEvent, opts: MarkdownExportChoice): void => {
      if (windowOf(e) !== child) return;
      done({ includeThinking: !!opts?.includeThinking, includeTools: !!opts?.includeTools, plain: !!opts?.plain });
    };
    ipc.on('markdown-export:apply', onApply);
    child.on('closed', () => done(null));
  });
}

/**
 * The Run Options window: which steps of the task a manual run should go
 * through, and its guidance (the window saves that as the task's note itself). Its checkboxes say what to run, so the run's skips are their
 * inverse. Resolves whether a run actually started — dismissing the window
 * without applying starts nothing.
 */
function promptRunOptions(taskId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = openChildWindow(`run-options/${encodeURIComponent(taskId)}`, 'Run Options', 420, 400, win, {
      minWidth: 320,
      minHeight: 240,
      resizable: false,
    });
    let settled = false;
    const done = (started: boolean): void => {
      if (settled) return;
      settled = true;
      ipc.removeListener('run-options:apply', onApply);
      resolve(started);
      if (!child.isDestroyed()) child.close();
    };
    const onApply = (e: Electron.IpcMainEvent, opts: { check: boolean; classifier: boolean; agent: boolean }): void => {
      if (windowOf(e) !== child) return;
      let started = false;
      try {
        started =
          engine?.runNow(taskId, { check: !opts?.check, classifier: !opts?.classifier, agent: !opts?.agent }) ?? false;
      } catch (err) {
        // An unknown task must not take the main process down with it.
        engine?.log.error(`run options for ${taskId} failed: ${(err as Error).message}`);
      }
      done(started);
    };
    ipc.on('run-options:apply', onApply);
    child.on('closed', () => done(false));
  });
}

/** Open a file or folder in its default app; on Windows a WSL path crosses via wslpath. */
async function openHostPath(p: string): Promise<void> {
  if (process.platform === 'win32' && p.startsWith('/')) {
    const winPath = await convertWslPath(p, 'windows');
    if (winPath) {
      void openPath(winPath);
      return;
    }
  }
  void openPath(p);
}

/** focusReport: select the run's report row (or its last step) once it loads. */
/** The start of a run window's renderer hash (a subagent's window has its agent id where this has "-"). */
function runWindowHash(taskId: string, runId: string): string {
  return `messages/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}/-`;
}

function openMessagesWindow(taskId: string, runId: string, agentId?: string, label?: string, focusReport = false): void {
  const task = engine?.findSessionTask(taskId);
  const title = agentId
    ? label?.trim()
      ? `Subagent: ${label.trim().slice(0, 80)}`
      : `Subagent ${agentId}`
    : `${engine?.taskName(taskId) ?? taskId} – ${runId}`;
  const hash =
    (agentId ? `messages/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}/${encodeURIComponent(agentId)}` : runWindowHash(taskId, runId)) +
    `/${encodeURIComponent(title)}` +
    (focusReport ? '/report' : '');
  const child = newWindow(
    {
      width: 960,
      height: 640,
      minWidth: 560,
      minHeight: 420,
      title,
      icon: appIcon,
      backgroundColor: windowBackground(),
      maximizable: true,
      webPreferences: webPreferences(),
    },
    hash,
  );
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
  // The export options window remembers the last choice for this window's lifetime.
  let exportOpts = { includeThinking: true, includeTools: true, plain: false };
  const saveMarkdown = async () => {
    if (!engine) return;
    try {
      const result = await engine.readMessages(taskId, runId, agentId, false);
      if (result.status !== 'ok' || result.rows.length === 0) {
        await showMessageBox(child, { type: 'error', title: 'Looper', message: 'There are no messages to save.', buttons: ['OK'] });
        return;
      }
      const picked = await showSaveDialog(child, {
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
      await showMessageBox(child, {
        type: 'error',
        title: 'Looper',
        message: 'Could not save the messages.',
        detail: (err as Error).message,
        buttons: ['OK'],
      });
    }
  };
  // The run's captured terminal output; the raw log while Raw Agent Output is on.
  let rawOutput = false;
  const outputFile = (): string => {
    if (!engine) return '';
    const dir = engine.runDir(taskId, runId);
    const clean = path.join(dir, 'output.txt');
    return !rawOutput && fs.existsSync(clean) ? clean : path.join(dir, 'output.log');
  };
  // Snapshot at window open: a run still in flight keeps the Continue items off.
  const none = { chat: false, terminal: false, guidance: false };
  const canContinue = agentId ? none : (engine?.canContinueRun(taskId, runId) ?? none);
  // A subagent's window shows only its conversation; the run's own items are the run window's.
  const runItems: Electron.MenuItemConstructorOptions[] = agentId
    ? []
    : [
        { label: 'Open &Output File', click: () => void openHostPath(outputFile()) },
        { type: 'separator' },
        {
          label: 'Continue in &Terminal',
          enabled: canContinue.terminal,
          click: () =>
            void openTerminal(taskId, runId).catch(async (err: unknown) => {
              await showMessageBox(child, {
                type: 'error',
                title: 'Looper',
                message: err instanceof Error ? err.message : String(err),
                buttons: ['OK'],
              });
            }),
        },
        {
          label: 'Continue in &Chat',
          enabled: canContinue.chat,
          click: () =>
            void openChat(taskId, runId).catch(async (err: unknown) => {
              await showMessageBox(child, {
                type: 'error',
                title: 'Looper',
                message: err instanceof Error ? err.message : String(err),
                buttons: ['OK'],
              });
            }),
        },
        {
          label: 'Continue with &Guidance…',
          enabled: canContinue.guidance,
          click: () => openContinueRunWindow(taskId, runId),
        },
        { type: 'separator' },
      ];
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: '&Save as Markdown…', accelerator: 'CmdOrCtrl+S', click: () => void saveMarkdown() },
        { type: 'separator' },
        ...runItems,
        {
          label: 'Open &Run Folder',
          click: () => {
            if (engine) void openHostPath(engine.runDir(taskId, runId));
          },
        },
        {
          label: 'Copy Run Folder &Path',
          click: () => {
            if (engine) writeClipboard(engine.runDir(taskId, runId));
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
        ...(agentId
          ? []
          : [
              {
                label: 'Raw Agent &Output',
                type: 'checkbox' as const,
                checked: false,
                click: (item: Electron.MenuItem) => {
                  rawOutput = item.checked;
                  send({ type: 'messages-raw-output', checked: item.checked });
                },
              },
            ]),
        {
          label: '&Auto Scroll',
          type: 'checkbox',
          checked: false,
          click: (item) => send({ type: 'messages-auto-scroll', checked: item.checked }),
        },
        { type: 'separator' },
        ...(agentId ? [] : [showItem('show-run', 'Show Run &Log', 'run')]),
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
    if (windowOf(e) !== child) return;
    filterValue = String(filter ?? '');
    const item = menu.getMenuItemById('filter');
    if (item) item.checked = filterValue.trim() !== '';
    if (isRemote(child)) child.refreshMenu();
  };
  ipc.on('messages:filter-state', onFilterState);
  child.on('closed', () => ipc.removeListener('messages:filter-state', onFilterState));
  child.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRenderer(child, hash);
}

function openImageWindow(taskId: string, runId: string, rowId: string, agentId?: string, label?: string): void {
  const name = label?.trim() ? label.trim().slice(0, 80) : `${runId} row ${rowId}`;
  const hash =
    `image/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}/${agentId ? encodeURIComponent(agentId) : '-'}` +
    `/${encodeURIComponent(rowId)}/${encodeURIComponent(`Image – ${name}`)}`;
  const child = newWindow(
    {
      width: 900,
      height: 700,
      minWidth: 420,
      minHeight: 320,
      title: `Image – ${name}`,
      icon: appIcon,
      backgroundColor: windowBackground(),
      maximizable: true,
      webPreferences: webPreferences(),
    },
    hash,
  );
  child.removeMenu();
  child.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRenderer(child, hash);
}

export function openEditorWindow(taskId?: string): void {
  openChildWindow(
    taskId ? `editor/${encodeURIComponent(taskId)}` : 'editor',
    taskId ? 'Edit Task' : 'New Task',
    780,
    800,
  );
}


function openNoteEditorWindow(taskId: string): void {
  openChildWindow(
    `note-editor/${encodeURIComponent(taskId)}`,
    'Guidance for Next Run',
    520,
    400,
    undefined,
    { minWidth: 460, minHeight: 340 },
  );
}

function openContinueRunWindow(taskId: string, runId: string): void {
  openChildWindow(
    `continue-run/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}`,
    'Continue Run',
    520,
    GUIDANCE_WINDOW_HEIGHT,
    undefined,
    { minWidth: 460, minHeight: GUIDANCE_WINDOW_HEIGHT, contentSize: true },
  );
}

/**
 * Page height of the run guidance windows: the Guidance field (10 rows) and
 * the button bar with nothing to spare. A taller window grows the text box.
 */
const GUIDANCE_WINDOW_HEIGHT = 273;

function openSendGuidanceWindow(taskId: string, runId: string): void {
  openChildWindow(
    `send-guidance/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}`,
    'Send Guidance',
    520,
    GUIDANCE_WINDOW_HEIGHT,
    undefined,
    { minWidth: 460, minHeight: GUIDANCE_WINDOW_HEIGHT, contentSize: true },
  );
}

function openFolderNoteEditorWindow(folderId: string): void {
  openChildWindow(
    `note-editor-folder/${encodeURIComponent(folderId)}`,
    'Guidance for Next Runs',
    520,
    400,
    undefined,
    { minWidth: 460, minHeight: 340 },
  );
}

function openMoveToFolderWindow(taskId: string): void {
  openChildWindow(`move-to-folder/${encodeURIComponent(taskId)}`, 'Move to Folder', 460, 440, win);
}

function openNewFolderWindow(parentId?: string): void {
  const hash = parentId ? `folder-new/${encodeURIComponent(parentId)}` : 'folder-new';
  openChildWindow(hash, 'New Folder', 420, 300, win, {
    minWidth: 420,
    minHeight: 300,
    resizable: false,
  });
}

function openRenameFolderWindow(folderId: string): void {
  openChildWindow(`folder-rename/${encodeURIComponent(folderId)}`, 'Rename Folder', 420, 240, win, {
    minWidth: 420,
    minHeight: 240,
    resizable: false,
  });
}

function openSettingsWindow(): void {
  // Sized by its page: the General tab, the tallest, fits without a scroll bar.
  openChildWindow('settings', 'Settings', 720, 640, win, { contentSize: true });
}

function openTemplatesWindow(): void {
  openChildWindow('templates', 'Templates', 560, 520);
}

/** The caller's main window: a browser tab's own, or the desktop's. */
function mainWin(): AppWindow | null {
  return callerMainWindow(win);
}

const recycleBinWindows = new WindowSlots();

/** One Recycle Bin window (per client): opening it again brings the open one forward. */
function openRecycleBinWindow(): void {
  const open = recycleBinWindows.get();
  if (open) {
    open.focus();
    return;
  }
  recycleBinWindows.set(openChildWindow('recycle-bin', 'Recycle Bin', 560, 520));
}

const addonsWindows = new WindowSlots();

/** One Addons window (per client): opening it again brings the open one forward. */
function openAddonsWindow(): void {
  const open = addonsWindows.get();
  if (open) {
    open.focus();
    return;
  }
  addonsWindows.set(openChildWindow('addons', 'Addons', 560, 560));
}

function addonDeps(): AddonUiDeps {
  return {
    host: addons!,
    hostKind: engine!.host,
    mainWindow: mainWin,
    openWindow: openChildWindow,
    view: () => engine?.settings.view ?? ViewSchema.parse({}),
    updateView,
  };
}

function openInstructionsWindow(): void {
  openChildWindow('instructions', 'Instructions', 800, 700);
}

function openEngineLogWindow(): void {
  const child = newWindow(
    {
      width: 1000,
      height: 640,
      minWidth: 640,
      minHeight: 420,
      title: 'Engine Log',
      icon: appIcon,
      backgroundColor: windowBackground(),
      maximizable: true,
      webPreferences: webPreferences(),
    },
    'engine-log',
  );
  // View: which sources (Looper itself, each addon) and levels the window lists.
  const hiddenSources = new Set<string>();
  const hiddenLevels = new Set<EngineLogLevel>();
  const send = () => {
    if (child.isDestroyed()) return;
    child.webContents.send('ui:event', { type: 'engine-log-view', hiddenSources: [...hiddenSources], hiddenLevels: [...hiddenLevels] });
  };
  const toggle =
    <T,>(set: Set<T>, key: T) =>
    (item: Electron.MenuItem) => {
      if (item.checked) set.delete(key);
      else set.add(key);
      send();
    };
  const check = <T,>(label: string, set: Set<T>, key: T): Electron.MenuItemConstructorOptions => ({
    label,
    type: 'checkbox',
    checked: true,
    click: toggle(set, key),
  });
  child.setMenu(
    Menu.buildFromTemplate([
      {
        label: '&View',
        submenu: [
          check('&Looper', hiddenSources, ENGINE_LOG_LOOPER),
          ...(addons?.list() ?? []).map((a) => check(menuText(a.name), hiddenSources, engineLogAddonSource(a.id))),
          { type: 'separator' },
          check('&Debug', hiddenLevels, 'debug'),
          check('&Info', hiddenLevels, 'info'),
          check('&Warn', hiddenLevels, 'warn'),
          check('&Error', hiddenLevels, 'error'),
        ],
      },
    ]),
  );
  child.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRenderer(child, 'engine-log');
}

function openAboutWindow(): void {
  openChildWindow('about', 'About', 360, 320, win, { minWidth: 360, minHeight: 320, resizable: false });
}

function openEnvEditorWindow(envId: string, isNew?: boolean, parent?: AppWindow | null): void {
  openChildWindow(
    `env-editor/${encodeURIComponent(envId)}${isNew ? '/new' : ''}`,
    isNew ? 'New Environment' : 'Edit Environment',
    700,
    560,
    parent,
  );
}

function openHarnessEditorWindow(
  envId: string,
  harnessId: string,
  isNew?: boolean,
  parent?: AppWindow | null,
): void {
  openChildWindow(
    `harness-editor/${encodeURIComponent(envId)}/${encodeURIComponent(harnessId)}${isNew ? '/new' : ''}`,
    isNew ? 'New Harness' : 'Edit Harness',
    640,
    620,
    parent,
  );
}

function openModelEditorWindow(
  envId: string,
  harnessId: string,
  index?: number,
  parent?: AppWindow | null,
): void {
  openChildWindow(
    `model-editor/${encodeURIComponent(envId)}/${encodeURIComponent(harnessId)}/${index === undefined ? 'new' : index}`,
    index === undefined ? 'New Model' : 'Edit Model',
    // Page size: all four fields of a claude-code/codex model, without a scroll bar.
    406,
    382,
    parent,
    { minWidth: 406, minHeight: 382, resizable: false, contentSize: true },
  );
}

function openModelUpdateWindow(envId?: string, harnessId?: string, parent?: AppWindow | null): void {
  const hash =
    envId && harnessId
      ? `model-update/${encodeURIComponent(envId)}/${encodeURIComponent(harnessId)}`
      : 'model-update';
  openChildWindow(hash, 'Update Models', 560, 560, parent ?? win);
}

function openTemplateEditorWindow(templateId?: string, _parent?: AppWindow | null): void {
  openChildWindow(
    templateId ? `template-editor/${encodeURIComponent(templateId)}` : 'template-editor',
    templateId ? 'Edit Template' : 'New Template',
    780,
    800,
  );
}

function openTemplatePickerWindow(): void {
  openChildWindow('template-picker', 'New Task from Template', 480, 420, win);
}

function openEditorFromTemplateWindow(templateId: string): void {
  const child = openChildWindow(
    `editor-from-template/${encodeURIComponent(templateId)}`,
    'New Task',
    780,
    800,
  );
  // The picker is modal to main; closing it auto-focuses main.
  // Intercept that focus event and redirect to the editor.
  const main = mainWin();
  if (main && !main.isDestroyed()) {
    const redirect = () => { if (!child.isDestroyed()) child.focus(); };
    main.once('focus', redirect);
    child.once('closed', () => main.removeListener('focus', redirect));
  }
}

// ---------- version history ----------

const versionWindows = new WindowSlots();

/** One Version History window per task (and client): opening it again brings the open one forward. */
function openVersionsWindow(taskId: string): void {
  const open = versionWindows.get(taskId);
  if (open) {
    open.focus();
    return;
  }
  versionWindows.set(openChildWindow(`versions/${encodeURIComponent(taskId)}`, 'Version History', 640, 480), taskId);
}

function openVersionDetailWindow(taskId: string, n: number, compare: boolean, _parent: AppWindow | null): void {
  openChildWindow(
    `version/${encodeURIComponent(taskId)}/${n}/${compare ? 'compare' : 'view'}`,
    compare ? `Compare Version ${n} with Current` : `Version ${n}`,
    900,
    680,
  );
}

// ---------- terminal sessions ----------

/** Open Remote Control conversation windows by session id (one per client). */
const terminalWindows = new WindowSlots();

/**
 * Open Project in Terminal, or Continue in Terminal with a run id: in the
 * Sessions window, or the system's default terminal when the setting says so.
 * A Remote Control conversation holding the run's conversation shows in its own window.
 */
async function openTerminal(taskId: string, runId?: string): Promise<void> {
  if (!engine) return;
  if (engine.settings.terminal === 'system') {
    await engine.openTaskTerminal(taskId, runId);
    return;
  }
  const sessionId = engine.startTerminalSession(taskId, runId);
  if (engine.isRemoteSession(sessionId)) openTerminalWindow(sessionId, `${engine.taskName(taskId) ?? taskId} – Remote Control`);
  else openSessionsWindow(sessionId);
}

/**
 * A Remote Control conversation's terminal window, or the open one brought
 * forward. The conversation keeps running when it closes.
 */
function openTerminalWindow(sessionId: string, title: string): void {
  const open = terminalWindows.get(sessionId);
  if (open) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return;
  }
  const hash = `terminal/${encodeURIComponent(sessionId)}/${encodeURIComponent(title)}`;
  const child = openChildWindow(hash, title, 960, 600, undefined, {
    minWidth: 480,
    minHeight: 300,
    contentSize: true,
  });
  child.setMaximizable(true);
  terminalWindows.set(child, sessionId);
}

// ---------- Remote Control ----------

/** An open conversation in a Looper terminal window (it keeps running when the window closes), an ended one in its run window. */
async function openRemoteConversation(id: string): Promise<void> {
  if (!engine) return;
  const conv = engine.remoteState().conversations.find((c) => c.id === id);
  if (!conv) return;
  if (conv.status === 'ended') openMessagesWindow(conv.taskId, conv.id);
  else openTerminalWindow(conv.id, `${conv.title ?? conv.name} – Remote Control`);
}

/** Advanced → Remote Control → Settings: modal, like the other settings windows. */
function openRemoteSettingsWindow(): void {
  openChildWindow('remote-settings', 'Remote Control', 640, 360, win, { contentSize: true });
}

// Page sizes: every field shows without a scroll bar.
function openRemoteHelperEditor(id: string, isNew: boolean, parent: AppWindow | null): void {
  openChildWindow(`remote-helper/${encodeURIComponent(id)}${isNew ? '/new' : ''}`, isNew ? 'New Helper' : 'Edit Helper', 560, 700, parent, {
    contentSize: true,
  });
}

// ---------- Remote Access ----------

function applyRemoteAccess(): void {
  if (!engine || !remoteAccess) return;
  remoteAccess.apply(engine.settings.remoteAccess).catch((err: unknown) => engine?.log.error(`remote access: ${String(err)}`));
}

/** Advanced → Remote Access → Turn On / Turn Off. */
function toggleRemoteAccess(): void {
  if (!engine) return;
  const ra = engine.settings.remoteAccess;
  engine.updateSettings({ remoteAccess: { ...ra, enabled: !ra.enabled } });
}

function openRemoteAccessSettingsWindow(): void {
  openChildWindow('remote-access-settings', 'Remote Access', 560, 600, win, { contentSize: true });
}

const remoteAccessPairWindows = new WindowSlots();

/** One Pair Device window per client; closing the last one cancels the code (there's one code for all). */
function openRemoteAccessPairWindow(parent: AppWindow | null = mainWin()): void {
  const open = remoteAccessPairWindows.get();
  if (open) {
    open.focus();
    return;
  }
  const child = openChildWindow('remote-access-pair', 'Pair Device', 420, 520, parent, {
    minWidth: 420,
    minHeight: 520,
    resizable: false,
    contentSize: true,
  });
  remoteAccessPairWindows.set(child);
  child.on('closed', () => {
    if (remoteAccessPairWindows.all().length === 0) remoteAccess?.cancelPairing();
  });
}

function openRemoteAccessRenameWindow(deviceId: string, parent: AppWindow | null): void {
  openChildWindow(`remote-access-rename/${encodeURIComponent(deviceId)}`, 'Rename Device', 420, 240, parent, {
    minWidth: 420,
    minHeight: 240,
    resizable: false,
  });
}

// ---------- projects ----------

/** Open Edit Project windows by project id ('' = New Project): opening one again brings it forward. */
const projectWindows = new WindowSlots();

/** The Edit Project window, modeless like the task editor (no id = New Project). */
function openProjectEditor(id?: string): void {
  const key = id ?? '';
  const open = projectWindows.get(key);
  if (open) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return;
  }
  const child = openChildWindow(id ? `project/${encodeURIComponent(id)}` : 'project-new', id ? 'Edit Project' : 'New Project', 560, 545, undefined, {
    contentSize: true,
  });
  projectWindows.set(child, key);
}

/** File → New Task with a project picked (a project's New Task…). */
function openNewTaskIn(projectId: string): void {
  openChildWindow(`editor-in/${encodeURIComponent(projectId)}`, 'New Task', 780, 800);
}

/** A new chat in a project, from the tray: Looper's main window stays as it is. */
function openProjectChat(projectId: string): void {
  void openChat(projectTaskId(projectId)).catch((err: unknown) => {
    void showMessageBox(undefined, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'] });
  });
}

const remoteConversationsWindows = new WindowSlots();

/** One Conversations window per client, modeless: opening it again brings the open one forward. */
function openRemoteConversationsWindow(): void {
  const open = remoteConversationsWindows.get();
  if (open) {
    open.focus();
    return;
  }
  const child = openChildWindow('remote-conversations', 'Remote Control Conversations', 820, 600);
  child.setMaximizable(true);
  remoteConversationsWindows.set(child);
}

// ---------- task chats ----------

/**
 * Open Project in Chat, or Continue in Chat with a run id: the task's harness
 * in a chat in the Sessions window. A chat already open on the run's
 * conversation is shown instead.
 */
async function openChat(taskId: string, runId?: string): Promise<void> {
  if (!engine) return;
  openSessionsWindow(engine.startChat(taskId, runId).id);
}

/** Fork from Here: a new chat with the conversation up to the message. */
function forkChat(chatId: string, index: number): void {
  if (engine) openSessionsWindow(engine.forkChat(chatId, index).id);
}

/** Menu labels show `&` as a mnemonic marker: a literal one is doubled. */
const menuText = (s: string): string => s.replace(/&/g, '&&');

/** A radio list for a Chat submenu; a current value the list doesn't offer shows too, checked. */
function radioItems(
  options: [string, string][],
  current: string,
  enabled: (value: string) => boolean,
  pick: (value: string) => void,
): Electron.MenuItemConstructorOptions[] {
  const all = options.some(([v]) => v === current) ? options : [...options, [current, current] as [string, string]];
  return all.map(([value, label]) => ({
    label: menuText(label),
    type: 'radio',
    checked: value === current,
    enabled: enabled(value),
    click: () => pick(value),
  }));
}

/**
 * The chat window's Chat menu: Stop, and the chat's own model, effort and
 * permission mode. Claude replaces its process for a new model, effort or
 * Bypass, which would cut a turn short, so those wait for the turn to end.
 */
function chatSettingItems(
  s: ChatState,
  configure: (patch: Partial<ChatSettings>) => void,
): Record<'model' | 'effort' | 'permission', Electron.MenuItemConstructorOptions[]> {
  const ended = s.status === 'ended';
  const claude = s.harnessKind === 'claude-code';
  const busy = s.status === 'working' || s.status === 'starting' || s.permissions.length > 0;
  const canReplace = !ended && !(claude && busy);
  const entry = s.models.find((m) => m.id === s.settings.model);
  const levels = EFFORT_LEVELS[s.harnessKind];
  const offered = entry?.efforts ? levels.filter(([v]) => entry.efforts!.includes(v)) : levels;
  const defaultEffort = entry?.defaultEffort ? levels.find(([v]) => v === entry.defaultEffort)?.[1] ?? entry.defaultEffort : undefined;
  const bypassLive = s.settings.permissionMode === 'bypassPermissions';
  return {
    model: radioItems(
      [['', 'Default'], ...s.models.map((m): [string, string] => [m.id, m.name])],
      s.settings.model ?? '',
      () => canReplace,
      (v) => configure({ model: v || undefined }),
    ),
    effort: radioItems(
      [['', defaultEffort ? `Default (${defaultEffort})` : 'Default'], ...offered],
      s.settings.effort ?? '',
      () => canReplace,
      (v) => configure({ effort: v || undefined }),
    ),
    permission: radioItems(
      PERMISSION_MODES[s.harnessKind],
      s.settings.permissionMode,
      (v) => !ended && (v !== 'bypassPermissions' || bypassLive || canReplace),
      (v) => configure({ permissionMode: v }),
    ),
  };
}

function chatMenu(
  s: ChatState,
  stop: () => void,
  sendNow: () => void,
  configure: (patch: Partial<ChatSettings>) => void,
): Electron.MenuItemConstructorOptions {
  const items = chatSettingItems(s, configure);
  return {
    label: '&Chat',
    submenu: [
      // Esc, as in Claude Code's own terminal: it ends the agent's turn. The window handles
      // the key itself, so Esc in the find bar closes that instead.
      { label: '&Stop', accelerator: 'Esc', registerAccelerator: false, enabled: s.status === 'working', click: stop },
      // The queued messages go now: the agent's turn ends first.
      { label: 'Send &Now', accelerator: 'CmdOrCtrl+Enter', enabled: s.queued.length > 0, click: sendNow },
      { type: 'separator' },
      { label: '&Model', submenu: items.model },
      { label: '&Effort', submenu: items.effort },
      { label: '&Permission Mode', submenu: items.permission },
    ],
  };
}

/** The message box's Model, Effort or Permission Mode menu: the Chat menu's list, which then rebuilds the menu bar. */
function chatSettingMenu(chatId: string, which: 'model' | 'effort' | 'permission'): Electron.MenuItemConstructorOptions[] {
  const chat = engine?.getChat(chatId);
  if (!chat) return [];
  const parent = sessionsWindows.get();
  const showError = (err: unknown) => {
    const opts = { type: 'error' as const, title: 'Looper', message: (err as Error).message, buttons: ['OK'] };
    void showMessageBox(parent, opts);
  };
  return chatSettingItems(chat, (patch) => void engine?.configureChat(chatId, patch).catch(showError).finally(() => refreshSessionsMenus(true)))[which];
}

// ---------- the Sessions window ----------

/** A Sessions window and the session it shows (null: the Overview): that session's chat and terminal output go there. */
interface SessionsView {
  w: AppWindow;
  shown: string | null;
  /** What its menu was last built from. */
  menuKey: string;
}

/** One Sessions window per client. */
const sessionsWindows = new WindowSlots();
const sessionsViews = new Map<AppWindow, SessionsView>();

/** Every Sessions window showing the session (a desktop and a phone can watch the same chat). */
function sessionWindowsShowing(id: string): AppWindow[] {
  return [...sessionsViews.values()].filter((v) => v.shown === id && !v.w.isDestroyed()).map((v) => v.w);
}

/**
 * The Sessions window, opened or brought forward, showing the session
 * `select` when given. Closing it leaves every session running: only Close
 * Conversation, Close All Conversations and quitting Looper end them.
 */
function openSessionsWindow(select?: string): void {
  const open = sessionsWindows.get();
  if (open) {
    if (open.isMinimized()) open.restore();
    open.show();
    open.focus();
    if (select) open.webContents.send('ui:event', { type: 'sessions-select', id: select });
    return;
  }
  const child = openChildWindow(select ? `sessions/${encodeURIComponent(select)}` : 'sessions', 'Sessions', 1388, 895, undefined, {
    minWidth: 900,
    minHeight: 500,
    contentSize: true,
  });
  child.setMaximizable(true);
  const view: SessionsView = { w: child, shown: select ?? null, menuKey: '' };
  sessionsWindows.set(child);
  sessionsViews.set(child, view);
  attachWindowMenu(child, sessionsTemplate(view));
  view.menuKey = sessionsMenuState(view);
  const unsubscribe = engine!.on((e) => {
    if ((e.type === 'chat' && e.state.id === view.shown) || e.type === 'sessions' || e.type === 'projects' || e.type === 'settings') {
      refreshSessionsMenu(view);
    }
  });
  child.on('closed', () => {
    unsubscribe();
    sessionsViews.delete(child);
    watchShownSessions();
  });
}

/** The engine follows closely every session a Sessions window shows, on any device. */
function watchShownSessions(): void {
  engine?.watchSessions([...sessionsViews.values()].flatMap((v) => (v.shown === null ? [] : [v.shown])));
}

/** That Sessions window now shows `id` (null: the Overview): its chat and terminal output go there. */
function showSession(w: AppWindow | null, id: string | null): void {
  const target = w && sessionsViews.has(w) ? w : sessionsWindows.get();
  const view = target ? sessionsViews.get(target) : undefined;
  if (view) view.shown = id;
  watchShownSessions();
  if (view) refreshSessionsMenu(view, true);
}

/** What a Sessions window's menu depends on: rebuilt when it changes. */
function sessionsMenuState(view: SessionsView): string {
  const id = view.shown;
  const chat = id ? engine?.getChat(id) : undefined;
  return JSON.stringify([
    id,
    id ? engine?.sessionKind(id) : null,
    chat ? [chat.settings, chat.status, chat.permissions.length > 0, chat.models, chat.queued.length > 0] : null,
    engine?.listProjects().map((p) => p.name),
    engine?.sessionsState().sessions.length ?? 0,
    engine?.settings.view.sessions,
  ]);
}

function refreshSessionsMenu(view: SessionsView, force = false): void {
  if (view.w.isDestroyed()) return;
  const key = sessionsMenuState(view);
  if (key === view.menuKey && !force) return;
  view.menuKey = key;
  replaceWindowMenu(view.w, sessionsTemplate(view));
}

function refreshSessionsMenus(force = false): void {
  for (const view of [...sessionsViews.values()]) refreshSessionsMenu(view, force);
}

/** A session's name for a question about it. */
function sessionTitle(id: string): string {
  return engine?.sessionsState().sessions.find((s) => s.id === id)?.title ?? 'The conversation';
}

/** Whether ending the session would cut the agent short: it's working, or waiting for a permission answer. */
function sessionBusy(id: string): boolean {
  const s = engine?.sessionsState().sessions.find((x) => x.id === id);
  return !!s && (s.status === 'working' || s.waiting?.reason === 'permission');
}

/** Close Conversation (the toolbar, the menus, Ctrl+W, Ctrl+F4): the session ends once the user confirms. */
async function closeSessionAsk(id: string): Promise<void> {
  if (!engine || !engine.sessionKind(id)) return;
  const parent = sessionsWindows.get();
  const busy = sessionBusy(id);
  const opts = {
    type: 'question' as const,
    title: 'Sessions',
    message: `Close "${sessionTitle(id)}"?`,
    detail: busy ? 'It’s still working, and closing stops it.' : 'It ends, and stays in its project’s or task’s run history.',
    // Not "Close": Windows turns that label into its own Close button and puts it after Cancel.
    buttons: ['Close Conversation', 'Cancel'],
    noLink: true,
    // Enter closes an idle conversation; one that's working takes a deliberate click.
    defaultId: busy ? 1 : 0,
    cancelId: 1,
  };
  const { response } = await showMessageBox(parent, opts);
  if (response === 0) await engine.closeSession(id);
}

/** Close All Conversations: every session ends, after asking. */
async function closeAllSessionsAsk(): Promise<void> {
  if (!engine) return;
  const sessions = engine.sessionsState().sessions;
  if (sessions.length === 0) return;
  const working = sessions.filter((s) => sessionBusy(s.id)).length;
  const parent = sessionsWindows.get();
  const opts = {
    type: 'question' as const,
    title: 'Sessions',
    message: sessions.length === 1 ? 'Close the conversation?' : `Close all ${sessions.length} conversations?`,
    detail:
      working === 0
        ? 'Each one ends, and stays in its project’s or task’s run history.'
        : working === 1
          ? 'One of them is still working, and closing stops it.'
          : `${working} of them are still working, and closing stops them.`,
    buttons: ['Close All', 'Cancel'],
    noLink: true,
    defaultId: 1,
    cancelId: 1,
  };
  const { response } = await showMessageBox(parent, opts);
  if (response === 0) await engine.closeAllSessions();
}

/** The Sessions window's menus: File, Edit, View, and Chat while a chat is shown. */
function sessionsTemplate(sv: SessionsView): Electron.MenuItemConstructorOptions[] {
  const child = sv.w;
  const id = sv.shown;
  const kind = id ? engine?.sessionKind(id) : undefined;
  const chat = kind === 'chat' && id ? engine?.getChat(id) : undefined;
  const send = (payload: unknown) => {
    if (!child.isDestroyed()) child.webContents.send('ui:event', payload);
  };
  const showError = (err: unknown) =>
    void showMessageBox(child, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'] });
  const projects = engine?.listProjects() ?? [];
  const anySessions = (engine?.sessionsState().sessions.length ?? 0) > 0;
  const shownProjectId = id ? engine?.sessionsState().sessions.find((s) => s.id === id)?.projectId : undefined;
  const shownProject = shownProjectId ? projects.find((p) => p.id === shownProjectId) : undefined;
  const attachFiles = async () => {
    if (!id) return;
    const r = await showOpenDialog(child, { title: 'Attach Files', properties: ['openFile', 'multiSelections'] });
    if (r.canceled || r.filePaths.length === 0 || !engine) return;
    const added = engine.attachToChat(id, r.filePaths.map((p) => ({ name: path.basename(p), path: p })));
    send({ type: 'chat-attached', attachments: added });
  };
  const saveMarkdown = async () => {
    const c = id ? engine?.getChat(id) : undefined;
    if (!c) return;
    const rows = [...c.history, ...c.rows];
    if (rows.length === 0) {
      await showMessageBox(child, { type: 'error', title: 'Looper', message: 'There are no messages to save.', buttons: ['OK'] });
      return;
    }
    const title = sessionTitle(c.id);
    const picked = await showSaveDialog(child, {
      title: 'Save as Markdown',
      defaultPath: `${title.replace(/[\\/:*?"<>|]/g, '-')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (picked.canceled || !picked.filePath) return;
    const chosen = await promptMarkdownExport(child, sessionsExportOpts);
    if (!chosen) return;
    sessionsExportOpts = chosen;
    fs.writeFileSync(picked.filePath, messagesToMarkdown(rows, { title, ...chosen }), 'utf8');
  };
  const openWorkingDirectory = () => {
    const taskId = id ? engine?.sessionsState().sessions.find((s) => s.id === id)?.taskId : undefined;
    const cwd = taskId ? engine?.findSessionTask(taskId)?.cwd : undefined;
    if (cwd) void openHostPath(cwd);
  };
  const perProject = (open: (projectId: string) => void): Electron.MenuItemConstructorOptions[] =>
    projects.map((p) => ({ label: menuText(p.name), click: () => open(p.id) }));
  const file: Electron.MenuItemConstructorOptions = {
    label: '&File',
    submenu: [
      // The page handles Ctrl+T, Ctrl+W and Ctrl+F4, so in a terminal session Ctrl+T and Ctrl+W stay the agent's.
      {
        label: shownProject ? `New Chat in ${menuText(shownProject.name)}` : 'New Chat in Project',
        accelerator: 'CmdOrCtrl+T',
        registerAccelerator: false,
        enabled: !!shownProject,
        click: () => shownProject && openProjectChat(shownProject.id),
      },
      { label: 'New &Chat', enabled: projects.length > 0, submenu: perProject(openProjectChat) },
      {
        label: 'New &Terminal',
        enabled: projects.length > 0,
        submenu: perProject((pid) => void openTerminal(projectTaskId(pid)).catch(showError)),
      },
      { type: 'separator' },
      // Chat-only: in a terminal these keys belong to the agent.
      { label: '&Attach Files…', accelerator: 'CmdOrCtrl+O', enabled: !!chat && chat.status !== 'ended', click: () => void attachFiles().catch(showError) },
      { label: '&Save as Markdown…', accelerator: 'CmdOrCtrl+S', enabled: !!chat, click: () => void saveMarkdown().catch(showError) },
      { type: 'separator' },
      { label: 'Open &Working Directory', enabled: !!kind, click: openWorkingDirectory },
      { label: 'Send to Sess&ions…', enabled: anySessions, click: openSendToSessionsWindow },
      { type: 'separator' },
      {
        label: 'Close C&onversation',
        accelerator: 'CmdOrCtrl+W',
        registerAccelerator: false,
        enabled: !!kind,
        click: () => id && void closeSessionAsk(id).catch(showError),
      },
      { label: 'Close A&ll Conversations', enabled: anySessions, click: () => void closeAllSessionsAsk().catch(showError) },
      { type: 'separator' },
      { label: 'Close &Window', accelerator: 'Alt+F4', registerAccelerator: false, click: () => child.close() },
    ],
  };
  // The page handles these keys itself, so a terminal still gets Ctrl+C and the rest.
  const edit: Electron.MenuItemConstructorOptions = {
    label: '&Edit',
    submenu: [
      { role: 'undo', label: '&Undo', registerAccelerator: false },
      { role: 'redo', label: '&Redo', registerAccelerator: false },
      { type: 'separator' },
      { role: 'cut', label: 'Cu&t', registerAccelerator: false },
      { role: 'copy', label: '&Copy', registerAccelerator: false },
      { role: 'paste', label: '&Paste', registerAccelerator: false },
      { role: 'selectAll', label: 'Select &All', registerAccelerator: false },
      { type: 'separator' },
      { label: '&Find…', accelerator: 'CmdOrCtrl+F', enabled: !!chat, click: () => send({ type: 'chat-find' }) },
    ],
  };
  const nav = (dir: 1 | -1, waiting: boolean) => () => send({ type: 'sessions-nav', dir, waiting });
  const shown = engine?.settings.view.sessions ?? ViewSchema.parse({}).sessions;
  const setShown = (patch: Partial<Settings['view']['sessions']>) => updateView({ sessions: { ...shown, ...patch } });
  const view: Electron.MenuItemConstructorOptions = {
    label: '&View',
    submenu: [
      { label: '&Dashboard', click: () => send({ type: 'sessions-dashboard' }) },
      { type: 'separator' },
      { label: '&Toolbar', type: 'checkbox', checked: shown.toolbar, click: (item) => setShown({ toolbar: item.checked }) },
      { label: 'A&ctivity Pane', type: 'checkbox', checked: shown.activityPane, click: (item) => setShown({ activityPane: item.checked }) },
      { label: 'Status &Bar', type: 'checkbox', checked: shown.statusBar, click: (item) => setShown({ statusBar: item.checked }) },
      { type: 'separator' },
      { label: 'Previous &Waiting Session', accelerator: 'F8', click: nav(-1, true) },
      { label: 'Next W&aiting Session', accelerator: 'F9', click: nav(1, true) },
      { label: '&Previous Session', accelerator: 'Shift+F8', click: nav(-1, false) },
      { label: '&Next Session', accelerator: 'Shift+F9', click: nav(1, false) },
      { type: 'separator' },
      // The page handles F6 too, so a terminal never gets it.
      { label: 'Next Pan&e', accelerator: 'F6', registerAccelerator: false, click: () => send({ type: 'sessions-pane', dir: 1 }) },
      { label: 'Previous Pane', accelerator: 'Shift+F6', registerAccelerator: false, click: () => send({ type: 'sessions-pane', dir: -1 }) },
    ],
  };
  const menus = process.platform === 'darwin' ? [file, view] : [file, edit, view];
  if (chat && id) {
    menus.push(
      chatMenu(
        chat,
        () => void engine?.stopChat(id).catch(showError),
        () => void engine?.sendNowChat(id).catch(showError),
        // The menu shows the chat's settings as they are once the change is through (or refused).
        (patch) => void engine?.configureChat(id, patch).catch(showError).finally(() => refreshSessionsMenu(sv, true)),
      ),
    );
  }
  return menus;
}

/** The export options Save as Markdown last used in the Sessions window. */
let sessionsExportOpts = { includeThinking: true, includeTools: true, plain: false };

const sendToSessionsWindows = new WindowSlots();

/** Send to Sessions: one message to the sessions picked there. Modeless, one per client; opening it again brings it forward. */
function openSendToSessionsWindow(): void {
  const open = sendToSessionsWindows.get();
  if (open) {
    open.focus();
    return;
  }
  sendToSessionsWindows.set(openChildWindow('send-to-sessions', 'Send to Sessions', 620, 560, undefined, { contentSize: true, minWidth: 480, minHeight: 420 }));
}

// ---------- task builder ----------

/**
 * Open builder windows by builder id: one per client at most (the desktop
 * and a phone can both show a builder). Closing the last one ends its session.
 */
const builderWindows = new Map<string, AppWindow[]>();

const BUILDER_SIZE = { width: 1180, height: 760 };

function openBuilderSetupWindow(): void {
  openChildWindow('builder-setup', 'New Task with Agent', 480, 372, undefined, {
    minWidth: 420,
    minHeight: 372,
    contentSize: true,
  });
}

/** Builders whose unsaved changes were answered (saved or put back): their window closes without asking again. */
const settledBuilders = new Set<string>();
/** Builders whose Save question is on screen, so a second close doesn't ask twice. */
const settlingBuilders = new Set<string>();

/**
 * Before a builder's window closes, ask about unsaved changes: Save stores the
 * draft, Don't Save puts back the files the agent changed, Cancel keeps the
 * window open. True = the window may close. The question goes over `parent`
 * when the builder's window isn't the asker's (quitting while a phone has it).
 */
async function settleBuilder(id: string, child: AppWindow, parent: AppWindow | null = child): Promise<boolean> {
  if (!engine || settledBuilders.has(id)) return true;
  if (settlingBuilders.has(id)) return false;
  settlingBuilders.add(id);
  try {
    if (!(await engine.builderUnsaved(id))) {
      settledBuilders.add(id);
      return true;
    }
    const state = engine.getBuilder(id);
    const raw = state?.draft.raw?.name;
    const name = typeof raw === 'string' && raw.trim() ? raw.trim() : '';
    const existing = !!state?.taskId && !!engine.getTask(state.taskId);
    // Not saving also undoes the agent's file changes, which isn't obvious: say which files.
    const files = (state?.changedFiles ?? []).map((f) => f.split(/[\\/]/).pop() ?? f);
    const fileList = listInWords(files.length > 3 ? [...files.slice(0, 2), `${files.length - 2} other files`] : files);
    if (parent === child) {
      if (child.isMinimized()) child.restore();
      child.focus();
    }
    const r = await showMessageBox(parent, {
      // A routine "save changes" confirmation: no icon.
      type: 'none',
      title: child.getTitle(),
      message: existing
        ? `Do you want to save changes to "${name || state?.taskId}"?`
        : name
          ? `Do you want to save the new task "${name}"?`
          : 'Do you want to save this new task?',
      ...(files.length ? { detail: `If you don't save, ${fileList} ${files.length === 1 ? 'goes' : 'go'} back to how ${files.length === 1 ? 'it was' : 'they were'}.` } : {}),
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (r.response === 2) return false;
    if (r.response === 0) {
      try {
        await engine.saveBuilder(id);
      } catch (err) {
        await showMessageBox(parent, { type: 'error', title: child.getTitle(), message: (err as Error).message, buttons: ['OK'] });
        return false;
      }
    } else {
      try {
        await engine.discardBuilder(id);
      } catch (err) {
        await showMessageBox(parent, { type: 'error', title: child.getTitle(), message: (err as Error).message, buttons: ['OK'] });
      }
    }
    settledBuilders.add(id);
    return true;
  } finally {
    settlingBuilders.delete(id);
  }
}

/** "a", "a and b", "a, b, and c". */
function listInWords(items: string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Every open builder answered (quitting, or closing the main window, which closes them). */
async function settleAllBuilders(): Promise<boolean> {
  for (const [id, list] of [...builderWindows]) {
    const live = list.filter((w) => !w.isDestroyed());
    // Asked over the asker's own builder window; one only another client shows is asked about over the asker's main window.
    const mine = ofCaller(live)[0];
    const child = mine ?? live[0];
    if (child && !(await settleBuilder(id, child, mine ? child : mainWin()))) return false;
  }
  return true;
}

/** Tie a builder to a window: the window's events, the Save question, and the session's end when its last window closes. */
function attachBuilder(child: AppWindow, id: string): void {
  builderWindows.set(id, [...(builderWindows.get(id) ?? []), child]);
  const others = () => (builderWindows.get(id) ?? []).filter((w) => w !== child && !w.isDestroyed());
  child.on('close', (e) => {
    // Another client still shows the builder: this window just goes.
    if (quitting || settledBuilders.has(id) || !engine || others().length > 0) return;
    e.preventDefault();
    void settleBuilder(id, child).then((ok) => {
      if (ok && !child.isDestroyed()) child.close();
    });
  });
  child.on('closed', () => {
    const rest = others();
    if (rest.length > 0) {
      builderWindows.set(id, rest);
      return;
    }
    builderWindows.delete(id);
    // A browser tab that never came back took its window without the Save question.
    if (isRemote(child) && child.client.disposed && !quitting && !settledBuilders.has(id)) {
      void rescueBuilder(id, child);
      return;
    }
    settledBuilders.delete(id);
    rescuedBuilders.delete(id);
    void engine?.closeBuilder(id);
  });
}

/** Builders a device left with unsaved work, by the device's id: they open there again when it reconnects. */
const rescuedBuilders = new Map<string, string>();

/**
 * The builder's work outlives the tab: with unsaved changes it opens on the
 * desktop, where its Save question comes as usual (also on quit), and on the
 * same device again once it reconnects. Without any, its session ends.
 */
async function rescueBuilder(id: string, gone: RemoteWindow): Promise<void> {
  if (!engine) return;
  const unsaved = await engine.builderUnsaved(id).catch(() => false);
  if (builderWindows.has(id)) return;
  if (!unsaved || quitting) {
    settledBuilders.delete(id);
    void engine.closeBuilder(id);
    return;
  }
  const child = openChildWindow(`builder/${encodeURIComponent(id)}`, gone.getTitle() || builderTitle(false), BUILDER_SIZE.width, BUILDER_SIZE.height, undefined, {
    minWidth: 760,
    minHeight: 480,
    contentSize: true,
    desktop: true,
  });
  child.setMaximizable(true);
  attachBuilder(child, id);
  rescuedBuilders.set(id, gone.client.device.id);
  engine.log.info(`remote access: ${gone.client.device.name} didn't come back to its task builder; its unsaved work is open on the desktop`);
}

/** A device's new tab: the builders it left with unsaved work open there too. */
function reopenRescuedBuilders(main: RemoteWindow): void {
  for (const [id, deviceId] of [...rescuedBuilders]) {
    if (deviceId !== main.client.device.id) continue;
    rescuedBuilders.delete(id);
    if (!builderWindows.has(id) || !engine?.getBuilder(id)) continue;
    const title = engine.getBuilder(id)?.taskId ? builderTitle(true) : builderTitle(false);
    const child = runAs({ client: main.client, window: main }, () =>
      openChildWindow(`builder/${encodeURIComponent(id)}`, title, BUILDER_SIZE.width, BUILDER_SIZE.height, undefined, { minWidth: 760, minHeight: 480, contentSize: true }),
    );
    child.setMaximizable(true);
    attachBuilder(child, id);
  }
}

function builderTitle(edit: boolean): string {
  return edit ? 'Edit Task with Agent' : 'New Task with Agent';
}

/** The setup window's Start: the builder starts and the same window turns into its conversation. */
function startBuilderInWindow(setupWindow: AppWindow | null, setup: BuilderSetup): void {
  if (!engine) return;
  const state = engine.startBuilder(setup);
  if (!setupWindow || setupWindow.isDestroyed()) {
    void engine.closeBuilder(state.id);
    return;
  }
  attachBuilder(setupWindow, state.id);
  setupWindow.setResizable(true);
  setupWindow.setMaximizable(true);
  setupWindow.setMinimumSize(760, 480);
  setupWindow.setContentSize(BUILDER_SIZE.width, BUILDER_SIZE.height);
  setupWindow.center();
  setupWindow.setTitle(builderTitle(false));
  // Same page, new hash: an in-page navigation the router never sees, so reload once it lands.
  setupWindow.webContents.once('did-navigate-in-page', () => {
    if (!setupWindow.isDestroyed()) setupWindow.webContents.reload();
  });
  loadRenderer(setupWindow, `builder/${state.id}`);
}

async function editWithAgent(taskId: string): Promise<void> {
  if (!engine) return;
  const openId = engine.builderForTask(taskId);
  const shown = openId ? (builderWindows.get(openId) ?? []).filter((w) => !w.isDestroyed()) : [];
  const open = ofCaller(shown)[0];
  if (open) {
    open.focus();
    return;
  }
  // Open on another client only: this one gets a window on the same builder.
  if (openId && shown.length > 0) {
    const child = openChildWindow(`builder/${openId}`, builderTitle(true), BUILDER_SIZE.width, BUILDER_SIZE.height, undefined, {
      minWidth: 760,
      minHeight: 480,
      contentSize: true,
    });
    child.setMaximizable(true);
    attachBuilder(child, openId);
    return;
  }
  try {
    const state = engine.startBuilder(engine.builderSetupFor(taskId));
    const child = openChildWindow(`builder/${state.id}`, builderTitle(true), BUILDER_SIZE.width, BUILDER_SIZE.height, undefined, {
      minWidth: 760,
      minHeight: 480,
      contentSize: true,
    });
    child.setMaximizable(true);
    attachBuilder(child, state.id);
  } catch (err) {
    await fileErrorBox('Could not open Edit with Agent.', (err as Error).message);
  }
}

/** Create/Update: the import editor prefilled with the draft, saving as the agent's version. */
function reviewBuilder(builderId: string): void {
  if (!engine) return;
  const payload = engine.builderDraft(builderId);
  const state = engine.getBuilder(builderId);
  const update = !!state?.taskId && !!engine.getTask(state.taskId);
  const key = Math.random().toString(36).slice(2, 10);
  importDrafts.set(key, payload);
  openChildWindow(
    `editor-import/${key}${update ? '/update' : ''}/builder/${encodeURIComponent(builderId)}`,
    update ? 'Edit Task' : 'New Task',
    780,
    800,
  );
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
  const main = mainWin();
  if (!main || main.isDestroyed()) return;
  const result = await showOpenDialog(main, {
    title: 'Import Task',
    filters: [{ name: FILE_KINDS.task.filterName, extensions: [FILE_KINDS.task.ext] }],
    properties: ['openFile'],
  });
  const file = result.canceled ? undefined : result.filePaths[0];
  if (file) await openLooperFile(file);
}

async function fileErrorBox(message: string, detail: string): Promise<void> {
  const opts: Electron.MessageBoxOptions = { type: 'error', title: 'Looper', message, detail, buttons: ['OK'] };
  const main = mainWin();
  await showMessageBox(main && !main.isDestroyed() ? main : undefined, opts);
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
  if (isAddonFileName(file)) {
    if (addons) await installAddonFile(addonDeps(), file, mainWin());
    return;
  }
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
  // A definition whose id is already in the store: ask whether to update that
  // item or import the file as a new one.
  const id = typeof payload.id === 'string' ? payload.id : '';
  const existing = !engine || !id
    ? undefined
    : doc.kind === 'task'
      ? engine.getTask(id)
      : engine.listTemplates().find((t) => t.id === id);
  let update = false;
  if (existing) {
    const kindLabel = doc.kind === 'task' ? 'task' : 'template';
    const opts: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Looper',
      message: `The ${kindLabel} "${existing.name}" is already in Looper.`,
      detail: `Update it with the file's contents, or create a new ${kindLabel}?`,
      buttons: ['Update', 'Create New', 'Cancel'],
      noLink: true,
      defaultId: 0,
      cancelId: 2,
    };
    const main = mainWin();
    const r = await showMessageBox(main && !main.isDestroyed() ? main : undefined, opts);
    if (r.response === 2) return;
    update = r.response === 0;
  }
  const key = Math.random().toString(36).slice(2, 10);
  importDrafts.set(key, payload);
  const route = doc.kind === 'task' ? 'editor-import' : 'template-import';
  const noun = doc.kind === 'task' ? 'Task' : 'Template';
  openChildWindow(`${route}/${key}${update ? '/update' : ''}`, `${update ? 'Edit' : 'New'} ${noun}`, 780, 800);
}

/** Send a UI command to the main window (menu accelerators act on the selected task there). */
function sendUi(type: string): void {
  const main = mainWin();
  if (main && !main.isDestroyed()) {
    main.webContents.send('ui:event', { type });
    main.focus();
  }
}

type MenuSelection = [
  boolean,
  boolean | undefined,
  boolean | undefined,
  string | undefined,
  boolean,
  boolean | undefined,
  boolean,
  boolean,
];
const NO_SELECTION: MenuSelection = [false, undefined, undefined, undefined, false, undefined, false, false];

/** Last selection reported by the renderer, so out-of-band rebuilds (rest events) keep the Task menu state. */
let menuSelection: MenuSelection = NO_SELECTION;
/** The same for each browser tab's main window. */
const remoteSelections = new WeakMap<RemoteWindow, MenuSelection>();

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
  const selection: MenuSelection = [
    hasTask,
    taskEnabled,
    taskPaused,
    taskState,
    hasNote ?? false,
    canRunNow,
    taskCompleted ?? false,
    allowComplete ?? false,
  ];
  // A browser tab's main window reported it: only that tab's menu bar follows.
  const ctx = caller();
  if (ctx) {
    const main = ctx.client.main;
    if (main && !main.isDestroyed()) {
      remoteSelections.set(main, selection);
      buildRemoteMenu(main);
    }
    return;
  }
  menuSelection = selection;
  buildMenu(...menuSelection);
}

function rebuildMenu(): void {
  buildMenu(...menuSelection);
  for (const w of remoteMainWindows()) buildRemoteMenu(w);
}

/** A browser tab's main window: the desktop main window's menu bar, from its own selection. */
function buildRemoteMenu(w: RemoteWindow): void {
  if (w.isDestroyed()) return;
  setWindowMenu(w, Menu.buildFromTemplate(mainMenuTemplate(...(remoteSelections.get(w) ?? NO_SELECTION))));
}

/** Persist a View-menu option; the settings event carries it to the renderer. */
function updateView(patch: Partial<Settings['view']>): void {
  if (!engine) return;
  engine.updateSettings({ view: { ...engine.settings.view, ...patch } });
}

function buildMenu(...selection: Partial<MenuSelection>): void {
  const template = mainMenuTemplate(...selection);
  if (process.platform === 'darwin') {
    // Don't stomp the menu of a focused run/subagent window; the
    // browser-window-focus handler restores the main menu on the next switch.
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || !macWindowMenus.has(focused)) {
      Menu.setApplicationMenu(Menu.buildFromTemplate(macTemplate(template)));
    }
  } else if (win && !win.isDestroyed()) {
    win.setMenu(Menu.buildFromTemplate(template));
  }
}

/** The main window's menu bar for a selection in its task list. */
function mainMenuTemplate(
  hasTask = false,
  taskEnabled?: boolean,
  taskPaused?: boolean,
  taskState?: string,
  hasNote = false,
  canRunNow?: boolean,
  taskCompleted = false,
  allowComplete = false,
): Electron.MenuItemConstructorOptions[] {
  const active = taskState === 'running' || taskState === 'checking' || taskState === 'classifying';
  // The renderer knows the task's run cap; a task with room under it can still Run Now while active.
  const runNow = canRunNow ?? !active;
  const view: Settings['view'] = engine?.settings.view ?? ViewSchema.parse({});
  const addonPanes = addons ? addonPanesMenu(addons.list(), view, updateView) : [];
  const tools = addons ? addonToolsMenu(addonDeps(), addons.list()) : [];
  const addonToolbars = addons ? addonToolbarsMenu(addons.list(), view, updateView) : [];
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: '&New Task…', accelerator: 'CmdOrCtrl+N', click: () => openEditorWindow() },
        { label: 'New Task from &Template…', accelerator: 'CmdOrCtrl+Shift+N', click: () => openTemplatePickerWindow() },
        { label: 'New Task with A&gent…', click: () => openBuilderSetupWindow() },
        { label: 'New &Folder…', click: () => openNewFolderWindow() },
        { label: 'New P&roject…', click: () => openProjectEditor() },
        { type: 'separator' },
        { label: '&Import Task…', click: () => void importTask() },
        { id: 'task-export', label: 'Ex&port Task…', enabled: hasTask, click: () => sendUi('export-task') },
        { type: 'separator' },
        { label: 'Temp&lates…', click: () => openTemplatesWindow() },
        { label: 'Recycle &Bin…', click: () => openRecycleBinWindow() },
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
        { id: 'task-edit-agent', label: 'Edit with &Agent…', enabled: hasTask, click: () => sendUi('edit-with-agent') },
        { id: 'task-versions', label: '&Version History…', enabled: hasTask, click: () => sendUi('version-history') },
        { id: 'task-delete', label: 'De&lete Task', enabled: hasTask, click: () => sendUi('delete-task') },
        { type: 'separator' },
        { id: 'task-note', label: hasNote ? 'Edit &Guidance for Next Run…' : 'Add &Guidance for Next Run…', enabled: hasTask, click: () => sendUi('edit-note') },
        { id: 'task-note-clear', label: 'Clear Guidance', enabled: hasTask && hasNote, click: () => sendUi('clear-note') },
        { type: 'separator' },
        { id: 'task-move-folder', label: 'Move to &Folder…', enabled: hasTask, click: () => sendUi('move-to-folder') },
        { id: 'task-clear-runs', label: 'Clear Run &History…', enabled: hasTask && !active, click: () => sendUi('clear-runs') },
        { type: 'separator' },
        { id: 'task-terminal', label: 'Open Project in &Terminal', accelerator: 'CmdOrCtrl+T', enabled: hasTask, click: () => sendUi('open-terminal') },
        { id: 'task-chat', label: 'Open Project in &Chat', enabled: hasTask, click: () => sendUi('open-chat') },
        { id: 'task-work-folder', label: 'Open &Working Directory', enabled: hasTask, click: () => sendUi('open-work-folder') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: '&Dashboard', click: () => sendUi('show-dashboard') },
        { label: '&Sessions', click: () => openSessionsWindow() },
        { type: 'separator' },
        {
          label: '&Projects',
          type: 'checkbox',
          checked: view.projectsPane.visible,
          click: (item) => updateView({ projectsPane: { ...view.projectsPane, visible: item.checked } }),
        },
        { label: 'Task &List', submenu: taskListMenu(view, updateView) },
        ...(addonPanes.length ? [{ label: '&Addon Panes', submenu: addonPanes }] : []),
        {
          label: 'Task Lo&gs',
          submenu: [
            { label: 'Hide Runs with &No Action', type: 'checkbox', checked: view.hideNoActionRuns, click: (item) => updateView({ hideNoActionRuns: item.checked }) },
            {
              label: 'Hide &Chats and Terminals',
              type: 'checkbox',
              checked: view.hideChatsAndTerminals,
              click: (item) => updateView({ hideChatsAndTerminals: item.checked }),
            },
          ],
        },
        { type: 'separator' },
        { label: '&Toolbar', type: 'checkbox', checked: view.toolbar, click: (item) => updateView({ toolbar: item.checked }) },
        ...addonToolbars,
        { label: 'Status &Bar', type: 'checkbox', checked: view.statusBar, click: (item) => updateView({ statusBar: item.checked }) },
      ],
    },
    ...(tools.length ? [{ label: 'T&ools', submenu: tools }] : []),
    {
      label: '&Advanced',
      submenu: [
        {
          label: 'Remote &Control',
          submenu: [
            {
              label: engine?.remoteState().running ? '&Stop Remote Control' : '&Start Remote Control',
              click: () => void toggleRemote(),
            },
            { type: 'separator' },
            { label: '&Conversations…', click: () => openRemoteConversationsWindow() },
            { label: 'S&ettings…', click: () => openRemoteSettingsWindow() },
          ],
        },
        {
          label: 'Remote Acc&ess',
          submenu: [
            {
              label: engine?.settings.remoteAccess.enabled ? 'Turn &Off Remote Access' : 'Turn &On Remote Access',
              click: () => toggleRemoteAccess(),
            },
            { type: 'separator' },
            { label: '&Pair Device…', enabled: remoteAccessPhase === 'running', click: () => openRemoteAccessPairWindow() },
            { label: 'S&ettings…', click: () => openRemoteAccessSettingsWindow() },
          ],
        },
        { label: '&Addons…', click: () => openAddonsWindow() },
        { type: 'separator' },
        { label: 'Update &Models…', click: () => openModelUpdateWindow() },
        { label: 'Engine &Log', click: () => openEngineLogWindow() },
        {
          label: 'Open &Data Directory',
          click: () => {
            if (engine) void openPath(engine.dataDir);
          },
        },
        { role: 'reload', label: '&Reload UI' },
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
  return template;
}
