import { Fragment, useRef } from 'react';
import type { HostDirEntry } from '../../../shared/remote-access';
import { ZoomImage, type ZoomSwipe } from '../components/ZoomImage';
import { fmtDateTime, fmtSize } from '../format';
import { groupPlaces } from './dialog-flows';
import type { FileView, HostBrowser } from './file-flows';
import { FileViewContent, viewerLayout } from './file-view';
import type { PhoneOs } from './nav-stack';
import { PlaceGlyph } from './places';

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

/** A message's images either side of the shown one. */
export interface ViewSteps {
  index: number;
  count: number;
  go: (index: number) => void;
  /** The image a step away, or null while it loads. */
  src: (step: -1 | 1) => string | null;
}

/**
 * A file shown before it's downloaded, as the activity panel shows it: an
 * image fit to the screen that zooms (and swipes to a message's other images),
 * a PDF's pages, code in its syntax colors, Markdown formatted, or text.
 */
export function FileViewBody({ view, name, steps }: { view: FileView; name: string; steps?: ViewSteps | null }) {
  const swipe: ZoomSwipe | undefined = steps
    ? {
        can: (step) => steps.index + step >= 0 && steps.index + step < steps.count,
        src: steps.src,
        go: (step) => steps.go(steps.index + step),
      }
    : undefined;
  return (
    <div className={`ph-viewer ph-scroll${viewerLayout(view)}`}>
      <FileViewContent view={view} name={name} classes={{ note: 'ph-viewer-note', text: 'ph-viewer-text' }} image={(url) => <ZoomImage src={url} alt={name} swipe={swipe} />} />
    </div>
  );
}

/** An on/off switch: iOS's knob, or Material's handle with a check when on. */
export function Switch({ os, on, disabled, label, onChange }: { os: PhoneOs; on: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  const ios = os === 'ios';
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`${ios ? 'ios-switch' : 'md-switch'}${on ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      {ios ? <span className="ios-switch-knob" /> : <span className="md-switch-handle">{on ? CHECK : null}</span>}
    </button>
  );
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
                    <span className="ph-file-detail">{[entry.modifiedAt ? fmtDateTime(entry.modifiedAt) : '', entry.size === undefined ? '' : fmtSize(entry.size)].filter(Boolean).join(' – ')}</span>
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
