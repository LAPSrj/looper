import { DEFAULT_SPRING, SMOOTH, SNAPPY } from './menu-motion';

/**
 * The phone's and tablet's motions, for a document of the frame or of a window's page. On Android only a screen pushed
 * inside the main window or a window pushed over it moves (Material's own navigation, `swapScreensAndroid`,
 * `swapWindowsAndroid`); the rest is iOS's small motions
 * (ios.md: Motion). Components keep
 * drawing their plain states; this watches the document and animates between them:
 *
 * - a segmented control's, a tab bar's and an iPad tab bar's selection slides to the new choice (snappy spring);
 * - glass lights up under the finger while it's pressed (WWDC25 Meet Liquid Glass: "the material illuminates
 *   from within … starting right under your fingertips");
 * - rows a tap inserts (a group opened) grow in, and rows it removes (a group closed, a row deleted) fold away;
 *   a conversation's new last message rises in;
 * - a screen pushed inside the main window (PhoneMain marks it `enter-push` or `enter-pop`; on a tablet, in the
 *   detail column) moves the one it replaces as iOS does: a third of the way out under it, or off the trailing edge
 *   over it;
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
  ['.pg-addon-pane', '.pg-row, .task-folder'],
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
const ANDROID_STYLE = `
.motion-ghost{pointer-events:none!important;animation:none!important;transition:none!important}
`;

const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
const springs = typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', 'linear(0, 1)');
const ease = (m: { easing: string }, fallback: string): string => (springs ? m.easing : fallback);

const installed = new WeakSet<Document>();

export function installMotion(doc: Document): void {
  const os = doc.documentElement.dataset.platform;
  if (installed.has(doc) || (os !== 'ios' && os !== 'android')) return;
  installed.add(doc);
  if (os === 'android') return installAndroid(doc);
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
 * The screen a push or a pop replaced, back as an inert copy over the box the new one fills, under it or over it. The
 * two are siblings, so the copy goes where the new one's layout box is (offsets leave out the transform its slide
 * starts with). A tablet's detail column clips both while they move, so neither passes over the list column; the
 * returned function ends that and removes the copy.
 */
function screenCopy(old: HTMLElement, fresh: HTMLElement, over: boolean): { copy: HTMLElement; done: () => void } {
  const { copy, rescroll } = copyOf(old);
  const parent = fresh.parentElement;
  Object.assign(copy.style, { position: 'absolute', left: '0px', top: '0px', width: `${fresh.offsetWidth}px`, height: `${fresh.offsetHeight}px`, margin: '0', zIndex: over ? '2' : '0' });
  parent?.insertBefore(copy, over ? fresh.nextSibling : fresh);
  copy.style.left = `${fresh.offsetLeft - copy.offsetLeft}px`;
  copy.style.top = `${fresh.offsetTop - copy.offsetTop}px`;
  rescroll();
  const clipped = parent?.matches('.pg-split-detail') ? parent : null;
  if (clipped) clipped.style.clipPath = 'inset(0)';
  return {
    copy,
    done: () => {
      copy.remove();
      if (clipped && !clipped.querySelector(':scope > .motion-ghost')) clipped.style.clipPath = '';
    },
  };
}

/**
 * The main window's screen changed by a push or a pop: the new one slides in (phone.css) and the old one, back as a
 * copy over the same box, moves a third of the way out under it (push) or slides off over it to the trailing edge (pop).
 */
function swapScreens(old: HTMLElement, fresh: HTMLElement): void {
  const pop = fresh.classList.contains('enter-pop');
  // A back the browser already played (Safari's swipe, phone-shell.tsx's data-instant-back) shows at once.
  if (pop && old.ownerDocument.documentElement.dataset.instantBack !== undefined) return;
  const { copy, done: remove } = screenCopy(old, fresh, pop);
  const bg = backdropOf(fresh.parentElement ?? fresh);
  Object.assign(copy.style, { background: bg, boxShadow: pop ? '-4px 0 16px rgba(0, 0, 0, 0.12)' : '' });
  fresh.style.background = bg;
  const spring = pop ? SMOOTH : DEFAULT_SPRING;
  const keys = reduced() ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: 'none' }, { transform: pop ? 'translateX(100%)' : 'translateX(-30%)' }];
  const done = () => {
    remove();
    fresh.style.background = '';
  };
  copy.animate(keys, { duration: spring.ms, easing: ease(spring, 'cubic-bezier(0.2, 0.85, 0.25, 1)'), fill: 'forwards' }).finished.then(done, done);
}

// ---------- Android: Material's navigation between screens ----------

/**
 * Material's shared axis X (MDC Android's MaterialSharedAxis, docs/theming/Motion.md: "used for transitions between
 * UI elements that have a spatial or navigational relationship"): both screens move 30 dp along x
 * (mtrl_transition_shared_axis_slide_distance), the old one fading out over the first 35% and the new one in over
 * the rest (FadeThroughProvider's 0.35), in motionDurationLong1 (450 ms in M3) on the emphasized easing. Forward, the
 * new screen comes from the trailing side; back, from the leading side.
 */
const AXIS_PX = 30;
const AXIS_MS = 450;
const FADE_THROUGH = 0.35;
/**
 * Predictive back's commit for a full-screen surface (Android's Predictive back design, Full screen surfaces): the
 * screen scales from 100% to 90% and the one under it from 110% to 100%, through a fade at 35%, on
 * (0.1, 0.1, 0, 1), "so the screen quickly exits". The page sees a system back only once it's let go (popstate), so
 * the preview's part plays as the commit's. The guide gives no duration.
 */
const BACK_MS = 350;
const BACK_EASING = 'cubic-bezier(0.1, 0.1, 0, 1)';

/** An easing given as SVG path cubics from (0, 0) to (1, 1) (Android's path interpolators), as CSS linear() points. */
export function pathEasing(cubics: readonly (readonly [number, number, number, number, number, number])[], steps = 24): string {
  const points: string[] = ['0'];
  let [x0, y0] = [0, 0];
  for (const [x1, y1, x2, y2, x3, y3] of cubics) {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const at = (a: number, b: number, c: number, d: number) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
      points.push(`${+at(y0, y1, y2, y3).toFixed(4)} ${+(at(x0, x1, x2, x3) * 100).toFixed(2)}%`);
    }
    [x0, y0] = [x3, y3];
  }
  return `linear(${points.join(', ')})`;
}

/** M3's emphasized easing (motionEasingEmphasizedInterpolator: "M 0,0 C 0.05, 0, 0.133333, 0.06, 0.166666, 0.4 C 0.208333, 0.82, 0.25, 1, 1, 1"). */
const EMPHASIZED = springs
  ? pathEasing([
      [0.05, 0, 0.133333, 0.06, 0.166666, 0.4],
      [0.208333, 0.82, 0.25, 1, 1, 1],
    ])
  : 'cubic-bezier(0.2, 0, 0, 1)';

function installAndroid(doc: Document): void {
  const style = doc.createElement('style');
  style.textContent = ANDROID_STYLE;
  doc.head.append(style);
  const startedAt = performance.now();
  // The frame's document holds the windows (.ph-win); a window's page holds the screens (.phone-screen).
  installAndroidWindows(doc, () => doc.hidden || performance.now() - startedAt < 800);
  new MutationObserver((records) => {
    if (doc.hidden || performance.now() - startedAt < 800) return;
    const added = new Set<Node>();
    for (const r of records) for (const n of r.addedNodes) added.add(n);
    for (const r of records) for (const n of r.removedNodes) if (n instanceof HTMLElement && !n.isConnected && n.classList.contains(SCREEN)) swapWith(r, n, added, swapScreensAndroid);
  }).observe(doc.body, { subtree: true, childList: true });
}

/** What a screen does in a shared axis: the keyframes and timing of its part, `enter` or `leave`. */
function axis(side: 'enter' | 'leave', pop: boolean, system: boolean): { keys: Keyframe[]; timing: KeyframeAnimationOptions } {
  const still = reduced();
  const timing = { duration: system ? BACK_MS : AXIS_MS, easing: system ? BACK_EASING : EMPHASIZED };
  // The effect's easing runs before the keyframes' offsets, so the fade through is at 35% of the eased progress, as in FadeThroughProvider.
  if (side === 'leave') {
    const to = system ? 'scale(0.9)' : `translateX(${pop ? AXIS_PX : -AXIS_PX}px)`;
    return { keys: [{ transform: 'none', opacity: 1 }, { opacity: 0, offset: FADE_THROUGH }, { transform: still ? 'none' : to, opacity: 0 }], timing };
  }
  const from = system ? 'scale(1.1)' : `translateX(${pop ? -AXIS_PX : AXIS_PX}px)`;
  return { keys: [{ transform: still ? 'none' : from, opacity: 0 }, { opacity: 0, offset: FADE_THROUGH }, { transform: 'none', opacity: 1 }], timing };
}

/**
 * Windows pushed over the main window or each other (`.ph-win.pres-push`, in the frame's document) move as the screens
 * inside one do: the new one comes in and the one under it goes out 30 dp (a pop is the same the other way), with
 * Navigation's predictive back for a system back and nothing for a back Chrome already animated. Dialogs and sheets keep
 * their own motions (android.css). Does nothing in a document without windows (a window's page).
 */
function installAndroidWindows(doc: Document, early: () => boolean): void {
  const root = doc.documentElement;
  const isPush = (n: Node): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('ph-win') && n.classList.contains('pres-push');
  /** The window the push covers or the pop uncovers: the nearest one under it that's drawn. */
  const under = (win: HTMLElement): HTMLElement | null => {
    for (let p = win.previousElementSibling; p; p = p.previousElementSibling) {
      if (p instanceof HTMLElement && p.classList.contains('ph-win') && !p.matches('.leaving, .hidden, .covered')) return p;
    }
    return null;
  };
  const card = (win: HTMLElement | null) => win?.querySelector<HTMLElement>(':scope > .ph-card') ?? null;
  const run = (el: HTMLElement | null, a: ReturnType<typeof axis>, fill: FillMode, release: boolean) => {
    const anim = el?.animate(a.keys, { ...a.timing, fill });
    // Under a window that's still covering it, the animation ends where it was: let it go so the screen is itself again.
    if (release) anim?.finished.then(() => anim.cancel(), () => undefined);
  };
  const push = (win: HTMLElement) => {
    run(card(under(win)), axis('leave', false, false), 'forwards', true);
    run(card(win), axis('enter', false, false), 'backwards', false);
  };
  const pop = (win: HTMLElement) => {
    const system = root.dataset.systemBack !== undefined;
    delete root.dataset.systemBack;
    // Chrome played this back: what it closed goes, and what's under it is in place, at once (phone.css).
    if (root.dataset.instantBack !== undefined) return;
    run(card(win), axis('leave', true, system), 'forwards', false);
    run(card(under(win)), axis('enter', true, system), 'backwards', false);
  };
  const classes = new MutationObserver((records) => {
    if (early()) return;
    for (const r of records) if (isPush(r.target) && r.target.classList.contains('leaving') && !/(^|\s)leaving(\s|$)/.test(r.oldValue ?? '')) pop(r.target);
  });
  const watch = (win: HTMLElement) => classes.observe(win, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  const ready = doc.querySelector('.ph-root');
  if (!ready) return;
  doc.querySelectorAll<HTMLElement>('.ph-win').forEach(watch);
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement) || !n.classList.contains('ph-win')) continue;
        watch(n);
        if (isPush(n) && n.isConnected && !early()) push(n);
      }
    }
  }).observe(ready, { childList: true, subtree: true });
}

/**
 * Android's push and pop: shared axis X, forward or back; a system back (the gesture or the back button, which
 * phone-shell.tsx marks data-system-back) closes with predictive back's commit, as Navigation's predictive pop has a
 * transition of its own; a back Chrome already animated (data-instant-back) shows at once. Reduce Motion (Remove
 * animations) keeps only the fade through.
 */
function swapScreensAndroid(old: HTMLElement, fresh: HTMLElement): void {
  const root = old.ownerDocument.documentElement;
  const pop = fresh.classList.contains('enter-pop');
  const system = pop && root.dataset.systemBack !== undefined;
  delete root.dataset.systemBack;
  if (pop && root.dataset.instantBack !== undefined) return;
  const { copy, done } = screenCopy(old, fresh, false);
  const out = axis('leave', pop, system);
  const into = axis('enter', pop, system);
  copy.animate(out.keys, { ...out.timing, fill: 'forwards' }).finished.then(done, done);
  fresh.animate(into.keys, { ...into.timing, fill: 'backwards' });
}

/** A removed screen and the screen PhoneMain put in its place, under the same parent, marked as a push or a pop. */
function swapWith(r: MutationRecord, old: HTMLElement, added: Set<Node>, swap: (old: HTMLElement, fresh: HTMLElement) => void): void {
  const fresh = [...added].find((a): a is HTMLElement => a instanceof HTMLElement && a.isConnected && a.classList.contains(SCREEN) && /\benter-(push|pop)\b/.test(a.className));
  if (fresh && fresh.parentNode === r.target) swap(old, fresh);
}

function animateRemoved(records: MutationRecord[], added: Set<Node>, afterTap: boolean): void {
  const rows: [MutationRecord, HTMLElement][] = [];
  const after = new Map<Node, Node>();
  for (const r of records) {
    for (const n of r.removedNodes) {
      if (!(n instanceof HTMLElement) || n.isConnected || n.classList.contains('motion-ghost')) continue;
      if (n.classList.contains(SCREEN)) {
        swapWith(r, n, added, swapScreens);
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
