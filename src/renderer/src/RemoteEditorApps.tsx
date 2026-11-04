import { useEffect, useState } from 'react';
import type { RemoteHelper, Settings } from '@shared/types';
import { SettingsSchema } from '@shared/types';
import { REPORT_INPUT, issueLines } from '@shared/issues';
import { EmptyWindow, Field, NumberField } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { useDiscardUnsaved, useLiveSettings } from './components/hooks';
import { useFitWindow } from './fit-window';
import { AgentFields, draftProblem, foldDraft, type RemoteFolderDraft } from './components/RemoteFields';

/**
 * Save a changed Remote Control helper list through the full settings
 * schema, so a bad value is reported before anything is written. True when saved.
 */
async function saveRemote(live: Settings, remote: Settings['remote']): Promise<boolean> {
  const parsed = SettingsSchema.safeParse({ ...live, remote }, REPORT_INPUT);
  if (!parsed.success) {
    void window.looper.showError(issueLines(parsed.error));
    return false;
  }
  try {
    await window.looper.updateSettings({ remote: parsed.data.remote });
    return true;
  } catch (e) {
    void window.looper.showError((e as Error).message);
    return false;
  }
}

/** Advanced → Remote Control → Helpers → Add/Edit. */
export function RemoteHelperEditorApp({ id, isNew }: { id: string; isNew?: boolean }) {
  const { live, host, missing } = useLiveSettings((s) => s.remote.helpers.some((h) => h.id === id));
  const [draft, setDraft] = useState<(RemoteFolderDraft & Pick<RemoteHelper, 'idleRestartMin' | 'instructions'>) | null>(null);
  const [saving, setSaving] = useState(false);
  const savedRef = useDiscardUnsaved(isNew, () => window.looper.remote.discard(id));
  useFitWindow();

  useEffect(() => {
    if (!live || draft) return;
    const h = live.remote.helpers.find((x) => x.id === id);
    if (!h) return;
    const { name, environmentId, harnessId, cwd, model, effort, idleRestartMin, instructions } = h;
    setDraft({ name, environmentId, harnessId, cwd, model, effort, idleRestartMin, instructions });
  }, [live, draft, id]);

  useEffect(() => {
    document.title = isNew ? 'New Helper' : 'Edit Helper';
  }, [isNew]);

  if (missing || !live || !draft) return <EmptyWindow gone={missing && 'This helper no longer exists.'} />;

  const doSave = async (): Promise<boolean> => {
    const problem = draftProblem(draft, live.environments);
    if (problem) {
      void window.looper.showError(problem);
      return false;
    }
    const { idleRestartMin, instructions, ...fields } = draft;
    const helpers = live.remote.helpers.map((h) => (h.id === id ? { ...h, ...foldDraft(fields, live.environments), idleRestartMin, instructions } : h));
    setSaving(true);
    const ok = await saveRemote(live, { ...live.remote, helpers });
    setSaving(false);
    if (ok) savedRef.current = true;
    return ok;
  };
  const save = async () => {
    if (await doSave()) window.close();
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <AgentFields
            draft={draft}
            environments={live.environments}
            host={host}
            harnesses="claude-code"
            onChange={(p) => setDraft((d) => (d ? { ...d, ...p } : d))}
          />
          <NumberField
            label="Restart when idle for"
            suffix="min"
            min={1}
            value={draft.idleRestartMin}
            onChange={(n) => setDraft((d) => (d ? { ...d, idleRestartMin: n } : d))}
          />
          <Field label="Instructions">
            <textarea rows={5} value={draft.instructions} onChange={(e) => setDraft((d) => (d ? { ...d, instructions: e.target.value } : d))} />
          </Field>
        </div>
      </div>
      <WindowActions confirm={{ label: isNew ? 'Create' : 'Save', run: () => void save() }} apply={isNew ? undefined : { run: () => void doSave() }} busy={saving} />
    </div>
  );
}

