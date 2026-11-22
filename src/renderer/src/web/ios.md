# iOS 27 guidelines

What an iOS screen in Looper looks like and how it moves: the frame
(`IosFrame.tsx`, `ios.css`, `ios-bar.css`) and the pages inside it
(`phone.css`). Every screen follows iOS 27 and only iOS 27. A value from an
older iOS (the 36 x 5 grabber, the `rgba(60, 60, 67, 0.29)` separator, opaque
popovers with a hairline under each item, the screen behind a sheet shrinking
back) is a bug, even when it still looks close.

## Sources

Each value below names where it comes from:

- **kit**: Apple's iOS and iPadOS 27 UI Kit for Figma, version 27.1.4 (October
  28, 2026). A copy is in the Takt Ventures drafts (file key
  `QDnxOwi97vhi3pN36Vexae`), read through the Figma REST API with figexport's
  token (`GET /v1/files/<key>/nodes?ids=<page>`). Measure a new component there
  before building it.
- **kit log**: the kit's Change log page, which lists what changed for iOS 27.
- **tokens**: the Sketch version of the same kit (27.1.3), whose Export Design
  Tokens give the color and type tokens by name.
- **HIG**: the Human Interface Guidelines page named after it.
- **press**: MacRumors' "Here's How Liquid Glass Is Changing in iOS 27" (June
  10, 2026). Use it only where neither the kit nor the HIG says anything.
- **LG guide**: Apple's "Adopting Liquid Glass" technology overview.
- **WWDC25**: the session "Meet Liquid Glass" (WWDC25 219), for how glass
  moves; **WWDC23**: "Animate with springs" (WWDC23 10158).
- **SwiftUI**: the `Animation` reference (`default`, `smooth`, `snappy`).
- **unverified**: how iOS behaves, from use rather than a document. Keep it,
  but check it on a device before changing anything around it.

A value with no source here hasn't been checked. Measure it in the kit before
relying on it, and add it here with its source.

## What changed from iOS 26

- Liquid Glass diffuses busy content more, has a darkened edge and brighter
  highlights, and people set it anywhere from ultra clear to fully tinted
  (press). CSS can't refract, so keep the glass as the tokens below draw it.
- A uniform bar appears across the top when content scrolls under the floating
  buttons, the hard scroll edge effect (press, kit: Scroll Edge Effect - Hard).
- The grabber went from 36 x 5 to 60 x 4 (kit log).
- Alert and action sheet buttons went from medium to semibold, and the alert's
  spacing changed (kit log).
- A bar's title with a subtitle is Subheadline emphasized; the back chevron is
  semibold (kit log).
- The determinate progress bar is 4 high instead of 6 (kit log).
- Switches, sliders, steppers, segmented controls and glass buttons gained
  pressed and disabled states (kit log).

## Color

Light first, then dark (tokens, kit).

| Token | Light | Dark |
| --- | --- | --- |
| Blue (tint) | `#0088FF` | `#0091FF` |
| Red | `#FF383C` | `#FF4245` |
| Orange | `#FF8D28` | `#FF9230` |
| Yellow | `#FFCC00` | `#FFD600` |
| Green | `#34C759` | `#30D158` |
| Label | `#000000` | `#FFFFFF` |
| Secondary label | `rgba(60, 60, 67, 0.6)` | `rgba(235, 235, 245, 0.6)` |
| Tertiary label (placeholders, chevrons) | `rgba(60, 60, 67, 0.3)` | `rgba(235, 235, 245, 0.3)` |
| Label on glass | `#1A1A1A` | `#F5F5F5` |
| Secondary label on glass (a subtitle, a shortcut) | `#727272` | `#8A8A8A` |
| Placeholder and disabled on glass | `#BFBFBF` | `#404040` |
| Separator | `rgba(0, 0, 0, 0.12)` | `rgba(255, 255, 255, 0.12)` |
| Opaque separator (a list's, a menu's) | `#E6E6E6` | `#1A1A1A` |
| Fill (primary, secondary, tertiary) | `rgba(120,120,120,0.2)`, `rgba(120,120,128,0.16)`, `rgba(118,118,128,0.12)` | `rgba(120,120,128,0.36)`, `rgba(120,120,128,0.32)`, `rgba(118,118,128,0.24)` |
| Grouped background, its cells | `#F2F2F7`, `#FFFFFF` | `#000000`, `#1C1C1E` |
| Elevated (a sheet) background, its cells | `#F2F2F7`, `#FFFFFF` | `#1C1C1E`, `#2C2C2E` |

- Increased contrast uses the HIG Color page's increased-contrast values
  (blue `#1E6EF4` light, `#5CB8FF` dark). The kit dropped its own.
- Status shows as colored text or a colored symbol, never a badge (project
  rule).

## Type

SF Pro through `-apple-system`, sizes in `--u` so Dynamic Type scales them
(tokens). Emphasized is semibold (590).

| Style | Size / line | Weight |
| --- | --- | --- |
| Large Title | 34 / 41, tracking 0.4 | Bold |
| Title 1, 2, 3 | 28 / 34, 22 / 28, 20 / 25 | Regular |
| Headline, Body emphasized | 17 / 22 | Semibold |
| Body | 17 / 22, tracking -0.43 | Regular |
| Callout | 16 / 21 | Regular |
| Subheadline | 15 / 20, tracking -0.23 | Regular |
| Footnote | 13 / 18, tracking -0.08 | Regular |
| Caption 1, 2 | 12 / 16, 11 / 13 | Regular |

## Liquid Glass

- Glass is for the layer of controls and navigation that floats over the
  content: bar buttons, the tab bar, the search field, menus, alerts, action
  sheets, a medium sheet and the message box. Content (list cards, message
  bubbles) never uses it (HIG Materials). A bar's buttons stay glass inside a
  sheet too (kit: Sheet - iPhone).
- Looper's three strengths, after the kit's:
  - **Small** (bar buttons, the tab bar, the search field, the message box and
    its +): `--ios-glass`, with a faint shadow, `0 8px 15px` black at 2% (4%
    in dark), and a 0.5 pt ring of `#E8E8E8` (kit: Fill + Shadow). A darker
    shadow draws a gray band where two glass controls sit side by side, and
    glass lightens its shadow over a plain light background (WWDC25).
  - **Medium and Large** (menus, alerts, action sheets, a medium sheet):
    `--ios-glass-dense`, white at 70% in light and `#1A1A1A` in dark, with the
    shadow `0 8px 48px` at 25% (45% in dark) as `--ios-glass-lift`.
  - **Clear** (a notification over a wallpaper): highly translucent.
- Without `backdrop-filter`, glass goes nearly opaque (`@supports not` rules).

## Scroll edge effects

- **Hard**, under a top bar once the page has scrolled: white at 85% with a
  6 pt blur and a line of black at 5% (dark: black at 55%, line at 10%) (kit).
  Nothing scrolls behind Looper's top bar, so `--ios-bar` is that white over
  the page (`#fdfdfd`, dark `#050505`) and `--ios-bar-line` the line.
- **Soft**, behind the floating tab bar: a 10 pt blur under a gradient mask,
  with no color (kit). `.phone-main::after` on a tab's own screen.
- A conversation runs to the screen's bottom under its message box, as in
  Messages, with the soft edge behind the box and nothing opaque under it.
  Its end scrolls clear of the box (`--chat-dock-h`). Nothing else floats
  over the conversation: "Claude Code is working…" is its last row, as
  Messages shows its typing bubble, because a line of text over scrolling
  messages runs into theirs.
- One per view, and only behind floating controls (HIG Scroll views).

## Components

Sizes are points, which are CSS pixels.

### Navigation bar (top toolbar)

- 54 high under the status bar: the buttons at its top, 10 under them, 16
  from the sides, 10 between separate buttons (kit: Toolbar - Top - iPhone).
- Buttons are 44 x 44 glass circles holding a 17 pt medium symbol; several
  share one glass capsule, their symbols 20 apart. The confirming action is a
  tinted circle with a checkmark (kit, HIG Toolbars).
- Back is a semibold chevron alone, Close an xmark alone; never the words Back
  or Close (kit, HIG Toolbars).
- The title is 17/22 semibold, centered. With a subtitle the title is 15/20
  semibold over a 12/16 medium subtitle in secondary label on glass (kit).
- A large title is 34/41 bold, 16 from the leading edge, its subtitle 15/20
  medium (kit).
- In a sheet the bar's buttons sit 16 below the sheet's top (kit), and on iPad
  10 in from its edges (kit log).

### Tab bar

- iPhone: a glass capsule 62 high, 21 from the screen's sides and 21 from its
  bottom (kit: Tab Bar - iPhone).
- Each tab is 54 high: an 18 pt semibold symbol over a 10/12 semibold label,
  in label on glass. The selected tab sits on a capsule (`#EDEDED`, dark
  `#121212`) and takes the tint (kit). Looper's selected label is `#0062CC`,
  darker than the tint, because the tint gives 2.9:1 on the pill.
- HIG Tab bars asks for filled symbols. Looper draws the desktop's line tab
  icons instead, so the views look the same on every device (Leandro's
  choice); only More keeps filled dots.
- iPad: a 44 high glass capsule near the top, padding 4; tabs 36 high with
  18 of side padding and 15/20 medium labels, the selected one bold in the
  tint on a capsule (kit: Tab Bar - iPad).
- The tab bar stays visible when a screen is pushed; only a modal covers it
  (HIG Tab bars).

### Lists

- Inset grouped: cards 16 from the screen's edges with corner radius 26, rows
  52 high (68 with a subtitle) with their text 16 in, a separator from the
  text's start to the trailing edge (kit).
- Row title Body; a subtitle 15/20 in secondary label; a value at the trailing
  end in secondary label; the drill-in chevron 17 pt semibold in tertiary
  label; a chosen row's checkmark 17 pt semibold in label (kit).
- A section title is 17/22 semibold in secondary label, 9 above its card,
  sentence or title case, never all caps. A footer is 13/18 in secondary
  label, 8 below the card (kit: Section Title, Grouped Table Footer).
- The kit tints a row that runs a command (Row - Button) and gives a chevron
  only to a row that pushes a screen. Looper doesn't follow it on the More and
  Advanced screens, whose command rows stay in label color: tried on
  2026-11-11 and rejected as too distracting. A single action under a list
  (Add…, Reorder, Clear) is in the tint, red when it destroys something. A
  command row's label has no trailing "…" (`Command.label`).
- A collapsible section's chevron is at the trailing end of its header, in the
  tint (kit: the Disclosure accessory).
- Swipe actions are 44 high capsules in the action's color (kit).

### Text fields and search

- A field in a list is a 52 high row; its text is 17/20 medium, its
  placeholder tertiary label (kit: Text Field).
- A search field is a glass capsule, 44 high in a bar or under it and 48 at
  the bottom: the magnifier in label on glass, 17 pt medium text, the
  placeholder in placeholder on glass, the microphone in secondary label on
  glass; 11 in on the left, 10 on the right (kit: _Search).

### Segmented control

- A capsule track of `rgba(118, 118, 128, 0.12)` (dark 0.24), 32 high with 2
  of padding, segments 28 high and 4 apart (kit). A large one is 48 high.
- Labels 13.33/18, medium; the selected one semibold on a capsule of white
  (dark: white at 27%) with the shadow `0 2px 20px rgba(0, 0, 0, 0.06)` (kit).
  The target stays 44 high.
- Text or symbols, not both; at most five segments on iPhone (HIG Segmented
  controls).

### Switch

- A 64 x 28 track, off `rgba(60, 60, 67, 0.3)` (dark `rgba(235, 235, 245,
  0.3)`), on green; a 38 x 24 white knob 2 in, moving 22 (kit: Toggle -
  Switch).
- Pressed, the knob swells to a 58 x 38 glass lens; disabled, the switch is at
  50% (kit).
- Only in a list row; outside a list use a button that toggles (HIG Toggles).

### Buttons

- Every target is at least 44 x 44 (HIG Buttons).
- A content button is large (50 high), medium (34) or small (28), a capsule;
  its label is 17 pt regular (large) with 20 of side padding. Bordered is the
  tint on `rgba(118, 118, 128, 0.12)`; prominent is white on the tint (kit:
  Button - Content Area).
- One prominent button per view, two at most (HIG Buttons).

### Menus

- A glass panel (Medium) with corner radius 34, 10 of padding at the top and
  bottom (kit: Menu).
- Items 40 high, their content 22 from the menu's edge: an optional 17 pt
  symbol in a 28 wide column, 8 from the label in 17/20 regular, label on
  glass; a subtitle 13/18 in secondary label on glass; disabled in placeholder
  on glass; destructive in red; a submenu's chevron 15 pt bold in label on
  glass (kit).
- The symbol column is there only in a group with symbols or a check; a group
  of plain items starts its labels at 22 from the edge (kit: Menu, its
  Submenu rows).
- No line between items; a group ends with a 1 pt separator 24 in from each
  side with 10 above and below, and a section title is 13/15 medium in
  placeholder on glass (kit).
- A control group puts three actions in tiles above the list, 10 from the
  menu's sides and 6 apart: 56 high, corner radius 20, a symbol over one line
  of 12/18 medium that truncates. A tile has no fill until the finger is on it
  (kit: Control Group, its BG layer hidden on all but the highlighted tile).
- The kit's separator (`#E6E6E6`, dark `#1A1A1A`) and pressed tile
  (`#EDEDED`, dark `#121212`) are blended, not painted: its render gives
  `#DFDFDF` and `#343434` on `#F8F8F8` and `#1A1A1A` menus. Looper draws them
  as black at 10% and 7% in light and white at 11% and 8% in dark.
- Icons for every item in a group or for none (HIG Menus).
- A list row that picks one of a few choices is a pop-up button: the value in
  secondary label, then chevron.up.chevron.down 10 after it, never the
  disclosure chevron (kit: Lists, Type=Pop-up). Its menu opens over the
  value, lined up with its trailing edge, and opens upward from the value's
  bottom when there isn't room below (`Row`'s `popUp`, `placePopUp`).
- Behind a menu the screen dims with `rgba(41, 41, 58, 0.23)` (tokens).

### Alerts

- 300 wide, corner radius 34, padding 14, glass Large (kit: Alert).
- Title 17/22 semibold and message 17/22 regular, both in label and left
  aligned, 10 apart, 8 in from the padding and 24 above the buttons (kit).
- Buttons are 48 high capsules, 8 apart, labels 17/22 semibold: side by side
  when two short ones fit, Cancel leading; stacked otherwise, default first and
  Cancel last. The default action is the tint with white text; the rest are
  `rgba(120, 120, 128, 0.16)`; a destructive one is red text on that, never
  filled (kit, HIG Alerts, HIG Buttons).
- The screen behind dims with `rgba(41, 41, 58, 0.23)` (kit: _Overlay -
  Alerts).

### Action sheets

- The alert's panel and buttons: 300 wide, title and message, then 48 high
  capsules 8 apart with semibold labels, destructive ones red and first
  (kit: Action Sheet, HIG Action sheets).

### Sheets

- A large sheet starts right under the status bar, corner radius 38 at the
  top, the shadow `0 15px 75px rgba(0, 0, 0, 0.18)`; the screen behind only
  dims, with black at 20% (kit: Sheet - iPhone, Large).
- A sheet over another narrows the one under it to 16 in from each side and
  starts 10 lower (kit: Large (Stacked)).
- A medium sheet floats 6 from the screen's sides and bottom, glass, corner
  radius 38 at the top and 58 at the bottom (kit: Medium).
- The grabber is 60 x 4, `#CCCCCC` (dark `#333333`), 6 below the sheet's top
  (kit).
- iPad: corner radius 32, the shadow above (kit: Sheet - iPad).
- Swiping down dismisses it; with unsaved changes ask first (HIG Sheets).

### Notifications

- A banner is a glass card with corner radius 24 and 14 of padding: a 38 pt
  icon, then the title 15/17 semibold over the message 15/18 regular, 10
  apart (kit: Notification - Collapsed).

### Progress and page controls

- A determinate bar is 4 high in semantic fill and track colors, with an
  optional label inside (kit log).
- The selected page dot in label color, the others in tertiary label (kit
  log).

## Motion

iOS 27 moves as iOS 26 does: neither the kit log nor the press lists a change
to motion. `web/motion.ts` sets the springs as CSS variables (`--spring-*`,
`--spring-*-ms`) and does what CSS can't; `ios.css` and `phone.css` use them.

### Springs

Springs, not eased curves, with no bounce unless the motion is small and quick
("These types of non-bouncy springs are used in animations all over iOS";
"be cautious about using values higher than around 0.4", WWDC23).

| Spring | Duration, bounce | For |
| --- | --- | --- |
| default | 0.55, 0 | a screen pushed in, a sheet rising, the screen under a push moving aside |
| smooth | 0.35, 0 | what leaves: a screen popped, a sheet dismissed, a menu going back into its button; a row growing in or folding away |
| snappy | 0.5, 0.15 | a menu opening out of its button, a selection sliding, a chevron turning, a switch's knob, an alert, a banner |

- default is SwiftUI's `Animation.default`, "spring(response: 0.55,
  dampingFraction: 1.0)" (SwiftUI). That UIKit's push and sheets use it is
  unverified.
- snappy is SwiftUI's preset with "a small amount of bounce" (SwiftUI); its
  0.15 is unverified (Apple's pages don't give it).
- `menu-motion.ts` turns a spring into a CSS `linear()` easing that runs until
  it settles (`springEasing`). Code that removes an element after its
  animation waits for the spring to come within a pixel of its end
  (`LEAVE_MS`, `PhoneSheet`'s close).

### What moves

- Everything follows the finger and can be interrupted, and nothing makes
  people wait for it (HIG Motion, WWDC23). A gesture's end hands its speed to
  the motion that finishes it (the back swipe, a sheet dragged down).
- Glass appears by gradually bending light, not by fading (WWDC25). CSS can't
  bend light, so glass fades in with its shape.
- Glass answers a touch: it flexes and "illuminates from within as a form of
  feedback", the glow starting under the finger (WWDC25). A pressed bar button
  grows to 108%, and a glow lights where the finger is on bar buttons, the
  tab bar and the + button (`motion.ts`).
- A switch's or slider's knob turns into glass while held (LG guide, kit
  pressed states).
- A button morphs into its menu or popover: "the bubble simply pops open"
  where you tapped, and shrinks back into the button (WWDC25, LG guide). Bar
  buttons' menus, long-press menus and the message box's + menu do.
- Larger glass (a menu opened from a button) casts a deeper shadow (WWDC25):
  `--ios-glass-lift`.
- An action sheet comes out of the control that opened it, not from the
  screen's bottom (LG guide).
- A half-height sheet pulled to full height turns more opaque (LG guide).
- A pushed screen slides in from the trailing edge while the one under it
  moves a third of the way out; back reverses it, and the back swipe follows
  the finger (unverified distances). On iPad it does the same inside the
  detail column, or across the width on a tab with no list column. A row of
  the list column puts its screen in the detail column without a slide: a
  split view "installs vc as the secondary view controller"
  (UISplitViewController, showDetailViewController).
- A tap on the status bar scrolls the screen's list to its top, on UIKit's
  animation. WebKit leaves the tap to UIKit, which moves only the top
  document's scroll view, so the shell keeps 1 px of it to scroll back
  (`status-bar-tap.ts`).
- Safari's own back swipe, in a tab and in the Home Screen app, wins whenever
  there's a history entry to go back to: from the edge, or across content that
  takes no sideways drag, and the page gets no touch until it fails (WebKit:
  `ViewGestureController::canSwipeInDirection`,
  `_canStartNavigationSwipeAtLastInteractionLocation`). It is UIKit's own
  back transition over a picture of the screen under it, so the back it asks
  for shows at once, without the app playing it again (`phone-shell.tsx`,
  `data-instant-back`). Anything that takes a sideways drag sets a
  `touch-action` without `pan-x`, so the swipe leaves it alone.
- A sheet rises from the bottom and follows the finger down; what's behind
  only dims (kit).
- The selection of a segmented control, the tab bar and the iPad tab bar
  slides to the new choice rather than jumping (unverified).
- A pressed row lights at once and fades back as the finger lifts
  (unverified).
- Rows a tap adds (a group opened) grow in and push the rows below down, rows
  it removes fold away, and a chevron turns as its group opens (unverified). A
  conversation's new message rises in (unverified).
- Alerts and banners spring in and fade away; a disclosure's content fades in
  under it (unverified).
- The tab bar can shrink as content scrolls (LG guide); Looper keeps it full
  size.
- Don't add motion to frequent interactions beyond these; keep it brief (HIG
  Motion).

### Reduce Motion

Reduce Motion keeps fades and what follows a finger, and drops the rest:
springs lose their bounce, slides along x, y and z become fades, and nothing
scales, zooms or blurs in or out (HIG Accessibility; WWDC25: it "disables any
elastic properties for the material"). Screens, sheets, alerts, banners and
menus fade; selections and rows change in place.
