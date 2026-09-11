import React from 'react';
import { createRoot } from 'react-dom/client';
import { isLooperFileName } from '@shared/files';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { AboutApp } from './AboutApp';
import { App } from './App';
import { EditorApp } from './EditorApp';
import { EngineLogApp } from './EngineLogApp';
import { InstructionsApp } from './InstructionsApp';
import { EnvEditorApp } from './EnvEditorApp';
import { HarnessEditorApp } from './HarnessEditorApp';
import { ModelEditorApp } from './ModelEditorApp';
import { FilterApp } from './FilterApp';
import { FolderNameApp } from './FolderNameApp';
import { FolderNoteApp } from './FolderNoteApp';
import { MoveToFolderApp } from './MoveToFolderApp';
import { ImageApp } from './ImageApp';
import { MarkdownExportApp } from './MarkdownExportApp';
import { MessagesApp } from './MessagesApp';
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
const templateImportMatch = /^template-import\/(.+)$/.exec(hash);
const envEditorMatch = /^env-editor\/([^/]+)(\/new)?$/.exec(hash);
const harnessEditorMatch = /^harness-editor\/([^/]+)\/([^/]+)(\/new)?$/.exec(hash);
const modelEditorMatch = /^model-editor\/([^/]+)\/([^/]+)\/(new|\d+)$/.exec(hash);
const runDetailMatch = /^run-detail\/([^/]+)\/([^/]+)$/.exec(hash);
const messagesMatch = /^messages\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(hash);
const imageMatch = /^image\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(hash);
const filterMatch = /^messages-filter(?:\/(.*))?$/.exec(hash);
const markdownExportMatch = /^markdown-export\/([01])\/([01])\/([01])$/.exec(hash);
const noteEditorMatch = /^note-editor\/([^/]+)$/.exec(hash);
const folderNoteMatch = /^note-editor-folder\/([^/]+)$/.exec(hash);
const moveToFolderMatch = /^move-to-folder\/([^/]+)$/.exec(hash);
const folderRenameMatch = /^folder-rename\/([^/]+)$/.exec(hash);
const folderNewMatch = /^folder-new(?:\/([^/]+))?$/.exec(hash);

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
  if (templateImportMatch) return <EditorApp mode="template" importKey={decodeURIComponent(templateImportMatch[1])} />;

  if (editorMatch) return <EditorApp taskId={editorMatch[1] ? decodeURIComponent(editorMatch[1]) : undefined} />;
  if (noteEditorMatch) return <NoteEditorApp taskId={decodeURIComponent(noteEditorMatch[1])} />;
  if (folderNoteMatch) return <FolderNoteApp folderId={decodeURIComponent(folderNoteMatch[1])} />;
  if (moveToFolderMatch) return <MoveToFolderApp taskId={decodeURIComponent(moveToFolderMatch[1])} />;
  if (folderNewMatch) return <FolderNameApp parentId={folderNewMatch[1] ? decodeURIComponent(folderNewMatch[1]) : undefined} />;
  if (folderRenameMatch) return <FolderNameApp folderId={decodeURIComponent(folderRenameMatch[1])} />;
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
  if (messagesMatch) {
    return (
      <MessagesApp
        taskId={decodeURIComponent(messagesMatch[1])}
        runId={decodeURIComponent(messagesMatch[2])}
        agentId={messagesMatch[3] === '-' ? undefined : decodeURIComponent(messagesMatch[3])}
        title={decodeURIComponent(messagesMatch[4])}
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
// (.loopertask/.loopertpl) imports instead, as if it had been double-clicked.
// In-app drags (list reordering) carry no files and fall through untouched.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && isLooperFileName(file.name)) void window.looper.openLooperFile(file);
});

createRoot(document.getElementById('root')!).render(<React.StrictMode>{pickRoot()}</React.StrictMode>);
