import type { ClipboardBridge } from './clipboard';

/**
 * An Edit menu role (copy, cut, paste, selectAll, undo, redo) carried out in a
 * window's page, as Electron does it in the focused webContents. Called inside
 * the click, so the clipboard may be used. False for a role it doesn't know.
 */
export function runEditRole(role: string, frame: HTMLIFrameElement | null | undefined, clipboard: ClipboardBridge): boolean {
  const win = frame?.contentWindow;
  const doc = frame?.contentDocument;
  if (!win || !doc) return false;
  win.focus();
  const el = doc.activeElement as HTMLElement | null;
  // Tag names, not instanceof: the page's elements belong to its own frame.
  const field = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (el as HTMLInputElement) : null;
  const editable = (!!field && !field.readOnly && !field.disabled) || !!el?.isContentEditable;
  const selected = (): string =>
    field ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0) : (doc.getSelection()?.toString() ?? '');
  switch (role.toLowerCase()) {
    case 'undo':
    case 'redo':
      doc.execCommand(role.toLowerCase());
      return true;
    case 'selectall':
      if (field) field.select();
      else doc.execCommand('selectAll');
      return true;
    case 'copy':
    case 'cut': {
      const text = selected();
      if (!text) return true;
      clipboard.write(text);
      if (role === 'cut' && editable) doc.execCommand('delete');
      return true;
    }
    case 'paste':
      if (!editable) return true;
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          win.focus();
          if (text) doc.execCommand('insertText', false, text);
        })
        .catch(() => undefined);
      return true;
    default:
      return false;
  }
}
