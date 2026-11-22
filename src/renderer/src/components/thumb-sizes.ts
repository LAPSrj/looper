import { useEffect, useState } from 'react';
import type { MessageRow, SentFileInfo } from '@shared/messages';
import type { ChatItem } from './chat-groups';

/**
 * A message's thumbnails drawn at their size from their first frame. A thumbnail's size is known only once it's
 * fetched (the thumbnail worker makes it, main/thumbnails.ts) and decoded: drawn before that, its message grew when
 * it came, and above the reader that pushed what they read. So a conversation fetches the thumbnails of the older
 * items it's about to draw first (prefetchThumbs), and each message draws its `<img>` with its width and height.
 */

/** The most a message's thumbnail is drawn at: `.chat-thumb img` in styles.css. */
const MAX_WIDTH = 220;
const MAX_HEIGHT = 120;
/** Fetched thumbnails kept for the page: a phone's long chat holds a few dozen. */
const KEEP = 300;

/** A thumbnail as it's drawn: its data URL and its size in CSS px, fitted in MAX_WIDTH × MAX_HEIGHT. */
export interface ShownThumb {
  src: string;
  width: number;
  height: number;
}

/** What a thumbnail's request returned (a data URL, or a sent file's details), and its thumbnail when it has one it can draw. */
export interface Shown<T> {
  value: T;
  thumb: ShownThumb | null;
}

const done = new Map<string, Shown<unknown> | null>();
const pending = new Map<string, Promise<Shown<unknown> | null>>();

async function decoded(src: string): Promise<ShownThumb | null> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!w || !h) return null;
  const scale = Math.min(1, MAX_WIDTH / w, MAX_HEIGHT / h);
  return { src, width: Math.round(w * scale), height: Math.round(h * scale) };
}

/** Asks `load` again and decodes its thumbnail; one request at a time for each key. */
function fetchShown<T>(key: string, load: () => Promise<T | null>, src: (v: T) => string | null | undefined): Promise<Shown<T> | null> {
  let p = pending.get(key) as Promise<Shown<T> | null> | undefined;
  if (!p) {
    p = load()
      .then(async (value) => {
        if (value === null || value === undefined) return null;
        const url = src(value);
        return { value, thumb: url ? await decoded(url).catch(() => null) : null };
      })
      .catch(() => null)
      .then((shown) => {
        pending.delete(key);
        done.delete(key);
        done.set(key, shown);
        if (done.size > KEEP) done.delete(done.keys().next().value!);
        return shown;
      });
    pending.set(key, p);
  }
  return p;
}

const same = (a: Shown<unknown> | null | undefined, b: Shown<unknown> | null): boolean =>
  a === b || (!!a && !!b && a.thumb?.src === b.thumb?.src && JSON.stringify(a.value) === JSON.stringify(b.value));

/**
 * What `load` returns with its thumbnail, as useThumbnail does: undefined while it loads, null when it has nothing.
 * One fetched before (prefetchThumbs) is there from the first frame; it's asked for again all the same, so a file
 * changed since shows as it is now.
 */
export function useShown<T>(key: string, load: () => Promise<T | null>, src: (v: T) => string | null | undefined): Shown<T> | null | undefined {
  const [state, setState] = useState(() => ({ key, shown: done.get(key) as Shown<T> | null | undefined }));
  useEffect(() => {
    let live = true;
    void fetchShown(key, load, src).then((shown) => {
      if (live) setState((s) => (s.key === key && same(s.shown, shown) ? s : { key, shown }));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state.shown : (done.get(key) as Shown<T> | null | undefined);
}

export const attachmentThumbKey = (path: string): string => `a\0${path}`;
export const sentThumbKey = (taskId: string, path: string): string => `s\0${taskId}\0${path}`;
export const loadAttachmentThumb = (path: string) => (): Promise<string | null> => window.looper.attachment.thumbnail(path);
export const loadSentFile = (taskId: string, path: string) => (): Promise<SentFileInfo | null> => window.looper.sessions.sentFile(taskId, path);
export const sentThumbSrc = (info: SentFileInfo): string | undefined => info.thumbnail;

/** Fetches the thumbnails the rows of `items` draw (a user's attached images, the images an agent sent); null when they have none to fetch. */
export function prefetchThumbs(items: readonly ChatItem[], taskId: string): Promise<void> | null {
  const loads: Promise<unknown>[] = [];
  const rowsOf = (item: ChatItem): MessageRow[] => (item.kind === 'row' ? [item.row] : item.rows);
  for (const row of items.flatMap(rowsOf)) {
    for (const a of row.attachments ?? []) {
      const key = attachmentThumbKey(a.path);
      if (a.image && a.path && !done.has(key)) loads.push(fetchShown(key, loadAttachmentThumb(a.path), (s) => s));
    }
    for (const f of row.sent?.files ?? []) {
      const key = sentThumbKey(taskId, f.path);
      if (f.inline && !done.has(key)) loads.push(fetchShown(key, loadSentFile(taskId, f.path), sentThumbSrc));
    }
  }
  return loads.length ? Promise.all(loads).then(() => undefined) : null;
}
