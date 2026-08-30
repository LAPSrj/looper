import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/shared/ansi';
import { TRUST_PROMPT_RE, WAITING_PROMPT_RE, systemFooter } from '../src/engine/steps/agent';

// Real fragments captured from a claude pty session (cursor-column moves between words).
const TRUST_DIALOG =
  '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\r\n' +
  '\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\n\x1b[2G\x1b[38;5;246mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[39m';
const PERMISSION_PROMPT =
  '\x1b[39mDo you want\x1b[14Gto\x1b[17Gcreate\x1b[24G\x1b[1mhello.txt\x1b[22m?\x1b[1C\x1b[1B\x1b[38;5;153m❯\x1b[4G\x1b[38;5;246m1. \x1b[38;5;153mYes' +
  '\x1b[1B\x1b[22m\x1b[38;5;246m3. \x1b[39mNo\x1b[1C\x1b[2B\x1b[38;5;246mEsc to cancel · Tab to amend\x1b[39m';
const WORKING = '\x1b[38;5;246m✻ Thinking… (esc to interrupt)\x1b[39m';

describe('prompt detection', () => {
  it('sees the trust dialog through cursor moves', () => {
    expect(TRUST_PROMPT_RE.test(stripAnsi(TRUST_DIALOG))).toBe(true);
    expect(TRUST_PROMPT_RE.test(stripAnsi(PERMISSION_PROMPT))).toBe(false);
  });
  it('sees a permission prompt but not a working spinner', () => {
    expect(WAITING_PROMPT_RE.test(stripAnsi(PERMISSION_PROMPT))).toBe(true);
    expect(WAITING_PROMPT_RE.test(stripAnsi(TRUST_DIALOG))).toBe(true);
    expect(WAITING_PROMPT_RE.test(stripAnsi(WORKING))).toBe(false);
  });
});

describe('stripAnsi', () => {
  it('turns column moves into spaces and drops colours', () => {
    expect(stripAnsi('\x1b[2GQuick\x1b[8Gsafety\x1b[38;5;246mcheck\x1b[39m')).toBe(' Quick safetycheck');
  });
});

describe('systemFooter', () => {
  it('tells interactive agents to call looper-done, headless ones not', () => {
    expect(systemFooter('T', 'r1', false)).toContain('looper-done');
    expect(systemFooter('T', 'r1', true)).not.toContain('looper-done');
  });
});
