import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHANGE_LABELS,
  branchText,
  changeText,
  type GitChange,
  type GitCommit,
  type GitCommitDetail,
  type GitFileChange,
  type GitFileDiff,
  type GitStatus,
  type GitStatusResult,
} from '@shared/git';
import { fmtDateTime } from '../format';
import { useListNav } from './hooks';
import { DiffView } from './ToolContent';
import { TabBar } from './ui';

type Tab = 'changes' | 'history';

const PAGE = 200;
const POLL_MS = 5000;

const baseName = (p: string) => p.split('/').pop() || p;
const dirName = (p: string) => p.slice(0, Math.max(0, p.length - baseName(p).length - 1));
const fail = (e: unknown) => void window.looper.showError((e as Error).message);

/** One file in a list: its name, its folder, and what happened to it. */
function FileRow({
  id,
  path,
  origPath,
  status,
  selected,
  onSelect,
  onMenu,
}: {
  id: string;
  path: string;
  origPath?: string;
  status: string;
  selected: boolean;
  onSelect: () => void;
  onMenu: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={`git-file${selected ? ' selected' : ''}`}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        onMenu();
      }}
    >
      <div className="git-file-name">
        <span>{baseName(path)}</span>
        <span className="muted git-file-status">{status}</span>
      </div>
      <div className="muted mono git-file-dir">{origPath ? `from ${origPath}` : dirName(path) || ' '}</div>
    </div>
  );
}

/** A file's diff, or why there's none to show. */
function DiffPane({ title, subtitle, diff, loading }: { title?: string; subtitle?: string; diff: GitFileDiff | null; loading: boolean }) {
  if (!title) return <div className="empty">Select a file to see its changes.</div>;
  let body;
  if (!diff) body = <div className="muted git-diff-note">{loading ? 'Loading…' : ''}</div>;
  else if (diff.binary) body = <div className="muted git-diff-note">This is a binary file, so there are no lines to compare.</div>;
  else if (diff.hunks.length === 0) body = <div className="muted git-diff-note">No changed lines.</div>;
  else body = <DiffView hunks={diff.hunks} />;
  return (
    <div className="git-diff">
      <div className="git-diff-head">
        <span className="mono">{title}</span>
        {subtitle && <span className="muted">{subtitle}</span>}
      </div>
      <div className="git-diff-body">
        {body}
        {diff?.truncated && <div className="muted git-diff-note">The diff is too long to show in full, so it stops here.</div>}
      </div>
    </div>
  );
}

/** Uncommitted changes: the files on the left, the selected one's diff against HEAD on the right. */
function ChangesView({ projectId, status }: { projectId: string; status: GitStatus }) {
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ key: string; diff: GitFileDiff } | null>(null);
  const changes = status.changes;
  const current = changes.find((c) => c.path === sel) ?? changes[0];
  // A change's diff is read again whenever the status says something changed.
  const statusKey = JSON.stringify(changes);
  const key = current ? `${current.path}\n${current.kind}\n${statusKey}` : '';
  useEffect(() => {
    if (!current) return;
    let live = true;
    window.looper.git
      .changeDiff(projectId, { path: current.path, origPath: current.origPath, kind: current.kind }, status.initial)
      .then((d) => live && setDiff({ key, diff: d }))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, projectId]);
  const index = current ? changes.indexOf(current) : -1;
  const onKey = useListNav({
    count: changes.length,
    index,
    onIndex: (i) => setSel(changes[i].path),
    scrollToId: current ? `change-${index}` : null,
  });
  if (changes.length === 0) return <div className="empty">There are no uncommitted changes.</div>;
  const menu = (c: GitChange) =>
    window.looper.git.showFileMenu({ projectId, root: status.root, path: c.path, exists: c.kind !== 'deleted' });
  return (
    <div className="git-columns two">
      <div className="git-list" role="listbox" tabIndex={0} onKeyDown={onKey} aria-label="Changes">
        {changes.map((c, i) => (
          <FileRow
            key={c.path}
            id={`change-${i}`}
            path={c.path}
            origPath={c.origPath}
            status={changeText(c)}
            selected={c === current}
            onSelect={() => setSel(c.path)}
            onMenu={() => menu(c)}
          />
        ))}
      </div>
      <DiffPane
        title={current?.path}
        subtitle={current ? changeText(current) : undefined}
        diff={diff && diff.key === key ? diff.diff : null}
        loading={!!current}
      />
    </div>
  );
}

/** The commit's message, author and date, and the files it changed. */
function CommitDetail({
  projectId,
  root,
  detail,
  file,
  onFile,
}: {
  projectId: string;
  root: string;
  detail: GitCommitDetail;
  file: GitFileChange | undefined;
  onFile: (path: string) => void;
}) {
  const index = file ? detail.files.indexOf(file) : -1;
  const onKey = useListNav({
    count: detail.files.length,
    index,
    onIndex: (i) => onFile(detail.files[i].path),
    scrollToId: index >= 0 ? `commit-file-${index}` : null,
  });
  return (
    <div className="git-commit-detail">
      <div className="git-commit-head">
        <div className="git-commit-subject">{detail.subject}</div>
        {detail.body && <div className="git-commit-body">{detail.body}</div>}
        <div className="muted">
          {detail.author} &lt;{detail.email}&gt;
        </div>
        <div className="muted">{fmtDateTime(detail.at)}</div>
        <div className="muted mono">{detail.hash}</div>
        {detail.refs.length > 0 && <div className="muted">{detail.refs.join(', ')}</div>}
      </div>
      <div className="pane-title git-files-title">{detail.files.length === 1 ? '1 file' : `${detail.files.length} files`}</div>
      <div className="git-list" role="listbox" tabIndex={0} onKeyDown={onKey} aria-label="Files">
        {detail.files.map((f, i) => (
          <FileRow
            key={`${f.path}\n${f.origPath ?? ''}`}
            id={`commit-file-${i}`}
            path={f.path}
            origPath={f.origPath}
            status={CHANGE_LABELS[f.kind]}
            selected={f === file}
            onSelect={() => onFile(f.path)}
            // The file as the working tree has it now, which may differ from the commit's.
            onMenu={() => window.looper.git.showFileMenu({ projectId, root, path: f.path, exists: f.kind !== 'deleted' })}
          />
        ))}
      </div>
    </div>
  );
}

/** The branch's history: the commits, the selected one's details and files, and the selected file's diff. */
function HistoryView({ projectId, root, refreshKey }: { projectId: string; root: string; refreshKey: number }) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ key: string; diff: GitFileDiff } | null>(null);
  const loading = useRef(false);
  const commitsRef = useRef(commits);
  commitsRef.current = commits;

  // The first page again on a refresh, kept as it is while the newest commit is the same;
  // the list grows by pages as it scrolls.
  useEffect(() => {
    let live = true;
    window.looper.git
      .log(projectId, 0, PAGE)
      .then((page) => {
        if (!live) return;
        setLoaded(true);
        if (commitsRef.current.length > 0 && commitsRef.current[0].hash === page[0]?.hash) return;
        setCommits(page);
        setMore(page.length === PAGE);
      })
      .catch(fail);
    return () => {
      live = false;
    };
  }, [projectId, refreshKey]);

  const loadMore = () => {
    if (loading.current || !more) return;
    loading.current = true;
    window.looper.git
      .log(projectId, commits.length, PAGE)
      .then((page) => {
        setCommits((prev) => [...prev, ...page.filter((c) => !prev.some((p) => p.hash === c.hash))]);
        setMore(page.length === PAGE);
      })
      .catch(fail)
      .finally(() => {
        loading.current = false;
      });
  };

  const current = commits.find((c) => c.hash === sel) ?? commits[0];
  useEffect(() => {
    setDetail(null);
    setFilePath(null);
    if (!current) return;
    let live = true;
    window.looper.git
      .commit(projectId, current.hash)
      .then((d) => live && setDetail(d))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [projectId, current?.hash]);

  const file = detail ? (detail.files.find((f) => f.path === filePath) ?? detail.files[0]) : undefined;
  const diffKey = detail && file ? `${detail.hash}\n${file.path}` : '';
  useEffect(() => {
    if (!detail || !file) return;
    let live = true;
    window.looper.git
      .commitDiff(projectId, detail.hash, file.path, file.origPath)
      .then((d) => live && setDiff({ key: diffKey, diff: d }))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffKey, projectId]);

  const index = current ? commits.indexOf(current) : -1;
  const onKey = useListNav({
    count: commits.length,
    index,
    onIndex: (i) => setSel(commits[i].hash),
    scrollToId: index >= 0 ? `commit-${index}` : null,
  });

  if (loaded && commits.length === 0) return <div className="empty">The branch has no commits yet.</div>;
  return (
    <div className="git-columns three">
      <div
        className="git-list"
        role="listbox"
        tabIndex={0}
        aria-label="Commits"
        onKeyDown={onKey}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) loadMore();
        }}
      >
        {commits.map((c, i) => (
          <div
            key={c.hash}
            id={`commit-${i}`}
            role="option"
            aria-selected={c === current}
            className={`git-commit${c === current ? ' selected' : ''}`}
            onClick={() => setSel(c.hash)}
            onContextMenu={(e) => {
              e.preventDefault();
              setSel(c.hash);
              window.looper.git.showCommitMenu({ hash: c.hash, subject: c.subject });
            }}
          >
            <div className="git-commit-line">{c.subject}</div>
            <div className="muted git-commit-meta">
              {c.author} · {fmtDateTime(c.at)} · <span className="mono">{c.shortHash}</span>
              {c.refs.length > 0 ? ` · ${c.refs.join(', ')}` : ''}
            </div>
          </div>
        ))}
      </div>
      {detail ? (
        <CommitDetail projectId={projectId} root={root} detail={detail} file={file} onFile={setFilePath} />
      ) : (
        <div className="empty">{current ? 'Loading…' : ''}</div>
      )}
      <DiffPane
        title={file?.path}
        subtitle={file ? (file.origPath ? `${CHANGE_LABELS[file.kind]} from ${file.origPath}` : CHANGE_LABELS[file.kind]) : undefined}
        diff={diff && diff.key === diffKey ? diff.diff : null}
        loading={!!file}
      />
    </div>
  );
}

export interface GitWatch {
  status: GitStatusResult | null;
  /** Grows when the history may have changed: the status changed, or the window got the focus back. */
  refreshKey: number;
}

/**
 * A project's git status, read again every few seconds while the window has
 * the focus and when it gets it back; nothing is read without a project. The
 * Git tab's parent holds it, so the tab's title can count the changes.
 */
export function useGitStatus(projectId: string | undefined): GitWatch {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastStatus = useRef('');

  const loadStatus = useCallback(() => {
    if (!projectId) return;
    window.looper.git
      .status(projectId)
      .then((s) => {
        const key = JSON.stringify(s);
        if (key === lastStatus.current) return;
        lastStatus.current = key;
        setStatus(s);
        // A commit changes the status too, so the history follows.
        setRefreshKey((k) => k + 1);
      })
      .catch((e) => setStatus({ repo: false, error: (e as Error).message }));
  }, [projectId]);

  useEffect(() => {
    setStatus(null);
    lastStatus.current = '';
    if (!projectId) return;
    loadStatus();
    const refresh = () => {
      loadStatus();
      setRefreshKey((k) => k + 1);
    };
    const poll = setInterval(() => {
      if (document.hasFocus()) loadStatus();
    }, POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(poll);
      window.removeEventListener('focus', refresh);
    };
  }, [projectId, loadStatus]);

  return { status, refreshKey };
}

/**
 * A project's git repository, read-only: the uncommitted changes and the
 * branch's history. `narrow` stacks the lists over the diff and puts the
 * branch at the bottom, for the Sessions window's activity pane; wide puts
 * the lists side by side and the branch beside the tabs.
 */
export function GitView({ projectId, watch, narrow = false }: { projectId: string; watch: GitWatch; narrow?: boolean }) {
  const [tab, setTab] = useState<Tab>('changes');
  const { status, refreshKey } = watch;
  const className = `git-view${narrow ? ' narrow' : ''}`;
  if (!status) return <div className={className}><div className="empty">Loading…</div></div>;
  if (!status.repo) {
    return (
      <div className={className}>
        <div className="empty">{status.error ?? "The project's folder isn't in a git repository."}</div>
      </div>
    );
  }
  const branch = <span className="muted git-branch">{branchText(status)}</span>;
  return (
    <div className={className}>
      <div className="git-head">
        <TabBar
          tabs={[
            ['changes', 'Changes'],
            ['history', 'History'],
          ]}
          active={tab}
          onSelect={setTab}
          className="git-tabs"
        />
        {!narrow && branch}
      </div>
      <div className="git-body">
        {tab === 'changes' ? <ChangesView projectId={projectId} status={status} /> : <HistoryView projectId={projectId} root={status.root} refreshKey={refreshKey} />}
      </div>
      {narrow && <div className="git-foot">{branch}</div>}
    </div>
  );
}
