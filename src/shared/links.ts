/**
 * Whether a link may leave Looper for the system: web pages and e-mail only. Message text comes from agents,
 * which read untrusted pages, and Windows opens any registered scheme (search-ms:, ms-msdt:…) from one click.
 */
export function isWebLink(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}
