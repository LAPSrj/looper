import type { AddonSide } from '../../shared/addons';
import type { GitStatus } from '../../shared/git';

/** What Looper accepts as a pane item's, a row's or a button's id. */
const ID_RE = /^[a-z0-9][a-z0-9._:-]*$/i;

const hex = (s: string): string => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

/** A pane item's id for a project: its own id when Looper accepts it as one, else a form of it that it does. */
export const itemId = (projectId: string): string => (ID_RE.test(projectId) && !projectId.startsWith('x-') ? projectId : `x-${hex(projectId)}`);

/** A list row's id for a file path: the same path always gets the same id, so the selection outlasts a redraw. */
export const pathRowId = (path: string): string => `f${hex(path)}`;

/** Where HEAD is: the branch, or the commit a detached HEAD is at. */
export function headText(s: Pick<GitStatus, 'branch' | 'detachedAt'>): string {
  return s.branch ?? (s.detachedAt ? `Detached at ${s.detachedAt}` : 'Detached');
}

/** A repository's line in the pane: "main · 2 changed · 1 ahead". */
export function repoDescription(s: Pick<GitStatus, 'branch' | 'detachedAt' | 'initial' | 'ahead' | 'behind' | 'changes'>): string {
  const parts = [headText(s)];
  if (s.initial) parts.push('no commits yet');
  if (s.changes.length) parts.push(`${s.changes.length} changed`);
  if (s.ahead) parts.push(`${s.ahead} ahead`);
  if (s.behind) parts.push(`${s.behind} behind`);
  return parts.join(' · ');
}

/** How the branch stands against the remote branch it tracks, for a screen that shows the branch on its own line. */
export function syncText(s: Pick<GitStatus, 'initial' | 'upstream' | 'ahead' | 'behind'>): string {
  if (s.initial) return 'No commits yet';
  if (!s.upstream) return 'Not tracking a remote branch';
  if (!s.ahead && !s.behind) return `Up to date with ${s.upstream}`;
  if (s.ahead && s.behind) return `${s.ahead} ahead of and ${s.behind} behind ${s.upstream}`;
  return `${s.ahead ? `${s.ahead} ahead of` : `${s.behind} behind`} ${s.upstream}`;
}

/** git can't commit because it has no name or email to put in the commit. */
export function needsIdentity(output: string): boolean {
  return /Author identity unknown|Please tell me who you are|unable to auto-detect email address|empty ident name/i.test(output);
}

/** The first line git wrote to stderr, without "fatal: ", or what its exit code says. */
export function gitMessage(r: { code: number; stderr: string }): string {
  const line = r.stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l);
  return line ? line.replace(/^(fatal|error): /, '') : `git exited with code ${r.code}.`;
}

/** A host named in git's or ssh's output: a URL's, or ssh's "user@host:". */
function hostIn(text: string): string | undefined {
  return /[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s']+@)?([^/\s':]+(?::\d+)?)/i.exec(text)?.[1] ?? /(?:[\w.-]+@)?([\w.-]+\.[a-z]{2,}): Permission denied/i.exec(text)?.[1];
}

/** git's own words, for a problem Looper doesn't recognize: without its "fatal:" and "error:" prefixes and its hints, as sentences. */
export function gitWords(r: { stdout: string; stderr: string }): string {
  return (r.stderr.trim() || r.stdout.trim())
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^(fatal|error|warning|remote|E|W):\s*/i, ''))
    .filter((l) => l && !/^hint:/i.test(l))
    .map((l) => `${l[0].toUpperCase()}${l.slice(1)}${/[.!?:]$/.test(l) ? '' : '.'}`)
    .join('\n');
}

/**
 * What a git command that failed tells the user, as Windows' error messages
 * do: a main instruction stating the problem (present tense, no final period,
 * object names in quotation marks) and, when it helps, a supplemental
 * instruction with the cause and how to fix it. `action` names what was
 * being done ("push", "clone the repository"); `url`, the remote it talked to.
 */
export function gitProblem(r: { stdout: string; stderr: string }, action: string, url?: string): { message: string; detail?: string } {
  const out = `${r.stderr}\n${r.stdout}`;
  const host = hostIn(out) ?? (url ? hostIn(url) : undefined);
  const files = (re: RegExp) => [...out.matchAll(re)].map((m) => m[1].trim()).slice(0, 5);
  if (/Authentication failed|Invalid username or password|HTTP Basic: Access denied/i.test(out)) {
    return { message: host ? `The user name or password for ${host} is incorrect` : 'The user name or password is incorrect' };
  }
  if (/Permission denied \(publickey/i.test(out)) {
    return { message: `${host ?? 'The server'} doesn't accept the SSH key`, detail: `To ${action} over SSH, add the key's public part to the account${host ? ` on ${host}` : ''}.` };
  }
  if (/Repository not found|repository '[^']+' not found|does not appear to be a git repository/i.test(out)) {
    const where = /repository '([^']+)' not found/i.exec(out)?.[1] ?? url;
    return { message: where ? `Can't find the repository at ${where}` : "Can't find the repository", detail: 'The address may be wrong, or the account may not have access to it.' };
  }
  if (/Could not resolve host|Failed to connect to|Connection timed out|Network is unreachable|Connection refused|Could not resolve hostname/i.test(out)) {
    return { message: host ? `Can't reach ${host}` : "Can't reach the server", detail: 'Check the network connection.' };
  }
  if (/\[rejected\][^\n]*\((fetch first|non-fast-forward)\)|Updates were rejected because the (tip|remote)/i.test(out)) {
    return { message: "Can't push because the remote branch has commits this branch doesn't", detail: 'To get them, pull first, or use Sync.' };
  }
  if (/divergent branches|Need to specify how to reconcile/i.test(out)) {
    return { message: "Can't pull because both branches have new commits", detail: 'To pull, choose how in Git Settings › Pull: Merge or Rebase.' };
  }
  if (/would be overwritten by (merge|checkout)|untracked working tree files would be (overwritten|removed)/i.test(out)) {
    const list = files(/^\t(.+)$/gm);
    return { message: `Can't ${action} because it would overwrite uncommitted changes`, detail: `To ${action}, commit the changes first.${list.length ? `\n\n${list.join('\n')}` : ''}` };
  }
  if (/CONFLICT \(|Automatic merge failed/i.test(out)) {
    const list = files(/Merge conflict in (.+)$/gm);
    return { message: `${action[0].toUpperCase()}${action.slice(1)} stopped at conflicting changes`, detail: `To finish, resolve the conflicts in the project and commit them.${list.length ? `\n\n${list.join('\n')}` : ''}` };
  }
  if (/There is no tracking information|has no upstream branch/i.test(out)) {
    return { message: `Can't ${action} because the branch doesn't track a remote branch`, detail: 'To set one, push the branch.' };
  }
  if (/nothing to commit|no changes added to commit/i.test(out)) return { message: 'There are no changes to commit' };
  if (/index\.lock'?: File exists|Another git process seems to be running/i.test(out)) {
    return { message: `Can't ${action} because another git command is using the repository`, detail: 'To try again, wait for it to finish.' };
  }
  const exists = /a branch named '([^']+)' already exists/i.exec(out);
  if (exists) return { message: `A branch named "${exists[1]}" already exists` };
  const badName = /'([^']+)' is not a valid branch name/i.exec(out);
  if (badName) return { message: `"${badName[1]}" can't be a branch's name` };
  const dest = /destination path '([^']+)' already exists and is not an empty directory/i.exec(out);
  if (dest) return { message: `Can't clone because the folder "${dest[1]}" already exists`, detail: 'To clone, choose another name or folder.' };
  const words = gitWords(r);
  return { message: `Can't ${action}`, ...(words ? { detail: words } : {}) };
}


const DRIVE = /^([a-z]):(?:[\\/](.*))?$/i;
const WSL_SHARE = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/][^\\/]+(?:[\\/](.*))?$/i;
const MNT = /^\/mnt\/([a-z])(?:\/(.*))?$/i;

const trimEnd = (p: string): string => p.replace(/[\\/]+$/, '');

/**
 * A folder picked in Looper (as the addon's side sees it) in the form an
 * environment on `side` uses: for WSL, C:\x is /mnt/c/x and
 * \\wsl.localhost\Ubuntu\home\x is /home/x; for Windows, /mnt/c/x is C:\x.
 * A WSL folder outside /mnt can't be named for Windows without its distro.
 */
export function toSidePath(path: string, side: AddonSide): string {
  const p = path.trim();
  if (side === 'wsl') {
    const drive = DRIVE.exec(p);
    if (drive) return trimEnd(`/mnt/${drive[1].toLowerCase()}/${(drive[2] ?? '').replace(/\\/g, '/')}`);
    const share = WSL_SHARE.exec(p);
    if (share) return `/${trimEnd((share[1] ?? '').replace(/\\/g, '/'))}`;
    return p.length > 1 ? trimEnd(p) : p;
  }
  const mnt = MNT.exec(p);
  if (mnt) return trimEnd(`${mnt[1].toUpperCase()}:\\${(mnt[2] ?? '').replace(/\//g, '\\')}`) + (mnt[2] ? '' : '\\');
  const drive = DRIVE.exec(p);
  if (drive) {
    const rest = trimEnd((drive[2] ?? '').replace(/\//g, '\\'));
    return `${drive[1].toUpperCase()}:\\${rest}`;
  }
  if (WSL_SHARE.test(p) || p.startsWith('\\\\')) return p;
  throw new Error("Can't clone into this folder from a Windows environment, which reaches only folders on a Windows drive");
}

/** A folder and a name in it, with the separator of `side`. */
export function joinSidePath(folder: string, name: string, side: AddonSide): string {
  const sep = side === 'wsl' ? '/' : '\\';
  return folder.endsWith('/') || folder.endsWith('\\') ? folder + name : folder + sep + name;
}

/** The folder name git clone would choose: the URL's last part without ".git". */
export function nameFromUrl(url: string): string {
  const last = url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? '';
  return last.replace(/\.git$/i, '').replace(/\.bundle$/i, '');
}

/** Why a folder name can't be used, or undefined when it can. */
export function badFolderName(name: string): string | undefined {
  if (!name) return 'The folder needs a name';
  if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return `"${name}" can't be a folder's name`;
  return undefined;
}
