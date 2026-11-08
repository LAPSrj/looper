import { useEffect, useMemo, useRef, useState } from 'react';
import type { AddonInfo } from '@shared/addons';
import { menuBar, runCommand } from '@shared/commands/build';
import type { CommandView } from '@shared/commands/command';
import type { CommandContext, HostCommand } from '@shared/commands/context';
import type { PreventSleepState, Project, ProjectFolder, RestState, Settings, TaskFolder, View } from '@shared/types';
import { emitUi, subscribe } from '../events';
import { useRemoteAccessState } from '../useRemoteAccess';
import { isPhone, uiHere } from '../web/page-nav';

const host = (name: HostCommand, ...args: string[]) => window.looper.commands.host(name, ...args);

/**
 * What every window's commands read, kept current: the settings, the projects
 * and folders, the addons, and the computer's Rest Mode, Prevent Sleep and
 * Remote Access state.
 */
export function useCommandState(): CommandContext {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [windowsHost, setWindowsHost] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([]);
  const [taskFolders, setTaskFolders] = useState<TaskFolder[]>([]);
  const [addons, setAddons] = useState<AddonInfo[]>([]);
  const [rest, setRest] = useState<RestState | null>(null);
  const [preventSleep, setPreventSleep] = useState<PreventSleepState | null>(null);
  const remoteAccess = useRemoteAccessState();
  const [remoteRunning, setRemoteRunning] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    void window.looper.info().then((i) => {
      setSettings(i.settings);
      setWindowsHost(i.host === 'windows');
    });
    void window.looper.projects.list().then(setProjects);
    void window.looper.projects.folders().then(setProjectFolders);
    void window.looper.folders.list().then(setTaskFolders);
    void window.looper.addons.list().then(setAddons);
    void window.looper.restState().then(setRest);
    void window.looper.preventSleepState().then(setPreventSleep);
    void window.looper.remote.state().then((s) => setRemoteRunning(s.running));
    const unsubAddons = window.looper.addons.onEvent((e) => {
      if (e.type === 'addons') setAddons(e.addons);
    });
    const unsub = subscribe((e) => {
      if (e.type === 'settings') setSettings(e.settings);
      else if (e.type === 'projects') setProjects(e.projects);
      else if (e.type === 'project-folders') setProjectFolders(e.folders);
      else if (e.type === 'folders') setTaskFolders(e.folders);
      else if (e.type === 'rest') setRest(e.rest);
      else if (e.type === 'prevent-sleep') setPreventSleep(e.state);
      else if (e.type === 'remote') setRemoteRunning(e.state.running);
    });
    return () => {
      unsub();
      unsubAddons();
    };
  }, []);

  return useMemo(
    () => ({
      looper: window.looper,
      here: uiHere,
      windowsHost,
      settings,
      setView: (patch: Partial<View>) => {
        const s = settingsRef.current;
        if (!s) return;
        const view = { ...s.view, ...patch };
        setSettings({ ...s, view });
        void window.looper.updateSettings({ view }).catch((e) => void window.looper.showError((e as Error).message));
      },
      ui: emitUi,
      host,
      closeWindow: () => window.close(),
      task: null,
      project: null,
      projects,
      projectFolders,
      taskFolders,
      addons,
      rest,
      preventSleep,
      remoteAccess,
      remoteRunning,
    }),
    [windowsHost, settings, projects, projectFolders, taskFolders, addons, rest, preventSleep, remoteAccess, remoteRunning],
  );
}

/**
 * A window's menu bar from the one list: sent to the main process whenever it
 * changes, which draws it; a click comes back as the item's id and runs here,
 * with the state it's drawn from now. A phone has no menu bar: its bar and More
 * are built from the same list by phoneNav.
 */
export function useCommandMenu(views: readonly CommandView[] | null, c: CommandContext): void {
  const latest = useRef(c);
  latest.current = c;
  const items = useMemo(() => (isPhone || !views ? null : menuBar(views, c)), [views?.join(), c]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = items ? JSON.stringify(items) : null;
  useEffect(() => {
    if (key !== null) window.looper.commands.setMenuBar(JSON.parse(key));
  }, [key]);
  useEffect(
    () =>
      window.looper.onUi((e) => {
        if (e.type === 'command') runCommand(e.id, latest.current);
      }),
    [],
  );
}
