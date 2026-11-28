import React, { useMemo, useState } from 'react';
import { groupBracketRounds, formatTeamMembers, isByeMatch } from '../engine/bracketGenerator.js';

const LARGE_BRACKET_THRESHOLD = 16;
const BRACKET_ROUND_TAB_KEY = 'pingpong-bracket-round-tab-v1';

function computeRoundTier(matchCount, maxMatches) {
  if (!maxMatches || !matchCount || matchCount >= maxMatches) return 0;
  return Math.min(3, Math.max(1, Math.round(Math.log2(maxMatches / matchCount))));
}

/**
 * Interactive & Presentation Single / Double Elimination Bracket Component
 * - For <= 16 players/teams: renders the complete multi-round tree view.
 * - For > 16 players/teams: switches automatically to a high-readability
 *   Current Round Focus grid (with round switcher tabs in interactive Control View).
 */
export default function BracketView({
  matches,
  players,
  format,
  entryMode = 'singles',
  activeMatchId,
  championId,
  interactive = true,
  compact = false,
  noScroll = false,
  bracketFilter = 'both', // 'both' | 'winners' | 'losers'
  onSelectMatch,
}) {
  const isTeams = entryMode === 'teams';
  const isLargeBracket = (players?.length || 0) > LARGE_BRACKET_THRESHOLD;
  const effectiveFilter = format === 'double' ? bracketFilter : 'both';

  // In interactive Control View on large brackets, operator can switch rounds or stick to 'current'
  const [selectedRoundKey, setSelectedRoundKey] = useState(() => {
    if (!interactive) return 'current';
    try {
      return localStorage.getItem(BRACKET_ROUND_TAB_KEY) || 'current';
    } catch {
      return 'current';
    }
  });

  const handleSelectRoundTab = (key) => {
    setSelectedRoundKey(key);
    try {
      localStorage.setItem(BRACKET_ROUND_TAB_KEY, key);
    } catch {
      // Ignore storage errors
    }
  };

  const playerMap = useMemo(() => {
    const map = new Map();
    for (const p of players || []) map.set(p.id, p);
    return map;
  }, [players]);

  const { winnersRounds, losersRounds, grandFinal } = useMemo(
    () => groupBracketRounds(matches || {}),
    [matches]
  );

  const champion = championId ? playerMap.get(championId) : null;

  const visibleLosersRounds = useMemo(
    () =>
      losersRounds
        .map((r) => ({
          ...r,
          matches: r.matches.filter((m) => !(m.isBye && m.winnerIsBye)),
        }))
        .filter((r) => r.matches.length > 0),
    [losersRounds]
  );

  // Build unified list of rounds for Large Bracket Current Round Focus mode
  const allRoundEntries = useMemo(() => {
    const list = [];
    if (effectiveFilter !== 'losers') {
      for (const r of winnersRounds) {
        list.push({
          key: `winners-${r.round}`,
          bracket: 'winners',
          round: r.round,
          label: r.label,
          matches: r.matches.filter((m) => !(m.isBye && m.winnerIsBye)),
        });
      }
    }
    if (effectiveFilter !== 'winners') {
      for (const r of visibleLosersRounds) {
        list.push({
          key: `losers-${r.round}`,
          bracket: 'losers',
          round: r.round,
          label: r.label,
          matches: r.matches,
        });
      }
    }
    if (format === 'double' && grandFinal && effectiveFilter !== 'losers') {
      list.push({
        key: 'final-1',
        bracket: 'final',
        round: 1,
        label: 'Grand Final',
        matches: [grandFinal],
      });
    }
    return list;
  }, [winnersRounds, visibleLosersRounds, format, grandFinal, effectiveFilter]);

  // Determine the active/current round key automatically
  const currentRoundKey = useMemo(() => {
    const activeMatch = activeMatchId ? matches?.[activeMatchId] : null;
    if (activeMatch) {
      const candidateKey = `${activeMatch.bracket}-${activeMatch.round}`;
      if (allRoundEntries.some((entry) => entry.key === candidateKey)) {
        return candidateKey;
      }
    }
    const firstIncomplete = allRoundEntries.find((entry) =>
      entry.matches.some((m) => !m.completed && !m.isBye)
    );
    if (firstIncomplete) return firstIncomplete.key;
    return allRoundEntries[allRoundEntries.length - 1]?.key || 'winners-1';
  }, [activeMatchId, matches, allRoundEntries]);

  const renderMatchCard = (match) => {
    if (match.isBye && match.winnerIsBye) {
      return <div key={match.id} className="bracket-bye-spacer" aria-hidden="true" />;
    }

    const p1 = match.player1Id ? playerMap.get(match.player1Id) : null;
    const p2 = match.player2Id ? playerMap.get(match.player2Id) : null;
    const isBye = isByeMatch(match);
    const isActive = match.id === activeMatchId && !isBye;
    const isCompleted = Boolean(match.completed) && !isBye;
    const isReady = Boolean(p1 && p2 && !isCompleted && !isBye);
    const canClick = interactive && !isBye;

    const cardClass = [
      'bracket-match-card',
      isBye ? 'is-bye' : '',
      isActive ? 'is-active' : '',
      isCompleted ? 'is-completed' : '',
      isReady ? 'is-ready' : '',
      canClick ? 'is-clickable' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const Tag = canClick ? 'button' : 'div';

    return (
      <Tag
        key={match.id}
        type={canClick ? 'button' : undefined}
        className={cardClass}
        onClick={canClick ? () => onSelectMatch?.(match.id) : undefined}
        aria-label={
          canClick
            ? `Load match ${match.label}: ${p1?.name || match.source1Label} vs ${
                p2?.name || match.source2Label
              }`
            : undefined
        }
      >
        <div className="bracket-card-head">
          <span className="bracket-match-code">{match.label}</span>
          <span className="bracket-match-state">
            {isBye ? 'BYE' : isActive ? 'LIVE' : isCompleted ? 'FINAL' : isReady ? 'READY' : 'TBD'}
          </span>
        </div>

        <div
          className={`bracket-slot ${
            (isCompleted || isBye) && match.winnerId === match.player1Id && match.player1Id
              ? 'is-slot-winner'
              : ''
          } ${
            (isCompleted && match.winnerId !== match.player1Id) || match.slot1IsBye
              ? 'is-slot-loser'
              : ''
          }`}
        >
          <span className="slot-seed">{p1 ? `#${p1.seed}` : '—'}</span>
          <div className="slot-name-wrap">
            <span className="slot-name">
              {match.slot1IsBye ? 'BYE' : p1 ? p1.name : match.source1Label}
            </span>
            {isTeams && p1 && !match.slot1IsBye && (
              <span className="slot-members">{formatTeamMembers(p1, ' / ')}</span>
            )}
          </div>
          <span className="slot-score">
            {isBye
              ? match.winnerId === match.player1Id && match.player1Id
                ? 'ADV'
                : '–'
              : isCompleted || isActive || match.score1 > 0 || match.score2 > 0
              ? match.score1
              : '–'}
          </span>
        </div>

        <div
          className={`bracket-slot ${
            (isCompleted || isBye) && match.winnerId === match.player2Id && match.player2Id
              ? 'is-slot-winner'
              : ''
          } ${
            (isCompleted && match.winnerId !== match.player2Id) || match.slot2IsBye
              ? 'is-slot-loser'
              : ''
          }`}
        >
          <span className="slot-seed">{p2 ? `#${p2.seed}` : '—'}</span>
          <div className="slot-name-wrap">
            <span className="slot-name">
              {match.slot2IsBye ? 'BYE' : p2 ? p2.name : match.source2Label}
            </span>
            {isTeams && p2 && !match.slot2IsBye && (
              <span className="slot-members">{formatTeamMembers(p2, ' / ')}</span>
            )}
          </div>
          <span className="slot-score">
            {isBye
              ? match.winnerId === match.player2Id && match.player2Id
                ? 'ADV'
                : '–'
              : isCompleted || isActive || match.score1 > 0 || match.score2 > 0
              ? match.score2
              : '–'}
          </span>
        </div>
      </Tag>
    );
  };

  // =========================================================================
  // LARGE BRACKET MODE (> 16 Players/Teams): Readable Current Round Focus View
  // =========================================================================
  if (isLargeBracket) {
    const resolvedKey =
      !interactive || selectedRoundKey === 'current' ? currentRoundKey : selectedRoundKey;
    const activeEntry =
      allRoundEntries.find((e) => e.key === resolvedKey) ||
      allRoundEntries.find((e) => e.key === currentRoundKey) ||
      allRoundEntries[0];

    const roundMatches = activeEntry?.matches || [];
    const realMatches = roundMatches.filter((m) => !m.isBye);
    const doneCount = realMatches.filter((m) => m.completed).length;
    const isFinalRound =
      effectiveFilter !== 'losers' &&
      (activeEntry?.key === allRoundEntries[allRoundEntries.length - 1]?.key || Boolean(champion));

    // Choose balanced grid columns for Presentation auto-fit readability
    const totalGridItems = roundMatches.length + (isFinalRound ? 1 : 0);
    const colCount =
      totalGridItems <= 3
        ? Math.max(1, totalGridItems)
        : totalGridItems <= 16
        ? 4
        : totalGridItems <= 32
        ? 6
        : totalGridItems <= 64
        ? 8
        : 10;

    return (
      <div className={`bracket-shell is-round-focus ${noScroll ? 'is-presentation-focus' : ''}`}>
        <div className="round-focus-header">
          <div className="round-focus-title-group">
            <span
              className={`bracket-dot ${
                activeEntry?.bracket === 'losers' ? 'losers-dot' : 'winners-dot'
              }`}
              aria-hidden="true"
            />
            <h3>
              {activeEntry?.label || 'Current Round'}
              {!interactive && <span className="rf-badge">CURRENT ROUND</span>}
            </h3>
            <span className="rf-progress-pill">
              {doneCount} / {realMatches.length} Matches Completed
            </span>
          </div>

          {/* Round Stepper (Interactive selector in Control View, clean progress breadcrumb in Presentation) */}
          <div className="round-stepper-pills">
            {interactive && (
              <button
                type="button"
                className={`rf-pill ${selectedRoundKey === 'current' ? 'is-active' : ''}`}
                onClick={() => handleSelectRoundTab('current')}
              >
                ★ Current
              </button>
            )}
            {allRoundEntries.map((entry) => {
              const isCurrent = entry.key === currentRoundKey;
              const isShown = entry.key === activeEntry?.key;
              const entryReal = entry.matches.filter((m) => !m.isBye);
              const entryAllDone = entryReal.length > 0 && entryReal.every((m) => m.completed);
              if (interactive) {
                return (
                  <button
                    key={entry.key}
                    type="button"
                    className={`rf-pill ${isShown ? 'is-active' : ''} ${
                      entryAllDone ? 'is-done' : ''
                    }`}
                    onClick={() => handleSelectRoundTab(entry.key)}
                  >
                    {entry.label}
                  </button>
                );
              }
              return (
                <span
                  key={entry.key}
                  className={`rf-pill is-static ${isCurrent ? 'is-active' : ''} ${
                    entryAllDone ? 'is-done' : ''
                  }`}
                >
                  {entry.label}
                </span>
              );
            })}
          </div>
        </div>

        <div
          className="round-focus-grid"
          style={
            noScroll
              ? { gridTemplateColumns: `repeat(${colCount}, minmax(218px, 1fr))` }
              : undefined
          }
        >
          {roundMatches.map((m) => renderMatchCard(m))}

          {isFinalRound && (
            <div className={`champion-trophy-card ${champion ? 'is-crowned' : ''}`}>
              <div className="trophy-emblem" aria-hidden="true">
                🏆
              </div>
              <div className="trophy-subtitle">TOURNAMENT CHAMPION</div>
              <div className="trophy-name">{champion ? champion.name : 'Awaiting Final'}</div>
              {champion && isTeams && (
                <div className="trophy-members">{formatTeamMembers(champion, ' & ')}</div>
              )}
              {champion && <div className="trophy-seed">Seed #{champion.seed}</div>}
            </div>
          )}
        </div>
      </div>
    );
  }

  // =========================================================================
  // STANDARD FULL BRACKET TREE (<= 16 Players/Teams)
  // =========================================================================
  const trackClass = noScroll ? 'bracket-fit-track' : 'bracket-scroll-track scroller';
  const showWinnersSection = effectiveFilter !== 'losers';
  const showLosersSection =
    format === 'double' && visibleLosersRounds.length > 0 && effectiveFilter !== 'winners';

  const maxWinnersMatches = winnersRounds.reduce(
    (max, r) => Math.max(max, r.matches.length),
    0
  );
  const maxLosersMatches = visibleLosersRounds.reduce(
    (max, r) => Math.max(max, r.matches.length),
    0
  );
  const lastWinnersTier = computeRoundTier(
    winnersRounds[winnersRounds.length - 1]?.matches.length || 1,
    maxWinnersMatches
  );
  const grandFinalTier =
    maxWinnersMatches > 1 ? Math.min(3, lastWinnersTier + 1) : 0;
  const championTier = format === 'double' && grandFinal ? grandFinalTier : lastWinnersTier;

  return (
    <div className={`bracket-shell ${compact ? 'is-compact' : ''}`}>
      {/* Winners Bracket (+ Grand Final + Champion Trophy) */}
      {showWinnersSection && (
        <div className="bracket-section">
          <div className="bracket-section-title">
            <span className="bracket-dot winners-dot" aria-hidden="true" />
            <h3>
              {format === 'double' && grandFinal
                ? 'Winners Bracket & Grand Final'
                : 'Championship Bracket'}
            </h3>
          </div>

          <div className={trackClass}>
            <div className="bracket-columns">
              {winnersRounds.map((roundObj) => {
                const tier = computeRoundTier(roundObj.matches.length, maxWinnersMatches);
                return (
                  <div
                    key={`w-${roundObj.round}`}
                    className="bracket-round-col"
                    data-round-tier={tier}
                  >
                    <div className="bracket-round-header">{roundObj.label}</div>
                    <div className="bracket-round-matches">
                      {roundObj.matches.map((m) => renderMatchCard(m))}
                    </div>
                  </div>
                );
              })}

              {format === 'double' && grandFinal && (
                <div
                  className="bracket-round-col grand-final-col"
                  data-round-tier={grandFinalTier}
                >
                  <div className="bracket-round-header is-final">Grand Final</div>
                  <div className="bracket-round-matches">{renderMatchCard(grandFinal)}</div>
                </div>
              )}

              {/* Champion Trophy Card */}
              <div
                className="bracket-round-col champion-col"
                data-round-tier={championTier}
              >
                <div className="bracket-round-header is-champion">Champion</div>
                <div className="bracket-round-matches">
                  <div className={`champion-trophy-card ${champion ? 'is-crowned' : ''}`}>
                    <div className="trophy-emblem" aria-hidden="true">
                      🏆
                    </div>
                    <div className="trophy-subtitle">TOURNAMENT CHAMPION</div>
                    <div className="trophy-name">
                      {champion ? champion.name : 'Awaiting Final'}
                    </div>
                    {champion && isTeams && (
                      <div className="trophy-members">{formatTeamMembers(champion, ' & ')}</div>
                    )}
                    {champion && <div className="trophy-seed">Seed #{champion.seed}</div>}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Losers Bracket (Double Elimination only) */}
      {showLosersSection && (
        <div className="bracket-section losers-section">
          <div className="bracket-section-title">
            <span className="bracket-dot losers-dot" aria-hidden="true" />
            <h3>Losers Bracket (Elimination Path)</h3>
          </div>

          <div className={trackClass}>
            <div className="bracket-columns">
              {visibleLosersRounds.map((roundObj) => {
                const tier = computeRoundTier(roundObj.matches.length, maxLosersMatches);
                return (
                  <div
                    key={`l-${roundObj.round}`}
                    className="bracket-round-col"
                    data-round-tier={tier}
                  >
                    <div className="bracket-round-header">{roundObj.label}</div>
                    <div className="bracket-round-matches">
                      {roundObj.matches.map((m) => renderMatchCard(m))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
