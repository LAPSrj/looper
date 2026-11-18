import { ICON_STROKE, ICON_STROKE_BOLD, iconNode } from './icons';

/**
 * A line icon, 16 px unless `size` says otherwise: `children` are its SVG paths, or `name` an ICONS key or addon
 * drawing (nothing is drawn for an unknown name). The paths are in a 16 x 16 box unless `box` says otherwise.
 * `bold`: a small icon's heavier stroke; `stroke` sets another.
 */
export function Icon({
  children,
  name,
  size = 16,
  box = 16,
  stroke,
  className,
  bold,
}: {
  children?: React.ReactNode;
  name?: string;
  size?: number;
  box?: number;
  stroke?: number;
  className?: string;
  bold?: boolean;
}) {
  const paths = name === undefined ? children : iconNode(name);
  if (name !== undefined && !paths) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke ?? (bold ? ICON_STROKE_BOLD : ICON_STROKE)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}
