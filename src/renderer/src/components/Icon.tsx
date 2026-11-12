import { ICON_STROKE, ICON_STROKE_BOLD } from './icons';

/** A line icon, 16 px unless `size` says otherwise; `children` are its SVG paths in a 16 x 16 box. `bold`: a small icon's heavier stroke. */
export function Icon({ children, size = 16, className, bold }: { children: React.ReactNode; size?: number; className?: string; bold?: boolean }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={bold ? ICON_STROKE_BOLD : ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
