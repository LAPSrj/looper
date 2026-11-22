import { useEffect, useRef, useState } from 'react';
import { XlsxSheetViewer } from '@silurus/ooxml/xlsx';
import { FILL, NOTE } from './note';

/** The sheets' tabs under the grid, as Excel draws them; inline, as the phone frames and the desktop have different stylesheets. */
const TABS: React.CSSProperties = { flex: 'none', display: 'flex', overflowX: 'auto', borderTop: '1px solid rgba(128, 128, 128, 0.35)', padding: '0 6px var(--viewer-end, 0px)' };
const TAB: React.CSSProperties = { flex: 'none', font: 'inherit', color: 'inherit', background: 'none', border: 0, borderBottom: '2px solid transparent', padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap' };
const ACTIVE: React.CSSProperties = { fontWeight: 600, borderBottomColor: 'currentColor' };


/**
 * An Excel workbook as Excel shows it, drawn by @silurus/ooxml: the cells with their fills, borders, merged
 * ranges, number formats and column widths, scrolled in the grid, and the sheets' names as tabs under it.
 * The workbook is read in a worker; only the cells in view are drawn on the page (the viewer's 'main' mode:
 * its 'worker' mode never finished loading in Electron).
 */
export default function XlsxSheets({ data, name }: { data: ArrayBuffer; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<XlsxSheetViewer | null>(null);
  const [sheets, setSheets] = useState<string[] | null>(null);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let live = true;
    setSheets(null);
    setIndex(0);
    setError('');
    const v = new XlsxSheetViewer(el, {
      resizable: true,
      showScrollbars: true,
      hiddenSheetMode: 'skip',
      onSheetChange: (i) => live && setIndex(i),
    });
    viewer.current = v;
    v.load(data.slice(0)).then(
      () => live && setSheets(v.sheetNames),
      (err: unknown) => live && setError(`${name} can’t be shown. ${err instanceof Error ? err.message : ''}`.trim()),
    );
    return () => {
      live = false;
      viewer.current = null;
      v.destroy();
    };
  }, [data, name]);
  return (
    <div className="preview-book" style={FILL}>
      {error && <div style={NOTE}>{error}</div>}
      {!sheets && !error && <div style={NOTE}>Loading…</div>}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: error ? 'none' : 'block' }}>
        <canvas ref={canvas} aria-label={sheets ? `${name}: ${sheets[index] ?? ''}` : name} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
      </div>
      {sheets && sheets.length > 1 && (
        <div className="preview-sheet-tabs" role="tablist" aria-label="Sheets" style={TABS}>
          {sheets.map((s, i) => (
            <button key={s} role="tab" aria-selected={i === index} style={i === index ? { ...TAB, ...ACTIVE } : TAB} onClick={() => void viewer.current?.goToSheet(i)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
