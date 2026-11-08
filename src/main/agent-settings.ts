import type { Engine } from '../engine/engine';
import { agentLocations, hostPathOf, probeAgentHome, readAgentSettings, writeAgentSettings, type AgentHome, type AgentLocations } from '../engine/agent-files';
import { listMcpTools } from '../engine/mcp-tools';
import type { AgentSettingsSave, AgentSettingsScope, McpServer, McpServerRequest } from '../shared/agent-config';
import type { WindowRole } from '../shared/remote-access';
import type { Environment, Harness } from '../shared/types';
import { ipc, showMessageBox, windowOf, type AppWindow } from './platform';

/*
 * Tools → Agent Settings: the window that edits an environment's Claude Code
 * or Codex settings files (a project's too, when one is picked), and the MCP
 * server window it opens. The files are read and written here; the window
 * keeps the drafts.
 */

export interface AgentSettingsDeps {
  engine: Engine;
  openWindow: (
    hash: string,
    title: string,
    width: number,
    height: number,
    modalParent: AppWindow | null | undefined,
    opts: { role: WindowRole; minWidth?: number; minHeight?: number; resizable?: boolean; contentSize?: boolean },
  ) => AppWindow;
  /** The caller's main window: the Agent Settings window is modal over it. */
  mainWindow: () => AppWindow | null;
}

let deps: AgentSettingsDeps | null = null;

/** Each environment harness's folders, asked once (its shell, its variables) while they stay the same. */
const homes = new Map<string, Promise<AgentHome>>();

function homeOf(env: Environment, harness: Harness): Promise<AgentHome> {
  const key = JSON.stringify([env.id, env.kind, env.distro ?? '', env.shell ?? '', harness.id, harness.env]);
  let home = homes.get(key);
  if (!home) {
    home = probeAgentHome(env, harness, deps!.engine.host);
    homes.set(key, home);
    home.catch(() => homes.delete(key));
  }
  return home;
}

/** The scope's environment, harness, project folder and file locations. Throws with the reason. */
async function locate(scope: AgentSettingsScope): Promise<{ env: Environment; harness: Harness; cwd: string | undefined; loc: AgentLocations }> {
  const engine = deps!.engine;
  const env = engine.settings.environments.find((e) => e.id === String(scope?.envId));
  if (!env) throw new Error('This environment no longer exists.');
  const harness = env.harnesses.find((h) => h.id === String(scope.harnessId));
  if (!harness) throw new Error('This harness no longer exists.');
  if (harness.kind === 'custom') throw new Error('A custom harness has no settings files Looper knows.');
  let cwd: string | undefined;
  if (scope.projectId) {
    const project = engine.getProject(String(scope.projectId));
    if (!project) throw new Error('This project no longer exists.');
    if (project.environmentId !== env.id) throw new Error(`The project "${project.name}" is in another environment.`);
    if (!project.cwd) throw new Error(`The project "${project.name}" has no folder.`);
    cwd = project.cwd;
  }
  const home = await homeOf(env, harness);
  const loc = await agentLocations(harness.kind, home, cwd, hostPathOf(engine.host, env));
  return { env, harness, cwd: cwd ?? home.home, loc };
}

/** Open Agent Settings, modal over the caller's main window. */
export function openAgentSettingsWindow(): void {
  if (!deps) return;
  deps.openWindow('agent-settings', 'Agent Settings', 760, 620, deps.mainWindow(), { role: 'editor', minWidth: 640, minHeight: 480 });
}

/** The server windows open now, by key: what each edits, and how its answer reaches the Agent Settings window. */
const serverEdits = new Map<string, { request: McpServerRequest; done: (server: McpServer | null) => void; window: AppWindow }>();
let serverKeys = 0;

export function registerAgentSettingsIpc(d: AgentSettingsDeps): void {
  deps = d;
  ipc.handle('agentSettings:open', () => openAgentSettingsWindow());
  ipc.handle('agentSettings:load', async (_e, scope: AgentSettingsScope) => readAgentSettings((await locate(scope)).loc));
  ipc.handle('agentSettings:save', async (e, scope: AgentSettingsScope, save: AgentSettingsSave) => {
    const { loc } = await locate(scope);
    const sender = windowOf(e);
    return writeAgentSettings(loc, save, async (paths) => {
      const { response } = await showMessageBox(sender, {
        type: 'question',
        title: 'Agent Settings',
        message: 'Replace the changes made elsewhere?',
        detail: `These files changed after this window read them:\n${paths.join('\n')}\n\nSaving replaces those changes with yours.`,
        buttons: ['Save', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return response === 0;
    });
  });
  ipc.handle('agentSettings:listTools', async (_e, scope: AgentSettingsScope, server: McpServer) => {
    const { env, harness, cwd } = await locate(scope);
    return listMcpTools(env, harness, d.engine.host, harness.kind as 'claude-code' | 'codex', server, cwd);
  });
  ipc.handle(
    'agentSettings:editServer',
    (e, request: McpServerRequest) =>
      new Promise<McpServer | null>((resolve) => {
        const key = String(++serverKeys);
        const child = d.openWindow(`mcp-server/${key}`, request.isNew ? 'New MCP Server' : 'Edit MCP Server', 560, 560, windowOf(e), { role: 'tool', minWidth: 480, minHeight: 440 });
        serverEdits.set(key, { request, done: resolve, window: child });
        child.on('closed', () => {
          if (!serverEdits.has(key)) return;
          serverEdits.delete(key);
          resolve(null);
        });
      }),
  );
  ipc.handle('agentSettings:serverRequest', (_e, key: string) => serverEdits.get(String(key))?.request ?? null);
  ipc.handle('agentSettings:serverDone', (_e, key: string, server: McpServer) => {
    const edit = serverEdits.get(String(key));
    if (!edit) return;
    serverEdits.delete(String(key));
    edit.done(server);
    if (!edit.window.isDestroyed()) edit.window.close();
  });
}
