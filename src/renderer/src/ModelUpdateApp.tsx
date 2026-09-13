import { Fragment, useEffect, useRef, useState } from 'react';
import type { Environment, Harness, Settings, Task } from '@shared/types';
import { DEFAULT_MODELS, harnessModels, resolveClassifierHarness, resolveHarness, sameModels } from '@shared/environments';
import { applyModelUpdate, buildUpdateRows, type ModelAction, type ModelUpdateRow } from '@shared/model-update';
import { EditorFooter } from './components/ui';
import { useDialogKeys } from './components/hooks';

interface Group {
  envId: string;
  harnessId: string;
  label: string;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  rows: ModelUpdateRow[];
  actions: Record<string, ModelAction>;
  open: boolean;
  /** Models the row's id is used by, per task agent/classifier. */
  usedBy: Record<string, number>;
}

/** Tasks whose agent or classifier runs on this harness and names this model id. */
function usageCounts(tasks: Task[], env: Environment, harness: Harness): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (id?: string) => {
    if (id) counts[id] = (counts[id] ?? 0) + 1;
  };
  for (const t of tasks) {
    if (t.environmentId !== env.id) continue;
    try {
      if (resolveHarness(t, env).id === harness.id) bump(t.agent.model);
    } catch {
      /* unresolvable harness: nothing to count */
    }
    try {
      if (t.classifier && resolveClassifierHarness(t, env).id === harness.id) bump(t.classifier.model);
    } catch {
      /* no classifier-capable harness: nothing to count */
    }
  }
  return counts;
}

/** The task list's folder chevron, pointing right and rotating open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`mu-chev${open ? ' open' : ''}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 1.5 7 5l-3.5 3.5" />
    </svg>
  );
}

function rowNote(row: ModelUpdateRow, used: number): string {
  const parts: string[] = [];
  if (!row.inList) parts.push(row.main ? 'new' : 'available');
  if (row.inList && !row.supported) parts.push('no longer supported');
  if (row.inList && used > 0) parts.push(used === 1 ? 'used by 1 task' : `used by ${used} tasks`);
  return parts.join(' · ');
}

/**
 * Update Models window: discover each harness's current catalog and stage
 * additions/removals, one action select per model. Without ids it covers
 * every claude-code/codex harness (Advanced → Update Models…); with ids it
 * is scoped to one harness (Harness editor → Models → Update…).
 */
export function ModelUpdateApp({ envId, harnessId }: { envId?: string; harnessId?: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [saving, setSaving] = useState(false);
  const settingsRef = useRef<Settings | null>(null);
  settingsRef.current = settings;

  useEffect(() => {
    document.title = 'Update Models';
    let disposed = false;
    void Promise.all([window.looper.info(), window.looper.tasks.list()]).then(([info, tasks]) => {
      if (disposed) return;
      setSettings(info.settings);
      const scoped: Group[] = [];
      for (const env of info.settings.environments) {
        for (const h of env.harnesses) {
          if (h.kind === 'custom') continue;
          if (envId && (env.id !== envId || h.id !== harnessId)) continue;
          scoped.push({
            envId: env.id,
            harnessId: h.id,
            label: `${env.name} · ${h.name}`,
            status: 'loading',
            rows: [],
            actions: {},
            open: !!envId,
            usedBy: usageCounts(tasks, env, h),
          });
        }
      }
      setGroups(scoped);
      for (const g of scoped) {
        const env = info.settings.environments.find((x) => x.id === g.envId)!;
        const h = env.harnesses.find((x) => x.id === g.harnessId)!;
        void window.looper
          .discoverModels(g.envId, g.harnessId)
          .then((catalog) => {
            if (disposed) return;
            const rows = buildUpdateRows(h.kind, harnessModels(h), catalog);
            const suggested = rows.some((r) => r.suggested !== 'keep');
            patchGroup(g, { status: 'ready', rows, open: !!envId || suggested });
          })
          .catch((e: unknown) => {
            if (disposed) return;
            patchGroup(g, { status: 'error', error: (e as Error).message, open: false });
          });
      }
    });
    const offSettings = window.looper.onEvent((e) => {
      if (e.type === 'settings') setSettings(e.settings);
    });
    return () => {
      disposed = true;
      offSettings();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envId, harnessId]);

  const patchGroup = (g: { envId: string; harnessId: string }, p: Partial<Group>) =>
    setGroups((gs) => gs.map((x) => (x.envId === g.envId && x.harnessId === g.harnessId ? { ...x, ...p } : x)));

  const doUpdate = async () => {
    const s = settingsRef.current;
    if (!s) return;
    const environments = s.environments.map((env) => ({
      ...env,
      harnesses: env.harnesses.map((h) => {
        const g = groups.find((x) => x.envId === env.id && x.harnessId === h.id && x.status === 'ready');
        if (!g) return h;
        const next = applyModelUpdate(harnessModels(h), g.rows, g.actions);
        const models = sameModels(next, DEFAULT_MODELS[h.kind]) ? undefined : next;
        return { ...h, models };
      }),
    }));
    setSaving(true);
    try {
      await window.looper.updateSettings({ environments });
      window.close();
    } catch (e) {
      void window.looper.showError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  useDialogKeys({ onSave: () => void doUpdate(), onCancel: () => window.close() });

  if (!settings) return <div className="empty">Loading…</div>;
  if (groups.length === 0) return <div className="empty">No Claude Code or Codex harnesses.</div>;

  const loading = groups.some((g) => g.status === 'loading');

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="mu-list">
          {groups.map((g) => {
            const expandable = g.status === 'ready' && g.rows.length > 0;
            const toggle = (open: boolean) => patchGroup(g, { open });
            return (
            <Fragment key={`${g.envId}/${g.harnessId}`}>
              <div
                className="mu-group"
                role={expandable ? 'button' : undefined}
                tabIndex={expandable ? 0 : undefined}
                aria-expanded={expandable ? g.open : undefined}
                onClick={expandable ? () => toggle(!g.open) : undefined}
                onKeyDown={
                  expandable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') toggle(!g.open);
                        else if (e.key === 'ArrowRight') toggle(true);
                        else if (e.key === 'ArrowLeft') toggle(false);
                        else return;
                        e.preventDefault();
                      }
                    : undefined
                }
              >
                {expandable ? <Chevron open={g.open} /> : <span className="mu-chev-space" />}
                <span className="mu-group-name">{g.label}</span>
                {g.status === 'loading' && <span className="mu-group-note">checking…</span>}
                {g.status === 'error' && (
                  <>
                    <span className="mu-group-note">{g.error}</span>
                    <button
                      className="link"
                      onClick={(e) => {
                        e.stopPropagation();
                        void window.looper.showError(`${g.label}: ${g.error ?? ''}`);
                      }}
                    >
                      Details…
                    </button>
                  </>
                )}
              </div>
              {g.open &&
                g.rows.map((row) => {
                  const action = g.actions[row.id] ?? row.suggested;
                  const greyed = action === 'keep' && !row.inList;
                  const note = rowNote(row, g.usedBy[row.id] ?? 0);
                  return (
                    <div key={row.id} className={`mu-item${greyed ? ' muted' : ''}`}>
                      <div className="mu-item-main">
                        <div className="mu-item-name">{row.name}</div>
                        <div className="mu-item-sub">
                          {row.id}
                          {note && ` · ${note}`}
                        </div>
                      </div>
                      <select
                        value={action}
                        onChange={(e) =>
                          patchGroup(g, { actions: { ...g.actions, [row.id]: e.target.value as ModelAction } })
                        }
                      >
                        {row.inList ? <option value="remove">Remove</option> : <option value="add">Add</option>}
                        <option value="keep">Do nothing</option>
                      </select>
                    </div>
                  );
                })}
            </Fragment>
            );
          })}
        </div>
      </div>
      <EditorFooter
        primaryLabel="Update"
        onPrimary={() => void doUpdate()}
        onCancel={() => window.close()}
        saving={saving}
        primaryDisabled={loading}
      />
    </div>
  );
}
