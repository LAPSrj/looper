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
- **Child windows have no menu bar** — call `removeMenu()` so Alt doesn't
  summon one.
- **Settings windows are modal** (block their parent). **Task and template
  editors are modeless** (main window stays usable).

## Editor patterns

- **Classic list-then-window UX** for collections (environments, harnesses,
  models, templates). A plain list with Add/Edit/Duplicate/Remove buttons
  underneath; Edit/Add opens a separate window. Not inline master-detail.
- **Add creates the item immediately** in the store with defaults. Closing the
  window without saving deletes it. The window title says "New X" and the
  primary button says "Create."
