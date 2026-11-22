# Component registry

Every role a screen has is drawn by one shared component, which follows the platform's guideline once for the whole app. This file names that component for each role, the file it lives in, the guideline it follows on each platform, and the test that fails when the role is drawn by hand. Read it before drawing any markup; if a role is here, place the component, and if the component draws the role wrongly, fix the component, never the one screen.

- **A screen never checks the platform.** The component places the role on each target. A change to what a phone screen shows runs `npm run ui-check`, which opens the built app's phone screens and measures them against the lines below.
- **A role that is not here is custom.** Add it to the custom components section with the shared component it should move to, or the reason it stays custom, in the same change that draws it.
- **Specs come first.** iOS follows `src/renderer/src/web/ios.md` (iOS 27 only), Android follows Material 3, the desktop follows the Win32 guide. Read the line for the role before changing its component.

## Targets

Looper runs on five targets from one renderer. `platform.ts` sets `platform` (`electron`, `web`, `ios` or `android`) once and writes it to `<html data-platform>`.

| Target | `platform` | Frame | Layout |
|---|---|---|---|
| Desktop app | `electron` | The real `BrowserWindow`s, native menus and dialogs | Windows |
| Desktop browser | `web` | `web/DesktopFrame.tsx` | Windows drawn in the page |
| iPhone | `ios` | `web/IosFrame.tsx` | A navigation stack and sheets |
| iPad | `ios`, `isTablet` | `web/IosFrame.tsx` | A split view from 700 px of page width |
| Android phone | `android` | `web/AndroidFrame.tsx` | Material screens, dialogs and bottom sheets |
| Android tablet | `android`, `isTablet` | `web/AndroidFrame.tsx` | A split view from 840 dp |

`isTablet` is a short side of 600 px or more (`web/nav-stack.ts`). `presentation()` in the same file decides how a window opens from its role, its modal flag, the OS and the kind of device, never from its size; `tests/ui-roles.test.ts` holds the table.

## Choosing a role

Ask in this order and stop at the first yes. A top-level view is one of the app's main areas. A collection is a list you pick something from. An overview sums up a view while nothing is selected. A section is a part of one item next to its other parts. An item makes sense on its own, usually because it can open in a window of its own. A supporting panel only makes sense beside what it is about. A modal window blocks its parent; a modeless one does not. `scratch/platforms.md` keeps the longer reasoning and the decisions.

## Specs

- **iOS:** `src/renderer/src/web/ios.md`, by section: Navigation bar (top toolbar), Bottom toolbar, iPad toolbar, Split view columns, Floating controls, Keyboard accessory bar, Selection mode (not covered), Tab bar, Lists, Text fields and search, Segmented control, Switch, Buttons, Menus, Alerts, Action sheets, Sheets, Notifications, Progress and page controls, Motion. Apple's Human Interface Guidelines fill what it leaves out.
- **Android:** Material 3, https://m3.material.io. Components: top app bar, navigation bar, navigation rail, tabs, lists, cards, dialogs, bottom sheets, side sheets, menus, text fields, buttons, search, snackbar, progress indicators, toolbars (the floating toolbar). Layout: list-detail, supporting pane, feed, breakpoints (compact under 600 dp, medium 600 to 839, expanded from 840). The rendered text of the pages used is in `scratch/component-inventory/m3/`, and the Toolbars pages' in `scratch/bottom-toolbar/m3/`.
- **Desktop:** the Win32 UX guide, https://learn.microsoft.com/en-us/windows/win32/uxguide/<page>. The pages used, each opened to confirm it exists: ctrl-list-views, ctrl-tree-views, ctrl-tabs, ctrl-text-boxes, ctrl-check-boxes, ctrl-radio-buttons, ctrl-list-boxes, ctrl-command-buttons, ctrl-links, ctrl-group-boxes, ctrl-balloons, ctrl-status-bars, cmd-menus, cmd-toolbars, win-dialog-box, win-property-win, mess-confirm, mess-error, inter-keyboard. Where the guide has no page for a role the entry says so.
- **Provenance:** "unverified match" means the page was not read to confirm it covers that role.

## How the tests read this file

`tests/ui-roles.test.ts` parses this file. Each component is a `###` heading with `- Classes:` listing the class names its markup uses. A name ending in `-*` is a family (`now-*` matches `now` and `now-title`); any other name matches itself. A `className` in a `.tsx` file whose class is in no entry fails the test, so a new component is registered here, with a reason, before it passes. Each shared entry names a `File:` that must exist; each custom entry names a `Source:` that must exist and either `Moves to:` or `Stays custom:`.

Classes are read from `className` props in `.tsx` files only. Classes added from `.ts` files (markdown-render.ts) or in CSS alone are not checked.

## Rules that apply everywhere

1. **Commands go in the toolbar data, not in buttons drawn per platform.** Promote at most two to bar buttons with `NavBar` `actions`; an item's screen gets a designed menu (`more`).
2. **Lists on phones show one level per screen.** Folders are rows with a chevron that push the next level; collapsible headers stay only where a list is long and flat (Chats).
3. **Context menus come from right-click only.** Write `onContextMenu`; the frame turns a 500 ms long press into it (`web/gestures.ts`).
4. **Keyboard text adapts too.** Labels get shortcuts through `withShortcut` (`shortcut.ts`), a multi-line box sends on Enter only on the desktop (`sendsOnEnter`, `components/composer-text.ts`), and a text input on iOS is at least 16 px so Safari does not zoom.
5. **Back and a title are the bar's.** A screen reports them through `NavBar`; no screen draws a back chevron, a back arrow, a `*-back` class or a title element of its own (`tests/ui-roles.test.ts`, "Back and a screen's title").

## Roles at a glance

| Role | Component | File |
|---|---|---|
| Bar and Back | NavBar | `components/NavBar.tsx` |
| Bar and Back | NavBarRow | `web/NavBarRow.tsx` |
| Frames | IosFrame | `web/IosFrame.tsx` |
| Frames | AndroidFrame | `web/AndroidFrame.tsx` |
| Frames | DesktopFrame | `web/DesktopFrame.tsx` |
| Frames | PhoneShell | `web/phone-shell.tsx` |
| List and detail | ListDetail | `components/ListDetail.tsx` |
| List and detail | SplitView | `components/phone/PhoneSplit.tsx` |
| List and detail | SplitPane / Splitter | `components/SplitPane.tsx` |
| List and detail | Inspector | `components/Inspector.tsx` |
| Sheets | PhoneSheet | `components/phone/PhoneSheet.tsx` |
| Sheets | BottomSheet | `web/BottomSheet.tsx` |
| Segmented control and tabs | TabBar / Tabs / Segmented | `components/ui.tsx` |
| Segmented control and tabs | ViewTabs | `components/ViewTabs.tsx` |
| Lists and rows | RowList / Group / Row / SwipeRow / TreeListSection / LargeTitle | `components/RowList.tsx` |
| Lists and rows | SelectList / ListActions / ListButton | `components/SelectList.tsx` |
| Lists and rows | GroupHeader | `components/GroupHeader.tsx` |
| Lists and rows | ReorderSheet | `components/phone/ReorderSheet.tsx` |
| Lists and rows | OverviewSwitch / TasksOverview / PhoneOverview | `components/phone/OverviewSwitch.tsx` |
| Sections and tables | Section | `components/Section.tsx` |
| Sections and tables | PropertyList | `components/PropertyList.tsx` |
| Sections and tables | DataTable | `components/DataTable.tsx` |
| Toolbars and menus | Toolbar | `components/Toolbar.tsx` |
| Toolbars and menus | BottomToolbar | `components/BottomToolbar.tsx` |
| Toolbars and menus | PaneHeader / PaneStack | `components/Sidebar.tsx` |
| Toolbars and menus | Menu | `components/Menu.tsx` |
| Fields and buttons | IosField | `web/IosField.tsx` |
| Fields and buttons | Form components | `components/ui.tsx` |
| Fields and buttons | WindowActions | `components/WindowActions.tsx` |
| Fields and buttons | Buttons and text styles | `styles.css` |
| Fields and buttons | SearchBox / FindBar | `components/SearchBox.tsx` |
| Message box and conversation | MessageBox | `components/MessageBox.tsx` |
| Message box and conversation | Conversation / TranscriptView / ChatView | `components/Conversation.tsx` |
| Message box and conversation | Markdown | `components/Markdown.tsx` |
| Empty states and notices | EmptyState | `components/EmptyState.tsx` |
| Empty states and notices | InfoBar | `components/ui.tsx` |
| Empty states and notices | Notifications | `web/Notifications.tsx` |
| Empty states and notices | StatusBar | `components/StatusBar.tsx` |
| Icons | Icon | `components/Icon.tsx` |
| Icons | ContextRing | `components/ContextRing.tsx` |
| Layout | Window and page containers | `App.tsx` |
| Frames | File and path dialogs | `web/IosFrame.tsx` |

## Shared components

Each entry gives the file, what it draws, what it follows on each platform and the test that guards it. "No role guard yet" means only the class names registry (`tests/ui-roles.test.ts`, "class names") watches it, and a markup guard is still to be written.

### Bar and Back

#### NavBar

- File: `components/NavBar.tsx`
- Role: A screen reports its title, subtitle, Back, Cancel and Confirm, bar buttons, toolbar and More menu. Draws nothing on the desktop; a phone draws the bar of its platform. The only way a screen shows a title or Back.
- iOS 27: `ios.md` "Navigation bar (top toolbar)": 54 high, Back a semibold chevron alone in a 44 x 44 glass circle, title 17/22 semibold centered.
- Material 3: [Top app bar](https://m3.material.io/components/top-app-bar/specs): 64 dp bar, back arrow in the leading icon button, title in the bar.
- Win32: [Dialog boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/win-dialog-box): a window has a title bar, a toolbar and a footer, so NavBar adds nothing.
- Guard: `tests/nav-bar.test.ts` ("one bar component"); `tests/ui-roles.test.ts` ("Back and a screen's title"); `npm run ui-check`.
- Classes: none

#### NavBarRow (IosBarRow, MdBarRow, IosBrowserBarRow)

- File: `web/NavBarRow.tsx`
- Role: The bar row each phone platform draws, from the bar model in `web/nav-bar-model.ts`. Internal to NavBar and the frames; a screen never uses it.
- iOS 27: `ios.md` "Navigation bar (top toolbar)".
- Material 3: [Top app bar](https://m3.material.io/components/top-app-bar/specs).
- Win32: n/a (phones only).
- Guard: `tests/nav-bar.test.ts` ("draws every bar row through NavBarRow"); `tests/ui-roles.test.ts` ("Back and a screen's title"); `npm run ui-check`.
- Classes: `fit`, `ios-back`, `ios-bar-group`, `ios-bar-lead`, `ios-bar-row`, `ios-bar-subtitle`, `ios-bar-title`, `ios-bar-titles`, `ios-bar-trail`, `ios-files-bar`, `ios-icon-btn`, `ios-title-*`, `md-bar-row`, `md-bar-subtitle`, `md-bar-title`, `md-bar-titles`, `md-crumb-*`, `md-crumbs`, `md-icon-btn`, `prominent`, `ws-crumb-*`, `ws-crumbs`

### Frames

#### IosFrame

- File: `web/IosFrame.tsx`, `web/IosMenu.tsx`
- Role: The iPhone and iPad shell: bar, tab bar, alerts, its own sheets, file and device sheets, menus.
- iOS 27: `ios.md` "Navigation bar (top toolbar)", `ios.md` "Tab bar", `ios.md` "Alerts", `ios.md` "Action sheets", `ios.md` "Sheets", `ios.md` "Menus".
- Material 3: n/a.
- Win32: n/a.
- Guard: `tests/code-splitting.test.ts` (loaded lazily); `tests/ui-roles.test.ts` ("Back and a screen's title": the frames own the bar); class names (`tests/ui-roles.test.ts`, "class names"); `npm run ui-check`. No role guard for its sheets and alerts yet.
- Classes: `destructive`, `ios`, `ios-alert-*`, `ios-bar`, `ios-bar-detail`, `ios-bar-inspector`, `ios-bar-list`, `ios-bar-split`, `ios-cell-button`, `ios-checkcircle`, `ios-device-pick`, `ios-files-search`, `ios-group`, `ios-group-footer`, `ios-menu-*`, `ios-own-sheet`, `ios-segmented`, `ios-sheet-body`, `ios-submenu`, `ios-tab`, `ios-tabbar-*`, `ph-card`, `ph-scrim`, `ph-scroll`, `split`

#### AndroidFrame

- File: `web/AndroidFrame.tsx`, `web/MaterialMenu.tsx`
- Role: The Android shell: top app bar, dialogs, file screens, device sheet, menus.
- iOS 27: n/a.
- Material 3: [Top app bar](https://m3.material.io/components/top-app-bar/specs), [Dialogs](https://m3.material.io/components/dialogs/guidelines), [Bottom sheets](https://m3.material.io/components/bottom-sheets/specs), [Menus](https://m3.material.io/components/menus/specs).
- Win32: n/a.
- Guard: `tests/code-splitting.test.ts` (loaded lazily); `tests/ui-roles.test.ts` ("Back and a screen's title"); class names (`tests/ui-roles.test.ts`, "class names"); `npm run ui-check`. No role guard for its dialogs yet.
- Classes: `android`, `main`, `md-bar`, `md-bar-pane`, `md-bar-split`, `md-bottom-actions`, `md-check-row`, `md-device-pick`, `md-dialog-*`, `md-handle`, `md-menu-*`, `md-outlined-input`, `md-own-*`, `md-scrim`, `md-sheet-actions`, `md-text-btn`, `ph-probe`, `ph-root`, `tappable`

#### DesktopFrame

- File: `web/DesktopFrame.tsx`, `web/ws-titlebar.tsx`
- Role: The desktop browser shell: windows, title bars, taskbar, dialogs, the This Device file dialogs.
- iOS 27: n/a.
- Material 3: n/a.
- Win32: [Dialog boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/win-dialog-box), [Confirmations](https://learn.microsoft.com/en-us/windows/win32/uxguide/mess-confirm), [Error messages](https://learn.microsoft.com/en-us/windows/win32/uxguide/mess-error).
- Guard: `tests/code-splitting.test.ts` (loaded lazily); `tests/web-shell.test.ts` (shell window stack, file dialog flow); class names (`tests/ui-roles.test.ts`, "class names").
- Classes: `shape`, `ws-backdrop`, `ws-browser-*`, `ws-caption`, `ws-close`, `ws-connection`, `ws-desktop`, `ws-device-*`, `ws-file-*`, `ws-filedialog`, `ws-filename`, `ws-files-empty`, `ws-filter`, `ws-frame`, `ws-icon-btn`, `ws-main`, `ws-modal-layer`, `ws-msg-icon`, `ws-msgbox-*`, `ws-resize-*`, `ws-root`, `ws-sources`, `ws-task`, `ws-taskbar`, `ws-thisdevice-*`, `ws-title`, `ws-titlebar`, `ws-viewer-*`, `ws-window`

#### PhoneShell (phone-shell, phone-files)

- File: `web/phone-shell.tsx`, `web/phone-files.tsx`, `web/nav-stack.ts`
- Role: How a window presents on a phone or tablet (`presentation()`): root, pushed screen, page sheet, form sheet, full-screen dialog, dialog or bottom sheet; the file and path screens.
- iOS 27: `ios.md` "Sheets".
- Material 3: [Dialogs](https://m3.material.io/components/dialogs/guidelines) (full-screen dialogs for compact only), [Bottom sheets](https://m3.material.io/components/bottom-sheets/specs).
- Win32: n/a.
- Guard: `tests/ui-roles.test.ts` ("how a window shows on a phone or tablet"); `tests/phone-frames.test.ts` ("presentation"); `npm run ui-check`.
- Classes: `ph-bar-slot`, `ph-body`, `ph-connection`, `ph-drag`, `ph-file-*`, `ph-files-*`, `ph-frame`, `ph-viewer`, `ph-win`, `pres-`, `slide-`

### List and detail

#### ListDetail

- File: `components/ListDetail.tsx`
- Role: A collection and its item or row detail: columns where there is room, a pushed detail (with the bar's Back) where there is not.
- iOS 27: `ios.md` "Lists"; HIG [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views).
- Material 3: [List-detail](https://m3.material.io/foundations/layout/canonical-examples/list-detail): Back in the detail only in a single pane.
- Win32: [List views](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-list-views), [Tree views](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-tree-views) (list beside its detail).
- Guard: `tests/ui-roles.test.ts` ("list and detail"; "Back and a screen's title"); `npm run ui-check`.
- Classes: `list-detail-*`, `list-summary-*`, `pg-inline-back`, `pg-segmented-wrap`, `sessions-body`

#### SplitView (PhoneSplit)

- File: `components/phone/PhoneSplit.tsx`
- Role: Two columns on an iPad and an Android tablet. Placed only by ListDetail.
- iOS 27: HIG [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views): 320 or 375 pt list column from 700 px of page width.
- Material 3: [List-detail](https://m3.material.io/foundations/layout/canonical-examples/list-detail): two panes from 840 dp.
- Win32: n/a.
- Guard: `tests/ui-roles.test.ts` ("list and detail"); `tests/phone-frames.test.ts` ("splitLayout"); `npm run ui-check`.
- Classes: `pg-split`, `pg-split-detail`, `pg-split-lead`, `pg-split-pane`

#### SplitPane / Splitter

- File: `components/SplitPane.tsx`
- Role: A two-pane splitter with a keyboard separator.
- iOS 27: n/a (fixed columns).
- Material 3: n/a (fixed columns).
- Win32: [Dialog boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/win-dialog-box) do not cover splitters; Looper's own (unverified).
- Guard: `tests/ui-roles.test.ts` ("draws a two-pane splitter only through SplitPane"); `tests/v3-live-fixes.test.ts` (separator a11y).
- Classes: `split-cell`, `split-divider`, `split-pane`

#### Inspector

- File: `components/Inspector.tsx`
- Role: A supporting panel (the Activity pane): a pane on the desktop, a column on an iPad, a sheet on a phone.
- iOS 27: `ios.md` "Sheets": a large sheet starts under the status bar.
- Material 3: [Supporting pane](https://m3.material.io/foundations/layout/canonical-examples/supporting-pane), [Bottom sheets](https://m3.material.io/components/bottom-sheets/specs).
- Win32: [Property windows](https://learn.microsoft.com/en-us/windows/win32/uxguide/win-property-win) (unverified match).
- Guard: `tests/ui-roles.test.ts` ("supporting panels"); `npm run ui-check` (a large sheet starts under the status bar).
- Classes: `pg-split-inspector`, `sidebar-divider`

### Sheets

#### PhoneSheet

- File: `components/phone/PhoneSheet.tsx`, `components/phone/sheet-detents.ts`
- Role: A page's own sheet (Activity, Usage), with its bar from NavBar. It rests at a medium and a large height, so it is the one sheet with a grabber, a button that a tap moves to the other height.
- iOS 27: `ios.md` "Sheets": a large sheet starts right under the status bar, over the bar; a grabber only on a resizable sheet (HIG Sheets).
- Material 3: [Bottom sheets](https://m3.material.io/components/bottom-sheets/specs).
- Win32: n/a.
- Guard: `tests/ui-roles.test.ts` ("supporting panels"); `tests/nav-bar.test.ts` ("what closes a container"); `tests/sheet-grabber.test.ts`; `npm run ui-check` (grabber rules).
- Classes: `detent-`, `pg-sheet-*`, `usage-panel`

#### BottomSheet

- File: `web/BottomSheet.tsx`
- Role: The Android bottom sheet.
- iOS 27: n/a.
- Material 3: [Bottom sheets](https://m3.material.io/components/bottom-sheets/specs).
- Win32: n/a.
- Guard: class names (`tests/ui-roles.test.ts`, "class names"). No role guard yet.
- Classes: `md-bottom-sheet`, `md-handle-area`, `md-sheet-layer`

### Segmented control and tabs

#### TabBar / Tabs / Segmented

- File: `components/ui.tsx`, `components/Tabs.tsx`, `components/tabs-model.ts`
- Role: Sections of one item: the desktop's tab strip, iOS's segmented control, Material tabs, or rows that push each panel.
- iOS 27: `ios.md` "Segmented control": at most five segments on iPhone, 32 high track.
- Material 3: [Tabs](https://m3.material.io/components/tabs/guidelines): scrollable tabs when they do not fit.
- Win32: [Tabs](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-tabs), [Property windows](https://learn.microsoft.com/en-us/windows/win32/uxguide/win-property-win).
- Guard: `tests/tabs-fields.test.ts`; `tests/v3-live-fixes.test.ts` (segmented targets, one Tab stop); class names (`tests/ui-roles.test.ts`, "class names").
- Classes: `end`, `start`, `tab`, `tab-close`, `tab-item`, `tab-label`, `tabs`, `tabs-scroll-button`

#### ViewTabs (TabRail, PhoneTabBar, IosTabBar)

- File: `components/ViewTabs.tsx`, `components/phone/tab-icons.tsx`
- Role: The top-level views: tabs on the desktop, a tab bar on iPhone and iPad, a navigation bar or rail on Android.
- iOS 27: `ios.md` "Tab bar".
- Material 3: [Navigation bar](https://m3.material.io/components/navigation-bar/guidelines), [Navigation rail](https://m3.material.io/components/navigation-rail/guidelines).
- Win32: n/a (Looper's own).
- Guard: `tests/phone-nav.test.ts` ("how the views show"); class names (`tests/ui-roles.test.ts`, "class names").
- Classes: `desktop-tab-icon`, `main-tabs`, `phone-tab-*`, `phone-tabbar`, `view-*`

### Lists and rows

#### RowList / Group / Row / SwipeRow / TreeListSection / LargeTitle

- File: `components/RowList.tsx`, `components/phone/PhoneList.tsx`
- Role: Lists and rows on every device: inset grouped on iOS, Material list items on Android, compact rows on the desktop. `LargeTitle` is the iOS large title inside a list screen.
- iOS 27: `ios.md` "Lists": cards 16 from the edges, rows 52 high, text 16 in.
- Material 3: [Lists](https://m3.material.io/components/lists/guidelines): 16 dp leading padding, edge to edge in compact windows.
- Win32: [List views](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-list-views).
- Guard: `tests/form-consistency.test.ts` (row metrics); `tests/phone-lists.test.ts`; class names (`tests/ui-roles.test.ts`, "class names"); `tests/ui-roles.test.ts`, "lists on a phone"; `npm run ui-check` (list cards 16 from the edges; a group header is a section's title, never a row in a card).
- Phone list components: `components/RowList.tsx`, `components/PhoneFolders.tsx`, `components/ProjectCollection.tsx`, `components/PropertyList.tsx`, `components/Section.tsx`, `components/SelectList.tsx`, `components/TaskCollection.tsx`, `components/WorkflowView.tsx`, `components/ui.tsx`, and every file in `components/phone/`. Only these draw a `Row`; a list of rows that a phone shows goes through `PhoneRows` (RowList.tsx).
- Classes: `detail-row-*`, `field-label`, `list-title`, `pg-chevron`, `pg-folder-icon`, `pg-group-*`, `pg-large-title`, `pg-list`, `pg-oneline`, `pg-popup-*`, `pg-row-*`, `pg-rows`, `pg-scroll`, `pg-segment-label`, `pg-segmented`, `pg-sessions`, `pg-swipe-*`, `session-swipe-action`, `swipes`

#### SelectList / ListActions / ListButton

- File: `components/SelectList.tsx`
- Role: List-then-window collections (Environments, Templates): a list with Add, Edit, Duplicate and Remove beneath it; command rows on a phone.
- iOS 27: `ios.md` "Lists": a command row has no trailing "…".
- Material 3: [Lists](https://m3.material.io/components/lists/guidelines).
- Win32: [List boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-list-boxes), [Command buttons](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-command-buttons).
- Guard: `tests/form-consistency.test.ts` ("draws a list").
- Classes: `env-actions`, `env-item-*`

#### GroupHeader

- File: `components/GroupHeader.tsx`
- Role: A collapsible group's header, with its chevron.
- iOS 27: `ios.md` "Lists": the chevron at the trailing end of the header, in the tint.
- Material 3: [Lists](https://m3.material.io/components/lists/guidelines).
- Win32: [Tree views](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-tree-views).
- Guard: `tests/controls-tokens.test.ts` ("every group header is a GroupHeader").
- Classes: `group-*`

#### ReorderSheet

- File: `components/phone/ReorderSheet.tsx`
- Role: Reordering on a phone: a sheet in edit mode.
- iOS 27: `ios.md` "Lists" (HIG Lists and tables: reorder in an edit mode).
- Material 3: [Cards](https://m3.material.io/components/cards/guidelines): pick up and move.
- Win32: Drag.
- Guard: `tests/ui-roles.test.ts` ("reordering on a phone"); class names (`tests/ui-roles.test.ts`, "class names").
- Classes: `pg-reorder-*`, `pg-reordering`

#### OverviewSwitch / TasksOverview / PhoneOverview

- File: `components/phone/OverviewSwitch.tsx`, `components/phone/TasksOverview.tsx`, `components/phone/overview-rows.tsx`
- Role: The Overview switch beside a phone list.
- iOS 27: `ios.md` "Segmented control".
- Material 3: [Tabs](https://m3.material.io/components/tabs/guidelines).
- Win32: n/a.
- Guard: `tests/ui-roles.test.ts` ("draws a phone's Overview cards in columns"); class names (`tests/ui-roles.test.ts`, "class names").
- Classes: `pg-overview`

### Sections and tables

#### Section

- File: `components/Section.tsx`
- Role: A titled part of a pane or screen, with a state or command and an empty text: the desktop's heading, a phone's list section.
- iOS 27: `ios.md` "Lists": section title 17/22 semibold in secondary label, 9 above its card.
- Material 3: [Lists](https://m3.material.io/components/lists/guidelines).
- Win32: [Group boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-group-boxes) (section headings, no frame).
- Guard: `tests/ui-roles.test.ts` ("panes and sections"); `npm run ui-check`.
- Classes: `section-*`

#### PropertyList

- File: `components/PropertyList.tsx`
- Role: Name and value pairs.
- iOS 27: `ios.md` "Lists": a value at the trailing end in secondary label.
- Material 3: [Lists](https://m3.material.io/components/lists/guidelines).
- Win32: [List views](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-list-views) (details).
- Guard: `tests/ui-roles.test.ts` ("leaves a property list's markup to PropertyList").
- Classes: `props`

#### DataTable (+ ResizableColumns)

- File: `components/DataTable.tsx`
- Role: A table of rows with resizable columns on the desktop; rows grouped by day or section on phones. Windowed past 200 rows.
- iOS 27: `ios.md` "Lists".
- Material 3: [Lists](https://m3.material.io/components/lists/guidelines).
- Win32: [List views](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-list-views) (report view).
- Guard: `tests/ui-roles.test.ts` ("data tables"); `tests/list-window.test.ts`.
- Classes: `addon-search-bar`, `list-group`, `num`, `pg-rows-search`, `runlog-table-*`

### Toolbars and menus

#### Toolbar (ToolbarButtons, CommandBar)

- File: `components/Toolbar.tsx`, `components/ToolButton.tsx`
- Role: Window and pane toolbars, drawn from the toolbar data and the shared icons. On a phone its commands go to the bar and the More menu; a screen's commands for what it shows go in BottomToolbar.
- iOS 27: `ios.md` "Navigation bar (top toolbar)": bar buttons and menus.
- Material 3: [Top app bar](https://m3.material.io/components/top-app-bar/specs): actions and an overflow menu.
- Win32: [Toolbars](https://learn.microsoft.com/en-us/windows/win32/uxguide/cmd-toolbars).
- Guard: `tests/ui-roles.test.ts` ("toolbars"); `tests/toolbars.test.ts`; `tests/more-menu.test.ts`.
- Classes: `labeled`, `pane-toolbar`, `split-arrow`, `split-button`, `toolbar-sep`

#### BottomToolbar

- File: `components/BottomToolbar.tsx`, `components/toolbar-model.ts`
- Role: The toolbar of a screen's own content: commands that act on what it shows, and a line of status, over that content. A screen gives the toolbar's data once (the desktop's groups) and where each item sits on a phone (`places`: the groups at the leading end and at the trailing end, the status between them). `bottomBarGroups` (toolbar-model.ts) places them: items `places` misses go at the trailing end, and a text item never shares a group with symbols. On a phone the content runs under the toolbar, and what scrolls in it ends with room for it (`--bottom-toolbar-clear` in phone.css: RowList's `.pg-rows`, a page's `.pg-scroll`, Now's screens). Now (Activity) uses it.
- iOS 27: `ios.md` "Bottom toolbar": glass circles and capsules 16 from the sides and 10 apart, the status centered between the two ends, a toggle that's on tinted in a plain glass button, no background of its own; the hard scroll edge behind it when it holds text, the soft one otherwise. HIG Tab bars: "If you need to provide controls that act on elements in the current view, use a Toolbars instead".
- Material 3: the floating toolbar. https://m3.material.io/components/toolbars/guidelines: "Floating toolbar: Floats above the body content. It’s best used for contextual actions relevant to the body content or the specific page", "Horizontal toolbars should have a minimum 16dp margin from the edge of the window", "Floating toolbars have elevation by default", and its "fully-rounded shape"; https://m3.material.io/components/toolbars/specs: "By default all toolbars are 64dp high, center-aligned, have equal padding between items", standard colors "Surface container" with a "Toggle tonal button (Secondary container, On secondary container)". The 8 dp inner padding and elevation level 3 are in the pages' images only, so they come from MDC-Android (`floatingtoolbar/res/values/tokens.xml`, `standard_toolbar_tokens.xml`). Not the docked toolbar, which "Spans the full width of the window. It’s best used for global actions that remain the same across multiple pages", nor the bottom app bar: "The baseline bottom app bar is no longer recommended". Read with the browser MCP; the pages' text and the MDC files are in `scratch/bottom-toolbar/m3/`.
- Win32: [Toolbars](https://learn.microsoft.com/en-us/windows/win32/uxguide/cmd-toolbars): the pane's toolbar above its content, the status after its buttons (drawn by Toolbar).
- Guard: `tests/bottom-toolbar.test.ts` (where the items go; only BottomToolbar draws `bottom-toolbar` markup; a Toolbar strip drawn in place only where its list allows); `npm run ui-check` (content-toolbar: no strip of buttons in a phone's content).
- Classes: `bottom-toolbar-*`, `has-status`, `toolbar-status`

#### PaneHeader / PaneStack

- File: `components/Sidebar.tsx`
- Role: A sidebar pane's header.
- iOS 27: n/a (desktop layout).
- Material 3: n/a (desktop layout).
- Win32: [Tree views](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-tree-views) (unverified match).
- Guard: `tests/ui-roles.test.ts` ("panes and sections").
- Classes: `sidebar`, `sidebar-header`, `sidebar-pane`

#### Menu (IosMenu, MaterialMenu, Win32Menu), MenuBar, WindowContextMenu, MenuList

- File: `components/Menu.tsx`, `components/MenuBar.tsx`, `components/MenuList.tsx`, `web/IosMenu.tsx`, `web/MaterialMenu.tsx`
- Role: Menus, the page-drawn menu bar and context menus.
- iOS 27: `ios.md` "Menus": glass panel, 40 high items.
- Material 3: [Menus](https://m3.material.io/components/menus/specs).
- Win32: [Menus](https://learn.microsoft.com/en-us/windows/win32/uxguide/cmd-menus); [Keyboard](https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-keyboard).
- Guard: `tests/web-shell.test.ts` ("menu keyboard navigation"); `tests/more-menu.test.ts`; class names (`tests/ui-roles.test.ts`, "class names").
- Classes: `has-checks`, `menu-access`, `ws-catcher`, `ws-menu-*`, `ws-menubar-*`

### Fields and buttons

#### IosField

- File: `web/IosField.tsx`
- Role: The iOS frame's own text cells.
- iOS 27: `ios.md` "Text fields and search".
- Material 3: n/a.
- Win32: n/a.
- Guard: `tests/form-consistency.test.ts` ("draws the iOS frame").
- Classes: `ios-cell`, `ios-cell-label`, `ios-field`

#### Form components (Field, FormGroup, TextInput, TextArea, SelectInput, IosPopUp, NumberInput, CheckboxField, RadioField, CheckboxGroup, CheckboxChoices, StepFields, InputRow, InlineField, EmptyWindow)

- File: `components/ui.tsx`, `components/RemoteFields.tsx`, `components/form-blocks.tsx`
- Role: Form fields that adapt per platform: a FormGroup is one card on an iPhone. AgentFields draws the agent fields of every editor; the form blocks (PathField, FolderOptions, ConcurrencyLimit, GuidanceForm) are shared groups.
- iOS 27: `ios.md` "Text fields and search", `ios.md` "Switch".
- Material 3: [Text fields](https://m3.material.io/components/text-fields/specs).
- Win32: [Text boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-text-boxes), [Check boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-check-boxes), [Radio buttons](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-radio-buttons).
- Guard: `tests/form-consistency.test.ts` ("agent fields", "form elements"); `tests/controls-tokens.test.ts`.
- Classes: `checkbox-*`, `col-resize`, `editor`, `editor-body`, `field`, `field-error`, `field-line`, `form-group-*`, `hours-row`, `infobar-*`, `inline-field`, `input-clear`, `main-instruction`, `path-*`, `radio-*`, `row`, `select-*`, `step-fields`, `suffix`, `tab-page`, `tab-sections`, `text-control`

#### WindowActions

- File: `components/WindowActions.tsx`
- Role: A window's commit buttons: the footer on the desktop (Save | Cancel | Apply), the bar's Cancel and Confirm on phones.
- iOS 27: `ios.md` "Navigation bar (top toolbar)": the confirming action is a tinted checkmark circle.
- Material 3: [Top app bar](https://m3.material.io/components/top-app-bar/specs), [Dialogs](https://m3.material.io/components/dialogs/guidelines).
- Win32: [Dialog boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/win-dialog-box): commit buttons.
- Guard: `tests/form-consistency.test.ts` ("writes the footer row by hand only in WindowActions").
- Classes: `editor-footer`, `footer-commit`, `footer-extras`

#### Buttons and text styles (global CSS)

- File: `styles.css`, `phone.css`
- Role: The `btn`, `primary`, `danger` and `small` buttons, and the text styles `muted`, `mono`, `link`, `error-text` and `sr-only`. No shared Button component exists yet: custom #42 and #43 list where buttons are written by hand.
- iOS 27: `ios.md` "Buttons": targets at least 44 x 44.
- Material 3: [Buttons](https://m3.material.io/components/buttons/specs).
- Win32: [Command buttons](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-command-buttons), [Links](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-links).
- Guard: `tests/controls-tokens.test.ts` ("buttons and the terminal", "tokens"); no badge or pill styles.
- Classes: `banner`, `btn`, `danger`, `error-*`, `help`, `link`, `mono`, `muted`, `primary`, `small`, `sr-only`, `warn`

#### SearchBox / FindBar

- File: `components/SearchBox.tsx`, `components/FindBar.tsx`
- Role: Search and find fields.
- iOS 27: `ios.md` "Text fields and search": a glass capsule, 44 high.
- Material 3: [Search](https://m3.material.io/components/search/specs).
- Win32: [Text boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-text-boxes).
- Guard: class names (`tests/ui-roles.test.ts`, "class names"). No role guard yet.
- Classes: `pg-search`, `search-*`

### Message box and conversation

#### MessageBox

- File: `components/MessageBox.tsx`
- Role: The message box: the desktop's command bar and box, a phone's growing capsule with a + menu and one button.
- iOS 27: `ios.md` "Text fields and search", `ios.md` "Liquid Glass" (the floating box).
- Material 3: [Text fields](https://m3.material.io/components/text-fields/specs).
- Win32: [Text boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-text-boxes).
- Guard: `tests/composer.test.ts` (text logic only); class names (`tests/ui-roles.test.ts`, "class names"). No markup guard yet; `Transcript.tsx` still draws its own guidance box (custom #28).
- Classes: `chat-composer`, `composer-*`, `phone-composer-*`

#### Conversation / TranscriptView / ChatView

- File: `components/Conversation.tsx`, `components/ChatView.tsx`, `components/Transcript.tsx`, `components/ChatRows.tsx`
- Role: A conversation's rows, drawn once for every device.
- iOS 27: `ios.md` "Lists" (rows), `ios.md` "Type".
- Material 3: [Lists](https://m3.material.io/components/lists/guidelines).
- Win32: Looper's own.
- Guard: `tests/chat-rows.test.ts` (row building); class names (`tests/ui-roles.test.ts`, "class names"). Its rows (`ChatRows.tsx`) have no markup guard.
- Classes: `chat-agent-group`, `chat-app`, `chat-aside`, `chat-divider`, `chat-file-remove`, `chat-remove-glyph`, `chat-script-*`, `chat-scroll`, `chat-status`, `chat-tool`, `chat-tool-body`, `chat-tool-name`, `chat-tool-result`, `chat-tools`, `chat-working`

#### Markdown (markdown-render.ts)

- File: `components/Markdown.tsx`, `components/markdown-render.ts`
- Role: Markdown to React elements. Raw HTML stays text; no `dangerouslySetInnerHTML` for messages.
- iOS 27: `ios.md` "Type".
- Material 3: n/a.
- Win32: n/a.
- Guard: `tests/markdown-render.test.ts`; CLAUDE.md, Performance ("Markdown goes through markdown-render.ts").
- Classes: `markdown`

### Empty states and notices

#### EmptyState

- File: `components/EmptyState.tsx`
- Role: Empty, loading and problem states.
- iOS 27: `ios.md` "Progress and page controls".
- Material 3: [Progress indicators](https://m3.material.io/components/progress-indicators/specs).
- Win32: Looper's own.
- Guard: `tests/v3-live-fixes.test.ts` (a11y only); class names (`tests/ui-roles.test.ts`, "class names").
- Classes: `empty-*`, `pg-spinner`

#### InfoBar, MainInstruction

- File: `components/ui.tsx`
- Role: An info bar, and a window's main instruction. Classes are registered under Form.
- iOS 27: `ios.md` "Notifications" (unverified match).
- Material 3: [Snackbar](https://m3.material.io/components/snackbar/specs) (unverified match).
- Win32: [Error messages](https://learn.microsoft.com/en-us/windows/win32/uxguide/mess-error), [Balloons](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-balloons).
- Guard: class names (`tests/ui-roles.test.ts`, "class names"). No role guard yet.
- Classes: none

#### Notifications (Banners, Snackbar, Toasts), OfflineBanner

- File: `web/Notifications.tsx`, `web/OfflineBanner.tsx`
- Role: An iOS banner, an Android snackbar, a browser toast; the lost-connection banner.
- iOS 27: `ios.md` "Notifications".
- Material 3: [Snackbar](https://m3.material.io/components/snackbar/specs).
- Win32: [Balloons](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-balloons).
- Guard: class names (`tests/ui-roles.test.ts`, "class names"). No role guard yet.
- Classes: `ios-banner-*`, `ios-banners`, `md-snackbar-*`, `offline-banner-*`, `ws-toast-*`, `ws-toasts`

#### StatusBar

- File: `components/StatusBar.tsx`
- Role: The desktop status bar. Phones have none.
- iOS 27: n/a.
- Material 3: n/a.
- Win32: [Status bars](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-status-bars).
- Guard: class names (`tests/ui-roles.test.ts`, "class names"). No role guard yet.
- Classes: `spacer`, `statusbar`

### Icons

#### Icon, ICONS, StatusMark

- File: `components/Icon.tsx`, `components/icons.tsx`, `components/StatusMark.tsx`
- Role: Every toolbar, tab and button icon. Read `components/icons.md` before adding one.
- iOS 27: SF Symbols on iOS status symbols (see `icons.md`).
- Material 3: Material symbols on Android status symbols (see `icons.md`).
- Win32: `icons.md`.
- Guard: `tests/addon-icons.test.ts`; `tests/controls-tokens.test.ts` ("draws the folder chevron only in the icons module").
- Classes: `chev`, `status-glyph-*`, `status-mark-*`

#### ContextRing, UsageGlyph

- File: `components/ContextRing.tsx`
- Role: The context and usage ring.
- iOS 27: n/a.
- Material 3: n/a.
- Win32: n/a.
- Guard: class names (`tests/ui-roles.test.ts`, "class names"). No role guard yet.
- Classes: `core`, `ring`, `session-icon`

### Layout

#### Window and page containers

- File: `App.tsx`, `main.tsx`, `components/Dashboard.tsx`
- Role: Containers with no visible role of their own: the main window's layout, a window's frame and body, the Dashboard's sections.
- iOS 27: n/a.
- Material 3: n/a.
- Win32: n/a.
- Guard: class names (`tests/ui-roles.test.ts`, "class names").
- Classes: `activity-body`, `activity-list`, `activity-panel`, `activity-section`, `activity-tabs`, `app-*`, `background-*`, `builder`, `builder-app`, `dashboard-*`, `editor-window`, `files-tab`, `history-app`, `messages-app`, `pane-count`, `pane-header`, `pane-sash`, `pane-title`, `phone-conversation`, `phone-detail`, `phone-main-row`, `phone-page`, `phone-screen`, `phone-sessions`, `phone-starting`, `sessions-app`, `single`, `subagent-list`, `tab-body`, `window-*`

### Frames

#### File and path dialogs (FileSheet, FileScreen, FileDialog, PathSheet, PathScreen, PathDialog, FileRows, PathBar, DevicePick)

- File: `web/IosFrame.tsx`, `web/AndroidFrame.tsx`, `web/DesktopFrame.tsx`, `web/PathBar.tsx`
- Role: Open, save and show-file dialogs, one form per platform. Their classes are registered under the frames.
- iOS 27: `ios.md` "Sheets", `ios.md` "Lists".
- Material 3: [Dialogs](https://m3.material.io/components/dialogs/guidelines), [Lists](https://m3.material.io/components/lists/guidelines).
- Win32: [Dialog boxes](https://learn.microsoft.com/en-us/windows/win32/uxguide/win-dialog-box).
- Guard: `tests/web-shell.test.ts` ("file dialog choice flow"); class names (`tests/ui-roles.test.ts`, "class names").
- Classes: none

## Custom components

The 78 components that draw a role themselves instead of placing a shared one, from the 2026-11-22 inventory (`scratch/component-inventory/index.html`, which has a screenshot of each on every device). Each says which shared component it should move to, or why it stays custom. "Differs" lists where it breaks `ios.md` or Material 3 today; fixing it is a change to the shared component, never to the one screen. The `Classes:` of an entry are the class names its markup adds.

### 1. InlineBack

- Source: `components/ListDetail.tsx`
- Role: Back link inside a list-detail column ("‹ Subagents")
- Classes: none
- Moves to: NavBar (Back is the bar's lead button: IosBarRow's .ios-back, MdBarRow's Back). The sheet's bar is PhoneSheet's own NavBar (with its xmark), so the fix belongs in ListDetail and PhoneSheet: the pushed detail's Back should replace the sheet bar's lead.
- Differs: Back is the word of the list it returns to with a chevron before it ("‹ Background", "‹ Subagents"), drawn in the content under the sheet's bar; ios.md:141 says Back is a semibold chevron alone, in the bar (ios.md:136-139: a 44 x 44 glass circle).
- Differs: It sits as a 44-high full-width text row in the tint, a second navigation row under the sheet's own bar (Activity with its xmark), so the sheet shows two bars.
- Differs: Android: drawn as "← Background", an arrow and the list's name in a content row under the sheet's title; Material puts the back arrow in the top app bar's leading icon button (Material 3 top app bar (m3.material.io/components/top-app-bar/specs, rendered text saved in m3/components_top-app-bar_specs.txt:299)), and a bottom sheet has no Back row.

### 2. NowScreen title row

- Source: `components/ActivityPanel.tsx`
- Role: Title row of the Now screen: the tool's name and the call's subject
- Classes: `now-diff`, `now-screen`, `now-subject`, `now-title`, `now-tool`
- Moves to: NavBar title/subtitle on phones; Section header on the desktop
- Differs: A second title row inside the sheet: the tool name in 17 pt semibold ("REPL") with the call's subject beside it in 12 pt monospace, under the sheet's own centered "Activity" title. ios.md:143 has one centered title with a 12/16 medium subtitle under it, not beside it.
- Differs: The subject is in a monospace face; ios.md:81-93 gives only SF Pro styles for text.
- Differs: Android: the same row sits under the bottom sheet's "Activity" title, a second title the top app bar or the sheet's headline would hold.

### 3. BackgroundConsole

- Source: `components/BackgroundConsole.tsx`
- Role: A background command's title row (now-title: label and "Running for …") and its console
- Classes: `bg-console`, `bg-screen-*`
- Moves to: NavBar title with subtitle for the title row; a shared Console/Terminal (none exists, platforms.md:393 proposes one) for the output
- Differs: Title row: the label in 17 pt semibold, left-aligned and cut with an ellipsis, with "Running for …" in 12 pt secondary on the same line at the trailing end (measured on iPhone 15); ios.md:143 puts the title centered with its subtitle under it.
- Differs: Together with the InlineBack row and the sheet's bar it makes three header rows over the console.

### 4. Hand-drawn consoles (TerminalScreen, ScriptConsole, CallLine, FailedCallLine)

- Source: `components/ActivityPanel.tsx`
- Role: A terminal-looking transcript of a Bash call or a Code Mode script ($ prompt, output, cursor)
- Classes: `now-console-*`, `now-term-*`, `now-terminal`
- Stays custom: No shared Console exists. The same `now-terminal` markup is written in three places (BackgroundConsole and twice in ActivityPanel). A console has no iOS or Material component, so it looks the same on every device. Proposed: one shared `Console`, used by #3 and #31 too, registered before more copies are written.

### 5. EditorScreen

- Source: `components/ActivityPanel.tsx`
- Role: A Read, Edit or Write call shown as an editor with a line gutter
- Classes: `now-editor-*`
- Moves to: CodeView/CodeBlock (ToolContent.tsx:283) already draws code with a gutter

### 6. MailView

- Source: `components/ActivityPanel.tsx`
- Role: A SendMessage call drawn as an email (subject, from, to, body)
- Classes: `now-mail-*`
- Stays custom: No shared email layout exists. The header fields could be a PropertyList and the body Markdown, but the sender line (avatar circle, date at the trailing end) has no iOS list equivalent.
- Differs: The sender line uses a gray circle with an initial ("M") and a date at the trailing end, an email layout with no iOS list equivalent; it is not inside an inset grouped card (ios.md:169).

### 7. SentFilesScreen / SentFileView

- Source: `components/ActivityPanel.tsx`
- Role: Files the agent sent, with caption and preview
- Classes: `image`, `now-sent-*`
- Moves to: FileViewContent for the preview; a Row list for the files

### 8. DocScreen

- Source: `components/ActivityPanel.tsx`
- Role: A Markdown document page (a Write of a .md file)
- Classes: `now-doc-*`
- Stays custom: A Markdown page inside a screen. Markdown is the shared renderer (`markdown-render.ts`); the page around it has no role of its own.

### 9. CallList / ScriptCallRows

- Source: `components/ActivityPanel.tsx`
- Role: The tool call list and a script's call list (tool, subject, state per row, a toggle head)
- Classes: `now-call-*`, `now-table`
- Moves to: RowList/Row (DetailRowText) for the rows

### 10. ScriptNow

- Source: `components/ActivityPanel.tsx`
- Role: A Code Mode script's current call with its own toolbar and "n of m" place
- Classes: `now-body`, `now-place`, `now-script-*`
- Stays custom: Toolbar draws the buttons. Now's own row moved to BottomToolbar; this pager of a REPL call's script calls is inside Now, whose bottom toolbar is Now's, and a screen has one ("Don't use multiple toolbars in compact windows", Material 3 Toolbars). Where it should go on a phone needs a decision (a second level of Now's toolbar, or the script's calls as a pushed list). The filled tint circle for Follow the latest has no source in ios.md (see Differs).
- Differs: A toolbar inside the sheet's content (Previous, Next, a filled tint circle for "Follow the latest", List, and "78 of 78" in 12 pt secondary); ios.md:138-140 reserves the tinted circle for the confirming action, and a toggled state drawn as a filled circle has no source in ios.md.

### 11. AddonCallScreen

- Source: `components/ActivityPanel.tsx`
- Role: An addon tool call's result screen
- Classes: `now-result`
- Moves to: ToolResultView/AddonScreenView (it wraps them with its own result block)

### 12. Background and Files list rows

- Source: `components/ActivityPanel.tsx`
- Role: A background item's row (status, label, kind, summary) and a file row (thumbnail, name, folder)
- Classes: `bg-item-head`, `bg-kind`, `bg-label`, `bg-status`, `bg-summary`, `file-dir`, `file-item-text`, `file-thumb`
- Moves to: RowList rows with DetailRowText (RowList.tsx:75)
- Differs: The Background list's cards start 28 pt from the screen's edges where ios.md:169 says 16: `.background-tab { padding: 8px 12px 10px; }` (styles.css:4461), a desktop rule, also applies on phones and adds 12 to Group's own 16 (measured: .pg-list x = 28, width 337 on a 393 pt screen).
- Differs: Each section title moves in with it (text at x = 44, in line with the rows' text at 28 + 16), so the title is not further in than the card's text, only than the screen edge ios.md expects.
- Differs: Android: the same padding puts the rows 28 dp from the screen edge (measured .pg-row x = 28 on a 412 dp Pixel 7), where Looper's other Android lists (Git changes) start at 16 and Material's list items have 16 dp leading padding (Material 3 lists (m3.material.io/components/lists/specs, rendered text saved in m3/components_lists_specs.txt:651)).

### 13. "Nothing is running in the background."

- Source: `components/ActivityPanel.tsx`
- Role: Empty state of the Background tab
- Classes: none
- Moves to: EmptyState

### 14. AgentRow

- Source: `components/AgentRows.tsx`
- Role: A subagent's row: description, status and a PropertyList (agent, model, effort, context)
- Classes: `activity-agent`, `subagent-desc`, `subagent-facts`, `subagent-head`, `subagent-tabs`
- Moves to: Row with a subtitle (or DetailRowText); the property list inside a list row is its own layout

### 15. WorkflowAgentBack

- Source: `components/WorkflowView.tsx`
- Role: A Back button over a workflow agent's conversation
- Classes: `workflow-back-*`
- Moves to: NavBar (Back belongs in the bar)

### 16. WorkflowOverview / ResultSection / PhoneResult

- Source: `components/WorkflowView.tsx`
- Role: A workflow run's header (name, description, error), log and JSON result
- Classes: `workflow-agents`, `workflow-description`, `workflow-error`, `workflow-head`, `workflow-json`, `workflow-log`, `workflow-name`, `workflow-overview`, `workflow-phase`, `workflow-result-*`, `workflow-text`, `workflow-tool`, `workflow-view`
- Moves to: Section and PropertyList (the head is its own title row)

### 17. LimitNotice / LoginNotice

- Source: `components/ChatView.tsx`
- Role: A banner over the message box: usage limit reached, or sign in
- Classes: `chat-limit-notice`
- Moves to: InfoBar (ui.tsx:189)

### 18. ChatView banner and queued message

- Source: `components/ChatView.tsx`
- Role: A muted banner line, and a queued message with its actions
- Classes: `chat-queued-*`
- Moves to: InfoBar for the banner; the queued message is a Conversation row

### 19. PermissionCard

- Source: `components/PermissionCard.tsx`
- Role: A permission request card with Allow and Deny
- Classes: `chat-permission-*`
- Stays custom: An inline card with Allow and Deny. iOS holds such a choice in an alert or action sheet (`ios.md` Alerts, Action sheets) and Android in a dialog, so whether the card moves needs a decision: it stays because the agent waits on it inside the conversation.

### 20. CommandItem

- Source: `components/ChatRows.tsx`
- Role: A "!" command's card: command line, status, chevron, output or terminal
- Classes: `chat-command-*`
- Moves to: Conversation draws it through ChatRows; no shared card

### 21. PromptForm (CommandPromptView)

- Source: `components/CommandPrompt.tsx`
- Role: A "!" command's password prompt (sudo) with a field and buttons
- Classes: `command-*`
- Moves to: MessageBox with a field (IosFrame Alert has an input, ios.md:256) or PhoneSheet

### 22. PlusMenu

- Source: `components/Composer.tsx`
- Role: The message box's + menu on phones
- Classes: `phone-plus-*`
- Moves to: Menu (IosMenu / MaterialMenu), which already morph out of their button (ios.md:343-345)

### 23. Composer CommandBar

- Source: `components/Composer.tsx`
- Role: The message box's command bar: model, effort and mode pickers
- Classes: `bash-prompt`, `chat-commandbar`, `chat-pending`, `commandbar-*`, `slash-*`
- Moves to: Toolbar (it uses Toolbar, but its pickers are its own labeled buttons)

### 24. Conversation rows (UserMessage, SentMessage, ThinkingBubble, ChatRowView)

- Source: `components/ChatRows.tsx`
- Role: Message bubbles, system lines, thinking, tool rows and the subagent hand-back line
- Classes: `chat-agent`, `chat-handback`, `chat-msg`, `chat-superseded`, `chat-system`, `chat-thinking`, `chat-tool-pre`, `chat-tool-preview`, `chat-user`
- Moves to: Conversation (registered) draws them through ChatRows.tsx, which no test guards

### 25. Tool groups and disclosures (ToolGroupView, ScriptCalls, Disclosure)

- Source: `components/ChatRows.tsx`
- Role: "N tool uses" and "Thinking" disclosure rows
- Classes: `chat-tools-list`
- Moves to: Conversation (rows); iOS has no disclosure row of this form
- Differs: "› Thinking" and "› N tool uses" put a gray chevron at the leading edge; ios.md:184 puts a disclosure's chevron at the trailing end of its header, in the tint.

### 26. AttachmentList / SentFileList / ThumbButton / RemoveButton

- Source: `components/ChatRows.tsx`
- Role: Attached and sent files as thumbnails and file rows with Remove
- Classes: `chat-attachments`, `chat-file`, `chat-remove`, `chat-remove-text`, `chat-thumb-*`, `chat-thumbs`
- Stays custom: No shared attachment strip exists. When one is built, Remove must be a 44 x 44 target on phones.

### 27. ScriptCallBox

- Source: `components/ChatRows.tsx`
- Role: A Code Mode call's box inside a conversation
- Classes: `tc-image-note`
- Moves to: Conversation rows

### 28. PendingMessage

- Source: `components/Transcript.tsx`
- Role: A message waiting in the queue, with its actions
- Classes: none
- Moves to: Conversation row

### 29. DraftPanel

- Source: `BuilderApp.tsx`
- Role: The task builder's draft panel: prompt, lists, properties, errors
- Classes: `builder-list`, `builder-panel-*`, `builder-prompt`, `builder-props`, `builder-tabs`, `builder-toolbar`
- Moves to: Inspector holds it; inside, Section and PropertyList (its builder-list rows are its own)

### 30. DraftCard

- Source: `BuilderApp.tsx`
- Role: A card in the builder conversation with Create
- Classes: `chat-card`
- Stays custom: No shared card with an action exists. Material has [Cards](https://m3.material.io/components/cards/guidelines); iOS has no card component, and content uses lists (`ios.md` Lists).

### 31. xterm hosts (TerminalView, CommandTerminal, BuilderTerminal)

- Source: `components/TerminalView.tsx`
- Role: A terminal: the stage around xterm
- Classes: `builder-chat`, `builder-terminal`, `term-key`, `term-keys-*`, `terminal-*`
- Stays custom: No shared Terminal exists. One xterm host that adds the phone key row and overlay is proposed in `scratch/platforms.md` (Components to build).

### 32. Chat cards (CardTitle, CardMessages, LiveCard, SmallCard, TerminalCard)

- Source: `SessionsApp.tsx`
- Role: A chat's card on the Chats overview: title row, last messages, a reply box, actions
- Classes: `big`, `card-split`, `kind-`, `live-only`, `overview-*`, `sessions-toolbar`
- Stays custom: No shared card exists (see #30). The cards follow Material's Cards; iOS has no card, so its form is undecided.
- Differs: A card with its own title row (status icon, 17 pt bold title, an expand button) and a meta line; ios.md has no card component, and its lists are inset grouped cards whose rows are 52 or 68 high (ios.md:169-174).
- Differs: A terminal card whose chat has ended draws a tall empty white area (the ended terminal's output area).
- Differs: Android: the cards are rounded 16 dp (measured border-radius 16px on .overview-chat); Material cards use a 12 dp corner radius (Material 3 cards (m3.material.io/components/cards/specs, rendered text saved in m3/components_cards_specs.txt:195)).

### 33. ChatsDashboard / PhoneOverview grids

- Source: `SessionsApp.tsx`
- Role: The grid the chat cards sit in, with sizes and splitters
- Classes: `active`, `card-gap`, `card-split-cell`, `focus-*`, `layout-*`, `sessions-center`, `sessions-dashboard`, `sessions-overview`
- Stays custom: No shared card grid exists (`scratch/platforms.md`, Card grid).

### 34. Group markup written outside Group

- Source: `SessionsApp.tsx`
- Role: A list section (section.pg-group, h2.pg-group-title, p.pg-group-footer) written by hand
- Classes: `phone-main`
- Moves to: Group (PhoneList.tsx:13) or TreeListSection (PhoneList.tsx:365), which draw the same markup

### 35. SessionRow

- Source: `components/SessionList.tsx`
- Role: A chat's row in the Chats list and History: icon, title, subtitle, status
- Classes: `history-continue`, `history-list`, `history-more`, `session-group`, `session-list`, `session-row-*`, `session-sub`, `session-title`
- Moves to: Row (phones) / RowList (desktop); it writes its own .session-row on both
- Differs: iPhone and iPad: each row is 66 high with its subtitle (measured), where ios.md:169 gives 68 for a row with a subtitle.
- Differs: iPhone History window: the rows (HistoryList with SessionRow) sit on the page with full-width separators under each group title, not in an inset grouped card 16 from the edges (ios.md:169).

### 36. Sidebar trees (FolderTree, GroupedProjects, AddonPaneList, ItemText)

- Source: `components/FolderTree.tsx`
- Role: The desktop's task, project and addon trees: ul.task-list with li.task-item rows
- Classes: `task-*`
- Stays custom: RowList is flat and the desktop's folders are a tree (`ul.task-list` with `li.task-item`). A tree variant of RowList is needed; phones already use PhoneFolderRows and Row.

### 37. DetailView header bar

- Source: `components/DetailView.tsx`
- Role: A task's or project's title bar over its tabs
- Classes: `detail`, `detail-bar`, `status-pane`
- Moves to: NavBar title on phones; PaneHeader-like pane title on the desktop

### 38. DiffPane

- Source: `components/DiffPane.tsx`
- Role: A file diff with its own header (path, counts)
- Classes: `diff-pane-*`
- Moves to: NavBar title for the header; DiffView for the body
- Differs: Phones: the file's path is repeated in a 13 pt monospace header row with a hairline under the bar, which already shows the file name as its title (cut to "check-docs-dri…"); ios.md:143-144 puts a subtitle in the bar, under the title.

### 39. Git commit rows and message (HistoryView, CommitMessage)

- Source: `components/GitView.tsx`
- Role: A commit's line (subject, meta) and its message block
- Classes: `git-commit-*`, `git-tabs`
- Moves to: Row with subtitle (DetailRowText) for the line; Section for the message
- Differs: The commit message sits in a card whose text starts 28 pt inside the card's edge (x = 44 on screen, the card at 16), where ios.md:169 puts a row's text 16 in.

### 40. Tab header with a note (GitView, AddonScreenView)

- Source: `components/GitView.tsx`
- Role: A tab strip with a note beside it (tabs-head, tabs-note) and a footer (tabs-foot)
- Classes: `git-body`, `pg-list-note`, `tabs-foot`, `tabs-head`
- Moves to: TabBar (ui.tsx:598)
- Differs: The Changes/History switch sits in its own strip with a full-width hairline under it, which ios.md's segmented control (ios.md:197-205) doesn't have; the note under it ("On master · …") is 13 pt secondary over the card.
- Differs: Android: the Git tab's Changes/History are a second row of tabs under the project's tabs; Material allows secondary tabs, but here both rows use the same 48 dp primary style with a 3 dp indicator (Material 3 tabs (m3.material.io/components/tabs/specs, rendered text saved in m3/components_tabs_specs.txt:169)).

### 41. FindStrip

- Source: `components/FindBar.tsx`
- Role: The find strip: search field, "n of m", Previous/Next/Close buttons
- Classes: `chat-find`
- Moves to: SearchBox is inside; the strip and its buttons are its own (Toolbar would hold them)

### 42. Bare .btn buttons outside the shared button places

- Source: `components/PermissionCard.tsx`
- Role: Inline command buttons written as <button className="btn …">
- Classes: none
- Stays custom: No shared Button exists. ListButton and WindowActions cover only list and footer buttons.

### 43. Text-link buttons (button.link)

- Source: `components/ChatRows.tsx`
- Role: Inline actions drawn as links (Open, Remove, Show all, Sign in…)
- Classes: none
- Stays custom: No shared link-style button exists (the Buttons entry holds the `link` class).

### 44. MessagesView detail pane

- Source: `components/Messages.tsx`
- Role: The run window's selected message: its body and result
- Classes: `messages`, `messages-chat`, `messages-detail-*`
- Moves to: ListDetail detail column (it is placed by ListDetail, but its header and body are its own)

### 45. Run result previews (RunLog, EngineLogApp, RemoteConversationsApp)

- Source: `components/RunLog.tsx`
- Role: A selected row's preview under a table: result text, "from" line, raw output
- Classes: `output`, `run-detail-app`, `runlog`, `runlog-result-*`
- Moves to: ListDetail detail with a Section (the same runlog-result block is written three times)

### 46. TagSections

- Source: `components/Markdown.tsx`
- Role: A message split into labeled sections (msg-section-label)
- Classes: `msg-*`
- Moves to: Section

### 47. ParamTable

- Source: `components/ToolContent.tsx`
- Role: A tool call's parameters as a two-column table
- Classes: `code-text`, `has-code`, `json-tree`, `tc-code`, `tc-fields`, `tc-file`, `tc-heading`, `tc-params`, `tc-web`, `term-block`, `todo-*`
- Moves to: PropertyList (it is a property list drawn as a table)

### 48. DiffRows / SideBySideDiff

- Source: `components/ToolContent.tsx`
- Role: Unified and side-by-side diffs
- Classes: `diff`, `diff-`, `diff-code`, `diff-hunk`, `diff-line`, `diff-mark`, `diff-num`, `new`, `old`, `sbs-*`
- Stays custom: The one drawing of unified and side-by-side diffs. No other code may draw diff rows; it should be added to the shared list when its role is next reviewed.

### 49. CodeView / CodeBlock

- Source: `components/ToolContent.tsx`
- Role: Code with a gutter and caption
- Classes: `code-caption`, `code-gutter`, `code-line`, `code-view`
- Stays custom: The one code viewer with a gutter and caption. Other code that shows code uses it.

### 50. JsonNode

- Source: `components/ToolContent.tsx`
- Role: A collapsible JSON tree
- Classes: `json-children`, `json-leaf`, `json-node`
- Stays custom: No shared collapsible tree exists.

### 51. FileList

- Source: `components/ToolContent.tsx`
- Role: A Glob/Grep result as a list of files
- Classes: `file-list-*`
- Moves to: RowList

### 52. ToolImage

- Source: `components/ToolContent.tsx`
- Role: An image result with a note
- Classes: `tc-caption`, `tc-image`, `tc-repl-value`
- Moves to: ZoomImage/FileViewContent

### 53. AddonScreenView parts (properties, text, markdown, tabs, list note)

- Source: `components/AddonScreen.tsx`
- Role: An addon screen's own property rows, text, Markdown block, tab header and list note
- Classes: `addon-details`, `addon-fill-*`, `addon-inline`, `addon-markdown`, `addon-prop-*`, `addon-reveal`, `addon-screen`, `addon-section`, `addon-tab-body`, `addon-tabs`, `addon-text`, `addon-wrap`, `tabs-note`
- Moves to: PropertyList for properties, TabBar for tabs, Section for notes

### 54. AddonListDetail header

- Source: `components/AddonListDetail.tsx`
- Role: The detail's own header (detail-head) and result line
- Classes: `detail-head`, `pg-result`
- Moves to: NavBar title
- Differs: Phones: the commit message card's text starts 28 pt inside the card (x 44 on screen, the card at 16), where ios.md:169 puts a row's text 16 in.

### 55. Agent Settings scope, file path and permission rows

- Source: `AgentSettingsApp.tsx`
- Role: The scope switcher, the settings file path and the permission rule rows
- Classes: `agent-*`, `editor-tabs`, `json-editor`, `mu-group`
- Moves to: SelectList/RowList for the rules; PathField for the path
- Differs: iPhone: its Settings / MCP Servers / MCP Permissions switch (TabBar) cuts "MCP Permissions" to "MCP Permissi…" (the shared segmented control's truncation, see the findings).

### 56. ModelUpdateApp list

- Source: `ModelUpdateApp.tsx`
- Role: Models found, grouped, with check rows and a note
- Classes: `mu-group-note`, `mu-list`, `mu-rows`
- Moves to: CheckboxGroup or RowList (GroupHeader is used for the groups)

### 57. Send to Chats list

- Source: `SendToSessionsApp.tsx`
- Role: Chats to send to, as checkbox rows with a title and kind
- Classes: `send-*`
- Moves to: CheckboxGroup (ui.tsx:100) or RowList

### 58. Pair a Device (QR, code, address, progress)

- Source: `RemoteAccessApps.tsx`
- Role: The pairing page: QR code, code, address with Copy, a progress bar
- Classes: `pair-address`, `pair-body`, `pair-code`, `pair-icon`, `pair-message`, `pair-progress-*`, `pair-qr`, `pair-source`, `pair-url`
- Stays custom: No shared form of a QR code, a copyable value and a progress bar exists.

### 59. Remote Access setup summary

- Source: `RemoteAccessApps.tsx`
- Role: Set-up steps: a link, a QR code, a summary list
- Classes: `ra-*`
- Moves to: Section and RowList

### 60. About block

- Source: `AboutApp.tsx`
- Role: The app's icon, name and version
- Classes: `about`
- Stays custom: An identity panel (icon, name, version) has no shared form.

### 61. Instructions page

- Source: `InstructionsApp.tsx`
- Role: A help document page
- Classes: `instructions-*`
- Stays custom: A help document is Markdown in a window of its own; the window has no role beyond it.

### 62. Preview window body

- Source: `PreviewApp.tsx`
- Role: The preview's body, its notes and a missing-image message
- Classes: `image-missing`, `image-zoom`, `preview-app`, `preview-body`, `preview-note`
- Moves to: EmptyState for the missing-image message; FileViewContent for the body

### 63. ImageViewer / ZoomImage

- Source: `components/ZoomImage.tsx`
- Role: A zoomable image
- Classes: `image-viewport`
- Stays custom: The one zoomable image viewer. Other code that shows a zoomable image uses it.

### 64. Version compare panes

- Source: `VersionDetailApp.tsx`
- Role: Two version panes and "same"/"missing" notes
- Classes: `compare-*`
- Moves to: SplitPane/ListDetail for the panes, EmptyState for the notes

### 65. Move to Folder / Select Window pickers

- Source: `MoveToFolderApp.tsx`
- Role: A list picker with a New Folder button
- Classes: `picker-body`
- Moves to: SelectList with ListButton

### 66. Editor window body (div.editor > div.editor-body > div.form)

- Source: `SettingsApp.tsx`
- Role: The body of every dialog and editor window
- Classes: `editor-panel`, `env-tab`, `fill`, `form`, `setup-form`
- Stays custom: No shared editor body exists: EmptyWindow draws only the empty state. A shared EditorWindow (div.editor, div.editor-body, div.form) is needed so editors stop writing it.

### 67. Time chips

- Source: `components/TaskEditor.tsx`
- Role: A daily schedule's times as chips with remove buttons
- Classes: `time-*`
- Stays custom: Pills are not allowed (CLAUDE.md, UI style). The chips should become list rows with Remove, which needs a decision before it moves.

### 68. Rebar / Band

- Source: `components/Rebar.tsx`
- Role: The main window's toolbar bands you drag and size
- Classes: `rebar-*`
- Stays custom: Desktop window layout (toolbar bands). Phones put commands in the bar, so it never draws there.

### 69. IosFrame DeviceSheet list

- Source: `web/IosFrame.tsx`
- Role: This Device sheet's grouped list (ios-grouped, ios-group, ios-cell) and its Switch
- Classes: `ios-cell-value`, `ios-group-title`, `ios-group-titled`, `ios-grouped`, `wrap`
- Moves to: Group/Row (PhoneList.tsx) and CheckboxField's phone switch; the frame writes its own ios-cell list

### 70. AndroidFrame DeviceSheet list

- Source: `web/AndroidFrame.tsx`
- Role: This Device sheet's list (md-list, md-list-item) and its Switch
- Classes: `md-list-*`, `md-sheet-title`
- Moves to: Group/Row and CheckboxField's switch

### 71. Switch (phone-files.tsx)

- Source: `web/phone-files.tsx`
- Role: A switch drawn by the frame (ios-switch, md-switch)
- Classes: `ios-switch-knob`, `md-switch-handle`
- Moves to: CheckboxField, which phones draw as a switch (forms.md)

### 72. AndroidFrame FileScreen tabs and FAB

- Source: `web/AndroidFrame.tsx`
- Role: File dialog's own tabs (md-tabs) and a floating New Folder button (md-fab)
- Classes: `md-fab`, `md-field-*`, `md-tab`, `md-tabs`
- Moves to: TabBar for the tabs

### 73. PairPage

- Source: `web/PairPage.tsx`
- Role: The phone's pairing page before it is paired: logo, code field, buttons
- Classes: `ios-large-title`, `md-headline`, `pair-logo`, `pair-page-*`
- Stays custom: The page frame before pairing stays custom, outside the shell. Its fields and buttons should be Field and WindowActions.

### 74. Waiting

- Source: `web/Waiting.tsx`
- Role: "Waiting for the computer" page
- Classes: `offline-waiting-*`
- Moves to: EmptyState

### 75. QrScanner

- Source: `web/QrScanner.tsx`
- Role: Camera view to scan a pairing code
- Classes: `qr-*`
- Stays custom: A camera view; neither iOS nor Material has a component for it.

### 76. HtmlFrame bar

- Source: `components/preview/HtmlFrame.tsx`
- Role: An HTML preview with its own note and button bar
- Classes: `preview-html`
- Moves to: InfoBar for the note

### 77. XlsxSheets tabs

- Source: `components/preview/XlsxSheets.tsx`
- Role: A workbook's sheet tabs
- Classes: `preview-book`, `preview-sheet-tabs`
- Moves to: TabBar

### 78. DocxPages / PptxSlides / PdfPages / PhoneGrid

- Source: `components/preview/DocxPages.tsx`
- Role: Document pages, slides, PDF pages and a phone's sheet grid
- Classes: `docx`, `pdf-*`, `pptx`, `preview-docx`, `preview-slide`, `preview-slides`
- Stays custom: Document viewers (Word pages, slides, PDF pages, a sheet grid) with no shared form.
