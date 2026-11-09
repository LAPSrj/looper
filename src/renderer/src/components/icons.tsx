import { createElement, type ReactNode } from 'react';
import { DRAWN_ICON, type IconDrawing, type IconShape } from '@shared/addon-icons';
import type { AddonIconName } from '@shared/addons';

/** The stroke of every line icon, and of the glyphs drawn beside text (chevrons, status marks). */
export const ICON_STROKE = 1.4;
/** The heavier stroke of a check or a cross inside a small control. */
export const ICON_STROKE_BOLD = 2;

/** The disclosure chevron's path in its 10 x 10 box. The disclosure triangle in styles.css (summary::before) draws the same path. */
export const CHEVRON_PATH = 'M3.5 1.5 7 5l-3.5 3.5';

/** The one disclosure chevron: it points right and turns a quarter when `open` (styles.css rotates `.chev.open`). */
export function Chevron({ open, className }: { open?: boolean; className?: string }) {
  return (
    <svg
      className={`chev${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={CHEVRON_PATH} />
    </svg>
  );
}

/** How serious a status glyph is. */
export type StatusLevel = 'error' | 'warning' | 'info';

/**
 * Windows' 16 px error, warning and information glyphs, drawn once for the
 * dashboard's status column and the InfoBar. Colors come from the theme tokens
 * (styles.css `.status-glyph`). With a `label` it is an image; without, it is
 * hidden from assistive technology because the text beside it says the same.
 */
export function StatusGlyph({ level, label, className }: { level: StatusLevel; label?: string; className?: string }) {
  return (
    <svg
      className={`status-glyph ${level}${className ? ` ${className}` : ''}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {level === 'error' ? (
        <>
          <circle className="status-glyph-bg" cx="8" cy="8" r="7.5" />
          <path className="status-glyph-mark" d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" strokeWidth="1.6" strokeLinecap="round" />
        </>
      ) : level === 'warning' ? (
        <>
          <path className="status-glyph-bg" d="M8 1.2 15.3 14.3H.7Z" strokeLinejoin="round" />
          <path className="status-glyph-mark" d="M8 5.6v4.3" strokeWidth="1.5" strokeLinecap="round" />
          <circle className="status-glyph-dot" cx="8" cy="12" r=".9" />
        </>
      ) : (
        <>
          <circle className="status-glyph-bg" cx="8" cy="8" r="8" />
          <circle className="status-glyph-dot" cx="8" cy="4.9" r="1" />
          <path className="status-glyph-mark" d="M8 7.3v4.4" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/** A speech bubble on the left of the icon, leaving the bottom-right corner for an action glyph. Its top is at 3, level with the checklist's and the folder's. */
const BUBBLE = 'M3 3h8a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H6.5L3.5 13.8V11H3a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 3Z';

/** The same bubble lower down, leaving the top-right corner for an action glyph. */
const BUBBLE_LOW = 'M3 5h8a1.5 1.5 0 0 1 1.5 1.5v4.5a1.5 1.5 0 0 1-1.5 1.5H6.5L3.5 15v-2.5H3A1.5 1.5 0 0 1 1.5 11V6.5A1.5 1.5 0 0 1 3 5Z';

/** The tasks icon's three checks, down its left side. */
const TASK_CHECKS = 'm1.8 3.8 1.2 1.2L5 3M1.8 8.3l1.2 1.2L5 7.5M1.8 12.8l1.2 1.2L5 12';

/** SVG paths of Looper's 16 px line icons (drawn by Icon), shared by the task toolbar and addon toolbars. */
export const ICONS: Record<
  | AddonIconName
  | 'dashboard'
  | 'resume'
  | 'power'
  | 'complete'
  | 'guidance'
  | 'chat'
  | 'newChat'
  | 'bullhorn'
  | 'sendNow'
  | 'compact'
  | 'stopChat'
  | 'restartAgent'
  | 'closeChat'
  | 'activity'
  | 'attach'
  | 'skills'
  | 'newTask'
  | 'newProject'
  | 'doubleSize'
  | 'normalSize'
  | 'history'
  | 'dashboardTab'
  | 'projectsTab'
  | 'tasksTab'
  | 'chatsTab'
  | 'window'
  | 'previous'
  | 'next'
  | 'close'
  | 'download'
  | 'filter',
  ReactNode
> = {
  previous: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  next: <path d="M6 3.5 10.5 8 6 12.5" />,
  close: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  // An arrow down into a tray.
  download: <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11" />,
  // Lines that get shorter, as a funnel does.
  filter: <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" />,
  dashboard: (
    <>
      <rect x="2.5" y="2.5" width="4" height="4" rx="0.5" />
      <rect x="9.5" y="2.5" width="4" height="4" rx="0.5" />
      <rect x="2.5" y="9.5" width="4" height="4" rx="0.5" />
      <rect x="9.5" y="9.5" width="4" height="4" rx="0.5" />
    </>
  ),
  run: <path d="M4.5 2.8v10.4L13 8Z" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  resume: <path d="M3.5 3.5v9M6.5 3.2 13.5 8l-7 4.8Z" />,
  power: (
    <>
      <path d="M8 2v5.5" />
      <path d="M11.5 4.2a5 5 0 1 1-7 0" />
    </>
  ),
  complete: (
    <>
      <path d="M8 14.5A6.5 6.5 0 1 1 8 1.5a6.5 6.5 0 0 1 0 13Z" />
      <path d="m5 8 2.2 2.2L11 6" />
    </>
  ),
  // A sticky note with its corner folded: a note for the next run.
  guidance: (
    <>
      <path d="M2.5 2.5h11v7l-4 4h-7Z" />
      <path d="M13.5 9.5h-4v4M5 5.5h6M5 8h3" />
    </>
  ),
  // The chat actions' bubble, moved to the middle of the box.
  chat: <path d={BUBBLE} transform="translate(1 -0.4)" />,
  // A speech bubble with a plus at its bottom-right corner, a gap cut around it (Fluent's compound icons).
  newChat: (
    <>
      <mask id="ico-cut-plus" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="white" stroke="none" />
        <circle cx="12" cy="12" r="4.3" fill="black" stroke="none" />
      </mask>
      <path d={BUBBLE} mask="url(#ico-cut-plus)" />
      <path d="M12 9.2v5.6M9.2 12h5.6" />
    </>
  ),
  bullhorn: (
    <>
      <path d="M2 6v3.5h2.8L11 13V2.5L4.8 6Z" />
      <path d="m5.4 9.5 1 3.8h1.8l-.8-3.1M13.5 6v3.5" />
    </>
  ),
  // A speech bubble with fast-forward at its corner: the queued messages skip ahead of the agent's turn.
  sendNow: (
    <>
      <mask id="ico-cut-ff" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="white" stroke="none" />
        <rect x="7.2" y="8" width="9" height="8" rx="2" fill="black" stroke="none" />
      </mask>
      <path d={BUBBLE} mask="url(#ico-cut-ff)" />
      <path d="m9 9.4 2.6 2.6L9 14.6M12.3 9.4l2.6 2.6-2.6 2.6" />
    </>
  ),
  // A speech bubble with lines of text, and a small empty one at its corner: the conversation goes on in a new, shorter one.
  compact: (
    <>
      <mask id="ico-cut-compact" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="white" stroke="none" />
        <rect x="8" y="8" width="8" height="8" rx="2" fill="black" stroke="none" />
      </mask>
      <path d={BUBBLE} mask="url(#ico-cut-compact)" />
      <path d="M4.5 5.6h5M4.5 8.2h3" />
      <path d="M10 9.6h4a1 1 0 0 1 1 1v2.4a1 1 0 0 1-1 1h-2.2l-1.6 1.4V14H10a1 1 0 0 1-1-1v-2.4a1 1 0 0 1 1-1Z" />
    </>
  ),
  // A speech bubble with a stop square at its corner: the agent's turn stops.
  stopChat: (
    <>
      <mask id="ico-cut-stop" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="white" stroke="none" />
        <rect x="8" y="8" width="8" height="8" rx="2" fill="black" stroke="none" />
      </mask>
      <path d={BUBBLE} mask="url(#ico-cut-stop)" />
      <rect x="9.6" y="9.6" width="4.8" height="4.8" rx="0.8" />
    </>
  ),
  // A speech bubble with a circular arrow at its corner: the agent starts again on the same conversation.
  restartAgent: (
    <>
      <mask id="ico-cut-restart" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="white" stroke="none" />
        <rect x="8" y="8" width="8" height="8" rx="2" fill="black" stroke="none" />
      </mask>
      <path d={BUBBLE} mask="url(#ico-cut-restart)" />
      <path d="M14.4 12a2.4 2.4 0 1 1-.7-1.7M14 8.9v1.6h-1.6" />
    </>
  ),
  // A speech bubble lower down with an X at the top-right corner, as on a window's close button.
  closeChat: (
    <>
      <mask id="ico-cut-close" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="white" stroke="none" />
        <circle cx="12.5" cy="3.5" r="3.9" fill="black" stroke="none" />
      </mask>
      <path d={BUBBLE_LOW} mask="url(#ico-cut-close)" />
      <path d="m10.6 1.6 3.8 3.8M14.4 1.6l-3.8 3.8" />
    </>
  ),
  // A window with a column on its right: the activity pane, so it doesn't read as another chat button.
  activity: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M10 2.5v11M11.8 5.5h1.2M11.8 7.8h1.2" />
    </>
  ),
  attach:<path d="m13 7.5-5.2 5.2a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.3 11.2a1 1 0 0 1-1.5-1.5L10 4.5" />,
  skills: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M9.6 5 6.4 11" />
    </>
  ),
  edit: <path d="m11.3 2.7 2 2L5.5 12.5l-2.8.8.8-2.8Z" />,
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="m4 6 2.5 2L4 10M8.5 10.5h3.5" />
    </>
  ),
  folder: <path d="M1.5 12.5v-8a1 1 0 0 1 1-1h3.2L7 5h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />,
  // The folder with its front tipped forward: opening one in Explorer, unlike the plain folder (a project).
  openFolder: <path d="M13 7.5V6a1 1 0 0 0-1-1H7L5.7 3.5H2.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h9.6a1 1 0 0 0 .9-.6l2.2-4.7a.5.5 0 0 0-.45-.7H4.4a1 1 0 0 0-.9.6L1.6 12.9" />,
  add: <path d="M8 3v10M3 8h10" />,
  // The tasks icon with a plus in place of its last two rows' lines, the second row's cut short to clear it.
  newTask: (
    <>
      <path d={`${TASK_CHECKS}M7.5 4h6.5M7.5 8.5h1.3`} />
      <path d="M12 9.2v5.6M9.2 12h5.6" />
    </>
  ),
  // The folder icon with a plus at its bottom-right corner, a gap cut around it.
  newProject: (
    <>
      <mask id="ico-cut-plus-project" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="white" stroke="none" />
        <circle cx="12" cy="12" r="4.3" fill="black" stroke="none" />
      </mask>
      <path d="M1.5 12.5v-8a1 1 0 0 1 1-1h3.2L7 5h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" mask="url(#ico-cut-plus-project)" />
      <path d="M12 9.2v5.6M9.2 12h5.6" />
    </>
  ),
  // Arrows out to two corners, and back in: a dashboard card at twice its size, and at its normal size.
  doubleSize: <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />,
  normalSize: <path d="M13 7H9V3M9 7l4.5-4.5M3 9h4v4M7 9l-4.5 4.5" />,
  // A clock face with an arrow going round it counter-clockwise, back in time.
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 5.5-5.5 6 6 0 0 0-4.1 1.7L2.5 5.6" />
      <path d="M2.5 2.5v3.1h3.1" />
      <path d="M8 5v3l2.2 1.4" />
    </>
  ),
  // The tabs' icons: two of a project's and a chat's shape for the plural names, and the dashboard's and the task list's drawn smaller to match their size.
  dashboardTab: (
    <>
      <rect x="3" y="3" width="3.5" height="3.5" rx="0.5" />
      <rect x="9.5" y="3" width="3.5" height="3.5" rx="0.5" />
      <rect x="3" y="9.5" width="3.5" height="3.5" rx="0.5" />
      <rect x="9.5" y="9.5" width="3.5" height="3.5" rx="0.5" />
    </>
  ),
  projectsTab: (
    <>
      <path d="M1.5 12.5V7a1 1 0 0 1 1-1h2.7L6.5 7.3h5a1 1 0 0 1 1 1v4.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" />
      <path d="M4 6V4a1 1 0 0 1 1-1h2.7L9 4.3h4.5a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1h-1" />
    </>
  ),
  tasksTab: (
    <>
      <path d="m2.5 4.4 1.1 1.1 1.9-1.9M2.5 7.9 3.6 9l1.9-1.9M2.5 11.4l1.1 1.1 1.9-1.9" />
      <path d="M7.5 4.5h5.5M7.5 8h5.5M7.5 11.5h5.5" />
    </>
  ),
  chatsTab: (
    <>
      <path d="M1.5 6.5a1.3 1.3 0 0 1 1.3-1.3h6.4a1.3 1.3 0 0 1 1.3 1.3v3.7a1.3 1.3 0 0 1-1.3 1.3H5.5L3 13.8v-2.3h-.2a1.3 1.3 0 0 1-1.3-1.3Z" />
      <path d="M5.5 5.2V3.8a1.3 1.3 0 0 1 1.3-1.3h6.4a1.3 1.3 0 0 1 1.3 1.3v3.7a1.3 1.3 0 0 1-1.3 1.3H13v2.2l-2.5-2.2" />
    </>
  ),
  // A window with a title bar: an addon's tab, when it names no icon of its own.
  window: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M1.5 5.5h13" />
    </>
  ),
  delete: <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.8 9h6.4l.8-9" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" />,
  open: <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />,
  key: (
    <>
      <circle cx="5" cy="11" r="2.5" />
      <path d="m6.8 9.2 6.2-6.2M11 5l1.5 1.5M9.5 6.5 11 8" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="7" width="10" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.3 10.3 3.2 3.2" />
    </>
  ),
  // A gear with eight teeth, as Windows draws Settings.
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M7 3.2L7.2 1.3L8.8 1.3L9 3.2L10.7 3.9L12.1 2.7L13.3 3.9L12.1 5.3L12.8 7L14.7 7.2L14.7 8.8L12.8 9L12.1 10.7L13.3 12.1L12.1 13.3L10.7 12.1L9 12.8L8.8 14.7L7.2 14.7L7 12.8L5.3 12.1L3.9 13.3L2.7 12.1L3.9 10.7L3.2 9L1.3 8.8L1.3 7.2L3.2 7L3.9 5.3L2.7 3.9L3.9 2.7L5.3 3.9Z" />
    </>
  ),
};

const ATTRIBUTE_PROPS: Record<string, string> = { 'fill-rule': 'fillRule', 'clip-rule': 'clipRule' };

function shapeNode([tag, attrs, children]: IconShape, key: number): ReactNode {
  const props: Record<string, unknown> = { key };
  for (const [name, value] of Object.entries(attrs)) props[ATTRIBUTE_PROPS[name] ?? name] = value;
  return createElement(tag, props, children?.map(shapeNode));
}

const drawnNodes = new Map<string, ReactNode>();

/** An addon's drawing, in the 16 x 16 box the surfaces draw in, its strokes as heavy as Looper's whatever its box. */
function drawnNode(icon: string): ReactNode {
  const known = drawnNodes.get(icon);
  if (known) return known;
  const d = JSON.parse(icon.slice(DRAWN_ICON.length)) as IconDrawing;
  const node = (
    <g transform={`scale(${16 / d.box})`} fill={d.fill} stroke={d.stroke} strokeWidth={(ICON_STROKE * d.box) / 16}>
      {d.shapes.map(shapeNode)}
    </g>
  );
  drawnNodes.set(icon, node);
  return node;
}

/** What a surface's `icon` draws: an ICONS key, or an addon's drawing, which travels with the name so a phone's frame can draw what a page reports to it. */
export const iconNode = (icon: string): ReactNode => (icon.startsWith(DRAWN_ICON) ? drawnNode(icon) : (ICONS as Record<string, ReactNode>)[icon]);
