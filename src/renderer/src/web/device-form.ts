import { useState } from 'react';
import type { ShellController } from './controller';
import { useThisDevice, type ThisDevice } from './device-flows';
import { PUSH_HINTS } from './push-client';

export interface DeviceForm extends ThisDevice {
  /** Notifications can be switched here: the browser offers them and they aren't blocked. */
  usable: boolean;
  /** Why they can't, when they can't. */
  hint: string | undefined;
  /** The Name field: what's typed, else the device's name. */
  nameText: string;
  setNameText: (text: string) => void;
  /** The typed name when it renames the device (not empty, not the same), else null. */
  newName: () => string | null;
  /** The field shows the device's name again. */
  resetName: () => void;
}

/** This Device's form, whichever frame draws it: its name being edited and its Notifications switch. */
export function useDeviceForm(controller: ShellController): DeviceForm {
  const d = useThisDevice(controller);
  const [draft, setDraft] = useState<string | null>(null);
  const nameText = draft ?? d.name;
  return {
    ...d,
    usable: d.push === 'on' || d.push === 'off',
    hint: d.push ? PUSH_HINTS[d.push] : undefined,
    nameText,
    setNameText: setDraft,
    newName: () => {
      const next = nameText.trim();
      return draft !== null && next && next !== d.name ? next : null;
    },
    resetName: () => setDraft(null),
  };
}
