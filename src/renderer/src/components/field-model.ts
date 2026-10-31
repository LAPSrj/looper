import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

const NATIVE_CONTROLS = new Set(['input', 'select', 'textarea']);

type Labelable = { labelable?: boolean };

/** A native input, select or textarea, or a component that puts its `id` on one (marked `labelable`). */
function isControl(node: ReactNode): boolean {
  if (!isValidElement(node)) return false;
  return typeof node.type === 'string' ? NATIVE_CONTROLS.has(node.type) : (node.type as Labelable).labelable === true;
}

export interface FieldBinding {
  /** The children, with `id` on the control the label names. */
  children: ReactNode;
  /** The id the label points to; undefined when no single control is named by it. */
  controlId?: string;
  /** The field is a group (several controls, or none the label can name): it is named by its label instead. */
  group: boolean;
}

/**
 * Tie a field's label to its control. A single control (or a component that
 * passes `id` on) gets the id; a wrapper element around the control gets it on
 * the first control among its children, and is a group named by the label too;
 * any other children (several controls, text) make the field a group.
 */
export function bindField(children: ReactNode, id: string): FieldBinding {
  if (Children.count(children) !== 1 || !isValidElement(children)) return { children, group: true };
  const only = children as ReactElement<{ id?: string; children?: ReactNode }>;
  if (isControl(only)) {
    const own = only.props.id;
    return { children: own ? only : cloneElement(only, { id }), controlId: own ?? id, group: false };
  }
  const inner = Children.toArray(only.props.children);
  const at = inner.findIndex(isControl);
  if (at === -1) return { children, group: true };
  const control = inner[at] as ReactElement<{ id?: string }>;
  const own = control.props.id;
  const next = own ? control : cloneElement(control, { id });
  return { children: cloneElement(only, undefined, ...inner.map((c, i) => (i === at ? next : c))), controlId: own ?? id, group: true };
}
