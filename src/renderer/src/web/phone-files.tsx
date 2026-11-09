import { Fragment, useRef } from 'react';
import type { HostDirEntry } from '../../../shared/remote-access';
import { Markdown } from '../components/Markdown';
import { ZoomImage } from '../components/ZoomImage';
import { fmtDateTime } from '../format';
import { groupPlaces } from './dialog-flows';
import type { FileView, HostBrowser } from './file-flows';
import type { PhoneOs } from './nav-stack';
import { PlaceGlyph } from './places';

const fmtSize = (n: number | undefined): string => (n === undefined ? '' : n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const FOLDER_GLYPH = (
  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h5l2.5 2.5h9.5A2.5 2.5 0 0 1 25 11v9.5a2.5 2.5 0 0 1-2.5 2.5h-17A2.5 2.5 0 0 1 3 20.5Z" fill="currentColor" />
  </svg>
);
export const FILE_GLYPH = (
  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
    <path d="M7 3.5h9l5.5 5.5v15.5H7Z M16 3.5V9h5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);
export const CHEVRON_RIGHT = (
  <svg width="9" height="15" viewBox="0 0 9 15" aria-hidden="true">
    <path d="M1.5 1.5L7.5 7.5L1.5 13.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const CHECK = (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path d="M3.5 9.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A file shown before it's downloaded: an image fit to the screen that zooms, or a text file's text, Markdown rendered. */
export function FileViewBody({ view, name }: { view: FileView; name: string }) {
  let body;
  if (view.error) body = <div className="ph-viewer-note">{view.error}</div>;
  else if (view.kind === 'image') body = view.url ? <ZoomImage key={view.url} src={view.url} alt={name} /> : <div className="ph-viewer-note">Loading…</div>;
  else if (view.text === null) body = <div className="ph-viewer-note">Loading…</div>;
  else body = view.kind === 'markdown' ? <Markdown text={view.text} breaks={false} /> : <pre className="ph-viewer-text">{view.text}</pre>;
  return <div className={`ph-viewer ph-scroll${view.kind === 'image' ? ' image' : ''}`}>{body}</div>;
}

/** What a tap on a row does: a folder opens (a push); a file is picked, toggled or named. */
export type RowTap = (entry: HostDirEntry) => void;

/**
 * The computer's folders as a navigable list: one row per folder with a
 * chevron, files with their size and date. A folder slides in from the side
 * it was entered from.
 */
export function FileRows({ os, browser, onFile, emptyText, query }: { os: PhoneOs; browser: HostBrowser; onFile: RowTap; emptyText?: string; query?: string }) {
  // The search field's text narrows the folder's entries by name.
  const needle = query?.trim().toLowerCase() ?? '';
  const entries = needle ? browser.entries.filter((e) => e.name.toLowerCase().includes(needle)) : browser.entries;
  const depth = browser.crumbs.length;
  const prev = useRef<{ depth: number; dir: 'fwd' | 'back' | 'none' }>({ depth, dir: 'none' });
  if (depth !== prev.current.depth) prev.current = { depth, dir: depth > prev.current.depth ? 'fwd' : 'back' };
  const dir = prev.current.dir;
  return (
    <div key={browser.path ?? ''} className={`ph-files ph-scroll slide-${dir}`} role="list">
      {(browser.path === null ? groupPlaces(entries) : entries.map((entry) => ({ heading: null, entry }))).map(({ heading, entry }) => {
        const selected = browser.selected.includes(entry.path);
        return (
          <Fragment key={entry.path}>
            {heading && (
              <div className="ph-files-group" role="presentation">
                {heading}
              </div>
            )}
            <div role="listitem" className="ph-file-item">
              <button className={`ph-file-row${selected ? ' selected' : ''}`} aria-pressed={entry.dir ? undefined : selected} onClick={() => (entry.dir ? browser.go(entry.path) : onFile(entry))}>
                <span className={`ph-file-icon${entry.dir ? ' dir' : ''}${entry.place ? ' place' : ''}`}>
                  {entry.place ? <PlaceGlyph place={entry.place} /> : entry.dir ? FOLDER_GLYPH : FILE_GLYPH}
                </span>
                <span className="ph-file-text">
                  <span className="ph-file-name">{entry.name}</span>
                  {!entry.dir && (entry.modifiedAt || entry.size !== undefined) && (
                    <span className="ph-file-detail">{[entry.modifiedAt ? fmtDateTime(entry.modifiedAt) : '', fmtSize(entry.size)].filter(Boolean).join(' – ')}</span>
                  )}
                </span>
                <span className="ph-file-end">{entry.dir ? (os === 'ios' ? CHEVRON_RIGHT : null) : selected ? CHECK : null}</span>
              </button>
            </div>
          </Fragment>
        );
      })}
      {!browser.loading && browser.entries.length === 0 && <div className="ph-files-empty">{emptyText ?? 'This folder is empty.'}</div>}
      {browser.entries.length > 0 && entries.length === 0 && <div className="ph-files-empty">No Results</div>}
      {browser.loading && browser.entries.length === 0 && <div className="ph-files-empty">Loading…</div>}
    </div>
  );
}
