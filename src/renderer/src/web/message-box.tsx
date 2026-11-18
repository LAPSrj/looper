import { useState, type ComponentType } from 'react';
import type { MessageBoxSpec } from '../../../shared/remote-access';
import type { HostBrowser, LocalMessage } from './file-flows';

/** A frame's message box: the computer's (showMessageBox) or the shell's own, with a text field for a name when it asks for one. */
export interface MessageBoxProps {
  spec: MessageBoxSpec;
  onAnswer: (response: number, checkboxChecked: boolean) => void;
  input?: { value: string; onChange: (v: string) => void };
}

/** A message box's check box, and its answer with the box's state. */
export function useMessageAnswer(spec: MessageBoxSpec, onAnswer: MessageBoxProps['onAnswer']) {
  const [checked, setChecked] = useState(!!spec.checkboxChecked);
  return { checked, setChecked, answer: (response: number) => onAnswer(response, checked) };
}

/** A message the shell asks itself (an error, Replace?), drawn by the frame's message box. */
export function LocalMessageBox({ msg, box: Box }: { msg: LocalMessage | null; box: ComponentType<MessageBoxProps> }) {
  return msg ? <Box spec={msg.spec} onAnswer={(r) => msg.onAnswer(r)} /> : null;
}

/** New Folder: the frame's message box with a name field; Create (button 1) makes the folder, and the box stays up when that fails. */
export function NewFolderBox({ browser, spec, box: Box, onDone }: { browser: HostBrowser; spec: MessageBoxSpec; box: ComponentType<MessageBoxProps>; onDone: () => void }) {
  const [name, setName] = useState('New folder');
  return (
    <Box
      spec={spec}
      input={{ value: name, onChange: setName }}
      onAnswer={(r) => {
        if (r === 1) void browser.makeDir(name).then((made) => made && onDone());
        else onDone();
      }}
    />
  );
}
