// eslint-disable-next-line no-control-regex
const CSI_COLUMN = /\x1b\[\d*G/g;
// eslint-disable-next-line no-control-regex
const ANSI =
  /[\x1b\x9b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\x07)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

/** Strip terminal escape sequences. Cursor-column moves become spaces so words stay separated. */
export function stripAnsi(s: string): string {
  return s.replace(CSI_COLUMN, ' ').replace(ANSI, '');
}
