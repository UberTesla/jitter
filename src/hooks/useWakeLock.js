import { useEffect, useRef, useState } from 'react';

/**
 * Multi-layer Screen Keep-Alive hook to prevent laptops, tablets, phones, and
 * dedicated Presenter TVs from sleeping or dimming during live tournaments:
 *
 *  1. Primary: Native Screen Wake Lock API (`navigator.wakeLock.request('screen')`)
 *     on secure contexts (HTTPS / localhost), with automatic re-acquisition on
 *     `visibilitychange`, `focus`, `fullscreenchange`, and unexpected OS release.
 *  2. Fallback: Silent 1x1 looping `<video>` backed by `canvas.captureStream(1)`
 *     for plain HTTP LAN URLs (e.g. `http://192.168.x.x:5173`) and browsers
 *     without Wake Lock support — auto-arms on first user tap/click if needed.
 *  3. Network Heartbeat: Optional periodic callback (default 25s) to keep LAN
 *     Wi-Fi / SSE presence fresh while the screen is displayed.
 */
export function useWakeLock({
  enabled = true,
  heartbeatIntervalMs = 25000,
  onHeartbeat = null,
} = {}) {
  const [status, setStatus] = useState(() => ({
    active: false,
    mode: enabled ? 'armed' : 'inactive', // 'wake-lock' | 'video-fallback' | 'armed' | 'inactive'
    supported: typeof navigator !== 'undefined' && Boolean(navigator.wakeLock?.request),
  }));

  const heartbeatRef = useRef(onHeartbeat);
  heartbeatRef.current = onHeartbeat;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;

    const nativeSupported = Boolean(navigator.wakeLock?.request);

    if (!enabled) {
      setStatus({ active: false, mode: 'inactive', supported: nativeSupported });
      return undefined;
    }

    let disposed = false;
    let sentinel = null;
    let fallbackVideo = null;
    let fallbackStream = null;
    let fallbackDrawTimer = null;
    let acquiring = false;

    const stopVideoFallback = () => {
      if (fallbackDrawTimer) {
        clearInterval(fallbackDrawTimer);
        fallbackDrawTimer = null;
      }
      if (fallbackStream) {
        try {
          for (const track of fallbackStream.getTracks()) track.stop();
        } catch {
          // Ignore track stop errors
        }
        fallbackStream = null;
      }
      if (fallbackVideo) {
        try {
          fallbackVideo.pause();
          fallbackVideo.srcObject = null;
          fallbackVideo.remove();
        } catch {
          // Ignore cleanup errors
        }
        fallbackVideo = null;
      }
    };

    const startVideoFallback = async () => {
      if (disposed || document.visibilityState !== 'visible') return false;
      if (fallbackVideo && !fallbackVideo.paused) {
        setStatus({ active: true, mode: 'video-fallback', supported: nativeSupported });
        return true;
      }

      try {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const ctx = canvas.getContext('2d');
        if (!ctx || typeof canvas.captureStream !== 'function') {
          return false;
        }

        let tick = 0;
        const paintFrame = () => {
          tick = (tick + 1) % 2;
          ctx.fillStyle = tick === 0 ? '#000000' : '#010101';
          ctx.fillRect(0, 0, 2, 2);
        };
        paintFrame();

        const stream = canvas.captureStream(1);
        const video = document.createElement('video');
        video.setAttribute('aria-hidden', 'true');
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.tabIndex = -1;
        video.srcObject = stream;
        video.style.cssText =
          'position:fixed;width:1px;height:1px;left:0;bottom:0;opacity:0.001;pointer-events:none;z-index:-1;';
        document.body.appendChild(video);

        await video.play();
        if (disposed) {
          video.pause();
          video.srcObject = null;
          video.remove();
          for (const track of stream.getTracks()) track.stop();
          return false;
        }

        fallbackVideo = video;
        fallbackStream = stream;
        fallbackDrawTimer = setInterval(paintFrame, 12000);
        setStatus({ active: true, mode: 'video-fallback', supported: nativeSupported });
        return true;
      } catch {
        stopVideoFallback();
        return false;
      }
    };

    const acquire = async () => {
      if (disposed || acquiring || document.visibilityState !== 'visible') return;
      if (sentinel && !sentinel.released) return;
      acquiring = true;

      try {
        if (nativeSupported) {
          try {
            const lock = await navigator.wakeLock.request('screen');
            if (disposed) {
              lock.release().catch(() => {});
              return;
            }
            sentinel = lock;
            stopVideoFallback();
            setStatus({ active: true, mode: 'wake-lock', supported: true });

            lock.addEventListener('release', () => {
              if (sentinel === lock) sentinel = null;
              if (!disposed && document.visibilityState === 'visible') {
                setTimeout(() => {
                  if (!disposed) acquire();
                }, 400);
              }
            });
            return;
          } catch {
            // Wake Lock rejected (e.g. non-HTTPS LAN IP or low-battery/policy) -> fall back to silent video
          }
        }

        const ok = await startVideoFallback();
        if (!ok && !disposed) {
          setStatus({ active: false, mode: 'armed', supported: nativeSupported });
        }
      } finally {
        acquiring = false;
      }
    };

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        acquire();
      }
    };

    const onUserGesture = () => {
      if ((!sentinel || sentinel.released) && (!fallbackVideo || fallbackVideo.paused)) {
        acquire();
      }
    };

    acquire();

    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    document.addEventListener('fullscreenchange', onVisibilityOrFocus);
    document.addEventListener('webkitfullscreenchange', onVisibilityOrFocus);
    window.addEventListener('focus', onVisibilityOrFocus);
    window.addEventListener('pointerdown', onUserGesture, { passive: true });
    window.addEventListener('touchstart', onUserGesture, { passive: true });
    window.addEventListener('keydown', onUserGesture, { passive: true });

    let hbTimer = null;
    if (heartbeatIntervalMs > 0) {
      hbTimer = setInterval(() => {
        if (!disposed && document.visibilityState === 'visible') {
          heartbeatRef.current?.();
          if ((!sentinel || sentinel.released) && (!fallbackVideo || fallbackVideo.paused)) {
            acquire();
          }
        }
      }, heartbeatIntervalMs);
    }

    return () => {
      disposed = true;
      if (hbTimer) clearInterval(hbTimer);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      document.removeEventListener('fullscreenchange', onVisibilityOrFocus);
      document.removeEventListener('webkitfullscreenchange', onVisibilityOrFocus);
      window.removeEventListener('focus', onVisibilityOrFocus);
      window.removeEventListener('pointerdown', onUserGesture);
      window.removeEventListener('touchstart', onUserGesture);
      window.removeEventListener('keydown', onUserGesture);
      if (sentinel) {
        sentinel.release().catch(() => {});
        sentinel = null;
      }
      stopVideoFallback();
    };
  }, [enabled, heartbeatIntervalMs]);

  return status;
}
