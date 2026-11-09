/**
 * The keys that mean the same in every window (Windows: "Use non-standard key
 * assignments consistently throughout your program. Don't assign different
 * meanings in different windows", and none for a well-known key). Menus and the
 * toolbars' hints take them from here, so a key can't come to mean two things.
 */
export const SHORTCUTS = {
  /** A new chat in the project (the Project menu, the Chats window's File menu). */
  newChat: 'CmdOrCtrl+T',
  /** A new terminal session in the project, in both windows. */
  newTerminal: 'CmdOrCtrl+Shift+T',
  /** Task > Pause / Resume (Ctrl+P is Print everywhere else). */
  pauseResume: 'F7',
} as const;

/** The key as the toolbars' hints write it ("Ctrl+Shift+T"). */
export const hint = (accelerator: string): string => accelerator.replace('CmdOrCtrl', 'Ctrl');

/** Keys with a meaning in every Windows program: no command of Looper's takes one for something else. */
export const WELL_KNOWN_KEYS = ['CmdOrCtrl+P', 'CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+X', 'CmdOrCtrl+Z', 'CmdOrCtrl+Y', 'CmdOrCtrl+A'] as const;

/**
 * Every key Looper uses in some window or state, its pages' own included: an
 * addon's command can't take one, so a key keeps one meaning in every window.
 * A test checks that the command list's keys are all here.
 */
export const LOOPER_KEYS: readonly string[] = [
  ...WELL_KNOWN_KEYS,
  ...Object.values(SHORTCUTS),
  'F1',
  'F2',
  'F3',
  'F5',
  'Shift+F5',
  'F6',
  'Shift+F6',
  'F8',
  'Shift+F8',
  'F9',
  'Shift+F9',
  'F10',
  'Alt+F4',
  'CmdOrCtrl+F4',
  'CmdOrCtrl+,',
  'CmdOrCtrl+E',
  'CmdOrCtrl+F',
  'CmdOrCtrl+N',
  'CmdOrCtrl+Shift+N',
  'CmdOrCtrl+O',
  'CmdOrCtrl+S',
  'CmdOrCtrl+W',
  'CmdOrCtrl+Enter',
  'CmdOrCtrl+Tab',
  'CmdOrCtrl+Shift+Tab',
  'CmdOrCtrl+PageUp',
  'CmdOrCtrl+PageDown',
  'CmdOrCtrl+Shift+Q',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `CmdOrCtrl+${n}`),
];

/** The same key however its modifiers are ordered. */
export const keyId = (accelerator: string): string => accelerator.split('+').sort().join('+');
