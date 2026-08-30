import { useEffect, useRef } from 'react';
import type { LogLine } from '@shared/types';
import { fmtTime } from '../format';

export function EngineLog({ lines, onClose }: { lines: LogLine[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);
  return (
    <div className="engine-log">
      <div className="engine-log-header">
        <span>Engine Log</span>
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="engine-log-body" ref={ref}>
        {lines.map((l, i) => (
          <div key={i} className={`log-${l.level}`}>
            <span className="muted">{fmtTime(l.ts)}</span> {l.message}
          </div>
        ))}
      </div>
    </div>
  );
}
