/** The code in a pairing link (`<url>/pair#<code>`, what the QR code holds), or null when the text isn't one. */
export function codeFromQr(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.pathname !== '/pair') return null;
  let raw: string;
  try {
    raw = decodeURIComponent(url.hash.slice(1));
  } catch {
    return null;
  }
  const code = raw.toUpperCase().replace(/[\s-]+/g, '');
  return /^[A-Z0-9]+$/.test(code) ? code : null;
}
