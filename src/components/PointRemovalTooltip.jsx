import React, { useCallback, useEffect, useRef, useState } from 'react';

export const POINT_REMOVAL_DELAY_MS = 3000;

/**
 * Manages a 3-second cancellable countdown before subtracting a point.
 * Pressing `-1` a second time on the same side while the countdown is active
 * immediately skips the remaining timer and removes the point right away.
 */
export function usePendingPointRemoval({
  matchId,
  score1 = 0,
  score2 = 0,
  onCommit,
  onCancel,
}) {
  const [pendingRemoval, setPendingRemoval] = useState(null);
  const pendingRef = useRef(null);
  const timerRef = useRef(null);
  const onCommitRef = useRef(onCommit);
  const onCancelRef = useRef(onCancel);

  onCommitRef.current = onCommit;
  onCancelRef.current = onCancel;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const commitEntry = useCallback(
    (entry) => {
      if (!entry) return;
      clearTimer();
      pendingRef.current = null;
      setPendingRemoval(null);
      onCommitRef.current?.(entry.slot, entry.count, entry.playerName);
    },
    [clearTimer]
  );

  const cancelPendingRemoval = useCallback(
    (silent = false) => {
      const current = pendingRef.current;
      clearTimer();
      pendingRef.current = null;
      setPendingRemoval(null);
      if (current && !silent) {
        onCancelRef.current?.(current);
      }
    },
    [clearTimer]
  );

  // Cancel any pending removal if the active match changes or unmounts
  useEffect(() => {
    cancelPendingRemoval(true);
  }, [matchId, cancelPendingRemoval]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const requestRemovePoint = useCallback(
    (slot, playerName) => {
      const sideScore = slot === 1 ? Number(score1) || 0 : Number(score2) || 0;
      if (!matchId || sideScore <= 0) return;

      const existing = pendingRef.current;

      if (existing && existing.matchId === matchId) {
        if (existing.slot === slot) {
          // 2nd press on the same side: skip remaining timer and remove the point immediately
          commitEntry(existing);
          return;
        }
        // Moving to remove a point on the other side: commit the first side cleanly
        commitEntry(existing);
      }

      clearTimer();
      const now = Date.now();
      const entry = {
        id: now,
        matchId,
        slot,
        playerName: playerName || `Player ${slot}`,
        count: 1,
        durationMs: POINT_REMOVAL_DELAY_MS,
        expiresAt: now + POINT_REMOVAL_DELAY_MS,
      };
      pendingRef.current = entry;
      setPendingRemoval(entry);

      timerRef.current = setTimeout(() => {
        if (pendingRef.current?.id === entry.id) {
          commitEntry(entry);
        }
      }, POINT_REMOVAL_DELAY_MS);
    },
    [matchId, score1, score2, clearTimer, commitEntry]
  );

  return {
    pendingRemoval,
    requestRemovePoint,
    cancelPendingRemoval,
  };
}

/**
 * Floating 3-second countdown tooltip anchored directly above the `-1` button,
 * showing the live timer and a Cancel button to abort point removal.
 */
export default function PointRemovalTooltip({ pending, onCancel, className = '' }) {
  const [remainingMs, setRemainingMs] = useState(0);

  useEffect(() => {
    if (!pending) {
      setRemainingMs(0);
      return undefined;
    }

    let rafId = null;
    const tick = () => {
      const left = Math.max(0, pending.expiresAt - Date.now());
      setRemainingMs(left);
      if (left > 0) {
        rafId = requestAnimationFrame(tick);
      }
    };
    tick();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [pending]);

  if (!pending) return null;

  const durationMs = Math.max(1, pending.durationMs || POINT_REMOVAL_DELAY_MS);
  const progressPct = Math.max(0, Math.min(100, (remainingMs / durationMs) * 100));
  const secondsLabel = (remainingMs / 1000).toFixed(1);

  return (
    <div
      className={`point-remove-tooltip ${className}`.trim()}
      role="alert"
      aria-live="assertive"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="prt-body">
        <div className="prt-info">
          <div className="prt-title-row">
            <span className="prt-dot" aria-hidden="true" />
            <strong className="prt-title">
              Removing −{pending.count} {pending.count === 1 ? 'pt' : 'pts'}
            </strong>
            <span className="prt-timer">{secondsLabel}s</span>
          </div>
          <span className="prt-player">{pending.playerName} · Tap −1 again for now</span>
        </div>
        <button
          type="button"
          className="btn-prt-cancel"
          onClick={(e) => {
            e.stopPropagation();
            onCancel?.();
          }}
        >
          ✕ Cancel
        </button>
      </div>
      <div className="prt-progress-track" aria-hidden="true">
        <div className="prt-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>
      <span className="prt-arrow" aria-hidden="true" />
    </div>
  );
}
