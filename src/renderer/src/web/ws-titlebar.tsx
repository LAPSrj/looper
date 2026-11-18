export function CloseButton({ onClick, className = 'ws-close' }: { onClick: (e: React.MouseEvent) => void; className?: string }) {
  return (
    <button className={className} aria-label="Close" onPointerDown={(e) => e.stopPropagation()} onClick={onClick}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.1" />
      </svg>
    </button>
  );
}

/** The desktop browser's title bar of a dialog the shell draws itself: its title, and Close when it can be closed. */
export function TitleBar({ title, onClose }: { title: string; onClose?: () => void }) {
  return (
    <div className="ws-titlebar">
      <span className="ws-title">{title}</span>
      {onClose && <CloseButton onClick={onClose} />}
    </div>
  );
}
