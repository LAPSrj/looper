/**
 * A background command's output, read a piece at a time: a poll gets only what was added since the reader's last
 * read, and nothing at all while the command is quiet (CLAUDE.md: a poll asks whether anything changed before it
 * reads).
 */
export interface OutputRead {
  /** The byte after the text: the next read passes it back as `known`. */
  end: number;
  /** The byte the text starts at: the reader's `known` when it follows on, else the start of a tail that replaces what it had. */
  from: number;
  /** Unset when nothing was added. */
  text?: string;
}

/** What a reader keeps of the output: where it ends in the file, its text, and whether earlier output is left out. */
export interface OutputShown {
  end: number;
  text: string;
  cut: boolean;
}

/** Most of the output a reader keeps, in characters; past it the oldest lines go. */
export const OUTPUT_KEPT_CHARS = 512 * 1024;

/** The output after a read: the new text added to what was kept when it follows on, else in its place. `prev` itself when nothing changed. */
export function mergeOutput(prev: OutputShown | null, read: OutputRead, max = OUTPUT_KEPT_CHARS): OutputShown {
  const follows = prev !== null && read.from === prev.end;
  if (prev && (read.text === undefined || (follows && read.text === '' && read.end === prev.end))) return prev;
  let text = follows ? prev.text + (read.text ?? '') : (read.text ?? '');
  let cut = follows ? prev.cut : read.from > 0;
  if (text.length > max) {
    const nl = text.indexOf('\n', text.length - max);
    text = nl === -1 ? text.slice(text.length - max) : text.slice(nl + 1);
    cut = true;
  }
  return { end: read.end, text, cut };
}

/** How many bytes at the start of `buf` are whole UTF-8 characters: a read that ends inside one leaves it for the next. */
export function wholeUtf8(buf: Uint8Array): number {
  let i = buf.length - 1;
  // Back over the continuation bytes (at most three) to the lead byte of the last character.
  while (i >= 0 && buf.length - 1 - i < 3 && (buf[i] & 0xc0) === 0x80) i--;
  if (i < 0) return buf.length;
  const lead = buf[i];
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i >= size ? buf.length : i;
}
