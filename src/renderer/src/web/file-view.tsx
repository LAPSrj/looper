import { lazy, Suspense, type ReactNode } from 'react';
import { Markdown } from '../components/Markdown';
import { CodeBlock } from '../components/ToolContent';
import type { FileView } from './file-flows';

/** pdf.js is over a megabyte, so it loads the first time a PDF is shown. */
const PdfPages = lazy(() => import('./PdfPages'));

/** The viewer's layout class for a kind that fills it its own way, with its leading space; '' for the others. */
export const viewerLayout = (view: FileView): string => (view.kind === 'image' || view.kind === 'pdf' || view.kind === 'code' ? ` ${view.kind}` : '');

/**
 * A file shown before it's downloaded, as the activity panel shows it: an image (`image` draws it),
 * a PDF's pages, code in its syntax colors, Markdown formatted, or text. `classes`: the frame's for a note
 * (Loading…, an error) and for plain text.
 */
export function FileViewContent({ view, name, classes, image }: { view: FileView; name: string; classes: { note: string; text: string }; image: (url: string) => ReactNode }) {
  const loading = <div className={classes.note}>Loading…</div>;
  if (view.error) return <div className={classes.note}>{view.error}</div>;
  if (view.kind === 'image') return view.url ? image(view.url) : loading;
  if (view.kind === 'pdf')
    return view.pdf ? (
      <Suspense fallback={loading}>
        <PdfPages data={view.pdf} name={name} />
      </Suspense>
    ) : (
      loading
    );
  if (view.text === null) return loading;
  if (view.kind === 'markdown') return <Markdown text={view.text} breaks={false} />;
  if (view.kind === 'code') return <CodeBlock text={view.text} file={name} />;
  return <pre className={classes.text}>{view.text}</pre>;
}
