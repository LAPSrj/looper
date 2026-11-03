# Looper — project rules

## Development

- **No backward-compat code.** The project is in active development. No
  migration logic, no fallback parsing of old formats, no legacy shims. When
  the schema changes, old data is simply invalid.
- **Clean up the full stack when removing a feature.** Check and delete all
  references: types, engine, IPC handler, preload bridge, API, renderer
  components, routes, CSS, and menu items.
- **Interactive mode is the primary mode.** Design features (output viewing,
  terminal tabs, idle detection) for the interactive path first; headless is
  secondary.
- **Interface changes update the docs.** Every change to what the user sees
  updates the pages in `docs/` that describe it, and retakes each screenshot
  in `docs/img/` that shows the changed screen. The app bundles those images,
  so rebuild after replacing one. Take screenshots with `npm run screenshots`
  in the Windows copy (`scripts/screenshots/driver.mjs`): it runs the build on
  a fresh copy of the demo data in `scripts/screenshots/demo/`, at 1388x895
  for the main window (`ss <name> 1388x895`). The displays run at 100%
  scaling, so a larger size only adds empty space around the same content.
- **Screenshots show no addons unless they're about addons.** `launch` starts
  the demo without its example addon (the Servers pane, toolbar button, Tools
  menu and status bar count), and `launch addons` keeps it. Use `launch
  addons` only for the screenshots in `docs/addons.md`.
- **Screenshots never show a full email address.** When one appears (for
  example in a Claude Code status line in a terminal), edit the image so it
  shows only the part before the @, with the rest of the line moved left.

## UI style

- **No badges or pills.** Show status and result values as plain text, not
  colored badges, pills, or chips.
- **No help text by default.** Don't add `help` props, hints, or tooltips
  unless the control is unusable without one — a required input format, a
  non-obvious consequence. Keep it short. Never restate what the label,
  options, or placeholder already say.
- **Units go inside the input field** as a right-aligned suffix (the
  `.input-suffix` pattern), not in the label. Use SI abbreviations: "s" for
  seconds, "min" for minutes.
- **Icons follow `src/renderer/src/components/icons.md`.** Read it before
  adding or changing an icon.
- **Section headers only when they group 3+ related fields.** Don't add
  headers for one or two fields. Don't add tab descriptions (text between the
  tab bar and the first field).

## Windows app conventions

This is a Windows-first Electron app. Follow native Windows UX patterns:

- **Native dialogs for errors and confirmations** — use `dialog.showMessageBox`
  (type: error/question), not inline error lists or browser `alert()`/`confirm()`.
- **Standard button order:** Save | Cancel | Apply (left to right).
- **Dynamic menu labels** — reflect the available action ("Enable" / "Disable",
  not a combined "Enable / Disable").
- **Right-click context menus** on list items.
- **Only the main window gets "Looper" in its title.** Child windows show just
  their own name (e.g. "Settings", "Edit Task").
- **Dialogs and editors have no menu bar** (Settings, New Task, Edit Project
  and the like) — call `removeMenu()` so Alt doesn't summon one. Windows you
  work in, with commands of their own (the Sessions window, the run window),
  can have one.
- **Settings windows are modal** (block their parent). **Task and template
  editors are modeless** (main window stays usable).

## Editor patterns

- **Classic list-then-window UX** for collections (environments, harnesses,
  models, templates). A plain list with Add/Edit/Duplicate/Remove buttons
  underneath; Edit/Add opens a separate window. Not inline master-detail.
- **Add creates the item immediately** in the store with defaults. Closing the
  window without saving deletes it. The window title says "New X" and the
  primary button says "Create."
