/** How long a write started by a menu pick waits for the text the computer sends. */
export const CLIPBOARD_WAIT_MS = 2000;

declare global {
  interface Window {
    /** The top frame's clipboard; the window iframes hand it their writes and reads. */
    __looperClipboard?: ClipboardBridge;
  }
}

interface PendingWrite {
  resolve: (text: string) => void;
  reject: () => void;
  timer: ReturnType<typeof setTimeout>;
  text?: string;
}

/**
 * The device's clipboard, for text that comes from the computer. Safari lets a
 * page write the clipboard only from inside a click or key press, but Copy Path
 * and the like answer later, over the WebSocket. So every menu pick starts a
 * write right away whose text is a promise, filled by the next text that
 * arrives (a `clipboard` message, or a page's writeText) within 2 s; when none
 * does, the write fails quietly and the clipboard keeps what it had.
 */
export class ClipboardBridge {
  private pending: PendingWrite | null = null;
  private read: { text: Promise<string>; at: number } | null = null;

  /** `fallback`: a write the top frame's clipboard refused, tried in the focused window's frame. */
  constructor(private readonly fallback: (text: string) => Promise<void>) {}

  /** Call inside the click or key press that picks a menu item. */
  armWrite(): void {
    this.drop();
    const clip = navigator.clipboard;
    if (!clip?.write || typeof ClipboardItem === 'undefined') return;
    let resolve!: (text: string) => void;
    let reject!: () => void;
    const blob = new Promise<Blob>((res, rej) => {
      resolve = (text) => res(new Blob([text], { type: 'text/plain' }));
      reject = () => rej(new DOMException('Nothing to copy.', 'AbortError'));
    });
    blob.catch(() => undefined);
    const entry: PendingWrite = {
      resolve,
      reject,
      timer: setTimeout(() => {
        if (this.pending === entry) this.pending = null;
        reject();
      }, CLIPBOARD_WAIT_MS),
    };
    let item: ClipboardItem;
    try {
      item = new ClipboardItem({ 'text/plain': blob });
    } catch {
      clearTimeout(entry.timer);
      return;
    }
    this.pending = entry;
    clip.write([item]).catch(() => {
      // Refused (no promise support, no permission, or the focus moved): the text goes in the ordinary way,
      // now if it came, else when it comes.
      if (this.pending === entry) {
        this.pending = null;
        clearTimeout(entry.timer);
      } else if (entry.text !== undefined) void this.writeNow(entry.text);
    });
  }

  /** Text for the clipboard: true when a write started by a pick took it. */
  offer(text: string): boolean {
    const p = this.pending;
    if (!p) return false;
    this.pending = null;
    clearTimeout(p.timer);
    p.text = text;
    p.resolve(text);
    return true;
  }

  write(text: string): void {
    if (!this.offer(text)) void this.writeNow(text);
  }

  /** Call inside the click on a Paste item: the page that pastes asks for the text a moment later. */
  armRead(): void {
    const clip = navigator.clipboard;
    if (!clip?.readText) return;
    const text = clip.readText();
    text.catch(() => undefined);
    this.read = { text, at: Date.now() };
  }

  /** The text a Paste pick read, while it's fresh. */
  takeRead(): Promise<string> | null {
    const r = this.read;
    this.read = null;
    return r && Date.now() - r.at < CLIPBOARD_WAIT_MS ? r.text : null;
  }

  private drop(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject();
  }

  private async writeNow(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      await this.fallback(text).catch(() => undefined);
    }
  }
}

/** In a window's iframe: the page's clipboard calls go through the top frame's bridge first. */
export function routeFrameClipboard(): void {
  const bridge = (window.top as Window).__looperClipboard;
  const clip = navigator.clipboard;
  if (!bridge || !clip) return;
  const writeText = clip.writeText.bind(clip);
  const readText = clip.readText.bind(clip);
  clip.writeText = (text: string) => (bridge.offer(text) ? Promise.resolve() : writeText(text));
  clip.readText = () => bridge.takeRead() ?? readText();
}
