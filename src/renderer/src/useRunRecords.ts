import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunRecord } from '@shared/types';
import { subscribe } from './events';

const MAX_RECORDS = 500;

/**
 * The run records of the tasks `ids`, each task's newest MAX_RECORDS, kept
 * current. A task's list, once read, is kept while the hook is mounted, so
 * showing that task again reads nothing. `cleared`: its runs were cleared.
 */
export function useRunRecords(ids: readonly string[]): { records: Record<string, RunRecord[]>; cleared: (taskId: string) => void } {
  const [records, setRecords] = useState<Record<string, RunRecord[]>>({});
  const reading = useRef(new Set<string>());
  const key = ids.join('\n');

  useEffect(() => {
    for (const id of key ? key.split('\n') : []) {
      if (records[id] || reading.current.has(id)) continue;
      reading.current.add(id);
      void window.looper.runs
        .list(id, MAX_RECORDS)
        .then((list) => setRecords((m) => ({ ...m, [id]: list })))
        .finally(() => reading.current.delete(id));
    }
  }, [key, records]);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== 'record') return;
        setRecords((m) => {
          const list = m[e.record.taskId];
          if (!list) return m; // not read yet: its read brings it
          const next = [...list, e.record];
          return { ...m, [e.record.taskId]: next.slice(Math.max(0, next.length - MAX_RECORDS)) };
        });
      }),
    [],
  );

  const cleared = useCallback((taskId: string) => setRecords((m) => ({ ...m, [taskId]: [] })), []);
  return { records, cleared };
}
