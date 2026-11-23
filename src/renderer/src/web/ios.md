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
- **SwiftUI**: the reference page named after it: `Animation` (`default`,
  `smooth`, `snappy`), `ToolbarItemPlacement` and its placements,
  `ToolbarSpacer`, `sharedBackgroundVisibility`, `tabBarMinimizeBehavior`,
  `tabViewBottomAccessory`, `searchToolbarBehavior`.
- **UIKit**: the reference page named after it (`UIToolbar`,
  `UIBarButtonItem` `sharesBackground` and `hidesSharedBackground`,
  `UITabBarController` `bottomAccessory`, `inputAccessoryView`).
- **WWDC25 284, 323, 356**: "Build a UIKit app with the new design", "Build a
  SwiftUI app with the new design" and "Get to know the new design system",
  for bars, toolbars, the tab bar and search. Copies of these pages and
  transcripts, and of the HIG pages, are in `scratch/ios-toolbars/sources/`.
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

The messages in the Overview's cards (phones and tablets) are 14 / 19, tracking
-0.15, by Leandro's choice: iOS has no 14 pt style, so this sits between
Subheadline (15 / 20, -0.23) and Footnote (13 / 18, -0.08). A small card's text
in Focus's row is Footnote.

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

- A page runs under its top bar to the screen's top, and the bar has no
  background: "Large titles are now placed at the top of the content scroll
  view, and scroll with the content underneath the bar. To keep the large title
  visible, extend the scroll view fully under the navigationBar"; "the bar
  background is now transparent by default. Remove any background
  customization from your navigation and toolbars" (WWDC25 284). The page's
  content starts below the bar (`--looper-bar-h`, which the frame sets) and
  its scrollers carry it under the bar (`phone.css`, the `::before` of a
  `.phone-page`'s or an editor's `.pg-scroll` and `.chat-scroll`). Any
  other page starts below the bar, which then takes the page's top color.
- **Hard**, under a top bar once the page has scrolled under it: white at 85%
  with a 6 pt blur and a line of black at 5% (dark: black at 55%, line at 10%)
  (kit), `--ios-edge-hard` on the bar's `::before`. "All scroll views
  underneath navigation or toolbars automatically apply a visual treatment"
  (WWDC25 284). It's the hard one because the bar then shows its title, text
  outside the glass: the automatic style "provides a more opaque visual
  separation for top toolbars that contain ... text that appears outside of
  Liquid Glass controls" (HIG Scroll views). An iPad's split bar has one per
  column, the bar's full height: "each pane can have its own scroll edge
  effect; in this case, keep them consistent in height" (HIG Scroll views).
  The bar's glass buttons don't blur again over it. Over a page that starts
  below the bar nothing passes behind it, so `--ios-bar` is that white drawn
  opaque (`#fdfdfd`, dark `#050505`) and `--ios-bar-line` the line.
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
  The bar's two sides take the wider one's width (`--ios-bar-side`, set by
  `IosBarRow`), so the title stays centered on the screen whatever Back and the
  buttons at the end hold, and is cut when it doesn't fit, never moved.
- A large title is 34/41 bold, 16 from the leading edge, its subtitle 15/20
  medium (kit). It's the first thing in the page's scroller and scrolls under
  the bar with the content: "By default, a large title transitions to a
  standard title as people begin scrolling the content, and transitions back
  to large when people scroll to the top" (HIG Toolbars). The bar's title shows
  once the page has scrolled at all, with the scroll edge effect, and goes back
  at the top.
- In a sheet the bar's buttons sit 16 below the sheet's top (kit), and on iPad
  10 in from its edges (kit log).
- Where an item goes (SwiftUI, `ToolbarItemPlacement`): `navigation` and
  `cancellationAction` at the leading edge; `primaryAction`,
  `confirmationAction`, `destructiveAction` and `automatic` at the trailing
  edge; `principal` "in the center of the navigation bar. This item takes
  precedent over a title", for "key units of functionality", such as "the
  location field for a web browser".
- One key action (Done, Submit) is the prominent style: "This separates and
  tints the action so there’s a clear focal point. Only specify one primary
  action, and put it on the trailing side of the toolbar" (HIG Toolbars).
- No bar background: "Remove any background customization from your
  navigation and toolbars" (WWDC25 284); see Scroll edge effects.

### Status bar

What Safari draws behind the status bar, in a tab and in the Home Screen app,
is WebKit's (read in its source, main of November 2026), not a setting of the
page:

- It fills that area with the background color of the fixed element at the
  top of the page and blurs it when there's none, and that blur reaches down
  over the bar's buttons. WebKit hit-tests the middle of the top edge, 4 px
  down, in the top document only, and takes the first fixed or sticky element
  there over 10 px tall and 90% of the width
  (`LocalFrameView::fixedContainerEdges`,
  `PageColorSampler::fixedContainerSampleRectMargin`); with one, it shows a
  color extension view in that color and hides the soft top blur
  (`WKWebView _updateFixedColorExtensionViews`, `_shouldHideTopScrollPocket`).
  A color under 75% opacity is blended over the page's background, a higher
  one made opaque (`PageColorSampler::finishedFixedContainerColor`).
- It samples only when the page loads, when a fixed element comes or goes
  (`WebPage::didAddOrRemoveViewportConstrainedObjects`) or when the insets
  change, never because a color changed. On an iPad the top isn't sampled
  again once the person has scrolled or touched the page
  (`Page::canSampleTopFixedContainerEdge`;
  `TopContentInsetBackgroundCanChangeAfterScrolling` is on only for the small
  screen idiom), and the iPad's hard top pocket is drawn solid in the color
  last sampled.
- So the served page starts with a fixed strip at the top (`pwa.ts`,
  `.ios-top-edge`), and the frame puts a new one in each time what the
  screen shows there changes: the page under the bar, the scroll edge effect,
  a sheet's or alert's dimming, the dark theme (`IosFrame`
  `screenTopColor`, `top-bar.ts` `paintTopEdge`). The strip has no
  transition, so WebKit never keeps a color halfway.
- `theme-color` is read from the top document only (`Page::themeColor`); WebKit
  only hands it to Safari, which no WebKit code uses for this area. The frame
  sets it to the same color.
- `apple-mobile-web-app-status-bar-style` stays unset: "If set to default or
  black, the web content is displayed below the status bar. If set to
  black-translucent, the web content is displayed on the entire screen,
  partially obscured by the status bar" (Apple, Supported Meta Tags). Under
  black-translucent iOS 26 blurred the top ~110 pt of the Home Screen app
  (unverified beyond Looper's own test on a phone).
- Playwright's WebKit draws no status bar: what it shows there is confirmed
  only on a device.

### Bottom toolbar

- Commands that act on what the screen shows go in a toolbar at its bottom:
  "If you need to provide controls that act on elements in the current view,
  use a Toolbars instead" (HIG Tab bars). Never in the tab bar or its
  accessory: "Avoid placing screen-specific actions here—a checkout button, for
  example, belongs with the content it supports" (WWDC25 356).
- It floats over the content as glass, with no background of its own: "Don’t
  apply custom backgrounds or appearances to UIToolbar" (UIToolbar). The
  content runs under it to the bottom edge, scrolls clear of it, and has a
  scroll edge effect behind it: "All scroll views underneath navigation or
  toolbars automatically apply a visual treatment" (WWDC25 284).
- Grouping: "By default, bar button items using images share the background
  with other image buttons ... Text buttons, the system “Done” and “Close”
  buttons, and prominent style buttons have separate glass backgrounds"; a
  fixed space splits a group; "each flexibleSpace item separates the
  background between items" (WWDC25 284; UIToolbar, "Split the toolbar's
  shared background"). `sharesBackground` false or `hidesSharedBackground`
  puts an item in a group of its own (UIBarButtonItem).
- "Be sure to not group symbols with text, like “Select” and the share icon"
  (WWDC25 356); "Keep actions with text labels separate" (HIG Toolbars).
- Group by function and frequency, and "aim for a maximum of three" groups
  (HIG Toolbars).
- A toggle that's on keeps its plain glass button and tints its symbol:
  "Only the Flag symbol will get colored. To tint the button background, set
  the style to prominent" (WWDC25 284). The tinted circle is only the
  confirming action's (Navigation bar).
- Status: informational text between the two ends. "Status items are
  informational in nature, and don't represent an action ... In iOS and
  iPadOS, the system places status items in the center of the bottom toolbar"
  (SwiftUI `status`). No saved source gives its type: Looper uses Footnote
  13/18 in secondary label (unverified).
- With text outside the glass (a status) the edge behind it is the hard one:
  the automatic style "provides a more opaque visual separation for top
  toolbars that contain ... text that appears outside of Liquid Glass
  controls" (HIG Scroll views, said of top toolbars; applied here to the
  bottom one). Under
  glass buttons alone it's the soft one (WWDC25 356: "Soft is the default").
- Its buttons are the navigation bar's: 44 x 44 glass circles, several in one
  capsule, 16 from the sides and 10 apart (kit: Toolbar - Top - iPhone; the
  kit's bottom toolbar hasn't been measured). It sits 21 above an iPhone's
  home indicator, where the tab bar sits (kit: Tab Bar - iPhone; unverified
  for the toolbar).
- Too many items: on iPhone "Create a More menu to include additional items"
  (HIG Toolbars, iOS).
- Material 3's counterpart is the floating toolbar (components.md,
  BottomToolbar). Looper draws both with `BottomToolbar`.

### iPad toolbar

- Three areas: the leading edge (Back, the sidebar button, the title, a
  document menu; not customizable), the center (common controls; people can
  customize them, and they collapse into the overflow menu as the window
  narrows), the trailing edge (items that must stay, inspectors, search, the
  More menu and the primary action; "visible at all window sizes") (HIG
  Toolbars, Item groupings).
- Overflow is the system's: "The system automatically adds an overflow menu
  in macOS or iPadOS when items no longer fit. Don’t add an overflow menu
  manually" (HIG Toolbars).
- Customization: "In iPadOS and macOS apps, consider letting people
  customize the toolbar" (HIG Toolbars); "Only secondaryAction items support
  customization in iPadOS" (SwiftUI `toolbar(id:content:)`); with
  customization the system "places items in the center of the navigation bar"
  (SwiftUI `automatic`).
- "a toolbar and a Tab bars can coexist in the same horizontal space at the
  top of the view" (HIG Toolbars, iPadOS).

### Split view columns

- Each column has its own bar and its own scroll edge effect: "In split view
  layouts on iPad and Mac, each pane can have its own scroll edge effect; in
  this case, keep them consistent in height to maintain alignment" (HIG
  Scroll views).
- Search for a split view is at the trailing edge of the navigation bar:
  "This is ideal for split views" (WWDC25 284).
- A bottom toolbar of one column: not covered by a saved source. Looper draws
  it in the column whose content it acts on (the inspector's Now).

### Floating controls

- Controls that float over a scroll view's edge get the edge effect too:
  "This new edge effect isn’t just for system bars ... two buttons overlaying
  the bottom edge of the scroll view" (WWDC25 284,
  `ScrollEdgeElementContainerInteraction`). "For denser UIs with a lot of
  floating elements, opt in to a hard edge style" (WWDC25 284).
- "Only use a scroll edge effect when a scroll view is behind floating
  interface elements" (HIG Scroll views).

### Keyboard accessory bar

- Controls for the text being typed go above the keyboard: "keyboard items
  are above the software keyboard when present, or at the bottom of the
  screen when a hardware keyboard is attached" (SwiftUI `keyboard`;
  UIKit `inputAccessoryView`).
- "make sure they’re relevant to the current task ... If you use a standard
  toolbar to contain your controls, it automatically adopts Liquid Glass"
  (HIG Virtual keyboards).

### Selection mode

- Not covered: no saved source says what a toolbar holds while items are
  selected. `EditButton` only says the Edit button "displays the title
  “Done” while edit mode is active" (SwiftUI). Read Apple's pages before
  building one.

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
- It navigates and never acts: "Use a tab bar to support navigation, not to
  provide actions" (HIG Tab bars); actions are the bottom toolbar's.
- It can minimize on scroll: "set tabBarMinimizeBehavior to the desired
  direction ... The tab bar re-expands when scrolling in the opposite
  direction" (WWDC25 284), and "A person can exit the minimized state by
  tapping a tab or scrolling to the top of the view" (HIG Tab bars). Looper
  keeps it full size (Motion).
- A bottom accessory sits above it for a persistent feature, "like the mini
  player in the Music app ... When the tab bar is minimized, the accessory
  view animates down to display inline with the tab bar" (WWDC25 284;
  UITabBarController `bottomAccessory`, SwiftUI `tabViewBottomAccessory`).
- A search tab sits at its trailing end (HIG Tab bars); selected, "a search
  field takes the place of the tab bar" (WWDC25 323). The standard style
  opens a search page with suggestions; the button style "brings focus to the
  search field and displays the keyboard" (HIG Search fields).

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
- Where search goes on iPhone: "As a tab in a tab bar; In a toolbar at the
  bottom or top of the screen; Directly inline with content" (HIG Search
  fields).
- "Place search at the bottom if there’s room", in the bottom toolbar "either
  as an expanded field or as a toolbar button, depending on how much space is
  available"; tapped, "it animates into a search field above the keyboard"
  (HIG Search fields; WWDC25 284). `searchToolbarBehavior(.minimized)` asks for
  the button (SwiftUI).
- At the top "when itʼs important to defer to content at the bottom of the
  screen, or thereʼs no bottom toolbar", as a bar button (HIG Search fields).
- Inline above the list it filters, when it searches only that list; "consider
  pinning it to the top toolbar when scrolling" (HIG Search fields).
- iPad: "at the trailing side of the toolbar for many common uses", or "at the
  top of the sidebar when filtering content or navigation there" (HIG Search
  fields).

### Segmented control

- A capsule track of `rgba(118, 118, 128, 0.12)` (dark 0.24), 32 high with 2
  of padding, segments 28 high and 4 apart (kit). A large one is 48 high.
- Labels 13.33/18, medium; the selected one semibold on a capsule of white
  (dark: white at 27%) with the shadow `0 2px 20px rgba(0, 0, 0, 0.06)` (kit).
  The target stays 44 high.
- Text or symbols, not both; at most five segments on iPhone (HIG Segmented
  controls).
- **Tabs that don't fit.** A screen whose tabs lead to long, separate views (the
  Activity sheet's Now, Background, Subagents, Files, Git) asks TabBar for
  `overflow: 'sections'`: when they don't fit as a segmented control (more than
  five, or labels wider than their segment), they are the list of rows of a
  Settings page, with chevrons and the counts in the titles ("Background (2)"),
  and a row opens its view under a bar whose Back returns to the list. When they
  fit, the segmented control stays. Reason: a pop-up button hides the choices
  behind a tap and gives no place to return to, and each of these views already
  pushes its own details, so a push stack of list, tab, detail is the one a
  person knows from Settings (HIG Lists and tables; HIG Pop-up buttons: for "a
  flat list of mutually exclusive options" when space is limited, which these
  are not: each is a destination). The bars' Back, the edge swipe and Safari's
  back are one path: detail, tab, list. A screen that has no such destinations
  keeps the pop-up button.

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
- Only a sheet that resizes has a grabber: "Include a grabber in a resizable
  sheet. A grabber shows people that they can drag the sheet to resize it;
  they can also tap it to cycle through the detents" (HIG Sheets), and
  UIKit's `prefersGrabberVisible` is false unless set. A sheet with one
  height (an editor, Preview, a file sheet) has none, still closes with a
  swipe down, and keeps its bar's buttons 16 below its top. Looper's
  grabber is a button: a tap, or VoiceOver's activation, moves the sheet to
  its other height (`PhoneSheet`; `npm run ui-check`, grabber rules).
- iPad: corner radius 32, the shadow above (kit: Sheet - iPad).
- A large sheet's content runs to the screen's bottom edge, under the home
  indicator, and its scroller pads its end by the safe area, so the last line
  still scrolls above the indicator; nothing pads the sheet itself, which
  showed the card's gray as a band under Preview's page (`--viewer-end` in
  ios.css for the shell's own sheets, `--looper-safe-bottom` for a window's
  page). A floating iPad sheet has no inset.
- Swiping down dismisses it; with unsaved changes ask first (HIG Sheets).
- Its top bar: "for sheets with a single view, the Cancel button belongs on
  the leading edge of the top toolbar. When present, the Done button belongs
  on the trailing edge" (HIG Sheets; SwiftUI `cancellationAction`,
  `confirmationAction`). Done always comes with Cancel or Back, and "Avoid
  showing all three buttons — Cancel, Done, and Back — together" (HIG
  Sheets).

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
  (`status-bar-tap.ts`). It reaches the first item every time: a list that
  draws its items in parts (a conversation's older messages) is scrolled
  through what's drawn without adding older items, then draws its first items
  at the top (`scroll-top.ts`), and a finger on the screen stops it.
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
