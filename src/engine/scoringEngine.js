/**
 * Official Table Tennis / Ping Pong Scoring Engine
 * Supports any target points, any win-by margin (1 = sudden death, 2 = classic, etc.),
 * any serve rotation interval, automatic 1-point serve alternation in Deuce,
 * and point history undo.
 */

export const MATCH_STATUS = {
  WAITING: 'WAITING',
  READY: 'READY',
  IN_PROGRESS: 'MATCH IN PROGRESS',
  DEUCE: 'DEUCE',
  GAME_POINT: 'GAME POINT',
  WINNER: 'WINNER',
};

/**
 * Computes comprehensive derived scoring state for a match.
 * @param {object} match - { score1, score2, initialServer, player1Id, player2Id, completed }
 * @param {object} rules - { targetPoints: number, serveRotation: number, winBy: number }
 */
export function evaluateMatchState(
  match,
  rules = {
    targetPoints: 11,
    serveRotation: 2,
    winBy: 2,
    skunkEnabled: false,
    skunkScore: 7,
    deadMansServe: false,
  }
) {
  const targetPoints = Math.max(1, Math.floor(Number(rules?.targetPoints) || 11));
  const serveRotation = Math.max(1, Math.floor(Number(rules?.serveRotation) || 2));
  const winBy = Math.max(1, Math.floor(Number(rules?.winBy ?? 2) || 2));
  const skunkEnabled = Boolean(rules?.skunkEnabled);
  const skunkScore = Math.max(1, Math.floor(Number(rules?.skunkScore ?? 7) || 7));
  const deadMansServe = Boolean(rules?.deadMansServe);

  if (!match) {
    return {
      status: MATCH_STATUS.WAITING,
      activeServer: 1,
      isDeuce: false,
      isInDeuceZone: false,
      gamePointFor: null,
      isSkunkPoint: false,
      isSkunkWin: false,
      isDeadMansServe: false,
      winnerSlot: null,
      canComplete: false,
      totalPoints: 0,
      pointsUntilServeSwitch: serveRotation,
      targetPoints,
      serveRotation,
      winBy,
      skunkEnabled,
      skunkScore,
      deadMansServe,
    };
  }

  const score1 = Math.max(0, Number(match.score1) || 0);
  const score2 = Math.max(0, Number(match.score2) || 0);
  const initialServer = match.initialServer === 2 ? 2 : 1;
  const deuceAt = Math.max(0, targetPoints - 1);
  const totalPoints = score1 + score2;
  const hasBothPlayers = Boolean(match.player1Id && match.player2Id);

  // Configurable win-by-N and optional Skunk (shutout at skunkScore-0) winner check
  let winnerSlot = null;
  let isSkunkWin = false;
  if (score1 >= targetPoints && score1 - score2 >= winBy) {
    winnerSlot = 1;
  } else if (score2 >= targetPoints && score2 - score1 >= winBy) {
    winnerSlot = 2;
  } else if (skunkEnabled && score1 >= skunkScore && score2 === 0) {
    winnerSlot = 1;
    isSkunkWin = true;
  } else if (skunkEnabled && score2 >= skunkScore && score1 === 0) {
    winnerSlot = 2;
    isSkunkWin = true;
  }

  const isInDeuceZone =
    winBy >= 2 && targetPoints >= 2 && score1 >= deuceAt && score2 >= deuceAt;
  const isSuddenDeathTie =
    winBy === 1 && targetPoints >= 2 && score1 === deuceAt && score2 === deuceAt;
  const isDeuce = (isInDeuceZone || isSuddenDeathTie) && score1 === score2 && winnerSlot === null;

  // A player holds Game Point (or Skunk Point) iff scoring 1 more point immediately wins the match
  let gamePointFor = null;
  let isSkunkPoint = false;
  if (winnerSlot === null && hasBothPlayers) {
    const p1NormalWin = score1 + 1 >= targetPoints && score1 + 1 - score2 >= winBy;
    const p2NormalWin = score2 + 1 >= targetPoints && score2 + 1 - score1 >= winBy;
    const p1SkunkWin = skunkEnabled && score1 + 1 >= skunkScore && score2 === 0;
    const p2SkunkWin = skunkEnabled && score2 + 1 >= skunkScore && score1 === 0;
    const p1WinsNext = p1NormalWin || p1SkunkWin;
    const p2WinsNext = p2NormalWin || p2SkunkWin;
    if (p1WinsNext && !p2WinsNext) {
      gamePointFor = 1;
      isSkunkPoint = !p1NormalWin && p1SkunkWin;
    } else if (p2WinsNext && !p1WinsNext) {
      gamePointFor = 2;
      isSkunkPoint = !p2NormalWin && p2SkunkWin;
    }
  }

  // Active server calculation
  let switches;
  let pointsUntilServeSwitch;
  if (isInDeuceZone) {
    const rotationsBeforeDeuce = Math.floor((2 * deuceAt) / serveRotation);
    const deucePoints = totalPoints - 2 * deuceAt;
    switches = rotationsBeforeDeuce + deucePoints;
    pointsUntilServeSwitch = 1;
  } else {
    switches = Math.floor(totalPoints / serveRotation);
    pointsUntilServeSwitch = serveRotation - (totalPoints % serveRotation);
  }

  let activeServer =
    switches % 2 === 0 ? initialServer : initialServer === 1 ? 2 : 1;
  // Dead Man's Serve: when facing Game Point (or Skunk Point), the trailing player always serves
  let isDeadMansServe = false;
  if (deadMansServe && winnerSlot === null && gamePointFor !== null) {
    activeServer = gamePointFor === 1 ? 2 : 1;
    pointsUntilServeSwitch = 1;
    isDeadMansServe = true;
  }
  // In official Table Tennis Doubles, each team alternates between Member 1 and Member 2
  // on each of that team's service turns (0 -> member 0, 1 -> member 1).
  const activeServerMemberIndex = Math.floor(switches / 2) % 2;

  let status = MATCH_STATUS.IN_PROGRESS;
  if (!hasBothPlayers) {
    status = MATCH_STATUS.WAITING;
  } else if (winnerSlot !== null || match.completed) {
    status = MATCH_STATUS.WINNER;
  } else if (!match.started && score1 === 0 && score2 === 0) {
    status = MATCH_STATUS.READY;
  } else if (isDeuce) {
    status = MATCH_STATUS.DEUCE;
  } else if (gamePointFor !== null) {
    status = MATCH_STATUS.GAME_POINT;
  }

  return {
    status,
    activeServer,
    activeServerMemberIndex,
    isDeuce,
    isInDeuceZone,
    gamePointFor,
    isSkunkPoint,
    isSkunkWin,
    isDeadMansServe,
    winnerSlot,
    canComplete: hasBothPlayers && winnerSlot !== null && !match.completed,
    totalPoints,
    pointsUntilServeSwitch,
    deuceAt,
    targetPoints,
    serveRotation,
    winBy,
    skunkEnabled,
    skunkScore,
    deadMansServe,
  };
}

/**
 * Applies a +1 or -1 score adjustment cleanly with point history tracking.
 */
export function adjustMatchScore(match, playerSlot, delta, rules) {
  if (!match || match.completed || !match.player1Id || !match.player2Id) {
    return match;
  }

  const evaluation = evaluateMatchState(match, rules);
  // Prevent adding more points after a winner is already reached
  if (delta > 0 && evaluation.winnerSlot !== null) {
    return match;
  }

  const history = Array.isArray(match.pointHistory) ? [...match.pointHistory] : [];
  let score1 = Math.max(0, Number(match.score1) || 0);
  let score2 = Math.max(0, Number(match.score2) || 0);

  if (playerSlot === 1) {
    if (delta > 0) {
      score1 += 1;
      history.push(1);
    } else if (delta < 0 && score1 > 0) {
      score1 -= 1;
      const lastIdx = history.lastIndexOf(1);
      if (lastIdx !== -1) history.splice(lastIdx, 1);
    }
  } else if (playerSlot === 2) {
    if (delta > 0) {
      score2 += 1;
      history.push(2);
    } else if (delta < 0 && score2 > 0) {
      score2 -= 1;
      const lastIdx = history.lastIndexOf(2);
      if (lastIdx !== -1) history.splice(lastIdx, 1);
    }
  }

  return {
    ...match,
    score1,
    score2,
    pointHistory: history,
  };
}

/**
 * Undoes the most recently scored point in the match.
 */
export function undoLastPoint(match) {
  if (!match || match.completed) return match;
  const history = Array.isArray(match.pointHistory) ? [...match.pointHistory] : [];
  if (history.length === 0) return match;

  const lastScorer = history.pop();
  let score1 = Math.max(0, Number(match.score1) || 0);
  let score2 = Math.max(0, Number(match.score2) || 0);

  if (lastScorer === 1 && score1 > 0) {
    score1 -= 1;
  } else if (lastScorer === 2 && score2 > 0) {
    score2 -= 1;
  }

  return {
    ...match,
    score1,
    score2,
    pointHistory: history,
  };
}

/**
 * Toggles who served first in the match.
 */
export function toggleInitialServer(match) {
  if (!match || match.completed) return match;
  return {
    ...match,
    initialServer: match.initialServer === 2 ? 1 : 2,
  };
}

/**
 * Computes elapsed match time in milliseconds for the live count-up timer.
 * - Returns 0 before a match has started.
 * - Counts up continuously from `match.startedAt` (+ any accumulated `timerOffsetMs` from reopens).
 * - Visually stops at `match.winnerReachedAt` once a winning score is reached, while `startedAt`
 *   keeps running in the background so subtracting a mistaken winning point immediately resumes
 *   the true continuous elapsed time.
 * - Freezes cleanly at the final recorded duration once completed.
 */
export function computeMatchElapsedMs(match, nowMs = Date.now()) {
  if (!match) return 0;
  const baseOffset = Math.max(0, Number(match.timerOffsetMs) || 0);
  if (match.completed) {
    if (Number.isFinite(match.elapsedMs)) {
      return Math.max(0, match.elapsedMs);
    }
    const endTs = Number(match.winnerReachedAt || match.completedAt || 0);
    if (match.startedAt && endTs) {
      return baseOffset + Math.max(0, endTs - Number(match.startedAt));
    }
    return baseOffset;
  }
  if (match.paused) {
    return baseOffset;
  }
  if (match.startedAt) {
    const endTs = match.winnerReachedAt ? Number(match.winnerReachedAt) : nowMs;
    return baseOffset + Math.max(0, endTs - Number(match.startedAt));
  }
  return baseOffset;
}

/**
 * Formats an elapsed duration in milliseconds as MM:SS (or H:MM:SS past 1 hour).
 */
export function formatMatchTimer(elapsedMs) {
  const totalSec = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Returns true when a match is nearing completion (e.g. >= 9 in an 11-pt game,
 * >= 17 in a 21-pt game, or already completed) so the On Deck banner can auto-appear.
 */
export function isMatchNearingEnd(match, rules = {}) {
  if (!match || match.isBye) return false;
  if (match.completed) return true;
  if ((Number(match.score1) || 0) === 0 && (Number(match.score2) || 0) === 0) return true;
  const target = Math.max(1, Math.floor(Number(rules?.targetPoints) || 11));
  const s1 = Math.max(0, Number(match.score1) || 0);
  const s2 = Math.max(0, Number(match.score2) || 0);
  const margin = Math.max(2, Math.round(target * 0.2));
  const threshold = Math.max(1, target - margin);
  if (Math.max(s1, s2) >= threshold) return true;
  if (rules?.skunkEnabled) {
    const skunkScore = Math.max(1, Math.floor(Number(rules?.skunkScore ?? 7) || 7));
    const skunkThreshold = Math.max(1, skunkScore - 2);
    if ((s2 === 0 && s1 >= skunkThreshold) || (s1 === 0 && s2 >= skunkThreshold)) {
      return true;
    }
  }
  return false;
}
