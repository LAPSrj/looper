import { useEffect, useRef, useState } from 'react';
import type { AddonInfo, AddonProjectTab, AddonProjectTabState } from '@shared/addons';
import { useAddonList } from '../live-state';
import { refreshes } from './addon-screen-model';
import { AddonScreenView } from './AddonScreen';

/** An addon's project tab among a project's tabs (ProjectDetail's, the activity pane's). */
export type AddonProjectTabId = `addon:${string}`;
export const addonProjectTabId = (addonId: string, tabId: string): AddonProjectTabId => `addon:${addonId}/${tabId}`;

/** A project tab that shows for the project: its id among the project's tabs and its title now. */
export interface ShownProjectTab {
  id: AddonProjectTabId;
  title: string;
  addon: AddonInfo;
  tab: AddonProjectTab;
}

/** No answer yet; the addon couldn't answer (the tab shows, and its screen says what went wrong); its answer. */
type TabState = undefined | 'failed' | AddonProjectTabState;

/**
 * The started addons' tabs for a project, after Looper's own: each addon is
 * asked (`projectTab`) whether its tab shows for the project and its title,
 * when the project shows, when the addon starts, and again when it asks for a
 * redraw of its project tabs. A tab shows once its addon has answered.
 */
export function useAddonProjectTabs(projectId: string | undefined): ShownProjectTab[] {
  const { addons } = useAddonList();
  const [states, setStates] = useState<Record<string, TabState>>({});
  const running = addons.filter((a) => a.enabled && a.status === 'running' && a.projectTabs.length > 0);
  const runningKey = running.map((a) => `${a.id}:${a.projectTabs.map((t) => t.id).join(',')}`).join('\n');
  const runningRef = useRef(running);
  runningRef.current = running;
  // Only the latest question about each tab, for the project showing now, is answered.
  const asked = useRef<Record<string, number>>({});
  const project = useRef(projectId);
  project.current = projectId;

  const ask = (a: AddonInfo) => {
    const pid = project.current;
    if (!pid) return;
    for (const t of a.projectTabs) {
      const key = addonProjectTabId(a.id, t.id);
      const n = (asked.current[key] ?? 0) + 1;
      asked.current[key] = n;
      const answer = (s: TabState) => {
        if (asked.current[key] === n && project.current === pid) setStates((m) => ({ ...m, [key]: s }));
      };
      window.looper.addons.projectTab(a.id, t.id, pid).then(answer, () => answer('failed'));
    }
  };
  const askRef = useRef(ask);
  askRef.current = ask;

  useEffect(() => setStates({}), [projectId]);
  useEffect(() => {
    for (const a of runningRef.current) askRef.current(a);
  }, [projectId, runningKey]);
  useEffect(
    () =>
      window.looper.addons.onEvent((e) => {
        if (e.type !== 'refresh' || !refreshes(e.only, { projectTabs: true })) return;
        const a = runningRef.current.find((x) => x.id === e.addonId);
        if (a) askRef.current(a);
      }),
    [],
  );

  if (!projectId) return [];
  return running.flatMap((addon) =>
    addon.projectTabs.flatMap((tab): ShownProjectTab[] => {
      const id = addonProjectTabId(addon.id, tab.id);
      const s = states[id];
      if (s === undefined || (s !== 'failed' && s.hidden)) return [];
      return [{ id, title: s !== 'failed' && s.title ? s.title : tab.title, addon, tab }];
    }),
  );
}

/** A project tab's content: the addon's screen for it, with the project's id, filling the tab. `narrow`: the activity pane's. */
export function AddonProjectTabView({ shown, projectId, narrow }: { shown: ShownProjectTab; projectId: string; narrow?: boolean }) {
  return (
    <AddonScreenView
      key={`${shown.id}/${projectId}`}
      addonId={shown.addon.id}
      addonName={shown.addon.name}
      view={shown.tab.view}
      params={{ projectId }}
      mode="fill"
      narrow={narrow}
    />
  );
}
