import type { OfflineBackend, OfflineBatch, OfflineEntry, OfflineMeta, OfflineStore } from './offline-store';

const DB_NAME = 'looper-offline';
const META_KEY = 'meta';

const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/** The entries and the meta record in the `looper-offline` database; load and save reject where IndexedDB doesn't work. */
export function idbBackend(): OfflineBackend {
  let opening: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> =>
    (opening ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('entries', { keyPath: 'key' });
        req.result.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  return {
    async load() {
      const tx = (await db()).transaction(['entries', 'meta'], 'readonly');
      const [entries, meta] = await Promise.all([done(tx.objectStore('entries').getAll()), done(tx.objectStore('meta').get(META_KEY))]);
      return { entries: entries as OfflineEntry[], meta: (meta as OfflineMeta | undefined) ?? null };
    },
    async save(batch: OfflineBatch) {
      const tx = (await db()).transaction(['entries', 'meta'], 'readwrite');
      const entries = tx.objectStore('entries');
      if (batch.clear) entries.clear();
      for (const key of batch.del) entries.delete(key);
      for (const e of batch.put) entries.put(e);
      if (batch.meta) tx.objectStore('meta').put(batch.meta, META_KEY);
      await finished(tx);
    },
  };
}

/** Writes the store out when the page goes to the background or closes: a page iOS suspends gets no later chance. */
export function flushWhenHidden(store: OfflineStore): void {
  window.addEventListener('pagehide', () => void store.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void store.flush();
  });
}
