import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

const withBreaks = [remarkGfm, remarkBreaks];
const noBreaks = [remarkGfm];

// Links open in the system browser: every window's open handler hands the URL
// to shell.openExternal and denies the in-app popup.
const external: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

/** `breaks`: render single newlines as line breaks (right for agent reports,
 * wrong for hard-wrapped documents like the user guide).
 * `onNavigate`: relative links (no scheme) call it instead of opening a browser. */
export function Markdown({
  text,
  breaks = true,
  onNavigate,
}: {
  text: string;
  breaks?: boolean;
  onNavigate?: (href: string) => void;
}) {
  const components: Components = useMemo(() => {
    if (!onNavigate) return external;
    return {
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
  }, [onNavigate]);
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={breaks ? withBreaks : noBreaks} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
