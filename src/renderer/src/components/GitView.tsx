import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { RowList, type PhoneRowModel } from './DataTable';
import { ListDetail, selectsFirstRow } from './ListDetail';
import { Group } from './phone/PhoneList';
import { DiffView } from './ToolContent';
import { TabBar } from './ui';

type Tab = 'changes' | 'history';

const PAGE = 200;
const WORKING_POLL_MS = 5000;
const IDLE_POLL_MS = 60_000;

const baseName = (p: string) => p.split('/').pop() || p;
const dirName = (p: string) => p.slice(0, Math.max(0, p.length - baseName(p).length - 1));
const fail = (e: unknown) => void window.looper.showError((e as Error).message);

interface FileLine {
  path: string;
  origPath?: string;
  status: string;
}

/** One file in a list: its name, its folder, and what happened to it. */
function FileRow({ path, origPath, status }: FileLine) {
  return (
    <>
      <div className="git-file-name">
        <span>{baseName(path)}</span>
        <span className="muted git-file-status">{status}</span>
      </div>
      <div className="muted mono git-file-dir">{origPath ? `from ${origPath}` : dirName(path) || ' '}</div>
    </>
  );
}

/** The same on a phone: the name, its folder under it, what happened to it at the end. */
const filePhoneRow = ({ path, origPath, status }: FileLine): PhoneRowModel => ({
  title: baseName(path),
  sub: <span className="pg-oneline mono">{origPath ? `from ${origPath}` : dirName(path) || '/'}</span>,
  value: status,
});

/** A file's diff, or why there's none to show. */
function DiffPane({ title, subtitle, diff, loading }: { title?: string; subtitle?: string; diff: GitFileDiff | null; loading: boolean }) {
  if (!title) return <div className="empty">Select a file to see its changes.</div>;
  let body;
  if (!diff) body = <div className="muted git-diff-note">{loading ? 'Loading…' : ''}</div>;
  else if (diff.binary) body = <div className="muted git-diff-note">This is a binary file, so there are no lines to compare.</div>;
  else if (diff.hunks.length === 0) body = <div className="muted git-diff-note">No changed lines.</div>;
  else body = <DiffView hunks={diff.hunks} file={title} />;
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

/** Uncommitted changes: the files, and the selected one's diff against HEAD. */
function ChangesView({ projectId, status, narrow, note, onDetail }: { projectId: string; status: GitStatus; narrow: boolean; note?: ReactNode; onDetail: (pushed: boolean) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ key: string; diff: GitFileDiff } | null>(null);
  const changes = status.changes;
  const current = changes.find((c) => c.path === sel) ?? (selectsFirstRow || sel !== null ? changes[0] : undefined);
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
  if (changes.length === 0) {
    return (
      <>
        {note}
        <div className="empty">There are no uncommitted changes.</div>
      </>
    );
  }
  const line = (c: GitChange): FileLine => ({ path: c.path, origPath: c.origPath, status: changeText(c) });
  return (
    <ListDetail
      panes={{ axis: narrow ? 'y' : 'x', initial: narrow ? 160 : 360 }}
      tabs={{ list: 'Files', detail: 'Diff' }}
      open={sel !== null}
      onClose={() => setSel(null)}
      detailTitle={current && baseName(current.path)}
      backLabel="Changes"
      onPushed={onDetail}
      empty="Select a file to see its changes."
      list={
        <RowList
          listClass="git-list"
          rowClass="git-file"
          label="Changes"
          idPrefix="change"
          rows={changes}
          rowKey={(c) => c.path}
          selected={current?.path}
          onSelect={(c) => setSel(c.path)}
          onMenu={(c) => window.looper.git.showFileMenu({ projectId, root: status.root, path: c.path, exists: c.kind !== 'deleted' })}
          empty=""
          head={note}
          row={(c) => <FileRow {...line(c)} />}
          phoneRow={(c) => filePhoneRow(line(c))}
        />
      }
      detail={<DiffPane title={current?.path} subtitle={current ? changeText(current) : undefined} diff={diff && diff.key === key ? diff.diff : null} loading={!!current} />}
    />
  );
}

/** The commit's message, author, date and id. */
function CommitMessage({ detail }: { detail: GitCommitDetail }) {
  return (
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
  );
}

const fileKey = (f: GitFileChange) => `${f.path}\n${f.origPath ?? ''}`;
const fileLine = (f: GitFileChange): FileLine => ({ path: f.path, origPath: f.origPath, status: CHANGE_LABELS[f.kind] });

/** The branch's history: the commits, and the selected one's message, files and the selected file's diff. */
function HistoryView({ projectId, root, refreshKey, narrow, note, onDetail }: { projectId: string; root: string; refreshKey: number; narrow: boolean; note?: ReactNode; onDetail: (pushed: boolean) => void }) {
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

  const current = commits.find((c) => c.hash === sel) ?? (selectsFirstRow ? commits[0] : undefined);
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

  const file = detail ? (detail.files.find((f) => f.path === filePath) ?? (selectsFirstRow ? detail.files[0] : undefined)) : undefined;
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

  if (loaded && commits.length === 0) return <div className="empty">The branch has no commits yet.</div>;
  const pending = <div className="empty">{current ? 'Loading…' : ''}</div>;
  return (
    <ListDetail
      panes={{ axis: narrow ? 'y' : 'x', initial: narrow ? 150 : 360 }}
      open={sel !== null}
      onClose={() => setSel(null)}
      detailTitle={current?.subject}
      backLabel="History"
      onPushed={onDetail}
      empty="Select a commit to see its changes."
      list={
        <RowList
          listClass="git-list"
          rowClass="git-commit"
          label="Commits"
          idPrefix="commit"
          rows={commits}
          rowKey={(c) => c.hash}
          selected={current?.hash}
          onSelect={(c) => setSel(c.hash)}
          onMenu={(c) => window.looper.git.showCommitMenu({ hash: c.hash, subject: c.subject })}
          onListScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) loadMore();
          }}
          empty=""
          head={note}
          row={(c) => (
            <>
              <div className="git-commit-line">{c.subject}</div>
              <div className="muted git-commit-meta">
                {c.author} · {fmtDateTime(c.at)} · <span className="mono">{c.shortHash}</span>
                {c.refs.length > 0 ? ` · ${c.refs.join(', ')}` : ''}
              </div>
            </>
          )}
          phoneRow={(c) => ({ title: c.subject, sub: `${c.author} · ${fmtDateTime(c.at)} · ${c.shortHash}` })}
        />
      }
      detail={
        <ListDetail
          panes={{ axis: 'y', initial: 160 }}
          tabs={{ list: 'Files', detail: 'Diff', head: { label: 'Commit Message', body: detail ? <CommitMessage detail={detail} /> : pending } }}
          open={filePath !== null}
          onClose={() => setFilePath(null)}
          detailTitle={file && baseName(file.path)}
          backLabel="Commit"
          empty="Select a file to see its changes."
          list={
            detail ? (
              <RowList
                listClass="git-list"
                rowClass="git-file"
                label="Files"
                idPrefix="commit-file"
                rows={detail.files}
                rowKey={fileKey}
                selected={file && fileKey(file)}
                onSelect={(f) => setFilePath(f.path)}
                // The file as the working tree has it now, which may differ from the commit's.
                onMenu={(f) => window.looper.git.showFileMenu({ projectId, root, path: f.path, exists: f.kind !== 'deleted' })}
                empty="This commit changed no files."
                head={
                  <Group title="Message">
                    <div className="pg-result">
                      <CommitMessage detail={detail} />
                    </div>
                  </Group>
                }
                row={(f) => <FileRow {...fileLine(f)} />}
                phoneRow={(f) => filePhoneRow(fileLine(f))}
              />
            ) : (
              pending
            )
          }
          detail={
            detail ? (
              <DiffPane
                title={file?.path}
                subtitle={file ? (file.origPath ? `${CHANGE_LABELS[file.kind]} from ${file.origPath}` : CHANGE_LABELS[file.kind]) : undefined}
                diff={diff && diff.key === diffKey ? diff.diff : null}
                loading={!!file}
              />
            ) : (
              pending
            )
          }
        />
      }
    />
  );
}

export interface GitWatch {
  status: GitStatusResult | null;
  /** Grows when the history may have changed: the status changed, or the window got the focus back. */
  refreshKey: number;
}

/**
 * A project's git status, read again while the window has the focus: every 5 s
 * while an agent works in the project (`active`), every minute otherwise, once
 * when the work ends, and on getting the focus back after a minute or more;
 * nothing is read without a project. The Git tab's parent holds it, so the
 * tab's title can count the changes.
 */
export function useGitStatus(projectId: string | undefined, active: boolean): GitWatch {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastStatus = useRef('');
  const checkedAt = useRef(0);

  const loadStatus = useCallback(() => {
    if (!projectId) return;
    checkedAt.current = Date.now();
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
      if (Date.now() - checkedAt.current < IDLE_POLL_MS) return;
      loadStatus();
      setRefreshKey((k) => k + 1);
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [projectId, loadStatus]);

  const wasActive = useRef(active);
  useEffect(() => {
    if (!projectId) return;
    // The last changes of the agent's work show at once, not a minute later.
    if (wasActive.current && !active) loadStatus();
    wasActive.current = active;
    const every = active ? WORKING_POLL_MS : IDLE_POLL_MS;
    const poll = setInterval(() => {
      // A focus or end-of-work check just now counts as this one.
      if (document.hasFocus() && Date.now() - checkedAt.current >= every / 2) loadStatus();
    }, every);
    return () => clearInterval(poll);
  }, [projectId, active, loadStatus]);

  return { status, refreshKey };
}

/**
 * A project's git repository, read-only: the uncommitted changes and the
 * branch's history. `narrow` stacks the panes and puts the branch at the
 * bottom, for the Sessions window's activity pane; wide puts the panes side by
 * side and the branch beside the tabs. A phone or tablet stacks them too, with
 * the branch as the list's header.
 */
export function GitView({ projectId, watch, narrow: narrowPane = false }: { projectId: string; watch: GitWatch; narrow?: boolean }) {
  const narrow = narrowPane || !selectsFirstRow;
  const [tab, setTab] = useState<Tab>('changes');
  // A pushed screen (a diff, a commit) shows instead of the tabs and the list.
  const [detailOpen, setDetailOpen] = useState(false);
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
  // On a phone or tablet the branch is the list's header (HIG: Lists and tables), not a strip of its own at the bottom.
  const note = selectsFirstRow ? undefined : <div className="pg-list-note">{branchText(status)}</div>;
  return (
    <div className={className}>
      {!detailOpen && (
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
      )}
      <div className="git-body">
        {tab === 'changes' ? (
          <ChangesView projectId={projectId} status={status} narrow={narrow} note={note} onDetail={setDetailOpen} />
        ) : (
          <HistoryView projectId={projectId} root={status.root} refreshKey={refreshKey} narrow={narrow} note={note} onDetail={setDetailOpen} />
        )}
      </div>
      {narrowPane && selectsFirstRow && !detailOpen && <div className="git-foot">{branch}</div>}
    </div>
  );
}
