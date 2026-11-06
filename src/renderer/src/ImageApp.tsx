import { useEffect, useRef, useState } from 'react';
import { fileImageId, type MessageImage } from '@shared/messages';
import { Icon } from './components/Icon';
import { ICONS as SHARED_ICONS } from './components/icons';
import { NavBar } from './components/NavBar';
import { NumberInput } from './components/ui';
import { ZoomImage } from './components/ZoomImage';
import { isPhone } from './web/page-nav';

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

const ICONS = {
  zoomOut: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m13.5 13.5-3.3-3.3M5 7h4" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m13.5 13.5-3.3-3.3M5 7h4M7 5v4" />
    </>
  ),
  fitWindow: (
    <>
      <path d="M1.5 5V3.5a1 1 0 0 1 1-1H4M12 2.5h1.5a1 1 0 0 1 1 1V5M14.5 11v1.5a1 1 0 0 1-1 1H12M4 13.5H2.5a1 1 0 0 1-1-1V11" />
      <rect x="5.5" y="6" width="5" height="4" />
    </>
  ),
  fitWidth: (
    <>
      <path d="M2.5 3.5v9M13.5 3.5v9" />
      <path d="M4.5 8h7M7 5.5 4.5 8 7 10.5M9 5.5 11.5 8 9 10.5" />
    </>
  ),
};

/** The window's title for a sent image's row id: "Image – name". */
const sentTitle = (key: string): string | null => {
  const file = fileImageId(key);
  return file === null ? null : `Image – ${file.replace(/\\/g, '/').split('/').pop()}`;
};

/**
 * An image from a conversation in its own window, with zoom controls.
 * `siblings`: the row ids of every image the agent sent in the same message
 * (this one included): the window steps through them, and its title follows.
 */
export function ImageApp({
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
  const title = many ? (sentTitle(rowId) ?? firstTitle) : firstTitle;
  const [image, setImage] = useState<MessageImage | 'missing' | null>(null);
  /** Percent; null until the fit-to-window zoom is computed on load. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  useEffect(() => {
    let live = true;
    setImage(null);
    setZoom(null);
    setNatural(null);
    void window.looper.runs
      .messageImage(taskId, runId, rowId, agentId)
      .then((img) => live && setImage(img ?? 'missing'))
      .catch(() => live && setImage('missing'));
    return () => {
      live = false;
    };
  }, [taskId, runId, rowId, agentId]);

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

  const url = image !== null && image !== 'missing' ? `data:${image.mediaType};base64,${image.data}` : null;
  const width = zoom !== null && natural ? Math.max(1, Math.round((natural.w * zoom) / 100)) : undefined;

  if (isPhone) {
    return (
      <div className="image-app">
        <NavBar
          title={many ? `${index + 1} of ${count}` : title}
          actions={
            many
              ? [
                  { id: 'previous', label: 'Previous Image', icon: 'previous', disabled: index <= 0, run: () => go(index - 1) },
                  { id: 'next', label: 'Next Image', icon: 'next', disabled: index >= count - 1, run: () => go(index + 1) },
                ]
              : undefined
          }
        />
        {image === 'missing' ? <div className="muted image-missing">The image is no longer available.</div> : url ? <ZoomImage key={url} src={url} alt={title} /> : null}
      </div>
    );
  }

  return (
    <div className="image-app">
      <div className="toolbar">
        {many && (
          <>
            <button title="Previous Image" aria-label="Previous Image" disabled={index <= 0} onClick={() => go(index - 1)}>
              <Icon>{SHARED_ICONS.previous}</Icon>
            </button>
            <button title="Next Image" aria-label="Next Image" disabled={index >= count - 1} onClick={() => go(index + 1)}>
              <Icon>{SHARED_ICONS.next}</Icon>
            </button>
            <span className="toolbar-sep" />
          </>
        )}
        <button title="Zoom Out" aria-label="Zoom Out" disabled={!url || (zoom ?? 100) <= MIN_ZOOM} onClick={() => step(-1)}>
          <Icon>{ICONS.zoomOut}</Icon>
        </button>
        <NumberInput
          className="image-zoom"
          label="Zoom"
          suffix="%"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          value={zoom}
          disabled={!url}
          onChange={(v) => Number.isFinite(v) && v > 0 && setZoom(clamp(v))}
        />
        <button title="Zoom In" aria-label="Zoom In" disabled={!url || (zoom ?? 100) >= MAX_ZOOM} onClick={() => step(1)}>
          <Icon>{ICONS.zoomIn}</Icon>
        </button>
        <span className="toolbar-sep" />
        <button title="Fit to Window" aria-label="Fit to Window" disabled={!url || !natural} onClick={() => fit('window')}>
          <Icon>{ICONS.fitWindow}</Icon>
        </button>
        <button title="Fit to Width" aria-label="Fit to Width" disabled={!url || !natural} onClick={() => fit('width')}>
          <Icon>{ICONS.fitWidth}</Icon>
        </button>
      </div>
      <div className="image-viewport" ref={viewportRef}>
        {image === 'missing' ? (
          <div className="muted image-missing">The image is no longer available.</div>
        ) : url ? (
          <img src={url} alt="" onLoad={onLoad} style={width !== undefined ? { width } : { maxWidth: '100%' }} />
        ) : null}
      </div>
      <div className="statusbar">
        <span>
          {[
            many ? `${index + 1} of ${count}` : null,
            image !== null && image !== 'missing' ? image.mediaType.replace(/^image\//, '').toUpperCase() : null,
            natural ? `${natural.w} × ${natural.h}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
    </div>
  );
}
