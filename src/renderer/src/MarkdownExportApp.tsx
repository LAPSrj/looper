import { useEffect, useState } from 'react';
import { useDialogKeys } from './components/hooks';
import { EditorFooter } from './components/ui';

/**
 * Export options for "Save as Markdown", shown after the save location is
 * chosen (the native save dialog cannot carry checkboxes). Save hands the
 * choice to the main process, which writes the file and closes this window.
 */
export function MarkdownExportApp({
  includeThinking: thinking0,
  includeTools: tools0,
  plain: plain0,
}: {
  includeThinking: boolean;
  includeTools: boolean;
  plain: boolean;
}) {
  const [includeThinking, setIncludeThinking] = useState(thinking0);
  const [includeTools, setIncludeTools] = useState(tools0);
  const [plain, setPlain] = useState(plain0);

  useEffect(() => {
    document.title = 'Export Options';
  }, []);

  const save = () => window.looper.applyMarkdownExport({ includeThinking, includeTools, plain });
  useDialogKeys({ onSave: save, onCancel: () => window.close() });

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <label className="checkbox-field">
            <input type="checkbox" checked={includeThinking} onChange={(e) => setIncludeThinking(e.target.checked)} />
            Include thinking
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={includeTools} onChange={(e) => setIncludeTools(e.target.checked)} />
            Include tool usage
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={plain} onChange={(e) => setPlain(e.target.checked)} />
            No formatting (plain text)
          </label>
        </div>
      </div>
      <EditorFooter primaryLabel="Save" onPrimary={save} onCancel={() => window.close()} />
    </div>
  );
}
