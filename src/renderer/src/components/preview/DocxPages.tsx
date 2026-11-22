import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { NOTE } from './note';

/**
 * A Word document's pages, drawn as HTML by docx-preview. Images come as data: URLs, which the window's
 * Content-Security-Policy allows (blob: it doesn't), and embedded HTML (altChunk) isn't drawn.
 */
export default function DocxPages({ data, name }: { data: ArrayBuffer; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'shown' | string>('loading');
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let live = true;
    setState('loading');
    el.replaceChildren();
    renderAsync(data.slice(0), el, undefined, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      useBase64URL: true,
      renderAltChunks: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
    }).then(
      () => live && setState('shown'),
      (err: unknown) => live && setState(`${name} can’t be shown. ${err instanceof Error ? err.message : ''}`.trim()),
    );
    return () => {
      live = false;
    };
  }, [data, name]);
  // A page wider than the viewer (a phone) is scaled down to fit it, as a phone's own document viewer does.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || state !== 'shown') return;
    // docx-preview puts its <style> elements in first: the pages are in its wrapper.
    const wrapper = el.querySelector<HTMLElement>(':scope > .docx-wrapper');
    if (!wrapper) return;
    wrapper.style.zoom = '';
    // The pages are centered in the wrapper, so an overflow to the left isn't in its scrollWidth: measure the widest page.
    const pad = parseFloat(getComputedStyle(wrapper).paddingLeft) + parseFloat(getComputedStyle(wrapper).paddingRight);
    const natural = Math.max(0, ...[...wrapper.children].map((c) => (c as HTMLElement).offsetWidth)) + (pad || 0);
    const fit = () => {
      wrapper.style.zoom = natural > el.clientWidth && el.clientWidth > 0 ? String(el.clientWidth / natural) : '';
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state]);
  return (
    <div className="preview-docx" role="document" aria-label={name} style={{ flex: 1, minWidth: 0 }}>
      {state !== 'shown' && <div style={NOTE}>{state === 'loading' ? 'Loading…' : state}</div>}
      <div ref={host} />
    </div>
  );
}
