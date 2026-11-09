import { Fragment, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Measured } from '../perf';

const withBreaks = [remarkGfm, remarkBreaks];
const noBreaks = [remarkGfm];

// Links open in the system browser: every window's open handler hands the URL
// to shell.openExternal and denies the in-app popup.
const external: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

// A table wider than the text scrolls sideways instead of squeezing its columns.
const table: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
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
  const components: Components = useMemo(() => {
    const img: Components = resolveImage
      ? {
          img: ({ node: _node, src, ...props }) => (
            <img {...props} src={resolveImage(String(src ?? '')) ?? src} />
          ),
        }
      : {};
    if (!onNavigate) return { ...external, ...table, ...img };
    return {
      ...table,
      ...img,
      a: ({ node: _node, href, ...props }) =>
        href && !/^[a-z][a-z+.-]*:/i.test(href) ? (
          <a
            {...props}
            href={href}
            onClick={(e) => {
              e.preventDefault();
              onNavigate(href);
            }}
          />
        ) : (
          <a {...props} href={href} target="_blank" rel="noreferrer" />
        ),
    };
  }, [onNavigate, resolveImage]);
  return (
    <div className="markdown">
      <Measured id="Markdown">
        <ReactMarkdown remarkPlugins={breaks ? withBreaks : noBreaks} components={components}>
          {text}
        </ReactMarkdown>
      </Measured>
    </div>
  );
}
