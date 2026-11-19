import { describe, expect, it } from 'vitest';
import { gitProblem, gitWords } from '../src/addons/git/text';

const err = (stderr: string) => ({ stdout: '', stderr });

describe("the Git addon's messages follow Windows' error message guidelines", () => {
  it('says a sign-in was refused as "The user name or password is incorrect", naming the server', () => {
    expect(gitProblem(err("fatal: Authentication failed for 'http://127.0.0.1:8765/demo.git/'\n"), 'fetch')).toEqual({
      message: 'The user name or password for 127.0.0.1:8765 is incorrect',
    });
  });

  it('names a repository that could not be found, with the likely causes', () => {
    const p = gitProblem(err("remote: Repository not found.\nfatal: repository 'https://github.com/example/demo.git/' not found\n"), 'fetch');
    expect(p.message).toBe("Can't find the repository at https://github.com/example/demo.git/");
    expect(p.detail).toBe('The address may be wrong, or the account may not have access to it.');
  });

  it('explains a rejected push and how to fix it, results before the action', () => {
    const p = gitProblem(
      err(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:a/b.git'\nhint: Updates were rejected because the remote contains work that you do\n"),
      'push',
    );
    expect(p).toEqual({ message: "Can't push because the remote branch has commits this branch doesn't", detail: 'To get them, pull first, or use Sync.' });
  });

  it('names the host an SSH key was refused by', () => {
    expect(gitProblem(err('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n'), 'push').message).toBe(
      "github.com doesn't accept the SSH key",
    );
  });

  it("falls back to git's own words without its fatal and error prefixes or hints, and never ends a main instruction with a period", () => {
    const p = gitProblem(err('error: something odd happened\nhint: try this\nfatal: the ref is weird\n'), 'push');
    expect(p).toEqual({ message: "Can't push", detail: 'Something odd happened.\nThe ref is weird.' });
    expect(gitWords(err('fatal: x is broken:\n'))).toBe('X is broken:');
  });

  it('quotes object names', () => {
    expect(gitProblem(err("fatal: a branch named 'feature' already exists\n"), 'create the branch').message).toBe('A branch named "feature" already exists');
  });
});
