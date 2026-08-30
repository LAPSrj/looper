import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { EditorApp } from './EditorApp';

const hash = window.location.hash.replace(/^#\/?/, '');
const editorMatch = /^editor(?:\/(.+))?$/.exec(hash);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {editorMatch ? <EditorApp taskId={editorMatch[1] ? decodeURIComponent(editorMatch[1]) : undefined} /> : <App />}
  </React.StrictMode>,
);
