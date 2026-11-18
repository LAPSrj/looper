import { useEffect, useState } from 'react';
import { EmptyWindow, Field, FormGroup, TextInput } from './ui';
import { WindowActions } from './WindowActions';
import { useLiveItem, useSave, type ItemSource } from './hooks';

/**
 * A rename window: the item's name, selected, and Save. It keeps the typed name
 * while the item changes, and says `gone` once the item is.
 */
export function RenameWindow<T extends { id: string }>({
  title,
  source,
  id,
  nameOf,
  rename,
  gone,
  allowEmpty,
  maxLength,
}: {
  title: string;
  source: ItemSource<T>;
  id: string;
  nameOf: (item: T) => string;
  rename: (name: string) => Promise<unknown>;
  gone: string;
  /** An empty name can be saved (it goes back to the automatic one). */
  allowEmpty?: boolean;
  maxLength?: number;
}) {
  const [name, setName] = useState('');
  const [loaded, setLoaded] = useState(false);
  const { missing } = useLiveItem(source, id, (item) => {
    setName(nameOf(item));
    setLoaded(true);
  });
  const saver = useSave();

  useEffect(() => {
    document.title = title;
  }, [title]);

  if (missing) return <EmptyWindow gone={gone} />;

  const blank = !allowEmpty && !name.trim();
  const save = () => {
    if (!blank) saver.save(() => rename(name).then(() => true));
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label="Name">
              <TextInput selectWhen={loaded} autoFocus value={name} maxLength={maxLength} onChange={(e) => setName(e.target.value)} />
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Save', run: save, disabled: blank }} busy={saver.busy} />
    </div>
  );
}
