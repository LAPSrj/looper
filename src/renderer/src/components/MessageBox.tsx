import { useRef } from 'react';
import { sendsOnEnter } from './composer-text';
import { useBoxHeight } from './hooks';
import { useAutoGrow } from './phone/auto-grow';
import { isPhone } from '../web/page-nav';

/** Whether this key sends here: Enter on the desktop (Shift+Enter breaks the line), and a phone's Enter breaks it. */
export const sendsOnEnterHere = (e: Parameters<typeof sendsOnEnter>[0]): boolean => sendsOnEnter(e, isPhone);

/** A phone message box's Send: an arrow, as in Messages. */
export const ARROW_UP = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 14.5v-11M4.5 8 9 3.5 13.5 8" />
  </svg>
);

/** Stop beside a message box's Send: whether it applies now, and what it does. */
export interface MessageBoxStop {
  enabled: boolean;
  run: () => void;
}

/**
 * How a message box looks, by where it is:
 * - `chat`: a chat's look (the Composer's layout, without its command bar, files and "/" list) on the desktop, a box
 *   of three lines with Send beside it on a phone. A task run's guidance and a subagent's message.
 * - `card`: a dashboard card's reply: the chat look on the desktop, one line that grows and a small Send on a phone.
 * - `builder`: the task builder's: a box of three lines with Send beside it on the desktop, the chat's growing box
 *   with its arrow on a phone.
 */
export type MessageBoxLook = 'chat' | 'card' | 'builder';

/**
 * A message box: the text and Send (and Stop, on the desktop's chat look). Enter sends on the desktop and
 * Shift+Enter breaks the line; a phone's Enter breaks the line and Ctrl+Enter or Cmd+Enter sends.
 */
export function MessageBox({
  text,
  onText,
  placeholder,
  shortPlaceholder,
  canSend,
  onSend,
  stop,
  look = 'chat',
  disabled,
  autoFocus,
}: {
  text: string;
  onText: (text: string) => void;
  placeholder: string;
  /** The placeholder where the box is narrow (a phone); unset: `placeholder`. */
  shortPlaceholder?: string;
  canSend: boolean;
  onSend: () => void;
  /** No Stop button when unset; only the desktop's chat look shows it. */
  stop?: MessageBoxStop;
  look?: MessageBoxLook;
  disabled?: boolean;
  /** Takes the focus as it shows, on the desktop. */
  autoFocus?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const box = useBoxHeight(rootRef);
  const growRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(growRef, text, look === 'card' ? 120 : 150, isPhone && look !== 'chat');
  const send = () => {
    if (canSend) onSend();
  };
  const textarea = (rows: number) => (
    <textarea
      ref={growRef}
      rows={rows}
      value={text}
      placeholder={isPhone && shortPlaceholder ? shortPlaceholder : placeholder}
      autoFocus={autoFocus && !isPhone}
      disabled={disabled}
      onChange={(e) => onText(e.target.value)}
      onKeyDown={(e) => {
        // The builder's box sends on Enter with Ctrl held too.
        const sends = look === 'builder' && !isPhone ? e.key === 'Enter' && !e.shiftKey : sendsOnEnter(e, isPhone);
        if (!sends) return;
        e.preventDefault();
        send();
      }}
    />
  );
  // A card opens on a click; a click in its box stays in the box.
  const keep = (e: React.MouseEvent) => e.stopPropagation();

  if (look === 'builder') {
    if (isPhone) {
      return (
        <div className="chat-composer phone-composer">
          <div className="phone-composer-row">
            <div className="composer-input phone-composer-box">
              {textarea(1)}
              {/* The box keeps the focus, so the keyboard stays up. */}
              <button className="phone-composer-action send" aria-label="Send" disabled={!canSend} onMouseDown={(e) => e.preventDefault()} onClick={send}>
                {ARROW_UP}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="chat-composer">
        {textarea(3)}
        <button className="btn primary" disabled={!canSend} onClick={send}>
          Send
        </button>
      </div>
    );
  }

  if (isPhone) {
    if (look === 'card') {
      return (
        <div className="overview-actions" onClick={keep}>
          {textarea(1)}
          <button className="btn small" disabled={!canSend} onClick={send}>
            Send
          </button>
        </div>
      );
    }
    return (
      <div className="guidance-compose">
        {textarea(3)}
        <button className="btn primary" disabled={!canSend} onClick={send}>
          Send
        </button>
      </div>
    );
  }

  const chat = (
    <div className="chat-composer" ref={rootRef}>
      <div className="composer-main">
        <div className="composer-input" style={{ minHeight: box.minHeight }}>
          <div className="composer-grip" onMouseDown={box.onGrip} />
          {textarea(3)}
        </div>
      </div>
      <div className="composer-actions">
        <button className="btn primary" disabled={!canSend} onClick={send}>
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
  return look === 'card' ? (
    <div className="overview-composer" onClick={keep}>
      {chat}
    </div>
  ) : (
    chat
  );
}
