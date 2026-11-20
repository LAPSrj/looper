import type { ADDON_FORMAT, ADDON_TYPE, AddonCommand, AddonManifest } from '../../shared/addons';

/** The places a command on a repository goes: a pane item (with its toolbar button when `toolbar`), a project, and the repository's screens. */
const onRepo = (toolbar = false): AddonCommand['in'] => ({
  item: toolbar ? { toolbar: true } : {},
  project: {},
  screen: { views: ['repo', 'project'], ...(toolbar ? { main: true } : {}) },
});

/** The Git addon's manifest: written to addon.json by scripts/build-addons.mjs. */
export const MANIFEST = {
  $type: 'looper/addon' satisfies typeof ADDON_TYPE,
  $version: 2 satisfies typeof ADDON_FORMAT,
  id: 'git',
  name: 'Git',
  version: '1.0.0',
  description: "Your projects' git repositories: changes, history, commits, branches, pull and push.",
  run: { on: 'looper', command: ['${addonDir}/addon.js'] },
  panes: [{ id: 'repositories', title: 'Git' }],
  panesIcon: 'library:git-branch',
  projectTabs: [{ id: 'git', title: 'Git', view: 'project' }],
  commands: [
    {
      id: 'clone',
      label: 'Cl&one Repository…',
      icon: 'library:git-branch-plus',
      opens: { view: 'clone', width: 560, height: 440 },
      in: { new: { toolbar: true }, panes: { toolbar: true, main: true } },
    },
    { id: 'commit', label: '&Commit…', icon: 'library:git-commit-horizontal', menu: 'tools', group: 'commit', in: onRepo(true) },
    { id: 'pull', label: 'P&ull', icon: 'library:arrow-down-to-line', menu: 'tools', group: 'remote', in: onRepo() },
    { id: 'push', label: '&Push', icon: 'library:arrow-up-from-line', menu: 'tools', group: 'remote', in: onRepo() },
    { id: 'sync', label: '&Sync', icon: 'library:arrow-down-up', menu: 'tools', group: 'remote', in: onRepo(true) },
    { id: 'fetch', label: '&Fetch', icon: 'library:cloud-download', menu: 'tools', group: 'remote', in: onRepo() },
    // A drop-down named after the current branch: its branches to switch to, then the Branches window (the state's `entries`).
    {
      id: 'branch',
      label: '&Branch',
      icon: 'library:git-branch',
      labeled: true,
      menu: 'tools',
      group: 'branch',
      entries: [{ id: 'branches', label: '&Branches…' }],
      in: onRepo(true),
    },
    { id: 'repo-settings', label: 'Repositor&y Settings…', icon: 'library:folder-cog', menu: 'tools', group: 'repo', in: onRepo() },
    { id: 'init', label: 'Create Rep&ository', icon: 'library:folder-git', menu: 'tools', group: 'repo', in: onRepo() },
    { id: 'settings', label: 'Git Setti&ngs…', icon: 'settings', menu: 'tools', group: 'settings', in: { app: {}, panes: { toolbar: true } } },
  ],
} satisfies Omit<AddonManifest, 'tabs' | 'icons' | 'toolCalls'>;

/** The commands that act on a project's repository, which each item, project tab and screen says how they are. */
export type RepoCommand = 'commit' | 'pull' | 'push' | 'sync' | 'fetch' | 'branch' | 'repo-settings' | 'init';
