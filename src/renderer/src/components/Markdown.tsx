import { Fragment, useMemo, type ReactNode } from 'react';
import { perfSpan } from '../perf';
import { renderMarkdown, type MarkdownHandlers } from './markdown-render';

// Links open in the system browser: every window's open handler hands the URL
// to shell.openExternal and denies the in-app popup.
const externalLink: MarkdownHandlers['link'] = (href, title, children, key) => (
  <a key={key} href={href} title={title} target="_blank" rel="noreferrer">
    {children}
  </a>
);
const plainImage: MarkdownHandlers['image'] = (src, alt, title, key) => <img key={key} src={src} alt={alt} title={title} />;
const plainHandlers: MarkdownHandlers = { link: externalLink, image: plainImage };

/** markdown-it percent-encodes a link's address; a page link is matched as it was written. */
const decoded = (href: string) => {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
};

/**
 * Best-effort parse of text that consists entirely of top-level `<tag>…</tag>`
 * blocks. Anything else — mixed text, unpaired or nested same-name tags —
 * returns null.
 */
export function parseTagSections(text: string): { name: string; content: string }[] | null {
  const re = /^<([A-Za-z][\w-]*)(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>\s*/;
  const sections: { name: string; content: string }[] = [];
  let rest = text.replace(/^\s+/, '');
  while (rest.length > 0) {
    const m = re.exec(rest);
    if (!m) return null;
    sections.push({ name: m[1], content: m[2] });
    rest = rest.slice(m[0].length);
  }
  return sections.length > 0 ? sections : null;
}

const tagLabel = (name: string) =>
  name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

/** Tag sections as label/content rows, dl-style. `mono`: bodies are plain
 * preformatted text (tool results) instead of markdown (messages). */
export function TagSections({ sections, mono }: { sections: { name: string; content: string }[]; mono?: boolean }) {
  return (
    <div className="msg-sections">
      {sections.map((s, i) => (
        <Fragment key={i}>
          <div className="msg-section-label">{tagLabel(s.name)}</div>
          <div>{mono ? <pre className="output">{s.content}</pre> : <Markdown text={s.content} />}</div>
        </Fragment>
      ))}
    </div>
  );
}

/** Markdown text; a fully tag-wrapped one becomes labeled sections instead. */
export function MessageBody({ text }: { text: string }) {
  const sections = useMemo(() => parseTagSections(text), [text]);
  return sections ? <TagSections sections={sections} /> : <Markdown text={text} />;
}

/** A one-line "/name args": a slash command or skill the user ran. */
export const isSlashCommand = (text: string): boolean => /^\/[\w:.-]+(?:[ \t][^\n]*)?$/.test(text.trim());

/** The user's message: a slash command as the plain text it was typed, anything else as MessageBody. */
export function PromptBody({ text }: { text: string }) {
  if (!isSlashCommand(text)) return <MessageBody text={text} />;
  return (
    <div className="markdown">
      <p>{text.trim()}</p>
    </div>
  );
}

/** `breaks`: render single newlines as line breaks (right for agent reports,
 * wrong for hard-wrapped documents like the user guide).
 * `onNavigate`: relative links (no scheme) call it instead of opening a browser.
 * `resolveImage`: maps a relative image src to a real URL (undefined keeps it). */
export function Markdown({
  text,
  breaks = true,
  onNavigate,
  resolveImage,
}: {
  text: string;
  breaks?: boolean;
  onNavigate?: (href: string) => void;
  resolveImage?: (src: string) => string | undefined;
}) {
  const handlers: MarkdownHandlers = useMemo(() => {
    const image: MarkdownHandlers['image'] = resolveImage
      ? (src, alt, title, key) => <img key={key} src={resolveImage(src) ?? src} alt={alt} title={title} />
      : plainImage;
    if (!onNavigate) return { link: externalLink, image };
    return {
      image,
      link: (href, title, children, key) =>
        href && !/^[a-z][a-z+.-]*:/i.test(href) ? (
          <a
            key={key}
            href={href}
            title={title}
            onClick={(e) => {
              e.preventDefault();
              onNavigate(decoded(href));
            }}
          >
            {children}
          </a>
        ) : (
          externalLink(href, title, children, key)
        ),
    };
  }, [onNavigate, resolveImage]);
  const plain = !onNavigate && !resolveImage;
  const body = useMemo(() => (plain ? cachedMarkdown(text, breaks) : parse(text, breaks, handlers)), [plain, text, breaks, handlers]);
  return <div className="markdown">{body}</div>;
}

function parse(text: string, breaks: boolean, handlers: MarkdownHandlers): ReactNode[] {
  return perfSpan('Markdown', () => renderMarkdown(text, breaks, handlers));
}

/**
 * Parsed messages, the most recently used last: opening a chat again doesn't parse the messages it showed before.
 * Kept to about a chat screen's worth of text, so the memory it holds stays small.
 */
const parsed = new Map<string, ReactNode[]>();
const PARSED_MAX_CHARS = 100_000;
let parsedChars = 0;

function cachedMarkdown(text: string, breaks: boolean): ReactNode[] {
  const key = (breaks ? 'b' : 'p') + text;
  const hit = parsed.get(key);
  if (hit) {
    parsed.delete(key);
    parsed.set(key, hit);
    return hit;
  }
  const el = parse(text, breaks, plainHandlers);
  if (key.length > PARSED_MAX_CHARS) return el;
  parsed.set(key, el);
  parsedChars += key.length;
  for (const old of parsed.keys()) {
    if (parsedChars <= PARSED_MAX_CHARS) break;
    parsed.delete(old);
    parsedChars -= old.length;
  }
  return el;
}
