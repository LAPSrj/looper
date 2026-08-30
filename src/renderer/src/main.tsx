import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { EditorApp } from './EditorApp';
import { SettingsApp } from './SettingsApp';

const hash = window.location.hash.replace(/^#\/?/, '');
const editorMatch = /^editor(?:\/(.+))?$/.exec(hash);

function pickRoot() {
  if (hash === 'editor-example') return <EditorApp example />;
  if (editorMatch) return <EditorApp taskId={editorMatch[1] ? decodeURIComponent(editorMatch[1]) : undefined} />;
  if (hash === 'settings') return <SettingsApp />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode>{pickRoot()}</React.StrictMode>);
