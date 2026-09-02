import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { EditorApp } from './EditorApp';
import { EnvEditorApp } from './EnvEditorApp';
import { HarnessEditorApp } from './HarnessEditorApp';
import { ModelEditorApp } from './ModelEditorApp';
import { NoteEditorApp } from './NoteEditorApp';
import { RunDetailApp } from './RunDetailApp';
import { SettingsApp } from './SettingsApp';
import { TemplatePickerApp } from './TemplatePickerApp';
import { TemplatesApp } from './TemplatesApp';

const hash = window.location.hash.replace(/^#\/?/, '');
const editorMatch = /^editor(?:\/(.+))?$/.exec(hash);
const templateEditorMatch = /^template-editor(?:\/(.+))?$/.exec(hash);
const fromTemplateMatch = /^editor-from-template\/(.+)$/.exec(hash);
const importMatch = /^editor-import\/(.+)$/.exec(hash);
const envEditorMatch = /^env-editor\/([^/]+)(\/new)?$/.exec(hash);
const harnessEditorMatch = /^harness-editor\/([^/]+)\/([^/]+)(\/new)?$/.exec(hash);
const modelEditorMatch = /^model-editor\/([^/]+)\/([^/]+)\/(new|\d+)$/.exec(hash);
const runDetailMatch = /^run-detail\/([^/]+)\/([^/]+)$/.exec(hash);
const noteEditorMatch = /^note-editor\/([^/]+)$/.exec(hash);

function pickRoot() {
  if (hash === 'template-picker') return <TemplatePickerApp />;
  if (hash === 'templates') return <TemplatesApp />;
  if (templateEditorMatch) {
    return (
      <EditorApp
        mode="template"
        templateId={templateEditorMatch[1] ? decodeURIComponent(templateEditorMatch[1]) : undefined}
      />
    );
  }
  if (fromTemplateMatch) return <EditorApp fromTemplateId={decodeURIComponent(fromTemplateMatch[1])} />;
  if (importMatch) return <EditorApp importKey={decodeURIComponent(importMatch[1])} />;

  if (editorMatch) return <EditorApp taskId={editorMatch[1] ? decodeURIComponent(editorMatch[1]) : undefined} />;
  if (noteEditorMatch) return <NoteEditorApp taskId={decodeURIComponent(noteEditorMatch[1])} />;
  if (modelEditorMatch) {
    return (
      <ModelEditorApp
        envId={decodeURIComponent(modelEditorMatch[1])}
        harnessId={decodeURIComponent(modelEditorMatch[2])}
        index={modelEditorMatch[3] === 'new' ? undefined : Number(modelEditorMatch[3])}
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
  if (runDetailMatch) {
    return (
      <RunDetailApp
        taskId={decodeURIComponent(runDetailMatch[1])}
        runId={decodeURIComponent(runDetailMatch[2])}
      />
    );
  }
  if (hash === 'settings') return <SettingsApp />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode>{pickRoot()}</React.StrictMode>);
