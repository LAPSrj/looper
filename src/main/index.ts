import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createEngine, type CommandPlace, type Engine } from '../engine/engine';
import { describeHolder, EngineLock, liveHolder, TAKEOVER_WAIT_MS, type LockHolder } from '../engine/lock';
import { readWakeTimerPolicy, SystemAwake } from '../engine/power-win';
import type { PowerAdapter } from '../engine/rest';
import type { EngineEvent, PreventSleepTimer } from '../shared/types';
import type { BuilderSetup } from '../shared/builder';
import { projectTaskId } from '../shared/projects';
import { sessionGroupKey, watchedSessions } from '../shared/sessions';
import type { UiEvent } from '../shared/api';
import { chatIsEmpty } from '../shared/chat';
import { loginRowKey, loginRows, type ClaudeLogin, type LoginRow } from '../shared/logins';
import { startsWithRemoteControl } from '../shared/environments';
import { convertWslPath, defaultDataDir } from '../engine/host';
import { readJson } from '../engine/store/fsutil';
import { FILE_KINDS, isAddonFileName, isLooperFileName, readLooperFile } from '../shared/files';
import { messagesToMarkdown } from '../shared/messages-md';
import type { MessageRow } from '../shared/messages';
import { adjustImportedTaskPaths } from './import-paths';
import { AddonHost } from './addon-host';
import { addonRequestHandler, ProjectActivity } from './addon-requests';
import { openAgentSettingsWindow, registerAgentSettingsIpc } from './agent-settings';
import { closeRequestedWindows, installAddonFile, openRequestedWindow, registerAddonIpc, sendAddonEvent, type AddonUiDeps } from './addons';
import { broadcastEvent, registerIpc } from './ipc';
import {
  callerMainWindow,
  caller,
  isMenuLevelWindow,
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
  useMenuPopupPage,
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
import { SOURCE_NAMES, type RemoteAccessPhase, type RemoteAccessProviderId, type RemoteAccessState, type WindowRole } from '../shared/remote-access';
import { addonTabId, mainTabs } from '../shared/main-tabs';
import { PANES_TAB } from '../shared/addons';
import { macMenuBar, openWindowItems } from './window-menu';
import { specTemplate } from './command-menu';
import { CHAT_WINDOW_VIEWS, CHATS_WINDOW_VIEWS, ENGINE_LOG_VIEWS, HISTORY_VIEWS, RUN_VIEWS, mainWindowViews, menuBar } from '../shared/commands/build';
import type { CommandView } from '../shared/commands/command';
import { EMPTY_CONTEXT, type CommandContext, type HostCommand } from '../shared/commands/context';
import type { MenuItemSpec } from '../shared/remote-access';
import { hideOffPlatform } from './platform/menus';
import { mainSpan, startStallWatch } from './main-stalls';
import { startMemoryTrim } from './memory-trim';
import { isWebLink } from '../shared/links';
import { NO_HISTORY_COMMANDS, RECENT_CHATS, recentChatLabel, type HistoryCommand } from '../shared/history';

/** How long after the first window the addons Looper comes with are installed or updated (as the engine's deferred start work waits). */
const BUNDLED_ADDONS_DELAY_MS = 2000;

/** When this bundle had loaded, from the process's start: what's before it is Electron's own start. */
const codeLoadedAt = performance.now();

// The network service runs in this process instead of a process of its own, which took 7-11 MB.
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
// Every window's page in one renderer process: a window opens 150-340 ms sooner and costs about 5 MB instead of 35,
// at the price of the windows sharing one main thread.
app.commandLine.appendSwitch('process-per-site');
let win: BrowserWindow | null = null;
let engine: Engine | null = null;
let addons: AddonHost | null = null;
let tray: Tray | null = null;
let quitting = false;
let startAgainQueued = false;
/** Whether Remote Control was on at its last event: the menus change only when this does. */
let remoteRunning = false;
/** The Prevent Sleep timer at its last event: the menus change only when this does. */
let preventSleepTimer: PreventSleepTimer = 'off';
let remoteAccess: RemoteAccess | null = null;
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
    // Shutting down: a window opened now would close with this process, so the new start runs once it has ended.
    if (quitting) {
      if (!startAgainQueued) app.relaunch({ args: argv.slice(1) });
      startAgainQueued = true;
      return;
    }
    showWindow();
    // A double-clicked/“Open with” Looper document lands in the second
    // instance's argv while this instance holds the single-instance lock.
    const file = looperFileFromArgv(argv);
    if (file) void openLooperFile(file);
  });

  app.whenReady().then(async () => {
    // When each step of starting ended, from the process's start, for perf.log once the main window has loaded.
    const startup: string[] = [];
    const mark = (step: string) => startup.push(`${step} ${Math.round(performance.now())} ms`);
    startup.push(`code loaded ${Math.round(codeLoadedAt)} ms`);
    mark('ready');
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
      ...(systemAwake ? { power: createPowerAdapter(systemAwake) } : {}),
      keepAwake: createKeepAwake(),
      showChat,
    });
    engine.start();
    if (systemAwake) {
      powerMonitor.on('resume', () => systemAwake.reapply());
      powerMonitor.on('on-ac', () => systemAwake.reapply());
      powerMonitor.on('on-battery', () => systemAwake.reapply());
    }
    mark('engine');
    useWindowPlaces(path.join(dataDir, 'windows.json'));
    useMenuPopupPage({ preload: webPreferences().preload!, load: (w, hash) => loadRenderer(w, hash) });
    // Which projects an agent is working in, for the addons' `activity` notifications.
    const projectActivity = new ProjectActivity(engine.sessionsState().sessions);
    engine.on((event) => {
      if (event.type === 'notify') showTaskNotification(event);
      else if (event.type === 'logins') showLoginNotifications(event.logins);
      else if (event.type === 'projects') {
        tray?.setContextMenu(trayMenu());
        addons?.notify({ method: 'projectsChanged', params: {} });
      }
      else if (event.type === 'sessions') {
        // Task runs in the Chats window aren't pushed: their own notifications cover them.
        void remoteAccess?.sessionsChanged(event.state.sessions.filter((s) => s.kind !== 'run'), !!engine?.settings.notificationsEnabled);
        for (const change of projectActivity.update(event.state.sessions)) addons?.notify({ method: 'activity', params: change });
      }
      else if (event.type === 'settings') {
        applyRemoteAccess();
        tray?.setContextMenu(trayMenu());
      }
      else if (event.type === 'rest') {
        if (event.disarmReason === 'user-wake') showRestDisarmNotification();
        tray?.setContextMenu(trayMenu());
      } else if (event.type === 'prevent-sleep' && event.state.timer !== preventSleepTimer) {
        // The Prevent Sleep choice and the Rest Mode item follow the timer.
        preventSleepTimer = event.state.timer;
        tray?.setContextMenu(trayMenu());
      } else if (event.type === 'remote' && event.state.running !== remoteRunning) {
        // Turn On/Off Remote Control and the Rest Mode item follow it.
        remoteRunning = event.state.running;
        tray?.setContextMenu(trayMenu());
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
      openWindows: (dialog) => {
        const over = dialog instanceof BrowserWindow ? dialog.getParentWindow() : null;
        return { windows: openWindowsInOrder().map((w) => ({ id: w.id, title: w.getTitle() })), current: over?.id ?? null };
      },
      showOpenWindow: (id, dialog) => {
        const w = BrowserWindow.fromId(id);
        if (!w || w.isDestroyed() || !listedWindows().includes(w)) return;
        // After the dialog is gone: closing a modal dialog gives its owner the focus back.
        if (dialog && !dialog.isDestroyed()) {
          dialog.once('closed', () => !w.isDestroyed() && bringForward(w));
          dialog.close();
        } else bringForward(w);
      },
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
      terminalWindow: (id) => [...terminalWindows.all(id), ...loginWindows.all(id), ...sessionWindowsShowing(id)],
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
      historyRun,
      historyMenu,
      showHistoryMenu,
      recentChatItems,
      openSessions: (select) => (select ? showChat(select) : openSessionsWindow()),
      openChatWindow,
      openRenameSession: openRenameSessionWindow,
      openItemWindow,
      openProjectFolderName: openProjectFolderNameWindow,
      openRemoteConversation,
      openRemoteHelperEditor,
      remoteAccess: () => remoteAccess,
      openRemoteAccessPair: openRemoteAccessPairWindow,
      openRemoteAccessRename: openRemoteAccessRenameWindow,
      finishRemoteAccessSetup,
      openNotification,
      logIn: openLogIn,
      openProjectEditor,
      openNewTaskIn,
      openInFolder,
      takeImportDraft,
      openLooperFile,
      showTaskInMain: (taskId, view) => openTaskView(taskId, '', view),
      setCommandMenu,
      runHostCommand,
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
      mainViews.set(w, { fixed: false });
      w.on('closed', () => mainViews.delete(w));
      attachWindowMenu(w, firstTemplate(w, mainWindowViews(), { here: 'web' }));
      reopenRescuedBuilders(w);
    });
    applyRemoteAccess();
    mark('remote access');
    // What an addon asks Looper for (ADDON_REQUESTS).
    const addonRequest = addonRequestHandler({
      host: eng.host,
      settings: () => eng.settings,
      projects: () => eng.listProjects(),
      saveProject: (input) => eng.saveProject(input),
      sessions: () => eng.sessionsState().sessions,
      openTerminal: openCommandTerminal,
      openWindow: (addonId, p) => openRequestedWindow(addonDeps(), addonId, p),
    });
    addons = new AddonHost({
      dir: path.join(engine.dataDir, 'addons'),
      host: engine.host,
      appVersion: app.getVersion(),
      log: engine.log,
      onChange: (list) => {
        sendAddonEvent({ type: 'addons', addons: list });
      },
      onRefresh: (addonId, only) => sendAddonEvent({ type: 'refresh', addonId, ...(only ? { only } : {}) }),
      disabled: () => engine?.settings.disabledAddons ?? [],
      setDisabled: (ids) => engine?.updateSettings({ disabledAddons: ids }),
      runs: () => engine?.settings.addonRuns ?? {},
      setRuns: (runs) => engine?.updateSettings({ addonRuns: runs }),
      environments: () => ({
        environments: engine?.settings.environments ?? [],
        defaultEnvironmentId: engine?.settings.defaultEnvironmentId ?? '',
      }),
      request: (addonId, method, params) => addonRequest(method, params, addonId),
      onStopped: closeRequestedWindows,
      // The packages Looper comes with: out/addons, inside app.asar once packaged.
      bundledDir: path.join(__dirname, '..', 'addons'),
      removedBundled: () => engine?.settings.removedBundledAddons ?? [],
      setRemovedBundled: (ids) => engine?.updateSettings({ removedBundledAddons: ids }),
    });
    registerAddonIpc(addonDeps());
    registerAgentSettingsIpc({ engine, openWindow: openChildWindow, mainWindow: mainWin });
    // Read before the first window, so it shows the addons' tabs and panes at once.
    await addons.start();
    mark('addons');
    // macOS keeps one global menu bar; elsewhere each window carries its own.
    if (process.platform === 'darwin') rebuildMenu();
    else Menu.setApplicationMenu(null);
    createTray();
    mark('tray');
    if (!startHidden) {
      createWindow();
      mark('window');
      win?.webContents.once('did-finish-load', () => {
        mark('page loaded');
        engine?.logPerf(`desktop | startup: ${startup.join(', ')}`);
      });
    }
    // The addons Looper comes with: reading and unpacking them waits until the first window is up.
    setTimeout(() => void addons?.installBundled(), BUNDLED_ADDONS_DELAY_MS);
    startMemoryTrim((ms) => engine?.logPerf(`desktop | memory handed back while no window had the focus, ${ms} ms`));
    startStallWatch((line) => engine?.logPerf(`desktop | ${line}`));
    // Launched by double-clicking a Looper document (file association).
    const fileArg = looperFileFromArgv(process.argv);
    if (fileArg) {
      if (!win) createWindow();
      void openLooperFile(fileArg);
    }
    app.on('activate', () => {
      if (!quitting && BrowserWindow.getAllWindows().length === 0) createWindow();
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

  app.on('browser-window-created', (_e, w) => {
    openedAt.set(w, ++windowsOpened);
    w.on('show', refreshOpenWindowLists);
    w.on('hide', refreshOpenWindowLists);
    w.on('closed', refreshOpenWindowLists);
    w.on('page-title-updated', () => setImmediate(refreshOpenWindowLists));
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
      hideForQuit();
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

/**
 * Once a quit is confirmed: every window and the tray icon go at once, so the
 * quit looks done while the engine stops its runs behind them.
 */
function hideForQuit(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.hide();
  tray?.destroy();
  tray = null;
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

/** Windows' keep-awake hold, shared by Prevent Sleep and Rest Mode. */
const systemAwake = process.platform === 'win32' ? new SystemAwake((message) => engine?.log.error(message)) : null;

/** Electron power hooks handed to the engine's Rest Mode controller. */
function createPowerAdapter(awake: SystemAwake): PowerAdapter {
  return {
    startBlocker: () => awake.hold('rest', true),
    stopBlocker: () => awake.hold('rest', false),
    onSuspend: (cb) => void powerMonitor.on('suspend', cb),
    onResume: (cb) => void powerMonitor.on('resume', cb),
    isOnBattery: () => powerMonitor.isOnBatteryPower(),
  };
}

/** Prevent Sleep's blocker, apart from Rest Mode's. */
function createKeepAwake(): (on: boolean) => void {
  if (systemAwake) return (on) => systemAwake.hold('prevent-sleep', on);
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

/** The login rows already notified (loginRowKey): each login notifies once a stage, for the whole app instead of once a task. */
const notifiedLogins = new Set<string>();

function showLoginNotifications(logins: ClaudeLogin[]): void {
  for (const row of loginRows(logins)) {
    const key = loginRowKey(row);
    if (notifiedLogins.has(key)) continue;
    notifiedLogins.add(key);
    showLoginNotification(row);
  }
}

/** A login that needs the user, on the desktop and the devices; the toast's click opens Log In. */
function showLoginNotification(row: LoginRow): void {
  if (!engine?.settings.notificationsEnabled) return;
  const n = { title: row.login.name, body: row.problem };
  notifyClients(n);
  if (BrowserWindow.getFocusedWindow()) return;
  void remoteAccess?.pushToast(n);
  if (!Notification.isSupported()) return;
  const toast = new Notification({ ...n, icon: appIcon });
  liveToasts.add(toast);
  if (liveToasts.size > MAX_LIVE_TOASTS) liveToasts.delete(liveToasts.values().next().value!);
  toast.on('click', () => {
    liveToasts.delete(toast);
    try {
      openLogIn(row.login.environmentId, row.login.harnessIds[0]);
    } catch (err) {
      void showMessageBox(undefined, { type: 'error', title: 'Looper', message: (err as Error).message, buttons: ['OK'], defaultId: 0, cancelId: 0 });
    }
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
    // The preload needs only Electron's contextBridge, ipcRenderer and webUtils; without the sandbox every window started Node for it.
    sandbox: true,
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

function macTemplate(template: Electron.MenuItemConstructorOptions[]): Electron.MenuItemConstructorOptions[] {
  return macMenuBar(template, { about: () => openAboutWindow(), settings: () => openSettingsWindow() });
}

/** The computer's windows a Window menu lists: not the hidden ones, or a modal one, which can't be switched away from anyway. */
const listedWindows = (): BrowserWindow[] =>
  BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible() && !w.isModal() && !isMenuLevelWindow(w));

/** The order the windows opened in, which the Window menu lists them in. */
const openedAt = new WeakMap<BrowserWindow, number>();
let windowsOpened = 0;

/** The listed windows in the order they opened. */
const openWindowsInOrder = (): BrowserWindow[] => listedWindows().sort((a, b) => (openedAt.get(a) ?? 0) - (openedAt.get(b) ?? 0));

const openWindowList = (): Electron.MenuItemConstructorOptions[] =>
  openWindowItems(openWindowsInOrder(), bringForward, (from) => openSelectWindowDialog(from instanceof BrowserWindow ? from : null));

/** Window → More Windows…: every open window to pick from, modal over the window whose menu it was. */
function openSelectWindowDialog(from: BrowserWindow | null): void {
  openChildWindow('select-window', 'Select Window', 360, 300, from, { role: 'prompt', minWidth: 300, minHeight: 240, resizable: false, contentSize: true });
}

let listedWindowsKey = '';

/** Rebuild the menu bars that list the open windows, when the list changed. macOS lists them itself. */
function refreshOpenWindowLists(): void {
  if (process.platform === 'darwin') return;
  const key = listedWindows().map((w) => `${w.id}:${w.getTitle()}`).join('\n');
  if (key === listedWindowsKey) return;
  listedWindowsKey = key;
  rebuildMenu();
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
    { role: 'workspace', desktop: true },
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
  mainViews.set(main, { fixed: false });
  win.on('closed', () => {
    mainViews.delete(main);
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // A renderer crash must never take the engine down: just reload the UI.
  win.webContents.on('render-process-gone', (_e, details) => {
    engine?.log.error(`renderer gone (${details.reason}); reloading`);
    if (win && !win.isDestroyed()) win.webContents.reload();
  });
  // The page starts loading first: building the menu takes a while on a slow computer.
  loadRenderer(win);
  // The window may be the first ever (tray start): give it a menu right away;
  // its page sends the full one once it knows the state.
  drawTemplate(main, firstTemplate(main, mainWindowViews()));
}

function openChildWindow(
  hash: string,
  title: string,
  width: number,
  height: number,
  modalParent: AppWindow | null | undefined,
  /** role: how a phone or tablet shows it. contentSize: width/height (and the minimums) size the page, not the frame around it. desktop: on the computer, whoever asks. */
  opts: { role: WindowRole; minWidth?: number; minHeight?: number; resizable?: boolean; contentSize?: boolean; desktop?: boolean },
): AppWindow {
  const parent = modalParent && !modalParent.isDestroyed() ? modalParent : undefined;
  const child = newWindow(
    {
      width,
      height,
      useContentSize: opts.contentSize ?? false,
      minWidth: opts.minWidth ?? 520,
      minHeight: opts.minHeight ?? 420,
      title,
      icon: windowIcon,
      backgroundColor: windowBackground(),
      maximizable: false,
      resizable: opts.resizable ?? true,
      webPreferences: webPreferences(),
      ...(parent ? { parent, modal: true, minimizable: false } : {}),
    },
    hash,
    opts.desktop ? { role: opts.role, desktop: true } : { role: opts.role },
  );
  // Detach the app menu entirely; hiding it would leave Alt able to summon it.
  child.removeMenu();
  // Links (e.g. in rendered markdown) open in the system browser, never a new app window.
  child.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebLink(url)) void shell.openExternal(url);
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
    const child = openChildWindow(hash, 'Export Options', 360, 260, parent, { role: 'prompt', minWidth: 320, minHeight: 220, resizable: false });
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
      role: 'tool',
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
    // A subagent's window is a conversation of its own; a run's is a look at one row of the task's runs.
    { role: agentId ? 'workspace' : 'detail' },
  );
  attachWindowMenu(child, firstTemplate(child, RUN_VIEWS));
  child.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRenderer(child, hash);
}

function openImageWindow(taskId: string, runId: string, rowId: string, agentId?: string, label?: string, siblings?: string[]): void {
  const name = label?.trim() ? label.trim().slice(0, 80) : `${runId} row ${rowId}`;
  const hash =
    `image/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}/${agentId ? encodeURIComponent(agentId) : '-'}` +
    `/${encodeURIComponent(rowId)}/${encodeURIComponent(`Image – ${name}`)}` +
    (siblings ? `/${encodeURIComponent(JSON.stringify(siblings))}` : '');
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
    { role: 'workspace' },
  );
  child.removeMenu();
  child.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebLink(url)) void shell.openExternal(url);
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
    undefined,
    { role: 'editor' },
  );
}


function openNoteEditorWindow(taskId: string): void {
  openChildWindow(
    `note-editor/${encodeURIComponent(taskId)}`,
    'Guidance for Next Run',
    520,
    400,
    undefined,
    { role: 'tool', minWidth: 460, minHeight: 340 },
  );
}

function openContinueRunWindow(taskId: string, runId: string): void {
  openChildWindow(
    `continue-run/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}`,
    'Continue Run',
    520,
    GUIDANCE_WINDOW_HEIGHT,
    undefined,
    { role: 'prompt', minWidth: 460, minHeight: GUIDANCE_WINDOW_HEIGHT, contentSize: true },
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
    { role: 'prompt', minWidth: 460, minHeight: GUIDANCE_WINDOW_HEIGHT, contentSize: true },
  );
}

function openFolderNoteEditorWindow(folderId: string): void {
  openChildWindow(
    `note-editor-folder/${encodeURIComponent(folderId)}`,
    'Guidance for Next Runs',
    520,
    400,
    undefined,
    { role: 'tool', minWidth: 460, minHeight: 340 },
  );
}

function openMoveToFolderWindow(taskId: string): void {
  openChildWindow(`move-to-folder/${encodeURIComponent(taskId)}`, 'Move to Folder', 460, 440, win, { role: 'tool' });
}

function openNewFolderWindow(parentId?: string): void {
  const hash = parentId ? `folder-new/${encodeURIComponent(parentId)}` : 'folder-new';
  openChildWindow(hash, 'New Folder', 420, 300, win, {
    role: 'prompt',
    minWidth: 420,
    minHeight: 300,
    resizable: false,
  });
}

/** A Projects tab folder's name: Rename Folder with `folderId`, else New Folder in `parentId`, which `moveProject` goes into once it's made. */
function openProjectFolderNameWindow(o: { folderId?: string; parentId?: string; moveProject?: string } = {}): void {
  if (o.folderId) {
    openChildWindow(`project-folder-rename/${encodeURIComponent(o.folderId)}`, 'Rename Folder', 420, 240, win, { role: 'prompt', minWidth: 420, minHeight: 240, resizable: false });
    return;
  }
  const query = new URLSearchParams({ ...(o.parentId ? { parent: o.parentId } : {}), ...(o.moveProject ? { move: o.moveProject } : {}) }).toString();
  openChildWindow(`project-folder-new${query ? `/${encodeURIComponent(query)}` : ''}`, 'New Folder', 420, 300, win, { role: 'prompt', minWidth: 420, minHeight: 300, resizable: false });
}

/** Rename… on a chat or terminal session: its name, or empty for its automatic one. */
function openRenameSessionWindow(sessionId: string, from?: AppWindow | null): void {
  openChildWindow(`session-rename/${encodeURIComponent(sessionId)}`, 'Rename', 420, 240, from ?? sessionsWindows.get() ?? win, {
    role: 'prompt',
    minWidth: 420,
    minHeight: 240,
    resizable: false,
  });
}

function openRenameFolderWindow(folderId: string): void {
  openChildWindow(`folder-rename/${encodeURIComponent(folderId)}`, 'Rename Folder', 420, 240, win, {
    role: 'prompt',
    minWidth: 420,
    minHeight: 240,
    resizable: false,
  });
}

function openSettingsWindow(): void {
  // Its tallest tab, Advanced, fits without a scroll bar (npm run perf fails a dialog that opens scrolling).
  openChildWindow('settings', 'Settings', 720, 642, win, { role: 'editor', contentSize: true });
}

const templatesWindows = new WindowSlots();

/** One Templates window (per client): opening it again brings the open one forward. */
function openTemplatesWindow(): void {
  const open = templatesWindows.get();
  if (open) {
    open.focus();
    return;
  }
  templatesWindows.set(openChildWindow('templates', 'Templates', 560, 520, undefined, { role: 'tool' }));
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
  recycleBinWindows.set(openChildWindow('recycle-bin', 'Recycle Bin', 560, 520, undefined, { role: 'tool' }));
}

const addonsWindows = new WindowSlots();

/** One Addons window (per client): opening it again brings the open one forward. */
function openAddonsWindow(): void {
  const open = addonsWindows.get();
  if (open) {
    open.focus();
    return;
  }
  addonsWindows.set(openChildWindow('addons', 'Addons', 560, 560, undefined, { role: 'tool' }));
}

function addonDeps(): AddonUiDeps {
  return {
    host: addons!,
    hostKind: engine!.host,
    mainWindow: mainWin,
    hasPanes: (w, addonId) => {
      const shown = mainViews.get(w);
      return !!shown && (!shown.fixed || shown.tab === addonTabId(addonId, PANES_TAB));
    },
    openWindow: openChildWindow,
  };
}

function openInstructionsWindow(): void {
  openChildWindow('instructions', 'Instructions', 800, 700, undefined, { role: 'editor' });
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
    { role: 'workspace' },
  );
  attachWindowMenu(child, firstTemplate(child, ENGINE_LOG_VIEWS));
  child.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRenderer(child, 'engine-log');
}

function openAboutWindow(): void {
  openChildWindow('about', 'About', 360, 320, win, { role: 'prompt', minWidth: 360, minHeight: 320, resizable: false });
}

function openEnvEditorWindow(envId: string, isNew?: boolean, parent?: AppWindow | null): void {
  openChildWindow(
    `env-editor/${encodeURIComponent(envId)}${isNew ? '/new' : ''}`,
    isNew ? 'New Environment' : 'Edit Environment',
    684,
    427,
    parent,
    { role: 'editor', contentSize: true },
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
    624,
    637,
    parent,
    { role: 'editor', contentSize: true },
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
    { role: 'tool', minWidth: 406, minHeight: 382, resizable: false, contentSize: true },
  );
}

function openModelUpdateWindow(envId?: string, harnessId?: string, parent?: AppWindow | null): void {
  const hash =
    envId && harnessId
      ? `model-update/${encodeURIComponent(envId)}/${encodeURIComponent(harnessId)}`
      : 'model-update';
  openChildWindow(hash, 'Update Models', 560, 560, parent ?? win, { role: 'tool' });
}

function openTemplateEditorWindow(templateId: string, isNew?: boolean, _parent?: AppWindow | null): void {
  openChildWindow(
    `template-editor/${encodeURIComponent(templateId)}${isNew ? '/new' : ''}`,
    isNew ? 'New Template' : 'Edit Template',
    780,
    800,
    undefined,
    { role: 'editor' },
  );
}

function openTemplatePickerWindow(): void {
  openChildWindow('template-picker', 'New Task from Template', 480, 420, win, { role: 'tool' });
}

function openEditorFromTemplateWindow(templateId: string): void {
  const child = openChildWindow(
    `editor-from-template/${encodeURIComponent(templateId)}`,
    'New Task',
    780,
    800,
    undefined,
    { role: 'editor' },
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
  versionWindows.set(openChildWindow(`versions/${encodeURIComponent(taskId)}`, 'Version History', 640, 480, undefined, { role: 'editor' }), taskId);
}

function openVersionDetailWindow(taskId: string, n: number, compare: boolean, _parent: AppWindow | null): void {
  openChildWindow(
    `version/${encodeURIComponent(taskId)}/${n}/${compare ? 'compare' : 'view'}`,
    compare ? `Compare Version ${n} with Current` : `Version ${n}`,
    900,
    680,
    undefined,
    { role: 'workspace' },
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
 * An addon's command in a terminal (`looper/openTerminal`): a Looper terminal
 * session where showChat puts it, or the system's default terminal when the
 * setting says so.
 */
async function openCommandTerminal(where: CommandPlace, command: string[], title: string): Promise<void> {
  if (!engine) return;
  if (engine.settings.terminal === 'system') {
    await engine.openCommandTerminal(where, command);
    return;
  }
  showChat(engine.startCommandTerminal(where, command, title));
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
    role: 'workspace',
    minWidth: 480,
    minHeight: 300,
    contentSize: true,
  });
  child.setMaximizable(true);
  terminalWindows.set(child, sessionId);
}

/** Log In's windows by session id (one per client). */
const loginWindows = new WindowSlots();

/** Log In: Claude Code's `auth login` for the harness in a terminal window. The login ends once no window shows it. */
function openLogIn(environmentId: string, harnessId: string): void {
  if (!engine) return;
  const sessionId = engine.logIn(environmentId, harnessId);
  const open = loginWindows.get(sessionId);
  if (open) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return;
  }
  const env = engine.settings.environments.find((e) => e.id === environmentId);
  const harness = env?.harnesses.find((h) => h.id === harnessId);
  const title = `Log In – ${harness?.name ?? 'Claude Code'} in ${env?.name ?? ''}`;
  const hash = `terminal/${encodeURIComponent(sessionId)}/${encodeURIComponent(title)}`;
  const child = openChildWindow(hash, title, 800, 500, undefined, { role: 'workspace', minWidth: 480, minHeight: 300, contentSize: true });
  loginWindows.set(child, sessionId);
  child.on('closed', () => {
    if (loginWindows.all(sessionId).length === 0) engine?.closeLogin(sessionId);
  });
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
  remoteHelpersWindows.set(openChildWindow('remote-helpers', 'Helpers', 640, 440, undefined, { role: 'editor', contentSize: true }));
}

// Page sizes: every field shows without a scroll bar.
function openRemoteHelperEditor(id: string, isNew: boolean, parent: AppWindow | null): void {
  openChildWindow(`remote-helper/${encodeURIComponent(id)}${isNew ? '/new' : ''}`, isNew ? 'New Helper' : 'Edit Helper', 560, 564, parent, {
    role: 'editor',
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
  openChildWindow('remote-access-settings', 'Remote Access', 560, 374, win, { role: 'tool', contentSize: true, minHeight: 374 });
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
  const child = openChildWindow('remote-access-setup', 'Set Up Remote Access', 560, 460, win, { role: 'tool', contentSize: true, minHeight: 460, resizable: false });
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
  remoteAccessDevicesWindows.set(openChildWindow('remote-access-devices', 'Paired Devices', 520, 391, undefined, { role: 'tool', minHeight: 340 }));
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
    role: 'tool',
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
    role: 'prompt',
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
  const child = openChildWindow(id ? `project/${encodeURIComponent(id)}` : 'project-new', id ? 'Edit Project' : 'New Project', 560, 528, undefined, {
    role: 'tool',
    contentSize: true,
  });
  projectWindows.set(child, key);
}

/** File → New Task with a project picked (a project's New Task…). */
function openNewTaskIn(projectId: string): void {
  openChildWindow(`editor-in/${encodeURIComponent(projectId)}`, 'New Task', 780, 800, undefined, { role: 'editor' });
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
  const child = openChildWindow('remote-conversations', 'Remote Control Conversations', 820, 600, undefined, { role: 'editor' });
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
  /** A main window's Chats tab. */
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
    role: 'workspace',
    // The list's and the Activity pane's smallest widths (200, 280) beside a 480 px conversation.
    minWidth: 970,
    minHeight: 500,
    contentSize: true,
  });
  child.setMaximizable(true);
  sessionsWindows.set(child);
  trackSessionsView({ w: child, shown: select ?? null, single: false, cards: [] });
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
    role: 'workspace',
    minWidth: 520,
    minHeight: 400,
    contentSize: true,
  });
  child.setMaximizable(true);
  chatWindows.set(child, id);
  trackSessionsView({ w: child, shown: id, single: true, cards: [] });
}

/** Give a Chats or single chat's window its menu, and its session's events, until it closes. */
function trackSessionsView(view: SessionsView): void {
  const child = view.w;
  sessionsViews.set(child, view);
  attachWindowMenu(child, firstTemplate(child, view.single ? CHAT_WINDOW_VIEWS : CHATS_WINDOW_VIEWS));
  watchShownSessions();
  const unsubscribe = engine!.on((e) => {
    // A single chat's window goes with its chat (closed, or a task run that ended).
    if (view.single && e.type === 'sessions' && view.shown && !engine?.sessionKind(view.shown)) {
      if (!child.isDestroyed()) child.close();
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
  // A view window has no Chats tab (Window → Chats is the Chats window).
  if (known || !main || main.fixed) return known;
  const view: SessionsView = { w, shown: null, single: false, cards: [], tab: true };
  sessionsViews.set(w, view);
  w.on('closed', () => {
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
}

/** The chats and task runs that Chats window's dashboard shows live as cards: their chat and activity events go there too. */
function showCards(w: AppWindow | null, ids: string[]): void {
  const view = w ? (sessionsViews.get(w) ?? tabSessionsView(w)) : undefined;
  if (!view || view.single) return;
  view.cards = ids;
  watchShownSessions();
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

/**
 * Close Conversation (the toolbar, the menus, Ctrl+W, Ctrl+F4): the chat or terminal
 * session ends at once, or once the user confirms with Settings → Chats → Ask before
 * closing a conversation. A conversation that's working always asks.
 */
async function closeSessionAsk(id: string, from?: AppWindow | null): Promise<void> {
  const kind = engine?.sessionKind(id);
  if (!engine || (kind !== 'chat' && kind !== 'terminal')) return;
  const busy = sessionBusy(id);
  // A chat nobody has written in has nothing to lose.
  const chat = kind === 'chat' ? engine.getChat(id) : undefined;
  // Settings → Chats: once the last reply's prompt cache has expired, going on would start over at full price anyway.
  const cacheUntil = engine.sessionsState().sessions.find((s) => s.id === id)?.cacheUntil;
  const expired = engine.settings.chats.closeExpiredWithoutAsking && cacheUntil !== undefined && cacheUntil <= Date.now();
  if (!busy && (!engine.settings.chats.confirmClose || (chat && chatIsEmpty(chat)) || expired)) {
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

/** The export options Save as Markdown last used. */
let markdownExportOpts = { includeThinking: true, includeTools: true, plain: false };

/** Save as Markdown: where, then which parts (the native save dialog can't hold check boxes). */
async function saveRowsAsMarkdown(w: AppWindow, rows: MessageRow[] | null, title: string): Promise<void> {
  if (!rows?.length) {
    await showMessageBox(w, { type: 'error', title: 'Looper', message: 'There are no messages to save.', buttons: ['OK'], defaultId: 0, cancelId: 0 });
    return;
  }
  const picked = await showSaveDialog(w, {
    title: 'Save as Markdown',
    defaultPath: `${title.replace(/[\\/:*?"<>|]/g, '-')}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (picked.canceled || !picked.filePath) return;
  const chosen = await promptMarkdownExport(w, markdownExportOpts);
  if (!chosen) return;
  markdownExportOpts = chosen;
  fs.writeFileSync(picked.filePath, messagesToMarkdown(rows, { title, ...chosen }), 'utf8');
}

/** A chat's history and live rows; a task run's agent conversation, as its run window reads it. */
async function sessionRows(id: string): Promise<MessageRow[] | null> {
  if (!engine) return null;
  const kind = engine.sessionKind(id);
  if (kind === 'chat') {
    const c = engine.getChat(id);
    return c ? [...c.history, ...c.rows] : null;
  }
  if (kind !== 'run') return null;
  const taskId = engine.sessionsState().sessions.find((s) => s.id === id)?.taskId;
  if (!taskId) return null;
  const result = await engine.readMessages(taskId, id, undefined, false);
  return result.status === 'ok' ? result.rows : [];
}

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
  sendToSessionsWindows.set(openChildWindow(hash, 'Send to Chats', 620, 560, undefined, { role: 'editor', contentSize: true, minWidth: 480, minHeight: 420 }));
}

// ---------- the History window ----------

/** One History window per client. */
const historyWindows = new WindowSlots();
const historyOpen = new Set<AppWindow>();

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
  const child = openChildWindow('history', 'History', 1388, 895, undefined, { role: 'workspace', minWidth: 970, minHeight: 500, contentSize: true });
  child.setMaximizable(true);
  historyWindows.set(child);
  historyOpen.add(child);
  attachWindowMenu(child, firstTemplate(child, HISTORY_VIEWS));
  child.on('closed', () => {
    historyOpen.delete(child);
  });
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
 * its project. Rejects with the reason. A History window that opened a
 * conversation closes (Copy Session ID and Open Working Directory leave it open).
 */
async function historyRun(from: AppWindow | null, id: string, command: HistoryCommand): Promise<void> {
  if (await historyContinue(from, id, command) && from && historyOpen.has(from) && !from.isDestroyed()) from.close();
}

/** historyRun's work: true once a conversation has opened (not for a cancelled question, or a command that opens none). */
async function historyContinue(from: AppWindow | null, id: string, command: HistoryCommand): Promise<boolean> {
  if (!engine) return false;
  const item = engine.historyItem(id);
  if (!item) throw new Error('This conversation is no longer in the list.');
  const can = engine.historyCommands(id);
  if (command === 'copy-id') {
    if (can.sessionId) writeClipboard(can.sessionId);
    return false;
  }
  if (command === 'open-folder') {
    if (item.folder) await openHostPath(item.folder);
    return false;
  }
  if (!can[command]) return false;
  if (item.runId) {
    if (command === 'chat') await openChat(item.taskId, item.runId);
    else if (command === 'terminal') await openTerminal(item.taskId, item.runId);
    else await compactRun(item.taskId, item.runId);
    return true;
  }
  // Compacting only reads the conversation.
  if (command === 'compact') {
    openSessionsWindow((await engine.compactHistory(id)).id);
    return true;
  }
  const changedAt = can.outside ? await engine.historyChangedAt(id) : undefined;
  if (changedAt !== undefined && !(await stillOpenAsk(from, changedAt))) return false;
  if (command === 'chat') {
    openSessionsWindow((await engine.continueHistoryInChat(id)).id);
    return true;
  }
  const sessionId = await engine.continueHistoryInTerminal(id);
  if (sessionId) openSessionsWindow(sessionId);
  return true;
}

/** historyRun for a menu pick: a failure shows in a message box over `from`. */
function historyRunFromMenu(from: AppWindow, id: string, command: HistoryCommand): void {
  void historyRun(from, id, command).catch((err: unknown) => {
    void showMessageBox(from, { type: 'error', title: 'Looper', message: err instanceof Error ? err.message : String(err), buttons: ['OK'], defaultId: 0, cancelId: 0 });
  });
}

/**
 * The most recent conversations (the History window's order, kept ready by
 * the engine so a menu reads nothing) as menu items that continue each in a
 * chat, or show it when a chat holds it already. `projectId`: only that
 * project's. Empty when there are none.
 */
async function recentChatItems(from: AppWindow, projectId?: string): Promise<Electron.MenuItemConstructorOptions[]> {
  if (!engine) return [];
  const items =
    engine.recentHistory(projectId) ??
    (
      await engine.historyList({
        fresh: false,
        limit: RECENT_CHATS,
        showRuns: engine.settings.view.history.showRuns,
        folder: projectId ? `project:${projectId}` : '',
      })
    ).items;
  return items.map((item): Electron.MenuItemConstructorOptions => {
    const where = projectId ? undefined : ((item.projectId && engine?.getProject(item.projectId)?.name) || item.folder.split(/[\\/]/).filter(Boolean).pop());
    return {
      label: menuText(recentChatLabel(item.title, where)),
      enabled: !!engine?.historyCommands(item.id).chat,
      click: () => historyRunFromMenu(from, item.id, 'chat'),
    };
  });
}

/** The Chats toolbar's History drop-down at (x, y): the recent conversations, then the History window. */
async function showHistoryMenu(from: AppWindow | null, x: number, y: number): Promise<void> {
  if (!from) return;
  const recent = await recentChatItems(from);
  const items: Electron.MenuItemConstructorOptions[] = [
    ...recent,
    ...(recent.length ? [{ type: 'separator' as const }] : []),
    { label: '&More…', click: () => openHistoryWindow() },
  ];
  if (!from.isDestroyed()) popupMenu(Menu.buildFromTemplate(items), { window: from, x, y });
}

/** A History window's commands on its conversation, as menu items: the File menu's and a row's right-click menu. */
function historyItems(from: AppWindow, id: string | null): Electron.MenuItemConstructorOptions[] {
  const can = id && engine ? engine.historyCommands(id) : NO_HISTORY_COMMANDS;
  const run = (command: HistoryCommand) => () => {
    if (id) historyRunFromMenu(from, id, command);
  };
  return [
    { id: 'history-chat', label: 'Continue in &Chat', glyph: 'chat', enabled: can.chat, click: run('chat') },
    { id: 'history-compact', label: 'Continue Co&mpacted', glyph: 'compact', enabled: can.compact, click: run('compact') },
    { id: 'history-terminal', label: 'Continue in &Terminal', glyph: 'terminal', enabled: can.terminal, click: run('terminal') },
    { type: 'separator' },
    { id: 'history-copy-id', label: 'Copy Session &ID', glyph: 'copy', enabled: !!can.sessionId, click: run('copy-id') },
    { id: 'history-folder', label: 'Open &Working Directory', glyph: 'folder', enabled: can.folder, click: run('open-folder') },
  ];
}

/** A conversation's right-click menu in the History window. */
function historyMenu(from: AppWindow | null, id: string): void {
  if (!from || !engine?.historyItem(id)) return;
  popupMenu(Menu.buildFromTemplate(historyItems(from, id)), { window: from });
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
    role: 'tool',
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
    role: 'workspace',
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
      openChildWindow(`builder/${encodeURIComponent(id)}`, title, BUILDER_SIZE.width, BUILDER_SIZE.height, undefined, { role: 'workspace', minWidth: 760, minHeight: 480, contentSize: true }),
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
  (isRemote(setupWindow) ? setupWindow : null)?.setRole('workspace');
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
      role: 'workspace',
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
      role: 'workspace',
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
    undefined,
    { role: 'editor' },
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
  openChildWindow(`${route}/${key}${update ? '/update' : ''}`, `${update ? 'Edit' : 'New'} ${noun}`, 780, 800, undefined, { role: 'editor' });
}

/** The windows that show the main window's views; a view window (Window → Dashboard, Projects, Tasks or an addon's tab) shows one of them. */
const mainViews = new Map<AppWindow, { fixed: boolean; tab?: string }>();

/** One window per view and client (Window → Dashboard, Projects, Tasks, an addon's tab). */
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
  const child = openChildWindow(`view/${encodeURIComponent(tab)}`, def.label, 1388, 895, undefined, { role: 'workspace', minWidth: 900, minHeight: 500, contentSize: true });
  child.setMaximizable(true);
  viewWindows.set(child, tab);
  mainViews.set(child, { fixed: true, tab });
  child.on('closed', () => mainViews.delete(child));
  attachWindowMenu(child, firstTemplate(child, mainWindowViews(tab, true), { tab, fixed: true }));
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
  const child = openChildWindow(`item/${kind}/${encodeURIComponent(id)}`, name, 1100, 760, undefined, { role: 'workspace', minWidth: 700, minHeight: 460, contentSize: true });
  child.setMaximizable(true);
  viewWindows.set(child, key);
  mainViews.set(child, { fixed: true });
  child.on('closed', () => mainViews.delete(child));
  attachWindowMenu(child, firstTemplate(child, mainWindowViews(tab, true, true), { tab, fixed: true, item: true }));
}

// ---------- menu bars: the page's, from the one command list ----------

/** The menu bar each window's page last sent, kept to draw again when what the main process fills in changes. */
const commandMenus = new Map<AppWindow, MenuItemSpec[]>();

/** What only the main process knows: the computer's open windows, and whether this one stays on top. */
function providedItems(w: AppWindow | null, key: string): Electron.MenuItemConstructorOptions[] | undefined {
  if (key === 'open-windows') return openWindowList();
  if (key === 'always-on-top') {
    return w instanceof BrowserWindow ? [{ label: 'Always on &Top', type: 'checkbox', checked: w.isAlwaysOnTop(), click: (item) => w.setAlwaysOnTop(item.checked) }] : [];
  }
  // macOS: Quit is in the app menu that macTemplate puts first.
  if (key === 'exit' && process.platform === 'darwin') return [];
  return undefined;
}

/** A click on a page's menu item goes back to it as the item's id. */
function commandTemplate(w: AppWindow | null, items: MenuItemSpec[]): Electron.MenuItemConstructorOptions[] {
  return specTemplate(
    items,
    (id) => {
      if (w && !w.isDestroyed()) w.webContents.send('ui:event', { type: 'command', id } satisfies UiEvent);
    },
    (key) => providedItems(w, key),
  );
}

/** A window's first menu, before its page has reported: the same list with nothing selected, so the menu bar doesn't change shape. */
function firstTemplate(w: AppWindow | null, views: readonly CommandView[], state: Partial<CommandContext> = {}): Electron.MenuItemConstructorOptions[] {
  return commandTemplate(w, menuBar(views, { ...EMPTY_CONTEXT, settings: engine?.settings ?? null, ...state }));
}

/** Show a template as the window's menu bar. */
function drawTemplate(w: AppWindow, template: Electron.MenuItemConstructorOptions[]): void {
  if (w.isDestroyed()) return;
  if (w !== win) {
    replaceWindowMenu(w, template);
    return;
  }
  if (process.platform === 'darwin') {
    // Don't stomp the menu of a focused window with its own; the browser-window-focus handler restores this one on the next switch.
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || !macWindowMenus.has(focused)) Menu.setApplicationMenu(desktopMenu(macTemplate(template)));
  } else setWindowMenu(win, Menu.buildFromTemplate(template));
}

/** A page's menu bar, sent again whenever it changes. */
function setCommandMenu(w: AppWindow | null, items: MenuItemSpec[]): void {
  if (!w) return;
  if (!commandMenus.has(w)) w.on('closed', () => commandMenus.delete(w));
  else if (JSON.stringify(commandMenus.get(w)) === JSON.stringify(items)) return;
  commandMenus.set(w, items);
  // A page sends three in 35 ms as a chat opens (up to 20 ms each to build): the last is drawn once they stop.
  menusToDraw.add(w);
  menuDrawFirst ??= Date.now();
  if (menuDraw) clearTimeout(menuDraw);
  menuDraw = setTimeout(drawPendingMenus, Math.max(0, Math.min(MENU_QUIET_MS, menuDrawFirst + MENU_WAIT_MS - Date.now())));
}
const MENU_QUIET_MS = 30;
const MENU_WAIT_MS = 100;
const menusToDraw = new Set<AppWindow>();
let menuDraw: NodeJS.Timeout | null = null;
let menuDrawFirst: number | null = null;

function drawPendingMenus(): void {
  menuDraw = null;
  menuDrawFirst = null;
  for (const m of [...menusToDraw]) {
    menusToDraw.delete(m);
    const latest = commandMenus.get(m);
    if (latest) drawCommandMenu(m, latest);
  }
}

/** A window with no commands (an addon's form) has no menu bar, as a dialog hasn't; macOS keeps its app menu for every window. */
const menuless = (w: AppWindow, items: MenuItemSpec[]): boolean => !items.length && w !== win && (process.platform !== 'darwin' || isRemote(w));

function drawCommandMenu(w: AppWindow, items: MenuItemSpec[]): void {
  if (w.isDestroyed()) return;
  mainSpan('menu bar', () => {
    if (menuless(w, items)) setWindowMenu(w, null);
    else drawTemplate(w, commandTemplate(w, items));
  });
}

/** Every window's menu bar again, for what the main process fills in; on macOS with no main window, the global one. */
function rebuildMenu(): void {
  for (const [w, items] of commandMenus) drawCommandMenu(w, items);
  if (process.platform === 'darwin' && (!win || win.isDestroyed())) {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || !macWindowMenus.has(focused)) Menu.setApplicationMenu(desktopMenu(macTemplate(firstTemplate(null, mainWindowViews()))));
  }
}

const errorBox = (w: AppWindow | null) => (err: unknown) =>
  void showMessageBox(w, { type: 'error', title: 'Looper', message: err instanceof Error ? err.message : String(err), buttons: ['OK'], defaultId: 0, cancelId: 0 });

/** What a command asks the main process for, by name: what only it can do. The typecheck keeps this table complete. */
const HOST: Record<HostCommand, (w: AppWindow | null, ...args: string[]) => void | Promise<unknown>> = {
  settings: () => openSettingsWindow(),
  templates: () => openTemplatesWindow(),
  'agent-settings': () => openAgentSettingsWindow(),
  'recycle-bin': () => openRecycleBinWindow(),
  'remote-access-toggle': () => toggleRemoteAccess(),
  'remote-access-setup': () => openRemoteAccessSetupWindow(),
  'remote-access-settings': () => openRemoteAccessSettingsWindow(),
  'pair-device': () => openRemoteAccessPairWindow(),
  'paired-devices': () => openRemoteAccessDevicesWindow(),
  'tailscale-sign-in': () => openTailscaleSignIn(),
  'tailscale-sign-out': () => signOutOfTailscale(),
  'remote-control-toggle': () => toggleRemote(),
  'remote-conversations': () => openRemoteConversationsWindow(),
  'remote-helpers': () => openRemoteHelpersWindow(),
  addons: () => openAddonsWindow(),
  'rest-toggle': () => toggleRestMode(),
  'prevent-sleep': (_w, value) => engine?.setPreventSleep(value === 'off' || value === 'until-off' ? value : (Number(value) as PreventSleepTimer)),
  'update-models': () => openModelUpdateWindow(),
  'engine-log': () => openEngineLogWindow(),
  'open-data-directory': () => (engine ? openPath(engine.dataDir) : undefined),
  instructions: () => openInstructionsWindow(),
  about: () => openAboutWindow(),
  'import-task': () => importTask(),
  // A project's folder takes the project along when `moveProject` is given.
  'new-folder': (_w, kind, moveProject) => (kind === 'project' ? openProjectFolderNameWindow(moveProject ? { moveProject } : {}) : openNewFolderWindow()),
  'open-view': (_w, tab) => openViewWindow(tab),
  'other-folder': (w, kind) => openInFolder(kind === 'terminal' ? 'terminal' : 'chat', w),
  'save-markdown': async (w, id, taskId, agentId, title) => {
    if (!w) return;
    if (taskId === undefined) return saveRowsAsMarkdown(w, await sessionRows(id), sessionTitle(id));
    const result = await engine?.readMessages(taskId, id, agentId || undefined, false);
    return saveRowsAsMarkdown(w, result?.status === 'ok' ? result.rows : null, title);
  },
  'close-all': (w) => closeAllSessionsAsk(undefined, w),
  'copy-session-id': (_w, id) => {
    const session = engine?.harnessSessionId(id);
    if (session) writeClipboard(session);
  },
  'run-output-file': (_w, taskId, runId, raw) => {
    if (!engine) return;
    const dir = engine.runDir(taskId, runId);
    const clean = path.join(dir, 'output.txt');
    return openHostPath(!raw && fs.existsSync(clean) ? clean : path.join(dir, 'output.log'));
  },
  'run-terminal': (_w, taskId, runId) => openTerminal(taskId, runId),
  'run-chat': (_w, taskId, runId) => openChat(taskId, runId),
  'run-compact': (_w, taskId, runId) => compactRun(taskId, runId),
  'run-guidance': (_w, taskId, runId) => openContinueRunWindow(taskId, runId),
  'run-folder': (_w, taskId, runId) => (engine ? openHostPath(engine.runDir(taskId, runId)) : undefined),
  'run-copy-folder': (_w, taskId, runId) => {
    if (engine) writeClipboard(engine.runDir(taskId, runId));
  },
  'run-work-folder': (_w, taskId, runId) => {
    const cwd = engine?.workFolder(taskId, runId);
    return cwd ? openHostPath(cwd) : undefined;
  },
  filter: (w, label, value) => {
    openChildWindow(`filter/${encodeURIComponent(label)}/${encodeURIComponent(value)}`, 'Filter', 420, 240, w, { role: 'prompt', minWidth: 360, minHeight: 220, resizable: false });
  },
};

/** Run a host command for the window that asked; a failure shows over it. */
function runHostCommand(w: AppWindow | null, name: HostCommand, args: string[]): void {
  const fn = HOST[name];
  if (!fn) return;
  try {
    void Promise.resolve(fn(w, ...args)).catch(errorBox(w));
  } catch (err) {
    void errorBox(w)(err);
  }
}
