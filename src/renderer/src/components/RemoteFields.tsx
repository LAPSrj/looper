import { Fragment, type ReactNode } from 'react';
import type { Environment, Harness, RemoteHelper } from '@shared/types';
import { EFFORT_LEVELS, PERMISSION_MODES, harnessKindLabel, harnessModels, pathFlavor } from '@shared/environments';
import { AGENT_LABELS, agentRows, type AgentField } from './agent-fields-model';
import { Field, InputRow } from './ui';

/** What a helper runs with. A helper has no permission mode. */
export type RemoteFolderDraft = Pick<RemoteHelper, 'name' | 'environmentId' | 'harnessId' | 'cwd' | 'model' | 'effort'> & {
  permissionMode?: string;
};

/**
 * The agent fields an editor draws: a field the draft doesn't have isn't shown
 * (no `name`: no Name field; no `mode`: no Session type; no `permissionMode`: no Permission mode).
 */
export interface AgentDraft {
  name?: string;
  environmentId: string;
  harnessId?: string;
  cwd: string;
  model?: string;
  effort?: string;
  mode?: 'interactive' | 'headless';
  permissionMode?: string;
}

/** The Claude Code harnesses of an environment: the only kind Remote Control runs. */
export const claudeHarnesses = (env: Environment | undefined) => env?.harnesses.filter((h) => h.kind === 'claude-code') ?? [];

/** Which harnesses an editor offers: Remote Control runs Claude Code only, a task builder the two agents, a project any. */
export type HarnessChoice = 'claude-code' | 'agents' | 'any';

export const offeredHarnesses = (env: Environment | undefined, choice: HarnessChoice): Harness[] =>
  env?.harnesses.filter((h) => (choice === 'claude-code' ? h.kind === 'claude-code' : choice === 'agents' ? h.kind !== 'custom' : true)) ?? [];

/** An editor's own handling of a pick, in place of AgentFields' patch (the task editor keeps a model the new harness also knows). */
export type AgentPicks = Partial<Record<'environment' | 'harness' | 'model', (id: string) => void>>;

/**
 * Name, working directory, environment, harness, model, effort, session type
 * and permission mode, in the one order and rows every editor uses (agentRows).
 */
export function AgentFields({
  draft,
  environments,
  host,
  harnesses: choice,
  namePlaceholder,
  onBrowsed,
  onChange,
  fields,
  customModel,
  lockCwd,
  pick,
  fallbackHarness,
  modelRequired,
  defaultMode = 'interactive',
}: {
  draft: AgentDraft;
  environments: Environment[];
  host?: string;
  harnesses: HarnessChoice;
  namePlaceholder?: string;
  /** Other fields the picked folder sets (a project's name, when it has none). */
  onBrowsed?: (picked: string) => Partial<AgentDraft>;
  onChange: (patch: Partial<AgentDraft>) => void;
  /** Draw only these, in their rows (the task editor has the folder and environment on General, the rest on Agent). */
  fields?: AgentField[];
  /**
   * A Custom… choice after the presets, with a Model id box beside it while
   * the model isn't a preset or Custom… is picked (`pinned`, kept by the editor).
   */
  customModel?: { pinned: boolean; onPin: (pinned: boolean) => void };
  /** The working directory is the project's: shown, not edited. */
  lockCwd?: boolean;
  pick?: AgentPicks;
  /** The harness shown while the draft names none, when it isn't the environment's first (the classifier's). */
  fallbackHarness?: Harness;
  /** No Default model: the draft always runs a named one (the classifier's). */
  modelRequired?: boolean;
  /** The session type that runs when the draft has none, marked "(default)". */
  defaultMode?: 'interactive' | 'headless';
}) {
  const env = environments.find((e) => e.id === draft.environmentId);
  const offered = offeredHarnesses(env, choice);
  const harness = offered.find((h) => h.id === draft.harnessId) ?? fallbackHarness ?? offered[0];
  const kind = harness && harness.kind !== 'custom' ? harness.kind : undefined;
  const models = harness ? harnessModels(harness) : [];
  const isCustom = !!customModel && (customModel.pinned || (!!draft.model && !models.some((m) => m.id === draft.model)));
  // A custom model has no entry: the kind's full effort list, and Default is the CLI's own.
  const modelEntry = isCustom ? undefined : models.find((m) => m.id === draft.model);
  const kindEfforts = kind ? EFFORT_LEVELS[kind] : [];
  const efforts = modelEntry?.efforts ? kindEfforts.filter(([v]) => modelEntry.efforts!.includes(v)) : kindEfforts;
  const defaultEffort = modelEntry?.defaultEffort
    ? (kindEfforts.find(([v]) => v === modelEntry.defaultEffort)?.[1] ?? modelEntry.defaultEffort)
    : undefined;
  const modes = kind ? PERMISSION_MODES[kind] : [];
  const headlessNotes = [kind === 'codex' && 'codex exec', defaultMode === 'headless' && 'default'].filter(Boolean);

  const browse = async () => {
    const picked = await window.looper.pickDirectory({
      current: draft.cwd || undefined,
      flavor: env ? pathFlavor(env, host) : undefined,
      distro: env?.kind === 'wsl' ? env.distro : undefined,
    });
    if (picked) onChange({ cwd: picked, ...onBrowsed?.(picked) });
  };

  /** Another harness has its own models, efforts and permission modes: the draft's go back to the defaults. */
  const pickHarness = (envId: string, harnessId?: string) => {
    const nextEnv = environments.find((e) => e.id === envId);
    const next = offeredHarnesses(nextEnv, choice);
    const h = next.find((x) => x.id === harnessId) ?? next[0];
    const k = h && h.kind !== 'custom' ? h.kind : undefined;
    const keepMode = draft.permissionMode === undefined || !k || PERMISSION_MODES[k].some(([v]) => v === draft.permissionMode);
    onChange({ environmentId: envId, harnessId: h?.id, model: undefined, effort: undefined, ...(keepMode ? {} : { permissionMode: 'auto' }) });
  };

  const rows = agentRows({ name: draft.name !== undefined, models: !!kind, mode: draft.mode !== undefined, permission: draft.permissionMode !== undefined && !!kind })
    .map((row) => row.filter((f) => !fields || fields.includes(f)))
    .filter((row) => row.length > 0);
  const label = (f: AgentField) => AGENT_LABELS[f];
  const pickModel = (id: string) => (pick?.model ? pick.model(id) : onChange({ model: id || undefined, effort: undefined }));

  const field = (f: AgentField, firstInForm: boolean): ReactNode => {
    switch (f) {
      case 'name':
        return (
          <Field key={f} label={label(f)}>
            <input autoFocus value={draft.name} placeholder={namePlaceholder} onChange={(e) => onChange({ name: e.target.value })} />
          </Field>
        );
      case 'cwd':
        return (
          <Field key={f} label={label(f)}>
            <InputRow>
              <input className="mono" autoFocus={firstInForm} disabled={lockCwd} value={draft.cwd} onChange={(e) => onChange({ cwd: e.target.value })} />
              <button className="btn" disabled={lockCwd} onClick={() => void browse()}>
                Browse…
              </button>
            </InputRow>
          </Field>
        );
      case 'environment':
        return (
          <Field key={f} label={label(f)}>
            <select value={draft.environmentId} onChange={(e) => (pick?.environment ? pick.environment(e.target.value) : pickHarness(e.target.value))}>
              {!env && <option value={draft.environmentId}>Unknown environment ({draft.environmentId || 'none'})</option>}
              {environments.map((e) => (
                <option key={e.id} value={e.id} disabled={choice !== 'any' && offeredHarnesses(e, choice).length === 0}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
        );
      case 'harness':
        return (
          <Field key={f} label={label(f)}>
            <select
              value={harness?.id ?? ''}
              disabled={!offered.length}
              onChange={(e) => (pick?.harness ? pick.harness(e.target.value) : pickHarness(draft.environmentId, e.target.value))}
            >
              {!offered.length && <option value="">No harnesses in this environment</option>}
              {offered.map((h) => (
                <option key={h.id} value={h.id}>
                  {choice === 'any' ? `${h.name} (${harnessKindLabel(h.kind)})` : h.name}
                </option>
              ))}
            </select>
          </Field>
        );
      case 'model':
        return (
          <Fragment key={f}>
            <Field label={label(f)}>
              <select
                value={isCustom ? 'custom' : (draft.model ?? '')}
                onChange={(e) => {
                  if (e.target.value === 'custom') return customModel?.onPin(true);
                  customModel?.onPin(false);
                  pickModel(e.target.value);
                }}
              >
                {!modelRequired && <option value="">Default</option>}
                {!customModel && draft.model && !modelEntry && <option value={draft.model}>{draft.model}</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
                {customModel && <option value="custom">Custom…</option>}
              </select>
            </Field>
            {isCustom && (
              <Field label="Model id">
                <input
                  className="mono"
                  value={draft.model ?? ''}
                  placeholder="model id"
                  onChange={(e) => {
                    // Emptied to type another id: the box stays.
                    customModel?.onPin(true);
                    onChange({ model: e.target.value || undefined });
                  }}
                />
              </Field>
            )}
          </Fragment>
        );
      case 'effort':
        if (!efforts.length) return null;
        return (
          <Field key={f} label={label(f)}>
            <select value={draft.effort ?? ''} onChange={(e) => onChange({ effort: e.target.value || undefined })}>
              <option value="">{defaultEffort ? `Default (${defaultEffort})` : 'Default'}</option>
              {draft.effort && !efforts.some(([v]) => v === draft.effort) && <option value={draft.effort}>{draft.effort}</option>}
              {efforts.map(([v, text]) => (
                <option key={v} value={v}>
                  {text}
                </option>
              ))}
            </select>
          </Field>
        );
      case 'mode':
        return (
          <Field key={f} label={label(f)}>
            <select value={draft.mode} onChange={(e) => onChange({ mode: e.target.value as 'interactive' | 'headless' })}>
              <option value="interactive">Interactive terminal{defaultMode === 'interactive' ? ' (default)' : ''}</option>
              <option value="headless">Headless{headlessNotes.length ? ` (${headlessNotes.join(', ')})` : ''}</option>
            </select>
          </Field>
        );
      case 'permission':
        return (
          <Field key={f} label={label(f)}>
            <select value={draft.permissionMode} onChange={(e) => onChange({ permissionMode: e.target.value })}>
              {modes.map(([v, text]) => (
                <option key={v} value={v}>
                  {text}
                </option>
              ))}
            </select>
          </Field>
        );
    }
  };

  return (
    <>
      {rows.map((row, r) =>
        row.length === 1 && (row[0] === 'name' || row[0] === 'cwd') ? (
          // A part of the fields (`fields`) sits among the editor's own, which has its own first field.
          field(row[0], r === 0 && !fields)
        ) : (
          <div className="row" key={row.join('-')}>
            {row.map((f) => field(f, false))}
          </div>
        ),
      )}
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
