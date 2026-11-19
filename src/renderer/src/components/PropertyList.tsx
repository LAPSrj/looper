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
  /** A phone row's value color (a limit close to its end). */
  valueTone?: 'error' | 'warning';
}

/**
 * Facts as labels and values: a status tab, an addon's details, a subagent's
 * model and effort. `className` is the list's look (`props`, `subagent-facts`).
 * `rows`: on a phone, a list group of rows under this title instead; with
 * `atEnd` each value sits at the row's end (short values), not under its label (long ones).
 * Items that are false, null or undefined are left out.
 */
export function PropertyList({ items, className = 'props', rows }: { items: (Property | false | null | undefined)[]; className?: string; rows?: { title: string; atEnd?: boolean } }) {
  const shown = items.filter((p): p is Property => !!p);
  if (isPhone && rows) {
    return (
      <Group title={rows.title}>
        {shown.map((p) => {
          const value = p.note ? <>{p.value} ({p.note.charAt(0).toLowerCase()}{p.note.slice(1)})</> : p.value;
          return rows.atEnd ? (
            <Row key={p.label} title={p.label} value={value} tone={p.tone} valueTone={p.valueTone} />
          ) : (
            <Row key={p.label} title={p.label} sub={value} tone={p.tone} valueTone={p.valueTone} />
          );
        })}
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
