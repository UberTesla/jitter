import React, { useEffect, useRef, useState } from 'react';

const DEFAULT_AUTO_DISMISS_MS = 5000;

/**
 * Non-blocking, auto-dismissing Debounce Override floating banner.
 * Appears cleanly without blocking taps, clicks, or other controls on the page,
 * letting an operator or scorekeeper override the debounce guard with one tap
 * or simply ignore it as it auto-dismisses.
 */
export default function DebounceOverrideDialog({
  request,
  onConfirm,
  onCancel,
  autoDismissMs = DEFAULT_AUTO_DISMISS_MS,
}) {
  const [remainingMs, setRemainingMs] = useState(autoDismissMs);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Auto-dismiss countdown timer (resets cleanly on each new blocked tap)
  useEffect(() => {
    if (!request) return undefined;
    const expiresAt = Date.now() + autoDismissMs;
    setRemainingMs(autoDismissMs);

    const interval = setInterval(() => {
      const left = Math.max(0, expiresAt - Date.now());
      setRemainingMs(left);
      if (left <= 0) {
        clearInterval(interval);
        onCancelRef.current?.();
      }
    }, 50);

    return () => clearInterval(interval);
  }, [request, autoDismissMs]);

  if (!request) return null;

  const pct = Math.max(0, Math.min(100, (remainingMs / autoDismissMs) * 100));
  const secLeft = Math.ceil(remainingMs / 1000);

  return (
    <div
      className="debounce-override-banner"
      role="status"
      aria-live="assertive"
      aria-atomic="true"
    >
      <div className="debounce-banner-content">
        <div className="debounce-banner-text">
          <div className="debounce-banner-kicker">
            <span>⏱ POINT RECENTLY RECORDED</span>
            <span className="debounce-banner-timer">Auto-dismiss {secLeft}s</span>
          </div>
          <p className="debounce-override-msg">
            A point was recently recorded ({request.remainingSec}s left). Add{' '}
            <strong>+1 point</strong> for <strong>{request.playerName}</strong> anyway?
          </p>
        </div>

        <div className="debounce-banner-actions">
          <button
            type="button"
            className="btn-amber btn-sm"
            onClick={() => onConfirm?.(request.slot)}
          >
            ✓ Add +1 Anyway
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => onCancel?.()}
            aria-label="Dismiss debounce prompt"
          >
            Dismiss
          </button>
        </div>
      </div>

      <div className="debounce-progress-track" aria-hidden="true">
        <div className="debounce-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
