import { z } from 'zod';

/**
 * Addons: programs that add screens to Looper. An addon is a process Looper
 * starts from its `.looperaddon` manifest and talks to over stdin/stdout, one
 * JSON-RPC 2.0 message per line. The addon describes each screen as data
 * (the nodes below); Looper draws it with its own components, so the look
 * follows Looper's. See docs/addons.md.
 */

export const ADDON_EXT = 'looperaddon';
export const ADDON_TYPE = 'looper/addon';
/** The addon format: the manifest and the protocol together. */
export const ADDON_FORMAT = 1;

const id = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/i, 'use letters, digits, ".", "_", ":" or "-"');
/** An addon's own id names its manifest file, so it keeps to what every file system accepts. */
const addonId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, 'use letters, digits, ".", "_" or "-"');

const RunBase = {
  command: z.array(z.string().min(1)).min(1),
  /** Working directory, in the form the side it runs on uses. */
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
};

/**
 * How the addon's file says to run it. `on` is the side its program is for;
 * which WSL distro or shell runs it is the user's environment's business.
 */
export const AddonRunSchema = z.object({ on: z.enum(['wsl', 'windows']), ...RunBase }).strict();
export type AddonRun = z.infer<typeof AddonRunSchema>;
export type AddonSide = AddonRun['on'];

/** How this user runs the addon (Advanced → Addons… → Edit…): an environment from Settings → Environments, and the command. */
export const AddonLocalRunSchema = z.object({ environmentId: z.string().min(1), ...RunBase }).strict();
export type AddonLocalRun = z.infer<typeof AddonLocalRunSchema>;

type EnvironmentKind = 'local' | 'wsl' | 'windows';

/** The side a Looper environment runs programs on, from where Looper itself runs. */
export function environmentSide(kind: EnvironmentKind, host: string): AddonSide {
  if (kind === 'local') return host === 'windows' ? 'windows' : 'wsl';
  return kind;
}

/**
 * The environments (Settings → Environments) that can run an addon whose
 * program is for `side`: WSL bridges work from Windows, Windows bridges from WSL.
 */
export function environmentsFor<E extends { kind: EnvironmentKind }>(side: AddonSide, environments: E[], host: string): E[] {
  const reachable = (e: E) => e.kind === 'local' || (e.kind === 'wsl' && host === 'windows') || (e.kind === 'windows' && host === 'wsl');
  return environments.filter((e) => reachable(e) && environmentSide(e.kind, host) === side);
}

export const AddonPaneDefSchema = z.object({ id, title: z.string().min(1) }).strict();

const ParamsSchema = z.record(z.string(), z.unknown());

/**
 * A Tools menu item: it opens a window with a pane (its list, and the
 * selected item's screen beside it) or with one screen.
 */
export const AddonToolSchema = z
  .object({
    id,
    label: z.string().min(1),
    pane: id.optional(),
    view: id.optional(),
    params: ParamsSchema.optional(),
    width: z.number().int().min(320).max(2000).optional(),
    height: z.number().int().min(200).max(1400).optional(),
  })
  .strict()
  .refine((t) => !!t.pane !== !!t.view, 'give either "pane" or "view"');
export type AddonTool = z.infer<typeof AddonToolSchema>;

/** A main-toolbar button: it opens one of the addon's tools, or else sends it a `click` event. */
export const AddonMainButtonSchema = z
  .object({
    id,
    label: z.string().min(1),
    icon: z.lazy(() => z.enum(ADDON_ICONS)).optional(),
    tool: id.optional(),
  })
  .strict();
export type AddonMainButton = z.infer<typeof AddonMainButtonSchema>;

export const AddonManifestSchema = z
  .object({
    $type: z.literal(ADDON_TYPE),
    $version: z.literal(ADDON_FORMAT),
    id: addonId,
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    run: AddonRunSchema,
    panes: z.array(AddonPaneDefSchema).default([]),
    tools: z.array(AddonToolSchema).default([]),
    /** Buttons on the main toolbar, there at all times. */
    toolbar: z.array(AddonMainButtonSchema).default([]),
    /** Names the toolbar buttons in "<toolbarName> Toolbar" (View menu); the addon's name otherwise. */
    toolbarName: z.string().min(1).optional(),
  })
  .strict();
export type AddonManifest = z.infer<typeof AddonManifestSchema>;

export type ReadManifestResult =
  | { ok: true; manifest: AddonManifest }
  /** newer: a format this Looper doesn't know yet. */
  | { ok: false; reason: 'not-addon' | 'newer' | 'invalid'; error?: string };

/** Check parsed `.looperaddon` content: the envelope first, so a newer format reads as such. */
export function readAddonManifest(input: unknown): ReadManifestResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, reason: 'not-addon' };
  const obj = input as Record<string, unknown>;
  if (obj.$type !== ADDON_TYPE) return { ok: false, reason: 'not-addon' };
  if (typeof obj.$version === 'number' && obj.$version > ADDON_FORMAT) return { ok: false, reason: 'newer' };
  const parsed = AddonManifestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid', error: zodSummary(parsed.error) };
  const ids = new Set<string>();
  for (const p of parsed.data.panes) {
    if (ids.has(p.id)) return { ok: false, reason: 'invalid', error: `panes: duplicate id "${p.id}"` };
    ids.add(p.id);
  }
  const toolIds = new Set<string>();
  for (const t of parsed.data.tools) {
    if (toolIds.has(t.id)) return { ok: false, reason: 'invalid', error: `tools: duplicate id "${t.id}"` };
    toolIds.add(t.id);
    if (t.pane && !ids.has(t.pane)) return { ok: false, reason: 'invalid', error: `tools: "${t.id}" names no pane "${t.pane}"` };
  }
  const buttonIds = new Set<string>();
  for (const b of parsed.data.toolbar) {
    if (buttonIds.has(b.id)) return { ok: false, reason: 'invalid', error: `toolbar: duplicate id "${b.id}"` };
    buttonIds.add(b.id);
    if (b.tool && !toolIds.has(b.tool)) return { ok: false, reason: 'invalid', error: `toolbar: "${b.id}" names no tool "${b.tool}"` };
  }
  return { ok: true, manifest: parsed.data };
}

/** The first few issues as `path: message` lines. */
export function zodSummary(err: z.ZodError): string {
  return err.issues
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

/** In `run.command`, `run.cwd` and `run.env`: the folder the `.looperaddon` file was installed from. */
export const ADDON_DIR_VAR = '${addonDir}';

export const usesAddonDir = (run: AddonRun): boolean => JSON.stringify(run).includes(ADDON_DIR_VAR);

/** `run` with ADDON_DIR_VAR replaced by `dir`, a path in the form the side the addon runs on uses. */
export function withAddonDir(run: AddonRun, dir: string): AddonRun {
  const sub = (s: string) => s.split(ADDON_DIR_VAR).join(dir);
  return {
    ...run,
    command: run.command.map(sub),
    ...(run.cwd ? { cwd: sub(run.cwd) } : {}),
    ...(run.env ? { env: Object.fromEntries(Object.entries(run.env).map(([k, v]) => [k, sub(v)])) } : {}),
  };
}

/** A command as one line, quoting the arguments that need it. */
export function runCommand(run: { command: string[] }): string {
  return run.command.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/** "WSL" or "Windows": the side an addon's program is for, as the UI names it. */
export const sideName = (side: AddonSide): string => (side === 'wsl' ? 'WSL' : 'Windows');

/** "a", "a and b", "a, b and c". */
function listText(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** What installing the addon adds to Looper, one line per place, for the install confirmation. */
export function addonAdditions(m: Pick<AddonManifest, 'panes' | 'toolbar' | 'tools'>): string[] {
  const lines: string[] = [];
  const panes = m.panes.map((p) => p.title);
  if (panes.length) lines.push(`${panes.length === 1 ? 'A ' : ''}${listText(panes)} pane${panes.length === 1 ? '' : 's'} in the sidebar`);
  const buttons = m.toolbar.map((b) => b.label);
  if (buttons.length) lines.push(`${buttons.length === 1 ? 'A ' : ''}${listText(buttons)} button${buttons.length === 1 ? '' : 's'} on the toolbar`);
  const tools = m.tools.map((t) => `${t.label}…`);
  if (tools.length) lines.push(`${listText(tools)} in the Tools menu`);
  return lines;
}

// ---------- Screens ----------

const ButtonSchema = z
  .object({
    id,
    label: z.string().min(1),
    primary: z.boolean().optional(),
    danger: z.boolean().optional(),
    disabled: z.boolean().optional(),
    /** Asked in a Yes/No dialog first; No sends nothing. */
    confirm: z.string().min(1).optional(),
  })
  .strict();
export type AddonButton = z.infer<typeof ButtonSchema>;

const PropSchema = z
  .object({
    label: z.string().min(1),
    value: z.string().optional(),
    mono: z.boolean().optional(),
    /** A Copy button for the value. */
    copy: z.boolean().optional(),
    /** Muted text after the value, such as how long it stays valid. */
    note: z.string().optional(),
    /**
     * The value is a secret the addon keeps: the row shows dots, its Show check box asks the
     * addon for it (a `reveal` event with this id) and Copy has the addon's
     * value copied without it passing through the screen (a `copy` event).
     */
    secret: id.optional(),
  })
  .strict();
export type AddonProp = z.infer<typeof PropSchema>;

const FieldSchema = z
  .object({
    type: z.literal('field'),
    id,
    label: z.string().min(1),
    input: z.enum(['text', 'password', 'textarea', 'number', 'checkbox', 'select', 'file']),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).optional(),
    placeholder: z.string().optional(),
    /** A unit shown inside the input, at its right ("s", "min"). */
    suffix: z.string().min(1).optional(),
    /** `file`: the kinds of file Browse… offers, such as `{ label: 'CSV files', extensions: ['csv'] }`. */
    accept: z
      .array(z.object({ label: z.string().min(1), extensions: z.array(z.string().min(1)).min(1) }).strict())
      .optional(),
    /** The window's primary button stays off while this is empty. */
    required: z.boolean().optional(),
    autofocus: z.boolean().optional(),
  })
  .strict();
export type AddonField = z.infer<typeof FieldSchema>;

export type AddonNode =
  | { type: 'props'; items: AddonProp[] }
  | { type: 'text'; text: string; muted?: boolean }
  | { type: 'markdown'; text: string }
  | { type: 'infobar'; title: string; message: string; button?: AddonButton }
  | { type: 'buttons'; items: AddonButton[] }
  | AddonField
  | { type: 'row'; items: AddonField[] }
  | { type: 'section'; title: string; body: AddonNode[] }
  /** Looper's tab control: one tab's body shows at a time, and the selected tab outlasts redraws. */
  | { type: 'tabs'; id: string; items: { id: string; title: string; body: AddonNode[] }[] }
  | { type: 'footer'; primary: AddonButton; apply?: AddonButton };

export const AddonNodeSchema: z.ZodType<AddonNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('props'), items: z.array(PropSchema) }).strict(),
    z.object({ type: z.literal('text'), text: z.string(), muted: z.boolean().optional() }).strict(),
    z.object({ type: z.literal('markdown'), text: z.string() }).strict(),
    z
      .object({ type: z.literal('infobar'), title: z.string().min(1), message: z.string(), button: ButtonSchema.optional() })
      .strict(),
    z.object({ type: z.literal('buttons'), items: z.array(ButtonSchema) }).strict(),
    FieldSchema,
    z.object({ type: z.literal('row'), items: z.array(FieldSchema) }).strict(),
    z.object({ type: z.literal('section'), title: z.string().min(1), body: z.array(AddonNodeSchema) }).strict(),
    z
      .object({
        type: z.literal('tabs'),
        id,
        items: z
          .array(z.object({ id, title: z.string().min(1), body: z.array(AddonNodeSchema) }).strict())
          .min(1)
          .refine((items) => new Set(items.map((t) => t.id)).size === items.length, 'tab ids must differ'),
      })
      .strict(),
    z.object({ type: z.literal('footer'), primary: ButtonSchema, apply: ButtonSchema.optional() }).strict(),
  ]),
) as z.ZodType<AddonNode>;

/** The icons a toolbar button can show: Looper's own, so they match its toolbar. */
export const ADDON_ICONS = [
  'add',
  'edit',
  'delete',
  'copy',
  'refresh',
  'open',
  'folder',
  'terminal',
  'run',
  'stop',
  'pause',
  'key',
  'lock',
  'search',
  'settings',
] as const;
export type AddonIconName = (typeof ADDON_ICONS)[number];

/** `needsItem`: in a pane window, off while no item is selected, and the event carries the selected one. */
const MenuItemSchema = z.union([
  z
    .object({
      id,
      label: z.string().min(1),
      enabled: z.boolean().optional(),
      confirm: z.string().min(1).optional(),
      needsItem: z.boolean().optional(),
      /** Set: the item shows a check mark when true. */
      checked: z.boolean().optional(),
      /** With `checked`: a bullet instead, for one choice among the items next to it. */
      radio: z.boolean().optional(),
    })
    .strict(),
  z.object({ separator: z.literal(true) }).strict(),
]);
export type AddonMenuItem = z.infer<typeof MenuItemSchema>;

/**
 * Whether a menu-bar item or pane-window toolbar button is available for the
 * selected pane item. One with `needsItem` follows the item's own menu: the
 * entry with its id gives its `enabled`, and with no such entry it's off. An
 * item without a menu leaves it on.
 */
export function commandOn(command: { id: string; needsItem?: boolean }, item: { menu?: AddonMenuItem[] } | undefined): boolean {
  if (!command.needsItem) return true;
  if (!item) return false;
  if (!item.menu) return true;
  const own = item.menu.find((m) => 'id' in m && m.id === command.id);
  return own !== undefined && 'id' in own && (own.enabled ?? true);
}

/** A window's menu bar: its menus, left to right. `&` in a label marks its access key. */
const MenuBarSchema = z.array(z.object({ label: z.string().min(1), items: z.array(MenuItemSchema) }).strict());
export type AddonMenuBar = z.infer<typeof MenuBarSchema>;

const ToolbarItemSchema = z.union([
  z
    .object({
      id,
      /** Shown after the icon; with `iconOnly`, the button's tooltip and accessible name. */
      label: z.string().min(1),
      icon: z.enum(ADDON_ICONS).optional(),
      /** Show only the icon, for commands users know by it (Refresh, Settings). */
      iconOnly: z.boolean().optional(),
      disabled: z.boolean().optional(),
      confirm: z.string().min(1).optional(),
      needsItem: z.boolean().optional(),
    })
    .strict()
    .refine((t) => !t.iconOnly || t.icon, { message: '"iconOnly" needs an "icon"', path: ['iconOnly'] }),
  z.object({ separator: z.literal(true) }).strict(),
]);
export type AddonToolbarItem = z.infer<typeof ToolbarItemSchema>;

export const AddonScreenSchema = z
  .object({
    title: z.string().optional(),
    /** Its buttons join the window's toolbar while the screen shows (the main window's after Looper's own). */
    toolbar: z.array(ToolbarItemSchema).optional(),
    /** The menu bar of a window this screen fills (ignored in the main window). */
    menuBar: MenuBarSchema.optional(),
    body: z.array(AddonNodeSchema),
    /** Draw the screen again this often while it shows (a countdown, a live value). */
    refreshSec: z.number().min(1).optional(),
  })
  .strict();
export type AddonScreen = z.infer<typeof AddonScreenSchema>;

// ---------- Panes ----------


export const AddonPaneItemSchema = z
  .object({
    id,
    label: z.string().min(1),
    description: z.string().optional(),
    /** The screen the main window shows while the item is selected. */
    view: id,
    params: ParamsSchema.optional(),
    /** Its right-click menu. */
    menu: z.array(MenuItemSchema).optional(),
    /** Shown dimmed, like a disabled task. */
    dimmed: z.boolean().optional(),
    /** Items with the same group show under a collapsible heading with that name, in the order the groups first appear. */
    group: z.string().min(1).optional(),
    /** More text the pane's search matches, beyond the label, description and group. */
    keywords: z.string().optional(),
  })
  .strict();
export type AddonPaneItem = z.infer<typeof AddonPaneItemSchema>;

export const AddonPaneContentSchema = z
  .object({
    items: z.array(AddonPaneItemSchema),
    /** The pane header's right-click menu (Looper adds Hide Pane after it). */
    menu: z.array(MenuItemSchema).optional(),
    /** In a pane window (Tools menu): its toolbar and menu bar. */
    toolbar: z.array(ToolbarItemSchema).optional(),
    menuBar: MenuBarSchema.optional(),
    /** Shown instead of the list when it has no items. */
    empty: z.string().optional(),
    /** A search box above the list; Looper filters the items as the user types. */
    search: z.object({ placeholder: z.string().min(1).optional() }).strict().optional(),
  })
  .strict();
export type AddonPaneContent = z.infer<typeof AddonPaneContentSchema>;

const WORD = /[^\p{L}\p{N}]+/u;

/**
 * A pane's search, as the Windows Search box guidelines have it: matching is
 * by word prefix, in any case, and with several words an item matches when
 * any of them starts a word of its label, description, group or keywords.
 */
export function matchesSearch(item: AddonPaneItem, query: string): boolean {
  const typed = query.toLowerCase().split(WORD).filter(Boolean);
  if (!typed.length) return true;
  const words = [item.label, item.description, item.group, item.keywords]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .split(WORD)
    .filter(Boolean);
  return typed.some((t) => words.some((w) => w.startsWith(t)));
}

// ---------- Events ----------

export type AddonEventKind = 'click' | 'open' | 'menu' | 'reveal' | 'copy';

/** `toolbar`: one of the addon's main-toolbar buttons (manifest `toolbar`). */
export type AddonEventSource =
  | { pane: string }
  | { view: string; params: Record<string, unknown> }
  | { toolbar: 'main' };

/** What Looper sends with the `event` method. */
export interface AddonEvent {
  source: AddonEventSource;
  kind: AddonEventKind;
  /** The button, menu item, secret, or (open) pane item. */
  id: string;
  /** The pane item a menu was opened on. */
  item?: string;
  /** The screen's field values, by field id. */
  values?: Record<string, string | number | boolean>;
}

export const AddonActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('openWindow'),
      view: id,
      params: ParamsSchema.optional(),
      title: z.string().min(1),
      width: z.number().int().min(320).max(2000).optional(),
      height: z.number().int().min(200).max(1400).optional(),
      /** Block the window it was opened from until it closes. */
      modal: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('closeWindow') }).strict(),
  z.object({ type: z.literal('refresh') }).strict(),
  z
    .object({
      type: z.literal('message'),
      kind: z.enum(['info', 'warning', 'error']).default('info'),
      message: z.string().min(1),
      detail: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('copy'), text: z.string() }).strict(),
  z.object({ type: z.literal('select'), pane: id, item: id }).strict(),
]);
export type AddonAction = z.infer<typeof AddonActionSchema>;

export const AddonEventResultSchema = z
  .object({
    actions: z.array(AddonActionSchema).optional(),
    /** A `reveal` or `copy` event's secret. */
    value: z.string().optional(),
    /** New values for the screen's fields, by field id. */
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();
export type AddonEventResult = z.infer<typeof AddonEventResultSchema>;

// ---------- What the renderer sees ----------

export type AddonStatus = 'starting' | 'running' | 'stopped';

export interface AddonInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** describeRun of its manifest. */
  run: string;
  panes: { id: string; title: string }[];
  tools: AddonTool[];
  toolbar: AddonMainButton[];
  toolbarName?: string;
  /** How its manifest says to run it. */
  ownRun: AddonRun;
  /** How this user changed that (Advanced → Addons… → Edit…), if they did. */
  localRun?: AddonLocalRun;
  /** The environment it runs in; unset while no environment runs programs on its side. */
  environmentId?: string;
  /** The environment it runs in without the user's change. */
  defaultEnvironmentId?: string;
  /** Off: stopped in the Addons window; it stays stopped and shows nothing until started there. */
  enabled: boolean;
  status: AddonStatus;
  /** Why it stopped: its exit and the last lines it wrote to stderr. */
  error?: string;
}

/** Key of an addon pane in the view settings and the sidebar. */
export const addonPaneKey = (addonId: string, paneId: string): string => `${addonId}/${paneId}`;

export type AddonUiEvent =
  | { type: 'addons'; addons: AddonInfo[] }
  /** Draw the addon's panes and screens again. */
  | { type: 'refresh'; addonId: string }
  /** Select a pane item, in the window the action came from (or the one that opened it). */
  | { type: 'select'; addonId: string; pane: string; item: string };

// ---------- Engine log sources ----------

export type EngineLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The Engine Log window's source for lines that aren't an addon's. */
export const ENGINE_LOG_LOOPER = 'looper';
export const engineLogAddonSource = (addonId: string): string => `addon:${addonId}`;

const ADDON_LINE = /^addon ([a-z0-9][a-z0-9._-]*)(?: stderr)?:/i;

/** Who wrote an engine log message: an addon (its lines start "addon <id>:" or "addon <id> stderr:") or Looper. */
export function engineLogSource(message: string): string {
  const m = ADDON_LINE.exec(message);
  return m ? engineLogAddonSource(m[1]) : ENGINE_LOG_LOOPER;
}
