import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/shared/ansi';
import { ScreenModel } from '../src/engine/screen';
import { CODEX_TRUST_PROMPT_RE, HEADLINE_MAX, TRUST_PROMPT_RE, WAITING_PROMPT_RE, headlineOf, parseDoneSignal, systemFooter } from '../src/engine/steps/agent';

// Real fragments captured from a claude pty session (cursor-column moves between words).
const TRUST_DIALOG =
  '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\r\n' +
  '\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\n\x1b[2G\x1b[38;5;246mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[39m';
const PERMISSION_PROMPT =
  '\x1b[39mDo you want\x1b[14Gto\x1b[17Gcreate\x1b[24G\x1b[1mhello.txt\x1b[22m?\x1b[1C\x1b[1B\x1b[38;5;153m❯\x1b[4G\x1b[38;5;246m1. \x1b[38;5;153mYes' +
  '\x1b[1B\x1b[22m\x1b[38;5;246m3. \x1b[39mNo\x1b[1C\x1b[2B\x1b[38;5;246mEsc to cancel · Tab to amend\x1b[39m';
const WORKING = '\x1b[38;5;246m✻ Thinking… (esc to interrupt)\x1b[39m';

describe('prompt detection (regexes on stripped bytes)', () => {
  it('sees the trust dialog through cursor moves', () => {
    expect(TRUST_PROMPT_RE.test(stripAnsi(TRUST_DIALOG))).toBe(true);
    expect(TRUST_PROMPT_RE.test(stripAnsi(PERMISSION_PROMPT))).toBe(false);
  });
  it('sees a permission prompt but not a working spinner', () => {
    expect(WAITING_PROMPT_RE.test(stripAnsi(PERMISSION_PROMPT))).toBe(true);
    expect(WAITING_PROMPT_RE.test(stripAnsi(WORKING))).toBe(false);
  });
});

describe('ScreenModel', () => {
  it('reports what is visible, and forgets a prompt once the screen is redrawn without it', async () => {
    const screen = new ScreenModel(120, 32);
    await screen.write('\x1b[?1049h\x1b[H' + PERMISSION_PROMPT);
    expect(screen.contains(WAITING_PROMPT_RE)).toBe(true);
    // Partial re-render of the top of the screen must NOT hide the prompt.
    await screen.write('\x1b[H\x1b[1mCheck output\x1b[22m lots of text redrawn at the top');
    expect(screen.contains(WAITING_PROMPT_RE)).toBe(true);
    // Full clear + working spinner: prompt gone.
    await screen.write('\x1b[2J\x1b[H' + WORKING);
    expect(screen.contains(WAITING_PROMPT_RE)).toBe(false);
    expect(screen.text()).toContain('Thinking');
    screen.dispose();
  });
  it('sees the trust dialog', async () => {
    const screen = new ScreenModel(120, 32);
    await screen.write(TRUST_DIALOG);
    expect(screen.contains(TRUST_PROMPT_RE)).toBe(true);
    screen.dispose();
  });
  it('sees the codex trust dialog and only that one', async () => {
    // Wording captured live from codex-cli 0.154.0.
    const screen = new ScreenModel(120, 32);
    await screen.write(
      'Do you trust the contents of this directory?\r\n' +
        'Working with untrusted contents comes with higher risk of prompt injection.\r\n' +
        '› 1. Yes, continue\r\n  2. No, quit\r\nPress enter to continue',
    );
    expect(screen.contains(CODEX_TRUST_PROMPT_RE)).toBe(true);
    expect(screen.contains(TRUST_PROMPT_RE)).toBe(false);
    screen.dispose();
  });
});

describe('stripAnsi', () => {
  it('turns column moves into spaces and drops colours', () => {
    expect(stripAnsi('\x1b[2GQuick\x1b[8Gsafety\x1b[38;5;246mcheck\x1b[39m')).toBe(' Quick safetycheck');
  });
});

describe('systemFooter', () => {
  it('asks for a looper-done status + headline followed by a final report message in both modes', () => {
    for (const headless of [false, true]) {
      const footer = systemFooter('T', 'r1', headless);
      expect(footer).toContain('looper-done <status> "<headline>"');
      expect(footer).toContain('success, warning or error');
      expect(footer).toContain('final message');
    }
    // Only the interactive session is closed by Looper.
    expect(systemFooter('T', 'r1', false)).toContain('closes this session');
    expect(systemFooter('T', 'r1', true)).not.toContain('closes this session');
  });

  it('teaches looper-complete only to an agent whose task allows it', () => {
    expect(systemFooter('T', 'r1', false)).not.toContain('looper-complete');
    expect(systemFooter('T', 'r1', false, true)).toContain('looper-complete "<why>"');
  });
});

describe('parseDoneSignal', () => {
  it('reads the status from the first line, the headline from the rest', () => {
    expect(parseDoneSignal('warning\nDeployed with caveats\n')).toEqual({
      status: 'warning',
      message: 'Deployed with caveats',
    });
    expect(parseDoneSignal('error\nBlocked: staging DB unreachable')).toEqual({
      status: 'error',
      message: 'Blocked: staging DB unreachable',
    });
    expect(parseDoneSignal('success\ndone\n')).toEqual({ status: 'success', message: 'done' });
  });
  it('treats a file without a status line as success', () => {
    expect(parseDoneSignal('Fixed 3 tests')).toEqual({ status: 'success', message: 'Fixed 3 tests' });
    expect(parseDoneSignal('warning')).toEqual({ status: 'warning', message: '' });
  });
});

describe('headlineOf', () => {
  it('is the first non-empty line, without heading markers, capped', () => {
    expect(headlineOf(undefined)).toBeUndefined();
    expect(headlineOf('  \n\n')).toBeUndefined();
    expect(headlineOf('\n## Fixed 3 tests\n\nmore text')).toBe('Fixed 3 tests');
    const long = headlineOf('x'.repeat(HEADLINE_MAX * 2))!;
    expect(long.length).toBe(HEADLINE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});
