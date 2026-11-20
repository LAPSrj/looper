// Every screen the performance check opens. tests/perf-coverage.test.ts fails when a window route in main.tsx,
// a main window tab or a task tab has no entry here, so a new screen can't skip the check.
// `hash`: the window's route, with {placeholders} filled from the seeded data (see resolveIds in check.mjs).
// `size`: the window's size as the app opens it (the main window's by default for tabs); `contentSize`: the size is
// its page's, as the app's `contentSize` option makes it.
// `fits`: a dialog sized to fit its tallest tab; the check fails when it opens with anything scrolling.
// `via`: a window whose route holds a key only the app can make (an import, an MCP server request): check.mjs
// has the app open it, and measures the window it opened.

/** Windows, by their route in main.tsx. */
export const WINDOWS = [
  { name: 'Main window', hash: '', size: [1400, 900] },
  { name: 'Tasks view window', hash: 'view/tasks', size: [1100, 760] },
  { name: 'Task window', hash: 'item/task/{task}', size: [1100, 760] },
  { name: 'Project window', hash: 'item/project/{project}', size: [1100, 760] },
  { name: 'Chats window', hash: 'sessions', size: [1200, 800] },
  { name: 'Chat window', hash: 'sessions/{chat}/window', size: [900, 800] },
  { name: 'Terminal window', hash: 'terminal/{terminal}/Terminal', size: [900, 600] },
  { name: 'Send to Chats', hash: 'send-to-sessions', size: [520, 520] },
  { name: 'Menu level', hash: 'menu-level/0', size: [336, 436] },
  { name: 'Rename Chat', hash: 'session-rename/{chat}', size: [420, 240], fits: true },
  { name: 'Watch Task Events', hash: 'watch-events/{chat}/{task}', size: [420, 300], fits: true },
  { name: 'Settings', hash: 'settings', size: [720, 642], contentSize: true, fits: true },
  { name: 'Agent Settings', hash: 'agent-settings', size: [900, 680] },
  { name: 'MCP Server', hash: 'mcp-server/{key}', via: 'mcp', size: [560, 560] },
  { name: 'Addons', hash: 'addons', size: [560, 560], fits: true },
  { name: 'Addon settings', hash: 'addon-edit/{addon}', size: [620, 560] },
  { name: 'Addon screen window', hash: 'addon/{addon}/{addonView}/%7B%7D/Servers', size: [900, 640] },
  { name: 'Engine Log', hash: 'engine-log', size: [1000, 640] },
  { name: 'History', hash: 'history', size: [900, 640] },
  { name: 'Recycle Bin', hash: 'recycle-bin', size: [760, 520] },
  { name: 'Templates', hash: 'templates', size: [620, 520] },
  { name: 'Template picker', hash: 'template-picker', size: [620, 520] },
  { name: 'Instructions', hash: 'instructions', size: [1000, 760] },
  { name: 'About', hash: 'about', size: [360, 320], fits: true },
  { name: 'New Task', hash: 'editor', size: [900, 760] },
  { name: 'Edit Task', hash: 'editor/{task}', size: [900, 760] },
  { name: 'New Task in project', hash: 'editor-in/{project}', size: [900, 760] },
  { name: 'New Template', hash: 'template-editor/{template}/new', via: 'new-template', size: [900, 760] },
  { name: 'Edit Template', hash: 'template-editor/{template}', size: [900, 760] },
  { name: 'New Task from template', hash: 'editor-from-template/{template}', size: [900, 760] },
  { name: 'Import Task', hash: 'editor-import/{key}', via: 'import-task', size: [900, 760] },
  { name: 'Import Template', hash: 'template-import/{key}', via: 'import-template', size: [900, 760] },
  { name: 'New Task with Agent', hash: 'builder-setup', size: [620, 560] },
  { name: 'Task builder', hash: 'builder/{builder}', size: [1100, 800] },
  { name: 'Version History', hash: 'versions/{task}', size: [900, 600] },
  { name: 'Version', hash: 'version/{task}/1/view', size: [1000, 700] },
  { name: 'Version compare', hash: 'version/{task}/1/compare', size: [1000, 700] },
  { name: 'Task note', hash: 'note-editor/{task}', size: [600, 480] },
  { name: 'Folder note', hash: 'note-editor-folder/{folder}', size: [600, 480] },
  { name: 'Move to Folder', hash: 'move-to-folder/{task}', size: [420, 480] },
  { name: 'Select Window', hash: 'select-window', size: [360, 300], contentSize: true, fits: true },
  { name: 'New Folder', hash: 'folder-new', size: [420, 300], fits: true },
  { name: 'Rename Folder', hash: 'folder-rename/{folder}', size: [420, 240], fits: true },
  { name: 'New Project Folder', hash: 'project-folder-new', size: [420, 300], fits: true },
  { name: 'Rename Project Folder', hash: 'project-folder-rename/{projectFolder}', size: [420, 240], fits: true },
  { name: 'New Project', hash: 'project-new', size: [560, 528], contentSize: true, fits: true },
  { name: 'Edit Project', hash: 'project/{project}', size: [560, 528], contentSize: true, fits: true },
  { name: 'Run Options', hash: 'run-options/{task}', size: [520, 460] },
  { name: 'Continue Run', hash: 'continue-run/{task}/{run}', size: [560, 420] },
  { name: 'Send Guidance', hash: 'send-guidance/{task}/{run}', size: [560, 420] },
  { name: 'Run conversation', hash: 'messages/{task}/{run}/-/Run', size: [1000, 720] },
  { name: 'Run report', hash: 'messages/{task}/{run}/-/Run/report', size: [1000, 720] },
  { name: 'Message filter', hash: 'filter/Show%20messages%20containing/', size: [420, 240], fits: true },
  { name: 'Save as Markdown', hash: 'markdown-export/1/1/0', size: [480, 300] },
  { name: 'Image', hash: 'image/{task}/{run}/-/{imageRow}/Image', size: [900, 700] },
  { name: 'Environment', hash: 'env-editor/{env}', size: [684, 427], contentSize: true, fits: true },
  { name: 'New Environment', hash: 'env-editor/{env}/new', size: [684, 427], contentSize: true, fits: true },
  { name: 'Harness', hash: 'harness-editor/{env}/{harness}', size: [624, 637], contentSize: true, fits: true },
  { name: 'New Harness', hash: 'harness-editor/{env}/{harness}/new', size: [624, 637], contentSize: true, fits: true },
  { name: 'Model', hash: 'model-editor/{env}/{harness}/0', size: [600, 520] },
  { name: 'New Model', hash: 'model-editor/{env}/{harness}/new', size: [600, 520] },
  { name: 'Copy Model', hash: 'model-editor/{env}/{harness}/copy-0', size: [600, 520] },
  { name: 'Update Models', hash: 'model-update', size: [760, 560] },
  { name: 'Update harness models', hash: 'model-update/{env}/{harness}', size: [760, 560] },
  { name: 'Remote Control helpers', hash: 'remote-helpers', size: [760, 520] },
  { name: 'Remote Control helper', hash: 'remote-helper/{helper}', size: [560, 564], contentSize: true, fits: true },
  { name: 'New Remote Control helper', hash: 'remote-helper/{helper}/new', size: [560, 564], contentSize: true, fits: true },
  { name: 'Remote Control conversations', hash: 'remote-conversations', size: [900, 600] },
  { name: 'Remote Access settings', hash: 'remote-access-settings', size: [560, 374], contentSize: true, fits: true },
  { name: 'Remote Access setup', hash: 'remote-access-setup', size: [560, 460], contentSize: true, fits: true },
  { name: 'Remote Access devices', hash: 'remote-access-devices', size: [700, 520] },
  { name: 'Pair a device', hash: 'remote-access-pair', size: [520, 600] },
  { name: 'Rename device', hash: 'remote-access-rename/{device}', size: [420, 240], fits: true },
];

/** The main window's tabs and the screens inside them, reached by clicks as a person would. */
export const MAIN_SCREENS = [
  { name: 'Dashboard tab', tab: 'dashboard' },
  { name: 'Projects tab', tab: 'projects' },
  { name: 'Tasks tab', tab: 'tasks' },
  { name: 'Chats tab', tab: 'chats' },
  { name: 'Task status', tab: 'tasks', detail: 'status' },
  { name: 'Task runs', tab: 'tasks', detail: 'runs' },
  { name: 'Project', tab: 'projects', project: true },
  // An addon's tab inside the project (the last of its tabs), drawn from the addon's screen.
  { name: 'Project addon tab', tab: 'projects', project: true, projectTab: 'last' },
  { name: 'Chat', tab: 'chats', chat: true },
  { name: 'Terminal', tab: 'chats', terminal: true },
  { name: 'Addon tab', tab: 'addon', addon: true },
];

/**
 * A phone's screens, on iOS (WebKit) and Android (Edge), paired over Remote Access: each tab of PHONE_TABS
 * (phone-nav.ts), and each kind of screen pushed over one (PhoneScreen), reached by tapping the texts in `taps`.
 */
export const PHONE_SCREENS = [
  { name: 'Dashboard', tab: 'Dashboard' },
  { name: 'Projects', tab: 'Projects' },
  { name: 'Tasks', tab: 'Tasks' },
  { name: 'Chats', tab: 'Chats' },
  { name: 'More', tab: 'More' },
  { name: 'Folder', tab: 'Tasks', push: 'folder', taps: ['Development'] },
  { name: 'Task', tab: 'Tasks', push: 'task', taps: ['Development', 'Issue triage'] },
  { name: 'Project', tab: 'Projects', push: 'project', taps: ['Web app'] },
  { name: 'Advanced', tab: 'More', push: 'list', taps: ['Advanced'] },
  { name: 'Addon pane', tab: 'More', push: 'addon', taps: ['Servers'] },
  { name: 'Chat', tab: 'Chats', taps: [/^Chat 0 message 0/] },
];

export const PHONES = ['ios', 'android'];
