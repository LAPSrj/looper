// Relative imports only: the main process, the renderer and the unit tests all load the list.
import type { AddonCommandStates, AddonInfo } from '../addons';
import type { LooperApi, UiEvent } from '../api';
import type { ChatState } from '../chat';
import type { HistoryCommands, HistoryFolderFilter } from '../history';
import type { RemoteAccessState } from '../remote-access';
import type { SessionSummary } from '../sessions';
import type { PreventSleepState, Project, ProjectFolder, RestState, Settings, Task, TaskFolder, TaskRuntime, View } from '../types';
import type { UiPlatform } from '../ui-platform';

/** What the main process does for a command, by name: what only it can (a window it opens, a dialog over its window). */
export const HOST_COMMANDS = [
  'settings',
  'templates',
  'agent-settings',
  'recycle-bin',
  'remote-access-toggle',
  'remote-access-setup',
  'remote-access-settings',
  'pair-device',
  'paired-devices',
  'tailscale-sign-in',
  'tailscale-sign-out',
  'remote-control-toggle',
  'remote-conversations',
  'remote-helpers',
  'addons',
  'rest-toggle',
  'prevent-sleep',
  'update-models',
  'engine-log',
  'open-data-directory',
  'instructions',
  'about',
  'import-task',
  'new-folder',
  'open-view',
  'other-folder',
  'save-markdown',
  'close-all',
  'copy-session-id',
  'run-output-file',
  'run-terminal',
  'run-chat',
  'run-compact',
  'run-guidance',
  'run-folder',
  'run-copy-folder',
  'run-work-folder',
  'messages-filter',
] as const;
export type HostCommand = (typeof HOST_COMMANDS)[number];

/** A Chats window's state, or the main window's Chats tab's. */
export interface ChatsContext {
  /** A single chat's window. */
  single: boolean;
  /** The main window's Chats tab, not a window of its own. */
  tab: boolean;
  selected: string | null;
  summary: SessionSummary | undefined;
  chat: ChatState | null;
  /** The harness's own id for the conversation, once it has started it. */
  sessionId: string | null;
  sessions: SessionSummary[];
  stoppable: boolean;
  shown: View['sessions'];
  setShown(patch: Partial<View['sessions']>): void;
  setSelected(id: string | null): void;
  /** The Activity pane or sheet shows. */
  activityOpen: boolean;
  toggleActivity(): void;
  /** Step through the list (F8, F9). */
  step(dir: 1 | -1, waiting: boolean): void;
  focusPane(dir: 1 | -1): void;
  /** A phone's Usage sheet, and what its ring shows. */
  showUsage?(): void;
  usageLabel?: string;
  usageRing?: { context: number | null; used: number | null };
}

/** A History window's state. */
export interface HistoryContext {
  selected: string | null;
  commands: HistoryCommands;
  shown: View['history'];
  setShown(patch: Partial<View['history']>): void;
  folder: HistoryFolderFilter;
  setFolder(folder: HistoryFolderFilter): void;
  activity: boolean;
  setActivity(on: boolean): void;
  refresh(): void;
  find(): void;
}

/** A run or subagent window's state. */
export interface RunContext {
  taskId: string;
  runId: string;
  agentId?: string;
  title: string;
  workFolder: boolean;
  canContinue: { chat: boolean; terminal: boolean; guidance: boolean; compact: boolean };
  raw: boolean;
  rawOutput: boolean;
  autoScroll: boolean;
  filter: string;
  /** A phone's run sheet: the tab it shows. */
  tab?: 'result' | 'details';
  set(patch: Partial<Pick<RunContext, 'raw' | 'rawOutput' | 'autoScroll'>>): void;
}

/**
 * The addon whose panes or screen a window shows, and the state its commands
 * read: a pane's, the picked item's and the screen's (in that order, the later
 * winning). A command placed on items acts on `item`.
 */
export interface AddonContext {
  id: string;
  /** Its panes tab shows: the pane a command placed in `panes` acts on, and its state. */
  panes?: { pane: string; state?: AddonCommandStates };
  /** The pane item picked, or the row right-clicked; null while none is. */
  item?: { pane: string; id: string; state?: AddonCommandStates } | null;
  /** One of its screens shows: which, its state, and how a command reaches it (with the screen's field values). */
  screen?: { view: string; state?: AddonCommandStates; run(command: string, confirm?: string): void };
}

/** The Engine Log window's state. */
export interface EngineLogContext {
  sources: { key: string; label: string }[];
  hiddenSources: string[];
  hiddenLevels: string[];
  toggleSource(key: string): void;
  toggleLevel(level: string): void;
}

/** Everything a command's rules read: the page fills in what its window has. */
export interface CommandContext {
  looper: LooperApi;
  here: UiPlatform;
  /** The computer's kind, for what only Windows has (Rest Mode). */
  windowsHost: boolean;
  settings: Settings | null;
  setView(patch: Partial<View>): void;
  /** Tell this window's own components (a find bar, a message box). */
  ui(e: UiEvent): void;
  host(name: HostCommand, ...args: string[]): void;
  closeWindow(): void;
  /** The main window's tab it shows; unset elsewhere. */
  tab?: string;
  /** Show this tab, in the main window (not a view window, which shows its one tab). */
  openTab?(id: string): void;
  /** A view window: one tab alone. */
  fixed?: boolean;
  /** A task's or project's own window. */
  item?: boolean;
  /** The task the commands act on: the selected one, the dashboard row's, or the row right-clicked. */
  task: Task | null;
  runtime?: TaskRuntime;
  /** On a dashboard, Stop Task stops the picked row's run. */
  pickedRun?: string | null;
  /** The project the commands act on: the selected project, or the task's. */
  project: Project | null;
  /** The shown project itself, not the task's. */
  projectSelected?: boolean;
  /** A project row's own folder when moved through its menu. */
  projects: Project[];
  taskFolders: TaskFolder[];
  projectFolders: ProjectFolder[];
  addons: AddonInfo[];
  rest: RestState | null;
  preventSleep: PreventSleepState | null;
  remoteAccess: RemoteAccessState | null;
  /** Remote Control is running now, not only turned on. */
  remoteRunning?: boolean;
  /** A confirmed Clear Run History emptied this task's runs. */
  runsCleared?(taskId: string): void;
  showDashboard?(): void;
  chats?: ChatsContext;
  history?: HistoryContext;
  run?: RunContext;
  engineLog?: EngineLogContext;
  addon?: AddonContext;
}

const nothing = (): void => undefined;

/** The state before a page reports: what the first menu is drawn from. Nothing runs from it. */
export const EMPTY_CONTEXT: CommandContext = {
  looper: {} as LooperApi,
  here: 'desktop',
  windowsHost: false,
  settings: null,
  setView: nothing,
  ui: nothing,
  host: nothing,
  closeWindow: nothing,
  task: null,
  project: null,
  projects: [],
  taskFolders: [],
  projectFolders: [],
  addons: [],
  rest: null,
  preventSleep: null,
  remoteAccess: null,
};
