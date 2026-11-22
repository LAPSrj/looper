import { useEffect, useRef, useState } from 'react';
import { fileImageId } from '@shared/messages';
import { baseName } from '@shared/paths';
import { languageOf } from './components/code-languages';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import type { ToolbarGroup } from './components/toolbar-model';
import { NumberInput } from './components/ui';
import { ImageViewer } from './components/ZoomImage';
import { fmtSize } from './format';
import { reportError } from './report-error';
import { imageType, VIEWER_MAX_BYTES, viewerKind, type ViewerKind } from './web/dialog-flows';
import type { FileView } from './web/file-flows';
import { bytesView, FileViewContent, viewerLayout, viewToggles, type ViewOptions } from './web/file-view';

const MIN_ZOOM = 10;
const MAX_ZOOM = 800;

const clamp = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));

let sbWidth: number | null = null;
/** Width of a classic (non-overlay) scrollbar; 0 when scrollbars are overlay. */
function scrollbarWidth(): number {
  if (sbWidth === null) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;overflow:scroll;width:100px;height:100px';
    document.body.appendChild(probe);
    sbWidth = probe.offsetWidth - probe.clientWidth;
    probe.remove();
  }
  return sbWidth;
}

/** What the status bar calls each kind. */
const KIND_NAMES: Record<ViewerKind, string> = {
  image: 'Image',
  pdf: 'PDF',
  markdown: 'Markdown',
  html: 'HTML page',
  csv: 'Delimited text',
  docx: 'Word document',
  xlsx: 'Excel workbook',
  pptx: 'PowerPoint presentation',
  code: 'Code',
  text: 'Text',
};

const isCode = (name: string) => languageOf(name) !== undefined;
const nothing = () => undefined;


/**
 * The Preview window: an image from a conversation, or a file the agent sent, read or wrote, shown as its kind
 * is (an image with zoom, a PDF's pages, a Word document, a workbook's sheets, a deck's slides, an HTML page in a
 * frame that runs no scripts, a CSV as a table, code, Markdown or text). `rowId`: a conversation row's id, or a
 * file's fileImageKey. `siblings`: the keys of every image the agent sent in the same message (this one
 * included): the window steps through them, and its title follows.
 */
export function PreviewApp({
  taskId,
  runId,
  agentId,
  rowId: firstRowId,
  title: firstTitle,
  siblings,
}: {
  taskId: string;
  runId: string;
  agentId?: string;
  rowId: string;
  title: string;
  siblings?: string[];
}) {
  const [index, setIndex] = useState(() => Math.max(0, siblings?.indexOf(firstRowId) ?? 0));
  const many = !!siblings && siblings.length > 1;
  const rowId = many ? siblings[index] : firstRowId;
  const path = fileImageId(rowId);
  const name = path !== null ? baseName(path) : firstTitle;
  const kind: ViewerKind = path === null ? 'image' : (viewerKind(name, isCode) ?? 'text');
  const [view, setView] = useState<FileView | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [options, setOptions] = useState<ViewOptions>({});
  /** Percent; null until the fit-to-window zoom is computed on load. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = `${name} – Preview`;
  }, [name]);

  useEffect(() => {
    let live = true;
    setView(null);
    setSize(null);
    setZoom(null);
    setNatural(null);
    const base: FileView = {
      kind,
      url: null,
      text: null,
      data: null,
      error: '',
      htmlPage: (html, load) => window.looper.sessions.previewPage(html, load),
      toDevice: nothing,
      toHost: nothing,
      askDownload: nothing,
    };
    const done = (v: Partial<FileView>) => live && setView({ ...base, ...v });
    if (path === null) {
      // An image in the conversation itself.
      window.looper.runs.messageImage(taskId, runId, rowId, agentId).then(
        (img) => done(img ? { url: `data:${img.mediaType};base64,${img.data}` } : { error: 'The image is no longer available.' }),
        () => done({ error: 'The image is no longer available.' }),
      );
    } else {
      window.looper.sessions.readSentFile(taskId, path, VIEWER_MAX_BYTES[kind]).then(
        async (r) => {
          if ('error' in r) return done({ error: r.error });
          if (live) setSize(r.data.byteLength);
          done(await bytesView(r.data, kind, imageType(name)));
        },
        (err: unknown) => done({ error: err instanceof Error ? err.message : String(err) }),
      );
    }
    return () => {
      live = false;
    };
  }, [taskId, runId, rowId, agentId, path, kind, name]);

  const count = siblings?.length ?? 1;
  const go = (to: number) => setIndex(Math.max(0, Math.min(count - 1, to)));
  const goRef = useRef(go);
  goRef.current = go;
  const indexRef = useRef(index);
  indexRef.current = index;
  useEffect(() => {
    if (!many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || (e.target as HTMLElement).closest('input, textarea, select')) return;
      const to = e.key === 'ArrowLeft' ? indexRef.current - 1 : e.key === 'ArrowRight' ? indexRef.current + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? Infinity : null;
      if (to === null) return;
      e.preventDefault();
      goRef.current(to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [many]);

  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    setNatural({ w: el.naturalWidth, h: el.naturalHeight });
    const vp = viewportRef.current;
    if (vp && el.naturalWidth > 0 && el.naturalHeight > 0) {
      const fit = Math.min((vp.clientWidth - 24) / el.naturalWidth, (vp.clientHeight - 24) / el.naturalHeight, 1);
      setZoom(clamp(fit * 100));
    } else {
      setZoom(100);
    }
  };

  /** Step by ×1.25, but never skip past a multiple of 25 — stop there first. */
  const step = (dir: 1 | -1) =>
    setZoom((z) => {
      const cur = z ?? 100;
      const next = clamp(dir > 0 ? cur * 1.25 : cur / 1.25);
      const snap = dir > 0 ? Math.floor(next / 25) * 25 : Math.ceil(next / 25) * 25;
      const between = dir > 0 ? snap > cur && snap < next : snap < cur && snap > next;
      return between ? snap : next;
    });

  const fit = (mode: 'window' | 'width') => {
    const vp = viewportRef.current;
    if (!vp || !natural || natural.w <= 0 || natural.h <= 0) return;
    // offsetWidth/Height is the viewport as if no scrollbars were shown;
    // when a fit-to-width result overflows vertically, reserve the scrollbar
    // up front instead of letting it appear and clip the image.
    const availW = vp.offsetWidth - 24;
    const availH = vp.offsetHeight - 24;
    let f: number;
    if (mode === 'window') {
      f = Math.min(availW / natural.w, availH / natural.h);
    } else {
      f = availW / natural.w;
      if (natural.h * f > availH) f = (availW - scrollbarWidth()) / natural.w;
    }
    setZoom(clamp(Math.floor(f * 100)));
  };

  const url = kind === 'image' ? (view?.url ?? null) : null;
  const width = zoom !== null && natural ? Math.max(1, Math.round((natural.w * zoom) / 100)) : undefined;

  const previous = { id: 'previous', label: 'Previous Image', icon: 'previous', enabled: index > 0, run: () => go(index - 1) };
  const next = { id: 'next', label: 'Next Image', icon: 'next', enabled: index < count - 1, run: () => go(index + 1) };
  const toggles = viewToggles(kind, options, setOptions);
  const groups: ToolbarGroup[] = [
    ...(many ? [{ id: 'images', items: [previous, next] }] : []),
    ...(kind === 'image'
      ? [
          {
            id: 'zoom',
            items: [
              { id: 'zoomOut', label: 'Zoom Out', icon: 'zoomOut', enabled: !!url && (zoom ?? 100) > MIN_ZOOM, run: () => step(-1) },
              { id: 'zoom', label: 'Zoom' },
              { id: 'zoomIn', label: 'Zoom In', icon: 'zoomIn', enabled: !!url && (zoom ?? 100) < MAX_ZOOM, run: () => step(1) },
            ],
          },
          {
            id: 'fit',
            items: [
              { id: 'fitWindow', label: 'Fit to Window', icon: 'fitWindow', enabled: !!url && !!natural, run: () => fit('window') },
              { id: 'fitWidth', label: 'Fit to Width', icon: 'fitWidth', enabled: !!url && !!natural, run: () => fit('width') },
            ],
          },
        ]
      : []),
    ...(toggles.length ? [{ id: 'view', items: toggles.map(({ on, disabled, ...t }) => ({ ...t, pressed: on, enabled: !disabled })) }] : []),
    ...(path !== null
      ? [{ id: 'file', items: [{ id: 'openDefault', label: 'Open in Default Program', icon: 'open', run: () => void window.looper.sessions.openFileDefault(taskId, path).catch(reportError) }] }]
      : []),
  ];
  // A phone zooms with a pinch, and steps through the images from its bar.
  const toolbar = (
    <Toolbar
      groups={groups}
      controls={{
        zoom: (
          <NumberInput
            className="image-zoom"
            label="Zoom"
            suffix="%"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            value={zoom}
            disabled={!url}
            onChange={(v) => setZoom(Math.round(v))}
          />
        ),
      }}
      nav={{
        title: many ? `${index + 1} of ${count}` : name,
        actions: many ? [previous, next].map(({ enabled, ...a }) => ({ ...a, disabled: !enabled })) : undefined,
      }}
    />
  );

  return (
    <div className="preview-app">
      {toolbar}
      {kind === 'image' ? (
        <ImageViewer
          src={url}
          alt={name}
          width={width}
          onLoad={onLoad}
          viewportRef={viewportRef}
          missing={view?.error ? <div className="muted image-missing">{view.error}</div> : undefined}
        />
      ) : (
        <div className={`preview-body${view ? viewerLayout(view, options) : ''}`} tabIndex={-1}>
          {view ? (
            <FileViewContent view={view} name={name} classes={{ note: 'muted preview-note', text: 'preview-text' }} image={() => null} options={options} />
          ) : (
            <div className="muted preview-note">Loading…</div>
          )}
        </div>
      )}
      <StatusBar>
        <span>
          {[
            many ? `${index + 1} of ${count}` : null,
            kind === 'image' ? (url ? url.slice(5, url.indexOf(';')).replace(/^image\//, '').replace(/\+xml$/, '').toUpperCase() : null) : KIND_NAMES[kind],
            natural ? `${natural.w} × ${natural.h}` : null,
            size !== null ? fmtSize(size) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </StatusBar>
    </div>
  );
}
