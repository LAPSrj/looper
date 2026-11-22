import { useContext } from 'react';
import type { GitFileDiff } from '@shared/git';
import { isPhone } from '../web/page-nav';
import { NavBar, BarHostContext } from './NavBar';
import { DiffView } from './ToolContent';

/**
 * A file's diff, or why there's none to show: the Git tab's, and an addon's `diff` node. `file` names the
 * file for its highlighting (unset: `title`); the heading shows while there's a title or a subtitle. `bar`: the
 * screen's bar already names the file, so on a phone the heading's rest (the change and the folder) is the bar's
 * subtitle (ios.md: Navigation bar) and the pane draws no heading; a sheet that draws its own bar keeps the heading.
 */
export function DiffPane({ title, subtitle, file, diff, bar = false }: { title?: string; subtitle?: string; file?: string; diff: GitFileDiff | null; bar?: boolean }) {
  const host = useContext(BarHostContext);
  const inBar = bar && isPhone && !host && !!(title || subtitle);
  const folder = title?.includes('/') ? title.slice(0, title.lastIndexOf('/')) : '';
  const forms = [subtitle && folder ? `${subtitle} · ${folder}` : '', subtitle || folder].filter(Boolean);
  let body;
  if (!diff) body = <div className="muted diff-pane-note">Loading…</div>;
  else if (diff.binary) body = <div className="muted diff-pane-note">This is a binary file, so there are no lines to compare.</div>;
  else if (diff.hunks.length === 0) body = <div className="muted diff-pane-note">No changed lines.</div>;
  else body = <DiffView hunks={diff.hunks} file={file ?? title} />;
  return (
    <div className="diff-pane">
      {inBar && <NavBar subtitle={forms} order={50} />}
      {(title || subtitle) && !inBar && (
        <div className="diff-pane-head">
          {title && <span className="mono">{title}</span>}
          {subtitle && <span className="muted">{subtitle}</span>}
        </div>
      )}
      <div className="diff-pane-body">
        {body}
        {diff?.truncated && <div className="muted diff-pane-note">The diff is too long to show in full, so it stops here.</div>}
      </div>
    </div>
  );
}
