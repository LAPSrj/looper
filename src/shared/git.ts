import type { PatchHunk } from './messages';

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted';

/** One uncommitted file, by its path from the repository's root. */
export interface GitChange {
  path: string;
  /** A renamed or copied file's old path. */
  origPath?: string;
  kind: GitChangeKind;
  /** Part of the change is in the index, and part only in the working tree. */
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatus {
  /** The repository's root, in the project environment's own path form. */
  root: string;
  /** The checked-out branch; unset when HEAD is detached. */
  branch?: string;
  /** The commit a detached HEAD is at. */
  detachedAt?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** The branch has no commits yet. */
  initial: boolean;
  changes: GitChange[];
}

export type GitStatusResult = ({ repo: true } & GitStatus) | { repo: false; error?: string };

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  /** Author time, ms since the epoch. */
  at: number;
  /** Branch and tag names pointing at it ("HEAD -> master" shows as "master"). */
  refs: string[];
  subject: string;
}

/** A file a commit changed. */
export interface GitFileChange {
  path: string;
  origPath?: string;
  kind: GitChangeKind;
}

export interface GitCommitDetail extends GitCommit {
  email: string;
  body: string;
  parents: string[];
  files: GitFileChange[];
}

export interface GitFileDiff {
  binary: boolean;
  hunks: PatchHunk[];
  /** The diff was longer than Looper shows. */
  truncated: boolean;
}

/** `git log --format` fields, split by unit and record separators so no message text can break them. */
export const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%s%x1e';
export const SHOW_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%P%x1f%s%x1f%b%x1e';

const kindOfLetter = (c: string): GitChangeKind | undefined =>
  ({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'conflicted' })[c] as GitChangeKind | undefined;

/** An ordinary entry's kind from its XY letters: addition and deletion win over modification. */
function kindOfXY(xy: string): GitChangeKind {
  const [x, y] = xy;
  if (x === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'T' || y === 'T') return 'typechange';
  return 'modified';
}

/** `git status --porcelain=v2 --branch -z` as branch facts and changes, minus the root (the caller knows it). */
export function parseStatus(out: string): Omit<GitStatus, 'root'> {
  const status: Omit<GitStatus, 'root'> = { ahead: 0, behind: 0, initial: false, changes: [] };
  const parts = out.split('\0');
  let oid = '';
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) {
      const [key, ...rest] = rec.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') {
        oid = value;
        status.initial = value === '(initial)';
      } else if (key === 'branch.head' && value !== '(detached)') status.branch = value;
      else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = rec[0];
    if (type === '?') {
      status.changes.push({ path: rec.slice(2), kind: 'untracked', staged: false, unstaged: true });
    } else if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = rec.split(' ');
      status.changes.push({ path: f.slice(8).join(' '), kind: kindOfXY(f[1]), staged: f[1][0] !== '.', unstaged: f[1][1] !== '.' });
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next record
      const f = rec.split(' ');
      const xy = f[1];
      status.changes.push({
        path: f.slice(9).join(' '),
        origPath: parts[++i],
        kind: xy.includes('C') ? 'copied' : 'renamed',
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
      });
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = rec.split(' ');
      status.changes.push({ path: f.slice(10).join(' '), kind: 'conflicted', staged: false, unstaged: true });
    }
  }
  if (!status.branch && oid && oid !== '(initial)') status.detachedAt = oid.slice(0, 7);
  return status;
}

/** `%D` as the names a reader wants: "HEAD -> master" is the branch, a bare "HEAD" says nothing more. */
function refsOf(d: string): string[] {
  return d
    .split(', ')
    .map((r) => r.trim().replace(/^HEAD -> /, ''))
    .filter((r) => r && r !== 'HEAD');
}

/** `git log --format=LOG_FORMAT` as commits, newest first. */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const rec of out.split('\x1e')) {
    const f = rec.replace(/^\n/, '').split('\x1f');
    if (f.length < 6 || !f[0]) continue;
    commits.push({ hash: f[0], shortHash: f[1], author: f[2], at: Number(f[3]) * 1000, refs: refsOf(f[4]), subject: f[5] });
  }
  return commits;
}

/** `git show -s --format=SHOW_FORMAT` as a commit's details, without its files. */
export function parseShow(out: string): Omit<GitCommitDetail, 'files'> | null {
  const f = out.replace(/^\n/, '').split('\x1e')[0].split('\x1f');
  if (f.length < 9 || !f[0]) return null;
  return {
    hash: f[0],
    shortHash: f[1],
    author: f[2],
    email: f[3],
    at: Number(f[4]) * 1000,
    refs: refsOf(f[5]),
    parents: f[6].split(' ').filter(Boolean),
    subject: f[7],
    body: f[8].trim(),
  };
}

/** `git diff-tree --name-status -z` as the files a commit changed. */
export function parseNameStatus(out: string): GitFileChange[] {
  const parts = out.split('\0');
  const files: GitFileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code || !/^[ACDMRTUX]\d*$/.test(code)) continue;
    const kind = kindOfLetter(code[0]) ?? 'modified';
    if (code[0] === 'R' || code[0] === 'C') {
      const origPath = parts[++i];
      files.push({ path: parts[++i], origPath, kind });
    } else {
      files.push({ path: parts[++i], kind });
    }
  }
  return files.filter((f) => f.path);
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One file's unified diff (`git diff` / `git show` of one path) as hunks. */
export function parseDiff(out: string, truncated = false): GitFileDiff {
  const diff: GitFileDiff = { binary: false, hunks: [], truncated };
  let hunk: PatchHunk | null = null;
  for (const line of out.split('\n')) {
    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      diff.hunks.push(hunk);
    } else if (hunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      hunk.lines.push(line);
    } else if (!hunk && /^Binary files .* differ$/.test(line)) {
      diff.binary = true;
    } else if (line.startsWith('diff --git')) {
      hunk = null;
    }
  }
  return diff;
}

export const CHANGE_LABELS: Record<GitChangeKind, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typechange: 'Type changed',
  untracked: 'Untracked',
  conflicted: 'Conflict',
};

/** "Modified", or "Modified, partly staged" / "Added, staged": what the change is and how much of it is in the index. */
export function changeText(c: GitChange): string {
  const label = CHANGE_LABELS[c.kind];
  if (c.kind === 'untracked' || c.kind === 'conflicted') return label;
  if (c.staged && c.unstaged) return `${label}, partly staged`;
  return c.staged ? `${label}, staged` : label;
}

/** How many uncommitted files are new, changed and deleted (a rename, copy or conflict counts as changed). */
export function changeCounts(changes: GitChange[]): { added: number; modified: number; deleted: number } {
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const c of changes) {
    if (c.kind === 'added' || c.kind === 'untracked') counts.added += 1;
    else if (c.kind === 'deleted') counts.deleted += 1;
    else counts.modified += 1;
  }
  return counts;
}

/** The Git tab's title: "Git (+2 ~3 −1)" for 2 new, 3 changed and 1 deleted files; a zero count is left out. */
export function gitTabLabel(changes: GitChange[] | undefined): string {
  if (!changes?.length) return 'Git';
  const { added, modified, deleted } = changeCounts(changes);
  const parts = [added ? `+${added}` : '', modified ? `~${modified}` : '', deleted ? `−${deleted}` : ''].filter(Boolean);
  return `Git (${parts.join(' ')})`;
}

/** The branch line of a Git tab. */
export function branchText(s: GitStatus): string {
  const where = s.branch ? `On ${s.branch}` : s.detachedAt ? `Detached at ${s.detachedAt}` : 'Detached';
  if (s.initial) return `${where} · no commits yet`;
  if (!s.upstream) return `${where} · not tracking a remote branch`;
  if (!s.ahead && !s.behind) return `${where} · up to date with ${s.upstream}`;
  if (s.ahead && s.behind) return `${where} · ${s.ahead} ahead of and ${s.behind} behind ${s.upstream}`;
  return `${where} · ${s.ahead ? `${s.ahead} ahead of` : `${s.behind} behind`} ${s.upstream}`;
}
