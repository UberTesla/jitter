import { useCallback, useEffect, useRef, useState } from 'react';

function getFullscreenActive() {
  if (typeof document === 'undefined') return false;
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

/**
 * Shared fullscreen toggle + mouseover auto-reveal hook for Presentation,
 * Spectator, and Scorekeeper views.
 * - While fullscreen: hides the top menu bar cleanly until the pointer moves
 *   near the top edge (or hovers over the revealed bar).
 */
export function useFullscreenMenu({ enabled = true } = {}) {
  const [isFullscreen, setIsFullscreen] = useState(getFullscreenActive);
  const [isMenuRevealed, setIsMenuRevealed] = useState(false);
  const isHoveringBarRef = useRef(false);
  const hideTimerRef = useRef(null);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onFsChange = () => {
      const active = getFullscreenActive();
      setIsFullscreen(active);
      if (!active) {
        setIsMenuRevealed(false);
        isHoveringBarRef.current = false;
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !isFullscreen || typeof window === 'undefined') return undefined;

    const scheduleHide = () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        if (!isHoveringBarRef.current) {
          setIsMenuRevealed(false);
        }
      }, 850);
    };

    const onMouseMove = (e) => {
      if (e.clientY <= 52) {
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
        setIsMenuRevealed(true);
      } else if (!isHoveringBarRef.current && e.clientY > 92) {
        scheduleHide();
      }
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [enabled, isFullscreen]);

  const toggleFullscreen = useCallback(async () => {
    if (typeof document === 'undefined') return;
    try {
      if (getFullscreenActive()) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      } else {
        const el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      }
    } catch {
      // Ignore fullscreen permission rejections gracefully
    }
  }, []);

  const barHoverHandlers = {
    onMouseEnter: () => {
      isHoveringBarRef.current = true;
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      if (isFullscreen) setIsMenuRevealed(true);
    },
    onMouseLeave: () => {
      isHoveringBarRef.current = false;
      if (isFullscreen) {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
          if (!isHoveringBarRef.current) setIsMenuRevealed(false);
        }, 650);
      }
    },
  };

  return {
    isFullscreen,
    isMenuRevealed,
    toggleFullscreen,
    barHoverHandlers,
  };
}
