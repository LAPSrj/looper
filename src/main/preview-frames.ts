import { randomBytes } from 'node:crypto';
import { previewFrameCsp, previewHtmlDocument, type PreviewNetwork } from '../shared/preview';

/** An HTML file Preview shows, as its frame is served: the page and the policy it runs under. */
export interface PreviewFrame {
  html: string;
  csp: string;
}

/** How long a page stays served, and how many are kept: a window reloading its frame gets it again. */
const TTL_MS = 30 * 60_000;
const MAX = 40;
const frames = new Map<string, PreviewFrame & { at: number }>();

function prune(now: number): void {
  for (const [token, f] of frames) if (now - f.at > TTL_MS) frames.delete(token);
  while (frames.size > MAX) frames.delete(frames.keys().next().value as string);
}

/**
 * Keeps an HTML file to serve to Preview's frame under an unguessable token: from looper-preview://<token>/ on
 * the computer, /preview-frame/<token> on Remote Access. `network`: 'ask' serves it with loads from the internet
 * blocked and tells the viewer when one was, for its bar. `device`: for a device's browser, whose popup blocker
 * lets a link open from the frame only on a tap; the computer's frame opens nothing, and Looper's preload sends
 * the links the user clicks in it to main (inPreviewPage).
 */
export function addPreviewFrame(html: string, network: PreviewNetwork, device = false): string {
  const now = Date.now();
  prune(now);
  const token = randomBytes(16).toString('hex');
  frames.set(token, { html: previewHtmlDocument(html, { reportBlocked: network === 'ask' }), csp: previewFrameCsp(network === 'allow', device), at: now });
  return token;
}

/** A frame of a window as main sees it (Electron's WebFrameMain). */
export interface FrameLike {
  readonly url: string;
  readonly parent: FrameLike | null;
}

/**
 * Whether a frame is a page Preview shows on the computer, or a frame inside one, at any depth: it, or a frame
 * it's in, is served from looper-preview://. A link the user clicks in one opens in the browser.
 */
export function inPreviewPage(frame: FrameLike | null | undefined): boolean {
  for (let f = frame; f; f = f.parent) if (f.url.startsWith('looper-preview://')) return true;
  return false;
}

/** The page kept under `token`, or undefined once it's gone. */
export function previewFrame(token: string): PreviewFrame | undefined {
  prune(Date.now());
  return frames.get(token);
}

/** The headers a previewed page is served with, wherever it's served. */
export function previewFrameHeaders(f: PreviewFrame): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': f.csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}
