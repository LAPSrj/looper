import type { SlashCommand } from '../../../shared/sessions';

/**
 * Whether a key press in a chat message box sends. On the desktop that's Enter
 * (Shift adds a line break; Ctrl is Send Now's key). On a phone or tablet Enter
 * adds a line break and Ctrl+Enter or Cmd+Enter, from a hardware keyboard, sends.
 */
export function sendsOnEnter(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, mobile: boolean): boolean {
  if (e.key !== 'Enter') return false;
  return mobile ? e.ctrlKey || e.metaKey : !e.shiftKey && !e.ctrlKey;
}

/** Selected text as a Markdown quote for the message box: each line after "> ", then an empty line. */
export function quoteText(selection: string): string {
  const body = selection.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  if (!body.trim()) return '';
  return `${body
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n')}\n\n`;
}

/** The "/" list's matches: the commands whose name starts with what follows the "/", then those that contain it. */
export function matchCommands(commands: SlashCommand[], typed: string, limit = 50): SlashCommand[] {
  const q = typed.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

/**
 * The command being typed at the cursor: a word that starts with one of
 * `triggers` ("/", or Codex's "$") at the start of the box or after a space or
 * line break, up to the cursor. `start` is where its trigger is; `query` what
 * follows it. Null when the cursor isn't in such a word, or the word is a path
 * ("/home/me").
 */
export function commandAt(text: string, caret: number, triggers: string[]): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)(\S*)$/.exec(before);
  if (!m) return null;
  const word = m[2];
  if (!word || !triggers.includes(word[0])) return null;
  const query = word.slice(1);
  if (/[/\\$]/.test(query)) return null;
  // The cursor is inside the word, not before more of it.
  if (/^\S/.test(text.slice(caret))) return null;
  return { start: caret - word.length, query };
}

/** The box after picking a command for the word at `start`: the command and a space replace it; the cursor goes after them. */
export function insertCommand(text: string, start: number, caret: number, command: string): { text: string; caret: number } {
  const rest = text.slice(caret).replace(/^[ \t]+/, '');
  const head = `${text.slice(0, start)}${command} `;
  return { text: head + rest, caret: head.length };
}
