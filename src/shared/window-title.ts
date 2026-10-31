/**
 * A window's title: what the window is, then the item it shows when two windows of
 * its kind can be open at once ("Edit Project – Web app"). A window that can't
 * have a twin shows just its kind ("Edit Environment"): child windows carry their
 * own name, never the product's.
 */
export function windowTitle(kind: string, name?: string | null): string {
  const item = name?.trim();
  return item ? `${kind} – ${item}` : kind;
}
