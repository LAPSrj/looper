import { Fragment, useEffect, useState } from 'react';
import type { Environment, Harness, Task } from '@shared/types';
import { DEFAULT_MODELS, harnessModels, resolveClassifierHarness, resolveHarness, sameModels } from '@shared/environments';
import { capFirst, plural } from '@shared/format';
import { applyModelUpdate, buildUpdateRows, hasModelChange, type ModelAction, type ModelUpdateRow } from '@shared/model-update';
import { GroupHeader } from './components/GroupHeader';
import { groupKeys } from './components/group-keys';
import { EmptyWindow, Field, FormGroup, SelectInput } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { useLiveSettings, useSave } from './components/hooks';

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

function rowNote(row: ModelUpdateRow, used: number): string {
  const parts: string[] = [];
  if (!row.inList) parts.push(row.main ? 'new' : 'available');
  if (row.inList && !row.supported) parts.push('no longer supported');
  if (row.inList && used > 0) parts.push(`used by ${plural(used, 'task')}`);
  return parts.join(' · ');
}

/**
 * Update Models window: discover each harness's current catalog and stage
 * additions/removals, one action select per model. Without ids it covers
 * every claude-code/codex harness (Advanced → Update Models…); with ids it
 * is scoped to one harness (Harness editor → Models → Update…).
 */
export function ModelUpdateApp({ envId, harnessId }: { envId?: string; harnessId?: string }) {
  const { live: settings } = useLiveSettings();
  const [groups, setGroups] = useState<Group[]>([]);
  const saver = useSave();

  useEffect(() => {
    document.title = 'Update Models';
    let disposed = false;
    void Promise.all([window.looper.info(), window.looper.tasks.list()]).then(([info, tasks]) => {
      if (disposed) return;
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
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envId, harnessId]);

  const patchGroup = (g: { envId: string; harnessId: string }, p: Partial<Group>) =>
    setGroups((gs) => gs.map((x) => (x.envId === g.envId && x.harnessId === g.harnessId ? { ...x, ...p } : x)));

  const doUpdate = async () => {
    if (!settings) return false;
    const environments = settings.environments.map((env) => ({
      ...env,
      harnesses: env.harnesses.map((h) => {
        const g = groups.find((x) => x.envId === env.id && x.harnessId === h.id && x.status === 'ready');
        if (!g) return h;
        const next = applyModelUpdate(harnessModels(h), g.rows, g.actions);
        const models = sameModels(next, DEFAULT_MODELS[h.kind]) ? undefined : next;
        return { ...h, models };
      }),
    }));
    await window.looper.updateSettings({ environments });
  };

  if (!settings || groups.length === 0) return <EmptyWindow gone={settings && 'No Claude Code or Codex harnesses.'} />;

  const loading = groups.some((g) => g.status === 'loading');

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="mu-list" role="tree" aria-label="Harnesses">
          {groups.map((g) => {
            const expandable = g.status === 'ready' && g.rows.length > 0;
            const open = expandable && g.open;
            const toggle = (next: boolean) => expandable && patchGroup(g, { open: next });
            return (
              <Fragment key={`${g.envId}/${g.harnessId}`}>
                <GroupHeader
                  name={g.label}
                  open={open}
                  className="mu-group"
                  tabIndex={0}
                  aria-disabled={!expandable || undefined}
                  onToggle={() => toggle(!g.open)}
                  onKeyDown={groupKeys(g.open, toggle)}
                >
                  {g.status === 'loading' && <span className="mu-group-note">checking…</span>}
                  {g.status === 'error' && (
                    <>
                      <span className="mu-group-note">{capFirst(g.error ?? '')}</span>
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
                </GroupHeader>
                {open && (
                  <div role="group" className="mu-rows">
                    <FormGroup>
                      {g.rows.map((row) => {
                        const note = rowNote(row, g.usedBy[row.id] ?? 0);
                        return (
                          <Field key={row.id} label={row.name} help={note ? `${row.id} · ${note}` : row.id}>
                            <SelectInput value={g.actions[row.id] ?? row.suggested} onChange={(e) => patchGroup(g, { actions: { ...g.actions, [row.id]: e.target.value as ModelAction } })}>
                              {row.inList ? <option value="remove">Remove</option> : <option value="add">Add</option>}
                              <option value="keep">Do nothing</option>
                            </SelectInput>
                          </Field>
                        );
                      })}
                    </FormGroup>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
      <WindowActions
        confirm={{
          label: 'Update',
          run: () => saver.save(doUpdate),
          disabled: loading || !groups.some((g) => g.status === 'ready' && hasModelChange(g.rows, g.actions)),
        }}
        busy={saver.busy}
      />
    </div>
  );
}
