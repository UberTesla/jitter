import React from 'react';
import { evaluateMatchState, MATCH_STATUS } from '../engine/scoringEngine.js';
import { formatTeamMembers } from '../engine/bracketGenerator.js';
import PointRemovalTooltip from './PointRemovalTooltip.jsx';
import MatchTimer from './MatchTimer.jsx';

/**
 * High-Contrast Digital Table Tennis Scoreboard
 * Supports both Singles (1v1) and Teams / Doubles (2v2 with teammate roster &
 * rotating doubles server tracking), plus selectable broadcast score typography.
 */
export default function Scoreboard({
  match,
  players,
  rules,
  entryMode = 'singles',
  scoreFont = 'barlow',
  mode = 'control', // 'control' | 'presentation' | 'compact'
  onAddPoint,
  onSubtractPoint,
  pendingPointRemoval = null,
  onCancelPointRemoval,
  onSwitchFirstServer,
  onStartMatch,
  onCancelMatchStart,
  onPauseMatch,
  onResumeMatch,
  onChangeMatchTable,
  onOpenMatchPicker,
  onReleaseScorekeeper,
  onCompleteMatch,
  onEditCompletedMatch,
  onReopenMatch,
}) {
  const playerMap = React.useMemo(() => {
    const map = new Map();
    for (const p of players || []) map.set(p.id, p);
    return map;
  }, [players]);

  const isTeams = entryMode === 'teams';
  const p1 = match?.player1Id ? playerMap.get(match.player1Id) : null;
  const p2 = match?.player2Id ? playerMap.get(match.player2Id) : null;
  const p1Members = isTeams ? formatTeamMembers(p1, ' · ') : '';
  const p2Members = isTeams ? formatTeamMembers(p2, ' · ') : '';

  const evalState = evaluateMatchState(match, rules);
  const isControl = mode === 'control';
  const isCompact = mode === 'compact';
  const tableCount = Math.max(1, Math.floor(Number(rules?.tableCount ?? 1) || 1));
  const currentTableNum = Math.max(
    1,
    Math.min(tableCount, Math.floor(Number(match?.tableNumber) || 1))
  );
  const isStarted = Boolean(
    match && (match.started || match.completed || (match.score1 || 0) > 0 || (match.score2 || 0) > 0)
  );
  const isPaused = Boolean(match && match.paused && !match.completed);
  const isLiveInSession = Boolean(isStarted && !isPaused && !match?.completed);
  const canStartMatch = Boolean(match && p1 && p2 && !match.completed && !isStarted);

  const statusTone =
    evalState.status === MATCH_STATUS.WINNER
      ? 'status-winner'
      : isPaused
      ? 'status-waiting'
      : evalState.status === MATCH_STATUS.DEUCE
      ? 'status-deuce'
      : evalState.status === MATCH_STATUS.GAME_POINT
      ? 'status-gamepoint'
      : evalState.status === MATCH_STATUS.WAITING || canStartMatch
      ? 'status-waiting'
      : 'status-live';

  const formatScore = (n) => String(Math.max(0, Number(n) || 0)).padStart(2, '0');

  const winnerName =
    evalState.winnerSlot === 1
      ? p1?.name
      : evalState.winnerSlot === 2
      ? p2?.name
      : match?.winnerId
      ? playerMap.get(match.winnerId)?.name
      : null;

  const gamePointName =
    evalState.gamePointFor === 1 ? p1?.name : evalState.gamePointFor === 2 ? p2?.name : null;

  const getActiveServerDetail = (entrant) => {
    const baseText = evalState.isDeadMansServe
      ? "Dead Man's Serve"
      : evalState.isInDeuceZone
      ? 'Deuce: 1 serve'
      : `${evalState.pointsUntilServeSwitch} serve${
          evalState.pointsUntilServeSwitch === 1 ? '' : 's'
        } left`;

    if (isTeams && Array.isArray(entrant?.members)) {
      const serverMember = entrant.members[evalState.activeServerMemberIndex] || entrant.members[0];
      if (serverMember) {
        return `Server: ${serverMember} · ${baseText}`;
      }
    }
    return baseText;
  };

  return (
    <section
      className={`scoreboard-card mode-${mode} score-font-${scoreFont} ${isTeams ? 'is-teams-mode' : ''}`}
      aria-label="Live Match Scoreboard"
    >
      <header className="scoreboard-header">
        <div className="scoreboard-meta">
          <span className="match-pill">
            {match ? `${match.roundLabel} · ${match.label}` : 'No Match Selected'}
          </span>
          {tableCount > 1 && match && (
            isControl && !onOpenMatchPicker && onChangeMatchTable ? (
              <select
                className="table-select-pill"
                value={currentTableNum}
                onChange={(e) => onChangeMatchTable(Number(e.target.value))}
                aria-label="Assigned match table"
              >
                {Array.from({ length: tableCount }, (_, idx) => (
                  <option key={idx + 1} value={idx + 1}>
                    Table {idx + 1}
                  </option>
                ))}
              </select>
            ) : (
              <span className="table-badge-pill">TABLE {currentTableNum}</span>
            )
          )}
          {isTeams && <span className="doubles-pill">DOUBLES / TEAMS</span>}
          {isControl && match?.scorekeeperDeviceId && !match.completed && (
            <span
              className="doubles-pill"
              title={`Claimed by Scorekeeper: ${match.scorekeeperDeviceName || match.scorekeeperDeviceId}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                background: 'rgba(16, 185, 129, 0.16)',
                borderColor: 'rgba(52, 211, 153, 0.45)',
                color: '#a7f3d0',
              }}
            >
              🎯 {match.scorekeeperDeviceName || 'Scorekeeper'}
              {onReleaseScorekeeper && (
                <button
                  type="button"
                  onClick={() => onReleaseScorekeeper(match.id)}
                  title="Release this Scorekeeper's claim on the match"
                  aria-label="Release Scorekeeper claim"
                  style={{
                    appearance: 'none',
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: '0 0.1rem',
                    fontSize: '0.72rem',
                    lineHeight: 1,
                    opacity: 0.85,
                  }}
                >
                  ✕
                </button>
              )}
            </span>
          )}
        </div>

        <div className="scoreboard-header-center">
          <div className={`match-status-banner ${statusTone}`} role="status" aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            <span className="status-label">
              {evalState.status === MATCH_STATUS.WINNER && winnerName
                ? `${evalState.isSkunkWin ? '🦨 SKUNK WIN' : 'WINNER'} — ${winnerName}`
                : isPaused
                ? '⏸ PAUSED'
                : evalState.status === MATCH_STATUS.GAME_POINT && gamePointName
                ? `${evalState.isSkunkPoint ? '🦨 SKUNK POINT' : 'GAME POINT'} — ${gamePointName}`
                : canStartMatch
                ? 'READY TO START'
                : evalState.status}
            </span>
            <MatchTimer match={match} inline />
          </div>
        </div>

        <div className="scoreboard-header-right">
          <span className="rules-pill">
            Race to {rules.targetPoints} · Win by {rules.winBy ?? 2} · Serve every{' '}
            {evalState.isInDeuceZone ? '1 (Deuce)' : rules.serveRotation}
            {rules?.skunkEnabled ? ` · Skunk ${rules.skunkScore ?? 7}–0` : ''}
            {rules?.deadMansServe ? " · Dead Man's Serve" : ''}
          </span>
        </div>
      </header>

      <div className="scoreboard-grid">
        {/* Side 1 Panel */}
        <div
          className={`player-panel player-1 ${
            evalState.activeServer === 1 && evalState.status !== MATCH_STATUS.WINNER && p1 && p2
              ? 'is-serving'
              : ''
          } ${evalState.winnerSlot === 1 || match?.winnerId === p1?.id ? 'is-winner' : ''}`}
        >
          <div className="player-top-row">
            <div className="player-identity">
              <span className="seed-badge">{p1 ? `#${p1.seed}` : 'TBD'}</span>
              <div className="player-name-stack">
                <h2 className="player-name">
                  {p1 ? p1.name : match?.source1Label || (isTeams ? 'Awaiting Team' : 'Awaiting Player')}
                </h2>
                {p1Members && <div className="team-members-line">{p1Members}</div>}
              </div>
            </div>
            {evalState.activeServer === 1 && p1 && p2 && !match?.completed && evalState.winnerSlot === null && (
              <span className="serving-badge" aria-label={`${isTeams ? 'Team 1' : 'Player 1'} is serving`}>
                <span className="serving-ball" aria-hidden="true" />
                SERVING
              </span>
            )}
            {(evalState.winnerSlot === 1 || (match?.completed && match?.winnerId === p1?.id)) && (
              <span className="winner-tag">{evalState.isSkunkWin ? '🦨 SKUNK' : 'WINNER'}</span>
            )}
          </div>

          <div className="score-display-wrap">
            <div className="digital-score" aria-label={`${p1?.name || (isTeams ? 'Team 1' : 'Player 1')} score`}>
              {formatScore(match?.score1)}
            </div>
            {!isCompact && evalState.activeServer === 1 && p1 && p2 && evalState.winnerSlot === null && (
              <div className="serve-countdown">{getActiveServerDetail(p1)}</div>
            )}
          </div>

          {isControl && (
            <div className="score-controls">
              <button
                type="button"
                className="btn-score-plus btn-p1"
                onClick={() => onAddPoint?.(1)}
                disabled={!p1 || !p2 || !isStarted || isPaused || match?.completed || evalState.winnerSlot !== null}
              >
                +1 Point <kbd>1</kbd>
              </button>
              <div className="score-minus-anchor">
                {pendingPointRemoval?.slot === 1 && (
                  <PointRemovalTooltip
                    pending={pendingPointRemoval}
                    onCancel={onCancelPointRemoval}
                  />
                )}
                <button
                  type="button"
                  className={`btn-score-minus ${
                    pendingPointRemoval?.slot === 1 ? 'is-pending-remove' : ''
                  }`}
                  onClick={() => onSubtractPoint?.(1)}
                  disabled={
                    !p1 ||
                    !p2 ||
                    match?.completed ||
                    (match?.score1 || 0) <= 0
                  }
                  aria-label={`Subtract 1 point from ${isTeams ? 'Team 1' : 'Player 1'}`}
                >
                  -1
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Center VS Divider */}
        <div className="scoreboard-vs" aria-hidden="true">
          <span className="vs-badge">VS</span>
          <span className="vs-total">{evalState.totalPoints} PTS</span>
        </div>

        {/* Side 2 Panel */}
        <div
          className={`player-panel player-2 ${
            evalState.activeServer === 2 && evalState.status !== MATCH_STATUS.WINNER && p1 && p2
              ? 'is-serving'
              : ''
          } ${evalState.winnerSlot === 2 || match?.winnerId === p2?.id ? 'is-winner' : ''}`}
        >
          <div className="player-top-row">
            <div className="player-identity">
              <span className="seed-badge">{p2 ? `#${p2.seed}` : 'TBD'}</span>
              <div className="player-name-stack">
                <h2 className="player-name">
                  {p2 ? p2.name : match?.source2Label || (isTeams ? 'Awaiting Team' : 'Awaiting Player')}
                </h2>
                {p2Members && <div className="team-members-line">{p2Members}</div>}
              </div>
            </div>
            {evalState.activeServer === 2 && p1 && p2 && !match?.completed && evalState.winnerSlot === null && (
              <span className="serving-badge" aria-label={`${isTeams ? 'Team 2' : 'Player 2'} is serving`}>
                <span className="serving-ball" aria-hidden="true" />
                SERVING
              </span>
            )}
            {(evalState.winnerSlot === 2 || (match?.completed && match?.winnerId === p2?.id)) && (
              <span className="winner-tag">{evalState.isSkunkWin ? '🦨 SKUNK' : 'WINNER'}</span>
            )}
          </div>

          <div className="score-display-wrap">
            <div className="digital-score" aria-label={`${p2?.name || (isTeams ? 'Team 2' : 'Player 2')} score`}>
              {formatScore(match?.score2)}
            </div>
            {!isCompact && evalState.activeServer === 2 && p1 && p2 && evalState.winnerSlot === null && (
              <div className="serve-countdown">{getActiveServerDetail(p2)}</div>
            )}
          </div>

          {isControl && (
            <div className="score-controls">
              <button
                type="button"
                className="btn-score-plus btn-p2"
                onClick={() => onAddPoint?.(2)}
                disabled={!p1 || !p2 || !isStarted || isPaused || match?.completed || evalState.winnerSlot !== null}
              >
                +1 Point <kbd>2</kbd>
              </button>
              <div className="score-minus-anchor">
                {pendingPointRemoval?.slot === 2 && (
                  <PointRemovalTooltip
                    pending={pendingPointRemoval}
                    onCancel={onCancelPointRemoval}
                  />
                )}
                <button
                  type="button"
                  className={`btn-score-minus ${
                    pendingPointRemoval?.slot === 2 ? 'is-pending-remove' : ''
                  }`}
                  onClick={() => onSubtractPoint?.(2)}
                  disabled={
                    !p1 ||
                    !p2 ||
                    match?.completed ||
                    (match?.score2 || 0) <= 0
                  }
                  aria-label={`Subtract 1 point from ${isTeams ? 'Team 2' : 'Player 2'}`}
                >
                  -1
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {isControl && (
        <footer className="scoreboard-actions">
          <div className="scoreboard-action-group">
            <button
              type="button"
              className="btn-secondary"
              onClick={onSwitchFirstServer}
              disabled={!match || match.completed}
            >
              ⇄ Switch 1st Server (
              {isTeams
                ? match?.initialServer === 2
                  ? 'Team 2'
                  : 'Team 1'
                : match?.initialServer === 2
                ? 'P2'
                : 'P1'}
              )
            </button>
            {match && onOpenMatchPicker && (
              <button
                type="button"
                className="btn-secondary"
                disabled={isLiveInSession}
                onClick={() => onOpenMatchPicker(currentTableNum)}
                title={
                  isLiveInSession
                    ? 'Pause or cancel this live match before changing it'
                    : tableCount > 1
                    ? `Change the match assigned to Table ${currentTableNum}`
                    : 'Change the active match'
                }
                style={{
                  opacity: isLiveInSession ? 0.5 : 1,
                  cursor: isLiveInSession ? 'not-allowed' : 'pointer',
                }}
              >
                Change Match
              </button>
            )}
            {match && isStarted && !match.completed && !isPaused && onPauseMatch && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onPauseMatch()}
                title="Pause this live match (freezes timer and allows changing the table match)"
              >
                ⏸ Pause
              </button>
            )}
            {match && isStarted && !match.completed && isPaused && onResumeMatch && (
              <button
                type="button"
                className="btn-amber"
                onClick={() => onResumeMatch()}
                title="Resume this paused match"
              >
                ▶ Resume Match
              </button>
            )}
            {match &&
              isStarted &&
              !match.completed &&
              (match.score1 || 0) === 0 &&
              (match.score2 || 0) === 0 &&
              onCancelMatchStart && (
                <button
                  type="button"
                  className="btn-danger-outline"
                  onClick={() => onCancelMatchStart()}
                  title="Return this match to Ready (unstarted) state and reset timer"
                >
                  ↩ Cancel Start
                </button>
              )}
          </div>

          {canStartMatch ? (
            <button
              type="button"
              className="btn-amber btn-begin-match"
              onClick={() => onStartMatch?.()}
            >
              ▶ Begin Match
            </button>
          ) : match?.completed ? (
            <div className="scoreboard-completed-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onEditCompletedMatch?.(match.id)}
              >
                ✏️ Edit Final Score
              </button>
              <button
                type="button"
                className="btn-amber"
                onClick={() => onReopenMatch?.(match.id)}
              >
                🔓 Reopen Match
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={`btn-advance ${evalState.canComplete ? 'is-ready' : ''}`}
              onClick={onCompleteMatch}
              disabled={!evalState.canComplete}
            >
              {evalState.canComplete
                ? `🏆 Complete Match & Advance ${isTeams ? 'Team' : 'Winner'}`
                : `Reach ${rules.targetPoints} (Win by ${rules.winBy ?? 2}) to Complete`}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
