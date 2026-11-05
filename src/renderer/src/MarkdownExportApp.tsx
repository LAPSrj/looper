import { useEffect, useState } from 'react';
import { CheckboxField, FormGroup } from './components/ui';
import { WindowActions } from './components/WindowActions';

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

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <CheckboxField label="Include thinking" autoFocus checked={includeThinking} onChange={setIncludeThinking} />
            <CheckboxField label="Include tool usage" checked={includeTools} onChange={setIncludeTools} />
            <CheckboxField label="No formatting (plain text)" checked={plain} onChange={setPlain} />
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Save', run: save }} />
    </div>
  );
}
