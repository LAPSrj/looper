// First: it must see whether the preload provided `window.looper` before the web boot below sets one.
import { platform } from './platform';
import React, { lazy, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { isLooperFileName } from '@shared/files';
import { setAppLocale } from './format';
import './styles.css';
import { App } from './App';
import { phoneStyles } from './components/phone/keyboard';
import { WindowBoundary, WindowReady } from './WindowReady';
import { wakeableSleep, waitForPairing } from './web/boot';
import { flushWhenHidden, idbBackend } from './web/offline-idb';
import { OfflineStore } from './web/offline-store';
import type { Session } from './web/session';
import { preloadFrame, Shell } from './web/Shell';
import { attachFrame, startSession } from './web/start';
import { Waiting } from './web/Waiting';

// Every window except the main one is a chunk of its own: a window loads only the code its route needs.
// A new window app is added here as a lazy import, never as a static one (tests/code-splitting.test.ts).
const AboutApp = lazy(() => import('./AboutApp').then((m) => ({ default: m.AboutApp })));
const AddonEditApp = lazy(() => import('./AddonsApp').then((m) => ({ default: m.AddonEditApp })));
const AddonsApp = lazy(() => import('./AddonsApp').then((m) => ({ default: m.AddonsApp })));
const AddonPaneWindowApp = lazy(() => import('./components/AddonPane').then((m) => ({ default: m.AddonPaneWindowApp })));
const AddonWindowApp = lazy(() => import('./components/AddonScreen').then((m) => ({ default: m.AddonWindowApp })));
const BuilderApp = lazy(() => import('./BuilderApp').then((m) => ({ default: m.BuilderApp })));
const BuilderSetupApp = lazy(() => import('./BuilderSetupApp').then((m) => ({ default: m.BuilderSetupApp })));
const VersionDetailApp = lazy(() => import('./VersionDetailApp').then((m) => ({ default: m.VersionDetailApp })));
const VersionHistoryApp = lazy(() => import('./VersionHistoryApp').then((m) => ({ default: m.VersionHistoryApp })));
const ContinueRunApp = lazy(() => import('./ContinueRunApp').then((m) => ({ default: m.ContinueRunApp })));
const EditorApp = lazy(() => import('./EditorApp').then((m) => ({ default: m.EditorApp })));
const EngineLogApp = lazy(() => import('./EngineLogApp').then((m) => ({ default: m.EngineLogApp })));
const InstructionsApp = lazy(() => import('./InstructionsApp').then((m) => ({ default: m.InstructionsApp })));
const EnvEditorApp = lazy(() => import('./EnvEditorApp').then((m) => ({ default: m.EnvEditorApp })));
const HarnessEditorApp = lazy(() => import('./HarnessEditorApp').then((m) => ({ default: m.HarnessEditorApp })));
const ModelEditorApp = lazy(() => import('./ModelEditorApp').then((m) => ({ default: m.ModelEditorApp })));
const ModelUpdateApp = lazy(() => import('./ModelUpdateApp').then((m) => ({ default: m.ModelUpdateApp })));
const FilterApp = lazy(() => import('./FilterApp').then((m) => ({ default: m.FilterApp })));
const FolderNameApp = lazy(() => import('./FolderNameApp').then((m) => ({ default: m.FolderNameApp })));
const FolderNoteApp = lazy(() => import('./FolderNoteApp').then((m) => ({ default: m.FolderNoteApp })));
const MoveToFolderApp = lazy(() => import('./MoveToFolderApp').then((m) => ({ default: m.MoveToFolderApp })));
const ImageApp = lazy(() => import('./ImageApp').then((m) => ({ default: m.ImageApp })));
const MarkdownExportApp = lazy(() => import('./MarkdownExportApp').then((m) => ({ default: m.MarkdownExportApp })));
const MessagesApp = lazy(() => import('./MessagesApp').then((m) => ({ default: m.MessagesApp })));
const NoteEditorApp = lazy(() => import('./NoteEditorApp').then((m) => ({ default: m.NoteEditorApp })));
const RecycleBinApp = lazy(() => import('./RecycleBinApp').then((m) => ({ default: m.RecycleBinApp })));
const RemoteConversationsApp = lazy(() => import('./RemoteConversationsApp').then((m) => ({ default: m.RemoteConversationsApp })));
const RemoteHelperEditorApp = lazy(() => import('./RemoteEditorApps').then((m) => ({ default: m.RemoteHelperEditorApp })));
const ProjectEditorApp = lazy(() => import('./ProjectEditorApp').then((m) => ({ default: m.ProjectEditorApp })));
const RemoteHelpersApp = lazy(() => import('./RemoteHelpersApp').then((m) => ({ default: m.RemoteHelpersApp })));
const RemoteAccessDevicesApp = lazy(() => import('./RemoteAccessApps').then((m) => ({ default: m.RemoteAccessDevicesApp })));
const RemoteAccessPairApp = lazy(() => import('./RemoteAccessApps').then((m) => ({ default: m.RemoteAccessPairApp })));
const RemoteAccessRenameApp = lazy(() => import('./RemoteAccessApps').then((m) => ({ default: m.RemoteAccessRenameApp })));
const RemoteAccessSettingsApp = lazy(() => import('./RemoteAccessApps').then((m) => ({ default: m.RemoteAccessSettingsApp })));
const RemoteAccessSetupApp = lazy(() => import('./RemoteAccessApps').then((m) => ({ default: m.RemoteAccessSetupApp })));
const RunOptionsApp = lazy(() => import('./RunOptionsApp').then((m) => ({ default: m.RunOptionsApp })));
const SendToSessionsApp = lazy(() => import('./SendToSessionsApp').then((m) => ({ default: m.SendToSessionsApp })));
const SessionsApp = lazy(() => import('./SessionsApp').then((m) => ({ default: m.SessionsApp })));
const SettingsApp = lazy(() => import('./SettingsApp').then((m) => ({ default: m.SettingsApp })));
const TemplatePickerApp = lazy(() => import('./TemplatePickerApp').then((m) => ({ default: m.TemplatePickerApp })));
const TemplatesApp = lazy(() => import('./TemplatesApp').then((m) => ({ default: m.TemplatesApp })));
const TerminalSessionApp = lazy(() => import('./TerminalSessionApp').then((m) => ({ default: m.TerminalSessionApp })));
const PairPage = lazy(() => import('./web/PairPage').then((m) => ({ default: m.PairPage })));

const hash = window.location.hash.replace(/^#\/?/, '');
const editorMatch = /^editor(?:\/(.+))?$/.exec(hash);
const editorInMatch = /^editor-in\/([^/]+)$/.exec(hash);
const projectMatch = /^project\/([^/]+)$/.exec(hash);
const templateEditorMatch = /^template-editor(?:\/(.+))?$/.exec(hash);
const fromTemplateMatch = /^editor-from-template\/(.+)$/.exec(hash);
const importMatch = /^editor-import\/([^/]+)(\/update)?(?:\/builder\/([^/]+))?$/.exec(hash);
const builderMatch = /^builder\/([^/]+)$/.exec(hash);
const versionsMatch = /^versions\/([^/]+)$/.exec(hash);
const versionMatch = /^version\/([^/]+)\/(\d+)\/(view|compare)$/.exec(hash);
const templateImportMatch = /^template-import\/([^/]+)(\/update)?$/.exec(hash);
const envEditorMatch = /^env-editor\/([^/]+)(\/new)?$/.exec(hash);
const harnessEditorMatch = /^harness-editor\/([^/]+)\/([^/]+)(\/new)?$/.exec(hash);
const modelEditorMatch = /^model-editor\/([^/]+)\/([^/]+)\/(new|copy-\d+|\d+)$/.exec(hash);
const modelUpdateMatch = /^model-update(?:\/([^/]+)\/([^/]+))?$/.exec(hash);
const runOptionsMatch = /^run-options\/([^/]+)$/.exec(hash);
const messagesMatch = /^messages\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)(\/report)?$/.exec(hash);
const imageMatch = /^image\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(hash);
const filterMatch = /^messages-filter(?:\/(.*))?$/.exec(hash);
const markdownExportMatch = /^markdown-export\/([01])\/([01])\/([01])$/.exec(hash);
const noteEditorMatch = /^note-editor\/([^/]+)$/.exec(hash);
const continueRunMatch = /^(continue-run|send-guidance)\/([^/]+)\/([^/]+)$/.exec(hash);
const folderNoteMatch = /^note-editor-folder\/([^/]+)$/.exec(hash);
const moveToFolderMatch = /^move-to-folder\/([^/]+)$/.exec(hash);
const folderRenameMatch = /^folder-rename\/([^/]+)$/.exec(hash);
const folderNewMatch = /^folder-new(?:\/([^/]+))?$/.exec(hash);
const terminalMatch = /^terminal\/([^/]+)\/([^/]+)$/.exec(hash);
const sessionsMatch = /^sessions(?:\/([^/]+)(\/window)?)?$/.exec(hash);
const remoteHelperMatch = /^remote-helper\/([^/]+)(\/new)?$/.exec(hash);
const addonWindowMatch = /^addon\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(hash);
const addonPaneWindowMatch = /^addon-pane\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(hash);

const addonEditMatch = /^addon-edit\/([^/]+)$/.exec(hash);
const remoteAccessRenameMatch = /^remote-access-rename\/([^/]+)$/.exec(hash);

function pickRoot() {
  if (hash === 'addons') return <AddonsApp />;
  if (addonEditMatch) return <AddonEditApp addonId={decodeURIComponent(addonEditMatch[1])} />;
  if (addonPaneWindowMatch) {
    return (
      <AddonPaneWindowApp
        addonId={decodeURIComponent(addonPaneWindowMatch[1])}
        pane={decodeURIComponent(addonPaneWindowMatch[2])}
        title={decodeURIComponent(addonPaneWindowMatch[3])}
      />
    );
  }
  if (addonWindowMatch) {
    return (
      <AddonWindowApp
        addonId={decodeURIComponent(addonWindowMatch[1])}
        view={decodeURIComponent(addonWindowMatch[2])}
        params={JSON.parse(decodeURIComponent(addonWindowMatch[3])) as Record<string, unknown>}
        title={decodeURIComponent(addonWindowMatch[4])}
      />
    );
  }
  if (hash === 'template-picker') return <TemplatePickerApp />;
  if (hash === 'templates') return <TemplatesApp />;
  if (hash === 'recycle-bin') return <RecycleBinApp />;
  if (hash === 'remote-helpers') return <RemoteHelpersApp />;
  if (hash === 'remote-conversations') return <RemoteConversationsApp />;
  if (hash === 'remote-access-settings') return <RemoteAccessSettingsApp />;
  if (hash === 'remote-access-setup') return <RemoteAccessSetupApp />;
  if (hash === 'remote-access-devices') return <RemoteAccessDevicesApp />;
  if (hash === 'remote-access-pair') return <RemoteAccessPairApp />;
  if (remoteAccessRenameMatch) return <RemoteAccessRenameApp id={decodeURIComponent(remoteAccessRenameMatch[1])} />;
  if (remoteHelperMatch) return <RemoteHelperEditorApp id={decodeURIComponent(remoteHelperMatch[1])} isNew={!!remoteHelperMatch[2]} />;
  if (hash === 'project-new') return <ProjectEditorApp />;
  if (projectMatch) return <ProjectEditorApp id={decodeURIComponent(projectMatch[1])} />;
  if (editorInMatch) return <EditorApp projectId={decodeURIComponent(editorInMatch[1])} />;
  if (templateEditorMatch) {
    return (
      <EditorApp
        mode="template"
        templateId={templateEditorMatch[1] ? decodeURIComponent(templateEditorMatch[1]) : undefined}
      />
    );
  }
  if (fromTemplateMatch) return <EditorApp fromTemplateId={decodeURIComponent(fromTemplateMatch[1])} />;
  if (importMatch) {
    return (
      <EditorApp
        importKey={decodeURIComponent(importMatch[1])}
        importUpdate={!!importMatch[2]}
        builderId={importMatch[3] ? decodeURIComponent(importMatch[3]) : undefined}
      />
    );
  }
  if (hash === 'builder-setup') return <BuilderSetupApp />;
  if (sessionsMatch) return <SessionsApp initial={sessionsMatch[1] ? decodeURIComponent(sessionsMatch[1]) : undefined} single={!!sessionsMatch[2]} />;
  if (hash === 'send-to-sessions') return <SendToSessionsApp />;  if (terminalMatch) {
    return <TerminalSessionApp id={decodeURIComponent(terminalMatch[1])} title={decodeURIComponent(terminalMatch[2])} />;
  }
  if (builderMatch) return <BuilderApp id={decodeURIComponent(builderMatch[1])} />;
  if (versionsMatch) return <VersionHistoryApp taskId={decodeURIComponent(versionsMatch[1])} />;
  if (versionMatch) {
    return (
      <VersionDetailApp
        taskId={decodeURIComponent(versionMatch[1])}
        n={Number(versionMatch[2])}
        compare={versionMatch[3] === 'compare'}
      />
    );
  }
  if (templateImportMatch) {
    return (
      <EditorApp
        mode="template"
        importKey={decodeURIComponent(templateImportMatch[1])}
        importUpdate={!!templateImportMatch[2]}
      />
    );
  }

  if (editorMatch) return <EditorApp taskId={editorMatch[1] ? decodeURIComponent(editorMatch[1]) : undefined} />;
  if (noteEditorMatch) return <NoteEditorApp taskId={decodeURIComponent(noteEditorMatch[1])} />;
  if (continueRunMatch) {
    return (
      <ContinueRunApp
        taskId={decodeURIComponent(continueRunMatch[2])}
        runId={decodeURIComponent(continueRunMatch[3])}
        mode={continueRunMatch[1] === 'send-guidance' ? 'send' : 'continue'}
      />
    );
  }
  if (folderNoteMatch) return <FolderNoteApp folderId={decodeURIComponent(folderNoteMatch[1])} />;
  if (moveToFolderMatch) return <MoveToFolderApp taskId={decodeURIComponent(moveToFolderMatch[1])} />;
  if (folderNewMatch) return <FolderNameApp parentId={folderNewMatch[1] ? decodeURIComponent(folderNewMatch[1]) : undefined} />;
  if (folderRenameMatch) return <FolderNameApp folderId={decodeURIComponent(folderRenameMatch[1])} />;
  if (modelUpdateMatch) {
    return (
      <ModelUpdateApp
        envId={modelUpdateMatch[1] ? decodeURIComponent(modelUpdateMatch[1]) : undefined}
        harnessId={modelUpdateMatch[2] ? decodeURIComponent(modelUpdateMatch[2]) : undefined}
      />
    );
  }
  if (modelEditorMatch) {
    return (
      <ModelEditorApp
        envId={decodeURIComponent(modelEditorMatch[1])}
        harnessId={decodeURIComponent(modelEditorMatch[2])}
        index={/^\d+$/.test(modelEditorMatch[3]) ? Number(modelEditorMatch[3]) : undefined}
        copyOf={modelEditorMatch[3].startsWith('copy-') ? Number(modelEditorMatch[3].slice(5)) : undefined}
      />
    );
  }
  if (harnessEditorMatch) {
    return (
      <HarnessEditorApp
        envId={decodeURIComponent(harnessEditorMatch[1])}
        harnessId={decodeURIComponent(harnessEditorMatch[2])}
        isNew={!!harnessEditorMatch[3]}
      />
    );
  }
  if (envEditorMatch) return <EnvEditorApp envId={decodeURIComponent(envEditorMatch[1])} isNew={!!envEditorMatch[2]} />;
  if (runOptionsMatch) return <RunOptionsApp taskId={decodeURIComponent(runOptionsMatch[1])} />;
  if (messagesMatch) {
    return (
      <MessagesApp
        taskId={decodeURIComponent(messagesMatch[1])}
        runId={decodeURIComponent(messagesMatch[2])}
        agentId={messagesMatch[3] === '-' ? undefined : decodeURIComponent(messagesMatch[3])}
        title={decodeURIComponent(messagesMatch[4])}
        focusReport={!!messagesMatch[5]}
      />
    );
  }
  if (filterMatch) return <FilterApp current={decodeURIComponent(filterMatch[1] ?? '')} />;
  if (markdownExportMatch) {
    return (
      <MarkdownExportApp
        includeThinking={markdownExportMatch[1] === '1'}
        includeTools={markdownExportMatch[2] === '1'}
        plain={markdownExportMatch[3] === '1'}
      />
    );
  }
  if (imageMatch) {
    return (
      <ImageApp
        taskId={decodeURIComponent(imageMatch[1])}
        runId={decodeURIComponent(imageMatch[2])}
        agentId={imageMatch[3] === '-' ? undefined : decodeURIComponent(imageMatch[3])}
        rowId={decodeURIComponent(imageMatch[4])}
        title={decodeURIComponent(imageMatch[5])}
      />
    );
  }
  if (hash === 'engine-log') return <EngineLogApp />;
  if (hash === 'settings') return <SettingsApp />;
  if (hash === 'instructions') return <InstructionsApp />;
  if (hash === 'about') return <AboutApp />;
  return <App />;
}

// A file dropped on any window must never navigate it; a Looper document
// (.loopertask/.loopertpl/.looperaddon) opens instead, as if it had been double-clicked.
// In-app drags (list reordering) carry no files and fall through untouched.
// A browser's top frame has no `window.looper`: its shell handles drops itself.
if (platform === 'electron' || window !== window.top) {
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file || !isLooperFileName(file.name)) return;
    const opening = window.looper.openLooperFile(file);
    // In a browser the file is sent to the computer first, which can fail (too large, connection lost).
    if (platform !== 'electron') opening.catch((err: Error) => void window.looper.showError(err.message));
  });
}

/** How long one /api/me may take before it counts as no answer. */
const ME_TIMEOUT_MS = 3000;
/** Without an answer by then, the windows of the last launch show from what the phone kept. */
const RESTORE_AFTER_MS = 800;

/** A browser's top frame: the pairing page until this device is paired, then the shell that shows the windows. */
async function bootWebTop() {
  preloadFrame();
  const root = createRoot(document.getElementById('root')!);
  const offline = await OfflineStore.open({ version: __LOOPER_VERSION__, backend: idbBackend() });
  flushWhenHidden(offline);
  const { sleep, wake } = wakeableSleep();
  const started: { session?: Session } = {};
  const restore = (): boolean => {
    if (started.session) return true;
    if (!offline.shell()?.windows.length) return false;
    started.session = startSession(offline, true);
    root.render(<Shell session={started.session} />);
    return true;
  };
  // A computer that's asleep or out of reach often leaves the request hanging instead of refusing it.
  const fetchMe = () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ME_TIMEOUT_MS);
    return fetch('/api/me', { signal: abort.signal }).finally(() => clearTimeout(timer));
  };
  const restoreTimer = setTimeout(restore, RESTORE_AFTER_MS);
  // No answer (Looper restarting, a source still starting) isn't "not paired": wait for one.
  // Meanwhile the windows of the last launch show from what the phone kept, and the session reconnects itself.
  const answer = await waitForPairing(fetchMe, {
    retryMs: 3000,
    sleep,
    onWaiting: () => {
      if (!restore()) root.render(<Waiting onRetry={wake} />);
    },
  });
  clearTimeout(restoreTimer);
  if (answer === 'unpaired') {
    started.session?.stop();
    await offline.clear();
    root.render(
      <Suspense fallback={null}>
        <PairPage />
      </Suspense>,
    );
    return;
  }
  if (!started.session) root.render(<Shell session={startSession(offline)} />);
}

/**
 * Every window formats dates in the machine's regional format, so it's known before the first paint,
 * and on a phone its stylesheet has loaded by then too.
 * `onRendered` fires once the window's own app has rendered: for a lazy app that's after its chunk
 * arrives, not after the empty fallback (see WindowReady), because the phone shows the window then.
 */
function bootWindow(onRendered?: () => void) {
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    onRendered?.();
  };
  const info = window.looper
    .info()
    .then((i) => setAppLocale(i.locale))
    .catch(() => undefined);
  void Promise.all([info, phoneStyles.catch(() => undefined)]).then(() => {
    const root = createRoot(document.getElementById('root')!);
    const render = () =>
      root.render(
        <React.StrictMode>
          <WindowBoundary onFailed={report}>
            <Suspense fallback={null}>
              {pickRoot()}
              {onRendered && <WindowReady onReady={report} />}
            </Suspense>
          </WindowBoundary>
        </React.StrictMode>,
      );
    if (!onRendered) return render();
    flushSync(render);
  });
}

if (platform !== 'electron' && window === window.top) {
  void bootWebTop();
} else if (platform !== 'electron') {
  const frame = attachFrame();
  bootWindow(frame.ready);
} else {
  bootWindow();
}
