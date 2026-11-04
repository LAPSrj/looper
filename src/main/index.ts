import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createEngine, type Engine } from '../engine/engine';
import { describeHolder, EngineLock, liveHolder, TAKEOVER_WAIT_MS, type LockHolder } from '../engine/lock';
import { readWakeTimerPolicy } from '../engine/power-win';
import type { PowerAdapter } from '../engine/rest';
import { ViewSchema, type EngineEvent, type PreventSleepTimer, type Settings } from '../shared/types';
import type { BuilderSetup } from '../shared/builder';
import { projectTaskId } from '../shared/projects';
import { sessionGroupKey, watchedSessions } from '../shared/sessions';
import type { UiEvent } from '../shared/api';
import { chatCanCompact, chatIsEmpty, type ChatSettingMenu, type ChatSettings, type ChatState } from '../shared/chat';
import { EFFORT_LEVELS, PERMISSION_MODES, startsWithRemoteControl } from '../shared/environments';
import { convertWslPath, defaultDataDir } from '../engine/host';
import { readJson } from '../engine/store/fsutil';
import { FILE_KINDS, isAddonFileName, isLooperFileName, readLooperFile } from '../shared/files';
import { messagesToMarkdown } from '../shared/messages-md';
import type { MessageRow } from '../shared/messages';
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
  openExternal,
  openPath,
  runAs,
  setWindowMenu,
  showMessageBox,
  showOpenDialog,
  showSaveDialog,
  placeAs,
  popupMenu,
  useRemoteClients,
  useWindowPlaces,
  windowOf,
  WindowSlots,
  writeClipboard,
  type AppWindow,
  type MessageBoxOptions,
  type RemoteWindow,
} from './platform';
import { RemoteAccess, wanted } from './remote-access';
import { pwaIcons } from './pwa-icons';
import { pwaStartup } from './pwa-startup';
import { SOURCE_NAMES, type RemoteAccessPhase, type RemoteAccessProviderId, type RemoteAccessState } from '../shared/remote-access';
import { groupProjectsByMenu, paneVisibilityItems, taskListMenu } from './view-menu';
import { mainTabs } from '../shared/main-tabs';
import { PROJECT_COMMAND_NAMES, projectMenuItems, type ProjectCommand } from './project-menu';
import { fileNewItems, newChatItems, type FileNewActions } from './file-menu';
import { commandMenu, commandMenuItem } from './command-menu';
import { CHAT_COMMANDS } from '../shared/commands/chat';
import { TASK_COMMANDS } from '../shared/commands/task';
import { zoomMenuItems } from './platform/zoom';

/** The main window's UI command for each Project menu item. */
const PROJECT_UI_ACTIONS: Record<ProjectCommand, string> = {
  'new-task': 'new-task',
  'new-chat': 'open-chat',
  'new-terminal': 'open-terminal',
  edit: 'edit-project',
  'open-folder': 'open-project-folder',
  delete: 'delete-project',
};
import { hideOffPlatform } from './platform/menus';
import { DESKTOP_ONLY, NOT_MOBILE } from '../shared/ui-platform';
import { SHORTCUTS } from '../shared/shortcuts';
import { NO_HISTORY_COMMANDS, type HistoryCommand, type HistoryFolderFilter } from '../shared/history';

let win: BrowserWindow | null = null;
let engine: Engine | null = null;
let addons: AddonHost | null = null;
let tray: Tray | null = null;
let quitting = false;
/** Whether Remote Control was on at its last event: the menus change only when this does. */
let remoteRunning = false;
/** The Prevent Sleep timer at its last event: the menus change only when this does. */
let preventSleepTimer: PreventSleepTimer = 'off';
let remoteAccess: RemoteAccess | null = null;
/** Remote Access's phase at its last event. */
let remoteAccessPhase: RemoteAccessPhase = 'off';
/** What the Remote Access menu shows from the state (its phase, Tailscale's sign-in): the menu changes only when this does. */
let remoteAccessMenuKey = '';
/** Each source's phase at the last event, and the server's error: a sign-in or error dialog comes once per change. */
const remoteAccessSourcePhases = new Map<RemoteAccessProviderId | 'server', RemoteAccessPhase>();

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
      keepAwake: createKeepAwake(),
    });
    engine.start();
    useWindowPlaces(path.join(dataDir, 'windows.json'));
    engine.on((event) => {
      if (event.type === 'notify') showTaskNotification(event);
      else if (event.type === 'projects') tray?.setContextMenu(trayMenu());
      // Task runs in the Chats window aren't pushed: their own notifications cover them.
      else if (event.type === 'sessions')
        void remoteAccess?.sessionsChanged(event.state.sessions.filter((s) => s.kind !== 'run'), !!engine?.settings.notificationsEnabled);
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
      } else if (event.type === 'prevent-sleep' && event.state.timer !== preventSleepTimer) {
        // The Prevent Sleep choice and the Rest Mode item follow the timer.
        preventSleepTimer = event.state.timer;
        tray?.setContextMenu(trayMenu());
        rebuildMenu();
      } else if (event.type === 'remote' && event.state.running !== remoteRunning) {
        // Turn On/Off Remote Control and the Rest Mode item follow it.
        remoteRunning = event.state.running;
        tray?.setContextMenu(trayMenu());
        rebuildMenu();
      }
    });
    // Turned on, it started with the engine, before the listener above was there.
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
      compactChat,
      compactRun,
      sessionWindow: sessionWindowsShowing,
      showSession,
      showCards,
      closeSession: (id, from) => closeSessionAsk(id, from),
      restartSession: (id, from) => restartSessionAsk(id, from),
      confirmChatSend,
      closeSessionGroup: (group, from) => closeAllSessionsAsk(group, from),
      openSendToSessions: openSendToSessionsWindow,
      openHistory: openHistoryWindow,
      historySelect,
      historyToggleActivity,
      historyRun,
      historyMenu,
      openSessions: (select) => (select ? showChat(select) : openSessionsWindow()),
      openChatWindow,
      openItemWindow,
      openProjectFolderName: openProjectFolderNameWindow,
      chatSettingMenu,
      openRemoteConversation,
      openRemoteHelperEditor,
      remoteAccess: () => remoteAccess,
      openRemoteAccessPair: openRemoteAccessPairWindow,
      openRemoteAccessRename: openRemoteAccessRenameWindow,
      finishRemoteAccessSetup,
      openNotification,
      openProjectEditor,
      openNewTaskIn,
      openInFolder,
      takeImportDraft,
      openLooperFile,
      showTaskInMain: (taskId, view) => openTaskView(taskId, '', view),
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
      startup: pwaStartup,
      savePort: (port) => {
        const ra = eng.settings.remoteAccess;
        if (ra.port === 0) eng.updateSettings({ remoteAccess: { ...ra, port } });
      },
      emit: (state) => {
        broadcastEvent({ type: 'remote-access', state });
        remoteAccessChanged(state);
      },
    });
    useRemoteClients(remoteAccess.clients);
    // A new browser tab's main window gets the main window's menu bar.
    remoteAccess.clients.onMainWindow((w) => {
      const view: MainView = { w, fixed: false, selection: NO_SELECTION };
      mainViews.set(w, view);
      w.on('closed', () => mainViews.delete(w));
      buildMainMenu(view);
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
    if (process.platform === 'darwin') rebuildMenu();
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
      // Starting Looper didn't ask to stop the other one's runs.
      destructiveId: 0,
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
    defaultId: 0,
    cancelId: 0,
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
    message.push(terminals === 1 ? 'A terminal session is still running.' : `${terminals} terminal sessions are still running.`);
    stops.push(terminals === 1 ? "the session's agent" : "the sessions' agents");
  }
  if (remote > 0) {
    message.push(remote === 1 ? 'A Remote Control conversation is still open.' : `${remote} Remote Control conversations are still open.`);
    stops.push(remote === 1 ? 'the conversation' : 'the conversations');
  }
  if (chats > 0) {
    message.push(chats === 1 ? 'An agent in a chat is still working.' : `Agents in ${chats} chats are still working.`);
    stops.push(chats === 1 ? 'the agent' : 'the agents');
  }
  if (running > 0) {
    message.push(running === 1 ? 'A task is still running.' : `${running} tasks are still running.`);
    stops.push(running === 1 ? 'its run' : 'their runs');
  }
  if (watching > 0) {
    message.push(watching === 1 ? 'A task is watching for events.' : `${watching} tasks are watching for events.`);
    stops.push(watching === 1 ? 'the watcher until Looper starts again' : 'the watchers until Looper starts again');
  }
  // The chats and terminal sessions themselves stay: the next start lists them again with their conversations.
  const stay = terminals > 0 || chats > 0 ? ' The chats and terminal sessions stay in the Chats window, with their conversations, for when Looper starts again.' : '';
  return { message: message.join(' '), detail: `Quitting Looper stops ${stops.join(' and ')}.${stay}` };
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
    const opts: MessageBoxOptions = {
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

/** Prevent Sleep's blocker, apart from Rest Mode's. */
function createKeepAwake(): (on: boolean) => void {
  let blockerId: number | null = null;
  return (on) => {
    if (on) {
      if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) blockerId = powerSaveBlocker.start('prevent-app-suspension');
      return;
    }
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
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
    await showMessageBox(undefined, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'], defaultId: 0, cancelId: 0 });
  }
}

function restMenuItems(): Electron.MenuItemConstructorOptions[] {
  if (engine?.host !== 'windows') return [];
  const armed = engine.restState().armed;
  // A sleeping computer drops Remote Control's sessions, and a Prevent Sleep timer
  // keeps the computer awake: Rest Mode waits until both are off.
  const enabled = armed || (!engine.remoteState().running && engine.preventSleepState().timer === 'off');
  return [{ label: armed ? 'Stop Res&t Mode' : 'Start Res&t Mode', enabled, click: () => void toggleRestMode() }];
}

/** Advanced → Prevent Sleep: the timer's choices (for this run of Looper), then the saved While a Session Is Working. */
function preventSleepMenu(): Electron.MenuItemConstructorOptions[] {
  const timer = engine?.preventSleepState().timer ?? 'off';
  const choices: [PreventSleepTimer, string][] = [
    ['off', '&Off'],
    [30, '&30 Minutes'],
    [60, '&1 Hour'],
    [120, '&2 Hours'],
    ['until-off', '&Until Turned Off'],
  ];
  return [
    ...choices.map(([value, label]): Electron.MenuItemConstructorOptions => ({
      label,
      type: 'radio',
      checked: timer === value,
      click: () => engine?.setPreventSleep(value),
    })),
    { type: 'separator' },
    {
      label: 'While a Session Is &Working',
      type: 'checkbox',
      checked: engine?.settings.preventSleepWhileWorking ?? false,
      click: (item) => engine?.updateSettings({ preventSleepWhileWorking: item.checked }),
    },
  ];
}

/** Advanced → Remote Control → Turn On / Turn Off: saved, so it starts with Looper while it's on. */
async function toggleRemote(): Promise<void> {
  if (!engine) return;
  const setEnabled = (enabled: boolean): boolean => {
    try {
      engine!.updateSettings({ remote: { ...engine!.settings.remote, enabled } });
      return true;
    } catch (err) {
      void showMessageBox(undefined, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'], defaultId: 0, cancelId: 0 });
      return false;
    }
  };
  if (!engine.settings.remote.enabled) {
    if (!setEnabled(true)) return;
    const harnessUsesIt = engine.settings.environments.some((e) => e.harnesses.some(startsWithRemoteControl));
    if (engine.settings.remote.helpers.length === 0 && !engine.listProjects().some((p) => p.remote) && !harnessUsesIt) {
      await showMessageBox(undefined, {
        type: 'info',
        title: 'Looper',
        message: 'Remote Control is on, but no helper or project keeps a conversation open yet.',
        detail:
          'Add a helper in Advanced → Remote Control → Helpers, check "Keep a Remote Control conversation open" in a project\'s Edit Project window, or check "Start new conversations with Remote Control" in a Claude Code harness.',
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0,
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
      detail: 'Turning off Remote Control ends every one of its sessions.',
      buttons: ['Turn Off', 'Cancel'],
      noLink: true,
      defaultId: 1,
      cancelId: 1,
    });
    if (r.response !== 0) return;
  }
  setEnabled(false);
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
/** Scaling the 1254x1254 PNG costs 150-300 ms per window opened; on Windows the .ico has the small sizes. appIcon stays the PNG for the PWA icons and notifications. */
const windowIcon = trayIcon;

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
    { label: 'Show Chats', click: () => openSessionsWindow() },
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
  /** run-window: the run window on its report; run: the run window as it opens; runs: the task's Runs tab. */
  view: 'status' | 'runs' | 'run-window' | 'run';
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
  // A run that ended badly opens its run window on the report; another
  // finished run lands on the Runs tab with the run selected; a live run (a
  // question, a held agent, a start) opens its run window, where the answer
  // or guidance is typed.
  const hasRun = e.runId !== '-';
  const view: ToastTarget['view'] =
    e.problem && hasRun && e.kind !== 'question'
      ? 'run-window'
      : e.kind === 'end' || e.kind === 'auto-paused' || e.kind === 'usage-limit' || e.kind === 'completed'
        ? 'runs'
        : hasRun
          ? 'run'
          : 'status';
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
  openToastTarget(toastTargets.get(toastKey(taskId, runId)) ?? { taskId, runId: runId ?? '-', view: runId ? 'runs' : 'status' });
}

function openToastTarget(t: ToastTarget): void {
  if (t.view === 'run-window' || t.view === 'run') {
    openMessagesWindow(t.taskId, t.runId, undefined, undefined, t.view === 'run-window');
    return;
  }
  openTaskView(t.taskId, t.runId, t.view);
}

function openTaskView(taskId: string, runId: string, view: 'status' | 'runs'): void {
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
  // Only the main window is titled "Looper": loading index.html fires its static
  // <title>, which must not replace the title a child window was created with.
  if (hash) {
    target.on('page-title-updated', (e, title) => {
      if (title === 'Looper') e.preventDefault();
    });
  }
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

/** A menu for the desktop's own menu bar: without the items marked for other platforms. */
function desktopMenu(template: Electron.MenuItemConstructorOptions[]): Menu {
  const menu = Menu.buildFromTemplate(template);
  hideOffPlatform(menu, 'desktop');
  return menu;
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
  const menu = desktopMenu(macTemplate(template));
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
  const menu = desktopMenu(macTemplate(template));
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
      icon: windowIcon,
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
  const main = win;
  mainViews.set(main, { w: main, fixed: false, selection: NO_SELECTION });
  win.on('closed', () => {
    mainViews.delete(main);
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
  buildMainMenu(mainViews.get(main)!);
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
      icon: windowIcon,
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
      icon: windowIcon,
      backgroundColor: windowBackground(),
      maximizable: true,
      webPreferences: webPreferences(),
    },
    hash,
  );
  const send = (payload: unknown) => {
    if (!child.isDestroyed()) child.webContents.send('ui:event', payload);
  };
  // Filter… opens the filter window, and its checkmark mirrors whether a
  // filter is active (reported by the renderer), not the click itself.
  let filterValue = '';
  // The export options window remembers the last choice for this window's lifetime.
  let exportOpts = { includeThinking: true, includeTools: true, plain: false };
  const saveMarkdown = async () => {
    if (!engine) return;
    try {
      const result = await engine.readMessages(taskId, runId, agentId, false);
      if (result.status !== 'ok' || result.rows.length === 0) {
        await showMessageBox(child, { type: 'error', title: 'Looper', message: 'There are no messages to save.', buttons: ['OK'], defaultId: 0, cancelId: 0 });
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
        defaultId: 0,
        cancelId: 0,
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
  const none = { chat: false, terminal: false, guidance: false, compact: false };
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
                defaultId: 0,
                cancelId: 0,
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
                defaultId: 0,
                cancelId: 0,
              });
            }),
        },
        {
          label: 'Continue Co&mpacted',
          enabled: canContinue.compact,
          click: () =>
            void compactRun(taskId, runId).catch(async (err: unknown) => {
              await showMessageBox(child, {
                type: 'error',
                title: 'Looper',
                message: err instanceof Error ? err.message : String(err),
                buttons: ['OK'],
                defaultId: 0,
                cancelId: 0,
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
      id: 'file',
      label: '&File',
      submenu: [
        { label: '&Save as Markdown…', accelerator: 'CmdOrCtrl+S', click: () => void saveMarkdown() },
        { type: 'separator' },
        ...runItems,
        {
          label: 'Open &Run Folder',
          platforms: DESKTOP_ONLY,
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
          platforms: DESKTOP_ONLY,
          enabled: !!task?.cwd,
          click: () => {
            if (task?.cwd) void openHostPath(task.cwd);
          },
        },
      ],
    },
    {
      id: 'view',
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
        ...(agentId
          ? []
          : [
              {
                id: 'show-run',
                label: 'Show Run &Log',
                type: 'checkbox' as const,
                checked: true,
                click: (item: Electron.MenuItem) => send({ type: 'messages-show-run', checked: item.checked }),
              },
              { type: 'separator' as const },
            ]),
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
      icon: windowIcon,
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

/** A Projects tab folder's name: Rename Folder with `folderId`, else New Folder in `parentId`, which `moveProject` goes into once it's made. */
function openProjectFolderNameWindow(o: { folderId?: string; parentId?: string; moveProject?: string } = {}): void {
  if (o.folderId) {
    openChildWindow(`project-folder-rename/${encodeURIComponent(o.folderId)}`, 'Rename Folder', 420, 240, win, { minWidth: 420, minHeight: 240, resizable: false });
    return;
  }
  const query = new URLSearchParams({ ...(o.parentId ? { parent: o.parentId } : {}), ...(o.moveProject ? { move: o.moveProject } : {}) }).toString();
  openChildWindow(`project-folder-new${query ? `/${encodeURIComponent(query)}` : ''}`, 'New Folder', 420, 300, win, { minWidth: 420, minHeight: 300, resizable: false });
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
  openChildWindow('settings', 'Settings', 720, 660, win, { contentSize: true });
}

const templatesWindows = new WindowSlots();

/** One Templates window (per client): opening it again brings the open one forward. */
function openTemplatesWindow(): void {
  const open = templatesWindows.get();
  if (open) {
    open.focus();
    return;
  }
  templatesWindows.set(openChildWindow('templates', 'Templates', 560, 520));
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
    hasPanes: (w) => {
      const view = mainViews.get(w);
      return !view?.fixed || view.tab === 'tasks';
    },
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
      icon: windowIcon,
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
  setWindowMenu(
    child,
    Menu.buildFromTemplate([
      {
        id: 'view',
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
  /** A new model that starts as a copy of the model at this index (Duplicate). */
  copyOf?: number,
): void {
  const slot = index !== undefined ? String(index) : Number.isInteger(copyOf) && copyOf! >= 0 ? `copy-${copyOf}` : 'new';
  openChildWindow(
    `model-editor/${encodeURIComponent(envId)}/${encodeURIComponent(harnessId)}/${slot}`,
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
 * Open Project in Terminal, or Continue in Terminal with a run id: where
 * showChat puts it, or the system's default terminal when the setting says so.
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
  else showChat(sessionId);
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

/**
 * An open conversation of Remote Control's own in a Looper terminal window (it
 * keeps running when the window closes), an open chat or terminal it lists in
 * the Chats window, an ended one in its run window.
 */
async function openRemoteConversation(id: string): Promise<void> {
  if (!engine) return;
  const conv = engine.remoteState().conversations.find((c) => c.id === id);
  if (!conv) return;
  if (conv.status === 'ended') openMessagesWindow(conv.taskId, conv.id);
  else if (conv.source === 'chat' || conv.source === 'terminal') showChat(conv.id);
  else openTerminalWindow(conv.id, `${conv.title ?? conv.name} – Remote Control`);
}

const remoteHelpersWindows = new WindowSlots();

/** Advanced → Remote Control → Helpers: one modeless window per client, like the other collection lists. */
function openRemoteHelpersWindow(): void {
  const open = remoteHelpersWindows.get();
  if (open) {
    open.focus();
    return;
  }
  remoteHelpersWindows.set(openChildWindow('remote-helpers', 'Helpers', 640, 440, undefined, { contentSize: true }));
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

/** Remote Access is on: turned on, with a source chosen. */
const remoteAccessOn = (): boolean => !!engine && wanted(engine.settings.remoteAccess) !== null;

/** Advanced → Remote Access → Turn On / Turn Off. With no source chosen yet, Turn On opens Set Up instead. */
async function toggleRemoteAccess(): Promise<void> {
  if (!engine) return;
  const ra = engine.settings.remoteAccess;
  if (remoteAccessOn()) {
    // Asked from a paired device, turning it off cuts that device off too: it asks first.
    const ctx = caller();
    if (ctx) {
      const { response } = await showMessageBox(undefined, {
        type: 'question',
        title: 'Looper',
        message: 'Turn off Remote Access?',
        detail: `${ctx.client.device.name} disconnects, and so does every other device, until Remote Access is turned on again on the computer.`,
        buttons: ['Turn Off', 'Cancel'],
        noLink: true,
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0 || !engine) return;
    }
    pairWhenRunning = null;
    engine.updateSettings({ remoteAccess: { ...engine.settings.remoteAccess, enabled: false } });
  } else if (!ra.sources.length) openRemoteAccessSetupWindow();
  else engine.updateSettings({ remoteAccess: { ...ra, enabled: true } });
}

/** Every Remote Access event: the menu, Set Up's pending Pair Device, and a dialog for a source that waits for a sign-in or fails. */
function remoteAccessChanged(state: RemoteAccessState): void {
  remoteAccessPhase = state.phase;
  const tailscale = state.sources.find((s) => s.id === 'tailscale');
  const menuKey = `${state.phase}|${tailscale?.phase ?? ''}|${tailscale?.account ?? ''}`;
  if (menuKey !== remoteAccessMenuKey) {
    remoteAccessMenuKey = menuKey;
    rebuildMenu();
  }
  if (pairWhenRunning && (state.phase === 'running' || state.phase === 'error')) {
    const { parent } = pairWhenRunning;
    pairWhenRunning = null;
    if (state.phase === 'running') openRemoteAccessPairWindow(parent && !parent.isDestroyed() ? parent : mainWin());
  }
  const now = new Map<RemoteAccessProviderId | 'server', RemoteAccessPhase>(state.sources.map((s) => [s.id, s.phase]));
  if (state.phase === 'error' && !state.sources.length) now.set('server', 'error');
  for (const [id, phase] of now) {
    if (remoteAccessSourcePhases.get(id) === phase) continue;
    // Set Up shows Tailscale's sign-in itself.
    if (id === 'tailscale' && phase === 'needs-login' && !remoteAccessSetupWindows.all().length) void askTailscaleSignIn();
    else if (phase === 'error') {
      const s = state.sources.find((x) => x.id === id);
      void remoteAccessErrorBox(id === 'server' ? state.message : `${SOURCE_NAMES[id]}: ${s?.message ?? 'it stopped working.'}`);
    }
  }
  remoteAccessSourcePhases.clear();
  for (const [id, phase] of now) remoteAccessSourcePhases.set(id, phase);
}

function openRemoteAccessSettingsWindow(): void {
  openChildWindow('remote-access-settings', 'Remote Access', 560, 400, win, { contentSize: true, minHeight: 400 });
}

const remoteAccessSetupWindows = new WindowSlots();
/** Set Up's Finish asked for Pair Device: it opens once Remote Access runs (Tailscale takes a few seconds). */
let pairWhenRunning: { parent: AppWindow | null } | null = null;

/** Advanced → Remote Access → Set Up: the wizard that chooses the sources, signs in to Tailscale and turns Remote Access on. */
function openRemoteAccessSetupWindow(): void {
  const open = remoteAccessSetupWindows.get();
  if (open) {
    open.focus();
    return;
  }
  const child = openChildWindow('remote-access-setup', 'Set Up Remote Access', 560, 460, win, { contentSize: true, minHeight: 460, resizable: false });
  remoteAccessSetupWindows.set(child);
  child.on('closed', () => {
    if (!remoteAccessSetupWindows.all().length) void remoteAccess?.endSignIn();
  });
}

/** Set Up's Finish: save its choices and turn Remote Access on; with `pair`, Pair Device follows once it runs. */
async function finishRemoteAccessSetup(choice: { sources?: unknown; hostname?: unknown }, pair: boolean): Promise<void> {
  if (!engine || !remoteAccess) throw new Error("Remote Access isn't ready yet.");
  const parent = mainWin();
  await remoteAccess.endSignIn();
  engine.updateSettings({
    remoteAccess: {
      ...engine.settings.remoteAccess,
      ...(choice.sources !== undefined ? { sources: choice.sources } : {}),
      ...(choice.hostname !== undefined ? { hostname: choice.hostname } : {}),
      enabled: true,
    },
  });
  if (!pair) return;
  if (remoteAccess.state().phase === 'running') openRemoteAccessPairWindow(parent);
  else pairWhenRunning = { parent };
}

const remoteAccessDevicesWindows = new WindowSlots();

/** One Paired Devices window (per client): opening it again brings the open one forward. */
function openRemoteAccessDevicesWindow(): void {
  const open = remoteAccessDevicesWindows.get();
  if (open) {
    open.focus();
    return;
  }
  remoteAccessDevicesWindows.set(openChildWindow('remote-access-devices', 'Paired Devices', 520, 391, undefined, { minHeight: 340 }));
}

/** The desktop's main window, for the dialogs Remote Access raises on its own. */
const desktopMain = (): BrowserWindow | undefined => (win && !win.isDestroyed() ? win : undefined);

/** Open while a sign-in or error dialog is up, so a restart doesn't stack a second one. */
let remoteAccessDialogOpen = false;

async function remoteAccessDialog(opts: MessageBoxOptions): Promise<number | null> {
  if (remoteAccessDialogOpen) return null;
  remoteAccessDialogOpen = true;
  try {
    return (await showMessageBox(desktopMain(), opts)).response;
  } finally {
    remoteAccessDialogOpen = false;
  }
}

/** Tailscale needs this computer signed in before Remote Access is reachable. */
async function askTailscaleSignIn(): Promise<void> {
  const r = await remoteAccessDialog({
    type: 'info',
    title: 'Looper',
    message: 'Sign in to Tailscale to finish turning on Remote Access.',
    buttons: ['Sign In…', 'Cancel'],
    noLink: true,
    defaultId: 0,
    cancelId: 1,
  });
  if (r === 0) await openTailscaleSignIn();
}

async function remoteAccessErrorBox(message: string | undefined): Promise<void> {
  await remoteAccessDialog({
    type: 'error',
    title: 'Looper',
    message: "Remote Access isn't working.",
    ...(message ? { detail: message } : {}),
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
  });
}

/** Advanced → Remote Access → Sign In to Tailscale: Tailscale's sign-in page, in the browser. */
async function openTailscaleSignIn(): Promise<void> {
  const url = tailscaleStatus()?.loginUrl;
  if (url && /^https:\/\//i.test(url)) await openExternal(url);
}

/** Tailscale's status while it's a running source. */
const tailscaleStatus = () => remoteAccess?.state().sources.find((s) => s.id === 'tailscale');

/** With Tailscale among the sources: Sign Out while signed in, else Sign In, which works while Tailscale asks for it. */
function tailscaleMenuItems(): Electron.MenuItemConstructorOptions[] {
  if (!engine?.settings.remoteAccess.sources.includes('tailscale')) return [];
  const s = tailscaleStatus();
  const signedIn = s?.phase === 'running' && !!s.account;
  return [
    { type: 'separator' },
    signedIn
      ? { label: 'Sign Ou&t of Tailscale…', click: () => void signOutOfTailscale() }
      : { label: 'Sign &In to Tailscale…', enabled: s?.phase === 'needs-login', click: () => void openTailscaleSignIn() },
  ];
}

/** Advanced → Remote Access → Sign Out of Tailscale; Remote Access then asks for a new sign-in. */
async function signOutOfTailscale(): Promise<void> {
  const ra = remoteAccess;
  if (!ra) return;
  const account = tailscaleStatus()?.account;
  const parent = mainWin();
  const { response } = await showMessageBox(parent, {
    type: 'question',
    title: 'Looper',
    message: `Sign this computer out of Tailscale${account ? ` (${account})` : ''}?`,
    detail: "Other devices can't reach Looper until you sign in again.",
    buttons: ['Sign Out', 'Cancel'],
    noLink: true,
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try {
    await ra.signOut();
  } catch (err) {
    await showMessageBox(parent, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'], defaultId: 0, cancelId: 0 });
  }
}

const remoteAccessPairWindows = new WindowSlots();

/** One Pair Device window per client; closing the last one cancels the code (there's one code for all). */
function openRemoteAccessPairWindow(parent: AppWindow | null = mainWin()): void {
  const open = remoteAccessPairWindows.get();
  if (open) {
    open.focus();
    return;
  }
  const child = openChildWindow('remote-access-pair', 'Pair Device', 420, 590, parent, {
    minWidth: 420,
    minHeight: 590,
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
    void showMessageBox(undefined, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'], defaultId: 0, cancelId: 0 });
  });
}

/**
 * Other Folder…: a new chat or terminal in a folder picked over `parent`, with
 * no project (a project on the folder gets it). Rejects with the reason.
 */
async function openInFolder(kind: 'chat' | 'terminal', parent: AppWindow | null): Promise<void> {
  if (!engine) return;
  const title = kind === 'chat' ? 'New Chat in Folder' : 'New Terminal in Folder';
  const r = await showOpenDialog(parent, { title, properties: ['openDirectory'] });
  const folder = r.canceled ? undefined : r.filePaths[0];
  if (!folder) return;
  const taskId = engine.folderTaskId(folder);
  await (kind === 'chat' ? openChat(taskId) : openTerminal(taskId));
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
 * in a chat, shown where showChat puts it. A chat already open on the run's
 * conversation is shown instead.
 */
async function openChat(taskId: string, runId?: string): Promise<void> {
  if (!engine) return;
  showChat(engine.startChat(taskId, runId).id);
}

/** Fork from Here: a new chat with the conversation up to the message. */
function forkChat(chatId: string, index: number): void {
  if (engine) showChat(engine.forkChat(chatId, index).id);
}

/** Compact into New Chat: the compacted chat shows where showChat puts it. Rejects with the reason. */
async function compactChat(chatId: string): Promise<void> {
  // The new chat shows before the old one closes, so the window doesn't fall back to the dashboard between them.
  if (engine) await engine.compactChat(chatId, (next) => showChat(next.id));
}

/** Continue Compacted: a new chat from the run's messages, shown where showChat puts it. Rejects with the reason. */
async function compactRun(taskId: string, runId: string): Promise<void> {
  if (engine) showChat((await engine.compactRun(taskId, runId)).id);
}

/** Menu labels show `&` as a mnemonic marker: a literal one is doubled. */
const menuText = (s: string): string => s.replace(/&/g, '&&');

/** Menu items are in title case, like the rest of the menus ("Extra high" reads "Extra High"). */
const titled = (options: readonly (readonly [string, string])[]): [string, string][] =>
  options.map(([value, label]) => [value, label.replace(/(^|\s)[a-z]/g, (m) => m.toUpperCase())]);

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
 * The chat window's Chat menu: Stop, and the chat's own harness, model,
 * effort and permission mode. The harness changes only until the first
 * message. Claude replaces its process for a new model, effort or Bypass,
 * which would cut a turn short, so those wait for the turn to end.
 */
function chatSettingItems(
  s: ChatState,
  configure: (patch: Partial<ChatSettings>) => void,
  setHarness: (harnessId: string) => void,
): Record<ChatSettingMenu, Electron.MenuItemConstructorOptions[]> {
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
    harness: radioItems(
      s.harnesses.map((h): [string, string] => [h.id, h.name]),
      s.harnessId,
      () => !s.harnessLocked,
      setHarness,
    ),
    model: radioItems(
      [['', 'Default'], ...s.models.map((m): [string, string] => [m.id, m.name])],
      s.settings.model ?? '',
      () => canReplace,
      (v) => configure({ model: v || undefined }),
    ),
    effort: radioItems(
      titled([['', defaultEffort ? `Default (${defaultEffort})` : 'Default'], ...offered]),
      s.settings.effort ?? '',
      () => canReplace,
      (v) => configure({ effort: v || undefined }),
    ),
    permission: radioItems(
      titled(PERMISSION_MODES[s.harnessKind]),
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
  setHarness: (harnessId: string) => void,
  /** The harness's own id for the conversation, once it has started it. */
  harnessSession: string | null,
  compact: () => void,
  restart: () => void,
): Electron.MenuItemConstructorOptions {
  return {
    id: 'chat',
    label: '&Chat',
    submenu: commandMenu(CHAT_COMMANDS, 'chat', {
      stop: { enabled: s.status === 'working' || s.runningCommands > 0, click: stop },
      sendNow: { enabled: s.queued.length > 0, click: sendNow },
      restart: { click: restart },
      ...chatSettingBindings(chatSettingItems(s, configure, setHarness)),
      compact: { enabled: chatCanCompact(s), click: compact },
      copySessionId: { enabled: !!harnessSession, click: () => harnessSession && writeClipboard(harnessSession) },
    }),
  };
}

/** The chat's settings submenus' bindings. */
const chatSettingBindings = (items: Record<ChatSettingMenu, Electron.MenuItemConstructorOptions[]>) => ({
  harness: { submenu: items.harness },
  model: { submenu: items.model },
  effort: { submenu: items.effort },
  permissionMode: { submenu: items.permission },
});

/** The chat's settings as submenus: the Chat menu's, and a narrow chat's one settings button. */
function chatSettingSubmenus(items: Record<ChatSettingMenu, Electron.MenuItemConstructorOptions[]>): Electron.MenuItemConstructorOptions[] {
  const b = chatSettingBindings(items);
  return [
    commandMenuItem(CHAT_COMMANDS.harness, b.harness),
    commandMenuItem(CHAT_COMMANDS.model, b.model),
    commandMenuItem(CHAT_COMMANDS.effort, b.effort),
    commandMenuItem(CHAT_COMMANDS.permissionMode, b.permissionMode),
  ];
}

/** The message box's Harness, Model, Effort or Permission Mode menu ('all': the four as submenus): the Chat menu's lists, which then rebuild the menu bar. */
function chatSettingMenu(chatId: string, which: ChatSettingMenu | 'all'): Electron.MenuItemConstructorOptions[] {
  const chat = engine?.getChat(chatId);
  if (!chat) return [];
  // The window whose message box asked: a Chats window or a main window's Chats tab.
  const showing = sessionWindowsShowing(chatId);
  const parent = showing.find((w) => w.isFocused()) ?? showing[0] ?? sessionsWindows.get();
  const showError = (err: unknown) => {
    const opts = { type: 'error' as const, title: 'Looper', message: (err as Error).message, buttons: ['OK'], defaultId: 0, cancelId: 0 };
    void showMessageBox(parent, opts);
  };
  const items = chatSettingItems(
    chat,
    (patch) => void engine?.configureChat(chatId, patch).catch(showError).finally(() => refreshSessionsMenus(true)),
    (harnessId) => void engine?.setChatHarness(chatId, harnessId).catch(showError).finally(() => refreshSessionsMenus(true)),
  );
  return which === 'all' ? chatSettingSubmenus(items) : items[which];
}

// ---------- the Chats window ----------

/**
 * A Chats window and the session it shows (null: the Overview), or a single
 * chat's window (Open in New Window): that session's chat and terminal output go there.
 */
interface SessionsView {
  w: AppWindow;
  shown: string | null;
  /** A single chat's window: it shows only `shown`, and closes when that chat does. */
  single: boolean;
  /** The chats and task runs whose cards on its dashboard show their conversation: their chat and activity events go there too. */
  cards: string[];
  /** What its menu was last built from. */
  menuKey: string;
  /** A main window's Chats tab: the menu is the main window's, which has the Chats parts while the tab shows. */
  tab?: boolean;
}

/** One Chats window per client. */
const sessionsWindows = new WindowSlots();
/** Single chats' windows, one per chat and client. */
const chatWindows = new WindowSlots();
const sessionsViews = new Map<AppWindow, SessionsView>();

/** Every Chats window and single chat's window showing the session, alone or as a dashboard card (a desktop and a phone can watch the same chat). */
function sessionWindowsShowing(id: string): AppWindow[] {
  return [...sessionsViews.values()].filter((v) => (v.shown === id || v.cards.includes(id)) && !v.w.isDestroyed()).map((v) => v.w);
}

/** Bring an open window to the front. */
function bringForward(w: AppWindow): void {
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/**
 * The Chats window, opened or brought forward, showing the session
 * `select` when given. Closing it leaves every session running: only Close
 * Conversation and Close All Conversations end them. Quitting Looper stops
 * their agents and keeps them for its next start.
 */
function openSessionsWindow(select?: string): void {
  const open = sessionsWindows.get();
  if (open) {
    bringForward(open);
    if (select) open.webContents.send('ui:event', { type: 'sessions-select', id: select });
    return;
  }
  const child = openChildWindow(select ? `sessions/${encodeURIComponent(select)}` : 'sessions', 'Chats', 1388, 895, undefined, {
    // The list's and the Activity pane's smallest widths (200, 280) beside a 480 px conversation.
    minWidth: 970,
    minHeight: 500,
    contentSize: true,
  });
  child.setMaximizable(true);
  sessionsWindows.set(child);
  trackSessionsView({ w: child, shown: select ?? null, single: false, cards: [], menuKey: '' });
}

/**
 * Open in New Window: a window with only that chat (or task run), laid out
 * like the Chats window's chat panel. The Chats window keeps listing it, and
 * both stay live; opening it again brings its window forward.
 */
function openChatWindow(id: string): void {
  const kind = engine?.sessionKind(id);
  if (kind !== 'chat' && kind !== 'run') return;
  const open = chatWindows.get(id);
  if (open) {
    bringForward(open);
    return;
  }
  const child = openChildWindow(`sessions/${encodeURIComponent(id)}/window`, sessionTitle(id), 900, 760, undefined, {
    minWidth: 520,
    minHeight: 400,
    contentSize: true,
  });
  child.setMaximizable(true);
  chatWindows.set(child, id);
  trackSessionsView({ w: child, shown: id, single: true, cards: [], menuKey: '' });
}

/** Give a Chats or single chat's window its menu, and its session's events, until it closes. */
function trackSessionsView(view: SessionsView): void {
  const child = view.w;
  sessionsViews.set(child, view);
  attachWindowMenu(child, sessionsTemplate(view));
  view.menuKey = sessionsMenuState(view);
  watchShownSessions();
  const unsubscribe = engine!.on((e) => {
    // A single chat's window goes with its chat (closed, or a task run that ended).
    if (view.single && e.type === 'sessions' && view.shown && !engine?.sessionKind(view.shown)) {
      if (!child.isDestroyed()) child.close();
      return;
    }
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

/** A main window's Chats tab, kept from the first time its page reports what it shows until the window closes. */
function tabSessionsView(w: AppWindow): SessionsView | undefined {
  const known = sessionsViews.get(w);
  const main = mainViews.get(w);
  // A view window has no Chats tab (View → Chats is the Chats window).
  if (known || !main || main.fixed) return known;
  const view: SessionsView = { w, shown: null, single: false, cards: [], menuKey: '', tab: true };
  sessionsViews.set(w, view);
  const unsubscribe = engine!.on((e) => {
    if ((e.type === 'chat' && e.state.id === view.shown) || e.type === 'sessions' || e.type === 'projects' || e.type === 'settings') refreshSessionsMenu(view);
  });
  w.on('closed', () => {
    unsubscribe();
    sessionsViews.delete(w);
    watchShownSessions();
  });
  return view;
}

/**
 * A conversation that was started or picked: in the Chats window when it's
 * open and the caller's main window isn't the one in front, else on the main
 * window's Chats tab. A phone's main window has no conversation in it, so it
 * opens a Chats window.
 */
function showChat(id: string): void {
  const main = mainWin();
  const phone = isRemote(main) && main.client.uiPlatform === 'mobile';
  if (!main || main.isDestroyed() || phone || (sessionsWindows.get() && !main.isFocused())) {
    openSessionsWindow(id);
    return;
  }
  bringForward(main);
  main.webContents.send('ui:event', { type: 'sessions-select', id } satisfies UiEvent);
}

/** The engine follows closely every session a Chats window shows, on any device, and the task runs its dashboard shows live. */
function watchShownSessions(): void {
  if (engine) engine.watchSessions(watchedSessions(sessionsViews.values(), (id) => engine?.sessionKind(id) === 'run'));
}

/** That Chats window now shows `id` (null: the Overview): its chat and terminal output go there. A single chat's window keeps its chat. */
function showSession(w: AppWindow | null, id: string | null): void {
  const own = w ? (sessionsViews.get(w) ?? tabSessionsView(w)) : undefined;
  const chatsWindow = sessionsWindows.get();
  // Another window's report is the Chats window's; a main window's never is, a view window's included.
  const view = own ?? (w && mainViews.has(w) ? undefined : chatsWindow ? sessionsViews.get(chatsWindow) : undefined);
  if (view && !view.single) view.shown = id;
  watchShownSessions();
  if (view) refreshSessionsMenu(view, true);
}

/** The chats and task runs that Chats window's dashboard shows live as cards: their chat and activity events go there too. */
function showCards(w: AppWindow | null, ids: string[]): void {
  const view = w ? (sessionsViews.get(w) ?? tabSessionsView(w)) : undefined;
  if (!view || view.single) return;
  view.cards = ids;
  watchShownSessions();
}

/** What a Chats window's menu depends on: rebuilt when it changes. */
function sessionsMenuState(view: SessionsView): string {
  const id = view.shown;
  const chat = id ? engine?.getChat(id) : undefined;
  return JSON.stringify([
    id,
    id ? engine?.sessionKind(id) : null,
    id ? !!engine?.harnessSessionId(id) : false,
    chat ? [chat.harnessId, chat.harnessLocked, chat.harnesses, chat.settings, chat.status, chat.permissions.length > 0, chat.models, chat.queued.length > 0] : null,
    engine?.listProjects().map((p) => p.name),
    engine?.sessionsState().sessions.length ?? 0,
    engine?.settings.view.sessions,
  ]);
}

function refreshSessionsMenu(view: SessionsView, force = false): void {
  if (view.w.isDestroyed()) return;
  const main = view.tab ? mainViews.get(view.w) : undefined;
  // Another tab of the main window shows: its menu has no Chats parts, and the tab's rebuild it when they come back.
  if (view.tab && main?.tab !== 'chats') {
    view.menuKey = '';
    return;
  }
  const key = sessionsMenuState(view);
  if (key === view.menuKey && !force) return;
  view.menuKey = key;
  if (main) buildMainMenu(main);
  else replaceWindowMenu(view.w, sessionsTemplate(view));
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

/** Close Conversation (the toolbar, the menus, Ctrl+W, Ctrl+F4): the chat or terminal session ends once the user confirms. */
async function closeSessionAsk(id: string, from?: AppWindow | null): Promise<void> {
  const kind = engine?.sessionKind(id);
  if (!engine || (kind !== 'chat' && kind !== 'terminal')) return;
  const busy = sessionBusy(id);
  // A chat nobody has written in has nothing to lose.
  const chat = kind === 'chat' ? engine.getChat(id) : undefined;
  // Settings → Chats: once the last reply's prompt cache has expired, going on would start over at full price anyway.
  const cacheUntil = engine.sessionsState().sessions.find((s) => s.id === id)?.cacheUntil;
  const expired = engine.settings.chats.closeExpiredWithoutAsking && cacheUntil !== undefined && cacheUntil <= Date.now();
  if (!busy && ((chat && chatIsEmpty(chat)) || expired)) {
    await engine.closeSession(id);
    return;
  }
  const parent = from && !from.isDestroyed() ? from : sessionsWindows.get();
  const opts = {
    type: 'question' as const,
    title: 'Chats',
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

/**
 * Settings → Chats → Ask before sending a message once the cache has expired:
 * a message to an idle chat whose last reply's prompt cache has expired (and,
 * with Only when the context is larger than, whose context is over the size)
 * asks first, since the agent reads the whole context again at full price.
 * True to send.
 */
async function confirmChatSend(id: string, from: AppWindow | null): Promise<boolean> {
  const ask = engine?.settings.chats.confirmExpiredSend;
  if (!engine || !ask?.enabled) return true;
  const s = engine.sessionsState().sessions.find((x) => x.id === id);
  if (!s || s.status === 'working' || s.cacheUntil === undefined || s.cacheUntil > Date.now()) return true;
  const tokens = engine.getChat(id)?.context?.tokens ?? s.context?.tokens;
  if (ask.onlyAbove && (tokens ?? 0) <= ask.aboveTokens) return true;
  const size = tokens !== undefined ? ` (${Math.round(tokens / 1000)}k tokens)` : '';
  const parent = from && !from.isDestroyed() ? from : sessionsWindows.get();
  const { response } = await showMessageBox(parent, {
    type: 'question',
    title: 'Chats',
    message: `The prompt cache of "${sessionTitle(id)}" has expired. Send anyway?`,
    detail: `The agent reads the whole conversation${size} again without the cache, which costs more and takes longer.`,
    buttons: ['Send', 'Cancel'],
    noLink: true,
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

/** Restart Agent (the toolbar, the menus): the harness starts again on the conversation, once the user confirms when it's working. Rejects with the reason. */
async function restartSessionAsk(id: string, from?: AppWindow | null): Promise<void> {
  if (!engine?.canRestartSession(id)) return;
  if (sessionBusy(id)) {
    const parent = from && !from.isDestroyed() ? from : sessionsWindows.get();
    const { response } = await showMessageBox(parent, {
      type: 'question',
      title: 'Chats',
      message: `Restart the agent of "${sessionTitle(id)}"?`,
      detail: 'It’s still working, and restarting stops its turn.',
      buttons: ['Restart Agent', 'Cancel'],
      noLink: true,
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  await engine.restartSession(id);
}

/** The chats and terminal sessions the list shows: the ones Close and Send to Chats act on (task runs aren't). */
function openConversations() {
  return (engine?.sessionsState().sessions ?? []).filter((s) => s.kind !== 'run');
}

/**
 * Close All Conversations: every chat and terminal session ends, after asking.
 * `group` (sessionGroupKey): only the ones in that list group, asked over `from`.
 */
async function closeAllSessionsAsk(group?: string, from?: AppWindow | null): Promise<void> {
  if (!engine) return;
  const eng = engine;
  const sessions = openConversations().filter((s) => group === undefined || sessionGroupKey(s) === group);
  if (sessions.length === 0) return;
  const working = sessions.filter((s) => sessionBusy(s.id)).length;
  const parent = from && !from.isDestroyed() ? from : sessionsWindows.get();
  const where = group === undefined ? '' : ` in ${sessions[0].groupName}`;
  const opts = {
    type: 'question' as const,
    title: 'Chats',
    message: sessions.length === 1 ? `Close the conversation${where}?` : `Close all ${sessions.length} conversations${where}?`,
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
  if (response !== 0) return;
  if (group === undefined) await eng.closeAllSessions();
  else await Promise.all(sessions.map((s) => eng.closeSession(s.id)));
}

/**
 * The Chats window's menus: File, Edit, View, and Chat while a chat is shown.
 * A single chat's window has the ones about its chat.
 */
function sessionsTemplate(sv: SessionsView): Electron.MenuItemConstructorOptions[] {
  const p = sessionsMenuParts(sv);
  const child = sv.w;
  const sep: Electron.MenuItemConstructorOptions = { type: 'separator' };
  const file: Electron.MenuItemConstructorOptions = {
    id: 'file',
    label: '&File',
    submenu: [
      ...(sv.single ? [] : [...fileNewItems(FILE_NEW_ACTIONS, p.newItems, true), sep]),
      ...p.fileItems,
      sep,
      { label: 'Close &Window', platforms: NOT_MOBILE, accelerator: 'Alt+F4', registerAccelerator: false, click: () => child.close() },
    ],
  };
  const shown = engine?.settings.view.sessions ?? ViewSchema.parse({}).sessions;
  const setShown = (patch: Partial<Settings['view']['sessions']>) => updateView({ sessions: { ...shown, ...patch } });
  const view: Electron.MenuItemConstructorOptions = {
    id: 'view',
    label: '&View',
    submenu: sv.single
      ? [
          {
            label: 'A&ctivity Pane',
            platforms: NOT_MOBILE,
            type: 'checkbox',
            checked: shown.windowActivityPane,
            click: (item) => setShown({ windowActivityPane: item.checked }),
          },
          { label: 'Status &Bar', platforms: NOT_MOBILE, type: 'checkbox', checked: shown.windowStatusBar, click: (item) => setShown({ windowStatusBar: item.checked }) },
          // A browser tab can't stay above the device's other windows.
          ...(child instanceof BrowserWindow
            ? [{ label: 'Always on &Top', type: 'checkbox' as const, checked: child.isAlwaysOnTop(), click: (item: Electron.MenuItem) => child.setAlwaysOnTop(item.checked) }]
            : []),
          sep,
          ...p.paneItems,
          sep,
          ...zoomMenuItems(),
        ]
      : [
          { id: 'chats-dashboard', label: '&Dashboard', glyph: 'dashboard', click: () => p.send({ type: 'sessions-dashboard' }) },
          { id: 'chats-history', label: '&History', glyph: 'history', platforms: NOT_MOBILE, click: () => openHistoryWindow() },
          sep,
          { label: '&Toolbar', platforms: NOT_MOBILE, type: 'checkbox', checked: shown.toolbar, click: (item) => setShown({ toolbar: item.checked }) },
          p.activityPane,
          { label: 'Status &Bar', platforms: NOT_MOBILE, type: 'checkbox', checked: shown.statusBar, click: (item) => setShown({ statusBar: item.checked }) },
          sep,
          ...p.listItems,
          sep,
          ...p.navItems,
          sep,
          ...p.paneItems,
          sep,
          ...zoomMenuItems(),
        ],
  };
  const menus = process.platform === 'darwin' ? [file, view] : [file, p.edit, view];
  if (p.chat) menus.push(p.chat);
  return menus;
}

/** What a Chats window's menus are made of, for its own menu bar and for a main window's Chats tab. */
interface SessionsMenuParts {
  /** Sends a UI event to the window. */
  send: (payload: UiEvent) => void;
  /** File → New Chat's items: a chat and a terminal in the shown session's project (the page takes their keys), then the project pickers. */
  newItems: Electron.MenuItemConstructorOptions[];
  /** File: from Attach Files… to Close All Conversations (a single chat's window: the ones about its chat). */
  fileItems: Electron.MenuItemConstructorOptions[];
  edit: Electron.MenuItemConstructorOptions;
  activityPane: Electron.MenuItemConstructorOptions;
  /** Show Task Runs and Waiting Chats First. */
  listItems: Electron.MenuItemConstructorOptions[];
  /** F8, F9 and Shift with them: the previous and next (waiting) chat. */
  navItems: Electron.MenuItemConstructorOptions[];
  /** F6 and Shift+F6. */
  paneItems: Electron.MenuItemConstructorOptions[];
  /** The Chat menu, while a chat shows. */
  chat?: Electron.MenuItemConstructorOptions;
}

function sessionsMenuParts(sv: SessionsView): SessionsMenuParts {
  const child = sv.w;
  const id = sv.shown;
  const kind = id ? engine?.sessionKind(id) : undefined;
  const chat = kind === 'chat' && id ? engine?.getChat(id) : undefined;
  const conversation = kind === 'chat' || kind === 'terminal';
  const harnessSession = id ? (engine?.harnessSessionId(id) ?? null) : null;
  const send = (payload: unknown) => {
    if (!child.isDestroyed()) child.webContents.send('ui:event', payload);
  };
  const showError = (err: unknown) =>
    void showMessageBox(child, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'], defaultId: 0, cancelId: 0 });
  const projects = engine?.listProjects() ?? [];
  const anySessions = openConversations().length > 0;
  const shownProjectId = id ? engine?.sessionsState().sessions.find((s) => s.id === id)?.projectId : undefined;
  const shownProject = shownProjectId ? projects.find((p) => p.id === shownProjectId) : undefined;
  const attachFiles = async () => {
    if (!id) return;
    const r = await showOpenDialog(child, { title: 'Attach Files', properties: ['openFile', 'multiSelections'] });
    if (r.canceled || r.filePaths.length === 0 || !engine) return;
    const added = engine.attachToChat(id, r.filePaths.map((p) => ({ name: path.basename(p), path: p })));
    send({ type: 'chat-attached', attachments: added });
  };
  /** A chat's history and live rows; a task run's agent conversation, as its run window reads it. */
  const conversationRows = async (): Promise<MessageRow[] | null> => {
    if (!id || !engine) return null;
    if (kind === 'chat') {
      const c = engine.getChat(id);
      return c ? [...c.history, ...c.rows] : null;
    }
    if (kind !== 'run') return null;
    const taskId = engine.sessionsState().sessions.find((s) => s.id === id)?.taskId;
    if (!taskId) return null;
    const result = await engine.readMessages(taskId, id, undefined, false);
    return result.status === 'ok' ? result.rows : [];
  };
  const saveMarkdown = async () => {
    const rows = await conversationRows();
    if (!rows || !id) return;
    if (rows.length === 0) {
      await showMessageBox(child, { type: 'error', title: 'Looper', message: 'There are no messages to save.', buttons: ['OK'], defaultId: 0, cancelId: 0 });
      return;
    }
    const title = sessionTitle(id);
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
  // The page handles Ctrl+T, Ctrl+Shift+T, Ctrl+W and Ctrl+F4, so in a terminal session Ctrl+T and Ctrl+W stay the agent's.
  const newItems = newChatItems(
    {
      project: shownProject ? { id: shownProject.id, name: menuText(shownProject.name) } : undefined,
      chat: (pid) => openProjectChat(pid),
      terminal: (pid) => void openTerminal(projectTaskId(pid)).catch(showError),
    },
    sessionNewMenus(child),
  );
  // A single chat's window has only the items about its chat.
  const fileItems = commandMenu(CHAT_COMMANDS, 'file', {
    attach: { enabled: !!chat && chat.status !== 'ended', click: () => void attachFiles().catch(showError) },
    saveMarkdown: { enabled: !!chat || kind === 'run', click: () => void saveMarkdown().catch(showError) },
    openInNewWindow: sv.single ? null : { enabled: kind === 'chat' || kind === 'run', click: () => id && openChatWindow(id) },
    openWorkFolder: { enabled: !!kind, click: openWorkingDirectory },
    sendToChats: sv.single ? null : { enabled: anySessions, click: () => openSendToSessionsWindow() },
    close: { enabled: conversation, click: () => id && void closeSessionAsk(id, child).catch(showError) },
    closeAll: sv.single ? null : { enabled: anySessions, click: () => void closeAllSessionsAsk(undefined, child).catch(showError) },
  });
  // The page handles these keys itself, so a terminal still gets Ctrl+C and the rest.
  // A phone has its own text editing menu, so the clipboard items stay off it.
  const edit: Electron.MenuItemConstructorOptions = {
    id: 'edit',
    label: '&Edit',
    submenu: [
      { role: 'undo', label: '&Undo', registerAccelerator: false, platforms: NOT_MOBILE },
      { role: 'redo', label: '&Redo', registerAccelerator: false, platforms: NOT_MOBILE },
      { type: 'separator' },
      { role: 'cut', label: 'Cu&t', registerAccelerator: false, platforms: NOT_MOBILE },
      { role: 'copy', label: '&Copy', registerAccelerator: false, platforms: NOT_MOBILE },
      { role: 'paste', label: '&Paste', registerAccelerator: false, platforms: NOT_MOBILE },
      { role: 'selectAll', label: 'Select &All', registerAccelerator: false, platforms: NOT_MOBILE },
      { type: 'separator' },
      ...commandMenu(CHAT_COMMANDS, 'edit', { find: { enabled: !!chat, click: () => send({ type: 'chat-find' }) } }),
    ],
  };
  const nav = (dir: 1 | -1, waiting: boolean) => () => send({ type: 'sessions-nav', dir, waiting });
  const shown = engine?.settings.view.sessions ?? ViewSchema.parse({}).sessions;
  const setShown = (patch: Partial<Settings['view']['sessions']>) => updateView({ sessions: { ...shown, ...patch } });
  return {
    send,
    newItems,
    fileItems,
    edit,
    activityPane: { label: 'A&ctivity Pane', platforms: NOT_MOBILE, type: 'checkbox', checked: shown.activityPane, click: (item) => setShown({ activityPane: item.checked }) },
    listItems: [
      { label: 'Show Task &Runs', type: 'checkbox', checked: shown.showRuns, click: (item) => setShown({ showRuns: item.checked }) },
      { label: '&Waiting Chats First', type: 'checkbox', checked: shown.waitingFirst, click: (item) => setShown({ waitingFirst: item.checked }) },
    ],
    navItems: [
      { label: 'Pre&vious Waiting Chat', accelerator: 'F8', click: nav(-1, true) },
      { label: 'Next W&aiting Chat', accelerator: 'F9', click: nav(1, true) },
      { label: '&Previous Chat', accelerator: 'Shift+F8', click: nav(-1, false) },
      { label: '&Next Chat', accelerator: 'Shift+F9', click: nav(1, false) },
    ],
    // The page handles F6 too, so a terminal never gets it.
    paneItems: [
      { label: 'Next Pan&e', accelerator: 'F6', registerAccelerator: false, platforms: NOT_MOBILE, click: () => send({ type: 'sessions-pane', dir: 1 }) },
      { label: 'Previous Pane', accelerator: 'Shift+F6', registerAccelerator: false, platforms: NOT_MOBILE, click: () => send({ type: 'sessions-pane', dir: -1 }) },
    ],
    chat:
      chat && id
        ? chatMenu(
            chat,
            () => void engine?.stopChat(id).catch(showError),
            () => void engine?.sendNowChat(id).catch(showError),
            // The menu shows the chat's settings as they are once the change is through (or refused).
            (patch) => void engine?.configureChat(id, patch).catch(showError).finally(() => refreshSessionsMenu(sv, true)),
            (harnessId) => void engine?.setChatHarness(id, harnessId).catch(showError).finally(() => refreshSessionsMenu(sv, true)),
            harnessSession,
            () => void compactChat(id).catch(showError),
            () => void restartSessionAsk(id, child).catch(showError),
          )
        : undefined,
  };
}

/** File → New Chat and New Terminal: a submenu each of the projects, then another folder. */
function sessionNewMenus(child: AppWindow): Electron.MenuItemConstructorOptions[] {
  const projects = engine?.listProjects() ?? [];
  const sep: Electron.MenuItemConstructorOptions = { type: 'separator' };
  const showError = (err: unknown) =>
    void showMessageBox(child, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'], defaultId: 0, cancelId: 0 });
  const newIn = (kind: 'chat' | 'terminal', open: (projectId: string) => void): Electron.MenuItemConstructorOptions[] => [
    ...projects.map((p) => ({ label: menuText(p.name), click: () => open(p.id) })),
    ...(projects.length > 0 ? [sep] : []),
    { label: 'Other &Folder…', click: () => void openInFolder(kind, child).catch(showError) },
  ];
  return commandMenu(CHAT_COMMANDS, 'pickers', {
    newChatPicker: { submenu: newIn('chat', openProjectChat) },
    newTerminalPicker: { submenu: newIn('terminal', (pid) => void openTerminal(projectTaskId(pid)).catch(showError)) },
  });
}

/** What File's New items open, in every window that has them. */
const FILE_NEW_ACTIONS: FileNewActions = {
  newProject: () => openProjectEditor(),
  newTask: () => openEditorWindow(),
  newTaskFromTemplate: () => openTemplatePickerWindow(),
  newTaskWithAgent: () => openBuilderSetupWindow(),
  newFolder: () => openNewFolderWindow(),
};

/** The export options Save as Markdown last used in the Chats window. */
let sessionsExportOpts = { includeThinking: true, includeTools: true, plain: false };

const sendToSessionsWindows = new WindowSlots();

/**
 * Send to Chats: one message to the chats and terminal sessions picked there. Modeless, one per client;
 * opening it again brings it forward. `group` (sessionGroupKey): that list group's chats are the ones checked.
 */
function openSendToSessionsWindow(group?: string): void {
  const open = sendToSessionsWindows.get();
  if (open) {
    if (group !== undefined) open.webContents.send('ui:event', { type: 'send-to-sessions-pick', group } satisfies UiEvent);
    open.focus();
    return;
  }
  const hash = group === undefined ? 'send-to-sessions' : `send-to-sessions/${encodeURIComponent(group)}`;
  sendToSessionsWindows.set(openChildWindow(hash, 'Send to Chats', 620, 560, undefined, { contentSize: true, minWidth: 480, minHeight: 420 }));
}

// ---------- the History window ----------

/** A History window: the conversation it shows (its menus act on it), whether its Activity Pane shows (hidden each time it opens), and View → Folder. */
interface HistoryWindowView {
  w: AppWindow;
  selected: string | null;
  activity: boolean;
  folder: HistoryFolderFilter;
  /** What its menu was last built from. */
  menuKey: string;
}

/** One History window per client. */
const historyWindows = new WindowSlots();
const historyViews = new Map<AppWindow, HistoryWindowView>();

/** How long after its transcript last changed a conversation from outside Looper may still be open in another terminal. */
const STILL_OPEN_MS = 5 * 60_000;

/**
 * The History window: the conversations on this computer, Looper's and every
 * Claude Code and Codex one in the environments' folders, to read or continue.
 * Modeless; opening it again brings it forward.
 */
function openHistoryWindow(): void {
  const open = historyWindows.get();
  if (open) {
    bringForward(open);
    return;
  }
  const child = openChildWindow('history', 'History', 1388, 895, undefined, { minWidth: 970, minHeight: 500, contentSize: true });
  child.setMaximizable(true);
  historyWindows.set(child);
  const view: HistoryWindowView = { w: child, selected: null, activity: false, folder: '', menuKey: '' };
  historyViews.set(child, view);
  attachWindowMenu(child, historyTemplate(view));
  view.menuKey = historyMenuState(view);
  // The View menu follows the settings, and Continue what chats and terminals hold.
  const unsubscribe = engine!.on((e) => {
    if (e.type === 'settings' || e.type === 'sessions' || e.type === 'projects') refreshHistoryMenu(view);
  });
  child.on('closed', () => {
    unsubscribe();
    historyViews.delete(child);
  });
}

function historyMenuState(view: HistoryWindowView): string {
  return JSON.stringify([view.selected, view.selected ? engine?.historyCommands(view.selected) : null, view.activity, view.folder, engine?.settings.view.history, engine?.listProjects().map((p) => [p.id, p.name])]);
}

function refreshHistoryMenu(view: HistoryWindowView, force = false): void {
  if (view.w.isDestroyed()) return;
  const key = historyMenuState(view);
  if (key === view.menuKey && !force) return;
  view.menuKey = key;
  replaceWindowMenu(view.w, historyTemplate(view));
}

/** That History window shows this conversation now: its menus act on it. */
function historySelect(w: AppWindow | null, id: string | null): void {
  const view = w ? historyViews.get(w) : undefined;
  if (!view) return;
  view.selected = id;
  refreshHistoryMenu(view, true);
}

/** View → Activity Pane, and the toolbar's button: the pane shows or hides. */
function setHistoryActivity(view: HistoryWindowView, checked: boolean): void {
  view.activity = checked;
  if (!view.w.isDestroyed()) view.w.webContents.send('ui:event', { type: 'history-activity', checked } satisfies UiEvent);
  refreshHistoryMenu(view, true);
}

function historyToggleActivity(w: AppWindow | null): void {
  const view = w ? historyViews.get(w) : undefined;
  if (view) setHistoryActivity(view, !view.activity);
}

/**
 * Looper can't see a harness running in another terminal: a conversation
 * from outside it whose transcript changed lately may still be open there.
 * True to go on.
 */
async function stillOpenAsk(parent: AppWindow | null, changedAt: number): Promise<boolean> {
  const ago = Date.now() - changedAt;
  if (ago >= STILL_OPEN_MS) return true;
  const mins = Math.max(1, Math.round(ago / 60_000));
  const { response } = await showMessageBox(parent, {
    type: 'question',
    title: 'History',
    message: `This conversation changed ${mins} min ago and may still be open elsewhere. Continue anyway?`,
    buttons: ['Continue', 'Cancel'],
    noLink: true,
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

/**
 * A History window's command on a conversation: a run's goes through the
 * run's own Continue items, a conversation from outside Looper resumes in
 * its project. Rejects with the reason.
 */
async function historyRun(from: AppWindow | null, id: string, command: HistoryCommand): Promise<void> {
  if (!engine) return;
  const item = engine.historyItem(id);
  if (!item) throw new Error('This conversation is no longer in the list.');
  const can = engine.historyCommands(id);
  if (command === 'copy-id') {
    if (can.sessionId) writeClipboard(can.sessionId);
    return;
  }
  if (command === 'open-folder') {
    if (item.folder) await openHostPath(item.folder);
    return;
  }
  if (!can[command]) return;
  if (item.runId) {
    if (command === 'chat') return openChat(item.taskId, item.runId);
    if (command === 'terminal') return openTerminal(item.taskId, item.runId);
    return compactRun(item.taskId, item.runId);
  }
  // Compacting only reads the conversation.
  if (command === 'compact') {
    openSessionsWindow((await engine.compactHistory(id)).id);
    return;
  }
  const changedAt = can.outside ? await engine.historyChangedAt(id) : undefined;
  if (changedAt !== undefined && !(await stillOpenAsk(from, changedAt))) return;
  if (command === 'chat') {
    openSessionsWindow((await engine.continueHistoryInChat(id)).id);
    return;
  }
  const sessionId = await engine.continueHistoryInTerminal(id);
  if (sessionId) openSessionsWindow(sessionId);
}

/** A History window's commands on its conversation, as menu items: the File menu's and a row's right-click menu. */
function historyItems(from: AppWindow, id: string | null): Electron.MenuItemConstructorOptions[] {
  const can = id && engine ? engine.historyCommands(id) : NO_HISTORY_COMMANDS;
  const run = (command: HistoryCommand) => () => {
    if (!id) return;
    void historyRun(from, id, command).catch((err: unknown) => {
      void showMessageBox(from, { type: 'error', title: 'Looper', message: err instanceof Error ? err.message : String(err), buttons: ['OK'], defaultId: 0, cancelId: 0 });
    });
  };
  return [
    { id: 'history-chat', label: 'Continue in &Chat', glyph: 'chat', enabled: can.chat, click: run('chat') },
    { id: 'history-compact', label: 'Continue Co&mpacted', glyph: 'compact', enabled: can.compact, click: run('compact') },
    { id: 'history-terminal', label: 'Continue in &Terminal', glyph: 'terminal', enabled: can.terminal, click: run('terminal') },
    { type: 'separator' },
    { id: 'history-copy-id', label: 'Copy Session &ID', glyph: 'copy', enabled: !!can.sessionId, click: run('copy-id') },
    { id: 'history-folder', label: 'Open &Working Directory', glyph: 'folder', platforms: DESKTOP_ONLY, enabled: can.folder, click: run('open-folder') },
  ];
}

/** A conversation's right-click menu in the History window. */
function historyMenu(from: AppWindow | null, id: string): void {
  if (!from || !engine?.historyItem(id)) return;
  popupMenu(Menu.buildFromTemplate(historyItems(from, id)), { window: from });
}

/** The History window's menus: File (the commands on the shown conversation), Edit and View. */
function historyTemplate(view: HistoryWindowView): Electron.MenuItemConstructorOptions[] {
  const child = view.w;
  const send = (payload: UiEvent) => {
    if (!child.isDestroyed()) child.webContents.send('ui:event', payload);
  };
  const shown = engine?.settings.view.history ?? ViewSchema.parse({}).history;
  const setShown = (patch: Partial<Settings['view']['history']>) => updateView({ history: { ...shown, ...patch } });
  const sep: Electron.MenuItemConstructorOptions = { type: 'separator' };
  const pickFolder = (folder: HistoryFolderFilter): Electron.MenuItemConstructorOptions['click'] => () => {
    view.folder = folder;
    send({ type: 'history-folder', folder });
    refreshHistoryMenu(view, true);
  };
  const projectsList = engine?.listProjects() ?? [];
  const folderItems: Electron.MenuItemConstructorOptions[] = [
    { label: '&All Folders', type: 'radio', checked: view.folder === '', click: pickFolder('') },
    ...(projectsList.length ? [sep] : []),
    ...projectsList.map((p): Electron.MenuItemConstructorOptions => ({ label: menuText(p.name), type: 'radio', checked: view.folder === `project:${p.id}`, click: pickFolder(`project:${p.id}`) })),
    sep,
    { label: '&Outside Projects', type: 'radio', checked: view.folder === 'other', click: pickFolder('other') },
  ];
  const file: Electron.MenuItemConstructorOptions = {
    id: 'file',
    label: '&File',
    submenu: [
      ...historyItems(child, view.selected),
      sep,
      { label: 'Close &Window', platforms: NOT_MOBILE, accelerator: 'Alt+F4', registerAccelerator: false, click: () => child.close() },
    ],
  };
  const edit: Electron.MenuItemConstructorOptions = {
    id: 'edit',
    label: '&Edit',
    submenu: [
      { role: 'undo', label: '&Undo', platforms: NOT_MOBILE },
      { role: 'redo', label: '&Redo', platforms: NOT_MOBILE },
      sep,
      { role: 'cut', label: 'Cu&t', platforms: NOT_MOBILE },
      { role: 'copy', label: '&Copy', platforms: NOT_MOBILE },
      { role: 'paste', label: '&Paste', platforms: NOT_MOBILE },
      { role: 'selectAll', label: 'Select &All', platforms: NOT_MOBILE },
      sep,
      { id: 'history-find', label: '&Find…', accelerator: 'CmdOrCtrl+F', glyph: 'search', click: () => send({ type: 'history-find' }) },
    ],
  };
  const viewMenu: Electron.MenuItemConstructorOptions = {
    id: 'view',
    label: '&View',
    submenu: [
      { label: 'Group by &Date', type: 'radio', checked: shown.groupBy === 'date', click: () => setShown({ groupBy: 'date' }) },
      { label: 'Group by Fo&lder', type: 'radio', checked: shown.groupBy === 'folder', click: () => setShown({ groupBy: 'folder' }) },
      sep,
      { label: 'Fold&er', submenu: folderItems },
      { label: 'Show Task &Runs', type: 'checkbox', checked: shown.showRuns, click: (item) => setShown({ showRuns: item.checked }) },
      sep,
      { label: 'A&ctivity Pane', platforms: NOT_MOBILE, type: 'checkbox', checked: view.activity, click: (item) => setHistoryActivity(view, item.checked) },
      sep,
      { label: 'Re&fresh', accelerator: 'F5', click: () => send({ type: 'history-refresh' }) },
      sep,
      ...zoomMenuItems(),
    ],
  };
  return process.platform === 'darwin' ? [file, viewMenu] : [file, edit, viewMenu];
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
      destructiveId: 1,
      noLink: true,
    });
    if (r.response === 2) return false;
    if (r.response === 0) {
      try {
        await engine.saveBuilder(id);
      } catch (err) {
        await showMessageBox(parent, { type: 'error', title: child.getTitle(), message: (err as Error).message, buttons: ['OK'], defaultId: 0, cancelId: 0 });
        return false;
      }
    } else {
      try {
        await engine.discardBuilder(id);
      } catch (err) {
        await showMessageBox(parent, { type: 'error', title: child.getTitle(), message: (err as Error).message, buttons: ['OK'], defaultId: 0, cancelId: 0 });
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
  // It's a builder window now: it opens, and saves, where builder windows do.
  if (setupWindow instanceof BrowserWindow) placeAs(setupWindow, `builder/${state.id}`);
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
  const opts: MessageBoxOptions = { type: 'error', title: 'Looper', message, detail, buttons: ['OK'], defaultId: 0, cancelId: 0 };
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
    const opts: MessageBoxOptions = {
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

/** Send a UI command to a main window (its menus act on the selection there): `target`, or the caller's. */
function sendUi(target: AppWindow | null, type: string): void {
  const main = target ?? mainWin();
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
  boolean,
];
const NO_SELECTION: MenuSelection = [false, undefined, undefined, undefined, false, undefined, false, false, false];

/**
 * A window that shows the main window's views: the desktop's main window, a
 * browser tab's, or a view window (View → Dashboard, Projects, Tasks or an
 * addon's tab), which shows one of them. Its menu bar follows its selection
 * and the tab it shows.
 */
interface MainView {
  w: AppWindow;
  /** The tab it shows (shared/main-tabs); unset until its page says, and on a phone, whose menu bar has every menu. */
  tab?: string;
  /** A view window: its one tab, and no Tabs menu. */
  fixed: boolean;
  /** The selection its page last reported, so rebuilds for other reasons (rest events) keep the Task menu's state. */
  selection: MenuSelection;
}

const mainViews = new Map<AppWindow, MainView>();

function updateTaskMenu(
  from: AppWindow | null,
  hasTask: boolean,
  taskEnabled?: boolean,
  taskPaused?: boolean,
  taskState?: string,
  hasNote?: boolean,
  canRunNow?: boolean,
  taskCompleted?: boolean,
  allowComplete?: boolean,
  hasProject?: boolean,
  tab?: string,
): void {
  const view = from ? mainViews.get(from) : undefined;
  if (!view) return;
  view.selection = [hasTask, taskEnabled, taskPaused, taskState, hasNote ?? false, canRunNow, taskCompleted ?? false, allowComplete ?? false, hasProject ?? false];
  if (!view.fixed) view.tab = tab;
  buildMainMenu(view);
}

/** Every main window's menu bar again; on macOS with no main window, the global one. */
function rebuildMenu(): void {
  for (const view of [...mainViews.values()]) buildMainMenu(view);
  if (process.platform === 'darwin' && (!win || win.isDestroyed())) {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || !macWindowMenus.has(focused)) Menu.setApplicationMenu(desktopMenu(macTemplate(mainMenuTemplate({ w: null, fixed: false, selection: NO_SELECTION }))));
  }
}

/** Persist a View-menu option; the settings event carries it to the renderer. */
function updateView(patch: Partial<Settings['view']>): void {
  if (!engine) return;
  engine.updateSettings({ view: { ...engine.settings.view, ...patch } });
}

function buildMainMenu(view: MainView): void {
  if (view.w.isDestroyed()) return;
  const template = mainMenuTemplate(view);
  if (view.w !== win) {
    replaceWindowMenu(view.w, template);
    return;
  }
  if (process.platform === 'darwin') {
    // Don't stomp the menu of a focused run/subagent window; the
    // browser-window-focus handler restores the main menu on the next switch.
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || !macWindowMenus.has(focused)) Menu.setApplicationMenu(desktopMenu(macTemplate(template)));
  } else {
    setWindowMenu(win, Menu.buildFromTemplate(template));
  }
}

/** One window per view and client (View → Dashboard, Projects, Tasks, an addon's tab). */
const viewWindows = new WindowSlots();

/**
 * A window with one of the main window's views alone, its toolbar and status
 * bar, and the menus the main window has on that tab; opening it again brings
 * it forward. Chats is the Chats window.
 */
function openViewWindow(tab: string): void {
  if (tab === 'chats') {
    openSessionsWindow();
    return;
  }
  const open = viewWindows.get(tab);
  if (open) {
    bringForward(open);
    return;
  }
  const def = mainTabs(addons?.list() ?? []).find((t) => t.id === tab);
  if (!def) return;
  const child = openChildWindow(`view/${encodeURIComponent(tab)}`, def.label, 1388, 895, undefined, { minWidth: 900, minHeight: 500, contentSize: true });
  child.setMaximizable(true);
  viewWindows.set(child, tab);
  const view: MainView = { w: child, tab, fixed: true, selection: NO_SELECTION };
  mainViews.set(child, view);
  child.on('closed', () => mainViews.delete(child));
  attachWindowMenu(child, mainMenuTemplate(view));
}

/**
 * A double-click on a row: the task or project in a window of its own (its
 * view alone, with its part of the toolbar, its menus and a status bar), or
 * the chat in its own window, as Open in New Window opens it. Opening it
 * again brings it forward.
 */
function openItemWindow(kind: 'task' | 'project' | 'chat', id: string): void {
  if (kind === 'chat') {
    openChatWindow(id);
    return;
  }
  const key = `${kind}:${id}`;
  const open = viewWindows.get(key);
  if (open) {
    bringForward(open);
    return;
  }
  const name = kind === 'task' ? engine?.listTasks().find((t) => t.id === id)?.name : engine?.listProjects().find((p) => p.id === id)?.name;
  if (!name) return;
  const tab = kind === 'task' ? 'tasks' : 'projects';
  const child = openChildWindow(`item/${kind}/${encodeURIComponent(id)}`, name, 1100, 760, undefined, { minWidth: 700, minHeight: 460, contentSize: true });
  child.setMaximizable(true);
  viewWindows.set(child, key);
  const view: MainView = { w: child, tab, fixed: true, selection: NO_SELECTION };
  mainViews.set(child, view);
  child.on('closed', () => mainViews.delete(child));
  attachWindowMenu(child, mainMenuTemplate(view));
}

/** View's item that opens each tab in a window of its own. */
const VIEW_WINDOW_LABELS: Record<string, string> = { dashboard: '&Dashboard', projects: '&Projects', tasks: 'Tas&ks', chats: '&Chats' };

/**
 * A main window's menu bar, for its selection and the tab it shows. File,
 * View, Tools, Advanced and Help are always there; Task on the Dashboard and
 * Tasks tabs, Project on those and the Projects tab, and Edit and Chat on the
 * Chats tab, which also adds the Chats window's File and View items. A phone's
 * main window (no tab) has every menu but the Chats tab's.
 */
function mainMenuTemplate({ w, tab, fixed, selection }: Omit<MainView, 'w'> & { w: AppWindow | null }): Electron.MenuItemConstructorOptions[] {
  const [hasTask, taskEnabled, taskPaused, taskState, hasNote, canRunNow, taskCompleted, allowComplete, hasProject] = selection;
  const ui = (type: string) => () => sendUi(w, type);
  const active = taskState === 'running' || taskState === 'checking' || taskState === 'classifying';
  // The renderer knows the task's run cap; a task with room under it can still Run Now while active.
  const runNow = canRunNow ?? !active;
  const view: Settings['view'] = engine?.settings.view ?? ViewSchema.parse({});
  const addonList = addons?.list() ?? [];
  const addonPanes = addons ? addonPanesMenu(addonList, view, updateView) : [];
  const tools = addons ? addonToolsMenu(addonDeps(), addonList) : [];
  const addonToolbars = addons ? addonToolbarsMenu(addonList, view, updateView) : [];
  const every = tab === undefined;
  const taskMenus = every || tab === 'dashboard' || tab === 'tasks';
  const projectMenu = taskMenus || tab === 'projects';
  const sv = tab === 'chats' && w ? tabSessionsView(w) : undefined;
  const chats = sv ? sessionsMenuParts(sv) : undefined;
  const sep: Electron.MenuItemConstructorOptions = { type: 'separator' };
  // On the Chats tab a terminal session needs these keys (Ctrl+N is the shell's), so the menu doesn't take them.
  const key = (accelerator: string) => (tab === 'chats' ? {} : { accelerator });
  // What the Runs tabs and Recent runs list: every run, unless these leave some out.
  const setRunFilter = (patch: Partial<Settings['view']['runFilter']>) => updateView({ runFilter: { ...view.runFilter, ...patch } });
  const hideNoAction: Electron.MenuItemConstructorOptions = {
    id: 'view-task-runs',
    label: 'Task &Runs',
    submenu: [
      { label: 'Show &Skipped Runs', type: 'checkbox', checked: !view.runFilter.hideSkipped, click: (item) => setRunFilter({ hideSkipped: !item.checked }) },
      { label: 'Show Runs with &No Action', type: 'checkbox', checked: !view.runFilter.hideNoAction, click: (item) => setRunFilter({ hideNoAction: !item.checked }) },
    ],
  };
  const tabs = view.tabs;
  const setTabs = (patch: Partial<Settings['view']['tabs']>) => updateView({ tabs: { ...tabs, ...patch } });
  const tabsMenu: Electron.MenuItemConstructorOptions = {
    id: 'view-tabs',
    label: 'Ta&bs',
    submenu: [
      { label: '&Top', type: 'radio', checked: tabs.position === 'top', click: () => setTabs({ position: 'top' }) },
      { label: '&Left', type: 'radio', checked: tabs.position === 'left', click: () => setTabs({ position: 'left' }) },
      { label: '&Bottom', type: 'radio', checked: tabs.position === 'bottom', click: () => setTabs({ position: 'bottom' }) },
      sep,
      tabs.position === 'left'
        ? { label: 'Show &Labels', type: 'checkbox', checked: tabs.labels, click: (item) => setTabs({ labels: item.checked }) }
        : { label: 'Show &Icons', type: 'checkbox', checked: tabs.icons, click: (item) => setTabs({ icons: item.checked }) },
    ],
  };
  // What the shown tab adds to View.
  const tabItems: Electron.MenuItemConstructorOptions[] =
    tab === 'dashboard'
      ? [hideNoAction]
      : tab === 'projects'
        ? [groupProjectsByMenu(view, updateView)]
        : tab === 'tasks'
          ? [...paneVisibilityItems(view, updateView, addonPanes), sep, { label: 'Task &List Options', submenu: taskListMenu(view, updateView) }, hideNoAction]
          : chats
            ? [chats.activityPane, sep, ...chats.listItems, sep, ...chats.navItems, sep, ...chats.paneItems]
            : [];
  const viewMenu: Electron.MenuItemConstructorOptions[] = every
    ? [
        { id: 'view-dashboard', label: '&Dashboard', glyph: 'dashboard', click: ui('show-dashboard') },
        { id: 'view-chats', label: '&Chats', glyph: 'chat', click: () => openSessionsWindow() },
        { id: 'view-history', label: '&History', glyph: 'history', platforms: NOT_MOBILE, click: () => openHistoryWindow() },
        sep,
        ...paneVisibilityItems(view, updateView, addonPanes),
        groupProjectsByMenu(view, updateView),
        sep,
        { label: 'Task &List Options', submenu: taskListMenu(view, updateView) },
        hideNoAction,
      ]
    : [
        ...mainTabs(addonList).map((t) => ({
          id: `view-${t.id}`,
          label: VIEW_WINDOW_LABELS[t.id] ?? menuText(t.label),
          glyph: t.icon,
          platforms: NOT_MOBILE,
          click: () => openViewWindow(t.id),
        })),
        { id: 'view-history', label: '&History', glyph: 'history', platforms: NOT_MOBILE, click: () => openHistoryWindow() },
        ...(fixed ? [] : [sep, tabsMenu]),
        ...(tabItems.length ? [sep, ...tabItems] : []),
      ];
  const head: Electron.MenuItemConstructorOptions[] = [
    {
      id: 'file',
      label: '&File',
      submenu: [
        // The phone's main window has no New Chat: its tabs have New Chat and New Terminal.
        ...fileNewItems(FILE_NEW_ACTIONS, every || !w ? null : (chats?.newItems ?? sessionNewMenus(w)), tab === 'chats'),
        sep,
        { id: 'import-task', label: '&Import Task…', click: () => void importTask() },
        ...(taskMenus ? commandMenu(TASK_COMMANDS, 'file', { export: { enabled: hasTask, click: ui('export-task') } }) : []),
        ...(chats ? [sep, ...chats.fileItems] : []),
        sep,
        { id: 'templates', label: 'Temp&lates', click: () => openTemplatesWindow() },
        { id: 'settings', label: 'S&ettings', ...key('CmdOrCtrl+,'), glyph: 'settings', click: () => openSettingsWindow() },
        // A view window closes like the Chats window; macOS: Quit lives in the app menu that macTemplate prepends.
        ...(fixed
          ? ([sep, { label: 'Close &Window', accelerator: 'Alt+F4', registerAccelerator: false, click: () => w?.close() }] as Electron.MenuItemConstructorOptions[])
          : process.platform === 'darwin'
            ? []
            : ([sep, { role: 'quit', label: 'E&xit' }] as Electron.MenuItemConstructorOptions[])),
      ],
    },
    ...(chats && process.platform !== 'darwin' ? [chats.edit] : []),
    ...(taskMenus
      ? [
          {
            id: 'task',
            label: '&Task',
            submenu: commandMenu(TASK_COMMANDS, 'task', {
              runNow: { enabled: hasTask && runNow, click: ui('run-now') },
              stop: { enabled: hasTask && active, click: ui('stop-task') },
              pauseResume: { alt: taskPaused, enabled: hasTask && taskState !== 'disabled' && !taskCompleted, click: ui('pause-resume') },
              enableDisable: { alt: taskEnabled === false, enabled: hasTask && !taskCompleted, click: ui('enable-disable') },
              complete: { alt: taskCompleted, enabled: hasTask && (taskCompleted || allowComplete), click: ui('complete-reopen') },
              edit: { enabled: hasTask, click: ui('edit-task') },
              editAgent: { enabled: hasTask, click: ui('edit-with-agent') },
              versions: { enabled: hasTask, click: ui('version-history') },
              delete: { enabled: hasTask, click: ui('delete-task') },
              note: { alt: hasNote, enabled: hasTask, click: ui('edit-note') },
              noteClear: { enabled: hasTask && hasNote, click: ui('clear-note') },
              moveFolder: { enabled: hasTask, click: ui('move-to-folder') },
              clearRuns: { enabled: hasTask && !active, click: ui('clear-runs') },
              workFolder: { enabled: hasTask, click: ui('open-work-folder') },
            }),
          } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    ...(projectMenu
      ? [
          {
            // The selected project, or the selected task's.
            id: 'project',
            label: '&Project',
            submenu: projectMenuItems(
              (command) => sendUi(w, PROJECT_UI_ACTIONS[command]),
              Object.fromEntries(
                PROJECT_COMMAND_NAMES.map((c) => [
                  c,
                  {
                    enabled: hasProject,
                    ...(c === 'new-chat' ? { accelerator: SHORTCUTS.newChat } : c === 'new-terminal' ? { accelerator: SHORTCUTS.newTerminal } : {}),
                  },
                ]),
              ),
            ),
          } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    ...(chats?.chat ? [chats.chat] : []),
    {
      id: 'view',
      label: '&View',
      submenu: [
        ...viewMenu,
        sep,
        { label: '&Toolbar', platforms: NOT_MOBILE, type: 'checkbox', checked: view.toolbar, click: (item) => updateView({ toolbar: item.checked }) },
        // The phone shows the addons' main-toolbar buttons on its Tasks tab, so their toggles stay.
        ...addonToolbars,
        { label: every ? 'Status &Bar' : 'Status Ba&r', platforms: NOT_MOBILE, type: 'checkbox', checked: view.statusBar, click: (item) => updateView({ statusBar: item.checked }) },
        sep,
        ...zoomMenuItems(),
      ],
    },
  ];
  const template: Electron.MenuItemConstructorOptions[] = [
    ...head,
    {
      id: 'tools',
      label: 'T&ools',
      submenu: [
        { id: 'recycle-bin', label: 'Recycle &Bin', glyph: 'delete', click: () => openRecycleBinWindow() },
        ...(tools.length ? [{ type: 'separator' } as Electron.MenuItemConstructorOptions, ...tools] : []),
      ],
    },
    {
      id: 'advanced',
      label: '&Advanced',
      submenu: [
        {
          id: 'remote-access',
          label: 'Remote Acc&ess',
          submenu: [
            {
              id: 'remote-access-toggle',
              label: remoteAccessOn() ? 'Turn &Off Remote Access' : 'Turn &On Remote Access',
              glyph: 'power',
              click: () => void toggleRemoteAccess(),
            },
            { id: 'remote-access-setup', label: 'Set &Up…', click: () => openRemoteAccessSetupWindow() },
            { type: 'separator' },
            { id: 'pair-device', label: '&Pair Device…', glyph: 'add', enabled: remoteAccessPhase === 'running', click: () => openRemoteAccessPairWindow() },
            { id: 'paired-devices', label: 'Paired &Devices', click: () => openRemoteAccessDevicesWindow() },
            ...tailscaleMenuItems(),
            { type: 'separator' },
            { id: 'remote-access-settings', label: 'S&ettings', glyph: 'settings', click: () => openRemoteAccessSettingsWindow() },
          ],
        },
        {
          id: 'remote-control',
          label: 'Remote &Control',
          submenu: [
            {
              label: engine?.settings.remote.enabled ? 'Turn &Off Remote Control' : 'Turn &On Remote Control',
              glyph: 'power',
              click: () => void toggleRemote(),
            },
            { type: 'separator' },
            { label: '&Conversations', click: () => openRemoteConversationsWindow() },
            { label: '&Helpers', click: () => openRemoteHelpersWindow() },
          ],
        },
        { id: 'addons', label: '&Addons', click: () => openAddonsWindow() },
        { type: 'separator' },
        ...restMenuItems(),
        { label: 'Prevent &Sleep', submenu: preventSleepMenu() },
        { type: 'separator' },
        { label: 'Update &Models…', glyph: 'refresh', click: () => openModelUpdateWindow() },
        { label: 'Engine &Log', click: () => openEngineLogWindow() },
        {
          label: 'Open &Data Directory',
          platforms: DESKTOP_ONLY,
          click: () => {
            if (engine) void openPath(engine.dataDir);
          },
        },
        // A phone reloads Looper's pages by itself when they lose their connection.
        { role: 'reload', label: '&Reload UI', platforms: NOT_MOBILE, ...(tab === 'chats' ? { registerAccelerator: false } : {}) },
      ],
    },
    {
      id: 'help',
      label: '&Help',
      submenu: [
        { id: 'instructions', label: '&Instructions', ...key('F1'), click: () => openInstructionsWindow() },
        { type: 'separator' },
        { id: 'about', label: '&About Looper', click: () => openAboutWindow() },
      ],
    },
  ];
  return template;
}
