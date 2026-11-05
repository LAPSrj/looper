import { useRef } from 'react';
import { sendsOnEnter } from './composer-text';
import { useBoxHeight } from './hooks';

/** Stop beside a message box's Send: whether it applies now, and what it does. */
export interface MessageBoxStop {
  enabled: boolean;
  run: () => void;
}

/**
 * A desktop message box with a chat's look (the Composer's layout and classes,
 * without its command bar, files and "/" list): a box of three lines (taller
 * when its top border is dragged), with Send above Stop beside it. Enter sends and Shift+Enter breaks the line. A task run's
 * guidance box and a terminal session's dashboard card use it.
 */
export function MessageBox({
  text,
  onText,
  placeholder,
  canSend,
  onSend,
  stop,
}: {
  text: string;
  onText: (text: string) => void;
  placeholder: string;
  canSend: boolean;
  onSend: () => void;
  /** No Stop button when unset. */
  stop?: MessageBoxStop;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const box = useBoxHeight(rootRef);
  return (
    <div className="chat-composer" ref={rootRef}>
      <div className="composer-main">
        <div className="composer-input" style={{ minHeight: box.minHeight }}>
          <div className="composer-grip" onMouseDown={box.onGrip} />
          <textarea
            rows={3}
            value={text}
            placeholder={placeholder}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={(e) => {
              if (!sendsOnEnter(e, false)) return;
              e.preventDefault();
              if (canSend) onSend();
            }}
          />
        </div>
      </div>
      <div className="composer-actions">
        <button className="btn primary" disabled={!canSend} onClick={onSend}>
          Send
        </button>
        {stop && (
          <button className="btn" disabled={!stop.enabled} onClick={stop.run}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
