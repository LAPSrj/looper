import { useEffect, useState } from 'react';
import { MCP_SCOPE_LABELS, serverProblem, type McpServer, type McpServerRequest, type McpTransport } from '@shared/agent-config';
import { envToLine, joinTokens, lineToEnv, tokenize } from '@shared/cmdline';
import { EmptyWindow, Field, FieldRow, FormGroup, SelectInput, TextArea, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';

const TRANSPORTS: Record<'claude-code' | 'codex', [McpTransport, string][]> = {
  'claude-code': [
    ['stdio', 'Command (stdio)'],
    ['http', 'HTTP'],
    ['sse', 'SSE'],
  ],
  codex: [
    ['stdio', 'Command (stdio)'],
    ['http', 'HTTP'],
  ],
};

/** "Name: value" lines as a header map, or the line that isn't one. */
function linesToHeaders(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const at = line.indexOf(':');
    if (at <= 0) return `"${line.trim()}" isn't a header (Name: value).`;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** Agent Settings → MCP Servers → Add/Edit: one server of the window's draft, confirmed back to it. */
export function McpServerApp({ requestKey }: { requestKey: string }) {
  const [request, setRequest] = useState<McpServerRequest | null | undefined>(undefined);
  const [draft, setDraft] = useState<McpServer | null>(null);
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [headersText, setHeadersText] = useState('');

  useEffect(() => {
    void window.looper.agentSettings.serverRequest(requestKey).then((r) => {
      setRequest(r);
      if (!r) return;
      document.title = r.isNew ? 'New MCP Server' : 'Edit MCP Server';
      setDraft(r.server);
      setArgsText(joinTokens(r.server.args));
      setEnvText(envToLine(r.server.env));
      setHeadersText(Object.entries(r.server.headers).map(([k, v]) => `${k}: ${v}`).join('\n'));
    });
  }, [requestKey]);

  if (!request || !draft) return <EmptyWindow gone={request === null && 'This server window is no longer needed.'} />;
  const patch = (p: Partial<McpServer>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const confirm = () => {
    const args = tokenize(argsText);
    if (!args.ok) return void window.looper.showError(`Arguments: ${args.error}`);
    const env = lineToEnv(envText);
    if (typeof env === 'string') return void window.looper.showError(`Environment variables: ${env}`);
    const headers = linesToHeaders(headersText);
    if (typeof headers === 'string') return void window.looper.showError(`Headers: ${headers}`);
    const server: McpServer = { ...draft, name: draft.name.trim(), command: draft.command.trim(), url: draft.url.trim(), args: args.tokens, env, headers };
    const problem = serverProblem(request.kind, server, request.taken[server.scope] ?? []);
    if (problem) return void window.looper.showError(problem);
    void window.looper.agentSettings.serverDone(requestKey, server).catch((e: Error) => void window.looper.showError(e.message));
  };

  const stdio = draft.transport === 'stdio';
  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <FieldRow>
              <Field label="Name">
                <TextInput autoFocus value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
              </Field>
              <Field label="Scope">
                <SelectInput value={draft.scope} onChange={(e) => patch({ scope: e.target.value as McpServer['scope'] })}>
                  {request.scopes.map((s) => (
                    <option key={s} value={s}>
                      {MCP_SCOPE_LABELS[request.kind][s]}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </FieldRow>
          </FormGroup>
          <FormGroup>
            <Field label="Type">
              <SelectInput value={draft.transport} onChange={(e) => patch({ transport: e.target.value as McpTransport })}>
                {TRANSPORTS[request.kind].map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </SelectInput>
            </Field>
            {stdio ? (
              <>
                <Field label="Command">
                  <TextInput code value={draft.command} onChange={(e) => patch({ command: e.target.value })} />
                </Field>
                <Field label="Arguments">
                  <TextInput code value={argsText} onChange={(e) => setArgsText(e.target.value)} />
                </Field>
                <Field label="Environment variables">
                  <TextInput code value={envText} onChange={(e) => setEnvText(e.target.value)} />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL">
                  <TextInput code inputMode="url" value={draft.url} placeholder="https://" onChange={(e) => patch({ url: e.target.value })} />
                </Field>
                <Field label="Headers">
                  <TextArea code rows={4} value={headersText} placeholder="Authorization: Bearer …" onChange={(e) => setHeadersText(e.target.value)} />
                </Field>
              </>
            )}
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: request.isNew ? 'Create' : 'Save', run: confirm }} />
    </div>
  );
}
