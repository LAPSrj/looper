# Looper — project rules

## Development

- **No backward-compat code.** The project is in active development. No
  migration logic, no fallback parsing of old formats, no legacy shims. When
  the schema changes, old data is simply invalid.
- **Clean up the full stack when removing a feature.** Check and delete all
  references: types, engine, IPC handler, preload bridge, API, renderer
  components, routes, CSS, and menu items.
- **Every feature works on every device.** No "not available on this device".
  A `platforms` mark is only for what lays out a desktop's windows or what the
  device itself provides, and `tests/ui-roles.test.ts` fails on any other.
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

## Performance

The goal is an app that feels as fast as Notepad++ or FileZilla and uses as
little memory as Electron allows. Every rule below comes from a measured cost.

- **`npm run perf` passes before a change is done.** Run it in the Windows
  copy after `npm run build` (`scripts/perf/check.mjs`). It opens every
  window route, main-window tab, task tab and phone screen (iOS in WebKit,
  Android in Edge) on demo data with 20 tasks and 20 chats, runs a day's use
  of the main window, and fails when a screen goes over its budget in
  `scripts/perf/budgets.json` (longest frame, time to content, elements, JS
  heap, memory), draws nothing or throws. A change meant to cost more runs
  `node scripts/perf/check.mjs --update` and says in its commit why.
- **A new screen gets an entry in `scripts/perf/screens.mjs`.** A window
  route in `main.tsx`, a main-window tab, a task tab, a phone tab or a kind of
  pushed phone screen without one fails `tests/perf-coverage.test.ts`.
- **Compare with `npm run perf:bench`, not by feel.** It prints the medians of
  three runs; one run swings by 20% and more. Its `BENCH_` options profile a
  step, trace layout and what invalidated it, try CSS or a script first, pass
  Chromium switches and dump each process's memory (see `scripts/perf/lib.mjs`
  and `journey.mjs`). Test on battery saver too: it shows what a slower
  computer feels.
- **Draw only what can be seen.** A list that can pass a few hundred rows is
  windowed (`DataTable` draws only the rows in view past 200), and a
  conversation draws its newest messages first (`useNewestFirst`). Never map a
  whole collection into elements.
- **Don't put `content-visibility: auto` on content people scroll through.** It
  moves layout and paint into the scroll's frames: scrolling a long chat went
  from a 67 ms worst frame to 217 ms.
- **A scroller that takes its size from its container gets `contain:
  strict`** (desktop only), so a change elsewhere doesn't lay its contents out
  again. Without it each key typed in the message box laid out the whole chat
  and chat list, 25 ms a key. Check first that nothing fixed-position is drawn
  inside it.
- **Code a window doesn't need right away loads on demand.** Window apps are
  lazy imports in `main.tsx`; a dependency over about 50 kB used by one
  feature is imported where it's used (xterm, highlight.js, jsQR, qrcode).
  `npx electron-vite build -c scripts/perf/bundle-report.config.ts` lists each
  chunk's largest modules.
- **Nothing that isn't needed for the first window runs before it.** Startup
  work goes after it (the retention sweep and the git checks wait
  `STARTUP_DEFER_MS`), and `perf.log`'s startup lines time each step.
- **A poll asks whether anything changed before it reads.** The Engine Log
  sends the size it has, and gets text only when the file grew.
- **Expensive results are cached by their input.** Markdown keeps parsed
  messages, so going back to a chat doesn't parse them again.
- **Windows stay sandboxed and share one renderer process.** The preload uses
  only `contextBridge`, `ipcRenderer` and `webUtils`, so `sandbox: true` holds;
  without it every window started Node and opened 280-450 ms later.
  `process-per-site` puts every window's page in one process, so a window
  costs about 5 MB instead of 35 MB, but the windows share one main thread:
  keep a window's load and its updates short, or every window stutters with it.
- **Each window's code is its own chunk, the main window's too.** The chunk
  every window loads holds only React and what `main.tsx` needs (305 kB);
  importing a module with zod schemas (`types.ts`, `addons.ts`) into it puts
  zod back in every window (`tests/code-splitting.test.ts` checks
  `files.ts`).
- **Chromium switches and features: measure before adding.** Turning off 14
  unused Chromium features, background networking and component updates saved
  nothing measurable, and `--in-process-gpu`, `--disable-gpu-rasterization`
  and `--disable-direct-composition` saved nothing or cost more. The memory is
  the GPU driver's, V8's and Blink's for what the windows show.
- **Watch `perf.log`.** The frame watchdog writes each freeze and burst of
  dropped frames there, on the desktop and on phones, with what rendered
  during it. The main process's freezes go there too (`main/main-stalls.ts`),
  with the IPC handlers, events and menu rebuilds that ran in them.
- **Nothing slow runs on the main process's thread.** On Windows it takes
  every window's input, so while it's held all of Looper stops responding,
  and the pages' watchdogs see nothing because they keep drawing. Decoding
  images there froze the app for seconds on each chat switch (20-50 ms a
  screenshot, for every image in the Files tab); thumbnails now come from a
  worker (`main/thumbnails.ts`). Read files with `fs.promises`, and put
  anything that takes more than a few ms in a worker. `npm run perf` fails a
  step that holds the main process past its budget (`mainFreezeMs`).
- **Measure on data shaped like real use.** Real chats keep 1,000 rows, about
  60% of them tool calls holding 1-2 MB; the benchmark's chats (`longChat` in
  `scripts/perf/lib.mjs`) are generated with that mix. A text-only chat hid a
  1.1 s freeze on clicking a chat. Never put anyone's transcript in a fixture.
- **Don't build what's closed.** A `<details>` body is drawn the first time it
  opens (`Disclosure` in `ChatRows.tsx`): built while closed, a dashboard's
  tool calls made 38,000 highlighted elements nobody saw.
- **A state that streams sends what changed.** A working chat's event carries
  its rows' ids and only the changed rows (`shared/chat-delta.ts`), not 1-2 MB
  every 100 ms; the page rebuilds the state, keeping unchanged rows the same
  objects so they don't render again.
- **A page has one engine-event listener: `subscribe` in `events.ts`.** On the
  desktop each `window.looper.onEvent` listener got its own copy of every
  event across `contextBridge` (`tests/perf-rules.test.ts`).
- **No `:has()` on `html`, `body` or `:root`.** `html:has(…)` made every
  inserted element check the whole document's style again, 237 times going
  back to a dashboard (`tests/perf-rules.test.ts`).
- **Make a formatter once.** `toLocaleString` with options builds an
  `Intl.DateTimeFormat` for each call (30 ms for a screen of runs); keep one
  per locale.
- **Markdown goes through `markdown-render.ts`** (markdown-it's tokens to
  React elements): react-markdown's parser took 1.4 ms per reply against
  0.06 ms. Raw HTML stays text, and no `dangerouslySetInnerHTML` for messages.
- **Memory nobody is using goes back.** Once no Looper window has had the
  focus for a minute, `main/memory-trim.ts` sends Chromium's memory-pressure
  signal (278 → 201 MB, and the next chat switch still drew in one frame).
  The scripts turn it off with `LOOPER_NO_MEMORY_TRIM` so their numbers
  compare; the journey's `memory when away` step measures it.
- **One worker for every terminal** (`terminal-host.ts`): each Worker is a V8
  of its own, about 8.5 MB and 100 ms to start.
- **Measured and left out** (`scripts/perf/switches.ps1`): low-end device mode
  and `--use-angle=d3d11-warp` save 50-60 MB but make startup's worst frame
  433-500 ms; the tile, GPU-cache and PartitionAlloc switches change nothing.
- **The main process's young generation doesn't grow.** `boot.ts` sets
  `--semi-space-growth-factor=1` before the app loads (83 → 57 MB in Task
  Manager after startup, with the same frames). `--max-semi-space-size` would
  need the real command line, because V8 reads it only when it creates its heap.
- **Profile with `scripts/perf/anatomy.mjs`** for one window's load split by
  self time into script, style, layout and paint, and `BENCH_HEAP=1` for what
  the main window's heap holds by constructor.

## UI style

- **Components adapt to each OS by themselves.** Looper's UI is made of
  components that follow each system's guidelines and look like a native app.
  On iOS and Android close enough isn't acceptable: it must look the same as
  the system. The long-term goal is that an agent building a screen doesn't
  think about design, because it places the components and they adjust to the
  system. When creating or updating a screen, always try to reuse components.
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

- **Win32 guidelines over WinUI.** The Windows UX guide for Win32
  (learn.microsoft.com/windows/win32/uxguide) wins, so Looper keeps the
  classic, efficient Win32 look and behavior. Use WinUI's guidance only where
  Win32 says nothing on the subject, and say so where you apply it.

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
- **The page draws the menu bar** (`components/MenuBar.tsx`, the same one the
  browser shows), from the window's Electron menu, which stays set but hidden.
  It keeps what a Windows menu bar does: Alt or F10 reaches it and Esc or Alt
  leaves it with the focus back where it was, Alt+letter opens a menu, access
  keys are underlined while they work and pick inside a menu, arrows, Home and
  End move, Esc closes one level at a time, the highlighted item has the focus
  with ARIA menubar, menu and checkbox roles, and high-contrast mode uses the
  system colors. A change to it keeps all of these. Context menus are drawn
  the same way (`WindowContextMenu`), and every open menu level is a small
  window of its own (`platform/menu-popups.ts`), so it reaches past the
  window's edges as a native menu does, while the page keeps the focus and
  the screen reader's copy.
- **Settings windows are modal** (block their parent). **Task and template
  editors are modeless** (main window stays usable).
- **A dialog opens at a fixed size that fits its tallest tab**, as Win32
  dialogs and property sheets do; nothing resizes it after it shows. Its size
  is in its opener in `main/index.ts` and its entry in
  `scripts/perf/screens.mjs` (`fits`), and `npm run perf` fails a dialog that
  opens with anything scrolling, so a form that grows gets a new size.

## Editor patterns

- **Classic list-then-window UX** for collections (environments, harnesses,
  models, templates). A plain list with Add/Edit/Duplicate/Remove buttons
  underneath; Edit/Add opens a separate window. Not inline master-detail.
- **Add creates the item immediately** in the store with defaults. Closing the
  window without saving deletes it. The window title says "New X" and the
  primary button says "Create."
