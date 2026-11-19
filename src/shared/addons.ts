import { z } from 'zod';
import { parseSvgIcon } from './addon-icons';
import { noMnemonic } from './commands/command';
import { REPORT_INPUT, issueLines } from './issues';
import { LOOPER_KEYS, hint, keyId } from './shortcuts';
import { UI_PLATFORMS } from './ui-platform';

/**
 * Addons: programs that add screens to Looper. An addon is a process Looper
 * starts from its `.looperaddon` manifest and talks to over stdin/stdout, one
 * JSON-RPC 2.0 message per line. The addon describes each screen as data
 * (the nodes below); Looper draws it with its own components, so the look
 * follows Looper's. See docs/addons.md.
 */

export const ADDON_TYPE = 'looper/addon';
/** The addon format: the package, the manifest and the protocol together. */
export const ADDON_FORMAT = 2;

const id = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/i, 'use letters, digits, ".", "_", ":" or "-"');
/** An addon's own id names its manifest file, so it keeps to what every file system accepts. */
const addonId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, 'use letters, digits, ".", "_" or "-"');

/** Where an item shows: 'desktop' (Looper's windows), 'web' (a desktop browser), 'mobile' (phones and tablets); unset: everywhere. */
const platforms = z
  .array(z.enum(UI_PLATFORMS))
  .min(1)
  .refine((p) => new Set(p).size === p.length, 'list each platform once')
  .optional();

const RunBase = {
  command: z.array(z.string().min(1)).min(1),
  /** Working directory, in the form the side it runs on uses. */
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
};

/**
 * How the addon's file says to run it. `on` is the side its program is for;
 * which WSL distro or shell runs it is the user's environment's business.
 * `looper`: a JavaScript program Looper runs with its own Node (Looper's
 * executable with ELECTRON_RUN_AS_NODE), on the side Looper itself runs, with
 * no environment; `command` is the script and its arguments, such as
 * `["${addonDir}/addon.js"]`.
 */
export const AddonRunSchema = z.object({ on: z.enum(['wsl', 'windows', 'looper']), ...RunBase }).strict();
export type AddonRun = z.infer<typeof AddonRunSchema>;
/** The sides an environment runs programs on; a `looper` addon needs none. */
export type AddonSide = Exclude<AddonRun['on'], 'looper'>;

/** How this user runs the addon (Advanced → Addons… → Edit…): an environment from Settings → Environments (none for a `looper` addon), and the command. */
export const AddonLocalRunSchema = z.object({ environmentId: z.string().min(1).optional(), ...RunBase }).strict();
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

/** What an icon field names in Looper's library: its name after this. */
export const ICON_LIBRARY = 'library:';
const OWN_ICON_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** One of ADDON_ICONS, one of the manifest's `icons`, or "library:<name>" (readAddonManifest checks it's one). */
const iconName = z.string().regex(/^(library:)?[a-z0-9][a-z0-9._-]*$/i, 'give an icon name');

/** A tab of the main window's own: one of the addon's screens fills it, and Window → its title opens it in a window of its own. */
export const AddonTabSchema = z
  .object({
    id,
    title: z.string().min(1),
    view: id,
    params: ParamsSchema.optional(),
    icon: iconName.optional(),
  })
  .strict();
export type AddonTab = z.infer<typeof AddonTabSchema>;

/**
 * A tab inside each project (its view in the main window and a phone's
 * project screen, and the Sessions window's activity pane for the session's
 * project), after Looper's own. The screen `view` fills it, drawn with
 * `{ projectId }` as its params. The `projectTab` request says, per project,
 * whether it shows and the title it has now.
 */
export const AddonProjectTabSchema = z
  .object({
    id,
    title: z.string().min(1),
    view: id,
    icon: iconName.optional(),
  })
  .strict();
export type AddonProjectTab = z.infer<typeof AddonProjectTabSchema>;

/** How a project tab is for one project now: the answer to `projectTab`. */
export const AddonProjectTabStateSchema = z
  .object({
    /** Left out of this project's tabs (a git tab for a folder that isn't a repository). */
    hidden: z.boolean().optional(),
    /** The title it has now, such as "Git (+2 ~3 −1)"; unset: the manifest's. */
    title: z.string().min(1).optional(),
  })
  .strict();
export type AddonProjectTabState = z.infer<typeof AddonProjectTabStateSchema>;

// ---------- Commands ----------

/** The menus an addon's command can go in: Looper's own, so every window's menu bar keeps one order. */
export const ADDON_MENUS = ['file', 'edit', 'view', 'tools', 'help'] as const;
export type AddonMenuName = (typeof ADDON_MENUS)[number];

/** The id of the main window's tab an addon's panes fill (mainTabs): no tab of the manifest's can take it. */
export const PANES_TAB = 'panes';

const placement = {
  toolbar: z.boolean().optional(),
  /** On a phone's bar while it can run and fits there; otherwise in the screen's More menu. */
  main: z.boolean().optional(),
  /** false: left out of the right-click menu (a pane item's, or a pane header's). */
  context: z.boolean().optional(),
};
const PlacementSchema = z.object(placement).strict();
export type AddonPlacement = z.infer<typeof PlacementSchema>;

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
const OTHER_KEY = /^([A-Z0-9]|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Enter|Tab|Space|Backspace)$/;

/** A key an addon's command can take: with Ctrl, so typing in a field never reaches it, or a function key. */
function isCommandKey(key: string): boolean {
  const parts = key.split('+');
  const main = parts.pop()!;
  if (new Set(parts).size !== parts.length || !parts.every((m) => m === 'CmdOrCtrl' || m === 'Alt' || m === 'Shift')) return false;
  return FUNCTION_KEY.test(main) || (OTHER_KEY.test(main) && parts.includes('CmdOrCtrl'));
}

/** A key that reaches the command while its menu is in the window's menu bar. */
const accelerator = z.string().refine(isCommandKey, 'use a key with CmdOrCtrl, such as "CmdOrCtrl+Shift+K", or a function key');

/**
 * Instead of a `command` event: one of the addon's screens in a window of its
 * own (picked again, it comes forward), or one of its main window's tabs
 * ("panes" is its panes' tab). A phone's More view lists the tab, so what opens
 * one stays off phones.
 */
const OpensSchema = z.union([
  z
    .object({
      view: id,
      params: ParamsSchema.optional(),
      width: z.number().int().min(320).max(2000).optional(),
      height: z.number().int().min(200).max(1400).optional(),
    })
    .strict(),
  z.object({ tab: id }).strict(),
]);

/** What a command and one of its submenu's items both have. */
const actionFields = {
  id,
  /** "&New Server…": a menu shows it with its access key, a toolbar and a phone without the "&" and the "…". */
  label: z.string().min(1),
  icon: iconName.optional(),
  accelerator: accelerator.optional(),
  /** It destroys or cuts something off: a phone draws it red, last in its menu. */
  destructive: z.boolean().optional(),
  /** Asked in a Yes/No dialog first; No sends nothing. */
  confirm: z.string().min(1).optional(),
  /** A check mark (`checked` in its state), or a radio bullet, one of its group's. */
  check: z.enum(['check', 'radio']).optional(),
  opens: OpensSchema.optional(),
};

/** One item of a command's submenu; `id` is unique among all the addon's commands and items, and its event and state use it. */
const AddonEntrySchema = z.object(actionFields).strict();
export type AddonEntry = z.infer<typeof AddonEntrySchema>;
const AddonEntryOrLineSchema = z.union([AddonEntrySchema, z.object({ separator: z.literal(true) }).strict()]);
export type AddonEntryOrLine = z.infer<typeof AddonEntryOrLineSchema>;

/**
 * One thing the addon can do, written once: the menu it's in, where else it goes
 * (`in`: toolbars, a phone's bar and More), and Looper draws it on each from this
 * entry. A screen, a pane or a pane item says how it is now (its `commands`
 * state). Picking it sends a `command` event, or opens one of the addon's screens.
 */
export const AddonCommandSchema = z
  .object({
    ...actionFields,
    /** Every command is a menu item, its toolbar button only a shortcut to it (Win32: the menu bar lists every command). A `new` one is in File. */
    menu: z.enum(ADDON_MENUS).optional(),
    /** On a toolbar, its label beside its icon; unset: the icon alone, its label the tooltip. A command with no icon shows its label. */
    labeled: z.boolean().optional(),
    /** A separator falls between groups, in a menu and on a toolbar; unset: the group of the addon's ungrouped commands. */
    group: id.optional(),
    /** A submenu in a menu, and a drop-down on a toolbar and a phone's bar. */
    entries: z.array(AddonEntryOrLineSchema).min(1).optional(),
    /** With `entries`: a toolbar's split button, whose icon sends the command's own event and whose arrow opens the list. With `opens` it's split anyway. */
    primary: z.boolean().optional(),
    platforms,
    in: z
      .object({
        /** With Looper's New: in File, after Looper's New items, and with `toolbar`, in the toolbar's New group. */
        new: z.object({ toolbar: z.boolean().optional() }).strict().optional(),
        /** The main window, on every tab: its menus, and its toolbar after the tab's own buttons. */
        app: PlacementSchema.optional(),
        /** While that tab shows: in the main window and in the tab's own window (the Chats window, for `chats`). */
        dashboard: PlacementSchema.optional(),
        projects: PlacementSchema.optional(),
        /**
         * A project: its right-click menu in the Projects tab, and the Projects tab's
         * menus and toolbar while one is selected (off while none is). The event's
         * `project` is that project's id.
         */
        project: PlacementSchema.optional(),
        tasks: PlacementSchema.optional(),
        chats: PlacementSchema.optional(),
        /** The addon's panes tab: its menus and toolbar while it shows, and a pane header's right-click menu. */
        panes: PlacementSchema.optional(),
        /** A pane item: its right-click menu, and the panes tab's menus and toolbar while one is selected (off while none is). */
        item: PlacementSchema.optional(),
        /** The addon's screens, wherever one shows (a tab, beside its pane, a window of its own); `views` keeps it to those. */
        screen: z
          .object({ ...placement, views: z.array(id).min(1).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, 'give at least one place'),
  })
  .strict()
  .refine((c) => c.in.new || c.menu, { error: 'give the menu it goes in', path: ['menu'] })
  .refine((c) => !c.in.new || !c.menu || c.menu === 'file', { error: 'a command in "new" goes in the file menu', path: ['menu'] })
  .refine((c) => !c.entries || !c.check, { error: 'a command with "entries" can\'t have a check mark', path: ['check'] })
  .refine((c) => !c.primary || c.entries, { error: '"primary" needs "entries"', path: ['primary'] });
export type AddonCommand = z.infer<typeof AddonCommandSchema>;
export type AddonPlace = keyof AddonCommand['in'];

/** The menu it's in. */
export const commandMenu = (c: Pick<AddonCommand, 'menu'>): AddonMenuName => c.menu ?? 'file';

/** A command's submenu items, without the lines between them. */
export const commandEntries = (c: Pick<AddonCommand, 'entries'>): AddonEntry[] => (c.entries ?? []).filter((e): e is AddonEntry => 'id' in e);

/** A command or a submenu's item, by its id. */
export function findAddonAction(commands: AddonCommand[], actionId: string): AddonCommand | AddonEntry | undefined {
  for (const c of commands) {
    if (c.id === actionId) return c;
    const entry = commandEntries(c).find((e) => e.id === actionId);
    if (entry) return entry;
  }
  return undefined;
}

/** How one of the addon's commands is now. A screen, a pane and a pane item each send theirs, and the most specific one wins. */
export const AddonCommandStateSchema = z
  .object({
    enabled: z.boolean().optional(),
    checked: z.boolean().optional(),
    /** Left out (a command that doesn't apply to this item, or to the state the addon is in). */
    hidden: z.boolean().optional(),
    /** The label it has now, for a command whose words change with the state ("&Lock Vault", "&Unlock Vault"). */
    label: z.string().min(1).optional(),
    /** The icon it has now: one of Looper's, or one the manifest names (a name it doesn't know leaves the command's own). */
    icon: iconName.optional(),
  })
  .strict();
export type AddonCommandState = z.infer<typeof AddonCommandStateSchema>;
const CommandStatesSchema = z.record(z.string(), AddonCommandStateSchema);
export type AddonCommandStates = z.infer<typeof CommandStatesSchema>;

/**
 * How a tool call shows on the Now tab: an addon's own tools (an MCP server
 * it comes with, say) can look the way the addon wants there.
 */
export const AddonToolCallSchema = z
  .object({
    /** The tool's name as the agent calls it; a "*" at the end matches every name that starts with what comes before it. */
    tool: z.string().regex(/^[^*]+\*?$/, 'give a name, with "*" only at its end'),
    /** The title instead of the tool's name; "{name}" is the call's parameter of that name. */
    title: z.string().min(1).optional(),
    /** The parameters to list, in this order; unset lists them all, and [] none. */
    params: z.array(z.string().min(1)).optional(),
    /** How the result shows; unset shows it as Looper shows any tool's. */
    result: z.union([z.enum(['text', 'markdown', 'code', 'image', 'table']), z.object({ view: id }).strict()]).optional(),
    /** With `result: "code"`: the language to color it as (typescript, json, python…). */
    language: z.string().min(1).optional(),
  })
  .strict();
export type AddonToolCall = z.infer<typeof AddonToolCallSchema>;

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
    /** The icon of the tab its panes fill; unset: a window. */
    panesIcon: iconName.optional(),
    /** Tabs in the main window, after Looper's own (not on a phone, whose tab bar has room for Looper's only). */
    tabs: z.array(AddonTabSchema).default([]),
    /** Tabs inside each project, after Looper's own. */
    projectTabs: z.array(AddonProjectTabSchema).default([]),
    /** The addon's own icons by name: SVG text, or "library:<name>" for a library icon only a state names. */
    icons: z.record(z.string().regex(OWN_ICON_NAME, 'use letters, digits, ".", "_" or "-"'), z.string()).default({}),
    /** Everything it can do, each once, in the order its menus and toolbars list them. */
    commands: z.array(AddonCommandSchema).default([]),
    /** Names its toolbar buttons in "<toolbarName> Toolbar" (View menu), which hides them; the addon's name otherwise. */
    toolbarName: z.string().min(1).optional(),
    /** How tool calls show on the Now tab. */
    toolCalls: z.array(AddonToolCallSchema).default([]),
  })
  .strict();
export type AddonManifest = z.infer<typeof AddonManifestSchema>;

export type ReadManifestResult =
  | { ok: true; manifest: AddonManifest }
  /** newer: a format this Looper doesn't know yet. */
  | { ok: false; reason: 'not-addon' | 'newer' | 'older' | 'invalid'; error?: string };

/** Every icon name the manifest's fields use, with the field for an error. */
export function manifestIconNames(m: Pick<AddonManifest, 'panesIcon' | 'tabs' | 'commands'> & { projectTabs?: AddonProjectTab[] }): { name: string; where: string }[] {
  const out: { name: string; where: string }[] = [];
  if (m.panesIcon) out.push({ name: m.panesIcon, where: 'panesIcon' });
  for (const t of m.tabs) if (t.icon) out.push({ name: t.icon, where: `tabs: "${t.id}"` });
  for (const t of m.projectTabs ?? []) if (t.icon) out.push({ name: t.icon, where: `projectTabs: "${t.id}"` });
  for (const c of m.commands) {
    for (const action of [c, ...commandEntries(c)]) if (action.icon) out.push({ name: action.icon, where: `commands: "${action.id}"` });
  }
  return out;
}

const isLooperIcon = (name: string): boolean => (ADDON_ICONS as readonly string[]).includes(name);

/** What's wrong with the manifest's icons: its own that can't be drawn, or a field naming one that doesn't exist. Library names are the main process's to check. */
function manifestIconError(m: AddonManifest): string | undefined {
  for (const [name, value] of Object.entries(m.icons)) {
    if (isLooperIcon(name)) return `icons: "${name}" is the name of one of Looper's icons`;
    if (value.startsWith(ICON_LIBRARY)) continue;
    const svg = parseSvgIcon(value);
    if (!svg.ok) return `icons: "${name}": ${svg.error}`;
  }
  for (const { name, where } of manifestIconNames(m)) {
    if (!isLooperIcon(name) && !name.startsWith(ICON_LIBRARY) && !Object.hasOwn(m.icons, name)) return `${where} names an icon that doesn't exist: "${name}"`;
  }
  return undefined;
}

/** Check parsed `.looperaddon` content: the envelope first, so a newer format reads as such. */
export function readAddonManifest(input: unknown): ReadManifestResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, reason: 'not-addon' };
  const obj = input as Record<string, unknown>;
  if (obj.$type !== ADDON_TYPE) return { ok: false, reason: 'not-addon' };
  if (typeof obj.$version === 'number' && obj.$version > ADDON_FORMAT) return { ok: false, reason: 'newer' };
  if (typeof obj.$version === 'number' && obj.$version < ADDON_FORMAT) return { ok: false, reason: 'older' };
  const parsed = AddonManifestSchema.safeParse(input, REPORT_INPUT);
  if (!parsed.success) return { ok: false, reason: 'invalid', error: issueLines(parsed.error, 4) };
  const ids = new Set<string>();
  for (const p of parsed.data.panes) {
    if (ids.has(p.id)) return { ok: false, reason: 'invalid', error: `panes: duplicate id "${p.id}"` };
    ids.add(p.id);
  }
  const tabIds = new Set<string>();
  for (const t of parsed.data.tabs) {
    if (tabIds.has(t.id)) return { ok: false, reason: 'invalid', error: `tabs: duplicate id "${t.id}"` };
    if (t.id === PANES_TAB) return { ok: false, reason: 'invalid', error: `tabs: "${PANES_TAB}" is the id of the panes' own tab` };
    tabIds.add(t.id);
  }
  const projectTabIds = new Set<string>();
  for (const t of parsed.data.projectTabs) {
    if (projectTabIds.has(t.id)) return { ok: false, reason: 'invalid', error: `projectTabs: duplicate id "${t.id}"` };
    projectTabIds.add(t.id);
  }
  const commandIds = new Set<string>();
  const keys = new Set<string>();
  const reserved = new Set(LOOPER_KEYS.map(keyId));
  for (const c of parsed.data.commands) {
    if ((c.in.panes || c.in.item) && !parsed.data.panes.length) return { ok: false, reason: 'invalid', error: `commands: "${c.id}" is placed in panes the addon doesn't have` };
    for (const action of [c, ...commandEntries(c)]) {
      if (commandIds.has(action.id)) return { ok: false, reason: 'invalid', error: `commands: duplicate id "${action.id}"` };
      commandIds.add(action.id);
      const tab = action.opens && 'tab' in action.opens ? action.opens.tab : undefined;
      if (tab && !(tab === PANES_TAB ? parsed.data.panes.length : tabIds.has(tab))) return { ok: false, reason: 'invalid', error: `commands: "${action.id}" opens a tab the addon doesn't have: "${tab}"` };
      if (action.accelerator) {
        const key = keyId(action.accelerator);
        if (reserved.has(key)) return { ok: false, reason: 'invalid', error: `commands: "${action.id}" uses ${hint(action.accelerator)}, which Looper uses` };
        if (keys.has(key)) return { ok: false, reason: 'invalid', error: `commands: "${action.id}" uses ${hint(action.accelerator)}, which another command uses` };
        keys.add(key);
      }
    }
  }
  const iconError = manifestIconError(parsed.data);
  if (iconError) return { ok: false, reason: 'invalid', error: iconError };
  const callTools = new Set<string>();
  for (const c of parsed.data.toolCalls) {
    if (callTools.has(c.tool)) return { ok: false, reason: 'invalid', error: `toolCalls: "${c.tool}" is there twice` };
    callTools.add(c.tool);
  }
  return { ok: true, manifest: parsed.data };
}

/** Whether a toolCalls entry is for this tool: its name, or with a "*" at the end, any name it starts. */
export const toolCallMatches = (c: AddonToolCall, tool: string): boolean =>
  c.tool.endsWith('*') ? tool.startsWith(c.tool.slice(0, -1)) : c.tool === tool;

/**
 * The toolCalls entry, of an addon that isn't stopped in the Addons window,
 * that says how this tool shows: the one naming it exactly, else the longest
 * "*" one that matches; ties go to the addon listed first.
 */
export function findToolCall(addons: AddonInfo[], tool: string): { addon: AddonInfo; call: AddonToolCall } | undefined {
  let found: { addon: AddonInfo; call: AddonToolCall } | undefined;
  const rank = (c: AddonToolCall) => (c.tool.endsWith('*') ? c.tool.length - 1 : Infinity);
  for (const addon of addons) {
    if (!addon.enabled) continue;
    for (const call of addon.toolCalls) {
      if (toolCallMatches(call, tool) && (!found || rank(call) > rank(found.call))) found = { addon, call };
    }
  }
  return found;
}

/** A toolCalls title with each "{name}" replaced by the call's parameter of that name (empty when it has none). */
export function toolCallTitle(title: string, input: Record<string, unknown>): string {
  return title.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const v = input[name];
    return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/**
 * In `run.command`, `run.cwd` and `run.env` (the manifest's or the user's):
 * the addon's installed folder, <dataDir>/addons/<id>, where its package's
 * files are, in the path form the side it runs on uses. Kept as written in
 * the installed addon.json and replaced each time the addon starts.
 */
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

/** The places of Looper's own windows a command can be in; the others are the addon's own panes and screens. */
const LOOPER_PLACES = ['new', 'app', 'dashboard', 'projects', 'project', 'tasks', 'chats'] as const;
const MENU_TITLES: Record<AddonMenuName, string> = { file: 'File', edit: 'Edit', view: 'View', tools: 'Tools', help: 'Help' };

/** What installing the addon adds to Looper, one line per place, for the install confirmation. */
export function addonAdditions(m: Pick<AddonManifest, 'panes' | 'commands'> & { tabs?: AddonTab[]; projectTabs?: AddonProjectTab[]; toolCalls?: AddonToolCall[] }): string[] {
  const lines: string[] = [];
  const tabs = (m.tabs ?? []).map((t) => t.title);
  if (tabs.length) lines.push(`${tabs.length === 1 ? 'A ' : ''}${listText(tabs)} tab${tabs.length === 1 ? '' : 's'} in the main window`);
  const projectTabs = (m.projectTabs ?? []).map((t) => t.title);
  if (projectTabs.length) lines.push(`${projectTabs.length === 1 ? 'A ' : ''}${listText(projectTabs)} tab${projectTabs.length === 1 ? '' : 's'} in each project`);
  const panes = m.panes.map((p) => p.title);
  if (panes.length) lines.push(`${panes.length === 1 ? 'A ' : ''}${listText(panes)} pane${panes.length === 1 ? '' : 's'} in a tab of ${panes.length === 1 ? 'its' : 'their'} own`);
  // Only what joins Looper's own windows: the rest is in the addon's tabs and panes, listed above.
  const inMenu = new Map<AddonMenuName, string[]>();
  const buttons: string[] = [];
  for (const c of m.commands) {
    const places = LOOPER_PLACES.filter((p) => c.in[p]);
    if (!places.length) continue;
    const label = noMnemonic(c.label);
    const menu = commandMenu(c);
    inMenu.set(menu, [...(inMenu.get(menu) ?? []), label]);
    if (places.some((p) => c.in[p]!.toolbar)) buttons.push(label.replace(/…$/, ''));
  }
  for (const menu of ADDON_MENUS) {
    const labels = inMenu.get(menu);
    if (labels) lines.push(`${listText(labels)} in the ${MENU_TITLES[menu]} menu`);
  }
  if (buttons.length) lines.push(`${buttons.length === 1 ? 'A ' : ''}${listText(buttons)} button${buttons.length === 1 ? '' : 's'} on the toolbar`);
  const calls = m.toolCalls?.length ?? 0;
  if (calls) lines.push(`How ${calls === 1 ? 'a tool’s calls show' : `${calls} tools’ calls show`} on the Now tab`);
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
    /** `checklist`: its `options` as rows with a check box each; its value is the checked options' values. */
    input: z.enum(['text', 'password', 'textarea', 'number', 'checkbox', 'select', 'list', 'checklist', 'file', 'folder']),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
    /** `list` and `checklist`: its rows, each with `description` as the line under it. `select`: the chosen option's `description` shows under it. */
    options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() }).strict()).optional(),
    /** `list`: what it shows with no options. */
    placeholder: z.string().optional(),
    /** `list`: the commands on its selected row, as buttons under it and in the row's menu. */
    buttons: z.array(ButtonSchema).optional(),
    /** `list`: it only shows its rows (the accounts an import changes): none can be chosen, and it has no `buttons`. */
    readOnly: z.boolean().optional(),
    /** A unit shown inside the input, at its right ("s", "min"). */
    suffix: z.string().min(1).optional(),
    /** `file` (not `folder`): the kinds of file Browse… offers, such as `{ label: 'CSV files', extensions: ['csv'] }`. */
    accept: z
      .array(z.object({ label: z.string().min(1), extensions: z.array(z.string().min(1)).min(1) }).strict())
      .optional(),
    /** The window's primary button stays off while this is empty. */
    required: z.boolean().optional(),
    /** `select`: choosing another option sends a `change` event with the field's id, and the answer's `values` fill the screen's fields. */
    change: z.boolean().optional(),
    /** A problem with what's in it, under it with an error icon (Windows' in-place error); an event answer's `errors` replace these. */
    error: z.string().min(1).optional(),
    autofocus: z.boolean().optional(),
  })
  .strict();
export type AddonField = z.infer<typeof FieldSchema>;

/** A value a screen's field holds: a checklist's is the checked options' values. */
export type AddonValue = string | number | boolean | string[];
const ValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

/** One row of a `listDetail` node. */
const ListRowSchema = z
  .object({
    id,
    title: z.string(),
    /** The line under the title, such as a file's folder or a commit's author and date. */
    subtitle: z.string().optional(),
    /** The subtitle in a monospace font (a path, an id). */
    mono: z.boolean().optional(),
    /** Plain text at the row's end, such as "Modified" (never a badge). */
    value: z.string().optional(),
    /** The screen beside the list (pushed on a phone) while the row is selected; drawn by `render` like any screen. */
    detail: z.object({ view: id, params: ParamsSchema.optional() }).strict().optional(),
  })
  .strict();
export type AddonListRow = z.infer<typeof ListRowSchema>;

/** One changed region of a `diff` node: unified diff lines, each starting with " ", "+" or "-". */
const DiffHunkSchema = z
  .object({
    oldStart: z.number().int().min(0),
    oldLines: z.number().int().min(0),
    newStart: z.number().int().min(0),
    newLines: z.number().int().min(0),
    lines: z.array(z.string()),
  })
  .strict();

export type AddonNode =
  | { type: 'props'; items: AddonProp[] }
  | { type: 'text'; text: string; muted?: boolean }
  | { type: 'markdown'; text: string }
  | { type: 'infobar'; title: string; message: string; button?: AddonButton; level?: 'info' | 'warning' | 'error' }
  | { type: 'empty'; text: string; level?: 'info' | 'warning' | 'error'; button?: AddonButton }
  | { type: 'buttons'; items: AddonButton[] }
  | AddonField
  | { type: 'row'; items: AddonField[] }
  | { type: 'section'; title: string; body: AddonNode[] }
  /** Looper's tab control: one tab's body shows at a time, and the selected tab outlasts redraws. */
  | { type: 'tabs'; id: string; items: { id: string; title: string; body: AddonNode[] }[] }
  | { type: 'footer'; primary: AddonButton; apply?: AddonButton }
  | { type: 'footer'; wizard: AddonWizard }
  /**
   * A list whose selected row's `detail` screen shows beside it (below it in a
   * narrow place, pushed on a phone), like the Git tab's changes and history.
   * The selection outlasts redraws, by row id. `menu` is each row's
   * right-click menu (on a phone, its pushed screen's More menu): a click event
   * with the button's id and the row's id in `item`. `more`: the list has
   * more rows than it sent; scrolling near its end sends a `more` event with
   * the node's id, and the addon answers with a `refresh` that sends more.
   */
  | {
      type: 'listDetail';
      id: string;
      /** The list's name for a screen reader, and a phone's back button on the detail. */
      label: string;
      items: AddonListRow[];
      /** The row selected when the node first shows; unset: the first on the desktop, none on a phone. */
      selected?: string;
      /** Shown instead of the list when it has no rows. */
      empty?: string;
      /** Shown beside the list while no row (or one without `detail`) is selected. */
      detailEmpty?: string;
      more?: boolean;
      menu?: AddonButton[];
    }
  /** A file's changes as Looper shows an edit's: line numbers, colors and highlighting by `file`'s extension. */
  | {
      type: 'diff';
      /** The heading, such as the file's path. */
      title?: string;
      /** Muted text after the heading, such as "Modified, staged". */
      subtitle?: string;
      /** The file's name, for the highlighting language; unset: `title`. */
      file?: string;
      hunks: z.infer<typeof DiffHunkSchema>[];
      /** A binary file: no lines to compare, and Looper says so. */
      binary?: boolean;
      /** The diff stops early, and Looper says so after it. */
      truncated?: boolean;
    };

/**
 * A wizard page's buttons, Back | Next | Cancel. `back` and `next` are the ids
 * their clicks send; with no `back` (the first page) Back is off. The page that
 * does the task has `commit` in Next's place, named by its verb (Import,
 * Create), or Finish when the task changes a setting.
 */
export type AddonWizard = { back?: string } & ({ next: string; commit?: never } | { commit: AddonButton; next?: never });

const WizardSchema = z
  .object({ back: id.optional(), next: id.optional(), commit: ButtonSchema.optional() })
  .strict()
  .refine((w) => !w.next !== !w.commit, { error: 'a wizard has "next" or "commit", not both' }) as z.ZodType<AddonWizard>;

export const AddonNodeSchema: z.ZodType<AddonNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('props'), items: z.array(PropSchema) }).strict(),
    z.object({ type: z.literal('text'), text: z.string(), muted: z.boolean().optional() }).strict(),
    z.object({ type: z.literal('markdown'), text: z.string() }).strict(),
    z
      .object({
        type: z.literal('infobar'),
        title: z.string().min(1),
        message: z.string(),
        button: ButtonSchema.optional(),
        /** Its icon; unset: `info`. A problem that keeps the screen from showing its content is an `empty` node instead. */
        level: z.enum(['info', 'warning', 'error']).optional(),
      })
      .strict(),
    /**
     * What the screen shows in place of the content it can't show: with a
     * `level`, a problem (normal text after a 16x16 icon, Windows' in-place
     * error), and `button` the action that fixes it; without one, that there's
     * nothing to show.
     */
    z.object({ type: z.literal('empty'), text: z.string().min(1), level: z.enum(['info', 'warning', 'error']).optional(), button: ButtonSchema.optional() }).strict(),
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
    z
      .object({ type: z.literal('footer'), primary: ButtonSchema.optional(), apply: ButtonSchema.optional(), wizard: WizardSchema.optional() })
      .strict()
      .refine((f) => (f.wizard ? !f.primary && !f.apply : !!f.primary), { error: 'a footer has "primary" (and "apply") or "wizard"' }),
    z
      .object({
        type: z.literal('listDetail'),
        id,
        label: z.string().min(1),
        items: z.array(ListRowSchema).refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, 'row ids must differ'),
        selected: id.optional(),
        empty: z.string().optional(),
        detailEmpty: z.string().optional(),
        more: z.boolean().optional(),
        menu: z.array(ButtonSchema).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('diff'),
        title: z.string().optional(),
        subtitle: z.string().optional(),
        file: z.string().optional(),
        hunks: z.array(DiffHunkSchema),
        binary: z.boolean().optional(),
        truncated: z.boolean().optional(),
      })
      .strict(),
  ]),
) as z.ZodType<AddonNode>;

/** The icons of Looper's own that any addon can name. `docs/addon-icon-list.md` lists them. */
export const ADDON_ICONS = [
  'add',
  'edit',
  'delete',
  'recycleBin',
  'copy',
  'refresh',
  'open',
  'folder',
  'openFolder',
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

/** What a surface draws for one of the addon's icon names (components/icons.tsx iconNode); undefined when it isn't one. */
export function addonIconKey(a: Pick<AddonInfo, 'icons'>, name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (isLooperIcon(name)) return name;
  return Object.hasOwn(a.icons, name) ? a.icons[name] : undefined;
}

export const AddonScreenSchema = z
  .object({
    title: z.string().optional(),
    /** The page's main instruction, drawn at its top: what to do there, or the question it asks. */
    instruction: z.string().min(1).optional(),
    /** How the addon's commands are while the screen shows (placed in `screen`, or anywhere else it shows). */
    commands: CommandStatesSchema.optional(),
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
    /** The description in a monospace font: a path, as the Projects tab shows a project's folder. */
    mono: z.boolean().optional(),
    /** The screen the main window shows while the item is selected. */
    view: id,
    params: ParamsSchema.optional(),
    /** How the commands placed on an item are for this one: one it doesn't have is `hidden`, one it can't do now is off. */
    commands: CommandStatesSchema.optional(),
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
    /** How the addon's commands are while the pane shows (a filter's check mark, what a locked vault can't do). */
    commands: CommandStatesSchema.optional(),
    /** Shown instead of the list when it has no items. */
    empty: z.string().optional(),
    /** The items can be searched: the window's Search box (one for the addon's panes) filters them as the user types. */
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

/**
 * `click`: a screen's button, or a `listDetail` row's menu item; `command`: one
 * of the manifest's commands; `open`: a pane item double-clicked; `more`: a
 * `listDetail` scrolled near the end of the rows it has; `change`: a field
 * with `change` given another value.
 */
export type AddonEventKind = 'click' | 'open' | 'command' | 'reveal' | 'copy' | 'more' | 'change';

/**
 * Where it happened: a pane (with the item a command acts on in `item`), a
 * screen, or Looper's own window for a command placed there (`app`).
 */
export type AddonEventSource = { pane: string } | { view: string; params: Record<string, unknown> } | { app: true };

/** What Looper sends with the `event` method. */
export interface AddonEvent {
  source: AddonEventSource;
  kind: AddonEventKind;
  /** The button, command, secret, or (open) pane item. */
  id: string;
  /** The pane item it acts on (a command placed on items, or the one opened), or the `listDetail` row whose menu was used. */
  item?: string;
  /** The project it acts on: a command placed in `project`, or picked while the Projects tab has one selected. */
  project?: string;
  /** The screen's field values, by field id. */
  values?: Record<string, AddonValue>;
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
    values: z.record(z.string(), ValueSchema).optional(),
    /**
     * Problems with what was typed, by field id: each shows under its field
     * with an error icon (Windows' in-place errors), the first field gets the
     * focus, and a field's problem goes when it's changed. Prefer this to a
     * `message` for anything one field can fix.
     */
    errors: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();
export type AddonEventResult = z.infer<typeof AddonEventResultSchema>;

// ---------- What the addon can ask Looper, and what Looper tells it ----------

/**
 * The addon's own requests to Looper: JSON-RPC requests (with an `id`) the
 * addon writes to its stdout, which Looper answers on its stdin. An error
 * answer's `message` says why. Each method's params are checked with its schema.
 */
export const ADDON_REQUESTS = {
  /** Looper's projects, in the Projects tab's order. Result: AddonProjectInfo[]. */
  'looper/projects': z.object({}).strict(),
  /** Settings → Environments. Result: AddonEnvironmentInfo[]. */
  'looper/environments': z.object({}).strict(),
  /**
   * Run a program, without a shell, in a project's environment (a WSL project's
   * inside its distro) and folder, or in an environment and folder: the way
   * Looper runs its own git. Result: AddonExecResult. Rejects only when the
   * program can't start or runs past the timeout.
   */
  'looper/exec': z
    .object({
      /** The project whose environment and folder it runs in. */
      projectId: z.string().min(1).optional(),
      /** Without `projectId`: the environment it runs in; unset: the default. */
      environmentId: z.string().min(1).optional(),
      /** The working folder, in the environment's own path form; with `projectId`, unset means the project's folder. */
      cwd: z.string().min(1).optional(),
      argv: z.array(z.string()).min(1),
      env: z.record(z.string(), z.string()).optional(),
      /** Text written to its stdin, which then closes. */
      stdin: z.string().optional(),
      /** 1 to 600; unset: 60. */
      timeoutSec: z.number().int().min(1).max(600).optional(),
    })
    .strict()
    .refine((p) => p.projectId || p.cwd, { error: 'give "projectId" or "cwd"' }),
  /** Add a project, as New Project does. Result: `{ id }`; rejects with the reason it isn't valid. */
  'looper/createProject': z
    .object({
      name: z.string().min(1),
      /** The project's folder, in the environment's own path form. */
      cwd: z.string().min(1),
      /** Unset: the default environment. */
      environmentId: z.string().min(1).optional(),
    })
    .strict(),
  /**
   * Run a command in a Looper terminal in the project's environment and folder,
   * where Looper shows terminals, so a program that asks for input (a password,
   * a passphrase) can. Result: `{}` once it starts.
   */
  'looper/openTerminal': z
    .object({
      /** The project whose environment and folder it runs in. */
      projectId: z.string().min(1).optional(),
      /** Without `projectId`: the environment it runs in; unset: the default. */
      environmentId: z.string().min(1).optional(),
      /** The working folder, in the environment's own path form; with `projectId`, unset means the project's folder. */
      cwd: z.string().min(1).optional(),
      command: z.array(z.string()).min(1),
      /** The terminal's title; unset: the command. */
      title: z.string().min(1).optional(),
    })
    .strict()
    .refine((p) => p.projectId || p.cwd, { error: 'give "projectId" or "cwd"' }),
  /** The projects an agent is working in now. Result: `{ working: string[] }`; the `activity` notification follows each change. */
  'looper/activity': z.object({}).strict(),
  /**
   * One of the addon's screens in a window of its own, opened when the addon
   * needs it rather than as an event's answer: a password git asks for in the
   * middle of a pull. It opens as a dialog over the window that sent `request`
   * (the id of a Looper `event` request the addon is still answering), on the
   * device that sent it; without one, or once that window has closed, over the
   * main window. Result: `{}` once the window has closed, however it closed.
   */
  'looper/openWindow': z
    .object({
      view: id,
      params: ParamsSchema.optional(),
      title: z.string().min(1),
      width: z.number().int().min(320).max(2000).optional(),
      height: z.number().int().min(200).max(1400).optional(),
      request: z.number().int().min(1).optional(),
    })
    .strict(),
} as const;
export type AddonRequestMethod = keyof typeof ADDON_REQUESTS;

export interface AddonProjectInfo {
  id: string;
  name: string;
  /** Its folder, in its environment's own path form (`/home/…` for a WSL project, `C:\…` for a Windows one). */
  cwd: string;
  environmentId: string;
  /** Where its programs run: `looper/exec` with its id runs there. */
  side: AddonSide;
}

export interface AddonEnvironmentInfo {
  id: string;
  name: string;
  side: AddonSide;
  /** The default environment (Settings → Environments). */
  default: boolean;
}

export interface AddonExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Looper's notifications to the addon (JSON-RPC without an `id`):
 * `projectsChanged` (`{}`) when a project is added, removed or changed, and
 * `activity` (`{ projectId, working }`) when an agent starts or stops working
 * in a project.
 */
export type AddonNotification = { method: 'projectsChanged'; params: Record<string, never> } | { method: 'activity'; params: { projectId: string; working: boolean } };

/**
 * The addon's `refresh` notification's params: what to draw again. Unset, or
 * none of these given: every pane, screen and project tab title of the addon.
 */
export const AddonRefreshSchema = z
  .object({
    /** The screens of these views, wherever they show. */
    views: z.array(id).optional(),
    /** These panes. */
    panes: z.array(id).optional(),
    /** Every project tab's title and whether it shows (`projectTab` again). */
    projectTabs: z.boolean().optional(),
  })
  .strict();
export type AddonRefresh = z.infer<typeof AddonRefreshSchema>;

/**
 * Looper's requests to the addon, besides `initialize` (`{ protocol: 2, looper,
 * host, dataDir, locale }`, `locale` the BCP 47 tag Looper formats dates and numbers with), `pane`, `render` and `event`: `projectTab`
 * (`{ tab, projectId }`), answered with an AddonProjectTabState.
 */
export const ADDON_PROTOCOL = ADDON_FORMAT;

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
  panesIcon?: string;
  tabs: AddonTab[];
  projectTabs: AddonProjectTab[];
  commands: AddonCommand[];
  /** Each own or library icon name the manifest uses, as a surface draws it (addonIconKey). */
  icons: Record<string, string>;
  toolbarName?: string;
  /** How tool calls show on the Now tab (findToolCall). */
  toolCalls: AddonToolCall[];
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
  /** Draw the addon's panes, screens and project tab titles again: only what `only` names, when it's given. */
  | { type: 'refresh'; addonId: string; only?: AddonRefresh }
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
