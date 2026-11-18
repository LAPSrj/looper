import { useRef, type ReactNode } from 'react';
import { Scrim } from './phone-shell';
import { slideCard, useDragToDismiss } from './sheet-drag';

/** Android's modal bottom sheet with a drag handle; drag it down, tap the scrim or go back to close. Styled in android.css. */
export function BottomSheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  const drag = useDragToDismiss({ extent: () => card.current?.clientHeight ?? 400, onMove: (offset) => slideCard(card.current, offset), onDismiss: onClose });
  return (
    <div className="md-sheet-layer">
      <Scrim className="md-scrim" onTap={onClose} />
      <div ref={card} className="md-bottom-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <div className="md-handle-area" {...drag}>
          <div className="md-handle" />
        </div>
        {children}
      </div>
    </div>
  );
}
