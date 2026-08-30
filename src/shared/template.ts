/**
 * Replace {{key}} placeholders. Strings are inserted as-is, anything else is
 * pretty-printed JSON. Unknown keys become empty strings.
 */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  });
}

export function hasPlaceholder(tpl: string, ...keys: string[]): boolean {
  return keys.some((k) => new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`).test(tpl));
}
