// No DOM types beyond what the caller passes in: the unit tests load this file.

/** How much shorter than the window the visible area must be for the on-screen keyboard to count as up. */
const KEYBOARD_MIN = 120;

/**
 * Whether the on-screen keyboard is up. iOS shrinks a Home Screen app's
 * innerHeight along with the keyboard, so the visible height is compared with
 * the tallest the window has been at this width; a field must have the focus,
 * so an iPad window made shorter (Stage Manager) isn't taken for a keyboard.
 */
export function keyboardUp(tallest: number, visibleHeight: number, editing: boolean): boolean {
  return editing && tallest - visibleHeight > KEYBOARD_MIN;
}

/** Remembers the tallest a window has been at each width, for `keyboardUp`. */
export function tallestTracker(): (width: number, height: number) => number {
  const tallest = new Map<number, number>();
  return (width, height) => {
    const h = Math.max(tallest.get(width) ?? 0, height);
    tallest.set(width, h);
    return h;
  };
}

interface FocusDoc {
  activeElement: { tagName: string; isContentEditable?: boolean; contentDocument?: FocusDoc | null; type?: string; readOnly?: boolean } | null;
}

const TEXT_INPUTS = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''];

/** Whether the focus is in something the on-screen keyboard types into, looking through iframes. */
export function editingIn(doc: FocusDoc | null | undefined): boolean {
  const el = doc?.activeElement;
  if (!el) return false;
  if (el.tagName === 'IFRAME') {
    try {
      return editingIn(el.contentDocument);
    } catch {
      return false;
    }
  }
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return !el.readOnly;
  return el.tagName === 'INPUT' && TEXT_INPUTS.includes(el.type ?? '') && !el.readOnly;
}
