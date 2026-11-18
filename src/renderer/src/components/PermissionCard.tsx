import type { ChatPermissionRequest, ChatState } from '@shared/chat';
import { harnessKindLabel } from '@shared/environments';
import type { MessageRow } from '@shared/messages';
import { ToolInputView } from './ToolContent';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** What the agent asks to do, in words. */
function requestText(harnessName: string, p: Pick<ChatPermissionRequest, 'tool' | 'input'>): string {
  const input = (p.input ?? {}) as Record<string, unknown>;
  const file = str(input.file_path) ?? str(input.notebook_path);
  switch (p.tool) {
    case 'Bash':
    case 'PowerShell':
      return `${harnessName} wants to run a command.`;
    case 'Write':
      return `${harnessName} wants to write ${file ?? 'a file'}.`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${harnessName} wants to change ${file ?? 'a file'}.`;
    case 'WebFetch':
      return `${harnessName} wants to fetch ${str(input.url) ?? 'a web page'}.`;
    default:
      return `${harnessName} wants to use ${p.tool}.`;
  }
}

/**
 * A tool call waiting for the user: what it does, then Allow or Deny. A chat's
 * request, or a task run's (its terminal asks too, and whichever answers first wins).
 */
export function PermissionCard({
  harnessKind,
  p,
  answer,
}: {
  harnessKind: ChatState['harnessKind'];
  p: Pick<ChatPermissionRequest, 'id' | 'tool' | 'input'>;
  answer: (allow: boolean) => void;
}) {
  const row: MessageRow = {
    id: `permission-${p.id}`,
    kind: 'tool',
    tool: p.tool,
    input: p.input,
    text: JSON.stringify(p.input, null, 2),
    preview: '',
  };
  return (
    <div className="chat-card chat-permission">
      <div>{requestText(harnessKindLabel(harnessKind), p)}</div>
      <div className="chat-tool-body">
        <ToolInputView row={row} />
      </div>
      <PermissionButtons answer={answer} />
    </div>
  );
}

/** Allow and Deny on a permission request: in the conversation, and on its dashboard card. */
export function PermissionButtons({ answer }: { answer: (allow: boolean) => void }) {
  return (
    <div className="chat-permission-actions">
      <button className="btn primary" onClick={() => answer(true)}>
        Allow
      </button>
      <button className="btn" onClick={() => answer(false)}>
        Deny
      </button>
    </div>
  );
}
