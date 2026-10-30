import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { subagentStatsOfLine } from '../src/engine/context';
import { GitService } from '../src/engine/git';
import { Logger } from '../src/engine/log';
import { branchText, changeText, parseDiff, parseLog, parseNameStatus, parseStatus } from '../src/shared/git';
import { TaskSchema, type Settings, type Task } from '../src/shared/types';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'looper-git-'));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function service(cwd: string, repos: string[][] = []): GitService {
  const task = { ...TaskSchema.parse({ id: 'p', name: 'p', environmentId: 'e', cwd, trigger: { mode: 'manual' }, agent: { prompt: 'x' } }) } as Task;
  return new GitService({
    projectTask: (id) => (id === 'p' ? task : undefined),
    projectIds: () => ['p'],
    settings: () => ({ environments: [{ id: 'e', kind: 'local', name: 'Local' }] }) as unknown as Settings,
    host: 'linux',
    log: new Logger(path.join(tmp(), 'log')),
    onRepos: (ids) => repos.push(ids),
  });
}

describe('git output parsers', () => {
  it('reads porcelain v2 status: branch facts, renames with their old path, untracked and conflicted files', () => {
    const out = [
      '# branch.oid 0123456789abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
      '1 A. N... 000000 100644 100644 000 ccc new.ts',
      '2 R. N... 100644 100644 100644 ddd ddd R100 src/renamed.ts',
      'src/old.ts',
      'u UU N... 100644 100644 100644 100644 e f g both.ts',
      '? notes.txt',
      '',
    ].join('\0');
    const s = parseStatus(out);
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, initial: false });
    expect(s.changes).toEqual([
      { path: 'src/a file.ts', kind: 'modified', staged: false, unstaged: true },
      { path: 'new.ts', kind: 'added', staged: true, unstaged: false },
      { path: 'src/renamed.ts', origPath: 'src/old.ts', kind: 'renamed', staged: true, unstaged: false },
      { path: 'both.ts', kind: 'conflicted', staged: false, unstaged: true },
      { path: 'notes.txt', kind: 'untracked', staged: false, unstaged: true },
    ]);
    expect(s.changes.map(changeText)).toEqual(['Modified', 'Added, staged', 'Renamed, staged', 'Conflict', 'Untracked']);
  });

  it('names a detached HEAD by its commit and a branch without commits as such', () => {
    expect(parseStatus('# branch.oid 0123456789abcdef\0# branch.head (detached)\0').detachedAt).toBe('0123456');
    const fresh = parseStatus('# branch.oid (initial)\0# branch.head main\0');
    expect(fresh.initial).toBe(true);
    expect(branchText({ ...fresh, root: '/r' })).toBe('On main · no commits yet');
  });

  it('says how far the branch is from its upstream', () => {
    const base = { root: '/r', branch: 'main', upstream: 'origin/main', initial: false, changes: [] };
    expect(branchText({ ...base, ahead: 0, behind: 0 })).toBe('On main · up to date with origin/main');
    expect(branchText({ ...base, ahead: 2, behind: 0 })).toBe('On main · 2 ahead of origin/main');
    expect(branchText({ ...base, ahead: 0, behind: 3 })).toBe('On main · 3 behind origin/main');
    expect(branchText({ ...base, ahead: 2, behind: 3 })).toBe('On main · 2 ahead of and 3 behind origin/main');
    expect(branchText({ ...base, upstream: undefined, ahead: 0, behind: 0 })).toBe('On main · no remote');
  });

  it('reads log records whose subject has the field separators of a plain format', () => {
    const out = 'abc123\x1fabc\x1fAna\x1f1700000000\x1fHEAD -> main, origin/main, tag: v1\x1fFix: a | b, c\x1e\ndef456\x1fdef\x1fBo\x1f1690000000\x1f\x1fFirst\x1e\n';
    expect(parseLog(out)).toEqual([
      { hash: 'abc123', shortHash: 'abc', author: 'Ana', at: 1700000000000, refs: ['main', 'origin/main', 'tag: v1'], subject: 'Fix: a | b, c' },
      { hash: 'def456', shortHash: 'def', author: 'Bo', at: 1690000000000, refs: [], subject: 'First' },
    ]);
  });

  it('reads name-status records with renames, and a diff as hunks or as binary', () => {
    expect(parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone.ts\0')).toEqual([
      { path: 'a.ts', kind: 'modified' },
      { path: 'new.ts', origPath: 'old.ts', kind: 'renamed' },
      { path: 'gone.ts', kind: 'deleted' },
    ]);
    const d = parseDiff('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@ fn\n a\n-b\n+c\n+d\n@@ -10 +11 @@\n-x\n+y\n');
    expect(d.hunks).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] },
      { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, lines: ['-x', '+y'] },
    ]);
    expect(parseDiff('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n')).toMatchObject({ binary: true, hunks: [] });
  });
});

describe.skipIf(!hasGit)('GitService on a real repository', () => {
  it('lists uncommitted changes against the upstream, and diffs a changed and an untracked file', async () => {
    const origin = tmp();
    git(origin, 'init', '-q');
    fs.writeFileSync(path.join(origin, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(origin, 'old.txt'), 'kept\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'First');
    const work = path.join(tmp(), 'work');
    git(path.dirname(work), 'clone', '-q', origin, work);
    fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, 'add', 'b.txt');
    git(work, 'commit', '-q', '-m', 'Second');
    fs.writeFileSync(path.join(work, 'a.txt'), 'one\nthree\n');
    git(work, 'mv', 'old.txt', 'new.txt');
    fs.mkdirSync(path.join(work, 'sub'));
    fs.writeFileSync(path.join(work, 'sub', 'u.txt'), 'u\n');
    const repos: string[][] = [];
    const g = service(path.join(work, 'sub'), repos);

    const s = await g.status('p');
    if (!s.repo) throw new Error('not a repo');
    expect(s.root).toBe(fs.realpathSync(work));
    expect(branchText(s)).toBe('On main · 1 ahead of origin/main');
    expect(s.changes).toEqual([
      { path: 'a.txt', kind: 'modified', staged: false, unstaged: true },
      { path: 'new.txt', origPath: 'old.txt', kind: 'renamed', staged: true, unstaged: false },
      { path: 'sub/u.txt', kind: 'untracked', staged: false, unstaged: true },
    ]);
    expect(repos.at(-1)).toEqual(['p']);
    expect(g.isRepo('p')).toBe(true);

    const a = await g.changeDiff('p', s.changes[0], false);
    expect(a.hunks[0].lines).toEqual([' one', '-two', '+three']);
    const u = await g.changeDiff('p', s.changes[2], false);
    expect(u.hunks[0].lines).toEqual(['+u']);
    const r = await g.changeDiff('p', s.changes[1], false);
    expect(r.hunks).toEqual([]);
  });

  it('reads the history page by page, a commit with its files, a merge against its first parent, and the first commit', async () => {
    const repo = tmp();
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'First');
    git(repo, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'Side work', '-m', 'With a body.');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\nb\n');
    git(repo, 'commit', '-q', '-am', 'Main work');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    const g = service(repo);

    const all = await g.log('p', 0, 200);
    expect(all.map((c) => c.subject)).toEqual(['Merge side', 'Main work', 'Side work', 'First']);
    expect(all[0].refs).toEqual(['main']);
    expect((await g.log('p', 1, 2)).map((c) => c.subject)).toEqual(['Main work', 'Side work']);

    const side = await g.commit('p', all[2].hash);
    expect(side).toMatchObject({ subject: 'Side work', body: 'With a body.', email: 't@example.com', files: [{ path: 'side.txt', kind: 'added' }] });
    const merge = await g.commit('p', all[0].hash);
    expect(merge.parents).toHaveLength(2);
    expect(merge.files).toEqual([{ path: 'side.txt', kind: 'added' }]);
    const first = await g.commit('p', all[3].hash);
    expect(first.files).toEqual([{ path: 'a.txt', kind: 'added' }]);

    const d = await g.commitDiff('p', all[1].hash, 'a.txt');
    expect(d.hunks[0].lines).toEqual([' a', '+b']);
    expect((await g.commitDiff('p', all[0].hash, 'side.txt')).hunks[0].lines).toEqual(['+side']);
    expect((await g.commitDiff('p', all[3].hash, 'a.txt')).hunks[0].lines).toEqual(['+a']);
    await expect(g.commit('p', 'not-a-hash')).rejects.toThrow("isn't a commit id");
  });

  it('handles a branch without commits, and a folder outside any repository', async () => {
    const repo = tmp();
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'n.txt'), 'n\n');
    git(repo, 'add', 'n.txt');
    const g = service(repo);
    const s = await g.status('p');
    if (!s.repo) throw new Error('not a repo');
    expect(s.initial).toBe(true);
    expect(s.changes).toEqual([{ path: 'n.txt', kind: 'added', staged: true, unstaged: false }]);
    expect((await g.changeDiff('p', s.changes[0], true)).hunks[0].lines).toEqual(['+n']);
    expect(await g.log('p', 0, 200)).toEqual([]);

    const plain = service(tmp());
    expect(await plain.status('p')).toEqual({ repo: false });
    expect(await plain.check('p')).toBe(false);
  });
});

describe('subagent stats', () => {
  it("reads a subagent response's model, effort and context, and skips other lines", () => {
    const rec = {
      type: 'assistant',
      isSidechain: true,
      effort: 'medium',
      message: { model: 'claude-haiku-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 31151, cache_creation_input_tokens: 2148 } },
    };
    expect(subagentStatsOfLine(JSON.stringify(rec))).toEqual({ model: 'claude-haiku-5-5', effort: 'medium', tokens: 33301 });
    expect(subagentStatsOfLine(JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBeNull();
    expect(subagentStatsOfLine(JSON.stringify({ ...rec, message: { ...rec.message, model: '<synthetic>' } }))).toBeNull();
  });
});
