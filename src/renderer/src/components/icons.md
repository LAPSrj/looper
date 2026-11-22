# Icon guidelines

Looper's toolbar, tab and button icons are the `ICONS` in `icons.tsx`, drawn by
`Icon.tsx`.

## Drawing an icon

- Every icon is a line drawing in a 16 x 16 box (`viewBox="0 0 16 16"`).
  `Icon.tsx` sets the stroke (`currentColor`, `ICON_STROKE` = 1.4, round caps
  and joins) and no fill, so an icon only has its paths' `d`.
- Keep the shape between 1.5 and 14.5 on both axes, so the stroke isn't
  clipped at the edge of the box.
- Put straight lines and rectangle edges on .5 coordinates, as the existing
  icons do, so a new icon lines up with the ones next to it.
- Center an icon that stands alone in the box. Only a compound icon (below)
  moves its base toward a corner.
- Line up icons that sit side by side by their top edge, and not by the
  centers of their boxes. The folder's top is at 3.5, and the checklist's and
  the bubble's at 3. A bubble whose top is higher looks taller than its
  neighbours, because its tail, low on the left, leaves most of its outline
  near the top.
- Give an icon a one-line comment saying what it shows when its name doesn't
  make that clear.

## One object, one shape

Each object Looper shows has one shape, and its tab and every button that
acts on it use that shape:

| Object | Shape | Tab icon | Buttons built on it |
|---|---|---|---|
| Project | `folder` | `projectsTab`: two folders | `newProject` |
| Task | `TASK_CHECKS` | `tasksTab`: the checklist, smaller | `newTask` |
| Chat | `BUBBLE` | `chatsTab`: two bubbles | `newChat` |
| Dashboard | `dashboard` | `dashboardTab`: the grid, smaller | the Chats and Tasks toolbars' Dashboard (Overview) |

- Tab labels are plural, so a tab whose shape is one thing shows two of it,
  one in front of the other. A tab whose shape is already many (the
  checklist's rows, the grid's tiles) is drawn smaller instead, so it matches
  the doubled icons' size. Buttons use the single shape.
- Each tab has its own icon key (`…Tab`), so resizing a tab icon doesn't
  change the toolbar button that shares its shape.
- Share the shape in code (a constant such as `BUBBLE` or `TASK_CHECKS`, or
  the same path), so changing the base changes every icon built on it.
- A new tab gets a shape of its own that no button or tab uses yet. If the tab
  has a New button, draw that button from the tab's shape.
- The New buttons are one toolbar group, in the order of the tabs: New
  Project, New Task, New Chat, then New Terminal on the Chats tab.
- A button that shows only beside the object it acts on doesn't repeat the
  object's shape. A conversation's toolbar shows only in a conversation, so its
  buttons are the action alone: Stop is the task's `stop` square, Close
  Conversation the `close` X, Send Now fast-forward, Restart Agent a circular
  arrow, and Compact arrows meeting at a line.

## Compound icons

A compound icon is an action on an object: the object's shape, with a small
action mark in a corner.

- New is the object's shape with a plus at the bottom-right (`M12 9.2v5.6M9.2
  12h5.6`). Don't use that corner plus for anything else.
- Leave a gap of about 1.5 between the mark and the base by drawing the base's
  parts clear of the mark. For the plus, the gap is a circle of radius 4.3 at
  12,12, and each line of the base ends 0.7 (half the stroke) before it, so
  its round cap reaches the gap's edge (`bubbleClear`, `newProject`).
- Don't cut the base with a mask. WebKit keeps a mask at the size it was
  first drawn, and an iOS menu grows out of its button, so a masked icon in a
  menu showed only its top-left corner.
- When the mark covers most of a part of the base, leave that part out
  instead of keeping a stub that touches the mark. `newTask` drops its last
  row's line and shortens the second.

## Keep shapes apart

A shape means one thing everywhere. Before adding an icon, check that no tab
or button shown at the same time looks like it.

- `folder` is a project, and `openFolder` (the folder with its front tipped
  forward) opens a folder in Explorer: Open Folder and Open Working Directory.
- The speech bubble is chats only. Guidance for the next run is a note with a
  folded corner (`guidance`).
- `delete`, the can with a lid, is Delete. The Recycle Bin (`recycleBin`) is
  the same can with slats, so its button on the Tasks toolbar isn't read as
  deleting the selected task.
- Restart Agent's circular arrow turns the other way from `refresh`'s, which an
  addon can put on the same toolbar.
- The pencil is Edit. Don't put a pencil on another icon, because Edit Task is
  next to Guidance on the Tasks tab.
- Activity Pane is a window with a right column, so it isn't read as another
  chat button.

## Other places

- A phone's tab bar and rail draw these tab icons (`…Tab`) at 24 px (`TabIcon`
  in `phone/tab-icons.tsx`), in place of the systems' own symbols, so the views
  look the same as on the desktop. Only More, which the desktop has no tab for,
  draws its own dots.
- The status glyphs (`StatusGlyph`) are Windows' on the desktop, and on a phone
  that system's own symbols: SF Symbols' xmark.circle.fill,
  exclamationmark.triangle.fill and info.circle.fill on iOS, and Material
  Symbols' error, warning and info on Android, in the system's red, orange and
  tint.
- A New button shows its New icon on a phone's bar too (`newProject`,
  `newTask`). The plain `add` plus is for an addon that chooses it.
- Addons can name the icons in `ADDON_ICONS` (`src/shared/addons.ts`), the ones
  in their manifest's `icons`, and the library's (`library:<name>`,
  `scripts/build-icon-library.mjs`). Adding one to `ADDON_ICONS` also adds its
  description to that script, which writes `docs/addon-icon-list.md`. An addon
  tab that names no icon gets `window`.
- `docs/addon-icons.md` is what addon authors read. It repeats the sizes and the
  corner plus above, so a change to them changes it too. Looper never adds a mark
  to an addon's icon: a New icon has its plus drawn in.
- `iconNode` draws every icon a surface gets by name. An addon's drawing travels
  with the name (`svg:…`), because a phone's frame draws what a page reports to
  it and has no list of addons.

## Docs

The toolbar tables in `docs/monitoring.md` name each button by its shape
("Checklist with a plus", "Open folder"). Changing an icon's shape updates its
rows there, and the screenshots in `docs/img/` that show it.
