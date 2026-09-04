import { useEffect, useRef, useState } from 'react';
import type { MessageImage } from '@shared/messages';

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

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
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

/** An image from a conversation in its own window, with zoom controls. */
export function ImageApp({
  taskId,
  runId,
  agentId,
  rowId,
  title,
}: {
  taskId: string;
  runId: string;
  agentId?: string;
  rowId: string;
  title: string;
}) {
  const [image, setImage] = useState<MessageImage | 'missing' | null>(null);
  /** Percent; null until the fit-to-window zoom is computed on load. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  useEffect(() => {
    void window.looper.runs
      .messageImage(taskId, runId, rowId, agentId)
      .then((img) => setImage(img ?? 'missing'))
      .catch(() => setImage('missing'));
  }, [taskId, runId, rowId, agentId]);

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

  return (
    <div className="image-app">
      <div className="toolbar">
        <button title="Zoom Out" aria-label="Zoom Out" disabled={!url || (zoom ?? 100) <= MIN_ZOOM} onClick={() => step(-1)}>
          <Icon>{ICONS.zoomOut}</Icon>
        </button>
        <div className="input-suffix image-zoom">
          <input
            type="number"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            value={zoom ?? ''}
            disabled={!url}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) setZoom(clamp(v));
            }}
          />
          <span className="suffix">%</span>
        </div>
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
