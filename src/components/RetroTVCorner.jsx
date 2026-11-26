import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RetroTVScene, LOGICAL_WIDTH, LOGICAL_HEIGHT } from '../canvas/RetroTVScene.js';
import {
  loadTvMediaSource,
  loadTvPlaylistItemSource,
  subscribeTvMediaSync,
} from '../state/mediaStore.js';

// Per-view local collapse override so clicking the coffee cup only affects THAT local view.
// Control View defaults to local coffee cup mode so Grandma stays compact on the operator screen.
const SMALL_SCREEN_QUERY = '(max-width: 700px), (max-height: 480px)';
const localMugOverridesByView = new Map([['control', false]]);

/**
 * Renders the Animated 4:3 Retro CRT TV & Grandma HTML5 Canvas Scene.
 * Custom uploaded videos (MP4/WebM) and animated GIFs/WebP render in a real visible
 * DOM underlay positioned precisely behind the canvas's transparent 4:3 CRT glass cutout
 * so videos stream natively via HTTP 206 byte-ranges and GIFs animate at full speed on
 * every device (including plain HTTP LAN phones, tablets, Safari, and Fire TV) without
 * requiring HTTPS/WebCodecs, while CRT scanlines, glare, bezel, and Grandma speech
 * bubbles stay cleanly layered on top.
 */
export default function RetroTVCorner({
  grandmaConfig,
  tvMuted = true,
  hasCustomTvMedia = undefined,
  tvMediaSyncKey = '',
  tvPlaylist = null,
  tvPlaylistIndex = 0,
  tvPlaylistMode = 'loop',
  tvPlaylistPaused = false,
  visible = true,
  scale = 1.0,
  opacity = 1.0,
  bubbleScale = 1.0,
  variant = 'corner',
  inStage = false,
  allowLocalToggle = true,
  mediaRefreshToken = 0,
}) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const videoRef = useRef(null);
  const objectUrlRef = useRef(null);
  const mediaSourceRef = useRef(null);

  const resolvedViewKey =
    inStage
      ? typeof window !== 'undefined' && window.location.pathname.startsWith('/spectator')
        ? 'spectator'
        : 'present'
      : 'control';

  const [mediaSource, setMediaSource] = useState(null); // { url, kind, name, updatedAt, isObjectUrl }
  const [domMediaReady, setDomMediaReady] = useState(false);
  const hasPlaylist = Array.isArray(tvPlaylist) && tvPlaylist.length > 0;
  const [localPlaylistIdx, setLocalPlaylistIdx] = useState(() => Math.max(0, Number(tvPlaylistIndex) || 0));

  // Sync local playback cursor whenever operator jumps or modifies playlist index
  useEffect(() => {
    if (!hasPlaylist) return;
    const len = tvPlaylist.length;
    const clamped = ((Number(tvPlaylistIndex) || 0) % len + len) % len;
    setLocalPlaylistIdx(clamped);
  }, [hasPlaylist, tvPlaylistIndex, tvPlaylist?.length]);

  const currentPlaylistItem = hasPlaylist
    ? tvPlaylist[localPlaylistIdx % tvPlaylist.length] || tvPlaylist[0]
    : null;

  const advancePlaylistItem = useCallback(() => {
    if (!hasPlaylist || tvPlaylist.length <= 1) return;
    if (tvPlaylistPaused || tvPlaylistMode === 'single') return;
    setLocalPlaylistIdx((prev) => {
      const len = tvPlaylist.length;
      if (len <= 1) return 0;
      if (tvPlaylistMode === 'shuffle') {
        let next = Math.floor(Math.random() * len);
        if (next === prev % len) next = (prev + 1) % len;
        return next;
      }
      return (prev + 1) % len;
    });
  }, [hasPlaylist, tvPlaylist, tvPlaylistMode, tvPlaylistPaused]);
  const [localVisibleOverride, setLocalVisibleOverride] = useState(() =>
    localMugOverridesByView.has(resolvedViewKey)
      ? localMugOverridesByView.get(resolvedViewKey)
      : null
  );

  // Sync local override when navigating between views
  useEffect(() => {
    setLocalVisibleOverride(
      localMugOverridesByView.has(resolvedViewKey)
        ? localMugOverridesByView.get(resolvedViewKey)
        : null
    );
  }, [resolvedViewKey]);

  // Auto-collapse to the local coffee cup on small screens (a manual local toggle still wins)
  const [isSmallScreen, setIsSmallScreen] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(SMALL_SCREEN_QUERY).matches
      : false
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(SMALL_SCREEN_QUERY);
    const onChange = (e) => setIsSmallScreen(e.matches);
    setIsSmallScreen(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const effectiveVisible =
    variant === 'corner'
      ? allowLocalToggle && localVisibleOverride !== null
        ? localVisibleOverride
        : isSmallScreen && resolvedViewKey !== 'present'
        ? false
        : Boolean(visible)
      : true;
  const collapsedToMug = variant === 'corner' && !effectiveVisible;
  const isLocallyOverridden =
    allowLocalToggle && variant === 'corner' && effectiveVisible !== Boolean(visible);

  const applyMediaSource = useCallback((nextSource) => {
    const prev = mediaSourceRef.current;
    if (
      prev &&
      nextSource &&
      prev.url === nextSource.url &&
      prev.kind === nextSource.kind &&
      prev.updatedAt === nextSource.updatedAt
    ) {
      return;
    }

    if (objectUrlRef.current && objectUrlRef.current !== nextSource?.url) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    if (!nextSource || !nextSource.url) {
      mediaSourceRef.current = null;
      setDomMediaReady(false);
      setMediaSource(null);
      sceneRef.current?.setDomMediaActive(false);
      return;
    }

    if (nextSource.isObjectUrl) {
      objectUrlRef.current = nextSource.url;
    }

    mediaSourceRef.current = nextSource;
    setDomMediaReady(false);
    sceneRef.current?.setDomMediaActive(false);
    setMediaSource(nextSource);
  }, []);

  // Keep canvas CRT cutout synchronized with DOM media readiness & collapsed state
  useEffect(() => {
    const active = Boolean(mediaSource && domMediaReady && !collapsedToMug);
    sceneRef.current?.setDomMediaActive(active);
  }, [mediaSource, domMediaReady, collapsedToMug]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const scene = new RetroTVScene(canvas, {
      stayDurationSec: grandmaConfig?.stayDurationSec,
      bubbleScale,
      activeSpeech: grandmaConfig?.activeSpeech || null,
      collapsedToMug,
      isLocallyOverridden,
    });
    sceneRef.current = scene;
    scene.start();

    let active = true;
    if (hasCustomTvMedia !== false) {
      loadTvMediaSource({ preferRemote: true }).then((source) => {
        if (active && source) {
          applyMediaSource(source);
        }
      });
    }

    const unsubscribe = subscribeTvMediaSync((msg) => {
      if (!active) return;
      if (msg.action === 'clear') {
        applyMediaSource(null);
      } else if (msg.action === 'set') {
        if (msg.source?.url) {
          applyMediaSource(msg.source);
        } else if (msg.record?.blob) {
          applyMediaSource({
            hasMedia: true,
            url: URL.createObjectURL(msg.record.blob),
            name: msg.record.name || 'tv-media',
            type: msg.record.type || msg.record.blob.type || 'application/octet-stream',
            kind: msg.record.kind || 'image',
            updatedAt: msg.record.updatedAt || Date.now(),
            isObjectUrl: true,
          });
        } else {
          loadTvMediaSource({ preferRemote: true }).then((source) => {
            if (active) applyMediaSource(source);
          });
        }
      }
    });

    return () => {
      active = false;
      unsubscribe();
      scene.stop();
      sceneRef.current = null;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [applyMediaSource]);

  // Playlist loader: load active playlist item whenever it changes
  useEffect(() => {
    if (!hasPlaylist || !currentPlaylistItem) return undefined;
    let active = true;
    if (currentPlaylistItem.kind === 'sitcom') {
      applyMediaSource(null);
      return undefined;
    }
    loadTvPlaylistItemSource(currentPlaylistItem).then((source) => {
      if (active) {
        applyMediaSource(source);
      }
    });
    return () => {
      active = false;
    };
  }, [
    hasPlaylist,
    currentPlaylistItem?.id,
    currentPlaylistItem?.kind,
    currentPlaylistItem?.url,
    currentPlaylistItem?.updatedAt,
    mediaRefreshToken,
    applyMediaSource,
  ]);

  // Playlist timer for non-video items (sitcom, images, GIFs, image URLs)
  useEffect(() => {
    if (!hasPlaylist || !currentPlaylistItem) return undefined;
    if (tvPlaylist.length <= 1 || tvPlaylistPaused || tvPlaylistMode === 'single') return undefined;
    if (collapsedToMug) return undefined;
    const isVideoItem =
      currentPlaylistItem.kind === 'video' ||
      (currentPlaylistItem.kind === 'url' && mediaSource?.kind === 'video');
    if (isVideoItem) return undefined;
    const durationMs = Math.max(3, Number(currentPlaylistItem.durationSec) || 12) * 1000;
    const timer = setTimeout(() => {
      advancePlaylistItem();
    }, durationMs);
    return () => clearTimeout(timer);
  }, [
    hasPlaylist,
    tvPlaylist?.length,
    currentPlaylistItem?.id,
    currentPlaylistItem?.kind,
    currentPlaylistItem?.durationSec,
    mediaSource?.kind,
    tvPlaylistMode,
    tvPlaylistPaused,
    collapsedToMug,
    advancePlaylistItem,
  ]);

  // Re-sync legacy CRT TV media when playlist is not in use
  useEffect(() => {
    if (hasPlaylist) return undefined;
    if (!tvMediaSyncKey) return undefined;
    if (hasCustomTvMedia === false) {
      applyMediaSource(null);
      return undefined;
    }
    let active = true;
    loadTvMediaSource({ preferRemote: true }).then((source) => {
      if (active) {
        applyMediaSource(source);
      }
    });
    return () => {
      active = false;
    };
  }, [hasPlaylist, tvMediaSyncKey, hasCustomTvMedia, applyMediaSource]);

  useEffect(() => {
    if (hasPlaylist) return;
    if (mediaRefreshToken === 0) return;
    let active = true;
    loadTvMediaSource({ preferRemote: true }).then((source) => {
      if (active) applyMediaSource(source);
    });
    return () => {
      active = false;
    };
  }, [hasPlaylist, mediaRefreshToken, applyMediaSource]);

  useEffect(() => {
    if (!sceneRef.current || !grandmaConfig) return;
    sceneRef.current.setConfig({
      stayDurationSec: grandmaConfig.stayDurationSec,
      bubbleScale,
      activeSpeech: grandmaConfig.activeSpeech || null,
      collapsedToMug,
      isLocallyOverridden,
    });
  }, [grandmaConfig, bubbleScale, collapsedToMug, isLocallyOverridden]);

  // Ensure remote & local `<video>` autoplay reliably (muted fallback if browser blocks unmuted autoplay)
  const ensureVideoPlaying = useCallback(
    (videoEl) => {
      if (!videoEl || collapsedToMug) return;
      videoEl.defaultMuted = true;
      videoEl.muted = Boolean(tvMuted);
      videoEl.playsInline = true;
      const playPromise = videoEl.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          videoEl.muted = true;
          videoEl.play().catch(() => {});
        });
      }
    },
    [tvMuted, collapsedToMug]
  );

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || mediaSource?.kind !== 'video') return;
    if (collapsedToMug) {
      videoEl.muted = true;
      videoEl.pause();
      return;
    }
    ensureVideoPlaying(videoEl);
  }, [tvMuted, mediaSource, collapsedToMug, ensureVideoPlaying]);

  const safeScale = Math.max(0.4, Math.min(1.5, Number(scale) || 1.0));
  const safeOpacity = Math.max(0.15, Math.min(1.0, Number(opacity) || 1.0));
  const scaledWidthPx = Math.round(LOGICAL_WIDTH * safeScale);

  // When Grandma is hidden in corner mode, collapse to just the steaming coffee mug + speech bubbles
  const wrapperClass =
    variant === 'stage'
      ? 'retro-tv-stage-wrapper'
      : `retro-tv-corner-wrapper ${inStage ? 'is-in-stage' : ''} ${
          collapsedToMug ? 'is-collapsed-mug' : ''
        }`;

  const wrapperStyle = { opacity: safeOpacity };

  const handleToggleLocalCoffeeMug = () => {
    const next = !effectiveVisible;
    localMugOverridesByView.set(resolvedViewKey, next);
    setLocalVisibleOverride(next);
  };

  return (
    <div className={wrapperClass} style={wrapperStyle}>
      <div className="retro-tv-canvas-frame">
        {/* Real visible DOM media underlay positioned directly behind the 4:3 CRT glass cutout */}
        {mediaSource && !collapsedToMug && (
          <div className="retro-tv-screen-underlay" aria-hidden="true">
            {mediaSource.kind === 'video' ? (
              <video
                key={mediaSource.url}
                ref={videoRef}
                src={mediaSource.url}
                className="retro-tv-media-el"
                autoPlay
                muted
                loop={!hasPlaylist || tvPlaylist.length <= 1 || tvPlaylistMode === 'single' || tvPlaylistPaused}
                playsInline
                preload="auto"
                onEnded={() => {
                  if (hasPlaylist && tvPlaylist.length > 1 && tvPlaylistMode !== 'single' && !tvPlaylistPaused) {
                    advancePlaylistItem();
                  }
                }}
                onLoadedData={(e) => {
                  setDomMediaReady(true);
                  ensureVideoPlaying(e.currentTarget);
                }}
                onCanPlay={(e) => {
                  setDomMediaReady(true);
                  ensureVideoPlaying(e.currentTarget);
                }}
                onError={() => setDomMediaReady(false)}
              />
            ) : (
              <img
                key={mediaSource.url}
                src={mediaSource.url}
                alt=""
                className="retro-tv-media-el"
                decoding="async"
                onLoad={() => setDomMediaReady(true)}
                onError={() => setDomMediaReady(false)}
              />
            )}
          </div>
        )}

        <canvas
          ref={canvasRef}
          className="retro-tv-canvas"
          aria-hidden="true"
          style={{
            width: variant === 'stage' ? '100%' : `${scaledWidthPx}px`,
            maxWidth: variant === 'stage' ? '780px' : inStage ? '960px' : '92vw',
            aspectRatio: `${LOGICAL_WIDTH} / ${LOGICAL_HEIGHT}`,
          }}
        />
        {variant === 'corner' && allowLocalToggle && (
          <button
            type="button"
            className={`retro-tv-mug-hitbox ${collapsedToMug ? 'is-collapsed' : 'is-expanded'}`}
            onClick={handleToggleLocalCoffeeMug}
            title={
              collapsedToMug
                ? `Click coffee cup to expand Grandma Corner (this view only${
                    isLocallyOverridden ? ' — local override active' : ''
                  })`
                : `Click coffee cup to collapse Grandma to coffee cup (this view only${
                    isLocallyOverridden ? ' — local override active' : ''
                  })`
            }
            aria-label={
              collapsedToMug
                ? 'Expand Grandma Corner in this view'
                : 'Collapse Grandma Corner to coffee cup in this view'
            }
            aria-pressed={collapsedToMug}
          />
        )}
      </div>
    </div>
  );
}
