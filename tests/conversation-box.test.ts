import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createElement, type FunctionComponent, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const renderer = path.join(__dirname, '..', 'src', 'renderer', 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const tsx = walk(renderer)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => [path.relative(renderer, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')] as const);
const phoneCss = readFileSync(path.join(renderer, 'phone.css'), 'utf8');

describe('a conversation with a message box', () => {
  it('is laid out by ConversationWithBox wherever a conversation is drawn', () => {
    const drawing = tsx.filter(([, text]) => /<Conversation\b/.test(text)).map(([file]) => file);
    // The chat, every transcript (a subagent's, a task run's with its guidance box) and the task builder.
    expect(drawing).toEqual(expect.arrayContaining(['components/ChatView.tsx', 'components/Transcript.tsx', 'BuilderApp.tsx']));
    for (const [file, text] of tsx) if (drawing.includes(file)) expect(text, file).toMatch(/<ConversationWithBox\b/);
  });

  it("gives a subagent's box and a task run's guidance box to it, not under it by hand", () => {
    const transcript = tsx.find(([file]) => file === 'components/Transcript.tsx')![1];
    expect(transcript).toMatch(/<ConversationWithBox float=\{!embedded\} box=\{footer\}>/);
    expect(transcript).not.toMatch(/<\/Conversation>\s*\{footer\}/);
  });

  it("keeps the box's height only in ConversationWithBox", () => {
    for (const [file, text] of tsx) if (file !== 'components/ConversationWithBox.tsx') expect(text, file).not.toMatch(/--chat-dock-h/);
  });
});

describe('ConversationWithBox', () => {
  // The phone's page: its tab's session names the platform (platform.ts), as on an iPhone, or the desktop app's preload.
  const load = async (where: 'ios' | 'electron'): Promise<FunctionComponent<{ children?: ReactNode; box?: ReactNode; float?: boolean }>> => {
    vi.resetModules();
    const element = { dataset: {}, classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined, contains: () => false }, style: {} };
    const top = { __looperSession: { platform: 'ios' } };
    Object.assign(globalThis, {
      window: where === 'ios' ? { top, location: { search: '' }, addEventListener: () => undefined } : { looper: {}, addEventListener: () => undefined },
      document: { documentElement: element, addEventListener: () => undefined },
    });
    // Read by its path at run time: the tests' type check (tsconfig.node.json) doesn't take the renderer's JSX.
    const mod = '../src/renderer/src/components/ConversationWithBox';
    return ((await import(/* @vite-ignore */ mod)) as { ConversationWithBox: FunctionComponent<{ children?: ReactNode; box?: ReactNode; float?: boolean }> }).ConversationWithBox;
  };
  const conversation = createElement('div', { className: 'chat-scroll' });
  const box = createElement('div', { className: 'chat-composer phone-composer' });

  it('floats the box over the conversation on iOS, after it, in its own dock', async () => {
    const C = await load('ios');
    const html = renderToStaticMarkup(createElement(C, { box }, conversation));
    expect(html).toBe('<section class="conversation-box floats"><div class="chat-scroll"></div><div class="conversation-dock"><div class="chat-composer phone-composer"></div></div></section>');
  });

  it("keeps a dashboard card's box under its conversation, and draws no dock without a box", async () => {
    const C = await load('ios');
    expect(renderToStaticMarkup(createElement(C, { box, float: false }, conversation))).toMatch(/^<section class="conversation-box"><div class="chat-scroll"><\/div><div class="conversation-dock">/);
    expect(renderToStaticMarkup(createElement(C, { box: undefined }, conversation))).toBe('<section class="conversation-box floats"><div class="chat-scroll"></div></section>');
    expect(renderToStaticMarkup(createElement(C, { box: false }, conversation))).not.toContain('conversation-dock');
  });

  it('puts the box under the conversation on the desktop', async () => {
    const C = await load('electron');
    expect(renderToStaticMarkup(createElement(C, { box }, conversation))).toMatch(/^<section class="conversation-box"><div class="chat-scroll">/);
  });
});

describe("phone.css: the conversation's box", () => {
  it("floats every conversation's box on iOS, not only the chat screen's", () => {
    expect(phoneCss).not.toMatch(/\.builder-chat:has\(/);
    expect(phoneCss).not.toMatch(/:not\(\.overview-chat \*\)/);
    expect(phoneCss).toMatch(/\[data-platform='ios'\] \.conversation-box\.floats > \.conversation-dock \{[^}]*position: absolute;/);
    expect(phoneCss).toMatch(/\[data-platform='ios'\] \.conversation-box\.floats > \.chat-scroll \{[^}]*padding-bottom: calc\(var\(--chat-dock-h, 0px\) \+ 12px\)/);
    // The soft scroll edge behind the box, only where there is one.
    expect(phoneCss).toMatch(/\.conversation-box\.floats > \.conversation-dock::before \{[^}]*backdrop-filter: blur\(10px\)/);
  });

  it("paints a sheet's conversation background behind its box too, not a band of the sheet's gray", () => {
    expect(phoneCss).toMatch(/:is\(\.pg-sheet, \.pg-split-inspector\) \.conversation-box \{\s*background: var\(--bg\);/);
    expect(phoneCss).not.toMatch(/:is\(\.pg-sheet, \.pg-split-inspector\) \.chat-scroll \{\s*background/);
  });
});
