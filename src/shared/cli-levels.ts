/**
 * How much of Looper the `looper` command-line tool may change (Settings →
 * Advanced). The app refuses a command its level doesn't include, so an
 * agent that calls the app's command server itself gets no further than the tool.
 */
export const CLI_LEVELS = ['basic', 'standard', 'extended', 'unrestricted'] as const;
export type CliLevel = (typeof CLI_LEVELS)[number];

export const CLI_LEVEL_LABELS: Record<CliLevel, string> = {
  basic: 'Basic',
  standard: 'Standard',
  extended: 'Extended',
  unrestricted: 'Unrestricted',
};

/** Each level as Settings offers it: what it adds to the one before. */
export const CLI_LEVEL_CHOICES: Record<CliLevel, string> = {
  basic: 'Basic: tasks, runs and new chats',
  standard: 'Standard: also open chats, history, folders and templates',
  extended: 'Extended: also environments, harnesses, projects, addons and devices',
  unrestricted: "Unrestricted: also agents' permission answers, terminals and settings",
};

/**
 * The level each command the app answers needs; one not listed needs Standard.
 * Basic is what Looper itself relies on; Extended adds changing environments,
 * harnesses, projects, addons and paired devices; Unrestricted adds what lets
 * an agent get past its own permissions.
 */
export const REQUEST_LEVELS: Record<string, CliLevel> = {
  'task-add': 'basic',
  'run-now': 'basic',
  event: 'basic',
  pause: 'basic',
  resume: 'basic',
  stop: 'basic',
  remove: 'basic',
  enable: 'basic',
  disable: 'basic',
  complete: 'basic',
  reopen: 'basic',
  guide: 'basic',
  chat: 'basic',
  end: 'basic',
  'environment-save': 'extended',
  'environment-remove': 'extended',
  'harness-save': 'extended',
  'harness-remove': 'extended',
  'project-save': 'extended',
  'addons-enable': 'extended',
  'devices-pair': 'extended',
  allow: 'unrestricted',
  deny: 'unrestricted',
  terminal: 'unrestricted',
  command: 'unrestricted',
  'settings-set': 'unrestricted',
  'store-move': 'unrestricted',
};

export const allows = (level: CliLevel, need: CliLevel): boolean => CLI_LEVELS.indexOf(level) >= CLI_LEVELS.indexOf(need);

/** Why a command is refused at this level. */
export const levelProblem = (need: CliLevel, level: CliLevel): string =>
  `This command needs the command-line tool at ${CLI_LEVEL_LABELS[need]} or above, and Settings → Advanced → Command-line tool is ${CLI_LEVEL_LABELS[level]}.`;
