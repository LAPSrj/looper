import { useEffect } from 'react';
import { platform } from '../platform';
import { AndroidFrame } from './AndroidFrame';
import { useShellController } from './controller';
import { DesktopFrame } from './DesktopFrame';
import { IosFrame } from './IosFrame';
import type { Session } from './session';

/**
 * A browser tab's Looper: the controller holds the behavior every platform
 * shares; the frame only draws it, as each platform's users expect.
 */
export function Shell({ session }: { session: Session }) {
  const controller = useShellController(session);
  useEffect(() => controller.start(), [controller]);
  if (platform === 'ios') return <IosFrame controller={controller} />;
  if (platform === 'android') return <AndroidFrame controller={controller} />;
  return <DesktopFrame controller={controller} />;
}
