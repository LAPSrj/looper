// No DOM: the unit tests load this file (the hook that uses it is useTypingCard.ts).

/** Room kept between the card and the bar above it, and between the card and the keyboard. */
export const TYPING_GAP = 8;
/** The least a card typed in is made: its title and message box, with a line of its conversation. */
export const TYPING_MIN_HEIGHT = 160;

/** Where a card stands and how far it scrolls, in the page's coordinates (getBoundingClientRect and the scroller's own). */
export interface TypingGeometry {
  /** The scroller's top: what shows starts there, under the bar. */
  top: number;
  /** Where what shows ends: the keyboard's top (Safari's form bar included), or the scroller's bottom when that is higher. */
  bottom: number;
  cardTop: number;
  cardHeight: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** The card's height, the scroller's scrollTop that puts it at the top, and the room to add below it so the scroller can go that far. */
export interface TypingFit {
  height: number;
  scrollTop: number;
  extra: number;
}

/**
 * A card whose message box is typed in, with the on-screen keyboard up: it fills what shows between the bar and the
 * keyboard, with TYPING_GAP above and below, so its conversation runs down to the message box right above the keyboard
 * ("keep important parts of your interface visible while the virtual keyboard is onscreen", HIG Virtual keyboards). The
 * page scrolls it to the top, taking the large title and what's above the card out of view, as content scrolling under
 * a large title does.
 */
export function typingCardFit(g: TypingGeometry): TypingFit {
  const height = Math.max(TYPING_MIN_HEIGHT, Math.floor(g.bottom - g.top - 2 * TYPING_GAP));
  // The card ends right above the keyboard. Where less than TYPING_MIN_HEIGHT shows (a phone held sideways), its top
  // goes under the bar rather than its message box under the keyboard.
  const scrollTop = Math.max(0, Math.round(g.scrollTop + g.cardTop - (g.bottom - TYPING_GAP - height)));
  // The card's new height changes how far the scroller goes.
  const max = g.scrollHeight + (height - g.cardHeight) - g.clientHeight;
  return { height, scrollTop, extra: Math.max(0, Math.ceil(scrollTop - max)) };
}
