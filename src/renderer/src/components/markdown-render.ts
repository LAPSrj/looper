import { createElement, type ReactNode } from 'react';
import MarkdownIt, { type PluginSimple } from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import footnote from 'markdown-it-footnote';
import { isWebLink } from '../../../shared/links';

/**
 * Markdown as React elements, from markdown-it's tokens: GitHub's flavor (tables, strikethrough, task lists,
 * footnotes, links found in the text) with raw HTML shown as text. It replaced react-markdown, whose parser
 * took 1.4 ms for an agent's reply against 0.06 ms here, so it's what opening a long chat spent its time on.
 */
export interface MarkdownHandlers {
  link: (href: string, title: string | undefined, children: ReactNode[], key: number) => ReactNode;
  image: (src: string, alt: string, title: string | undefined, key: number) => ReactNode;
}

const make = (breaks: boolean) => {
  // The plugin's types are written against markdown-it's older typings.
  const md = new MarkdownIt({ html: false, linkify: true, breaks, typographer: false }).use(footnote as unknown as PluginSimple);
  // A link with a scheme only to the web or e-mail (isWebLink), like react-markdown's; one without (a help page's
  // link to another) as markdown-it allows it. Anything else stays text.
  const allowed = md.validateLink.bind(md);
  md.validateLink = (url) => allowed(url) && (!/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) || isWebLink(url));
  return md;
};
/** Found in the text, a link counts as GitHub counts one: with a scheme, starting "www." or an e-mail address, not every word that looks like a domain. */
const autolinked = (text: string) => /^([a-z][a-z0-9+.-]*:|www\.)/i.test(text) || text.includes('@');
const parsers = { breaks: make(true), plain: make(false) };

/** A node being built: its tag, props and children. */
interface Open {
  tag: string;
  props: Record<string, unknown>;
  kids: ReactNode[];
}

let footnoteRuns = 0;

/** A footnote link scrolls to its target: the windows route by the URL's hash, so a link mustn't change it. */
const jump = (id: string) => (e: { preventDefault: () => void }) => {
  e.preventDefault();
  // No DOM types here: the unit tests check this file under the node tsconfig.
  const doc = (globalThis as unknown as { document?: { getElementById(id: string): { scrollIntoView(o: object): void } | null } }).document;
  doc?.getElementById(id)?.scrollIntoView({ block: 'nearest' });
};

export function renderMarkdown(text: string, breaks: boolean, h: MarkdownHandlers): ReactNode[] {
  const tokens = (breaks ? parsers.breaks : parsers.plain).parse(text, {});
  // Footnote ids unique to this message, since a chat shows many.
  const fn = `fn${++footnoteRuns}-`;
  const root: Open = { tag: '', props: {}, kids: [] };
  const stack: Open[] = [root];
  const top = () => stack[stack.length - 1];
  const add = (node: ReactNode) => top().kids.push(node);
  const key = () => top().kids.length;

  const open = (tag: string, props: Record<string, unknown> = {}) => {
    const node: Open = { tag, props, kids: [] };
    stack.push(node);
  };
  const close = () => {
    const node = stack.pop()!;
    const parent = top();
    if (node.tag === '') parent.kids.push(...node.kids);
    else parent.kids.push(createElement(node.tag, { key: parent.kids.length, ...node.props }, ...node.kids));
  };

  /** A list item just opened: its text may start with GitHub's task box, "[ ] " or "[x] ". */
  let itemStart = false;
  const inline = (children: Token[]) => {
    if (itemStart) {
      itemStart = false;
      const m = children[0]?.type === 'text' ? /^\[([ xX])\] /.exec(children[0].content) : null;
      if (m) {
        // GitHub's classes on the item and its list.
        const li = stack.findLast((o) => o.tag === 'li');
        const list = li && stack[stack.indexOf(li) - 1];
        if (li) li.props.className = 'task-list-item';
        if (list) list.props.className = 'contains-task-list';
        add(createElement('input', { key: key(), type: 'checkbox', disabled: true, checked: m[1] !== ' ', readOnly: true }));
        add(' ');
        children = [Object.assign(Object.create(Object.getPrototypeOf(children[0])), children[0], { content: children[0].content.slice(m[0].length) }), ...children.slice(1)];
      }
    }
    for (let i = 0; i < children.length; i++) {
      const t = children[i];
      switch (t.type) {
        case 'text':
          add(t.content);
          break;
        case 'code_inline':
          add(createElement('code', { key: key() }, t.content));
          break;
        case 'softbreak':
          add(breaks ? createElement('br', { key: key() }) : '\n');
          break;
        case 'hardbreak':
          add(createElement('br', { key: key() }));
          break;
        case 'strong_open':
          open('strong');
          break;
        case 'em_open':
          open('em');
          break;
        case 's_open':
          open('del');
          break;
        case 'strong_close':
        case 'em_close':
        case 's_close':
          close();
          break;
        case 'link_open': {
          // Its children until link_close go to the handler.
          const node: Open = { tag: '', props: {}, kids: [] };
          stack.push(node);
          let depth = 1;
          let j = i + 1;
          const inner: Token[] = [];
          for (; j < children.length; j++) {
            if (children[j].type === 'link_open') depth++;
            else if (children[j].type === 'link_close' && --depth === 0) break;
            inner.push(children[j]);
          }
          inline(inner);
          stack.pop();
          if (t.markup === 'linkify' && !autolinked(inner.map((x) => x.content).join(''))) top().kids.push(...node.kids);
          else add(h.link(t.attrGet('href') ?? '', t.attrGet('title') ?? undefined, node.kids, key()));
          i = j;
          break;
        }
        case 'image':
          add(h.image(t.attrGet('src') ?? '', t.content, t.attrGet('title') ?? undefined, key()));
          break;
        case 'footnote_ref': {
          const n = Number(t.meta.id) + 1;
          const sub = t.meta.subId > 0 ? `:${t.meta.subId}` : '';
          add(createElement('sup', { key: key(), className: 'footnote-ref' }, createElement('a', { href: `#${fn}${n}`, id: `${fn}ref${n}${sub}`, onClick: jump(`${fn}${n}`) }, String(n))));
          break;
        }
        default:
          if (t.content) add(t.content);
      }
    }
  };

  for (const t of tokens) {
    if (t.type !== 'inline' && t.type !== 'paragraph_open') itemStart = false;
    switch (t.type) {
      case 'inline':
        inline(t.children ?? []);
        break;
      case 'paragraph_open':
        // A tight list's paragraphs aren't drawn as paragraphs.
        open(t.hidden ? '' : 'p');
        break;
      case 'heading_open':
      case 'blockquote_open':
      case 'thead_open':
      case 'tbody_open':
      case 'tr_open':
        open(t.tag);
        break;
      case 'bullet_list_open':
        open('ul');
        break;
      case 'ordered_list_open': {
        const start = Number(t.attrGet('start') ?? 1);
        open('ol', start !== 1 ? { start } : {});
        break;
      }
      case 'list_item_open':
        open('li');
        itemStart = true;
        break;
      case 'table_open':
        // A table wider than the text scrolls sideways instead of squeezing its columns.
        open('div', { className: 'md-table' });
        open('table');
        break;
      case 'table_close':
        close();
        close();
        break;
      case 'th_open':
      case 'td_open': {
        const align = /text-align:(\w+)/.exec(t.attrGet('style') ?? '')?.[1];
        open(t.tag, align ? { style: { textAlign: align } } : {});
        break;
      }
      case 'fence':
      case 'code_block': {
        const lang = t.info.trim().split(/\s+/)[0];
        add(createElement('pre', { key: key() }, createElement('code', lang ? { className: `language-${lang}` } : {}, t.content)));
        break;
      }
      case 'hr':
        add(createElement('hr', { key: key() }));
        break;
      case 'footnote_block_open':
        open('section', { className: 'footnotes' });
        open('ol');
        break;
      case 'footnote_block_close':
        close();
        close();
        break;
      case 'footnote_open':
        open('li', { id: `${fn}${Number(t.meta.id) + 1}` });
        break;
      case 'footnote_anchor': {
        const n = Number(t.meta.id) + 1;
        const sub = t.meta.subId > 0 ? `:${t.meta.subId}` : '';
        add(' ');
        add(createElement('a', { key: key(), href: `#${fn}ref${n}${sub}`, className: 'footnote-back', 'aria-label': 'Back to the text', onClick: jump(`${fn}ref${n}${sub}`) }, '↩'));
        break;
      }
      case 'html_block':
        add(t.content);
        break;
      default:
        if (t.nesting === -1) close();
    }
  }
  return root.kids;
}
