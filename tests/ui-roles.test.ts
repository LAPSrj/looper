import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_MIN_WIDTH } from '../src/shared/card-grid';
import { moveKey, withSiblingsOrdered } from '../src/shared/folders';
import { presentation, splitLayout } from '../src/renderer/src/web/nav-stack';

const renderer = path.join(__dirname, '..', 'src', 'renderer', 'src');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const files = walk(renderer)
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => [path.relative(renderer, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')] as const);

/** Fails when a file other than `owners` matches: that role is drawn by hand. */
function onlyIn(owners: string[], pattern: RegExp): void {
  for (const [file, text] of files) {
    if (!owners.includes(file)) expect(text, file).not.toMatch(pattern);
  }
}

describe('list and detail', () => {
  it('draws the columns only through ListDetail', () => {
    onlyIn(['components/ListDetail.tsx', 'components/phone/PhoneSplit.tsx'], /\bSplit(View|Empty)\b/);
  });

  it('draws a two-pane splitter only through SplitPane', () => {
    onlyIn(['components/SplitPane.tsx'], /className="split-(pane|cell|divider)/);
    for (const [file, text] of files) expect(text, file).not.toMatch(/\b(runlog|run-detail|git)-divider\b/);
  });

  it('leaves a row\'s gestures and placement to the components in the screens that moved onto them', () => {
    const moved = ['components/RunLog.tsx', 'components/Messages.tsx', 'components/GitView.tsx', 'components/ProjectDetail.tsx', 'components/SessionList.tsx', 'components/FolderTree.tsx', 'EngineLogApp.tsx', 'RemoteConversationsApp.tsx', 'VersionDetailApp.tsx'];
    for (const [file, text] of files) {
      if (moved.includes(file)) expect(text, file).not.toMatch(/\bisPhone\b/);
    }
  });
});

describe('data tables', () => {
  it('writes a table of rows only in DataTable', () => {
    onlyIn(['components/DataTable.tsx'], /className="runlog-table"/);
    onlyIn(['components/DataTable.tsx', 'components/ui.tsx'], /\bResizableColumns\b/);
  });
});

describe('supporting panels', () => {
  it('places the Activity pane only through Inspector', () => {
    for (const [file, text] of files) {
      if (!text.includes('<ActivityPanel')) continue;
      expect(text, file).toContain('<Inspector');
      expect(text, file).not.toMatch(/<PhoneSheet[^>]*title="Activity"/);
      expect(text, file).not.toContain('pg-split-inspector');
    }
  });
});

describe('every feature on every device', () => {
  const src = path.join(__dirname, '..', 'src');
  /** Why something may stay off a phone: it lays out a desktop's windows, the phone itself provides it, or a phone reaches it another way. */
  const ALLOWED = [
    /role: '(undo|redo|cut|copy|paste|selectAll|reload)'/, // Edit commands and Reload UI: the phone's own
    /Close &Window|Next Pan&e|Prev&ious Pane|Always on &Top/, // desktop windows
    /&Toolbar|Status &?B|S&ingle Pane|M&ultiple Panes|&Standard|&Compact/, // desktop layout; the last four wait for a decision on Multiple Panes and Compact
    /A&ctivity Pane|activity-pane|activityPane|id: 'panes'/, // a phone has a bar button for Activity
    /Open in (&N|N)ew Window|openInNewWindow/, // waits for a decision on tablets
    /settingsItem|templatesItem/, // More has them from the File menu
    /groupByMenu|Group Projects By/, // a phone has them on a long press of the list
    /showPaneItem|paneMenuItems|p\.menuLabel/, // desktop panes
    /windowMenu|OPEN_WINDOW_ID|openWindowItems/, // the computer's own windows
  ];

  it('keeps a platforms mark only on what a short list allows', () => {
    const files = walk(src).filter((f) => /\.tsx?$/.test(f));
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/platforms(: |[,=] ?)(NOT_MOBILE|DESKTOP_ONLY)|platforms = NOT_MOBILE/.test(line)) return;
        const near = lines.slice(Math.max(0, i - 4), i + 3).join('\n');
        expect(ALLOWED.some((r) => r.test(near)), `${path.relative(src, file)}:${i + 1}: ${line.trim()}`).toBe(true);
      });
    }
  });
});

describe('reordering on a phone', () => {
  it('moves a row', () => {
    expect(moveKey(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveKey(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the rows a list doesn\'t show in their places, and leaves other folders alone', () => {
    const order = new Map([
      ['', ['a', 'hidden', 'b', 'folder:f']],
      ['f', ['c', 'd']],
    ]);
    expect(withSiblingsOrdered(order, '', ['folder:f', 'b', 'a'])).toEqual({ '': ['folder:f', 'hidden', 'b', 'a'], f: ['c', 'd'] });
  });

  it('draws a phone\'s Overview cards in columns at least as wide as the desktop\'s', () => {
    expect(fs.readFileSync(path.join(renderer, 'phone.css'), 'utf8')).toContain(`minmax(min(${CARD_MIN_WIDTH}px, 100%), 1fr)`);
  });
});

describe('an editor on an iPad', () => {
  const editor = { modal: false, width: 780, height: 800 };

  it('is a sheet at every size and in both orientations, and only a window made for a desktop is pushed', () => {
    for (const screen of [{ width: 1376, height: 1032 }, { width: 1032, height: 1376 }, { width: 1180, height: 820 }, { width: 820, height: 1180 }]) {
      expect(presentation('ios', editor, false, screen)).toBe('page-sheet');
      expect(presentation('ios', { modal: false, width: 1388, height: 895 }, false, screen)).toBe('push');
    }
  });
});

describe('where two columns start', () => {
  const ipad = { width: 1180, height: 820 };
  const pixel = { width: 800, height: 1280 };

  it('is 700 px on an iPad and 840 dp on an Android tablet, and never on a phone', () => {
    expect(splitLayout(699, ipad)).toBeNull();
    expect(splitLayout(700, ipad)).not.toBeNull();
    expect(splitLayout(800, pixel, 'android')).toBeNull();
    expect(splitLayout(839, pixel, 'android')).toBeNull();
    expect(splitLayout(840, pixel, 'android')).not.toBeNull();
    expect(splitLayout(900, { width: 900, height: 412 }, 'android')).toBeNull();
  });
});
