# Addons

An addon is another program that adds to Looper: tabs in the main window and in
each project, a list of items with a screen for the selected one, windows of its
own, and commands in Looper's menus and toolbars. The program only describes what each
screen holds (fields, values, buttons). Looper draws it with its own controls, so
addon screens look and behave like the rest of Looper, and they follow along
when Looper's interface changes.

## Installing an addon

An addon comes with a `.looperaddon` file. Double-click it, drop it on the
Looper window, or use **Advanced → Addons… → Install…**. Looper asks first,
showing the addon's description, the tabs, panes, menu items and toolbar buttons
it adds, how many tools' calls it changes the look of on the Chats window's Now
tab, and the command it runs, and installs it when you click
**Install**. For an addon that's already installed, the button says
**Replace** (another version) or **Reinstall** (the same version).

Installing unpacks the file into a folder of its own, `addons/<id>` in Looper's
data folder, in place of the installed version's folder, and **Remove** deletes
it. An addon that comes with Looper, such as Git, installs itself when Looper
starts, without asking, and updates when Looper comes with a newer version. One
you remove stays removed until you install it by hand.

The command runs with your user account, the way a task's check does, so
install only addons you trust.

Looper starts every installed addon when it starts, and stops them when it
quits.

## Addon panes

![An addon's Servers pane, with a search box, and a server's screen](img/addons-pane.png)

An addon's panes have a tab of their own in the main window, named after its
one pane, or after the addon when it has several. The panes are the list on the
left, and selecting an item shows its screen on the right. An addon can group a
pane's items under headings, like task folders, that you click to collapse;
collapsed groups stay collapsed the next time. Right-clicking an item opens its
menu, and right-clicking a pane's header opens the pane's menu.

## Addon tabs

An addon can add other tabs to the main window, after Looper's own. Each one is
filled by one of the addon's screens, across the whole window, such as a
**Servers** tab that shows every server at once. A tab has a name and an icon.
Without an icon of its own it shows a window icon.

The **Window** menu has an item named after each tab, which opens that tab in a
window of its own. The tabs go away while the addon is stopped in the Addons
window, and a window left on one goes back to the Dashboard.

On a phone or tablet, the tab bar has only Looper's own tabs, and the **More** tab
lists each addon with its tabs.

When an addon stops on its own, its panes say so and show the end of what it
printed as it stopped, with a **Restart** button.

## Project tabs

An addon can add a tab inside each project, after Looper's own: in a project's
view in the Projects tab, on a phone's project screen, and in the Sessions
window's activity pane for the session's project. Each one is filled by one of
the addon's screens, which gets `{ "projectId": "…" }` as its params. For each
project the addon says whether its tab shows and what it's titled now, so a
Git tab can be left out for a folder that isn't a repository, or show
"Git (+2 ~3 −1)". The tabs go away while the addon isn't running.

## Menus and toolbars

An addon's commands join Looper's own menus and toolbars. A command can show on
every tab, while one of Looper's tabs shows, or while the addon's own panes or
screens show, such as **Edit Server…** for the selected server. Its New commands
are in **File** with Looper's New items, and its other tools are in **Tools**,
before Agent Settings.

An addon's buttons are a toolbar of their own, which you can drag like Looper's
(see [The toolbar](monitoring.md#the-toolbar)). **View → Toolbars** has a check box
for each started addon with toolbar buttons, after Looper's own, such as
**Servers Toolbar** (the addon can give it another name), and right-clicking the
toolbar lists the same check boxes. Clearing one leaves all of that addon's
buttons out of the toolbars. Its commands stay in its menus.

On a phone or tablet, a command shows on the screen's bar or in its More menu.
One that no screen has is listed under the addon on the **More** tab.

## The Addons window

**Advanced → Addons…** lists the installed addons with their status (Starting,
Running, or Stopped). Under the list, **Install…** picks a `.looperaddon`
file, **Edit…** changes how the selected addon runs (below), **Stop** stops
it, **Start** starts it again, **Restart** stops and starts it, and
**Remove** uninstalls it after asking. Below the buttons are the selected
addon's command, its panes, and why it stopped, if it stopped on its own.

### Changing how an addon runs

An addon runs in one of your environments from **Settings → Environments**,
the way tasks do, with that environment's WSL distro and shell. Its file says
whether its program is a WSL or a Windows program (or a `looper` script, below),
and Looper starts it in
your default environment when that one runs programs of that kind, or else in
the first environment that does. When none does, the addon stays stopped and
says so. An addon whose file says `looper` is a script Looper runs with its own
Node, so it uses no environment, and its **Edit…** window has no Environment
field.

**Edit…**, or double-clicking an addon, opens a window where you change how
your Looper runs it: the **Environment** (only the ones that run its kind of
program are listed), the **Command**, the **Working folder**, and the
**Environment variables** (`NAME=value`, separated by spaces). Use it when the
addon's program is in a different place on your computer, or when it needs a
setting of yours. **Save** restarts the addon with your settings. Looper keeps
them apart from the addon's file, so installing a new version doesn't undo
them, and **Restore Defaults** goes back to the file's own and the default
environment. The install dialog shows your settings when you have changed
them.

Looper remembers a stopped addon: it doesn't start the next time Looper
starts, its tabs, panes and commands stay hidden, and its windows close, until
you start it again. The status bar counts the
running addons.

## Writing an addon

An addon is any program that reads JSON-RPC 2.0 requests from its stdin and
writes the responses to its stdout, one JSON message per line. Looper starts
it from the manifest, keeps it running, and closes its stdin when it stops
it. The addon should then exit, and Looper kills it if it hasn't exited
2 seconds later. Each line the addon writes to stderr goes to the engine log
as `addon <id> stderr: <line>`, up to 60 lines a minute, and the last lines
also show in the Stopped message. A stdout line that isn't JSON is skipped and
noted in the engine log.

### The package

A `.looperaddon` file is a zip file. The manifest (below) is in it at the root,
as `addon.json`, and the addon's other files, such as its script or its
binaries, are beside it, in folders if you like. Installing unpacks all of them
into the addon's folder, which is `${addonDir}`, and an executable file stays
executable. A new version replaces the whole folder, so an addon keeps what it
saves outside it.

Looper checks every entry before it unpacks any, and refuses the package, with
a message naming the entry, when:

- an entry's path is absolute, starts with a drive letter, has a backslash,
  `..`, an empty or `.` folder name, or a character Windows doesn't allow in
  file names (`< > : " | ? *` and control characters);
- an entry is a link, is encrypted, or uses a compression other than stored or
  deflate;
- two entries have the same name in any case, or a file is also a folder;
- the package has more than 5,000 entries or 500 MB of files, or is damaged;
- there is no `addon.json` at the root, which Looper reads as "the file does not
  contain a Looper addon", the same as for a file that isn't a zip;
- `addon.json` isn't JSON, or doesn't fit the manifest below, in which case the
  first wrong fields are shown.

A manifest whose `$version` is newer than the Looper knows is refused as needing
a newer Looper, and one whose `$version` is older as made for an older Looper.
Format 1 was the manifest alone, as a JSON file, so a format 1 file is refused
the same way: pack its manifest with `$version` 2 and its program as below.
Addons that an older Looper installed stay installed: when Looper starts, it
moves each to its own folder as `addons/<id>/addon.json`, with `$version` 2
and the rest of the manifest as it was, and notes it in the Engine Log.

Looper has no command that packs an addon, so any zip tool makes one, with the
files at the top level and not inside a folder:

```sh
zip -X servers.looperaddon addon.json addon.js
```

`scripts/build-addons.mjs` in Looper's source shows how Looper builds its own:
it bundles an addon's `main.ts` into one CommonJS file, `addon.js`, writes
`addon.json` from the addon's `manifest.ts`, and zips both with `fflate`.

### The manifest

```json
{
  "$type": "looper/addon",
  "$version": 2,
  "id": "servers",
  "name": "Servers",
  "version": "1.0.0",
  "description": "The servers you log in to",
  "run": {
    "on": "looper",
    "command": ["${addonDir}/addon.js"],
    "env": { "SERVERS_FILE": "${addonDir}/servers.json" }
  },
  "panes": [{ "id": "servers", "title": "Servers" }],
  "panesIcon": "library:server",
  "tabs": [{ "id": "overview", "title": "Overview", "view": "overview", "icon": "library:layout-grid" }],
  "projectTabs": [{ "id": "servers", "title": "Servers", "view": "project-servers" }],
  "commands": [
    { "id": "new", "label": "New &Server…", "icon": "add", "in": { "new": { "toolbar": true }, "panes": { "main": true } } },
    { "id": "edit", "label": "&Edit Server…", "icon": "edit", "menu": "edit", "in": { "item": { "toolbar": true, "main": true } } },
    { "id": "shell", "label": "Open &Shell", "icon": "terminal", "menu": "tools", "in": { "project": {} } }
  ]
}
```

| Field | Meaning |
|---|---|
| `$type`, `$version` | Always `looper/addon` and `2`. `$version` is the format: the package, the manifest and the protocol. A Looper that doesn't know the version refuses the file, and asks to be updated when the file is newer. |
| `id` | Letters, digits, `.`, `_`, `-`. It names the addon's folder. Installing another package with the same id replaces the addon. |
| `name`, `version`, `description` | What the install dialog and the Addons window show. |
| `run.on` | `wsl`, `windows` or `looper`. `wsl` and `windows` say whether the program is a WSL or a Windows program, and the user's environment decides the distro and shell. `looper` is a JavaScript program that Looper runs with its own Node (Looper's executable with `ELECTRON_RUN_AS_NODE` set), on the side Looper itself runs, in no environment, so there is nothing for the user to install. |
| `run.command` | The program and its arguments. For `looper`, the script and its arguments, such as `["${addonDir}/addon.js"]`, which run in the addon's folder unless `run.cwd` says another. A WSL command runs through the environment's shell, `bash -lic` unless the user changed it, as tasks do, so the PATH includes what `~/.bashrc` adds (nvm, bun). A Windows command must be an `.exe`. |
| `run.cwd`, `run.env` | Working directory and extra environment variables, on top of Looper's own. |
| `${addonDir}` | In `run.command`, `run.cwd` and `run.env` values: the addon's installed folder, `addons/<id>` in Looper's data folder, as the side the addon runs on sees it (`/home/…` or `/mnt/c/…` in WSL, Looper's own path for `looper`). Looper fills it in each time the addon starts. Put your program in the package and write `"command": ["node", "${addonDir}/addon.mjs"]`, and the addon runs wherever Looper keeps its data. |
| `panes` | The panes on the addon's panes tab, by id and title. |
| `panesIcon` | The icon of the panes tab. Without one it shows a window icon. |
| `tabs` | Tabs in the main window, after Looper's own: `{ id, title, view, params?, icon? }`. Each one is filled by the addon's screen `view`, drawn with `params` like any screen. Without an `icon` the tab shows a window icon. A tab `id` can't repeat, and can't be `panes`, which is the panes tab's. |
| `projectTabs` | Tabs inside each project, after Looper's own: `{ id, title, view, icon? }`. Each one is filled by the addon's screen `view`, drawn with `{ projectId }` as its params, and the `projectTab` request says for each project whether it shows and its title. An `id` can't repeat among the `projectTabs`. |
| `commands` | Everything the addon can do, each once (below). |
| `icons` | The addon's own icons, by name. See [Addon icons](addon-icons.md). |
| `toolbarName` | The name in the View menu's "*name* Toolbar" check box for the addon's buttons. Unset means the addon's `name`. |
| `toolCalls` | How calls to some tools show on the Now tab of the Chats window's activity pane (below). |

### Commands

Each thing the addon can do is one entry in `commands`, which says where it goes,
and Looper draws it on every menu, toolbar and phone bar from that entry. The
list's order is the order in its menus and toolbars.

| Field | Meaning |
|---|---|
| `id` | Sent in its event. An id can't repeat among the commands and their submenus' items. |
| `label` | What it's called, such as `&New Server…`. `&` marks a menu's access key, and `&&` is a literal `&`. A toolbar and a phone leave out the `&` and a trailing `…`. |
| `menu` | `file`, `edit`, `view`, `tools` or `help`: the menu it's in. Every command is in a menu, and a toolbar button is a shortcut to it. A command in `new` is in `file`, and can leave this out. |
| `in` | Where it shows (below). |
| `icon` | Its icon. See [Addon icons](addon-icons.md). |
| `labeled` | `true`: on a toolbar, its label beside its icon. Without it, the icon shows alone with the label as its tooltip, and a command with no icon shows its label. |
| `accelerator` | Its keyboard shortcut (below). |
| `group` | A separator falls between groups, in a menu and on a toolbar. Commands with no group are one group. |
| `check` | `check`: a check mark in a menu and a pressed button on a toolbar, while its state says `checked`. `radio`: a bullet, for one choice among its group. |
| `destructive` | `true` on a command that deletes or stops something, such as Delete Server: a phone shows it in red, last in its menu. Looper doesn't guess it from the label. |
| `confirm` | Asks that question first, and No sends nothing. |
| `opens` | Instead of sending an event, opens a screen in a window of its own, `{ view, params?, width?, height? }`, or one of the addon's tabs, `{ tab }`, where `panes` is the panes tab. Picked again, the window comes forward. Width is 320 to 2000 and height 200 to 1400. A phone's More tab lists the tabs, so a command that opens one stays off phones. |
| `entries` | A submenu (below). |
| `primary` | With `entries`: see below. |
| `platforms` | `desktop`, `web` or `mobile`: the devices it shows on. Unset means all of them. |

`in` lists the places a command shows, each with options:

| Place | The command shows and acts |
|---|---|
| `new` | With Looper's New items, in the File menu of the main window. `toolbar` also puts it in the toolbar's New group. |
| `app` | In the main window, on every tab. |
| `dashboard`, `projects`, `tasks`, `chats` | While that tab shows, in the main window and in that tab's own window. |
| `project` | A project: its right-click menu in the Projects tab, and the Projects tab's menus and toolbar while one is selected, unavailable while none is. The event's `project` is that project's id. |
| `panes` | On the addon's panes tab, and in a pane header's right-click menu. The event's `source` is the pane. |
| `item` | On the panes tab while an item is selected, and it's unavailable while none is. Also in an item's right-click menu. The event's `item` is that item. |
| `screen` | While one of the addon's screens shows, wherever it shows. `views` keeps it to those screens. The event has the screen's field values. |

A place's options are `toolbar: true` for a toolbar button, `main: true` for a
phone's bar while it can run and fits there (otherwise it's in that screen's More
menu), and `context: false` to leave it out of the right-click menu.

The buttons and menu items are unavailable while the addon isn't running.

#### How a command is now

A pane, a pane item and a screen can each send `commands`, how the commands are
at the moment, by id. The most specific one wins:

```json
"commands": {
  "lock": { "label": "&Unlock Vault", "icon": "unlocked" },
  "edit": { "enabled": false },
  "show:all": { "checked": true },
  "copy-totp": { "hidden": true }
}
```

`enabled: false` turns it off, and a phone's menus leave it out while it's off.
`checked` sets its check mark or bullet, `hidden:
true` leaves it out, and `label` and `icon` change what it shows. Picking a
command sends the usual `command` event, and the addon answers with a `refresh` so
the marks follow.

#### Keyboard shortcuts

`accelerator` is a key with `CmdOrCtrl`, such as `CmdOrCtrl+Shift+K`, or a function
key, such as `F12` or `Shift+F11`. `CmdOrCtrl` is Ctrl on Windows. The key works
while the command is in the window's menu bar, and a toolbar button's tooltip
shows it.

The manifest is invalid if it gives a key to two commands, or uses one Looper
uses in any window, such as `CmdOrCtrl+S` or `F5`, so a key means the same thing
everywhere. When two addons choose the same key, the one listed first in the
Addons window keeps it.

#### Submenus

`entries` makes a command a submenu in its menu and a drop-down on a toolbar and a
phone's bar:

```json
{
  "id": "source",
  "label": "&Source",
  "icon": "library:filter",
  "menu": "view",
  "entries": [
    { "id": "source:all", "label": "&All Accounts", "check": "radio" },
    { "id": "source:local", "label": "&Local Only", "check": "radio" },
    { "separator": true },
    { "id": "import", "label": "&Import…", "opens": { "view": "import" } }
  ],
  "in": { "panes": { "toolbar": true } }
}
```

An item has `id`, `label`, `icon`, `accelerator`, `check`, `destructive`, `confirm`
and `opens`, as a command does, and `{ "separator": true }` is a line between
items. A submenu has one level, and its items act where the command is placed.
Picking an item sends a `command` event with the item's `id`, and `commands` sets
how an item is now by that same `id`. A command with `entries` can't have `check`.

A toolbar's button opens the list. With `"primary": true` or `opens`, it's a split
button instead: the icon does the command itself, and the arrow opens the list.

### Requests from Looper

| Method | Params | Result |
|---|---|---|
| `initialize` | `{ protocol: 2, looper, host, dataDir, locale }` | `{}`. Looper marks the addon as running once it answers. `looper` is Looper's version, and `host` is where it runs: `windows`, `wsl`, `linux` or `mac`. `dataDir` is Looper's data folder (where `projects.json`, `settings.json` and the `addons` folder are) as a path on the addon's side, such as `/mnt/c/Users/me/looper` for an addon in WSL. `locale` is the BCP 47 tag Looper formats dates and numbers with, such as `pt-BR`: Windows' regional format, or else the runtime's. |
| `pane` | `{ pane }` | A pane's content (below). |
| `render` | `{ view, params }` | A screen (below). |
| `projectTab` | `{ tab, projectId }` | `{ hidden?, title? }`. How the project tab `tab` is for that project now: `hidden: true` leaves it out of the project's tabs, and `title` is the title it has now, in place of the manifest's. `{}` shows it as the manifest says. |
| `event` | an event (below) | `{ actions?, value?, values? }` |

An answer with `error: { message }` instead of `result` shows the message to
the user: in a dialog for an event, or in place of the screen or pane. Looper
waits 30 seconds for each answer, and 10 minutes for an event's, which can run
a long command.

### Notifications from Looper

Looper tells a running addon what changed with notifications, which have no
`id` and need no answer:

| Method | Params | Sent when |
|---|---|---|
| `projectsChanged` | `{}` | A project is added, removed or changed. Ask `looper/projects` again. |
| `activity` | `{ projectId, working }` | An agent starts working in a project (`working: true`) or stops. |

### Notifications from the addon

The addon can send the `refresh` notification (`{"jsonrpc": "2.0", "method":
"refresh"}`) at any time, and Looper asks for its panes and the screens it
shows again, and for each project tab's `projectTab`. Its params limit what is
asked for again:

```json
{ "jsonrpc": "2.0", "method": "refresh", "params": { "views": ["repo"], "panes": ["repositories"], "projectTabs": true } }
```

| Param | Asks again for |
|---|---|
| `views` | The screens of these views, wherever they show. |
| `panes` | These panes. |
| `projectTabs` | With `true`, every project tab's title and whether it shows. |

With no params, or none of these given, Looper asks for everything. With one
given, it asks only for what is named, so `{ "views": ["repo"] }` leaves the
panes as they are. Params Looper can't read draw everything and put a line in
the Engine Log.

### Requests to Looper

The addon can also ask Looper for things. A request is a JSON-RPC request, with
an `id`, that the addon writes to its stdout, and Looper answers it on the
addon's stdin with a `result`, or with `error: { code, message }` whose
`message` says why. Looper checks the params first, and answers `Invalid params`
with the first wrong fields when they don't fit. A method Looper doesn't have is
answered with code `-32601`.

| Method | Params | Result |
|---|---|---|
| `looper/projects` | `{}` | Looper's projects, in the Projects tab's order: `[{ id, name, cwd, environmentId, side }]`. `cwd` is the project's folder in its environment's own path form (`/home/…` for a WSL project, `C:\…` for a Windows one), and `side` is `wsl` or `windows`, where its programs run. A project whose environment is gone is left out. |
| `looper/environments` | `{}` | The environments from Settings → Environments that can run programs from where Looper runs: `[{ id, name, side, default }]`. |
| `looper/exec` | `{ projectId?, environmentId?, cwd?, argv, env?, stdin?, timeoutSec? }` | `{ code, stdout, stderr }`. Runs a program, without a shell, in a project's environment and folder (a WSL project's inside its distro), the way Looper runs its own git. Give `projectId`, whose folder `cwd` replaces if given, or `cwd` with an `environmentId` (unset: the default environment). `cwd` is in the environment's own path form. `argv` is the program and its arguments, `env` adds variables, and `stdin` is text written to its input, which then closes. `timeoutSec` is 1 to 600, and 60 when unset. A program that exits with an error is still a result, with its `code`: the request fails only when the program can't start or runs past the timeout. |
| `looper/createProject` | `{ name, cwd, environmentId? }` | `{ id }`. Adds a project the way New Project does, in the default environment unless `environmentId` says another. It fails with the reason when the project isn't valid. |
| `looper/openTerminal` | `{ projectId?, environmentId?, cwd?, command, title? }` | `{}`, once it starts. Runs `command` in a terminal where Looper shows terminals, in the project's environment and folder as for `looper/exec`, so a program that asks for input, such as a password, can get it. `title` is the terminal's title, and unset is the command. |
| `looper/activity` | `{}` | `{ working: [projectId, …] }`: the projects an agent is working in now. The `activity` notification follows each change. |
| `looper/openWindow` | `{ view, params?, title, width?, height?, request? }` | `{}`, once the window has closed, however it closed. Opens one of the addon's screens in a window of its own when the addon needs it, instead of as an event's answer, such as a password git asks for in the middle of a pull. It opens as a dialog over the window that sent the event `request` names (its JSON-RPC `id`, while the addon is still answering it), on the device that sent it. Without `request`, or once that window has closed, it opens over the main window. |

### Panes

```json
{
  "items": [
    {
      "id": "db-1",
      "label": "db-1",
      "description": "postgres@db-1.example.com",
      "group": "Production",
      "keywords": "Linux",
      "view": "server",
      "params": { "id": "db-1" },
      "commands": { "copy-password": { "hidden": true } }
    }
  ],
  "search": { "placeholder": "Search servers" },
  "commands": { "show:all": { "checked": true } },
  "empty": "No servers yet."
}
```

Each item is a row like a task's: `label`, and `description` as the line
under it. `mono: true` shows the description in a monospace font, for a path, as the
Projects tab shows a project's folder. `dimmed: true` fades the row the way a disabled task's is. Items
with the same `group` show under a heading with that name, in the order the
groups first appear, and items without one come first. Selecting the item
renders its `view` with its `params` beside the list. Double-clicking it or
pressing Enter sends an `open` event. An item's and a pane's `commands` say how
the addon's commands are now, as above.

`search` makes the pane searchable. The addon has one Search box, at the right end
of the main window's toolbar, which filters every searchable pane of the addon
(**View → Filter…**, Ctrl+F, focuses it). It is drawn and matched the way the
Windows guidelines describe an instant search, with no request to the addon:

- `placeholder` is its prompt, such as "Search servers", and it defaults to
  "Type to search" ("Search" on a phone).
- The list filters as the user types. An item matches when any word typed
  starts a word of its `label`, `description`, `group` or `keywords`, in any
  case.
- While a search is on, every group with a match is open. The "x" in the box or
  Esc clears it, and focusing the box selects what was typed before.

### Screens

```json
{
  "title": "db-1",
  "commands": { "edit": { "enabled": true } },
  "body": [
    { "type": "props", "items": [
      { "label": "Host", "value": "db-1.example.com", "copy": true },
      { "label": "Password", "secret": "password" },
      { "label": "Uptime", "value": "12 days", "note": "Checked 5 s ago" }
    ] },
    { "type": "section", "title": "Notes", "body": [{ "type": "text", "text": "Primary database.\nBackups run at 02:00." }] }
  ],
  "refreshSec": 5
}
```

`instruction` is the page's main instruction, drawn at its top: what to do there,
or the question it asks. `commands` says how the addon's commands are while the
screen shows, as above.
The commands themselves are in the manifest, so a screen's window has the ones
placed in `screen` in its menu bar and toolbar.

`body` is a list of nodes:

| Node | Fields | Drawn as |
|---|---|---|
| `props` | `items`: `{ label, value?, mono?, copy?, note?, secret? }` | Label and value rows, like a task's Status tab. `copy` adds a Copy button, and `note` is muted text at the end of the row. `secret` names a value the addon keeps: the row shows dots, selecting its Show check box sends a `reveal` event and shows the `value` it answers until the box is cleared, and Copy sends a `copy` event whose `value` goes to the clipboard without reaching the screen. |
| `text` | `text`, `muted?` | A paragraph. Line breaks in `text` show as line breaks. |
| `markdown` | `text` | Formatted text. |
| `infobar` | `title`, `message`, `button?`, `level?` | An information bar above the screen's content. `level` is `info` (the default), `warning` or `error`, and sets its icon. |
| `empty` | `text`, `level?`, `button?` | What the screen shows in place of the content it can't show. With a `level`, it's a problem: normal text after a 16x16 icon, as Windows shows in-place errors, with `button` the action that fixes it (Install Git). Without one, it says there's nothing to show. |
| `buttons` | `items`: buttons | A row of buttons. |
| `field` | `id`, `label`, `input`, `value?`, `options?`, `placeholder?`, `buttons?`, `readOnly?`, `accept?`, `suffix?`, `required?`, `autofocus?`, `change?`, `error?` | An input. `input` is `text`, `password`, `textarea`, `number`, `checkbox`, `select` (with `options: [{ value, label, description? }]`, the chosen option's `description` showing under it, and with `change: true` choosing another option sends a `change` event), `list`, `checklist` (both below), `file` or `folder`. `suffix` is a unit shown inside the input. A `file` or `folder` field is a path box with a **Browse…** button, which picks a file or a folder. On a `file` field, `accept: [{ label, extensions }]` (such as `{ "label": "CSV files", "extensions": ["csv"] }`) sets the kinds of file Browse… offers. Its value is the path as the addon sees it: a file or folder picked on Windows reaches an addon in WSL as a `/mnt/c/...` path. `error` is a problem with what's in it, shown under it with an error icon, as Windows shows in-place errors. |
| `row` | `items`: fields | Fields side by side. |
| `section` | `title`, `body` | A titled group of nodes. |
| `tabs` | `id`, `items`: `{ id, title, body }` | Looper's tabs, showing one tab's `body` at a time. In a window, top-level tabs go across the top of the window, and Ctrl+Tab moves between them. The selected tab stays selected when the screen is drawn again, and the fields on every tab keep their values. |
| `footer` | `primary`, `apply?`, or `wizard` | In a window, its bottom bar: the primary button, Cancel (which closes the window), and the apply button, or a wizard's buttons (below). Enter clicks the primary button and Esc cancels. The primary button stays off while a `required` field is empty. A window without a footer has a Close button there, which Esc also clicks. |
| `listDetail` | `id`, `label`, `items`, `selected?`, `empty?`, `detailEmpty?`, `more?`, `menu?` | A list with the selected row's screen beside it (below). |
| `diff` | `title?`, `subtitle?`, `file?`, `hunks`, `binary?`, `truncated?` | A file's changes, as Looper shows an edit's (below). |

A `list` field shows its `options` as rows, `description` being the line under a
label, and `placeholder` when it has none. Its value is the selected row's
`value`. `buttons` are the commands on the selected row, drawn as buttons under
the list and in the row's right-click menu. Clicking one sends a `click` event
with the button's id, and `values` has the list's field id set to that row's
value. With `readOnly: true` the list only shows its rows: none can be chosen,
and it has no `buttons`. A `checklist` shows its `options` as rows with a check box
each, and its value is a list of the checked options' `value`s, such as
`["a", "c"]`. So a field's `value`, and its entry in an event's and an answer's
`values`, is a string, a number, a boolean or, for a checklist, a list of strings.

A `listDetail` is a list whose selected row's screen shows beside it, below it in
a narrow place, and pushed as a screen of its own on a phone, where `label` names
the back button (it is also the list's name for a screen reader). A row is
`{ id, title, subtitle?, mono?, value?, detail? }`, and row ids must differ.
`subtitle` is the line under the title, in a monospace font with `mono`, and
`value` is plain text at the row's end, such as "Modified". `detail` is the
screen, `{ view, params? }`, which Looper asks for with `render` like any
screen. The selection stays by row id when the screen is drawn again. `selected`
is the row selected when the node first shows, and without it the first row is
on the desktop and none on a phone. `empty` is shown instead of the list when it
has no rows, and `detailEmpty` beside it while no row, or a row without
`detail`, is selected. `menu` is buttons that make each row's right-click menu,
and on a phone its screen's More menu: picking one sends a `click` event with
the button's id and the row's id in `item`.

`more: true` says the list has more rows than it sent. Scrolling to within about
300 px of its end sends a `more` event, with the node's `id` as the event's
`id`, once for each state of the rows. The addon answers by sending a `refresh`
with more rows.

A `diff` has `hunks`: `{ oldStart, oldLines, newStart, newLines, lines }`, the
numbers whole numbers from 0, and `lines` the unified diff's lines, each
starting with a space, `+` or `-`. Looper draws line numbers, colors and
highlighting by the extension of `file` (`title` when it is unset). `title` is the
heading, such as the file's path, and `subtitle` is muted text after it, such as
"Modified, staged". `binary: true` is for a file with no lines to compare, and
Looper says so. `truncated: true` says the diff stops early, and Looper says so
after it.

A footer has `primary` (and `apply`) or `wizard`, not both. A `wizard` is a wizard
page's buttons, Back, Next and Cancel: `wizard: { back?, next?, commit? }`.
`back` and `next` are the ids that clicking them sends in a `click` event, and
with no `back`, the first page, Back is off. The page that does the task has
`commit`, a button, in Next's place, named by its verb (Import, Create), or
Finish when the task changes a setting. It has `next` or `commit`, not both.

A button is `{ id, label, primary?, danger?, disabled?, confirm? }`. With
`confirm`, Looper asks that question first, and No sends nothing. A button shows
its label and has no icon, like the buttons in Looper's own windows.

Looper keeps what the user types in the fields while the screen is drawn
again, so an addon can send the same screen with new values in other nodes.
`refreshSec` draws the screen again that often while it shows, for a
countdown or a value that changes.

### Events

```json
{
  "source": { "view": "edit", "params": { "id": "db-1" } },
  "kind": "click",
  "id": "save",
  "values": { "name": "db-1", "host": "db-1.example.com" }
}
```

`source` is where the event came from: a screen (`{ view, params }`), a pane
(`{ pane }`), or one of Looper's own windows for a command placed there
(`{ app: true }`). `kind` is one of:

- `click`: a screen's button, a `list` field's button, or an item of a
  `listDetail`'s `menu`, and `id` is the button. For a `listDetail`'s, `item` is
  the row.
- `command`: one of the manifest's commands or a submenu's item, and `id` is that
  one. For a command placed in `item`, `item` is the selected pane item.
- `open`: a pane item was double-clicked or had Enter pressed, and `id` and
  `item` are that item.
- `reveal` or `copy`: a secret's Show check box or Copy button, `id` is the
  secret.
- `more`: a `listDetail` scrolled near the end of its rows, and `id` is the node's
  `id`.
- `change`: a `select` field with `change: true` was given another option, and
  `id` is the field. `values` already has the new option, and the answer's
  `values` fill the screen's other fields (Git Settings reads the chosen
  environment's settings this way).

`project` is the project a command acts on: the one a command placed in `project`
was picked for, or the one selected in the Projects tab. `values` has the
screen's fields, by field id.

The answer can have:

- `value`: the secret, for `reveal` and `copy`.
- `values`: new values for the screen's fields, by field id.
- `errors`: problems with what was typed, by field id. Each shows under its field
  with an error icon, as Windows shows in-place errors, the first of those fields
  gets the focus, and a field's problem goes once it's changed. Use it instead of a
  `message` for anything one field can fix.
- `actions`, carried out in order:

| Action | Fields | What it does |
|---|---|---|
| `openWindow` | `view`, `params?`, `title`, `width?`, `height?`, `modal?` | Opens a window showing that screen. It doesn't block the window it came from unless `modal` is set. |
| `closeWindow` | | Closes the window the event came from. |
| `refresh` | | Draws the addon's panes and screens again. |
| `message` | `kind` (`info`, `warning`, `error`), `message`, `detail?` | Shows a dialog. |
| `copy` | `text` | Copies the text to the clipboard. |
| `select` | `pane`, `item` | Selects a pane item, such as one just created, in the window the event came from, or in the window that opened it. |

### How tool calls show

The Now tab of the Chats window's activity pane shows the agent's tool calls.
An addon whose program the agent calls as a tool, such as an MCP server that
comes with it, can say how those calls show there, with `toolCalls` in the
manifest:

```json
"toolCalls": [
  { "tool": "mcp__servers__deploy", "title": "Deploy {server}", "params": ["server", "branch"], "result": "markdown" },
  { "tool": "mcp__servers__logs", "params": [], "result": "code", "language": "json" },
  { "tool": "mcp__servers__*", "result": { "view": "tool-call" } }
]
```

| Field | Meaning |
|---|---|
| `tool` | The tool's name as the agent calls it. An MCP server's tools are `mcp__<server>__<tool>`. A `*` at the end matches every name that starts with what comes before it. When several entries match, the one that names the tool wins, and then the longest `*` one. |
| `title` | The title above the call instead of the tool's name. `{name}` in it is the call's parameter of that name. |
| `params` | The parameters to list, in this order. Unset lists them all, and `[]` none. |
| `result` | How the result shows: `text` (as it is, in monospace), `markdown` (formatted), `code` (with line numbers and colors), `image` (the picture the result carries), `table` (a JSON list of objects as a table, a JSON object as name and value rows), or `{ "view": "<id>" }`, one of the addon's screens. Unset shows it the way Looper shows any tool's result. |
| `language` | With `"result": "code"`: the language to color it as, such as `typescript`, `json`, `python`, `bash`, `powershell`, `yaml`, `sql`, `xml` or `markdown`. Unset goes by the extension of the call's `file_path`. |

For a `view`, Looper asks for the screen with `render` and these params:
`{ tool, input, result, error }`, the tool's name, the call's parameters, the
result's text and whether the call failed. The screen shows under the
parameters without its title, and its buttons send events
as on any screen. While the addon isn't running, the result shows the way
Looper shows any tool's. An addon stopped in the Addons window changes no
tool's look.

### Ids and limits

Pane, item, view, command, button, field and secret ids use letters,
digits, `.`, `_`, `:` and `-`, and start with a letter or digit. The addon's
own `id` can't have `:`, because it names its folder. Windows are 320
to 2000 px wide and 200 to 1400 px tall, and `refreshSec` is at least 1.
`params` can be any JSON object, and Looper passes it back unchanged. The rows of a
`listDetail` have ids of their own, and so do the tabs of a `tabs` node, each
unique within it.

### When a reply doesn't fit

Looper checks every pane, screen, project tab and event answer. One that doesn't fit the
protocol shows instead of the screen or pane, or in a dialog for an event,
as "The addon sent a screen Looper can't show:" followed by the first wrong
fields, such as `body.0.type: Invalid discriminator value`. An addon that
exits shows "It exited with code N." and the last lines it wrote to stderr in
its panes and in the Addons window.

### A minimal addon

This Node addon has one pane, `notes`, with one item whose screen shows a
line of text. Its manifest has `"panes": [{ "id": "notes", "title": "Notes" }]` and
`"run": { "on": "wsl", "command": ["node", "${addonDir}/addon.mjs"] }`, and its
package holds the manifest as `addon.json` and the script as `addon.mjs`.

```js
import { createInterface } from 'node:readline';

const notes = [{ id: 'n1', title: 'First note', text: 'Hello from an addon.' }];
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

const methods = {
  initialize: () => ({}),
  pane: () => ({ items: notes.map((n) => ({ id: n.id, label: n.title, view: 'note', params: { id: n.id } })) }),
  render: ({ params }) => {
    const n = notes.find((x) => x.id === params.id);
    return { title: n.title, body: [{ type: 'text', text: n.text }] };
  },
  event: () => ({ actions: [{ type: 'message', kind: 'info', message: 'Clicked.' }] }),
};

createInterface({ input: process.stdin })
  .on('line', async (line) => {
    const msg = JSON.parse(line);
    try {
      send({ id: msg.id, result: await methods[msg.method](msg.params ?? {}) });
    } catch (e) {
      send({ id: msg.id, error: { code: 1, message: e.message } });
    }
  })
  .on('close', () => process.exit(0));
```

An addon whose answers take a while should finish the ones still pending
before it exits on close, by counting the requests it hasn't answered and
exiting when the count reaches zero.

### Testing an addon

Outside Looper, pipe requests into the addon, one per line, and read its
answers:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":2}}' \
  '{"jsonrpc":"2.0","id":2,"method":"pane","params":{"pane":"notes"}}' \
  | node addon.mjs
```

In Looper, install the package. Looper runs the copy it unpacked, not your
files, so while you work, use **Advanced → Addons… → Edit…** to point the
**Command** at your own copy, and **Restart** after each change to the addon's
code, because Looper keeps the process it started. Pack and install again when
the manifest or the package's files change.
**Advanced → Engine Log** shows when each addon starts and how long that took,
when it stops, any stdout line Looper skipped, and the addon's stderr. Its
View menu can list one addon's lines only. A request that takes 250 ms or more
gets a line, and so does one that fails, times out, or gets a reply Looper
can't show:

```
addon servers: #41 render server 1830 ms (2 in flight)
addon servers: #42 event click save 412 ms, failed: The disk is full.
addon servers: render server drawn after 1910 ms
```

`#41` is the JSON-RPC request id, so start your own stderr lines with it to
line them up with Looper's. "In flight" counts the requests still waiting for
an answer when this one was sent. "Drawn after" is a screen that took more
than 500 ms from being asked for to showing. Lines never include request
params, field values, or replies, since those can hold passwords.
