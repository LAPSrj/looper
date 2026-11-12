import { Fragment, type ReactNode } from 'react';
import { isPhone } from '../web/page-nav';
import { Group, Row } from './phone/PhoneList';

/** One label and its value. */
export interface Property {
  label: string;
  value: ReactNode;
  /** The value's classes (mono, error-text). */
  className?: string;
  /** A note on the value: a line of its own under it, or in parentheses after it in a phone's row. */
  note?: string;
  /** A phone row's color. */
  tone?: 'error';
}

/**
 * Facts as labels and values: a status tab, an addon's details, a subagent's
 * model and effort. `className` is the list's look (`props`, `subagent-facts`).
 * `rows`: on a phone, a list group of rows under this title instead.
 * Items that are false, null or undefined are left out.
 */
export function PropertyList({ items, className = 'props', rows }: { items: (Property | false | null | undefined)[]; className?: string; rows?: { title: string } }) {
  const shown = items.filter((p): p is Property => !!p);
  if (isPhone && rows) {
    return (
      <Group title={rows.title}>
        {shown.map((p) => (
          <Row key={p.label} title={p.label} sub={p.note ? <>{p.value} ({p.note.charAt(0).toLowerCase()}{p.note.slice(1)})</> : p.value} tone={p.tone} />
        ))}
      </Group>
    );
  }
  return (
    <dl className={className}>
      {shown.map((p, i) => (
        <Fragment key={i}>
          <dt>{p.label}</dt>
          <dd className={p.className}>{p.value}</dd>
          {p.note && (
            <>
              <dt />
              <dd className="muted">{p.note}</dd>
            </>
          )}
        </Fragment>
      ))}
    </dl>
  );
}
