import { useEffect, useRef, useState } from 'react';
import { codeFromQr } from './pair-link';
import { createQrDecoder } from './pair-scan';

const SCAN_INTERVAL_MS = 200;

/** Full-screen camera view that reads a pairing QR code and hands over its code. */
export function QrScanner({ onCode, onClose, onError, buttonClass }: { onCode: (code: string) => void; onClose: () => void; onError: (message: string) => void; buttonClass: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hint, setHint] = useState('');
  // The effect must not restart when the parent re-renders with new callbacks.
  const callbacks = useRef({ onCode, onClose, onError });
  callbacks.current = { onCode, onClose, onError };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stream: MediaStream | undefined;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) return stop();
        const video = videoRef.current;
        if (!video) return stop();
        video.srcObject = stream;
        await video.play();
        const decode = await createQrDecoder();
        const tick = async () => {
          if (stopped) return;
          const text = await decode(video);
          if (stopped) return;
          if (text) {
            const code = codeFromQr(text);
            if (code) {
              stop();
              callbacks.current.onCode(code);
              return;
            }
            setHint("That QR code isn't a Looper pairing code.");
          }
          timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
        };
        void tick();
      } catch (e) {
        stop();
        const denied = (e as DOMException).name === 'NotAllowedError' || (e as DOMException).name === 'SecurityError';
        callbacks.current.onError(denied ? 'Camera access was denied.' : "Couldn't open the camera.");
      }
    })();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') callbacks.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      stop();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="qr-scan" role="dialog" aria-label="Scan QR Code">
      <video ref={videoRef} className="qr-scan-video" playsInline muted />
      <div className="qr-scan-hint">{hint || 'Point the camera at the QR code on the host computer.'}</div>
      <button type="button" className={buttonClass} onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
