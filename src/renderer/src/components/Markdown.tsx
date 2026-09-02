import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

const withBreaks = [remarkGfm, remarkBreaks];
const noBreaks = [remarkGfm];

// Links open in the system browser: every window's open handler hands the URL
// to shell.openExternal and denies the in-app popup.
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

/** `breaks`: render single newlines as line breaks (right for agent reports,
 * wrong for hard-wrapped documents like the README). */
export function Markdown({ text, breaks = true }: { text: string; breaks?: boolean }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={breaks ? withBreaks : noBreaks} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
