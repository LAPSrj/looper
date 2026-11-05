import { useEffect, useMemo, useState } from 'react';
import type { Project, Settings } from '@shared/types';
import {
  MCP_SCOPE_LABELS,
  claudeEffective,
  claudePermission,
  claudeServer,
  codexEffective,
  codexEntry,
  codexPermission,
  codexServer,
  fileProblem,
  isTomlFile,
  jsonServers,
  jsonText,
  parseJsonObject,
  parseTomlTable,
  putServer,
  putTomlServer,
  claudeEntry,
  setClaudePermission,
  setCodexPermission,
  tomlServers,
  type AgentFileKey,
  type AgentSettingsData,
  type AgentSettingsSave,
  type AgentSettingsScope,
  type McpPermission,
  type McpScope,
  type McpServer,
  type McpServerMap,
  type McpTool,
} from '@shared/agent-config';
import { Field, FieldRow, FormGroup, SelectInput, TabBar, TextArea } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { ListActions, SelectList } from './components/SelectList';
import { useDialogKeys } from './components/hooks';

type Tab = 'settings' | 'servers' | 'permissions';
const TABS: [Tab, string][] = [
  ['settings', 'Settings'],
  ['servers', 'MCP Servers'],
  ['permissions', 'MCP Permissions'],
];

const FILE_LABELS: Record<AgentFileKey, string> = {
  'claude-user': 'User (settings.json)',
  'claude-project': 'Project, shared (.claude/settings.json)',
  'claude-local': 'Project, personal (.claude/settings.local.json)',
  'mcp-json': 'Project MCP servers (.mcp.json)',
  'codex-user': 'User (config.toml)',
  'codex-project': 'Project (.codex/config.toml)',
};

const PERMISSIONS: [McpPermission, string][] = [
  ['default', 'Default'],
  ['allow', 'Allow'],
  ['ask', 'Ask'],
  ['deny', 'Deny'],
];
const CODEX_WRITES: [McpPermission, string] = ['writes', 'Ask before changes'];

const RESULT: Record<McpPermission, string> = {
  default: 'The permission mode decides',
  allow: 'Allowed',
  ask: 'Asks',
  deny: 'Denied',
  writes: 'Asks before changes',
};

/** A server's one-line description in the list: where it runs or what it reaches. */
const serverWhere = (s: McpServer): string => (s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url);
const serverKey = (s: McpServer): string => `${s.scope}:${s.name}`;

interface Drafts {
  files: Partial<Record<AgentFileKey, string>>;
  user: McpServerMap | null;
  local: McpServerMap | null;
}

function draftsOf(data: AgentSettingsData): Drafts {
  return {
    files: Object.fromEntries(data.files.map((f) => [f.key, f.text ?? ''])),
    user: data.claudeJson?.user ?? null,
    local: data.claudeJson?.local ?? null,
  };
}

/** Tools → Agent Settings: an environment harness's Claude Code or Codex settings files, MCP servers and MCP permissions, and a project's. */
export function AgentSettingsApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scope, setScope] = useState<AgentSettingsScope | null>(null);
  const [data, setData] = useState<AgentSettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({ files: {}, user: null, local: null });
  const [tab, setTab] = useState<Tab>('settings');
  const [fileKey, setFileKey] = useState<AgentFileKey | null>(null);
  const [rulesKey, setRulesKey] = useState<AgentFileKey>('claude-user');
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tools, setTools] = useState<Record<string, McpTool[] | string>>({});
  const [saving, setSaving] = useState(false);

  useDialogKeys({ tabs: TABS.map(([id]) => id), tab, onTab: setTab });

  useEffect(() => {
    document.title = 'Agent Settings';
    void window.looper.info().then((info) => {
      setSettings(info.settings);
      const env = info.settings.environments.find((e) => e.id === info.settings.defaultEnvironmentId) ?? info.settings.environments[0];
      const harness = env?.harnesses.find((h) => h.kind !== 'custom');
      if (env && harness) setScope({ envId: env.id, harnessId: harness.id });
    });
    void window.looper.projects.list().then(setProjects);
  }, []);

  const load = async (s: AgentSettingsScope) => {
    setData(null);
    setLoadError(null);
    setTools({});
    setExpanded(new Set());
    try {
      const d = await window.looper.agentSettings.load(s);
      setData(d);
      setDrafts(draftsOf(d));
      setFileKey(d.files[0]?.key ?? null);
      setRulesKey(d.kind === 'codex' ? 'codex-user' : s.projectId ? 'claude-local' : 'claude-user');
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };
  useEffect(() => {
    if (scope) void load(scope);
  }, [scope]);

  const dirtyFiles = useMemo(
    () => (data ? data.files.filter((f) => (drafts.files[f.key] ?? '') !== (f.text ?? '')) : []),
    [data, drafts],
  );
  const userDirty = !!data?.claudeJson && JSON.stringify(drafts.user) !== JSON.stringify(data.claudeJson.user);
  const localDirty = !!data?.claudeJson && JSON.stringify(drafts.local) !== JSON.stringify(data.claudeJson.local);
  const dirty = dirtyFiles.length > 0 || userDirty || localDirty;

  /** Another environment, harness or project: changes made so far are given up, once the user agrees. */
  const changeScope = async (next: AgentSettingsScope) => {
    if (dirty && !(await window.looper.confirm('Discard your changes to the agent settings files?'))) return;
    setScope(next);
  };

  if (!settings || !scope) return <Empty text="Loading…" />;
  const envs = settings.environments.filter((e) => e.harnesses.some((h) => h.kind !== 'custom'));
  if (envs.length === 0) return <Empty text="No environment has a Claude Code or Codex harness." />;
  const env = envs.find((e) => e.id === scope.envId) ?? envs[0];
  const harnesses = env.harnesses.filter((h) => h.kind !== 'custom');
  const envProjects = projects.filter((p) => p.cwd);
  const kind = data?.kind ?? 'claude-code';

  const fileOf = (key: AgentFileKey) => data?.files.find((f) => f.key === key);
  const setFile = (key: AgentFileKey, text: string) => setDrafts((d) => ({ ...d, files: { ...d.files, [key]: text } }));

  // ---------- servers, from the drafts ----------
  const problems: string[] = [];
  const parsedJson = (key: AgentFileKey): Record<string, unknown> | null => {
    if (!fileOf(key)) return null;
    const p = parseJsonObject(drafts.files[key] ?? '');
    if (!p.ok) {
      problems.push(`${fileOf(key)!.path}: ${p.error}`);
      return null;
    }
    return p.value;
  };
  const parsedToml = (key: AgentFileKey): Record<string, unknown> | null => {
    if (!fileOf(key)) return null;
    const p = parseTomlTable(drafts.files[key] ?? '');
    if (!p.ok) {
      problems.push(`${fileOf(key)!.path}: ${p.error}`);
      return null;
    }
    return p.value;
  };
  const servers: McpServer[] = [];
  if (data && kind === 'claude-code') {
    for (const [n, raw] of Object.entries(drafts.user ?? {})) servers.push(claudeServer('user', n, raw));
    for (const [n, raw] of Object.entries(drafts.local ?? {})) servers.push(claudeServer('local', n, raw));
    const mcp = parsedJson('mcp-json');
    for (const [n, raw] of Object.entries(mcp ? jsonServers(mcp) : {})) servers.push(claudeServer('project', n, raw));
  } else if (data) {
    for (const [key, sc] of [['codex-user', 'user'], ['codex-project', 'project']] as const) {
      const doc = parsedToml(key);
      for (const [n, raw] of Object.entries(doc ? tomlServers(doc) : {})) servers.push(codexServer(sc, n, raw));
    }
  }
  const scopes: McpScope[] = kind === 'codex' ? (scope.projectId ? ['user', 'project'] : ['user']) : scope.projectId ? ['user', 'local', 'project'] : ['user'];

  /** The drafts with server `old` (null: none) replaced by `next` (null: removed). */
  const putServerDraft = (old: McpServer | null, next: McpServer | null) => {
    try {
      {
        let out: Drafts = { ...drafts, files: { ...drafts.files } };
        const put = (sc: McpScope, oldName: string | null, name: string, s: McpServer | null) => {
          if (kind === 'codex') {
            const key: AgentFileKey = sc === 'project' ? 'codex-project' : 'codex-user';
            out.files[key] = putTomlServer(out.files[key] ?? '', oldName, name, s ? codexEntry(s) : null);
          } else if (sc === 'project') {
            const p = parseJsonObject(out.files['mcp-json'] ?? '');
            if (!p.ok) throw new Error(`.mcp.json has an error. ${p.error}`);
            out.files['mcp-json'] = jsonText({ ...p.value, mcpServers: putServer(jsonServers(p.value), oldName, name, s ? claudeEntry(s) : null) });
          } else {
            const map = putServer((sc === 'user' ? out.user : out.local) ?? {}, oldName, name, s ? claudeEntry(s) : null);
            out = sc === 'user' ? { ...out, user: map } : { ...out, local: map };
          }
        };
        if (old && (!next || next.scope !== old.scope)) put(old.scope, old.name, old.name, null);
        if (next) put(next.scope, old && old.scope === next.scope ? old.name : null, next.name, next);
        setDrafts(out);
      }
      if (next) setSelected(serverKey(next));
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const editServer = async (server: McpServer | null, copy = false) => {
    const isNew = !server || copy;
    const base: McpServer = server
      ? { ...server, name: copy ? `${server.name}-copy` : server.name }
      : { scope: scopes[scopes.length > 1 ? 1 : 0], name: '', transport: 'stdio', command: '', args: [], env: {}, url: '', headers: {}, raw: {} };
    const taken = Object.fromEntries(
      scopes.map((sc) => [sc, servers.filter((s) => s.scope === sc && (isNew || serverKey(s) !== serverKey(server!))).map((s) => s.name)]),
    );
    try {
      const result = await window.looper.agentSettings.editServer({ kind, server: base, isNew, scopes, taken });
      if (result) putServerDraft(isNew ? null : server, result);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };
  const selectedServer = servers.find((s) => serverKey(s) === selected) ?? null;

  // ---------- permissions ----------
  const claudeFiles = (['claude-user', 'claude-project', 'claude-local'] as AgentFileKey[]).filter((k) => fileOf(k));
  const rulesDoc = kind === 'claude-code' ? parsedJson(rulesKey) : null;
  const allRules = kind === 'claude-code' ? claudeFiles.map((k) => (k === rulesKey ? rulesDoc : parsedJson(k))).filter((x): x is Record<string, unknown> => !!x) : [];
  /** Claude Code's rules go by server name, wherever it's defined; Codex's are in each server's own entry. */
  const permServers = kind === 'claude-code' ? servers.filter((s, i) => servers.findIndex((x) => x.name === s.name) === i) : servers;

  const setPermission = (server: McpServer, tool: string | undefined, perm: McpPermission) => {
    try {
      if (kind === 'claude-code') {
        if (!rulesDoc) throw new Error(`${fileOf(rulesKey)?.path ?? 'The settings file'} has an error; fix it on the Settings tab first.`);
        setFile(rulesKey, jsonText(setClaudePermission(rulesDoc, server.name, tool, perm)));
      } else {
        const key: AgentFileKey = server.scope === 'project' ? 'codex-project' : 'codex-user';
        setFile(key, putTomlServer(drafts.files[key] ?? '', server.name, server.name, setCodexPermission(server.raw, tool, perm)));
      }
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };
  const permissionOf = (server: McpServer, tool?: string): McpPermission =>
    kind === 'claude-code' ? (rulesDoc ? claudePermission(rulesDoc, server.name, tool) : 'default') : codexPermission(server.raw, tool);
  const effectiveOf = (server: McpServer, tool?: string): McpPermission =>
    kind === 'claude-code' ? claudeEffective(allRules, server.name, tool) : codexEffective(server.raw, tool);
  const resultText = (p: McpPermission) => (p === 'default' && kind === 'codex' ? 'Codex decides' : RESULT[p]);
  const options = kind === 'codex' ? [...PERMISSIONS, CODEX_WRITES] : PERMISSIONS;

  const toggle = (server: McpServer) => {
    const key = serverKey(server);
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      if (!tools[key] || typeof tools[key] === 'string') {
        setTools((t) => ({ ...t, [key]: 'Listing tools…' }));
        window.looper.agentSettings.listTools(scope, server).then(
          (list) => setTools((t) => ({ ...t, [key]: list })),
          (e: Error) => setTools((t) => ({ ...t, [key]: `Its tools can't be listed: ${e.message}` })),
        );
      }
    }
    setExpanded(next);
  };

  // ---------- saving ----------
  const doSave = async (): Promise<boolean> => {
    if (!data) return false;
    for (const f of dirtyFiles) {
      const problem = fileProblem(f.key, drafts.files[f.key] ?? '');
      if (problem) {
        setTab('settings');
        setFileKey(f.key);
        void window.looper.showError(`${f.path} has an error.`, problem);
        return false;
      }
    }
    const save: AgentSettingsSave = { files: dirtyFiles.map((f) => ({ key: f.key, base: f.text, text: drafts.files[f.key] ?? '' })) };
    if (data.claudeJson && (userDirty || localDirty)) {
      save.claudeJson = {
        ...(userDirty ? { user: { base: data.claudeJson.user, servers: drafts.user ?? {} } } : {}),
        ...(localDirty ? { local: { base: data.claudeJson.local, servers: drafts.local ?? {} } } : {}),
      };
    }
    if (!save.files.length && !save.claudeJson) return true;
    setSaving(true);
    try {
      if (!(await window.looper.agentSettings.save(scope, save))) return false;
      const d = await window.looper.agentSettings.load(scope);
      setData(d);
      setDrafts(draftsOf(d));
      return true;
    } catch (e) {
      void window.looper.showError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const current = fileKey ? fileOf(fileKey) : undefined;

  return (
    <div className="editor">
      <div className="form agent-scope">
        <FormGroup>
          <FieldRow>
            <Field label="Project">
              <SelectInput
                value={scope.projectId ?? ''}
                onChange={(e) => {
                  const p = envProjects.find((x) => x.id === e.target.value);
                  if (!p) return void changeScope({ envId: env.id, harnessId: scope.harnessId });
                  const pEnv = envs.find((x) => x.id === p.environmentId);
                  if (!pEnv) return void window.looper.showError(`The project "${p.name}" is in an environment without a Claude Code or Codex harness.`);
                  const h = pEnv.harnesses.find((x) => x.id === p.harnessId && x.kind !== 'custom') ?? pEnv.harnesses.find((x) => x.kind !== 'custom')!;
                  void changeScope({ envId: pEnv.id, harnessId: h.id, projectId: p.id });
                }}
              >
                <option value="">None (user settings only)</option>
                {envProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Environment">
              <SelectInput
                value={env.id}
                disabled={!!scope.projectId}
                onChange={(e) => {
                  const next = envs.find((x) => x.id === e.target.value);
                  const h = next?.harnesses.find((x) => x.kind !== 'custom');
                  if (next && h) void changeScope({ envId: next.id, harnessId: h.id });
                }}
              >
                {envs.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Harness">
              <SelectInput value={scope.harnessId} onChange={(e) => void changeScope({ ...scope, harnessId: e.target.value })}>
                {harnesses.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </FieldRow>
        </FormGroup>
      </div>
      <TabBar tabs={TABS} active={tab} onSelect={setTab} className="editor-tabs" label="Agent Settings" />
      <div className="editor-body">
        {!data ? (
          <div className="empty">{loadError ?? 'Loading…'}</div>
        ) : tab === 'settings' ? (
          <div className="form agent-file">
            <FormGroup>
              <Field label="File">
                <SelectInput value={fileKey ?? ''} onChange={(e) => setFileKey(e.target.value as AgentFileKey)}>
                  {data.files.map((f) => (
                    <option key={f.key} value={f.key}>
                      {FILE_LABELS[f.key]}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </FormGroup>
            {current && (
              <>
                <div className="muted agent-path">{current.text === null ? `${current.path} (created on save)` : current.path}</div>
                <TextArea
                  code className="json-editor agent-text"
                  aria-label={FILE_LABELS[current.key]}
                  wrap="off"
                  value={drafts.files[current.key] ?? ''}
                  placeholder={isTomlFile(current.key) ? '' : '{}'}
                  onChange={(e) => setFile(current.key, e.target.value)}
                />
              </>
            )}
          </div>
        ) : tab === 'servers' ? (
          <div className="form env-tab">
            {problems.map((p) => (
              <div key={p} className="muted">
                {p}
              </div>
            ))}
            <SelectList
              items={servers}
              label="MCP servers"
              idPrefix="mcp"
              selectedKey={selected}
              itemKey={(s) => serverKey(s)}
              itemName={(s) => s.name}
              itemSub={(s) => `${MCP_SCOPE_LABELS[kind][s.scope]} · ${serverWhere(s)}`}
              onSelect={(s) => setSelected(serverKey(s))}
              onOpen={(s) => void editServer(s)}
              menu={(s) => [
                { label: 'Edit…', run: () => void editServer(s) },
                { label: 'Duplicate', run: () => void editServer(s, true) },
                { label: 'Remove', destructive: true, run: () => putServerDraft(s, null) },
              ]}
              onDelete={(s) => putServerDraft(s, null)}
              empty="No MCP servers"
            />
            <ListActions
              item="Server"
              onAdd={() => void editServer(null)}
              onEdit={() => selectedServer && void editServer(selectedServer)}
              editDisabled={!selectedServer}
              onDuplicate={() => selectedServer && void editServer(selectedServer, true)}
              duplicateDisabled={!selectedServer}
              onRemove={() => selectedServer && putServerDraft(selectedServer, null)}
              removeDisabled={!selectedServer}
            />
          </div>
        ) : (
          <div className="form">
            {kind === 'claude-code' && (
              <FormGroup>
                <Field label="Rules in">
                  <SelectInput value={rulesKey} onChange={(e) => setRulesKey(e.target.value as AgentFileKey)}>
                    {claudeFiles.map((k) => (
                      <option key={k} value={k}>
                        {FILE_LABELS[k]}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              </FormGroup>
            )}
            {problems.map((p) => (
              <div key={p} className="muted">
                {p}
              </div>
            ))}
            <div className="agent-perms" role="tree" aria-label="MCP permissions">
              {permServers.length === 0 && <div className="muted">No MCP servers</div>}
              {permServers.map((s) => {
                const key = serverKey(s);
                const open = expanded.has(key);
                const list = tools[key];
                return (
                  <div key={key} role="treeitem" aria-expanded={open}>
                    <div className="agent-perm-row">
                      <button type="button" className="btn small agent-perm-toggle" aria-label={open ? `Hide ${s.name}'s tools` : `Show ${s.name}'s tools`} onClick={() => toggle(s)}>
                        {open ? '−' : '+'}
                      </button>
                      <span className="agent-perm-name">
                        {s.name}
                        {kind === 'codex' && <span className="muted"> ({MCP_SCOPE_LABELS[kind][s.scope]})</span>}
                      </span>
                      <SelectInput aria-label={`${s.name}: permission`} value={permissionOf(s)} onChange={(e) => setPermission(s, undefined, e.target.value as McpPermission)}>
                        {options.map(([v, label]) => (
                          <option key={v} value={v}>
                            {label}
                          </option>
                        ))}
                      </SelectInput>
                      <span className="agent-perm-result">{resultText(effectiveOf(s))}</span>
                    </div>
                    {open && (
                      <div role="group">
                        {typeof list === 'string' || !list ? (
                          <div className="muted agent-perm-note">{list ?? 'Listing tools…'}</div>
                        ) : list.length === 0 ? (
                          <div className="muted agent-perm-note">The server offers no tools.</div>
                        ) : (
                          list.map((t) => (
                            <div key={t.name} className="agent-perm-row agent-perm-tool" role="treeitem" title={t.description}>
                              <span />
                              <span className="agent-perm-name mono">{t.name}</span>
                              <SelectInput aria-label={`${t.name}: permission`} value={permissionOf(s, t.name)} onChange={(e) => setPermission(s, t.name, e.target.value as McpPermission)}>
                                {options.map(([v, label]) => (
                                  <option key={v} value={v}>
                                    {v === 'default' ? 'Same as server' : label}
                                  </option>
                                ))}
                              </SelectInput>
                              <span className="agent-perm-result">{resultText(effectiveOf(s, t.name))}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <WindowActions
        confirm={{ label: 'Save', disabled: !data, run: () => void doSave().then((ok) => ok && window.close()) }}
        apply={{ disabled: !data || !dirty, run: () => void doSave() }}
        busy={saving}
      />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="editor">
      <div className="editor-body">
        <div className="empty">{text}</div>
      </div>
      <WindowActions close />
    </div>
  );
}
