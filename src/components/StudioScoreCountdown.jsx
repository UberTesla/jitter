import React, { useEffect, useState } from 'react';
import { tournamentStore } from '../state/tournamentStore.js';

/**
 * 3-Second Cancellable Countdown Popup for Studio Mode Score Updates
 * Scores always update live even while in OBS Studio Mode — this popup gives
 * the operator 3 seconds to Cancel & revert (or Send Now) before the score
 * pushes to Presentation View without leaking staged slide/banner edits.
 */
export default function StudioScoreCountdown({ pendingScorePush }) {
  const [remainingMs, setRemainingMs] = useState(0);

  useEffect(() => {
    if (!pendingScorePush) {
      setRemainingMs(0);
      return undefined;
    }

    let rafId = null;
    const tick = () => {
      const left = Math.max(0, pendingScorePush.expiresAt - Date.now());
      setRemainingMs(left);
      if (left > 0) {
        rafId = requestAnimationFrame(tick);
      }
    };
    tick();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [pendingScorePush]);

  if (!pendingScorePush) return null;

  const durationMs = Math.max(1, pendingScorePush.durationMs || 3000);
  const progressPct = Math.max(0, Math.min(100, (remainingMs / durationMs) * 100));
  const secondsLabel = (remainingMs / 1000).toFixed(1);

  return (
    <div className="studio-score-popup" role="alert" aria-live="assertive">
      <div className="ssp-content">
        <div className="ssp-text">
          <div className="ssp-kicker">
            <span className="ssp-dot" aria-hidden="true" />
            STUDIO MODE · PUBLISHING SCORE LIVE IN {secondsLabel}s
          </div>
          <div className="ssp-summary">
            <strong>{pendingScorePush.summary}</strong>
            <span> — staged slides remain hidden</span>
          </div>
        </div>

        <div className="ssp-actions">
          <button
            type="button"
            className="btn-ssp-cancel"
            onClick={() => tournamentStore.cancelPendingScorePush()}
          >
            ✕ Cancel
          </button>
          <button
            type="button"
            className="btn-ssp-now"
            onClick={() => tournamentStore.flushPendingScorePush()}
          >
            ▶ Send Now
          </button>
        </div>
      </div>

      <div className="ssp-progress-track" aria-hidden="true">
        <div className="ssp-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>
    </div>
  );
}
