import { useEffect, useState } from 'react';
import type { RemoteHelper } from '@shared/types';
import { EmptyWindow, Field, FormGroup, NumberField, TextArea } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { saveSettings, useDiscardUnsaved, useLiveSettings, useSave } from './components/hooks';
import { AgentFields, draftProblem, foldDraft, type RemoteFolderDraft } from './components/RemoteFields';

/** Advanced → Remote Control → Helpers → Add/Edit. */
export function RemoteHelperEditorApp({ id, isNew }: { id: string; isNew?: boolean }) {
  const { live, host, missing } = useLiveSettings((s) => s.remote.helpers.some((h) => h.id === id));
  const [draft, setDraft] = useState<(RemoteFolderDraft & Pick<RemoteHelper, 'idleRestartMin' | 'instructions'>) | null>(null);
  const saver = useSave();
  const savedRef = useDiscardUnsaved(isNew, () => window.looper.remote.discard(id));

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

  const doSave = async () => {
    const problem = draftProblem(draft, live.environments);
    if (problem) {
      void window.looper.showError(problem);
      return false;
    }
    const { idleRestartMin, instructions, ...fields } = draft;
    const helpers = live.remote.helpers.map((h) => (h.id === id ? { ...h, ...foldDraft(fields, live.environments), idleRestartMin, instructions } : h));
    await saveSettings(live, { remote: { ...live.remote, helpers } });
    savedRef.current = true;
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
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
          </FormGroup>
          <FormGroup>
            <Field label="Instructions">
              <TextArea rows={5} value={draft.instructions} onChange={(e) => setDraft((d) => (d ? { ...d, instructions: e.target.value } : d))} />
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions
        draft={draft}
        confirm={{ label: isNew ? 'Create' : 'Save', run: () => saver.save(doSave) }}
        apply={isNew ? undefined : { run: () => void saver.apply(doSave) }}
        busy={saver.busy}
      />
    </div>
  );
}

