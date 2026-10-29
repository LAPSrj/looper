# Projects

A project is a folder you work in: your tasks run there, and your chats,
terminal sessions and Remote Control conversations open there. Each project
has an environment and agent settings (harness, session type, model, effort
and permission mode). Its tasks use them unless a task picks its own, and
its chats and terminal sessions start with the same harness, model, effort
and permission mode.

![The Projects pane and a project's view](img/projects.png)

## Creating a project

You never have to create a project before a task. On the task editor's
General tab, leave **Project** on **New project** and pick the task's
working directory: saving the task creates the project for that folder,
named after it, with the task's environment and agent settings. A task saved with
the folder of an existing project joins that project.

To make a project with no tasks, for example a folder you only chat in, use
**File → New Project…**, or right-click the Projects pane.

## The Projects pane

The Projects pane, above the task list, lists every project with its folder.
Drag a project to change the order, which the tray icon's menu follows too.
**View → Projects** shows or hides the pane.

Selecting a project shows its view in the main window, and the
[toolbar](monitoring.md#the-toolbar) then acts on the project: **New Task in
&lt;project&gt;**, **Edit Project**, **New Chat**, **New Terminal** and **Open
Working Directory**. The **Status** tab shows the project's settings and
whether it keeps a Remote Control conversation open. The **Tasks** tab lists
the tasks that run in the project, in the same kind of table as a task's
Runs tab, with each task's status, last run, its result and its details; double-click a task (or press Enter) to select it. The **Sessions** tab lists the
project's chats, terminal sessions and Remote Control conversations, like a
task's Runs tab: double-click one for its run window, or right-click it to
go on with it in a chat or a terminal.

Right-clicking a project opens a menu with New Chat, New Terminal, New Task…,
Edit Project…, Open Working Directory and Delete Project. Double-clicking it
opens Edit Project.

## Editing a project

![The Edit Project window](img/project-editor.png)

- **Name** — how the project shows in the Projects pane, the tray menu, its
  chat windows, and the Claude app for a Remote Control conversation. Left
  empty, it's the folder's name.
- **Working directory** — the project's folder, in the path style its
  environment expects. Browse… opens a picker scoped to the environment.
  Two projects can't have the same folder in the same environment.
- **Environment** and **Harness** — where the project's tasks and sessions
  run, and the agent CLI they run.
- **Model**, **Effort**, **Session type** and **Permission mode** — what
  the project's tasks run with, unless a task has its own agent settings.
  New chats and terminal sessions start with the same model, effort and
  permission mode; they're always interactive, so the session type is only
  for tasks.
- **Extra command-line arguments** — appended to the harness command line
  of every task's agent and every chat and terminal session in the project.
  A task's own arguments come after them.
- **Extra environment variables** — set for every step of the project's
  tasks and for its sessions. A task's own variables are added to them, and
  replace one with the same name.
- **Keep a Remote Control conversation open** — while
  [Remote Control](monitoring.md#remote-control) is on, a conversation in
  this project is always open in the Claude app, and another one opens once
  it's used and ends.

Saving a change applies it to the project's tasks right away: a task moves
with the project's folder, and follows its environment and agent settings
unless the task overrides them. A task that keeps one rolling conversation across
runs starts a new one, since a conversation can't move to another folder,
environment or harness.

## Tasks and their project

A task always runs in its project's folder. On its General tab, **Override
the project's environment** lets the task run in another environment that
uses the same kind of path, and on its Agent tab, **Override the project's
agent settings** lets it pick its own harness,
session type, model, effort and permission mode. Without those boxes
checked, the task follows the project. See [the task
editor](tasks.md#general).

To move a task to another project, pick that project on its General tab.

## Starting a chat from the tray

Right-click the tray icon and click a project: a new chat opens in it, with
the project's harness, model and permission mode, without bringing up the
main window. Double-clicking the tray icon still shows the main window.

## Deleting a project

**Delete Project** asks first, and leaves the folder and its files as they
are. A project that still has tasks can't be deleted: move them to another
project or delete them first. Its past chats and terminal sessions stay in
the run history until their retention runs out.
