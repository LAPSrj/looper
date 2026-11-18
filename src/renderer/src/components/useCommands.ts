import { useEffect, useMemo, useRef } from 'react';
import { menuBar, runCommand } from '@shared/commands/build';
import type { CommandView } from '@shared/commands/command';
import type { CommandContext, HostCommand } from '@shared/commands/context';
import { emitUi } from '../events';
import { setView, useAddonList, useLiveState } from '../live-state';
import { useRemoteAccessState } from '../useRemoteAccess';
import { isPhone, uiHere } from '../web/page-nav';

const host = (name: HostCommand, ...args: string[]) => window.looper.commands.host(name, ...args);

/**
 * What every window's commands read, kept current: the settings, the projects
 * and folders, the addons, and the computer's Rest Mode, Prevent Sleep and
 * Remote Access state. The page's live state (live-state.ts) is shared with
 * the main window's own, so each is read once a page.
 */
export function useCommandState(): CommandContext {
  const { info, projects, projectFolders, projectLayout, taskFolders, rest, preventSleep, remote } = useLiveState();
  const { addons } = useAddonList();
  const remoteAccess = useRemoteAccessState();
  const settings = info?.settings ?? null;
  const windowsHost = info?.host === 'windows';
  const remoteRunning = remote?.running ?? false;

  return useMemo(
    () => ({
      looper: window.looper,
      here: uiHere,
      windowsHost,
      settings,
      setView,
      ui: emitUi,
      host,
      closeWindow: () => window.close(),
      task: null,
      project: null,
      projects,
      projectFolders,
      projectLayout,
      taskFolders,
      addons,
      rest,
      preventSleep,
      remoteAccess,
      remoteRunning,
    }),
    [windowsHost, settings, projects, projectFolders, projectLayout, taskFolders, addons, rest, preventSleep, remoteAccess, remoteRunning],
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
