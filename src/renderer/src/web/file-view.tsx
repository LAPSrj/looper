import { lazy, Suspense, type ReactNode } from 'react';
import { Markdown } from '../components/Markdown';
import { CodeBlock } from '../components/ToolContent';
import { binaryKind, type ViewerKind } from './dialog-flows';
import type { FileView } from './file-flows';

// Each kind's renderer loads the first time a file of its kind is shown: pdf.js is over a megabyte,
// and the Office readers (docx-preview, @silurus/ooxml) more.
const PdfPages = lazy(() => import('./PdfPages'));
const HtmlFrame = lazy(() => import('../components/preview/HtmlFrame'));
const CsvTable = lazy(() => import('../components/preview/CsvTable'));
const DocxPages = lazy(() => import('../components/preview/DocxPages'));
const XlsxSheets = lazy(() => import('../components/preview/XlsxSheets'));
const PptxSlides = lazy(() => import('../components/preview/PptxSlides'));

/** How a file of a kind that has a choice shows: as its source text (HTML, Markdown, CSV), or an HTML page laid out at a desktop's width. */
export interface ViewOptions {
  source?: boolean;
  desktopWidth?: boolean;
}

/**
 * A file's bytes as the viewer shows them: an image as a data: URL (the browser's FileReader encodes it, off the
 * page's thread), a document's bytes as they are, and text decoded.
 */
export async function bytesView(bytes: Uint8Array, kind: ViewerKind, imageType: string): Promise<Pick<FileView, 'url' | 'text' | 'data'>> {
  if (kind === 'image') {
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error ?? new Error("The image couldn't be read."));
      r.readAsDataURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: imageType }));
    });
    return { url, text: null, data: null };
  }
  if (!binaryKind(kind)) return { url: null, text: new TextDecoder().decode(bytes), data: null };
  // Its own buffer: a view into a larger one is copied out.
  const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
  return { url: null, text: null, data };
}

/** The kinds that can show as their source text instead (View Code). */
export const hasSource = (kind: ViewerKind): boolean => kind === 'html' || kind === 'markdown' || kind === 'csv';

/** A toggle of how a file shows, as a phone's bar and the Preview window's toolbar list it; `on` while it isn't at its default. */
export interface ViewToggle {
  id: string;
  label: string;
  icon: string;
  on: boolean;
  disabled?: boolean;
  run: () => void;
}

/** View Code for HTML, Markdown and CSV, and Desktop Width for HTML (off while its code shows). */
export function viewToggles(kind: ViewerKind, options: ViewOptions, set: (next: ViewOptions) => void): ViewToggle[] {
  if (!hasSource(kind)) return [];
  const source = !!options.source;
  return [
    ...(kind === 'html'
      ? [{ id: 'desktopWidth', label: 'Desktop Width', icon: 'desktopWidth', on: !!options.desktopWidth && !source, disabled: source, run: () => set({ ...options, desktopWidth: !options.desktopWidth }) }]
      : []),
    { id: 'viewCode', label: 'View Code', icon: 'source', on: source, run: () => set({ ...options, source: !source }) },
  ];
}

/** The kinds that fill the viewer and scroll themselves (a frame, a table, a deck's slides). */
const FILLS: ViewerKind[] = ['html', 'csv', 'xlsx', 'pptx'];

/** The viewer's layout class for a kind that fills it its own way, with its leading space; '' for the others. */
export const viewerLayout = (view: FileView, options?: ViewOptions): string => {
  if (options?.source && hasSource(view.kind)) return ' code';
  if (view.kind === 'image' || view.kind === 'pdf' || view.kind === 'code') return ` ${view.kind}`;
  return FILLS.includes(view.kind) ? ` fill ${view.kind}` : '';
};

/**
 * A file shown before it's downloaded, as the activity panel shows it: an image (`image` draws it),
 * a PDF's pages, a Word document's pages, a workbook's sheets, a deck's slides, an HTML page in a frame
 * that runs no scripts, a CSV as a table, code in its syntax colors, Markdown formatted, or text.
 * `classes`: the frame's for a note (Loading…, an error) and for plain text.
 */
export function FileViewContent({
  view,
  name,
  classes,
  image,
  options,
}: {
  view: FileView;
  name: string;
  classes: { note: string; text: string };
  image: (url: string) => ReactNode;
  options?: ViewOptions;
}) {
  const loading = <div className={classes.note}>Loading…</div>;
  if (view.error) return <div className={classes.note}>{view.error}</div>;
  if (view.kind === 'image') return view.url ? image(view.url) : loading;
  if (binaryKind(view.kind)) {
    if (!view.data) return loading;
    const data = view.data;
    return (
      <Suspense fallback={loading}>
        {view.kind === 'pdf' ? (
          <PdfPages data={data} name={name} />
        ) : view.kind === 'docx' ? (
          <DocxPages data={data} name={name} />
        ) : view.kind === 'xlsx' ? (
          <XlsxSheets data={data} name={name} />
        ) : (
          <PptxSlides data={data} name={name} />
        )}
      </Suspense>
    );
  }
  if (view.text === null) return loading;
  if (options?.source && hasSource(view.kind)) return <CodeBlock text={view.text} file={name} />;
  if (view.kind === 'markdown') return <Markdown text={view.text} breaks={false} />;
  if (view.kind === 'html')
    return (
      <Suspense fallback={loading}>
        <HtmlFrame html={view.text} name={name} desktop={!!options?.desktopWidth} page={view.htmlPage} />
      </Suspense>
    );
  if (view.kind === 'csv')
    return (
      <Suspense fallback={loading}>
        <CsvTable text={view.text} name={name} />
      </Suspense>
    );
  if (view.kind === 'code') return <CodeBlock text={view.text} file={name} />;
  return <pre className={classes.text}>{view.text}</pre>;
}
