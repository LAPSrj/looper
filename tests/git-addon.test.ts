import { describe, expect, it } from 'vitest';
import { commandStates } from '../src/addons/git/addon';
import { MANIFEST } from '../src/addons/git/manifest';
import { badFolderName, itemId, joinSidePath, nameFromUrl, needsIdentity, pathRowId, repoDescription, toSidePath } from '../src/addons/git/text';
import { AddonCommandStateSchema, readAddonManifest } from '../src/shared/addons';
import type { GitStatus } from '../src/shared/git';

const status = (over: Partial<GitStatus> = {}): GitStatus => ({ root: '/r', branch: 'main', ahead: 0, behind: 0, initial: false, changes: [], ...over });
const change = (path: string) => ({ path, kind: 'modified' as const, staged: false, unstaged: true });

describe('the Git addon manifest', () => {
  it('passes readAddonManifest', () => {
    const r = readAddonManifest(JSON.parse(JSON.stringify(MANIFEST)));
    expect(r).toMatchObject({ ok: true });
  });

  it("names every command the item, project tab and screen states set", () => {
    const ids = new Set(MANIFEST.commands.map((c) => c.id));
    for (const s of [commandStates({ repo: false }), commandStates({ repo: false, missing: 'git' }), commandStates({ repo: true, remotes: [], ...status() })]) {
      for (const [id, state] of Object.entries(s)) {
        expect(ids.has(id), id).toBe(true);
        expect(AddonCommandStateSchema.safeParse(state).success).toBe(true);
      }
    }
  });
});

describe('command states', () => {
  it('shows only Create Repository for a folder that is not a repository', () => {
    const s = commandStates({ repo: false });
    expect(s.init).toMatchObject({ hidden: false, enabled: true });
    for (const id of ['commit', 'pull', 'push', 'sync', 'fetch', 'branches', 'repo-settings']) expect(s[id]).toEqual({ hidden: true });
  });

  it('hides every command, Create Repository too, without git or without the folder', () => {
    for (const missing of ['git', 'folder'] as const) {
      const s = commandStates({ repo: false, missing });
      for (const id of ['commit', 'pull', 'push', 'sync', 'fetch', 'branches', 'repo-settings', 'init']) expect(s[id], id).toEqual({ hidden: true });
    }
  });

  it('turns off Commit without changes and the remote commands without a remote', () => {
    const s = commandStates({ repo: true, remotes: [], ...status() });
    expect(s.init).toEqual({ hidden: true });
    expect(s.commit.enabled).toBe(false);
    expect(s.push.enabled).toBe(false);
    expect(s.sync.enabled).toBe(false);
    expect(s.branches.enabled).toBe(true);
    expect(s['repo-settings']).toEqual({ hidden: false, enabled: true });
    const ready = commandStates({ repo: true, remotes: [{ name: 'origin', url: 'u' }], ...status({ changes: [change('a')] }) });
    expect(ready.commit.enabled).toBe(true);
    expect(ready.push.enabled).toBe(true);
    expect(ready.sync.enabled).toBe(true);
  });
});

describe('descriptions', () => {
  it('describes a repository by its branch and what changed', () => {
    expect(repoDescription(status())).toBe('main');
    expect(repoDescription(status({ changes: [change('a'), change('b')], ahead: 1 }))).toBe('main · 2 changed · 1 ahead');
    expect(repoDescription(status({ ahead: 2, behind: 3 }))).toBe('main · 2 ahead · 3 behind');
    expect(repoDescription(status({ branch: undefined, detachedAt: 'abc1234' }))).toBe('Detached at abc1234');
    expect(repoDescription(status({ initial: true, changes: [change('a')] }))).toBe('main · no commits yet · 1 changed');
  });

  it('makes ids Looper accepts', () => {
    const ID = /^[a-z0-9][a-z0-9._:-]*$/i;
    expect(itemId('webapp')).toBe('webapp');
    for (const id of ['my project', '/home/x', 'x-1', '-a']) {
      expect(itemId(id)).toMatch(ID);
      expect(itemId(id)).not.toBe(itemId(`${id}2`));
    }
    expect(pathRowId('src/a b.ts')).toMatch(ID);
    expect(pathRowId('src/é.ts')).not.toBe(pathRowId('src/e.ts'));
  });
});

describe('needsIdentity', () => {
  it.each([
    '*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"',
    'Author identity unknown\n\nfatal: unable to auto-detect email address (got \'me@box.(none)\')',
    "fatal: empty ident name (for <me@box>) not allowed",
  ])('sees a missing name or email in %s', (out) => {
    expect(needsIdentity(out)).toBe(true);
  });

  it('sees nothing in another failure', () => {
    expect(needsIdentity('nothing added to commit but untracked files present')).toBe(false);
    expect(needsIdentity("error: pathspec 'x' did not match any file(s) known to git")).toBe(false);
  });
});

describe('the clone folder', () => {
  it('converts a Windows folder for a WSL environment', () => {
    expect(toSidePath('C:\\Users\\me\\repos', 'wsl')).toBe('/mnt/c/Users/me/repos');
    expect(toSidePath('D:\\', 'wsl')).toBe('/mnt/d');
    expect(toSidePath('c:/work/', 'wsl')).toBe('/mnt/c/work');
    expect(toSidePath('\\\\wsl.localhost\\Ubuntu\\home\\me\\src', 'wsl')).toBe('/home/me/src');
    expect(toSidePath('\\\\wsl$\\Ubuntu-24.04\\home\\me', 'wsl')).toBe('/home/me');
    expect(toSidePath('/home/me/src/', 'wsl')).toBe('/home/me/src');
    expect(toSidePath('/', 'wsl')).toBe('/');
  });

  it('converts a WSL folder for a Windows environment', () => {
    expect(toSidePath('/mnt/c/Users/me/repos', 'windows')).toBe('C:\\Users\\me\\repos');
    expect(toSidePath('/mnt/d', 'windows')).toBe('D:\\');
    expect(toSidePath('C:\\Users\\me\\', 'windows')).toBe('C:\\Users\\me');
    expect(toSidePath('c:/x', 'windows')).toBe('C:\\x');
    expect(() => toSidePath('/home/me', 'windows')).toThrow(/Windows drive/);
  });

  it('joins the folder and the name with the side separator', () => {
    expect(joinSidePath('/mnt/c/repos', 'app', 'wsl')).toBe('/mnt/c/repos/app');
    expect(joinSidePath('/', 'app', 'wsl')).toBe('/app');
    expect(joinSidePath('C:\\repos', 'app', 'windows')).toBe('C:\\repos\\app');
    expect(joinSidePath('D:\\', 'app', 'windows')).toBe('D:\\app');
  });

  it('names the folder after the URL', () => {
    expect(nameFromUrl('https://github.com/me/looper.git')).toBe('looper');
    expect(nameFromUrl('https://github.com/me/looper/')).toBe('looper');
    expect(nameFromUrl('git@github.com:me/tools.git')).toBe('tools');
    expect(nameFromUrl('/srv/git/site.git')).toBe('site');
    expect(badFolderName('looper')).toBeUndefined();
    expect(badFolderName('')).toMatch(/name/);
    expect(badFolderName('a/b')).toMatch(/can't/);
  });
});
