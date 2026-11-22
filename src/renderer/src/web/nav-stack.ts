// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import type { RemoteWindowSpec } from '../../../shared/remote-access';

// ---------- how a window shows on a phone or tablet ----------

export type PhoneOs = 'ios' | 'android';

/**
 * root: the main window, the screen everything else goes over.
 * push: a full-screen screen with a back button (a modeless window, a large one on a tablet).
 * page-sheet / form-sheet: iOS sheets (page: nearly the full screen; form: a centered card on iPad).
 * full-dialog / bottom-sheet / dialog: Material's full-screen dialog, modal bottom sheet, and centered dialog (tablets).
 */
export type Presentation = 'root' | 'push' | 'page-sheet' | 'form-sheet' | 'full-dialog' | 'bottom-sheet' | 'dialog';

export interface ScreenSize {
  width: number;
  height: number;
}

/** A tablet: its short side is 600 CSS px or more (Material's medium window class; every iPad). */
export const isTablet = (screen: ScreenSize): boolean => Math.min(screen.width, screen.height) >= 600;

/** An iPad split view's columns, in CSS px: the list's (leading) and the inspector's (trailing; 0 when there's no room for one). */
export interface SplitLayout {
  lead: number;
  inspector: number;
}

/** The leading column: 320 pt, 375 pt on wide screens (UISplitViewController's widths). */
const leadWidth = (width: number): number => (width >= 1200 ? 375 : 320);
export const INSPECTOR_WIDTH = 360;
/** The detail column keeps at least this much beside an inspector; with less, the inspector is a sheet. */
const MIN_DETAIL_BESIDE_INSPECTOR = 600;
/** Narrower than this a page shows one column, as on a phone: iPad split-screen multitasking, and Material's two panes starting at expanded. */
const MIN_SPLIT_WIDTH: Record<PhoneOs, number> = { ios: 700, android: 840 };

/**
 * Whether a page or pane `width` wide on `screen` shows a list beside its
 * detail, and the columns' widths; null shows one column (a phone, or a narrow
 * window on a tablet).
 */
export function splitLayout(width: number, screen: ScreenSize, os: PhoneOs = 'ios'): SplitLayout | null {
  if (!isTablet(screen) || width < MIN_SPLIT_WIDTH[os]) return null;
  const lead = leadWidth(width);
  return { lead, inspector: width - lead - INSPECTOR_WIDTH >= MIN_DETAIL_BESIDE_INSPECTOR ? INSPECTOR_WIDTH : 0 };
}

/** From the window's declared role and the device, never its desktop size. */
export function presentation(os: PhoneOs, win: Pick<RemoteWindowSpec, 'modal' | 'role'>, isMain: boolean, screen: ScreenSize): Presentation {
  if (isMain) return 'root';
  // A row looked at closely: a sheet over its list, which stays in view behind it (HIG: Sheets; Material: bottom sheets).
  if (win.role === 'detail') return os === 'ios' ? 'page-sheet' : 'bottom-sheet';
  if (isTablet(screen)) {
    if (win.role === 'workspace') return 'push';
    if (os === 'ios') return win.role === 'editor' ? 'page-sheet' : 'form-sheet';
    return win.modal ? 'dialog' : 'push';
  }
  if (!win.modal) return 'push';
  if (os === 'ios') return 'page-sheet';
  return win.role === 'prompt' ? 'bottom-sheet' : 'full-dialog';
}

/** Whether the presentation covers the whole screen, so what's under it needn't be drawn. */
export const coversScreen = (p: Presentation): boolean => p === 'root' || p === 'push' || p === 'full-dialog';

/**
 * Which screens of a stack (bottom first) are drawn: from the top down to the first one that covers everything.
 * When the top covers everything, what it would uncover (down to the next screen that covers everything) is
 * `covered`: drawn only while a back swipe uncovers it, or while the top is still `arriving` (sliding in), when
 * it's drawn too.
 */
export function drawnScreens(stack: readonly Presentation[], arriving: boolean): { visible: boolean[]; covered: boolean[] } {
  const visible = stack.map(() => false);
  const covered = stack.map(() => false);
  const top = stack.length - 1;
  for (let i = top; i >= 0; i--) {
    visible[i] = true;
    if (!coversScreen(stack[i])) continue;
    for (let j = i - 1; j >= 0 && i === top; j--) {
      (arriving ? visible : covered)[j] = true;
      if (coversScreen(stack[j])) break;
    }
    break;
  }
  return { visible, covered };
}

// ---------- back: the browser's history in step with what can be closed ----------

export interface HistoryLike {
  /** The current entry's depth (from its state); 0 for the page's own entry. */
  depth(): number;
  push(depth: number): void;
  go(delta: number): void;
}

/** How long after a back the history waits for the screen to change before it catches up. */
export const BACK_SETTLE_MS = 400;

/**
 * One history entry per thing Back can close (a window, a page's deeper
 * screen, a menu or dialog), so Android's back button and gesture, and
 * Safari's, close them one at a time. Entries carry their depth, so a popstate
 * says how far back (or forward) the user went. The page's own entry (depth 0)
 * is left alone: Back from there leaves Looper, as the browser does.
 */
export class BackStack {
  private current: number;
  /** A go() we made is under way: the browser hasn't arrived yet. */
  private traversing = false;
  private holdUntil = 0;
  private want = 0;

  constructor(
    private readonly h: HistoryLike,
    private readonly now: () => number,
  ) {
    this.current = Math.max(0, h.depth());
  }

  get depth(): number {
    return this.current;
  }

  /** ms until sync acts again after a back (0: now). */
  holdRemaining(): number {
    return Math.max(0, this.holdUntil - this.now());
  }

  /** Make the entries match `want` layers: push the missing ones, or go back over the extra ones. */
  sync(want: number): void {
    this.want = Math.max(0, want);
    if (this.traversing || this.holdRemaining() > 0) return;
    if (this.want > this.current) {
      while (this.current < this.want) this.h.push(++this.current);
    } else if (this.want < this.current) {
      const n = this.current - this.want;
      this.current = this.want;
      this.traversing = true;
      this.h.go(-n);
    }
  }

  /**
   * A popstate arrived at `depth`. Returns how many layers the user asked to
   * close (0: it was our own go(), or a forward move).
   */
  popped(depth: number): number {
    const d = Math.max(0, depth);
    if (this.traversing) {
      this.traversing = false;
      this.current = d;
      this.sync(this.want);
      return 0;
    }
    if (d >= this.current) {
      // Forward (or nothing): the extra entries go on the next sync.
      this.current = d;
      this.sync(this.want);
      return 0;
    }
    const steps = this.current - d;
    this.current = d;
    this.holdUntil = this.now() + BACK_SETTLE_MS;
    return steps;
  }

  /** A Back button in the frame: through the history, so it stays in step; false when there's no entry to go back over. */
  back(): boolean {
    if (this.traversing || this.current === 0) return false;
    this.h.go(-1);
    return true;
  }
}

/** A computed `rgb()`/`rgba()` color dark enough that the bar's title must be light over it (a terminal's black). */
export function darkColor(c: string | undefined): boolean {
  const m = c ? /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(c) : null;
  if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.35;
}
