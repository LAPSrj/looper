import type { Attachment } from './chat';

/**
 * A command the user ran from a chat's message box, as Claude Code's bash
 * mode runs one: a message that starts with "!" runs the rest in the chat's
 * working directory instead of going to the agent. Its result waits in the
 * message box as an attachment and goes to the agent with the message.
 */
export interface CommandOutput {
  /** Unique within the chat. */
  id: string;
  input: string;
  stdout: string;
  stderr: string;
  /** Its exit code once it has ended by itself; null while it runs, or once it was stopped. */
  exitCode: number | null;
  running?: boolean;
  stopped?: boolean;
  /**
   * A stream longer than MAX_COMMAND_OUTPUT was saved whole to a file in the
   * chat's folder; its text above is then only the preview (the first
   * OUTPUT_PREVIEW characters).
   */
  saved?: { stdout?: SavedOutput; stderr?: SavedOutput };
}

/**
 * What a running "!" command asks the user for (sudo's password), shown by the
 * device that ran it: the answer goes back to the command's program, and is
 * kept nowhere.
 */
export interface CommandPrompt {
  /** Names this ask, so an answer can't reach a later one. */
  id: string;
  text: string;
  /** The answer is a password: its field hides it. */
  secret: boolean;
  /** The command asked this before and its answer didn't work. */
  retry: boolean;
}

/** A command's whole output, saved to a file because it was too long to send. */
export interface SavedOutput {
  /** The file, as the agent's target names it (the path the agent gets, and Open opens). */
  path: string;
  /** Its full size, in bytes. */
  bytes: number;
}

/**
 * The output a command sends inline, per stream, as Claude Code's own default
 * (BASH_MAX_OUTPUT_LENGTH, 30000 characters): past it, the whole output goes
 * to a file, and the agent gets a preview and the file's path.
 */
export const MAX_COMMAND_OUTPUT = 30_000;
/** The preview of output saved to a file: Claude Code's "Preview (first 2KB)". */
export const OUTPUT_PREVIEW = 2_048;

/** A size as Claude Code writes it: "512B", "363.5KB", "12.4MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** "363.5KB" back to bytes (as near as the text says). */
function sizeBytes(text: string): number {
  const m = /^([\d.]+)(B|KB|MB)$/.exec(text.trim());
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] === 'MB' ? 1024 * 1024 : m[2] === 'KB' ? 1024 : 1));
}

/** Live output past MAX_COMMAND_OUTPUT: its last part, as a terminal keeps the newest lines in view. */
export function outputTail(text: string, max = MAX_COMMAND_OUTPUT): string {
  return text.length <= max ? text : `…\n${text.slice(-max)}`;
}

/**
 * A message box going into bash mode, as Claude Code's does: "!" typed, or
 * text starting with "!" pasted, into the empty box. The command line it then
 * holds (without the "!", which becomes the prompt); null when the box stays a
 * message box.
 */
export function bashModeEntry(before: string, after: string): string | null {
  return before === '' && after.startsWith('!') ? after.slice(1) : null;
}

/** Output past MAX_COMMAND_OUTPUT: its start and end, with how much was left out between. */
export function capOutput(text: string, max = MAX_COMMAND_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… ${text.length - 2 * half} characters left out …\n${text.slice(-half)}`;
}

/** A finished command as the attachment its message carries. */
export function commandAttachment(c: CommandOutput): Attachment {
  return { name: `! ${c.input}`, path: '', image: false, command: c };
}

const commandsOf = (attachments: Attachment[]): CommandOutput[] => attachments.flatMap((a) => (a.command ? [a.command] : []));

/** The attachments that are files (the agent reads them, or sees an image), without the commands. */
export const fileAttachments = (attachments: Attachment[]): Attachment[] => attachments.filter((a) => !a.command);

/** The message the agent gets: the user's text, then the paths of the files it reads itself. */
export function withFileList(text: string, files: string[]): string {
  if (files.length === 0) return text;
  const list = files.map((f) => `- ${f}`).join('\n');
  return `${text}\n\nAttached files (read them from these paths):\n${list}`.trim();
}

const FILE_LIST = /(?:^|\n\n)Attached files \(read them from these paths\):((?:\n- [^\n]+)+)(?=\n\n|$)/g;

/**
 * A message from a transcript, the other way: the files of each list
 * withFileList put in it (a turn's queued messages go as one, each with its
 * own), through `attachment`, and the text without the lists. The text stays
 * whole when a listed path isn't one of Looper's attachment copies.
 */
export function parseFileList(message: string, attachment: (agentPath: string) => Attachment | null): { files: Attachment[]; text: string } {
  const files: Attachment[] = [];
  for (const m of message.matchAll(FILE_LIST)) {
    for (const line of m[1].split('\n').slice(1)) {
      const a = attachment(line.slice(2));
      if (!a) return { files: [], text: message };
      files.push(a);
    }
  }
  return files.length ? { files, text: message.replace(FILE_LIST, '').trim() } : { files, text: message };
}

const EXIT_LINE = /\n?Exit code (\d+)$/;
const STOPPED_LINE = /\n?Stopped by the user$/;

/**
 * A stream saved to a file, as Claude Code hands the model a large tool
 * output: its size, the file's path, and a preview (Claude Code 2.1's
 * <persisted-output> wording).
 */
export function persistedText(preview: string, saved: SavedOutput): string {
  return `<persisted-output>\nOutput too large (${sizeText(saved.bytes)}). Full output saved to: ${saved.path}\n\nPreview (first 2KB):\n${preview}\n</persisted-output>`;
}

const PERSISTED = /^<persisted-output>\nOutput too large \(([^)]*)\)\. Full output saved to: ([^\n]*)\n\nPreview \(first 2KB\):\n([\s\S]*)\n<\/persisted-output>/;

/** One command in Claude Code's own bash-mode format; a non-zero exit code, or a stop, is the last line of stderr. */
function commandBlock(c: CommandOutput): string {
  const tail = c.stopped ? 'Stopped by the user' : c.exitCode ? `Exit code ${c.exitCode}` : '';
  const stream = (text: string, saved: SavedOutput | undefined) => (saved ? persistedText(text.replace(/\n+$/, ''), saved) : text.replace(/\n+$/, ''));
  const out = stream(c.stdout, c.saved?.stdout);
  const err = stream(c.stderr, c.saved?.stderr);
  const stderr = tail ? (err ? `${err}\n${tail}` : tail) : err;
  return `<bash-input>${c.input}</bash-input>\n<bash-stdout>${out}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
}

/**
 * The message the agent gets for `text` with these attachments: each command
 * the user ran, with its output, ahead of the text, as Claude Code puts them
 * in the conversation (<bash-input>, <bash-stdout>, <bash-stderr>).
 */
export function withCommands(text: string, attachments: Attachment[]): string {
  const commands = commandsOf(attachments);
  if (commands.length === 0) return text;
  const blocks = commands.map(commandBlock).join('\n\n');
  return text ? `${blocks}\n\n${text}` : blocks;
}

const BLOCK = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*(?:<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*<bash-stderr>([\s\S]*?)<\/bash-stderr>)?/;
const OUTPUT_ONLY = /^\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*<bash-stderr>([\s\S]*?)<\/bash-stderr>\s*$/;

/** A stream's text as the agent got it: the preview and the file when it was saved, else the text. */
function streamOf(text: string): { text: string; saved?: SavedOutput } {
  const m = PERSISTED.exec(text);
  if (!m) return { text: capOutput(text) };
  return { text: m[3], saved: { path: m[2], bytes: sizeBytes(m[1]) } };
}

function outputOf(id: string, input: string, stdoutRaw: string, stderrRaw: string): CommandOutput {
  let stderr = stderrRaw;
  let exitCode: number | null = 0;
  let stopped = false;
  const exit = EXIT_LINE.exec(stderr);
  if (exit) {
    exitCode = Number(exit[1]);
    stderr = stderr.slice(0, exit.index);
  } else if (STOPPED_LINE.test(stderr)) {
    stopped = true;
    exitCode = null;
    stderr = stderr.replace(STOPPED_LINE, '');
  }
  const out = streamOf(stdoutRaw);
  const err = streamOf(stderr);
  const saved = out.saved || err.saved ? { ...(out.saved ? { stdout: out.saved } : {}), ...(err.saved ? { stderr: err.saved } : {}) } : undefined;
  return { id, input, stdout: out.text, stderr: err.text, exitCode, ...(stopped ? { stopped } : {}), ...(saved ? { saved } : {}) };
}

/**
 * A message from a transcript, the other way: the commands at its start
 * (Looper's withCommands, or Claude Code's own bash mode, which records the
 * input alone), and the text after them. `idPrefix` keeps the ids apart.
 */
export function parseCommands(message: string, idPrefix: string): { commands: CommandOutput[]; text: string } {
  const commands: CommandOutput[] = [];
  let rest = message;
  for (let m = BLOCK.exec(rest); m; m = BLOCK.exec(rest)) {
    const id = `${idPrefix}-${commands.length}`;
    commands.push(m[2] === undefined ? { id, input: m[1], stdout: '', stderr: '', exitCode: null } : outputOf(id, m[1], m[2], m[3]));
    rest = rest.slice(m[0].length);
  }
  return { commands, text: commands.length ? rest.trim() : message };
}

/** Claude Code's own bash mode records a command's output as a message of its own: its stdout and stderr, else null. */
export function parseOutputOnly(message: string): { stdout: string; stderr: string } | null {
  const m = OUTPUT_ONLY.exec(message);
  return m ? { stdout: m[1], stderr: m[2] } : null;
}

/** A command's output filled in from Claude Code's output message. */
export function withOutput(c: CommandOutput, out: { stdout: string; stderr: string }): CommandOutput {
  return outputOf(c.id, c.input, out.stdout, out.stderr);
}

/**
 * A command attachment from outside the engine (a window's draft or message),
 * checked field by field; null when it isn't one, or still runs.
 */
export function commandFrom(v: unknown): CommandOutput | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.input !== 'string' || c.running) return null;
  const str = (x: unknown) => capOutput(typeof x === 'string' ? x : '');
  const file = (x: unknown): SavedOutput | undefined => {
    const s = x as Record<string, unknown> | undefined;
    return s && typeof s.path === 'string' && s.path && typeof s.bytes === 'number' ? { path: s.path, bytes: s.bytes } : undefined;
  };
  const savedIn = (c.saved ?? {}) as Record<string, unknown>;
  const saved = { stdout: file(savedIn.stdout), stderr: file(savedIn.stderr) };
  return {
    id: c.id,
    input: c.input,
    stdout: str(c.stdout),
    stderr: str(c.stderr),
    exitCode: typeof c.exitCode === 'number' ? c.exitCode : null,
    ...(c.stopped === true ? { stopped: true } : {}),
    ...(saved.stdout || saved.stderr
      ? { saved: { ...(saved.stdout ? { stdout: saved.stdout } : {}), ...(saved.stderr ? { stderr: saved.stderr } : {}) } }
      : {}),
  };
}
