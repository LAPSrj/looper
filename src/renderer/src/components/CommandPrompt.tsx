import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommandPrompt } from '@shared/bash-mode';
import { subscribe } from '../events';
import { isPhone } from '../web/page-nav';
import { PhoneSheet } from './phone/PhoneSheet';
import { Field, TextInput } from './ui';

/**
 * What the "!" commands waiting in a message box ask the user (sudo's password), asked here because the
 * command was run here: the first one asking, with the command's id. A command that asked before this box
 * showed (another chat was open) is read from the engine; the rest arrive as events.
 */
export function useCommandPrompt(ownerId: string, commandIds: string[]): { commandId: string; prompt: CommandPrompt } | null {
  const [prompts, setPrompts] = useState<Record<string, CommandPrompt>>({});
  /** The commands an event has already told about: a read that comes after it is older. */
  const told = useRef(new Set<string>());
  const key = commandIds.join(',');
  useEffect(() => {
    let alive = true;
    for (const id of commandIds) {
      void window.looper.chat
        .commandPrompt(ownerId, id)
        .then((p) => {
          if (alive && p && !told.current.has(id)) setPrompts((s) => ({ ...s, [id]: p }));
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, key]);
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== 'chat:command-prompt' || e.chatId !== ownerId) return;
        told.current.add(e.id);
        setPrompts((s) => {
          const { [e.id]: _gone, ...rest } = s;
          return e.prompt ? { ...rest, [e.id]: e.prompt } : rest;
        });
      }),
    [ownerId],
  );
  const commandId = commandIds.find((id) => prompts[id]);
  return commandId ? { commandId, prompt: prompts[commandId] } : null;
}

/**
 * A command's prompt: a card above the message box on a desktop, a sheet on a phone. The answer goes to the
 * program that asked (the engine keeps it nowhere), and Cancel, Esc or closing the sheet is no answer.
 */
export function CommandPromptView({ ownerId, commandId, prompt }: { ownerId: string; commandId: string; prompt: CommandPrompt }) {
  const answer = (a: string | null) => window.looper.chat.answerCommand(ownerId, commandId, prompt.id, a);
  const form = <PromptForm key={prompt.id} prompt={prompt} answer={answer} />;
  if (!isPhone) return <div className="command-prompt-card">{form}</div>;
  // At the page's root: inside the message box a sheet would be cut to the box's own size.
  return createPortal(
    <PhoneSheet title={prompt.secret ? 'Password' : 'Command'} detent="medium" onClose={() => answer(null)}>
      {form}
    </PhoneSheet>,
    document.body,
  );
}

function PromptForm({ prompt, answer }: { prompt: CommandPrompt; answer: (a: string | null) => void }) {
  const [value, setValue] = useState('');
  const noun = prompt.secret ? 'password' : 'answer';
  return (
    <form
      className="command-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) answer(value);
      }}
      onKeyDown={(e) => {
        // Esc is Stop in the message box: here it only closes the prompt.
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        answer(null);
      }}
    >
      <div className="command-prompt-text">{prompt.text}</div>
      <Field label={prompt.secret ? 'Password' : 'Answer'} error={prompt.retry ? `The ${noun} is incorrect` : undefined}>
        <TextInput type={prompt.secret ? 'password' : 'text'} autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <div className="command-prompt-actions">
        <button className="btn primary" type="submit" disabled={!value}>
          OK
        </button>
        <button className="btn" type="button" onClick={() => answer(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
