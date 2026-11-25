import React from 'react';
import { formatMatchTimer } from '../engine/scoringEngine.js';

/**
 * Shared tournament stats + leaders content.
 * - variant="full": the Spotlight slide's leaderboard + highlight cards (+ extra stat cards when `extras`).
 * - variant="chips": the same data flattened into compact chips for the presentation ticker.
 */
export function buildStatChips(stats, rules = {}) {
  const chips = [
    { label: 'MATCHES', value: `${stats.completedCount} / ${stats.totalMatches}` },
    { label: 'PROGRESS', value: `${stats.progressPct}%` },
    { label: 'TOTAL POINTS', value: String(stats.totalPointsPlayed) },
  ];
  if (stats.avgPointsPerMatch > 0) chips.push({ label: 'AVG PTS / MATCH', value: String(stats.avgPointsPerMatch) });
  if (stats.avgMatchDurationMs > 0) chips.push({ label: 'AVG MATCH TIME', value: formatMatchTimer(stats.avgMatchDurationMs) });
  chips.push({ label: `${rules.winBy ?? 2}-PT NAIL-BITERS`, value: String(stats.closestMarginCount) });
  chips.push({ label: 'DEUCE MATCHES', value: String(stats.deuceMatchesCount) });
  chips.push({ label: 'REMAINING', value: String(stats.remainingCount) });
  return chips;
}

export function buildHighlights(stats, playerMap) {
  const nm = (id, f) => playerMap.get(id)?.name || f;
  return [
    {
      label: '🔥 HIGHEST THRILLER',
      value: stats.highestScoringMatch
        ? `${stats.highestScoringMatch.match.score1}–${stats.highestScoringMatch.match.score2}`
        : '—',
      sub: stats.highestScoringMatch
        ? `${nm(stats.highestScoringMatch.match.player1Id, 'P1')} vs ${nm(stats.highestScoringMatch.match.player2Id, 'P2')}`
        : 'Awaiting completed match',
    },
    {
      label: '⚡ HOTTEST STREAK',
      value: stats.longestPointStreak ? `${stats.longestPointStreak.streak} PTS` : '—',
      sub: stats.longestPointStreak
        ? `${stats.longestPointStreak.playerName} (${stats.longestPointStreak.matchLabel})`
        : 'Consecutive points run',
    },
    {
      label: '💥 BIGGEST WIN',
      value: stats.biggestBlowout ? `+${stats.biggestBlowout.margin} PTS` : '—',
      sub: stats.biggestBlowout
        ? `${stats.biggestBlowout.winnerName} (${stats.biggestBlowout.match.score1}–${stats.biggestBlowout.match.score2})`
        : 'Largest winning margin',
    },
    {
      label: '⏱ LONGEST MATCH',
      value: stats.longestMatch ? formatMatchTimer(stats.longestMatch.elapsedMs) : `${stats.remainingCount} LEFT`,
      sub: stats.longestMatch
        ? `${stats.longestMatch.match.label} (${stats.longestMatch.match.score1}–${stats.longestMatch.match.score2})`
        : `${stats.deuceMatchesCount} deuce match${stats.deuceMatchesCount === 1 ? '' : 'es'}`,
    },
  ];
}

export default function TournamentStatsPanel({
  stats,
  playerMap,
  isTeams = false,
  rules = {},
  variant = 'full',
  leaderCount = 5,
  extras = false,
}) {
  const leaders = (stats.leaderboard || []).slice(0, leaderCount);
  const highlights = buildHighlights(stats, playerMap);
  const fmtDiff = (d) => (d > 0 ? `+${d}` : String(d));

  if (variant === 'chips') {
    return (
      <>
        {leaders.map((row, idx) => (
          <div key={row.playerId} className="ticker-chip">
            <span className="ticker-code">#{idx + 1}</span>
            <span className={idx === 0 && row.wins > 0 ? 'ticker-winner' : ''}>{row.name}</span>
            <strong className="ticker-score">{row.wins}W–{row.losses}L</strong>
            <span>{row.pointsFor} pts ({fmtDiff(row.pointDiff)})</span>
          </div>
        ))}
        {highlights.map((h) => (
          <div key={h.label} className="ticker-chip">
            <span className="ticker-code">{h.label}</span>
            <strong className="ticker-score">{h.value}</strong>
            <span>{h.sub}</span>
          </div>
        ))}
        {buildStatChips(stats, rules).map((c) => (
          <div key={c.label} className="ticker-chip">
            <span className="ticker-code">{c.label}</span>
            <strong className="ticker-score">{c.value}</strong>
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      <div className="intermission-leaders-section">
        <div className="intermission-sec-label">TOP {isTeams ? 'TEAMS' : 'PLAYERS'} LEADERBOARD</div>
        <div className="intermission-leaders-list">
          {leaders.map((row, idx) => (
            <div
              key={row.playerId}
              className={`intermission-leader-row ${idx === 0 && row.wins > 0 ? 'is-top' : ''}`}
            >
              <span className="ilr-rank">#{idx + 1}</span>
              <span className="ilr-name">{row.name}</span>
              <span className="ilr-record">{row.wins}W–{row.losses}L</span>
              <span className="ilr-pts">{row.pointsFor} pts</span>
              <span className={`ilr-diff ${row.pointDiff > 0 ? 'is-pos' : row.pointDiff < 0 ? 'is-neg' : ''}`}>
                {fmtDiff(row.pointDiff)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="intermission-highlights-grid">
        {highlights.map((h) => (
          <div key={h.label} className="ih-card">
            <span className="ih-label">{h.label}</span>
            <strong className="ih-val">{h.value}</strong>
            <span className="ih-sub">{h.sub}</span>
          </div>
        ))}
      </div>

      {extras && (
        <div className="intermission-highlights-grid">
          {buildStatChips(stats, rules).map((c) => (
            <div key={c.label} className="ih-card">
              <span className="ih-label">{c.label}</span>
              <strong className="ih-val">{c.value}</strong>
            </div>
          ))}
        </div>
      )}
    </>
  );
}