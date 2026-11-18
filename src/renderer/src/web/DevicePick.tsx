import { useRef } from 'react';
import type { FileFilterSpec } from '../../../shared/remote-access';
import { acceptAttr } from './dialog-flows';
import type { FileDialogFlow } from './file-flows';

/** Open from This Device: the button that opens the system's file picker, and what's going on with the files picked (uploading). */
export function DevicePick({
  f,
  filters,
  label,
  className,
  buttonClass,
  busyClass,
  autoFocus,
}: {
  f: FileDialogFlow;
  filters: FileFilterSpec[] | undefined;
  /** The button's text, by the number of files it picks: [one, many]. */
  label: [string, string];
  className: string;
  buttonClass: string;
  busyClass: string;
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={className}>
      <button className={buttonClass} autoFocus={autoFocus} disabled={!!f.busy} onClick={() => input.current?.click()}>
        {f.multi ? label[1] : label[0]}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        multiple={f.multi}
        accept={acceptAttr(filters)}
        onChange={(e) => {
          f.fromDevice([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {f.busy && <div className={busyClass}>{f.busy}</div>}
    </div>
  );
}
