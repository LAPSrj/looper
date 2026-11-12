import { useRef, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react';
import { sendsOnEnter } from './composer-text';
import { useBoxHeight } from './hooks';
import { useAutoGrow } from './phone/auto-grow';
import { isPhone } from '../web/page-nav';

/** Whether this key sends here: Enter on the desktop (Shift+Enter breaks the line), and a phone's Enter breaks it. */
export const sendsOnEnterHere = (e: Parameters<typeof sendsOnEnter>[0]): boolean => sendsOnEnter(e, isPhone);

/** A phone message box's Send: an arrow, as in Messages. */
const ARROW_UP = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 14.5v-11M4.5 8 9 3.5 13.5 8" />
  </svg>
);
const STOP = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="3.5" y="3.5" width="9" height="9" rx="2" />
  </svg>
);

/** Stop beside a message box's Send: whether it applies now, and what it does. */
export interface MessageBoxStop {
  enabled: boolean;
  run: () => void;
  /** The desktop button's tooltip (its shortcut). */
  title?: string;
}

/** What Send does now, which names its button: send, queue behind the agent's turn, or run a command. */
export type MessageBoxAction = 'send' | 'queue' | 'run';

const LABELS: Record<MessageBoxAction | 'stop', string> = { send: 'Send', queue: 'Queue', run: 'Run', stop: 'Stop' };

/**
 * The message box, the same for a chat, a subagent, a task run's guidance, a dashboard card's reply and the task
 * builder. On the desktop: the box, with Send (and Stop) beside it, and its top border drags to make it taller. On a
 * phone, as Messages draws it: a capsule that starts at one line and grows to six, with one round button at its
 * trailing edge (Send, Queue or Stop). Enter sends on the desktop and Shift+Enter breaks the line; a phone's Enter
 * breaks the line and Ctrl+Enter or Cmd+Enter sends. A chat adds its own parts: `bar`, `plus`, `pending`, `inside`.
 */
export function MessageBox({
  text,
  onText,
  placeholder,
  shortPlaceholder,
  canSend,
  onSend,
  action = 'send',
  stop,
  disabled,
  autoFocus,
  bash,
  bar,
  plus,
  pending,
  inside,
  inputRef,
  input,
}: {
  text: string;
  onText?: (text: string) => void;
  placeholder: string;
  /** The placeholder where the box is narrow (a phone); unset: `placeholder`. */
  shortPlaceholder?: string;
  canSend: boolean;
  onSend: () => void;
  action?: MessageBoxAction;
  /** No Stop when unset. */
  stop?: MessageBoxStop;
  disabled?: boolean;
  /** Takes the focus as it shows, on the desktop. */
  autoFocus?: boolean;
  /** The box is a command line (a chat's bash mode). */
  bash?: boolean;
  /** Over the box on the desktop: a chat's command bar. */
  bar?: ReactNode;
  /** Beside the box on a phone: a chat's + menu. */
  plus?: ReactNode;
  /** The files waiting to go with the message: over the box on the desktop, in it on a phone. */
  pending?: ReactNode;
  /** In the box, ahead of its text: a chat's "/" list and bash mode's prompt. */
  inside?: ReactNode;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** The text box's own handlers and attributes, over the ones here (a chat's keys, caret and paste). */
  input?: TextareaHTMLAttributes<HTMLTextAreaElement>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const box = useBoxHeight(rootRef);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  useAutoGrow(ref, text, 150, isPhone);
  const textarea = (
    <textarea
      ref={ref}
      rows={isPhone ? 1 : 3}
      value={text}
      placeholder={isPhone && shortPlaceholder ? shortPlaceholder : placeholder}
      autoFocus={autoFocus && !isPhone}
      disabled={disabled}
      onChange={(e) => onText?.(e.target.value)}
      onKeyDown={(e) => {
        if (!sendsOnEnter(e, isPhone)) return;
        e.preventDefault();
        if (canSend) onSend();
      }}
      {...input}
    />
  );

  if (isPhone) {
    const mode = action !== 'run' && stop?.enabled && !canSend ? 'stop' : action;
    return (
      <div className="chat-composer phone-composer">
        <div className="phone-composer-row">
          {plus}
          <div className={`composer-input phone-composer-box${bash ? ' bash-mode' : ''}`}>
            {pending}
            {inside}
            {textarea}
            <button
              className={`phone-composer-action ${mode}`}
              aria-label={LABELS[mode]}
              disabled={mode !== 'stop' && !canSend}
              // The box keeps the focus, so the keyboard stays up.
              onMouseDown={(e) => e.preventDefault()}
              onClick={mode === 'stop' ? stop!.run : onSend}
            >
              {mode === 'stop' ? STOP : ARROW_UP}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-composer" ref={rootRef}>
      <div className="composer-main">
        {bar}
        {pending}
        <div className={`composer-input${bash ? ' bash-mode' : ''}`} style={{ minHeight: box.minHeight }}>
          <div className="composer-grip" onMouseDown={box.onGrip} />
          {inside}
          {textarea}
        </div>
      </div>
      <div className="composer-actions">
        <button className="btn primary" disabled={!canSend} onClick={onSend}>
          {LABELS[action]}
        </button>
        {stop && (
          <button className="btn" title={stop.title} disabled={!stop.enabled} onClick={stop.run}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
