import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DESKTOP_WIDTH, PREVIEW_BLOCKED, PREVIEW_END, PREVIEW_SANDBOX, PREVIEW_SANDBOX_DEVICE, type PreviewNetwork } from '@shared/preview';
import { isPhone } from '../../web/page-nav';
import { FILL, NOTE } from './note';

type PageOf = (html: string, load: boolean) => Promise<{ url: string; network: PreviewNetwork }>;

// Styled inline: the phone frames and the desktop have different stylesheets.
const BAR: React.CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'rgba(255, 196, 0, 0.18)', borderBottom: '1px solid rgba(128, 128, 128, 0.35)' };
const BUTTON: React.CSSProperties = { font: 'inherit', padding: '4px 12px', borderRadius: 4, border: '1px solid rgba(128, 128, 128, 0.5)', background: 'Canvas', color: 'CanvasText', cursor: 'pointer' };

/**
 * An HTML file as a web page, its scripts running, apart from Looper: main serves it as a page of its own
 * (looper-preview:// on the computer, /preview-frame/ on a phone) under a Content-Security-Policy that
 * sandboxes it, and the frame has allow-scripts without allow-same-origin, so the page can't reach this window,
 * `window.looper` or the Remote Access API. What it may load from the internet is Settings → Advanced's: with
 * Ask, the page reports a blocked load and a bar offers to load it. On the computer the frame opens nothing
 * itself: Looper's preload sends a link the user clicks in it, or in a frame inside it, to main, which opens it
 * in the browser. `desktop`: laid out at a desktop's width and scaled down to fit. In a phone's sheet the frame runs
 * to the screen's bottom edge, and the page gets room after its end as tall as the safe area there (--viewer-end),
 * so its last line can scroll above the home indicator.
 */
export default function HtmlFrame({ html, name, desktop, page }: { html: string; name: string; desktop: boolean; page: PageOf }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const endProbe = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, end: 0 });
  const [load, setLoad] = useState(false);
  const [src, setSrc] = useState<{ url: string; network: PreviewNetwork } | null>(null);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // The viewer may make a new function each render; the page is asked for again only when the file or Load changes.
  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => {
    setLoad(false);
    setDismissed(false);
  }, [html]);

  useEffect(() => {
    let live = true;
    setSrc(null);
    setBlocked(false);
    setError('');
    pageRef.current(html, load).then(
      (r) => live && setSrc(r),
      (err: unknown) => live && setError(`${name} can’t be shown. ${err instanceof Error ? err.message : ''}`.trim()),
    );
    return () => {
      live = false;
    };
  }, [html, load, name]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source && e.source === frame.current?.contentWindow && e.data === PREVIEW_BLOCKED) setBlocked(true);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      const end = endProbe.current?.offsetHeight ?? 0;
      setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight && s.end === end ? s : { w: el.clientWidth, h: el.clientHeight, end }));
    };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);

  const scale = desktop && size.w > 0 && size.w < DESKTOP_WIDTH ? size.w / DESKTOP_WIDTH : 1;
  const style: React.CSSProperties =
    scale < 1 ? { width: DESKTOP_WIDTH, height: size.h / scale, transform: `scale(${scale})`, transformOrigin: '0 0' } : { width: '100%', height: '100%' };
  const ask = src?.network === 'ask' && !load && blocked && !dismissed;
  // In the page's own pixels: a page at desktop width is scaled down.
  const end = Math.round(size.end / scale);
  const postEnd = () => frame.current?.contentWindow?.postMessage({ [PREVIEW_END]: end }, '*');
  const postEndRef = useRef(postEnd);
  postEndRef.current = postEnd;
  useEffect(() => postEndRef.current(), [end]);
  return (
    <div className="preview-html" style={FILL}>
      {ask && (
        <div role="alert" style={BAR}>
          <span style={{ flex: 1 }}>This page loads content from the internet</span>
          <button className="btn" style={isPhone ? BUTTON : undefined} onClick={() => setLoad(true)}>
            Load
          </button>
          <button className="btn" style={isPhone ? BUTTON : undefined} onClick={() => setDismissed(true)}>
            Don’t Load
          </button>
        </div>
      )}
      <div ref={box} style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: '#fff' }}>
        <div ref={endProbe} aria-hidden="true" style={{ position: 'absolute', width: 0, height: 'var(--viewer-end, 0px)', visibility: 'hidden', pointerEvents: 'none' }} />
        {error && <div style={NOTE}>{error}</div>}
        {src && (
          <iframe
            ref={frame}
            key={src.url}
            title={name}
            sandbox={src.url.startsWith('looper-preview:') ? PREVIEW_SANDBOX : PREVIEW_SANDBOX_DEVICE}
            referrerPolicy="no-referrer"
            src={src.url}
            onLoad={() => postEndRef.current()}
            style={{ ...style, position: 'absolute', inset: '0 auto auto 0', border: 0, display: 'block', background: '#fff' }}
          />
        )}
      </div>
    </div>
  );
}
