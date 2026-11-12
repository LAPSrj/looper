import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_MIN_WIDTH } from '../src/shared/card-grid';
import { moveKey, withSiblingsOrdered } from '../src/shared/folders';
import type { WindowRole } from '../src/shared/remote-access';
import { presentation, splitLayout, type Presentation } from '../src/renderer/src/web/nav-stack';

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
    // A three-pane window's dividers and the Activity pane's are the shared components' own.
    onlyIn(['components/ListDetail.tsx', 'components/Inspector.tsx'], /className="sidebar-divider"/);
  });

  it('leaves a row\'s gestures and placement to the components in the screens that moved onto them', () => {
    const moved = ['components/RunLog.tsx', 'components/Messages.tsx', 'components/GitView.tsx', 'components/ProjectDetail.tsx', 'components/SessionList.tsx', 'components/FolderTree.tsx', 'EngineLogApp.tsx', 'RemoteConversationsApp.tsx', 'VersionDetailApp.tsx'];
    for (const [file, text] of files) {
      if (moved.includes(file)) expect(text, file).not.toMatch(/\bisPhone\b/);
    }
  });
});

describe('an edit window', () => {
  const EDITORS = /(^|\/)(TaskEditor|EditorApp|EnvEditorApp|HarnessEditorApp|ModelEditorApp|McpServerApp|ProjectEditorApp|RemoteEditorApps|NoteEditorApp|FolderNoteApp|FolderNameApp|SessionNameApp|SendToSessionsApp|TemplatePickerApp|TemplatesApp|SettingsApp|AgentSettingsApp|MoveToFolderApp|RunOptionsApp|ContinueRunApp|BuilderSetupApp)\.tsx$/;

  it('doesn\'t check the platform: its fields and buttons adapt by themselves', () => {
    const editors = files.filter(([file]) => EDITORS.test(file));
    expect(editors.length).toBeGreaterThanOrEqual(20);
    for (const [file, text] of editors) expect(text, file).not.toMatch(/\b(isPhone|onIos|uiHere)\b|platform ===/);
  });
});

describe('data tables', () => {
  it('writes a table of rows only in DataTable', () => {
    onlyIn(['components/DataTable.tsx'], /className="runlog-table"/);
    onlyIn(['components/DataTable.tsx', 'components/ui.tsx'], /\bResizableColumns\b/);
  });
});

describe('toolbars', () => {
  it('draws a toolbar only through Toolbar, from its data and the shared icons', () => {
    onlyIn(['components/Toolbar.tsx'], /className=["{`](?:[^"}`]*\s)?toolbar(?=[\s"}`])/);
  });
});

describe('panes and sections', () => {
  it('draws a sidebar pane\'s header only through PaneHeader', () => {
    onlyIn(['components/Sidebar.tsx'], /className=["{`](?:[^"}`]*\s)?sidebar-header(?=[\s"}`])/);
  });

  it('draws a titled section with a command or an empty text only through Section', () => {
    onlyIn(['components/Section.tsx'], /\b(dashboard-section-head|dashboard-empty|files-heading|workflow-phase-title|workflow-none)\b/);
  });

  it('draws a phone\'s workflow and Chats window in the same tree as the desktop\'s', () => {
    onlyIn([], /\bfunction (PhoneWorkflow|PhoneSessions|DesktopSessions)\b/);
  });

  it('leaves a property list\'s markup to PropertyList', () => {
    onlyIn(['components/PropertyList.tsx'], /<dl\b/);
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
    /Open in (&N|N)ew Window|openInNewWindow/, // waits for a decision on tablets
    /OPEN_WINDOW_ID|openWindowItems/, // the computer's own windows
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

describe('how a window shows on a phone or tablet', () => {
  const roles: WindowRole[] = ['prompt', 'tool', 'editor', 'workspace', 'detail'];
  const phones = [{ width: 393, height: 852 }, { width: 852, height: 393 }, { width: 360, height: 800 }];
  const tablets = [{ width: 1376, height: 1032 }, { width: 1032, height: 1376 }, { width: 1180, height: 820 }, { width: 820, height: 1180 }, { width: 800, height: 1280 }];

  /** The table: what each role and modal flag gives, by OS and kind of device. */
  const expected = (os: 'ios' | 'android', tablet: boolean, role: WindowRole, modal: boolean): Presentation => {
    if (role === 'detail') return os === 'ios' ? 'page-sheet' : 'bottom-sheet';
    if (tablet) {
      if (role === 'workspace') return 'push';
      if (os === 'ios') return role === 'editor' ? 'page-sheet' : 'form-sheet';
      return modal ? 'dialog' : 'push';
    }
    if (!modal) return 'push';
    if (os === 'ios') return 'page-sheet';
    return role === 'prompt' ? 'bottom-sheet' : 'full-dialog';
  };

  it('depends on the role, modal flag, OS and device kind, never on the window size', () => {
    for (const os of ['ios', 'android'] as const) {
      for (const [tablet, screens] of [[false, phones], [true, tablets]] as const) {
        for (const screen of screens) {
          for (const role of roles) {
            for (const modal of [false, true]) {
              expect(presentation(os, { role, modal }, false, screen), `${os} ${screen.width}x${screen.height} ${role} modal=${modal}`).toBe(expected(os, tablet, role, modal));
              expect(presentation(os, { role, modal }, true, screen)).toBe('root');
            }
          }
        }
      }
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
