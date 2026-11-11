import { DEFAULT_SPRING, SMOOTH, SNAPPY } from './menu-motion';

/**
 * iOS's small motions, for a document of the frame or of a window's page (ios.md: Motion). Components keep
 * drawing their plain states; this watches the document and animates between them:
 *
 * - a segmented control's, a tab bar's and an iPad tab bar's selection slides to the new choice (snappy spring);
 * - glass lights up under the finger while it's pressed (WWDC25 Meet Liquid Glass: "the material illuminates
 *   from within … starting right under your fingertips");
 * - rows a tap inserts (a group opened) grow in, and rows it removes (a group closed, a row deleted) fold away;
 *   a conversation's new last message rises in;
 * - a screen pushed inside the main window (PhoneMain marks it `enter-push` or `enter-pop`) moves the one it
 *   replaces as iOS does: a third of the way out under it, or off the trailing edge over it;
 * - alerts, banners and the message box's + menu go away with a fade instead of vanishing.
 *
 * What goes away comes back for its animation as an inert copy where it was (`ghost`), so nothing has to wait to
 * unmount and the action it ended runs at once.
 *
 * Reduce Motion keeps the fades and drops the sliding and growing (HIG: Accessibility).
 */

const SELECTION_LISTS = '.pg-segmented, .tabs-segmented, .phone-detail > .detail > .tabs, .phone-tabbar:not(.rail), .ios-segmented, .ios-tabbar';
const SELECTED = ':is(button, .tab, .phone-tab, .ios-tab).active, [role="tab"][aria-selected="true"]';

const GLASS = '.ios-back, .ios-text-btn, .ios-icon-btn, .ios-bar-group, .phone-plus-button, .phone-tabbar, .ios-tabbar';

/**
 * Rows that grow in or fold away when a tap adds or removes them, each with the list that holds them. A removed
 * row is detached when it's seen, so it's matched alone and its old parent is matched against the list.
 */
const LIST_ROWS: [list: string, row: string][] = [
  ['.pg-list', '.pg-row, .pg-swipe'],
  ['.pg-sessions', '.session-row, .session-group'],
  ['.pg-addon-pane', '.task-item, .task-folder'],
];
const isListRow = (n: Element, parent: Node | null): boolean => parent instanceof Element && LIST_ROWS.some(([list, row]) => n.matches(row) && !!parent.closest(list));
const SCREEN = 'phone-screen';
/** A conversation's message: only one added at its end rises in (the older ones load above it). */
const MESSAGES = '.chat-msg';
/** What fades away rather than vanish, with its keyframes. */
const LEAVING: [string, Keyframe[]][] = [
  ['.ios-alert-layer', [{ opacity: 1 }, { opacity: 0 }]],
  ['.ios-banner', [{ transform: 'none', opacity: 1 }, { transform: 'translateY(-120%)', opacity: 0 }]],
  ['.phone-plus-menu', [{ transform: 'none', opacity: 1 }, { transform: 'scale(0.6)', opacity: 0 }]],
  ['.phone-plus-scrim', [{ opacity: 1 }, { opacity: 0 }]],
];

/** How long after a tap a list change counts as its result. */
const TAP_MS = 1000;
/** More rows than this at once is a list being loaded or swapped, not a change to animate. */
const MAX_ROWS = 24;

const STYLE = `
.motion-thumb{position:absolute;z-index:-1;left:0;top:0;pointer-events:none}
.motion-thumb-hide{background:transparent!important;box-shadow:none!important}
.motion-glow{position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .45s;
background:radial-gradient(circle at var(--glow-x) var(--glow-y),rgba(255,255,255,.55),rgba(255,255,255,.18) 40%,transparent 75%)}
.motion-glow.on{opacity:1;transition:opacity .08s}
@media (prefers-color-scheme:dark){.motion-glow{background:radial-gradient(circle at var(--glow-x) var(--glow-y),rgba(255,255,255,.28),rgba(255,255,255,.08) 40%,transparent 75%)}}
.motion-ghost{pointer-events:none!important;animation:none!important;transition:none!important}
.phone-screen.enter-push{position:relative;z-index:1}
`;

const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
const springs = typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', 'linear(0, 1)');
const ease = (m: { easing: string }, fallback: string): string => (springs ? m.easing : fallback);

const installed = new WeakSet<Document>();

export function installMotion(doc: Document): void {
  if (installed.has(doc) || doc.documentElement.dataset.platform !== 'ios') return;
  installed.add(doc);
  const root = doc.documentElement;
  // The springs for the stylesheets' transitions and keyframes (ios.css, phone.css).
  if (springs) {
    for (const [name, m] of [
      ['default', DEFAULT_SPRING],
      ['smooth', SMOOTH],
      ['snappy', SNAPPY],
    ] as const) {
      root.style.setProperty(`--spring-${name}`, m.easing);
      root.style.setProperty(`--spring-${name}-ms`, `${m.ms}ms`);
    }
  }
  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.append(style);

  let tappedAt = -Infinity;
  const tapped = () => performance.now() - tappedAt < TAP_MS;
  doc.addEventListener('pointerdown', () => (tappedAt = performance.now()), true);
  doc.addEventListener('keydown', () => (tappedAt = performance.now()), true);
  installGlow(doc);
  // A copy of a scrolled list starts at its top: the copy takes the scroll its original last had.
  doc.addEventListener('scroll', (e) => e.target instanceof Element && scrolled.set(e.target, [e.target.scrollLeft, e.target.scrollTop]), { capture: true, passive: true });

  const startedAt = performance.now();
  const observer = new MutationObserver((records) => {
    if (doc.hidden || performance.now() - startedAt < 800) return;
    slideSelections(records);
    const added = new Set<Node>();
    for (const r of records) for (const n of r.addedNodes) added.add(n);
    animateAdded(added, tapped());
    animateRemoved(records, added, tapped());
  });
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'aria-selected', 'aria-current'] });
}

// ---------- the sliding selection ----------

const thumbs = new WeakMap<Element, Animation>();

function wasSelected(r: MutationRecord): boolean {
  const el = r.target as Element;
  if (r.attributeName === 'class') return /(^|\s)active(\s|$)/.test(r.oldValue ?? '') && !el.classList.contains('active');
  if (r.attributeName === 'aria-selected') return r.oldValue === 'true' && el.getAttribute('aria-selected') !== 'true';
  return r.oldValue === 'page' && el.getAttribute('aria-current') !== 'page';
}

function slideSelections(records: MutationRecord[]): void {
  const left = new Map<Element, Element>();
  for (const r of records) {
    if (r.type !== 'attributes' || !wasSelected(r)) continue;
    const list = (r.target as Element).closest(SELECTION_LISTS);
    if (list) left.set(list, r.target as Element);
  }
  for (const [list, from] of left) {
    const to = list.querySelector<HTMLElement>(SELECTED);
    if (to && to !== from && from.isConnected && !reduced()) slide(list as HTMLElement, from as HTMLElement, to);
  }
}

/** A thumb in the selection's colors moves from where it was to the new choice, which shows its own once it's there. */
function slide(list: HTMLElement, from: HTMLElement, to: HTMLElement): void {
  const doc = list.ownerDocument;
  const base = list.getBoundingClientRect();
  const running = list.querySelector<HTMLElement>(':scope > .motion-thumb');
  const start = (running ?? from).getBoundingClientRect();
  thumbs.get(list)?.cancel();
  running?.remove();
  for (const el of list.querySelectorAll('.motion-thumb-hide')) el.classList.remove('motion-thumb-hide');
  const end = to.getBoundingClientRect();
  const cs = getComputedStyle(to);
  const thumb = doc.createElement('div');
  thumb.className = 'motion-thumb';
  Object.assign(thumb.style, { width: `${end.width}px`, height: `${end.height}px`, background: cs.backgroundColor, borderRadius: cs.borderRadius, boxShadow: cs.boxShadow });
  if (getComputedStyle(list).position === 'static') list.style.position = 'relative';
  list.style.isolation = 'isolate';
  list.prepend(thumb);
  to.classList.add('motion-thumb-hide');
  const at = (r: DOMRect) => `translate(${r.left - base.left + list.scrollLeft - list.clientLeft}px, ${r.top - base.top + list.scrollTop - list.clientTop}px)`;
  const a = thumb.animate(
    [
      { transform: at(start), width: `${start.width}px`, height: `${start.height}px` },
      { transform: at(end), width: `${end.width}px`, height: `${end.height}px` },
    ],
    { duration: SNAPPY.ms, easing: ease(SNAPPY, 'cubic-bezier(0.3, 1.2, 0.5, 1)'), fill: 'forwards' },
  );
  thumbs.set(list, a);
  const done = () => {
    if (thumbs.get(list) !== a) return;
    thumbs.delete(list);
    thumb.remove();
    to.classList.remove('motion-thumb-hide');
  };
  a.finished.then(done, () => undefined);
}

// ---------- glass lighting up under the finger ----------

function installGlow(doc: Document): void {
  let lit: HTMLElement | null = null;
  const off = () => {
    const glow = lit;
    lit = null;
    if (!glow) return;
    glow.classList.remove('on');
    setTimeout(() => glow.remove(), 500);
  };
  doc.addEventListener(
    'pointerdown',
    (e) => {
      off();
      const host = (e.target as Element | null)?.closest?.<HTMLElement>(GLASS);
      if (!host || (host as HTMLButtonElement).disabled || reduced()) return;
      const r = host.getBoundingClientRect();
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const glow = doc.createElement('span');
      glow.className = 'motion-glow';
      glow.setAttribute('aria-hidden', 'true');
      glow.style.setProperty('--glow-x', `${e.clientX - r.left}px`);
      glow.style.setProperty('--glow-y', `${e.clientY - r.top}px`);
      host.append(glow);
      // Next frame, so the fade in runs from 0.
      requestAnimationFrame(() => glow.classList.add('on'));
      lit = glow;
    },
    true,
  );
  for (const type of ['pointerup', 'pointercancel', 'dragstart']) doc.addEventListener(type, off, true);
}

// ---------- rows and messages coming and going ----------

function addedWithin(n: Node, added: Set<Node>): boolean {
  for (let p = n.parentNode; p; p = p.parentNode) if (added.has(p)) return true;
  return false;
}

function animateAdded(added: Set<Node>, afterTap: boolean): void {
  const rows: HTMLElement[] = [];
  const messages: HTMLElement[] = [];
  for (const n of added) {
    if (!(n instanceof HTMLElement) || !n.isConnected || n.classList.contains('motion-ghost') || addedWithin(n, added)) continue;
    if (afterTap && isListRow(n, n.parentNode)) rows.push(n);
    else if (n.matches(MESSAGES) && !n.nextElementSibling) messages.push(n);
  }
  if (rows.length && rows.length <= MAX_ROWS) {
    for (const row of rows) {
      const [shut, full] = fold(row);
      row.animate(reduced() ? [{ opacity: 0 }, { opacity: 1 }] : [shut, full], { duration: SMOOTH.ms, easing: ease(SMOOTH, 'ease-out') });
    }
  }
  if (messages.length && messages.length <= 2) {
    for (const msg of messages) {
      const keys = reduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: 'translateY(16px)', opacity: 0 }, { transform: 'none', opacity: 1 }];
      msg.animate(keys, { duration: SNAPPY.ms, easing: ease(SNAPPY, 'ease-out') });
    }
  }
}

/** Each scroller's last scroll, by element: a detached element reads 0, so its copy takes it from here. */
const scrolled = new WeakMap<Element, [number, number]>();

/** An inert copy of a removed element, scrolled where its original was. */
function copyOf(n: HTMLElement): { copy: HTMLElement; rescroll: () => void } {
  const copy = n.cloneNode(true) as HTMLElement;
  copy.classList.add('motion-ghost');
  copy.removeAttribute('id');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  const rescroll = () => {
    const from = [n, ...n.querySelectorAll('*')];
    const to = [copy, ...copy.querySelectorAll('*')];
    from.forEach((el, i) => {
      const at = scrolled.get(el);
      if (at && to[i]) [to[i].scrollLeft, to[i].scrollTop] = at;
    });
  };
  return { copy, rescroll };
}

/** A removed element comes back as an inert copy where it was, to animate away. */
function ghost(r: MutationRecord, n: HTMLElement, after: Map<Node, Node>): HTMLElement | null {
  const parent = r.target;
  if (!parent.isConnected) return null;
  const { copy } = copyOf(n);
  const next = r.nextSibling && r.nextSibling.parentNode === parent ? r.nextSibling : null;
  const prev = r.previousSibling && r.previousSibling.parentNode === parent ? r.previousSibling : null;
  if (next) parent.insertBefore(copy, next);
  else if (prev) {
    // Several rows removed one after another all name the same row before them: keep them in their order.
    const last = after.get(prev) ?? prev;
    parent.insertBefore(copy, last.nextSibling);
    after.set(prev, copy);
  } else parent.appendChild(copy);
  return copy;
}

/** The first opaque background behind an element: screens moving over each other need one to hide what's under them. */
function backdropOf(el: Element): string {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const bg = getComputedStyle(e).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg;
  }
  return '#fff';
}

/**
 * The main window's screen changed by a push or a pop: the new one slides in (phone.css) and the old one, back as a
 * copy over the same box, moves a third of the way out under it (push) or slides off over it to the trailing edge (pop).
 */
function swapScreens(old: HTMLElement, fresh: HTMLElement): void {
  const pop = fresh.classList.contains('enter-pop');
  const { copy, rescroll } = copyOf(old);
  const bg = backdropOf(fresh.parentElement ?? fresh);
  Object.assign(copy.style, {
    position: 'absolute',
    left: `${fresh.offsetLeft}px`,
    top: `${fresh.offsetTop}px`,
    width: `${fresh.offsetWidth}px`,
    height: `${fresh.offsetHeight}px`,
    margin: '0',
    zIndex: pop ? '2' : '0',
    background: bg,
    boxShadow: pop ? '-4px 0 16px rgba(0, 0, 0, 0.12)' : '',
  });
  fresh.style.background = bg;
  fresh.parentElement?.insertBefore(copy, pop ? fresh.nextSibling : fresh);
  rescroll();
  const spring = pop ? SMOOTH : DEFAULT_SPRING;
  const keys = reduced() ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: 'none' }, { transform: pop ? 'translateX(100%)' : 'translateX(-30%)' }];
  const done = () => {
    copy.remove();
    fresh.style.background = '';
  };
  copy.animate(keys, { duration: spring.ms, easing: ease(spring, 'cubic-bezier(0.2, 0.85, 0.25, 1)'), fill: 'forwards' }).finished.then(done, done);
}

function animateRemoved(records: MutationRecord[], added: Set<Node>, afterTap: boolean): void {
  const rows: [MutationRecord, HTMLElement][] = [];
  const after = new Map<Node, Node>();
  for (const r of records) {
    for (const n of r.removedNodes) {
      if (!(n instanceof HTMLElement) || n.isConnected || n.classList.contains('motion-ghost')) continue;
      if (n.classList.contains(SCREEN)) {
        const fresh = [...added].find((a): a is HTMLElement => a instanceof HTMLElement && a.isConnected && a.classList.contains(SCREEN) && /\benter-(push|pop)\b/.test(a.className));
        if (fresh && fresh.parentNode === r.target) swapScreens(n, fresh);
        continue;
      }
      const leave = LEAVING.find(([sel]) => n.matches(sel));
      if (leave) {
        const copy = ghost(r, n, after);
        if (!copy) continue;
        const keys = reduced() ? [{ opacity: 1 }, { opacity: 0 }] : leave[1];
        copy.animate(keys, { duration: 220, easing: 'ease-in', fill: 'forwards' }).finished.then(() => copy.remove(), () => copy.remove());
      } else if (afterTap && isListRow(n, r.target)) rows.push([r, n]);
    }
  }
  if (!rows.length || rows.length > MAX_ROWS) return;
  for (const [r, n] of rows) {
    const copy = ghost(r, n, after);
    if (!copy) continue;
    const [shut, full] = fold(copy);
    copy.animate(reduced() ? [{ opacity: 1 }, { opacity: 0 }] : [full, shut], { duration: SMOOTH.ms, easing: ease(SMOOTH, 'ease-in'), fill: 'forwards' }).finished.then(() => copy.remove(), () => copy.remove());
  }
}

/**
 * A row closed to nothing and at its full height. A row has a minimum height and padding, so its box is held to
 * its border edge (the same `box-sizing` at both ends holds all the way) and both go to 0 with the height.
 */
function fold(row: HTMLElement): [Keyframe, Keyframe] {
  const cs = getComputedStyle(row);
  const fixed = { boxSizing: 'border-box', minHeight: '0px', overflow: 'hidden' };
  return [
    { ...fixed, height: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', opacity: 0 },
    { ...fixed, height: `${row.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth, opacity: 1 },
  ];
}
