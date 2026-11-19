import type { ReactNode } from 'react';
import { isPhone } from '../web/page-nav';
import { EmptyState } from './EmptyState';
import { Group, Row } from './phone/PhoneList';

/**
 * A titled part of a pane: the desktop's heading over its content, a phone's
 * list section. `state`: text after the title (a phase's progress), at the
 * heading's end on the desktop and after a dot in a phone's title. `action`: a
 * command on the whole section (Clear), a small button on the desktop and a
 * tinted row at a phone section's end. `empty`: shown in place of the content.
 * On a phone the content is list rows.
 */
export function Section({
  title,
  state,
  action,
  detail,
  empty,
  className,
  children,
}: {
  title?: string;
  state?: { text: string; error?: boolean };
  action?: { label: string; disabled?: boolean; run: () => void };
  detail?: ReactNode;
  empty?: ReactNode;
  /** The desktop section's class, which sets its spacing in its pane. */
  className?: string;
  children?: ReactNode;
}) {
  if (isPhone) {
    return (
      <Group title={title && (state ? `${title} · ${state.text}` : title)} footer={detail}>
        {empty ? <EmptyState at="section">{empty}</EmptyState> : children}
        {action && !action.disabled && <Row title={action.label} tone="action" onOpen={action.run} />}
      </Group>
    );
  }
  return (
    <section className={className ? `section ${className}` : 'section'}>
      {title && (
        <div className="section-head">
          <span className="pane-title">{title}</span>
          {state && <span className={`section-state ${state.error ? 'error-text' : 'muted'}`}>{state.text}</span>}
          {action && (
            <button className="btn small" disabled={action.disabled} onClick={action.run}>
              {action.label}
            </button>
          )}
        </div>
      )}
      {detail && <div className="muted section-detail">{detail}</div>}
      {empty ? <EmptyState at="section">{empty}</EmptyState> : children}
    </section>
  );
}
