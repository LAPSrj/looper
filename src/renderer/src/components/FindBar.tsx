import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { perfSpan } from '../perf';
import { AddonSearchBox } from './AddonPane';

/** How often a Find over changing content finds again (ms). */
const AGAIN_MS = 150;

/** What is searched for, and which of its matches is the current one (it wraps around both ways). */
export interface FindState {
  query: string;
  index: number;
}

const wrap = (index: number, count: number) => ((index % count) + count) % count;

/** The visible matches of `query` in `root`, in document order (case-insensitive, within one text node). */
function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  if (!needle) return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // Text in a closed <details> isn't on screen.
    acceptNode: (n) => (n.parentElement?.checkVisibility() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const hay = node.data.toLowerCase();
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + needle.length);
      ranges.push(r);
    }
  }
  return ranges;
}

/** The element that scrolls `node` into view: the nearest scrolling one up to `root`, else `root`. */
function scrollerOf(node: Node, root: HTMLElement): HTMLElement {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
  }
  return root;
}

/**
 * Every match of `find` in `root` highlighted, and the current one brought into
 * view when it changes. What `root` shows changing (rows drawn above, text coming
 * in) only updates the highlights, so reading elsewhere isn't interrupted, and
 * the current match stays the same one as matches are added before it (its new
 * index goes to `setFind`, for the query it was found with only, so what's typed
 * meanwhile isn't lost). `onScrolled` hears when it moved the view. Returns how
 * many matches there are.
 */
export function useFindHighlights(
  root: RefObject<HTMLElement | null>,
  find: FindState | null,
  setFind: Dispatch<SetStateAction<FindState | null>>,
  onScrolled?: () => void,
): number {
  const [matches, setMatches] = useState(0);
  const [changed, setChanged] = useState(0);
  const finding = find !== null;
  // Find again while what's searched changes, at most every AGAIN_MS: each pass repaints every match.
  useEffect(() => {
    const el = root.current;
    if (!el || !finding) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      timer ??= setTimeout(() => {
        timer = null;
        setChanged((n) => n + 1);
      }, AGAIN_MS);
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [root, finding]);
  const scrolledTo = useRef('');
  // The current match last shown, by where it starts, to follow it as matches are added before it.
  const shown = useRef<{ query: string; index: number; node: Node; offset: number } | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || !find) {
      CSS.highlights.delete('chat-find');
      CSS.highlights.delete('chat-find-current');
      setMatches(0);
      shown.current = null;
      return;
    }
    const ranges = perfSpan('Find matches', () => findRanges(el, find.query));
    setMatches(ranges.length);
    perfSpan('Find highlights', () => CSS.highlights.set('chat-find', new Highlight(...ranges)));
    if (!ranges.length) {
      CSS.highlights.delete('chat-find-current');
      shown.current = null;
      return;
    }
    const was = shown.current;
    if (was && was.query === find.query && was.index === find.index) {
      const now = ranges.findIndex((r) => r.startContainer === was.node && r.startOffset === was.offset);
      if (now >= 0 && now !== wrap(find.index, ranges.length)) {
        // Same match, new place in the list: no scrolling to it again.
        scrolledTo.current = `${find.query}\n${now}`;
        shown.current = { ...was, index: now };
        const query = find.query;
        setFind((f) => (f && f.query === query ? { ...f, index: now } : f));
        return;
      }
    }
    const current = ranges[wrap(find.index, ranges.length)];
    shown.current = { query: find.query, index: find.index, node: current.startContainer, offset: current.startOffset };
    CSS.highlights.set('chat-find-current', new Highlight(current));
    const key = `${find.query}\n${find.index}`;
    if (scrolledTo.current === key) return;
    scrolledTo.current = key;
    const scroller = scrollerOf(current.startContainer, el);
    const box = current.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom) {
      scroller.scrollTop += box.top - view.top - view.height / 2;
      onScrolled?.();
    }
    // setFind is stable; onScrolled is read when it's called, so a new function each render isn't a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find, changed, root]);
  return matches;
}

/**
 * The find field's `inputRef`, and `focus`, which gives the field the focus and selects what it holds once it shows
 * (the strip may open in the same render): Find asked again while it's open goes back to the field.
 */
export function useFindFocus(): { inputRef: (el: HTMLInputElement | null) => void; focus: () => void } {
  const input = useRef<HTMLInputElement | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!asked) return;
    input.current?.focus();
    input.current?.select();
  }, [asked]);
  const inputRef = useCallback((el: HTMLInputElement | null) => {
    input.current = el;
  }, []);
  const focus = useCallback(() => setAsked((n) => n + 1), []);
  return { inputRef, focus };
}

/** The find bar over what is searched: the field (Enter and Shift+Enter step), "n of m", Previous, Next and Close. */
export function FindBar({
  find,
  matches,
  onChange,
  onClose,
  inputRef,
}: {
  find: FindState;
  matches: number;
  onChange: (find: FindState) => void;
  onClose: () => void;
  inputRef?: (el: HTMLInputElement | null) => void;
}) {
  const step = (dir: 1 | -1) => onChange({ ...find, index: find.index + dir });
  return (
    <FindStrip
      query={find.query}
      onQuery={(query) => onChange({ query, index: 0 })}
      status={!find.query ? '' : matches ? `${wrap(find.index, matches) + 1} of ${matches}` : 'No matches'}
      onEnter={(back) => step(back ? -1 : 1)}
      onClose={onClose}
      inputRef={inputRef}
    >
      <button className="btn small" disabled={!matches} onClick={() => step(-1)}>
        Previous
      </button>
      <button className="btn small" disabled={!matches} onClick={() => step(1)}>
        Next
      </button>
    </FindStrip>
  );
}

/**
 * A find strip over what it searches: the field, what was found, the strip's own buttons, then Close. Enter in
 * the field does `onEnter` (`back` with Shift); Esc clears the field, then closes the strip.
 */
export function FindStrip({
  query,
  onQuery,
  status,
  onEnter,
  onClose,
  inputRef,
  children,
}: {
  query: string;
  onQuery: (query: string) => void;
  status: string;
  onEnter: (back: boolean) => void;
  onClose: () => void;
  inputRef?: (el: HTMLInputElement | null) => void;
  children: ReactNode;
}) {
  return (
    <div className="chat-find">
      <div
        style={{ display: 'contents' }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter(e.shiftKey);
          else if (e.key === 'Escape') onClose();
          else return;
          e.preventDefault();
        }}
      >
        <AddonSearchBox value={query} placeholder="Find" inputRef={inputRef} onChange={onQuery} />
      </div>
      <span className="muted">{status}</span>
      {children}
      <button className="btn small" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
