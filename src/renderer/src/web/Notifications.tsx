import { useLayoutEffect, useRef } from 'react';
import { platform } from '../platform';
import type { ShellController } from './controller';
import { CLOSE } from './NavBarRow';
import type { Toast } from './store';
import { CloseButton } from './ws-titlebar';

interface NotificationsProps {
  controller: ShellController;
  toasts: Toast[];
  /** Android: the page draws its own tab bar at the bottom, which the snackbar stays above. */
  ownsBottom?: boolean;
}

/**
 * What the computer tells this device while Looper is open in it (a task
 * ended): each OS's own way of showing it. iOS: banners stacked at the top, a
 * tap opens one and a flick up sends it away. Android: the newest as a
 * snackbar above the bottom, with Open. Windows: toasts stacked at the bottom
 * right, each with its close button.
 */
export function Notifications(props: NotificationsProps) {
  if (!props.toasts.length) return null;
  if (platform === 'ios') return <Banners {...props} />;
  if (platform === 'android') return <Snackbar {...props} />;
  return <Toasts {...props} />;
}

function Banners({ controller, toasts }: NotificationsProps) {
  const start = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    for (const id of [...start.current.keys()]) if (!toasts.some((t) => t.id === id)) start.current.delete(id);
  }, [toasts]);
  return (
    <div className="ios-banners" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="ios-banner"
          role="status"
          onPointerDown={(e) => start.current.set(t.id, e.clientY)}
          onPointerUp={(e) => {
            const y0 = start.current.get(t.id);
            start.current.delete(t.id);
            // Flicked up: away; a tap opens it.
            if (y0 !== undefined && y0 - e.clientY > 24) controller.closeToast(t.id);
            else controller.openToast(t);
          }}
        >
          <img className="ios-banner-icon" src="/icons/icon-192.png" alt="" />
          <div className="ios-banner-text">
            <div className="ios-banner-title">{t.title}</div>
            {t.body && <div className="ios-banner-body">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The newest toast as a snackbar above the bottom (and above the page's own tab bar). */
function Snackbar({ controller, toasts, ownsBottom }: NotificationsProps) {
  const t = toasts[toasts.length - 1];
  return (
    <div className={`md-snackbar-area${ownsBottom ? ' above-tabs' : ''}`} aria-live="polite">
      <div key={t.id} className="md-snackbar" role="status">
        <button className="md-snackbar-text" onClick={() => controller.openToast(t)}>
          <span className="md-snackbar-title">{t.title}</span>
          {t.body && <span className="md-snackbar-body">{t.body}</span>}
        </button>
        {t.taskId && (
          <button className="md-snackbar-action" onClick={() => controller.openToast(t)}>
            Open
          </button>
        )}
        <button className="md-icon-btn md-snackbar-close" aria-label="Dismiss" onClick={() => controller.closeToast(t.id)}>
          {CLOSE}
        </button>
      </div>
    </div>
  );
}

function Toasts({ controller, toasts }: NotificationsProps) {
  return (
    <div className="ws-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="ws-toast" role="status" onClick={() => controller.openToast(t)}>
          <div className="ws-toast-title">{t.title}</div>
          {t.body && <div className="ws-toast-body">{t.body}</div>}
          <CloseButton
            className="ws-toast-close"
            onClick={(e) => {
              e.stopPropagation();
              controller.closeToast(t.id);
            }}
          />
        </div>
      ))}
    </div>
  );
}
