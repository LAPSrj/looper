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
    const offenders: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Any mark: a constant (NOT_MOBILE), a literal array or a platform name; not a comment, nor a copy of a mark ([...x]).
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
        if (!/\bplatforms\??\s*[:=]\s*(\[(?!\.\.\.)|['"]|[A-Z][A-Z_]+\b)|\bplatforms[,=] ?(NOT_MOBILE|DESKTOP_ONLY)/.test(line)) return;
        const near = lines.slice(Math.max(0, i - 4), i + 3).join('\n');
        if (!ALLOWED.some((r) => r.test(near))) offenders.push(`${path.relative(src, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
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
    if (role === 'editor') return os === 'ios' ? 'page-sheet' : tablet ? 'dialog' : 'full-dialog';
    if (tablet) {
      if (role === 'workspace') return 'push';
      if (os === 'ios') return 'form-sheet';
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

/**
 * The `className`s a .tsx file writes: its string literals, outside comparisons (`x === 'a'`). A name built with an
 * interpolation keeps only its literal parts, so `ios-group-${x}` gives `ios-group-`.
 */
function classNamesIn(source: string): string[] {
  const src = source
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    .join('\n');
  const names: string[] = [];
  const start = /\bclassName\s*[=:]\s*/g;
  for (let m = start.exec(src); m; m = start.exec(src)) {
    const i = start.lastIndex;
    const c = src[i];
    let body = '';
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) continue;
      body = src.slice(i, end + 1);
    } else if (c === '{') {
      let depth = 0;
      let j = i;
      let inString: string | null = null;
      const templates: number[] = [];
      for (; j < src.length; j++) {
        const ch = src[j];
        if (inString) {
          if (ch === '\\') j++;
          else if (inString === '`' && ch === '$' && src[j + 1] === '{') {
            templates.push(depth);
            inString = null;
            depth++;
            j++;
          } else if (ch === inString) inString = null;
        } else if (ch === '"' || ch === "'" || ch === '`') inString = ch;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (templates.length && templates[templates.length - 1] === depth) {
            templates.pop();
            inString = '`';
          } else if (depth === 0) break;
        }
      }
      body = src.slice(i, j + 1);
    } else continue;
    body = body.replace(/(?:===?|!==?)\s*(["'])[^"'\n]*\1/g, ' ');
    for (const s of body.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
      const text = (s[1] ?? s[2] ?? s[3]).replace(/\$\{[^}]*\}/g, ' ');
      for (const name of text.split(/\s+/)) if (/^[a-z][\w-]*$/i.test(name)) names.push(name);
    }
  }
  return names;
}

const tsxFiles = files.filter(([file]) => file.endsWith('.tsx'));
const comment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

describe('Back and a screen\'s title', () => {
  /** The bar rows and the three frames draw the bars; nothing else may. */
  const BAR = ['web/NavBarRow.tsx', 'web/IosFrame.tsx', 'web/AndroidFrame.tsx', 'web/DesktopFrame.tsx'];

  it('draws Back only through NavBar: no back chevron, back arrow or *-back class outside the bar rows and the frames', () => {
    /** A file that may keep one, and why. */
    const ALLOWED: Record<string, string> = {
      'web/MaterialMenu.tsx': "a submenu's own back arrow, inside a menu, not a screen's Back",
      'components/WorkflowView.tsx': "the desktop's bar over a workflow agent's conversation; a phone returns before it and its agent view has its own bar",
    };
    const offenders: string[] = [];
    for (const [file, text] of tsxFiles) {
      if (BAR.includes(file) || file in ALLOWED) continue;
      for (const name of new Set(classNamesIn(text))) if (/(^|-)back(-|$)/.test(name)) offenders.push(`${file}: class "${name}"`);
      text.split('\n').forEach((line, i) => {
        if (comment(line)) return;
        if (/\b(ARROW_BACK|BACK_ICON)\b|ICONS\.(previous|back)\b|aria-label=["']Back["']|[‹←]|M6\.5 1\.5 1\.5 6\.5/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'Back is drawn only by NavBar (web/NavBarRow.tsx): report it with <NavBar back={...} />').toEqual([]);
  });

  it('draws a screen\'s title only through NavBar', () => {
    const TITLE = /^(ios|md)-bar-(titles?|subtitle)$|^(ios-large-title|md-headline|pg-large-title|ws-titlebar|ws-title)$/;
    const owners = [...BAR, 'web/PathBar.tsx', 'web/ws-titlebar.tsx', 'web/PairPage.tsx', 'components/phone/PhoneList.tsx'];
    const offenders: string[] = [];
    for (const [file, text] of tsxFiles) {
      if (owners.includes(file)) continue;
      for (const name of new Set(classNamesIn(text))) if (TITLE.test(name)) offenders.push(`${file}: class "${name}"`);
    }
    // A heading element is a screen's title: only the bar, the large title, the pairing page and the pages before the shell draw one.
    const headings = ['web/NavBarRow.tsx', 'components/phone/PhoneList.tsx', 'web/PairPage.tsx', 'web/Waiting.tsx', 'AboutApp.tsx'];
    for (const [file, text] of tsxFiles) {
      if (headings.includes(file)) continue;
      text.split('\n').forEach((line, i) => {
        if (!comment(line) && /<h1\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "a screen's title is NavBar's title (and the large title in RowList's LargeTitle)").toEqual([]);
  });
});

describe('lists on a phone', () => {
  const doc = fs.readFileSync(path.join(renderer, 'components', 'components.md'), 'utf8');
  const listed = (/^- Phone list components: (.*)$/m.exec(doc)?.[1] ?? '').match(/`[^`]+`/g)?.map((f) => f.replace(/`/g, '')) ?? [];
  const code = (text: string) => text.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
  const inPhoneDir = (file: string) => file.startsWith('components/phone/');

  it('draws a Row only inside the shared phone list components (components.md, "Phone list components")', () => {
    expect(listed.length).toBeGreaterThanOrEqual(9);
    for (const f of listed.filter((f) => f.endsWith('.tsx'))) expect(fs.existsSync(path.join(renderer, f)), f).toBe(true);
    const offenders = files
      .filter(([file, text]) => file.endsWith('.tsx') && !listed.includes(file) && !inPhoneDir(file) && /<Row[\s>/]/.test(code(text)))
      .map(([file]) => file);
    expect(offenders, 'a phone list goes through PhoneRows (RowList.tsx), or the component is registered under "Phone list components"').toEqual([]);
  });

  it('draws a group header for a phone only in the shared phone list (PhoneList.tsx)', () => {
    for (const [file, text] of files) {
      if (file === 'components/phone/PhoneList.tsx' || !file.endsWith('.tsx')) continue;
      const own = /<GroupHeader\b[^>]*(isPhone|inTree=\{false\})/.test(code(text));
      expect(own, `${file}: a phone's group header is a Group's title, never a GroupHeader row in a card: use PhoneRows`).toBe(false);
    }
  });
});

describe('the component registry (components/components.md)', () => {
  const doc = fs.readFileSync(path.join(renderer, 'components', 'components.md'), 'utf8');
  const [sharedPart, customPart = ''] = doc.split(/^## Custom components$/m);

  interface Entry {
    heading: string;
    fields: Map<string, string>;
  }
  const entriesOf = (text: string): Entry[] =>
    text
      .split(/^#{3,4} /m)
      .slice(1)
      .map((block) => {
        const [heading, ...lines] = block.split('\n');
        const fields = new Map<string, string>();
        for (const line of lines) {
          const m = /^- ([A-Za-z0-9 ]+): (.*)$/.exec(line);
          if (m && !fields.has(m[1])) fields.set(m[1], m[2]);
          else if (m) fields.set(m[1], `${fields.get(m[1])}\n${m[2]}`);
        }
        return { heading, fields };
      });
  const shared = entriesOf(sharedPart).filter((e) => e.fields.has('File'));
  const custom = entriesOf(customPart).filter((e) => e.fields.has('Source'));
  const patterns = [...shared, ...custom].flatMap((e) => [...(e.fields.get('Classes') ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  const registered = (name: string): boolean => patterns.some((p) => (p.endsWith('-*') ? name === p.slice(0, -2) || name.startsWith(p.slice(0, -1)) : name === p));
  const exists = (list: string): boolean => list.split(',').every((f) => fs.existsSync(path.join(renderer, f.replace(/`/g, '').trim())));

  it('registers every shared component with its file, what it follows on each platform and its guard', () => {
    expect(shared.length).toBeGreaterThanOrEqual(35);
    for (const e of shared) {
      for (const key of ['Role', 'iOS 27', 'Material 3', 'Win32', 'Guard', 'Classes']) expect(e.fields.get(key), `${e.heading}: ${key}`).toBeTruthy();
      expect(exists(e.fields.get('File')!), `${e.heading}: File`).toBe(true);
    }
  });

  it('gives every custom component its source, its classes and a reason: the shared component it moves to or why it stays', () => {
    expect(custom.length).toBeGreaterThanOrEqual(78);
    for (const e of custom) {
      expect(exists(e.fields.get('Source')!), `${e.heading}: Source`).toBe(true);
      expect(e.fields.get('Role'), `${e.heading}: Role`).toBeTruthy();
      expect(e.fields.get('Classes'), `${e.heading}: Classes`).toBeTruthy();
      expect(e.fields.has('Moves to') !== e.fields.has('Stays custom'), `${e.heading}: exactly one of Moves to and Stays custom`).toBe(true);
    }
  });

  it('knows every class name a .tsx file uses: a new custom component is registered, with a reason, before it passes', () => {
    const unregistered: string[] = [];
    for (const [file, text] of tsxFiles) {
      for (const name of new Set(classNamesIn(text))) if (!registered(name)) unregistered.push(`${file}: ${name}`);
    }
    expect(unregistered, 'add the component to components/components.md: a shared one with its specs and guard, or a custom one with its reason').toEqual([]);
  });
});
