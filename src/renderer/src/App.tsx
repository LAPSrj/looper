import { Fragment, useRef, useState } from 'react';
import { AddonScreenView, AddonToolbarButtons } from './components/AddonScreen';
import { Dashboard } from './components/Dashboard';
import { ProjectDetail } from './components/ProjectDetail';
import { Sidebar } from './components/Sidebar';
import { sidebarHasPanes } from '@shared/panes';
import { TaskDetail } from './components/TaskDetail';
import { TaskToolbar } from './components/TaskToolbar';
import { useDragResize } from './components/hooks';
import { PhoneMain } from './components/phone/PhoneMain';
import { isPhone } from './web/page-nav';
import { preventSleepStatus, restStatus, useMainWindow, type MainWindow } from './useMainWindow';
import { useRemoteAccessState } from './useRemoteAccess';
import { remoteAccessStatusItems } from '@shared/remote-access';

/** The main window: the shared state and commands, drawn for the desktop or a phone. */
export function App() {
  const m = useMainWindow();
  return isPhone ? <PhoneMain m={m} /> : <DesktopMain m={m} />;
}

/** The desktop main window: toolbar, sidebar, the selected item's view, status bar. */
function DesktopMain({ m }: { m: MainWindow }) {
  const { view, tasks, projects, runtimes, now, task, project, addonShown, targetTask, selected, addons, rest, counts, remoteOpen } = m;
  // The main toolbar's end, where the shown addon screen puts its buttons.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const appRef = useRef<HTMLDivElement>(null);
  // With every pane hidden (View menu) there is no sidebar: the main view takes the whole width.
  const sidebar = !view || sidebarHasPanes(view, addons);
  const preventSleepText = m.preventSleep ? preventSleepStatus(m.preventSleep) : null;
  const remoteAccess = useRemoteAccessState();

  const onSidebarDragStart = useDragResize({
    axis: 'x',
    containerRef: appRef,
    onDrag: (x, rect) => setSidebarWidth(Math.max(180, Math.min(rect.width * 0.5, x))),
  });

  return (
    <div className="app-shell">
      {(view?.toolbar ?? true) && (
        <TaskToolbar
          // On the dashboard the task buttons are off; the menus still act on the picked row.
          task={selected ? targetTask : null}
          project={project}
          newTaskProject={project ?? projects.find((p) => p.id === targetTask?.projectId) ?? null}
          sessionProject={m.sessionProject}
          runtime={selected && targetTask ? runtimes[targetTask.id] : undefined}
          dashboard={!selected && !project && !addonShown}
          onAction={m.uiAction}
          addonButtons={addons
            .filter((a) => a.enabled && a.toolbar.length && !view?.hiddenAddonToolbars.includes(a.id))
            .map((a) => (
              <Fragment key={a.id}>
                <span className="toolbar-sep" />
                <AddonToolbarButtons
                  items={a.toolbar.map((b) => ({ ...b, disabled: a.status !== 'running' }))}
                  onClick={(id) => {
                    const b = a.toolbar.find((x) => x.id === id);
                    if (b?.tool) void window.looper.addons.openTool(a.id, b.tool);
                    else void window.looper.addons.event(a.id, { source: { toolbar: 'main' }, kind: 'click', id });
                  }}
                />
              </Fragment>
            ))}
          addonSlot={setToolbarSlot}
        />
      )}
      <div className="app" ref={appRef} style={{ gridTemplateColumns: sidebar ? `${sidebarWidth}px 5px 1fr` : '1fr' }}>
        {!sidebar ? null : view ? (
          <Sidebar
            projects={projects}
            projectSelected={project ? project.id : null}
            onProjectSelect={m.selectProject}
            environments={m.info?.settings.environments ?? []}
            tasks={tasks}
            folders={m.folders}
            layout={m.layout}
            runtimes={runtimes}
            selected={selected}
            now={now}
            onSelect={m.select}
            view={view}
            onView={m.changeView}
            addons={addons}
            addonPanes={m.addonPanes}
            addonSelected={m.addonSel}
            onAddonSelect={m.selectAddon}
            onAddonRetry={m.reloadAddon}
          />
        ) : (
          <aside className="sidebar" />
        )}
        {sidebar && <div className="sidebar-divider" onMouseDown={onSidebarDragStart} />}
        <main className="main">
          {task ? (
            <TaskDetail
              key={task.id}
              task={task}
              project={projects.find((p) => p.id === task.projectId)}
              environments={m.info?.settings.environments ?? []}
              runtime={runtimes[task.id]}
              records={m.records[task.id] ?? []}
              now={now}
              tab={m.tab}
              onTab={m.setTab}
              hideNoActionRuns={view?.hideNoActionRuns ?? false}
              focusRun={m.focusRun}
              terminalRun={m.terminalRun}
              onTerminalRun={m.setTerminalRun}
            />
          ) : project ? (
            <ProjectDetail
              key={project.id}
              project={project}
              tasks={tasks}
              runtimes={runtimes}
              environments={m.info?.settings.environments ?? []}
              remote={m.remote}
              now={now}
              onSelectTask={m.select}
            />
          ) : addonShown ? (
            <AddonScreenView
              key={`${addonShown.addon.id}/${addonShown.item.view}/${JSON.stringify(addonShown.item.params ?? {})}`}
              addonId={addonShown.addon.id}
              addonName={addonShown.addon.name}
              view={addonShown.item.view}
              params={addonShown.item.params ?? {}}
              mode="main"
              toolbarSlot={view?.hiddenAddonToolbars.includes(addonShown.addon.id) ? null : toolbarSlot}
            />
          ) : (
            <Dashboard
              attention={m.attention}
              running={m.running}
              remote={remoteOpen}
              recent={m.recentShown}
              runtimes={runtimes}
              now={now}
              pick={m.livePick}
              onPick={m.setPick}
              onOpen={m.openFromDashboard}
            />
          )}
        </main>
      </div>
      {(view?.statusBar ?? true) && (
        <div className="statusbar">
          <span>
            {counts.enabled} enabled · {counts.disabled} disabled · {counts.completed} completed · {counts.paused} paused ·{' '}
            {counts.running} running
            {remoteOpen && ` · ${remoteOpen.length} Remote Control session${remoteOpen.length === 1 ? '' : 's'}`}
            {addons.length > 0 && ` · ${m.runningAddons} addon${m.runningAddons === 1 ? '' : 's'} running`}
          </span>
          <span className="spacer" />
          {rest?.armed && <span>{restStatus(rest, now)}</span>}
          {preventSleepText && <span>{preventSleepText}</span>}
          {remoteAccess && remoteAccessStatusItems(remoteAccess).map((text) => <span key={text}>{text}</span>)}
        </div>
      )}
    </div>
  );
}
