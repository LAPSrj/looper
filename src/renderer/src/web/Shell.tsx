import { lazy, Suspense, useEffect } from 'react';
import { platform } from '../platform';
import { useShellController } from './controller';
import type { Session } from './session';

// Each platform's frame, with its CSS, is a chunk of its own: a tab loads only its own.
const loadFrame = () =>
  platform === 'ios'
    ? import('./IosFrame').then((m) => ({ default: m.IosFrame }))
    : platform === 'android'
      ? import('./AndroidFrame').then((m) => ({ default: m.AndroidFrame }))
      : import('./DesktopFrame').then((m) => ({ default: m.DesktopFrame }));
const Frame = lazy(loadFrame);

/** Starts loading this platform's frame, so it arrives while the tab is still waiting on the computer's first answer. */
export function preloadFrame(): void {
  void loadFrame();
}

/**
 * A browser tab's Looper: the controller holds the behavior every platform
 * shares; the frame only draws it, as each platform's users expect.
 */
export function Shell({ session }: { session: Session }) {
  const controller = useShellController(session);
  useEffect(() => controller.start(), [controller]);
  return (
    <Suspense fallback={null}>
      <Frame controller={controller} />
    </Suspense>
  );
}
