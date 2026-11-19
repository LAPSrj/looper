import type { GitFileDiff } from '@shared/git';
import { DiffView } from './ToolContent';

/**
 * A file's diff, or why there's none to show: the Git tab's, and an addon's `diff` node. `file` names the
 * file for its highlighting (unset: `title`); the heading shows while there's a title or a subtitle.
 */
export function DiffPane({ title, subtitle, file, diff }: { title?: string; subtitle?: string; file?: string; diff: GitFileDiff | null }) {
  let body;
  if (!diff) body = <div className="muted git-diff-note">Loading…</div>;
  else if (diff.binary) body = <div className="muted git-diff-note">This is a binary file, so there are no lines to compare.</div>;
  else if (diff.hunks.length === 0) body = <div className="muted git-diff-note">No changed lines.</div>;
  else body = <DiffView hunks={diff.hunks} file={file ?? title} />;
  return (
    <div className="git-diff">
      {(title || subtitle) && (
        <div className="git-diff-head">
          {title && <span className="mono">{title}</span>}
          {subtitle && <span className="muted">{subtitle}</span>}
        </div>
      )}
      <div className="git-diff-body">
        {body}
        {diff?.truncated && <div className="muted git-diff-note">The diff is too long to show in full, so it stops here.</div>}
      </div>
    </div>
  );
}
