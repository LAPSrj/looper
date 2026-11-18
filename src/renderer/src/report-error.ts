export const reportError = (e: unknown): void => void window.looper.showError(e instanceof Error ? e.message : String(e));
