import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AddonInfo } from '@shared/addons';
import type { AppInfo } from '@shared/api';
import type { RemoteState } from '@shared/remote';
import type { RunPermission, SessionsState } from '@shared/sessions';
import type { PreventSleepState, Project, ProjectFolder, RestState, TaskFolder, View } from '@shared/types';
import { subscribe } from './events';
import { reportError } from './report-error';

/** What a page's commands and the main window read: loaded once a page, then kept current by the page's one event listener. */
export interface LiveState {
  /** The app's info, its settings kept current; null until it loads. */
  info: AppInfo | null;
  projects: Project[];
  projectFolders: ProjectFolder[];
  taskFolders: TaskFolder[];
  /** The project folders' row orders, which the commands' project lists follow. */
  projectLayout: Record<string, string[]>;
  /** The task folders' row orders: empty in a page that hasn't asked for them (useLiveState(true)). */
  taskLayout: Record<string, string[]>;
  rest: RestState | null;
  preventSleep: PreventSleepState | null;
  /** Remote Control; null until it loads. */
  remote: RemoteState | null;
}

let state: LiveState = {
  info: null,
  projects: [],
  projectFolders: [],
  taskFolders: [],
  projectLayout: {},
  taskLayout: {},
  rest: null,
  preventSleep: null,
  remote: null,
};
const listeners = new Set<() => void>();
let started = false;
let layouts = false;
/** The entries an event has set: a read that answers after one is older than it, and is dropped. */
const fromEvents = new Set<keyof LiveState>();
/** Settings an event brought before the app's info was read, which they are newer than. */
let earlySettings: AppInfo['settings'] | null = null;

function update(patch: Partial<LiveState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** An entry read once, unless an event has set it first. */
function read<K extends keyof LiveState>(key: K, load: () => Promise<LiveState[K]>): void {
  void load().then((value) => {
    if (!fromEvents.has(key)) update({ [key]: value } as Pick<LiveState, K>);
  });
}

function fromEvent(patch: Partial<LiveState>): void {
  for (const key of Object.keys(patch) as (keyof LiveState)[]) fromEvents.add(key);
  update(patch);
}

function start(): void {
  started = true;
  const api = window.looper;
  void api.info().then((info) => update({ info: earlySettings ? { ...info, settings: earlySettings } : info }));
  read('projects', () => api.projects.list());
  read('projectFolders', () => api.projects.folders());
  read('projectLayout', () => api.projects.layout());
  read('taskFolders', () => api.folders.list());
  read('rest', () => api.restState());
  read('preventSleep', () => api.preventSleepState());
  read('remote', () => api.remote.state());
  subscribe((e) => {
    switch (e.type) {
      case 'settings':
        if (state.info) update({ info: { ...state.info, settings: e.settings } });
        else earlySettings = e.settings;
        break;
      case 'projects':
        fromEvent({ projects: e.projects });
        break;
      case 'project-folders':
        fromEvent({ projectFolders: e.folders, projectLayout: e.layout });
        break;
      case 'folders':
        fromEvent(layouts ? { taskFolders: e.folders, taskLayout: e.layout } : { taskFolders: e.folders });
        break;
      case 'rest':
        fromEvent({ rest: e.rest });
        break;
      case 'prevent-sleep':
        fromEvent({ preventSleep: e.state });
        break;
      case 'remote':
        fromEvent({ remote: e.state });
        break;
      case 'sessions':
        if (sessionsWanted) setSessions(e.state);
        break;
    }
  });
}

function watch(onChange: () => void): () => void {
  if (!started) start();
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function loadTaskLayout(): void {
  if (layouts) return;
  layouts = true;
  read('taskLayout', () => window.looper.folders.layout());
}

/** The page's live state; `withLayouts`: the task folders' row orders too, which only the main window lists by. */
export function useLiveState(withLayouts = false): LiveState {
  useEffect(() => {
    if (withLayouts) loadTaskLayout();
  }, [withLayouts]);
  return useSyncExternalStore(watch, () => state);
}

/**
 * Every chat and terminal session, kept apart from LiveState: it changes with every chat's status, which the
 * pages reading only LiveState would render again for, and only the pages that list chats read it.
 */
let sessions: SessionsState | null = null;
const sessionListeners = new Set<() => void>();
let sessionsWanted = false;

function setSessions(next: SessionsState): void {
  sessions = next;
  for (const l of sessionListeners) l();
}

function watchSessions(onChange: () => void): () => void {
  if (!started) start();
  if (!sessionsWanted) {
    sessionsWanted = true;
    // An event that came first is newer than what was read.
    void window.looper.sessions.state().then((s) => {
      if (!sessions) setSessions(s);
    });
  }
  sessionListeners.add(onChange);
  return () => sessionListeners.delete(onChange);
}

/** Every chat and terminal session, kept current: read once a page, the first time something asks; null until then. */
export function useSessionsState(): SessionsState | null {
  return useSyncExternalStore(watchSessions, () => sessions);
}

/**
 * The tool call a task run's agent waits for the user to allow, for a page that shows only that run (the Run
 * conversation window): it renders again when the request changes, not at every chat's status.
 */
export function useRunPermission(taskId: string, runId: string): RunPermission | undefined {
  const last = useRef<RunPermission | undefined>(undefined);
  return useSyncExternalStore(watchSessions, () => {
    const p = sessions?.sessions.find((s) => s.kind === 'run' && s.taskId === taskId && s.id === runId)?.permission;
    // Each event brings new objects: the same request (its id) stays the same object.
    if (p?.id !== last.current?.id) last.current = p;
    return last.current;
  });
}

/** The installed addons; `loaded` is false until the first list answers, so an empty list before that isn't "no addons". */
export interface AddonList {
  addons: AddonInfo[];
  loaded: boolean;
}

let addonList: AddonList = { addons: [], loaded: false };
const addonListeners = new Set<() => void>();
let addonsStarted = false;

function updateAddons(next: AddonList): void {
  addonList = next;
  for (const l of addonListeners) l();
}

function watchAddons(onChange: () => void): () => void {
  if (!addonsStarted) {
    addonsStarted = true;
    window.looper.addons
      .list()
      .then((addons) => updateAddons({ addons, loaded: true }))
      .catch(() => updateAddons({ ...addonList, loaded: true }));
    window.looper.addons.onEvent((e) => {
      if (e.type === 'addons') updateAddons({ addons: e.addons, loaded: true });
    });
  }
  addonListeners.add(onChange);
  return () => addonListeners.delete(onChange);
}

/** The installed addons, loaded once a page (only when something asks) and kept current by the addons' own event. */
export function useAddonList(): AddonList {
  return useSyncExternalStore(watchAddons, () => addonList);
}

/** Changes the view: shown at once, and the settings event that follows carries the same view back. */
export function setView(patch: Partial<View>): void {
  const info = state.info;
  if (!info) return;
  const view = { ...info.settings.view, ...patch };
  update({ info: { ...info, settings: { ...info.settings, view } } });
  void window.looper.updateSettings({ view }).catch(reportError);
}
