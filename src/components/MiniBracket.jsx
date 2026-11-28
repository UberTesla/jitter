import React from 'react';
import { groupBracketRounds, isByeMatch } from '../engine/bracketGenerator.js';
import AutoFitBox from './AutoFitBox.jsx';

const LARGE_BRACKET_THRESHOLD = 16;

function computeRoundTier(matchCount, maxMatches) {
  if (!maxMatches || !matchCount || matchCount >= maxMatches) return 0;
  return Math.min(3, Math.max(1, Math.round(Math.log2(maxMatches / matchCount))));
}

/**
 * Compact Live Mini Bracket for Presentation View
 * - For <= 16 players/teams: renders the full auto-scaled mini tree.
 * - For > 16 players/teams: displays ONLY the current active round in a crisp,
 *   readable multi-column grid so every match stays legible on screen.
 */
export default function MiniBracket({
  matches,
  players,
  format,
  entryMode = 'singles',
  activeMatchId,
  championId,
  showLosers = true,
  title = 'LIVE BRACKET OVERVIEW',
  vertical = false,
  focusActive = false,
}) {
  const isTeams = entryMode === 'teams';
  const isLargeBracket = (players?.length || 0) > LARGE_BRACKET_THRESHOLD;

  const playerMap = React.useMemo(() => {
    const map = new Map();
    for (const p of players || []) map.set(p.id, p);
    return map;
  }, [players]);

  const { winnersRounds, losersRounds, grandFinal } = React.useMemo(
    () => groupBracketRounds(matches || {}),
    [matches]
  );

  const visibleLosers = React.useMemo(
    () =>
      losersRounds
        .map((r) => ({
          ...r,
          matches: r.matches.filter((m) => !(m.isBye && m.winnerIsBye)),
        }))
        .filter((r) => r.matches.length > 0),
    [losersRounds]
  );

  const champion = championId ? playerMap.get(championId) : null;

  // Determine Current Round matches when > 16 players/teams
  const currentRoundData = React.useMemo(() => {
    if (!isLargeBracket) return null;
    const allMatches = Object.values(matches || {}).filter(
      (m) => showLosers || m.bracket !== 'losers'
    );
    const activeMatch = activeMatchId ? matches?.[activeMatchId] : null;
    const usableActive =
      activeMatch && (showLosers || activeMatch.bracket !== 'losers') ? activeMatch : null;

    let targetBracket = usableActive?.bracket || 'winners';
    let targetRound = usableActive?.round || 1;

    if (!usableActive) {
      const firstOpen = allMatches
        .filter((m) => !m.isBye && !m.completed)
        .sort((a, b) => a.round - b.round || a.matchNumber - b.matchNumber)[0];
      if (firstOpen) {
        targetBracket = firstOpen.bracket;
        targetRound = firstOpen.round;
      }
    }

    let roundMatches = allMatches
      .filter(
        (m) =>
          m.bracket === targetBracket &&
          m.round === targetRound &&
          !(m.isBye && m.winnerIsBye)
      )
      .sort((a, b) => a.matchNumber - b.matchNumber);

    if (roundMatches.length === 0) {
      roundMatches = allMatches
        .filter((m) => !m.isBye && !m.completed)
        .slice(0, 12);
    }

    const label = usableActive?.roundLabel || roundMatches[0]?.roundLabel || 'Current Round';
    const realMatches = roundMatches.filter((m) => !m.isBye);
    const done = realMatches.filter((m) => m.completed).length;

    return {
      label,
      matches: roundMatches,
      done,
      total: realMatches.length,
    };
  }, [isLargeBracket, activeMatchId, matches, showLosers]);

  const shortName = (playerId, isBye, fallback) => {
    if (isBye) return 'BYE';
    if (!playerId) return fallback || 'TBD';
    const p = playerMap.get(playerId);
    if (!p) return 'TBD';
    if (isTeams) {
      return `#${p.seed} ${p.name}`;
    }
    const parts = p.name.trim().split(/\s+/);
    const label = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
    return `#${p.seed} ${label}`;
  };

  const renderMiniCard = (m) => {
    if (m.isBye && m.winnerIsBye) {
      return <div key={m.id} className="mb-spacer" aria-hidden="true" />;
    }
    const isBye = isByeMatch(m);
    const isActive = m.id === activeMatchId && !isBye;
    const isCompleted = m.completed && !isBye;
    return (
      <div
        key={m.id}
        className={`mb-card ${isActive ? 'is-active' : ''} ${isCompleted ? 'is-done' : ''} ${
          isBye ? 'is-bye' : ''
        }`}
      >
        <div
          className={`mb-row ${
            (isCompleted || isBye) && m.winnerId === m.player1Id && m.player1Id ? 'is-win' : ''
          }`}
        >
          <span className="mb-name">{shortName(m.player1Id, m.slot1IsBye, 'TBD')}</span>
          <span className="mb-score">
            {isBye
              ? m.winnerId === m.player1Id && m.player1Id
                ? '✓'
                : '–'
              : isCompleted || isActive
              ? m.score1
              : '–'}
          </span>
        </div>
        <div
          className={`mb-row ${
            (isCompleted || isBye) && m.winnerId === m.player2Id && m.player2Id ? 'is-win' : ''
          }`}
        >
          <span className="mb-name">{shortName(m.player2Id, m.slot2IsBye, 'TBD')}</span>
          <span className="mb-score">
            {isBye
              ? m.winnerId === m.player2Id && m.player2Id
                ? '✓'
                : '–'
              : isCompleted || isActive
              ? m.score2
              : '–'}
          </span>
        </div>
      </div>
    );
  };

  const headerTitle =
    isLargeBracket && currentRoundData
      ? `${currentRoundData.label.toUpperCase()} (${currentRoundData.done}/${currentRoundData.total})`
      : title;

  const focusMatchCount = currentRoundData?.matches.length || 0;
  const focusCols =
    focusMatchCount <= 4
      ? Math.max(1, focusMatchCount)
      : focusMatchCount > 16
      ? 6
      : focusMatchCount > 8
      ? 5
      : 4;

  const maxWinnersMatches = winnersRounds.reduce((m, r) => Math.max(m, r.matches.length), 0);
  const maxLosersMatches = visibleLosers.reduce((m, r) => Math.max(m, r.matches.length), 0);
  const lastWinnersTier = computeRoundTier(
    winnersRounds[winnersRounds.length - 1]?.matches.length || 1,
    maxWinnersMatches
  );
  const grandFinalTier = maxWinnersMatches > 1 ? Math.min(3, lastWinnersTier + 1) : 0;
  const championTier = format === 'double' && grandFinal ? grandFinalTier : lastWinnersTier;

  if (vertical) {
    const sections = [];
    for (const r of winnersRounds) {
      sections.push({
        key: `vw-${r.round}`,
        label: r.label,
        labelClass: '',
        matches: r.matches,
      });
    }
    if (showLosers && format === 'double') {
      for (const r of visibleLosers) {
        sections.push({
          key: `vl-${r.round}`,
          label: r.label,
          labelClass: '',
          matches: r.matches,
        });
      }
    }
    if (format === 'double' && grandFinal) {
      sections.push({
        key: 'v-gf',
        label: 'Grand Final',
        labelClass: 'is-gold',
        matches: [grandFinal],
      });
    }
    sections.push({
      key: 'v-champ',
      label: 'Champion',
      labelClass: 'is-emerald',
      isChampion: true,
      matches: [],
    });

    let visibleSections = sections;
    if (focusActive && sections.length > 3) {
      let activeIdx = sections.findIndex((sec) =>
        sec.matches.some((m) => m.id === activeMatchId && !m.isBye)
      );
      if (activeIdx === -1) {
        activeIdx = sections.findIndex((sec) =>
          sec.matches.some((m) => !m.isBye && !m.completed)
        );
      }
      if (activeIdx === -1) {
        activeIdx = champion ? sections.length - 1 : 0;
      }
      const start = Math.max(0, Math.min(sections.length - 3, activeIdx - 1));
      visibleSections = sections.slice(start, start + 3);
    }

    return (
      <section
        className={`mini-bracket-panel is-vertical ${focusActive ? 'is-focused' : ''}`}
        aria-label="Live Mini Bracket"
      >
        <div className="mini-bracket-header">
          <span className="mb-header-dot" aria-hidden="true" />
          <span className="mb-header-title">{title}</span>
          <span className="mb-header-legend">
            <i className="mb-leg-live" /> Live
            <i className="mb-leg-done" /> Final
          </span>
        </div>
        <div className="mb-vertical">
          {visibleSections.map((sec) => {
            let rowMatches = sec.matches;
            if (focusActive && rowMatches.length > 4) {
              const mIdx = rowMatches.findIndex((m) => m.id === activeMatchId);
              const start = mIdx === -1 ? 0 : Math.max(0, Math.min(rowMatches.length - 4, mIdx - 1));
              rowMatches = rowMatches.slice(start, start + 4);
            }
            return (
              <div key={sec.key} className="mb-v-round">
                <div className={`mb-round-lbl ${sec.labelClass}`.trim()}>{sec.label}</div>
                {sec.isChampion ? (
                  <div className={`mb-champ-card ${champion ? 'is-crowned' : ''}`}>
                    <span>🏆</span>
                    <strong>{champion ? champion.name : 'TBD'}</strong>
                  </div>
                ) : (
                  <div className="mb-v-grid">{rowMatches.map(renderMiniCard)}</div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    );
  }
  return (
    <section className="mini-bracket-panel" aria-label="Live Mini Bracket">
      <div className="mini-bracket-header">
        <span className="mb-header-dot" aria-hidden="true" />
        <span className="mb-header-title">{headerTitle}</span>
        <span className="mb-header-legend">
          <i className="mb-leg-live" /> Live
          <i className="mb-leg-done" /> Final
        </span>
      </div>

      <AutoFitBox className="mini-bracket-fit-area" align="left" fillWidth={true}>
        {isLargeBracket && currentRoundData ? (
          <div
            className="mb-round-focus-grid"
            style={{ gridTemplateColumns: `repeat(${focusCols}, minmax(172px, 1fr))` }}
          >
            {currentRoundData.matches.map(renderMiniCard)}
          </div>
        ) : (
          <div className="mb-trees">
            <div className="mb-row-tree">
              {winnersRounds.map((r) => {
                const tier = computeRoundTier(r.matches.length, maxWinnersMatches);
                return (
                  <div key={`mw-${r.round}`} className="mb-round" data-round-tier={tier}>
                    <div className="mb-round-lbl">{r.label}</div>
                    <div className="mb-round-col">{r.matches.map(renderMiniCard)}</div>
                  </div>
                );
              })}

              {format === 'double' && grandFinal && (
                <div className="mb-round" data-round-tier={grandFinalTier}>
                  <div className="mb-round-lbl is-gold">Grand Final</div>
                  <div className="mb-round-col">{renderMiniCard(grandFinal)}</div>
                </div>
              )}

              <div className="mb-round" data-round-tier={championTier}>
                <div className="mb-round-lbl is-emerald">Champion</div>
                <div className="mb-round-col">
                  <div className={`mb-champ-card ${champion ? 'is-crowned' : ''}`}>
                    <span>🏆</span>
                    <strong>{champion ? champion.name : 'TBD'}</strong>
                  </div>
                </div>
              </div>
            </div>

            {showLosers && format === 'double' && visibleLosers.length > 0 && (
              <div className="mb-row-tree is-losers">
                {visibleLosers.map((r) => {
                  const tier = computeRoundTier(r.matches.length, maxLosersMatches);
                  return (
                    <div key={`ml-${r.round}`} className="mb-round" data-round-tier={tier}>
                      <div className="mb-round-lbl">{r.label}</div>
                      <div className="mb-round-col">{r.matches.map(renderMiniCard)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </AutoFitBox>
    </section>
  );
}
