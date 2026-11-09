# Addon icons

An addon's tabs and commands can each have an icon. It comes from one of three
places, and [Addon icon list](addon-icon-list.md) lists the names:

| You write | The icon is |
|---|---|
| `"icon": "key"` | One of Looper's own |
| `"icon": "library:rocket"` | One of the library's |
| `"icon": "vault"` | One of your manifest's own, from its `icons` |

These fields take an icon: `panesIcon` and a tab's `icon` for the main window's
tabs, a command's `icon` and a submenu item's `icon`, and `icon` in a command's
state, for a command whose icon changes with its state. A tab with no icon shows
a window.

## Where an icon shows

- On the main window's tabs, and on its toolbars, where a command shows its icon
  alone with its label as the tooltip. Set `"labeled": true` to show the label
  beside it, for a command people don't know by its icon.
- On a phone's bar and in a phone's menus. On an iPhone, a menu's group of items
  shows icons only when every item in the group has one. On Android, a menu with
  check marks shows those instead of icons.
- Not in a desktop window's menu bar or right-click menus, because those are the
  system's own menus.

## Choosing an icon

- Use Looper's own icon when it shows what you mean, so your buttons match the
  ones beside them.
- A shape means one thing everywhere, so don't use one for something else while
  Looper's own shows nearby:
  - A folder is a project, and a folder with its front tipped forward (`openFolder`)
    opens a folder in Explorer.
  - A speech bubble is a chat.
  - A pencil is Edit.
  - A checklist is a task.
- Give each thing your addon has one shape, and use it for its tab and for the
  buttons that act on it.

## New commands

A command in `new` shows the icon you give it, and Looper doesn't add anything
to it. To match Looper's New buttons (a folder or a checklist with a plus at its
bottom-right corner), give it an icon that has the plus drawn in, as described
below. `"icon": "add"` is a plain plus, for when you want that instead.

## Drawing your own

`icons` in the manifest holds your own icons by name, each as the text of an SVG
file:

```json
"icons": {
  "new-key": "<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\"><circle cx=\"4\" cy=\"9.5\" r=\"2.5\"/><path d=\"m5.8 7.7 6.2-6.2M10 3.5l1.5 1.5M8.5 5l1.5 1.5\"/><path d=\"M12 9.2v5.6M9.2 12h5.6\"/></svg>"
}
```

An icon's name uses letters, digits, `.`, `_` and `-`, and can't be the name of
one of Looper's icons.

Looper's icons are line drawings in a 16 x 16 box, and yours should be too:

- Set `fill="none"` and `stroke="currentColor"` on the `<svg>`, and Looper draws
  every line 1.4 wide with round ends and joins. A `stroke-width`, `stroke-linecap`
  or `stroke-linejoin` in the file is ignored, so your lines match Looper's.
- Keep the shape between 1.5 and 14.5 on both axes, so the line isn't cut off at
  the edge of the box.
- Put straight lines and rectangle edges on .5 coordinates, so they stay sharp at
  16 px.
- Center an icon that stands alone. Line up its top with Looper's, which is at 3
  to 3.5.
- Any square `viewBox` that starts at 0 0 works, and Looper scales it to the same
  size with the same line width. The numbers here are for a 16 x 16 box.
- An `<svg>` with no `fill` or `stroke` is filled and not stroked, as in any SVG
  file.

### The plus on a New icon

The plus is the same size and in the same place on every New icon:

| | In a 16 x 16 box | In a 24 x 24 box |
|---|---|---|
| Center | 12, 12 | 18, 18 |
| Each arm, from the center | 2.8 | 4.2 |
| Path | `M12 9.2v5.6M9.2 12h5.6` | `M18 13.8v8.4M13.8 18h8.4` |
| Space to keep clear of the rest of the icon, around the center | Radius 4.3 | Radius 6.45 |

Use this plus only for New. To leave that space clear, draw the rest of the icon
toward the top-left corner, as the example above moves its key. Leave out any
part the plus would cover, instead of keeping a stub that touches it.

### What an icon's file can have

| Allowed | |
|---|---|
| Elements | `svg`, `path`, `circle`, `ellipse`, `rect`, `line`, `polyline`, `polygon`, `g`. `title`, `desc` and `metadata` are ignored. |
| Attributes | Each shape's geometry, `transform`, `fill-rule` and `clip-rule`. |
| Colors | Only `none` and `currentColor`, for `fill` and `stroke`, so an icon follows the theme and shows when it's disabled. |
| Size | Up to 8192 characters. |

Anything else makes the manifest invalid, and the error names what's wrong, such
as `icons: "vault": <image> isn't allowed`. That includes scripts, styles, links,
images, masks and text.

## A library icon only a state names

Looper loads the library icons your manifest's fields name. To name one only in
a command's state, list it in `icons` too:

```json
"icons": { "unlocked": "library:lock-open" }
```

The state can then say `"icon": "unlocked"`. A state that names an icon the
manifest doesn't have keeps the command's own icon.
