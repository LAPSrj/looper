import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { platform } from '../platform';
import { atEnd } from './newest-first';

/**
 * Keeps the floating box's height in `--chat-dock-h`, for the conversation to scroll clear of it, and a reader at the
 * conversation's end there as the box takes more or less room.
 */
function useDockHeight(sectionRef: RefObject<HTMLElement | null>, on: boolean): void {
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!on || !section) return;
    const parts = () => {
      let dock: HTMLElement | null = null;
      let scroll: HTMLElement | null = null;
      for (const el of section.children) {
        if (el.classList.contains('conversation-dock')) dock = el as HTMLElement;
        else if (el.classList.contains('chat-scroll')) scroll = el as HTMLElement;
      }
      return { dock, scroll };
    };
    const measure = () => {
      const { dock, scroll } = parts();
      const stays = !!scroll && atEnd(scroll);
      section.style.setProperty('--chat-dock-h', `${dock?.offsetHeight ?? 0}px`);
      if (scroll && stays) scroll.scrollTop = scroll.scrollHeight;
    };
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      const { dock } = parts();
      // The border box: the box's padding changes alone as the keyboard and the home indicator's inset come and go.
      if (dock) ro.observe(dock, { box: 'border-box' });
      measure();
    };
    // The box comes and goes (a subagent that finishes, a run that stops taking guidance).
    const mo = new MutationObserver(watch);
    mo.observe(section, { childList: true });
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [sectionRef, on]);
}

/**
 * A conversation with its message box under it, laid out once for every one: a chat, a subagent's conversation, a
 * task run's with its guidance box, the task builder's. `children`: the conversation (a Conversation), with anything
 * that goes over it first (a find bar). `box`: the message box and what goes with it (a run's question), or nothing.
 * On iOS the box floats over the conversation's end, as Messages draws it: the conversation runs to the screen's
 * bottom under it, scrolls clear of it and has the soft scroll edge behind it (ios.md: Scroll edge effects).
 * Elsewhere the box sits under the conversation, on the conversation's background. `float` false: under the
 * conversation on iOS too (a dashboard card, whose conversation scrolls inside the card).
 */
export function ConversationWithBox({ children, box, float = true }: { children: ReactNode; box?: ReactNode; float?: boolean }) {
  const sectionRef = useRef<HTMLElement>(null);
  const floats = float && platform === 'ios';
  useDockHeight(sectionRef, floats);
  return (
    <section className={floats ? 'conversation-box floats' : 'conversation-box'} ref={sectionRef}>
      {children}
      {box && <div className="conversation-dock">{box}</div>}
    </section>
  );
}
