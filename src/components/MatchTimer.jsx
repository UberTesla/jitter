import React, { useEffect, useState } from 'react';
import { computeMatchElapsedMs, formatMatchTimer } from '../engine/scoringEngine.js';
import { tournamentStore } from '../state/tournamentStore.js';

/**
 * Live Count-Up Match Timer Pill.
 * - Shows `00:00` before the match begins.
 * - Counts up cleanly (`MM:SS` / `H:MM:SS`) once started, anchored to server-synced clock.
 * - Stops visually as soon as a winner is reached (while `startedAt` keeps running in the
 *   background so subtracting a mistaken winning point seamlessly resumes true elapsed time).
 * - Freezes at the final match duration once completed.
 */
export default function MatchTimer({ match, inline = false, className = '' }) {
  const isWinnerStopped = Boolean(match && !match.completed && match.winnerReachedAt);
  const isPaused = Boolean(match && match.paused && !match.completed);
  const isRunning = Boolean(
    match && match.started && match.startedAt && !match.completed && !isWinnerStopped && !isPaused
  );
  const isCompleted = Boolean(match && (match.completed || isWinnerStopped));
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isRunning) return undefined;
    const id = setInterval(() => {
      setTick((n) => (n + 1) % 1000000);
    }, 250);
    return () => clearInterval(id);
  }, [isRunning, match?.id, match?.startedAt, match?.winnerReachedAt, match?.paused]);

  const elapsedMs = computeMatchElapsedMs(match, tournamentStore.getServerNow());
  const formatted = formatMatchTimer(elapsedMs);
  const stateClass = isRunning ? 'is-running' : isCompleted ? 'is-completed' : 'is-idle';

  const titleText = isRunning
    ? 'Live match elapsed time'
    : isPaused
    ? 'Match paused — timer frozen until resumed'
    : isWinnerStopped
    ? 'Timer stopped at winning point (keeps tracking in background if a point is removed)'
    : isCompleted
    ? 'Final match duration'
    : 'Match timer starts when Begin Match is pressed';

  if (inline) {
    return (
      <span
        className={`match-timer-inline ${stateClass} ${className}`.trim()}
        aria-label={`Match timer ${formatted}`}
        title={titleText}
      >
        <span className="match-timer-sep" aria-hidden="true">·</span>
        <span className="match-timer-digits">{formatted}</span>
      </span>
    );
  }

  return (
    <span
      className={`match-timer-pill ${stateClass} ${className}`.trim()}
      aria-label={`Match timer ${formatted}`}
      title={titleText}
    >
      <span className="match-timer-dot" aria-hidden="true" />
      <span className="match-timer-digits">{formatted}</span>
    </span>
  );
}
