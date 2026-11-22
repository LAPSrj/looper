/**
 * The full text of what's cut off, as a tooltip (desktop). One listener per page, and it reads layout only for the
 * elements under a pointer that has just entered them: the text is clipped when it has an ellipsis and its content is
 * wider than the box. An element with a title of its own keeps it; one this set a title on is checked again each time,
 * so it follows the text.
 */
const MAX_DEPTH = 4;
const ours = new WeakSet<Element>();

function clipped(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis';
}

function onOver(e: PointerEvent): void {
  if (e.pointerType === 'touch' || !(e.target instanceof HTMLElement)) return;
  let el: HTMLElement | null = e.target;
  for (let depth = 0; el && depth < MAX_DEPTH; depth++, el = el.parentElement) {
    const own = el.hasAttribute('title') && !ours.has(el);
    if (own) return;
    if (!clipped(el)) {
      if (ours.has(el)) {
        el.removeAttribute('title');
        ours.delete(el);
      }
      continue;
    }
    const text = el.textContent?.replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (el.getAttribute('title') !== text) el.setAttribute('title', text);
    ours.add(el);
    return;
  }
}

/** Starts the page's listener. */
export function startClippedTitles(): void {
  document.addEventListener('pointerover', onOver, { passive: true });
}
