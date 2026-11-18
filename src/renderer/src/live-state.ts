import { useEffect, useSyncExternalStore } from 'react';
import type { AddonInfo } from '@shared/addons';
import type { AppInfo } from '@shared/api';
import type { RemoteState } from '@shared/remote';
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

function update(patch: Partial<LiveState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function start(): void {
  started = true;
  const api = window.looper;
  void api.info().then((info) => update({ info }));
  void api.projects.list().then((projects) => update({ projects }));
  void api.projects.folders().then((projectFolders) => update({ projectFolders }));
  void api.projects.layout().then((projectLayout) => update({ projectLayout }));
  void api.folders.list().then((taskFolders) => update({ taskFolders }));
  void api.restState().then((rest) => update({ rest }));
  void api.preventSleepState().then((preventSleep) => update({ preventSleep }));
  void api.remote.state().then((remote) => update({ remote }));
  subscribe((e) => {
    switch (e.type) {
      case 'settings':
        if (state.info) update({ info: { ...state.info, settings: e.settings } });
        break;
      case 'projects':
        update({ projects: e.projects });
        break;
      case 'project-folders':
        update({ projectFolders: e.folders, projectLayout: e.layout });
        break;
      case 'folders':
        update(layouts ? { taskFolders: e.folders, taskLayout: e.layout } : { taskFolders: e.folders });
        break;
      case 'rest':
        update({ rest: e.rest });
        break;
      case 'prevent-sleep':
        update({ preventSleep: e.state });
        break;
      case 'remote':
        update({ remote: e.state });
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
  void window.looper.folders.layout().then((taskLayout) => update({ taskLayout }));
}

/** The page's live state; `withLayouts`: the task folders' row orders too, which only the main window lists by. */
export function useLiveState(withLayouts = false): LiveState {
  useEffect(() => {
    if (withLayouts) loadTaskLayout();
  }, [withLayouts]);
  return useSyncExternalStore(watch, () => state);
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
