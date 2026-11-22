// What the Preview window and a device's file viewer work out from a file before drawing it. No DOM: the unit tests load this.

/**
 * The delimiter of a delimited text file: a tab for .tsv; otherwise a comma, or a semicolon when the
 * first line has more of them outside quotes (Excel writes ; where the decimal mark is a comma).
 */
export function sniffDelimiter(name: string, text: string): string {
  if (/\.tsv$/i.test(name)) return '\t';
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === '\n' || c === '\r') break;
    else if (c === ',') commas++;
    else if (c === ';') semis++;
  }
  return semis > commas ? ';' : ',';
}

/**
 * A delimited text file's rows, as RFC 4180 reads them: a field in double quotes may hold the delimiter,
 * line breaks and doubled quotes; CRLF, LF and CR end a row; a leading byte-order mark is skipped.
 * A quote inside an unquoted field is kept as it is.
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (i >= n) return rows;
  for (;;) {
    let field: string;
    if (text[i] === '"') {
      // A quoted field: up to the quote that isn't doubled, then anything before the next delimiter or line end.
      let parts = '';
      let at = i + 1;
      for (;;) {
        const q = text.indexOf('"', at);
        if (q === -1) {
          parts += text.slice(at);
          at = n;
          break;
        }
        parts += text.slice(at, q);
        if (text[q + 1] === '"') {
          parts += '"';
          at = q + 2;
        } else {
          at = q + 1;
          break;
        }
      }
      let end = at;
      while (end < n && text[end] !== delimiter && text[end] !== '\n' && text[end] !== '\r') end++;
      field = parts + text.slice(at, end);
      i = end;
    } else {
      let end = i;
      while (end < n && text[end] !== delimiter && text[end] !== '\n' && text[end] !== '\r') end++;
      field = text.slice(i, end);
      i = end;
    }
    row.push(field);
    if (i >= n) {
      rows.push(row);
      return rows;
    }
    if (text[i] === delimiter) {
      i++;
      // A delimiter at the very end still ends with an empty field.
      if (i >= n) {
        row.push('');
        rows.push(row);
        return rows;
      }
      continue;
    }
    // A line end: CRLF counts once; the file's last line end adds no empty row.
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= n) return rows;
  }
}

/** A spreadsheet column's name by its index from 0: A … Z, AA … ZZ, AAA …. */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * The file an HTML page Preview shows was read from, so the page loads the files next to it: one the agent sent,
 * read or wrote (`taskId`, and its path in the session's form, as sessions.readSentFile takes it), or a path on
 * the computer (a device's file viewer).
 */
export interface PreviewSource {
  taskId?: string;
  path: string;
}

/** Settings → Advanced → Previewed web pages' network access. */
export const PREVIEW_NETWORKS = ['allow', 'ask', 'deny'] as const;
export type PreviewNetwork = (typeof PREVIEW_NETWORKS)[number];

/** How Settings names each choice. */
export const PREVIEW_NETWORK_CHOICES: Record<PreviewNetwork, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };

/** The message an Ask page's frame posts to the viewer when it blocked a load from the internet. */
export const PREVIEW_BLOCKED = 'looper-preview-blocked';

/**
 * The key of the message the viewer posts to the page's frame with the room to leave after the page's end, in CSS
 * pixels: on a phone, the safe area under a sheet the page runs to the bottom edge of, so its end can scroll above
 * the home indicator (the scroll view's inset in Safari).
 */
export const PREVIEW_END = 'looper-preview-end';

/**
 * What the frame may do on the computer: run scripts, never share an origin with Looper, and open nothing by
 * itself, since Electron has no popup blocker (a script's window.open went to the default browser without a click).
 * The frames in it get the same. A click the user makes on a link, in the page or in any frame in it, reaches main
 * from Looper's preload instead (forwardPreviewLinks in src/preload/index.ts), which opens it.
 */
export const PREVIEW_SANDBOX = 'allow-scripts';
/** On a device, whose browser opens a popup only on the user's tap: a link opens in a new tab from the frame. */
export const PREVIEW_SANDBOX_DEVICE = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

/**
 * The Content-Security-Policy an HTML page is served with in Preview. Its sandbox directive gives the page an
 * origin of its own even when its address is opened outside the frame. `remote`: it may load from the internet;
 * otherwise only what's inline in the file (data: and blob: too) loads. `files`: the page's folder is served
 * beside it, so its scripts, styles, images, fonts and media load from its own address ('self') too; what it
 * fetches, and the frames in it, don't.
 */
export function previewFrameCsp(remote: boolean, device = false, files = false): string {
  const local = "'unsafe-inline' 'unsafe-eval' data: blob:";
  const net = (files ? "'self' " : '') + (remote ? '* ' : '');
  return [
    `sandbox ${device ? PREVIEW_SANDBOX_DEVICE : PREVIEW_SANDBOX}`,
    `default-src ${remote ? `* ${local}` : "'none'"}`,
    `script-src ${net}${local}`,
    `style-src ${net}'unsafe-inline' data: blob:`,
    `img-src ${net}data: blob:`,
    `font-src ${net}data: blob:`,
    `media-src ${net}data: blob:`,
    `connect-src ${remote ? '* data: blob:' : "'none'"}`,
    `frame-src ${remote ? '* data: blob:' : "'none'"}`,
    "form-action 'none'",
  ].join('; ');
}

/**
 * An HTML file as the Preview's frame loads it: links open outside the frame (in the default browser on
 * the computer, a new tab on a phone), apart from a link to a place in the page, which moves there.
 * `reportBlocked`: a script first in the page tells the viewer when a load from the internet was blocked, for
 * the Ask setting's bar.
 */
export function previewHtmlDocument(html: string, opts: { reportBlocked?: boolean } = {}): string {
  const report = opts.reportBlocked
    ? `<script>addEventListener('securitypolicyviolation',function(e){if(/^(https?|wss?):/i.test(e.blockedURI))parent.postMessage('${PREVIEW_BLOCKED}','*')});</script>`
    : '';
  // <base target="_blank"> would send #section to a new window too (nothing on the computer, the page again in a new tab on a phone).
  const inPage = `<script>addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null,h=a&&a.getAttribute('href');if(e.defaultPrevented||!h||h.charAt(0)!=='#'||a.hasAttribute('target'))return;e.preventDefault();location.hash=h});</script>`;
  // The room the viewer asks for after the page's end (PREVIEW_END): a box after the body, in the page's own scroller.
  const end = `<script>addEventListener('message',function(e){var n=e.data&&e.data['${PREVIEW_END}'];if(e.source!==parent||typeof n!=='number')return;var s=document.getElementById('${PREVIEW_END}');if(!s){s=document.createElement('style');s.id='${PREVIEW_END}';document.documentElement.appendChild(s)}s.textContent=n>0?'html::after{content:"";display:block;height:'+Math.min(n,400)+'px}':''});</script>`;
  const base = '<base target="_blank">' + inPage + end + report;
  // First, after a doctype: a <head> or <html> after it still makes the same document.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + base + html.slice(at);
}

/** The width a page is laid out at for Desktop Width, in CSS pixels. */
export const DESKTOP_WIDTH = 1280;
