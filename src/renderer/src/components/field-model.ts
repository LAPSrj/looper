import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

const NATIVE_CONTROLS = new Set(['input', 'select', 'textarea']);

/** Marks on a component: it puts its `id` on a control, and that control has several lines. */
type Labelable = { labelable?: boolean; multiline?: boolean };

/** A native input, select or textarea, or a component that puts its `id` on one (marked `labelable`). */
function isControl(node: ReactNode): boolean {
  if (!isValidElement(node)) return false;
  return typeof node.type === 'string' ? NATIVE_CONTROLS.has(node.type) : (node.type as Labelable).labelable === true;
}

export interface TextOptions {
  /** A command, path, id or URL: monospace, and the keyboard changes nothing in it. */
  code?: boolean;
  /** A name the keyboard must not change (a host name), in the ordinary font. */
  verbatim?: boolean;
}

/** The attributes of a text box with these options: a phone keyboard's capitals, corrections and spell check would break what's typed. */
export const textOptions = ({ code, verbatim }: TextOptions, className?: string) => ({
  ...(code || verbatim ? ({ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } as const) : {}),
  className: [code && 'mono', className].filter(Boolean).join(' ') || undefined,
});

export interface FieldBinding {
  /** The children, with `id` on the control the label names. */
  children: ReactNode;
  /** The id the label points to; undefined when no single control is named by it. */
  controlId?: string;
  /** The field is a group (several controls, or none the label can name): it is named by its label instead. */
  group: boolean;
  /** It holds only controls one line high: a phone draws the first beside the label and any other on a line of its own. */
  oneLine: boolean;
}

/** One control other than a textarea, or a wrapper around nothing else (InputSuffix, an InputRow of number boxes). */
function isOneLine(node: ReactNode): boolean {
  if (!isValidElement(node)) return false;
  if (isControl(node)) return node.type !== 'textarea' && !(node.type as Labelable).multiline;
  const inner = Children.toArray((node.props as { children?: ReactNode }).children);
  return inner.length > 0 && inner.every(isOneLine);
}

/**
 * Tie a field's label to its control. A single control (or a component that
 * passes `id` on) gets the id; a wrapper element around the control gets it on
 * the first control among its children, and is a group named by the label too;
 * any other children (several controls, text) make the field a group.
 */
export function bindField(children: ReactNode, id: string, extra?: Record<string, unknown>): FieldBinding {
  // Conditional content that isn't showing (`{warn && <p>…</p>}`) doesn't make a field taller.
  const shown = Children.toArray(children);
  const oneLine = shown.length > 0 && shown.every(isOneLine);
  if (Children.count(children) !== 1 || !isValidElement(children)) return { children, group: true, oneLine };
  const only = children as ReactElement<{ id?: string; children?: ReactNode }>;
  if (isControl(only)) {
    const own = only.props.id;
    return { children: own && !extra ? only : cloneElement(only, { ...(own ? {} : { id }), ...extra }), controlId: own ?? id, group: false, oneLine };
  }
  const inner = Children.toArray(only.props.children);
  const at = inner.findIndex(isControl);
  if (at === -1) return { children, group: true, oneLine };
  const control = inner[at] as ReactElement<{ id?: string }>;
  const own = control.props.id;
  const next = own && !extra ? control : cloneElement(control, { ...(own ? {} : { id }), ...extra });
  return { children: cloneElement(only, undefined, ...inner.map((c, i) => (i === at ? next : c))), controlId: own ?? id, group: true, oneLine };
}
