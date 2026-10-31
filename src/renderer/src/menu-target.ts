// No DOM types: the unit tests (node tsconfig) load this file.

/**
 * The task a context menu is open for. The task context menu's items tell the
 * window what to do without naming a task (`ui:event` with only a type), so the
 * window acts on its selected one. A long press on a row of a list must not
 * select it (on a phone a selection opens the task's screen), so the press sets
 * the target and the next command takes it: it acts on that task, once. A
 * target the menu never used (dismissed) is dropped by `clear` when the page is
 * used again.
 */
export class MenuTarget {
  private id: string | null = null;

  /** A long press on a task's row: its menu is about to open. */
  set(taskId: string | null): void {
    this.id = taskId;
  }

  /** The popup is gone without a command (the page was touched, the screen changed). */
  clear(): void {
    this.id = null;
  }

  get current(): string | null {
    return this.id;
  }

  /** The command that arrived: the target if one is set (used up now), else the selection. */
  take<T>(selected: T): string | T {
    const id = this.id;
    this.id = null;
    return id ?? selected;
  }
}
