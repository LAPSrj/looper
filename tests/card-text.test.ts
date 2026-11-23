import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'src');
const phoneCss = fs.readFileSync(path.join(SRC, 'phone.css'), 'utf8');
const sessionsApp = fs.readFileSync(path.join(SRC, 'SessionsApp.tsx'), 'utf8');

/** The declarations of each rule whose selector (comments out) starts with `start` and ends with `end`. */
function rules(css: string, start: string, end = ''): string[] {
  const bare = css.replace(/\/\*[^]*?\*\//g, '');
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].trim().startsWith(start) && m[1].trim().endsWith(end)).map((m) => m[2]);
}

describe("the text of a phone's dashboard cards", () => {
  it("is smaller than the chat's own: 14 / 19 on iOS (Leandro's choice, between Subheadline and Footnote) and Material's body medium (14 / 20)", () => {
    // The chat's own screen keeps 16 (Callout on iOS, body large on Android).
    expect(rules(phoneCss, 'html.phone-window .chat-msg', 'html.phone-window .chat-msg').join('')).toContain('font-size: calc(16 * var(--u))');
    const tokens = rules(phoneCss, 'html.phone-window .phone-sessions .overview-card', '.overview-card').join('\n');
    expect(tokens).toContain('--card-msg-size: calc(14 * var(--u))');
    expect(tokens).toContain('--card-msg-lh: calc(19 * var(--u))');
    expect(tokens).toContain('--card-msg-tracking: -0.15px');
    const android = rules(phoneCss, "html.phone-window[data-platform='android'] .phone-sessions .overview-card", '.overview-card').join('\n');
    expect(android).not.toContain('--card-msg-size');
    expect(android).toContain('--card-msg-lh: calc(20 * var(--u))');
    expect(android).toContain('--card-msg-tracking: 0.25px');
  });

  it("applies to a card's messages, with the style's line height, and not to the chat's own", () => {
    const own = rules(phoneCss, 'html.phone-window .phone-sessions .overview-card :is(.chat-msg');
    expect(own.length).toBe(1);
    expect(own[0]).toContain('font-size: var(--card-msg-size)');
    expect(own[0]).toContain('line-height: var(--card-msg-lh)');
    expect(own[0]).toContain('letter-spacing: var(--card-msg-tracking)');
  });

  it('fades the text of a small card in at the top where it runs out, instead of cutting a line', () => {
    const fade = rules(phoneCss, 'html.phone-window .phone-sessions .overview-small', '[data-cut]').join('');
    // Over the top line's own height, which is the style's line height.
    expect(fade).toContain('mask-image: linear-gradient(to bottom, transparent, #000 var(--small-lh))');
    // CardMessages marks the card's messages once they scroll, and not before.
    expect(sessionsApp).toMatch(/const cutTop = [^]*?scrollTop > 1[^]*?dataset\.cut/);
    expect(sessionsApp).toMatch(/onScroll=\{[^}]*cutTop\(e\.currentTarget\)/);
  });

  it("shows whole lines only in a small card's text box: a whole number of lines tall, with no gap that breaks the line grid", () => {
    const box = rules(phoneCss, 'html.phone-window .phone-sessions .overview-small > .overview-messages', '.overview-messages').join('');
    expect(box).toContain('height: calc(3 * var(--small-lh))');
    expect(box).toContain('flex: none');
    expect(box).toContain('gap: 0');
    expect(box).toContain('line-height: var(--small-lh)');
    // The card's own height comes from its lines, not a fixed 124 px that cuts the last one.
    const card = rules(phoneCss, 'html.phone-window .phone-sessions .focus-strip > .overview-small', '.overview-small').join('');
    expect(card).not.toMatch(/height: \d+px/);
  });

  it("sets a small card's text in Footnote on iOS (13 / 18, tracking -0.08) and Material 3's body small on Android (12 / 16, tracking 0.4)", () => {
    const ios = rules(phoneCss, 'html.phone-window .phone-sessions .overview-small', '.overview-small').join('\n');
    expect(ios).toContain('--small-size: calc(13 * var(--u))');
    expect(ios).toContain('--small-lh: calc(18 * var(--u))');
    expect(ios).toContain('--small-tracking: -0.08px');
    const android = rules(phoneCss, "html.phone-window[data-platform='android'] .phone-sessions .overview-small", '.overview-small').join('\n');
    expect(android).toContain('--small-size: calc(12 * var(--u))');
    expect(android).toContain('--small-lh: calc(16 * var(--u))');
    expect(android).toContain('--small-tracking: 0.4px');
    expect(rules(phoneCss, 'html.phone-window .phone-sessions .overview-small > .overview-messages', '.overview-messages').join('')).toContain('letter-spacing: var(--small-tracking)');
  });
});
