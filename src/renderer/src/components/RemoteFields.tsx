import type { Environment, RemoteHelper, Task } from '@shared/types';
import { EFFORT_LEVELS, PERMISSION_MODES, harnessModels, pathFlavor } from '@shared/environments';
import { Field } from './ui';

/** What a helper or folder project runs with: the fields both editors share. A helper has no permission mode. */
export type RemoteFolderDraft = Pick<RemoteHelper, 'name' | 'environmentId' | 'harnessId' | 'cwd' | 'model' | 'effort'> & {
  permissionMode?: string;
};

/** The Claude Code harnesses of an environment: the only kind Remote Control runs. */
export const claudeHarnesses = (env: Environment | undefined) => env?.harnesses.filter((h) => h.kind === 'claude-code') ?? [];

/** Whether a task's agent runs on Claude Code (its harness, or its environment's first). */
export function isClaudeTask(task: Task, environments: Environment[]): boolean {
  const env = environments.find((e) => e.id === task.environmentId);
  const harness = task.agent.harnessId ? env?.harnesses.find((h) => h.id === task.agent.harnessId) : env?.harnesses[0];
  return harness?.kind === 'claude-code';
}

/** Name, environment, harness, model, effort, permission mode and folder of a helper or folder project. */
export function RemoteFolderFields({
  draft,
  environments,
  host,
  onChange,
}: {
  draft: RemoteFolderDraft;
  environments: Environment[];
  host?: string;
  onChange: (patch: Partial<RemoteFolderDraft>) => void;
}) {
  const env = environments.find((e) => e.id === draft.environmentId);
  const harnesses = claudeHarnesses(env);
  const harness = harnesses.find((h) => h.id === draft.harnessId) ?? harnesses[0];
  const models = harness ? harnessModels(harness) : [];
  const modelEntry = models.find((m) => m.id === draft.model);
  const kindEfforts = EFFORT_LEVELS['claude-code'];
  const efforts = modelEntry?.efforts ? kindEfforts.filter(([v]) => modelEntry.efforts!.includes(v)) : kindEfforts;
  const defaultEffort = modelEntry?.defaultEffort
    ? (kindEfforts.find(([v]) => v === modelEntry.defaultEffort)?.[1] ?? modelEntry.defaultEffort)
    : undefined;

  const browse = async () => {
    const picked = await window.looper.pickDirectory({
      current: draft.cwd || undefined,
      flavor: env ? pathFlavor(env, host) : undefined,
      distro: env?.kind === 'wsl' ? env.distro : undefined,
    });
    if (picked) onChange({ cwd: picked });
  };

  return (
    <>
      <Field label="Name">
        <input autoFocus value={draft.name} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>
      <Field label="Environment">
        <select
          value={draft.environmentId}
          onChange={(e) => onChange({ environmentId: e.target.value, harnessId: undefined, model: undefined, effort: undefined })}
        >
          {environments.map((e) => (
            <option key={e.id} value={e.id} disabled={claudeHarnesses(e).length === 0}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Harness">
        <select value={harness?.id ?? ''} onChange={(e) => onChange({ harnessId: e.target.value, model: undefined, effort: undefined })}>
          {harnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        <Field label="Model">
          <select value={draft.model ?? ''} onChange={(e) => onChange({ model: e.target.value || undefined, effort: undefined })}>
            <option value="">Default</option>
            {draft.model && !models.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Effort">
          <select value={draft.effort ?? ''} onChange={(e) => onChange({ effort: e.target.value || undefined })}>
            <option value="">{defaultEffort ? `Default (${defaultEffort})` : 'Default'}</option>
            {efforts.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {draft.permissionMode !== undefined && (
        <Field label="Permission mode">
          <select value={draft.permissionMode} onChange={(e) => onChange({ permissionMode: e.target.value })}>
            {PERMISSION_MODES['claude-code'].map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Working directory">
        <div className="browse-row">
          <input className="mono" value={draft.cwd} onChange={(e) => onChange({ cwd: e.target.value })} />
          <button className="btn" onClick={() => void browse()}>
            Browse…
          </button>
        </div>
      </Field>
    </>
  );
}

/** A helper or folder project's fields as saved: trimmed, and the harness pinned when the environment has one. */
export function foldDraft(draft: RemoteFolderDraft, environments: Environment[]): RemoteFolderDraft {
  const env = environments.find((e) => e.id === draft.environmentId);
  const harnesses = claudeHarnesses(env);
  const harnessId = harnesses.some((h) => h.id === draft.harnessId) ? draft.harnessId : harnesses[0]?.id;
  return { ...draft, name: draft.name.trim(), cwd: draft.cwd.trim(), harnessId };
}

/** Why a helper or folder project can't be saved yet; null when it can. */
export function draftProblem(draft: RemoteFolderDraft, environments: Environment[]): string | null {
  if (!draft.name.trim()) return 'Give it a name.';
  if (claudeHarnesses(environments.find((e) => e.id === draft.environmentId)).length === 0) {
    return 'Choose an environment with a Claude Code harness.';
  }
  if (!draft.cwd.trim()) return 'Choose the working directory.';
  return null;
}
