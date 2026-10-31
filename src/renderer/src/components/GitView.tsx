import { Children, Fragment, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
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
import { isPhone, usePageNav } from '../web/page-nav';
import { useDragResize, useListNav } from './hooks';
import { Group, Row } from './phone/PhoneList';
import { DiffView } from './ToolContent';
import { TabBar } from './ui';

type Tab = 'changes' | 'history';

const PAGE = 200;
const POLL_MS = 5000;

const baseName = (p: string) => p.split('/').pop() || p;
const dirName = (p: string) => p.slice(0, Math.max(0, p.length - baseName(p).length - 1));
const fail = (e: unknown) => void window.looper.showError((e as Error).message);

const DIVIDER = 5;
const MIN_PANE = 60;
/** A stacked list-over-diff area shorter than this (px) splits into tabs instead. */
const SHORT = 260;

/** The drag handle between two panes of a Split; `index` is the pane before it. */
function SplitDivider({
  axis,
  index,
  containerRef,
  sizes,
  count,
  onSize,
}: {
  axis: 'x' | 'y';
  index: number;
  containerRef: RefObject<HTMLDivElement | null>;
  sizes: number[];
  count: number;
  onSize: (index: number, size: number) => void;
}) {
  const onMouseDown = useDragResize({
    axis,
    containerRef,
    onDrag: (pos, rect) => {
      const total = axis === 'x' ? rect.width : rect.height;
      let start = index * DIVIDER;
      for (let i = 0; i < index; i++) start += sizes[i];
      let after = (count - 1 - index) * DIVIDER + MIN_PANE;
      for (let i = index + 1; i < count - 1; i++) after += sizes[i];
      const max = Math.max(MIN_PANE, total - start - DIVIDER - after);
      onSize(index, Math.round(Math.max(MIN_PANE, Math.min(max, pos - start - DIVIDER / 2))));
    },
  });
  return <div className={`git-divider ${axis}`} onMouseDown={onMouseDown} />;
}

/**
 * Panes in a row (`x`) or a column (`y`) with a drag handle between each pair.
 * `initial` sizes every pane but the last, which takes the rest.
 */
function Split({ axis, initial, children }: { axis: 'x' | 'y'; initial: number[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState(initial);
  const panes = Children.toArray(children);
  const onSize = (i: number, size: number) => setSizes((prev) => prev.map((s, j) => (j === i ? size : s)));
  return (
    <div ref={ref} className={`git-split ${axis}`}>
      {panes.map((pane, i) => (
        <Fragment key={i}>
          {i > 0 && <SplitDivider axis={axis} index={i - 1} containerRef={ref} sizes={sizes} count={panes.length} onSize={onSize} />}
          <div className="git-pane" style={i < panes.length - 1 ? { flex: `0 1 ${sizes[i]}px` } : { flex: '1 1 0' }}>
            {pane}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

type PaneId = 'message' | 'files' | 'changes';

/**
 * A file list with the selected file's changes beside it (`x`) or below it
 * (`y`), a drag handle between them. When a stacked area is too short for
 * both, they become two tabs, Files and Diff. `message`, when given, is a
 * first tab of its own (the commit message).
 */
function FilesChanges({ axis, message, files, changes }: { axis: 'x' | 'y'; message?: ReactNode; files: ReactNode; changes: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [short, setShort] = useState(false);
  const [pane, setPane] = useState<PaneId>(message ? 'message' : 'files');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setShort(axis === 'y' && el.clientHeight < SHORT);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [axis]);

  const together = !short;
  const tabs: [PaneId, string][] = [];
  if (message) tabs.push(['message', 'Commit Message']);
  tabs.push(['files', 'Files']);
  if (!together) tabs.push(['changes', 'Diff']);
  // The Diff tab goes away once there's room for both again.
  const active = together && pane === 'changes' ? 'files' : pane;
  let body: ReactNode;
  if (active === 'message') body = message;
  else if (together) {
    body = (
      <Split axis={axis} initial={[axis === 'x' ? 360 : 160]}>
        {files}
        {changes}
      </Split>
    );
  } else body = active === 'files' ? files : changes;
  return (
    <div ref={ref} className="git-files-changes">
      {tabs.length > 1 && <TabBar tabs={tabs} active={active} onSelect={setPane} className="git-subtabs" />}
      <div className="git-tabbody">{body}</div>
    </div>
  );
}

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

/**
 * A phone's push: while a deeper screen shows (`title` set), Back returns to
 * the one before it. The frame's bar draws the Back and the title; in a sheet,
 * where the bar is out of reach, `PhoneBack` draws one in the view.
 */
function usePhoneDetail(title: string | null, onBack: () => void): void {
  usePageNav(isPhone && title !== null ? { title, back: onBack } : null, 10);
}

/** The in-view Back a phone's sheet shows over a pushed screen (hidden elsewhere: the frame's bar has it). */
function PhoneBack({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button className="pg-inline-back" onClick={onBack}>
      <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
        <path d="M6.5 1.5 1.5 6.5l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
}

/** Files as list rows: the name, its folder under it, what happened to it at the end. A tap pushes the diff. */
function PhoneFiles({ files, onOpen, onMenu }: { files: { key: string; path: string; origPath?: string; status: string }[]; onOpen: (i: number) => void; onMenu: (i: number) => void }) {
  return (
    <Group>
      {files.map((f, i) => (
        <Row
          key={f.key}
          title={baseName(f.path)}
          sub={<span className="pg-oneline mono">{f.origPath ? `from ${f.origPath}` : dirName(f.path) || '/'}</span>}
          value={f.status}
          chevron
          onOpen={() => onOpen(i)}
          onMenu={() => onMenu(i)}
        />
      ))}
    </Group>
  );
}

/** Uncommitted changes: the files, and the selected one's diff against HEAD beside or below them. A phone lists the files and pushes the diff. */
function ChangesView({ projectId, status, narrow, onDetail }: { projectId: string; status: GitStatus; narrow: boolean; onDetail: (open: boolean) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  // A phone: the diff screen shows (a file was tapped).
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<{ key: string; diff: GitFileDiff } | null>(null);
  const changes = status.changes;
  const current = changes.find((c) => c.path === sel) ?? changes[0];
  const diffShown = !isPhone || open;
  useEffect(() => onDetail(isPhone && open), [open, onDetail]);
  usePhoneDetail(isPhone && open && current ? baseName(current.path) : null, () => setOpen(false));
  // A change's diff is read again whenever the status says something changed.
  const statusKey = JSON.stringify(changes);
  const key = current ? `${current.path}\n${current.kind}\n${statusKey}` : '';
  useEffect(() => {
    if (!current || !diffShown) return;
    let live = true;
    window.looper.git
      .changeDiff(projectId, { path: current.path, origPath: current.origPath, kind: current.kind }, status.initial)
      .then((d) => live && setDiff({ key, diff: d }))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, projectId, diffShown]);
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
  if (isPhone) {
    const diffPane = (
      <DiffPane
        title={current?.path}
        subtitle={current ? changeText(current) : undefined}
        diff={diff && diff.key === key ? diff.diff : null}
        loading={!!current}
      />
    );
    return open ? (
      <div className="git-phone-detail">
        <PhoneBack label="Changes" onBack={() => setOpen(false)} />
        {diffPane}
      </div>
    ) : (
      <div className="git-phone-list">
        <PhoneFiles
          files={changes.map((c) => ({ key: c.path, path: c.path, origPath: c.origPath, status: changeText(c) }))}
          onOpen={(i) => {
            setSel(changes[i].path);
            setOpen(true);
          }}
          onMenu={(i) => menu(changes[i])}
        />
      </div>
    );
  }
  return (
    <FilesChanges
      axis={narrow ? 'y' : 'x'}
      files={
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
      }
      changes={
        <DiffPane
          title={current?.path}
          subtitle={current ? changeText(current) : undefined}
          diff={diff && diff.key === key ? diff.diff : null}
          loading={!!current}
        />
      }
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

/** The files a commit changed. */
function CommitFiles({
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
  );
}

/** The branch's history: the commits, and beside or below them the selected one's message, files and the selected file's diff. */
function HistoryView({ projectId, root, refreshKey, narrow, onDetail }: { projectId: string; root: string; refreshKey: number; narrow: boolean; onDetail: (open: boolean) => void }) {
  // A phone: the commit's screen (its message and files) shows, then a file's diff over it.
  const [phoneOpen, setPhoneOpen] = useState<'commit' | 'file' | null>(null);
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
  // A phone reads a commit once it's opened.
  const wantDetail = !isPhone || phoneOpen !== null;
  useEffect(() => {
    setDetail(null);
    setFilePath(null);
    if (!current || !wantDetail) return;
    let live = true;
    window.looper.git
      .commit(projectId, current.hash)
      .then((d) => live && setDetail(d))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [projectId, current?.hash, wantDetail]);

  const file = detail ? (detail.files.find((f) => f.path === filePath) ?? detail.files[0]) : undefined;
  const diffKey = detail && file ? `${detail.hash}\n${file.path}` : '';
  useEffect(() => onDetail(isPhone && phoneOpen !== null), [phoneOpen, onDetail]);
  usePhoneDetail(
    !isPhone || phoneOpen === null ? null : phoneOpen === 'file' ? (file ? baseName(file.path) : '') : (current?.subject ?? ''),
    () => setPhoneOpen(phoneOpen === 'file' ? 'commit' : null),
  );
  useEffect(() => {
    if (!detail || !file || (isPhone && phoneOpen !== 'file')) return;
    let live = true;
    window.looper.git
      .commitDiff(projectId, detail.hash, file.path, file.origPath)
      .then((d) => live && setDiff({ key: diffKey, diff: d }))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffKey, projectId, phoneOpen === 'file']);

  const index = current ? commits.indexOf(current) : -1;
  const onKey = useListNav({
    count: commits.length,
    index,
    onIndex: (i) => setSel(commits[i].hash),
    scrollToId: index >= 0 ? `commit-${index}` : null,
  });

  if (loaded && commits.length === 0) return <div className="empty">The branch has no commits yet.</div>;
  const pending = <div className="empty">{current ? 'Loading…' : ''}</div>;
  if (isPhone) {
    if (phoneOpen === 'file') {
      return (
        <div className="git-phone-detail">
          <PhoneBack label="Commit" onBack={() => setPhoneOpen('commit')} />
          {detail ? (
            <DiffPane
              title={file?.path}
              subtitle={file ? (file.origPath ? `${CHANGE_LABELS[file.kind]} from ${file.origPath}` : CHANGE_LABELS[file.kind]) : undefined}
              diff={diff && diff.key === diffKey ? diff.diff : null}
              loading={!!file}
            />
          ) : (
            pending
          )}
        </div>
      );
    }
    if (phoneOpen === 'commit') {
      return (
        <div className="git-phone-list">
          <PhoneBack label="History" onBack={() => setPhoneOpen(null)} />
          {detail ? (
            <>
              <Group title="Message">
                <div className="pg-result">
                  <CommitMessage detail={detail} />
                </div>
              </Group>
              <PhoneFiles
                files={detail.files.map((f) => ({ key: `${f.path}\n${f.origPath ?? ''}`, path: f.path, origPath: f.origPath, status: CHANGE_LABELS[f.kind] }))}
                onOpen={(i) => {
                  setFilePath(detail.files[i].path);
                  setPhoneOpen('file');
                }}
                onMenu={(i) => window.looper.git.showFileMenu({ projectId, root, path: detail.files[i].path, exists: detail.files[i].kind !== 'deleted' })}
              />
            </>
          ) : (
            pending
          )}
        </div>
      );
    }
    return (
      <div
        className="git-phone-list"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) loadMore();
        }}
      >
        <Group>
          {commits.map((c) => (
            <Row
              key={c.hash}
              title={c.subject}
              sub={<span className="pg-oneline">{`${c.author} · ${fmtDateTime(c.at)} · ${c.shortHash}`}</span>}
              chevron
              onOpen={() => {
                setSel(c.hash);
                setPhoneOpen('commit');
              }}
              onMenu={() => window.looper.git.showCommitMenu({ hash: c.hash, subject: c.subject })}
            />
          ))}
        </Group>
      </div>
    );
  }
  return (
    <Split axis={narrow ? 'y' : 'x'} initial={[narrow ? 150 : 360]}>
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
      <FilesChanges
        axis="y"
        message={detail ? <CommitMessage detail={detail} /> : pending}
        files={detail ? <CommitFiles projectId={projectId} root={root} detail={detail} file={file} onFile={setFilePath} /> : pending}
        changes={
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
    </Split>
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
 * branch's history. `narrow` stacks the panes and puts the
 * branch at the bottom, for the Sessions window's activity pane; wide puts
 * the panes side by side and the branch beside the tabs.
 */
export function GitView({ projectId, watch, narrow = false }: { projectId: string; watch: GitWatch; narrow?: boolean }) {
  const [tab, setTab] = useState<Tab>('changes');
  // A phone: a pushed screen (a diff, a commit) shows instead of the tabs and the list.
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
          <ChangesView projectId={projectId} status={status} narrow={narrow} onDetail={setDetailOpen} />
        ) : (
          <HistoryView projectId={projectId} root={status.root} refreshKey={refreshKey} narrow={narrow} onDetail={setDetailOpen} />
        )}
      </div>
      {narrow && !detailOpen && <div className="git-foot">{branch}</div>}
    </div>
  );
}
