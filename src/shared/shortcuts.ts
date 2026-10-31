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
