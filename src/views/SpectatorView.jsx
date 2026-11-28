import React, { useEffect, useMemo, useState } from 'react';
import {
  ROLE_META,
  getTableSlots,
  tournamentStore,
} from '../state/tournamentStore.js';
import {
  evaluateMatchState,
  MATCH_STATUS,
  formatMatchTimer,
  computeMatchElapsedMs,
} from '../engine/scoringEngine.js';
import {
  computeTournamentStats,
  formatTeamMembers,
  formatTeamMembersShort,
  resolveClaimedPlayer,
} from '../engine/bracketGenerator.js';
import { renderLiveMessageText } from '../engine/grandmaVariables.js';
import { trackUsageEvent } from '../engine/usageAnalytics.js';
import ViewNavBar from '../components/ViewNavBar.jsx';
import BracketView from '../components/BracketView.jsx';
import MatchTimer from '../components/MatchTimer.jsx';
import TournamentStatsPanel from '../components/TournamentStatsPanel.jsx';
import RetroTVCorner from '../components/RetroTVCorner.jsx';

/**
 * Native Mobile-First Spectator Companion (/spectator)
 * - Live Match Hero Card (with multi-table switcher if multiple tables are live)
 * - Personal Status Banner when the user has claimed a player
 * - Active Sticky Announcement Banner
 * - 3 Native Tabs: Live & Queue | Bracket | Leaders & Roster
 * - One-click Request Scorekeeper for guests + quick link to TV Presentation View
 */
export default function SpectatorView({
  state,
  effectiveRole = 'spectator',
  rolePerms = null,
  myDeviceId = '',
  onNavigateMode,
  onOpenTournamentChooser,
}) {
  const [activeTab, setActiveTab] = useState('live');
  const [selectedTableMatchId, setSelectedTableMatchId] = useState(null);
  const [bracketFilter, setBracketFilter] = useState('both');
  const [feedback, setFeedback] = useState('');
  const [accessDeniedMsg, setAccessDeniedMsg] = useState('');
  const [bannerTick, setBannerTick] = useState(0);
  const [grandmaTick, setGrandmaTick] = useState(0);

  const isTeams = state.entryMode === 'teams';
  const grandmaEnabled = state.rules?.grandmaEnabled !== false;
  const canScoreRole = rolePerms
    ? Boolean(rolePerms.canScore)
    : effectiveRole !== 'spectator' && effectiveRole !== 'presenter';
  const roleMeta = ROLE_META[effectiveRole] || ROLE_META.spectator;
  const pendingRequestsCount =
    (state.scorekeeperRequests?.length || 0) + (state.joinRequests?.length || 0);
  const hasPendingRequest = Boolean(
    myDeviceId &&
      (state.scorekeeperRequests || []).some((r) => r && r.deviceId === myDeviceId)
  );

  // Listen for real-time Scorekeeper request approval / denial notices
  useEffect(() => {
    const checkNotice = (meta) => {
      const notice = meta?.remoteSync?.scorekeeperResolutionNotice;
      if (!notice) return;
      tournamentStore.clearScorekeeperResolutionNotice();
      if (!notice.approved) {
        setAccessDeniedMsg(
          notice.message || 'Access Denied — your request for Scorekeeper access was denied.'
        );
      } else {
        setAccessDeniedMsg('');
      }
    };
    checkNotice(tournamentStore.getSyncMeta());
    return tournamentStore.subscribe((_s, nextMeta) => checkNotice(nextMeta));
  }, []);

  // Tick once per second while an active announcement banner is shown (supports live $countdown)
  const activeBanner = state.presentation?.activeBanner || null;
  useEffect(() => {
    if (!activeBanner || !activeBanner.text) return undefined;
    const id = setInterval(() => setBannerTick((n) => (n + 1) % 100000), 1000);
    return () => clearInterval(id);
  }, [activeBanner]);

  const bannerText = useMemo(() => {
    if (!activeBanner?.text) return '';
    return renderLiveMessageText(activeBanner, tournamentStore.getServerNow());
  }, [activeBanner, bannerTick]);

  // Sync live Grandma speech expiry so the commentary card appears while Grandma is speaking
  const activeGrandmaSpeech = state.grandma?.activeSpeech || null;
  useEffect(() => {
    if (!grandmaEnabled || !activeGrandmaSpeech?.text) return undefined;
    const now = tournamentStore.getServerNow();
    const expiresAt = Number(activeGrandmaSpeech.expiresAt) || 0;
    const remaining = expiresAt - now;
    if (remaining <= 0) return undefined;
    const id = setTimeout(() => setGrandmaTick((n) => (n + 1) % 100000), remaining + 120);
    return () => clearTimeout(id);
  }, [grandmaEnabled, activeGrandmaSpeech?.id, activeGrandmaSpeech?.expiresAt]);

  const liveGrandmaQuote = useMemo(() => {
    if (!grandmaEnabled || !activeGrandmaSpeech?.text) return null;
    const now = tournamentStore.getServerNow();
    const expiresAt = Number(activeGrandmaSpeech.expiresAt) || 0;
    if (expiresAt > 0 && expiresAt <= now) return null;
    return activeGrandmaSpeech;
  }, [grandmaEnabled, activeGrandmaSpeech, grandmaTick]);

  const playerMap = useMemo(() => {
    const map = new Map();
    for (const p of state.players || []) map.set(p.id, p);
    return map;
  }, [state.players]);

  const claimedPlayerObj = useMemo(
    () => resolveClaimedPlayer(state, myDeviceId ? state.playerClaims?.[myDeviceId] : null),
    [state, myDeviceId]
  );
  const claimedEntrantId = claimedPlayerObj?.teamId || null;

  const stats = useMemo(() => computeTournamentStats(state), [state]);

  const allMatches = useMemo(() => Object.values(state.matches || {}), [state.matches]);

  // Identify live/featured matches and upcoming queue
  const { liveMatches, featuredMatch, onDeckQueue, recentResults } = useMemo(() => {
    const matches = allMatches.filter((m) => m && !m.isBye);
    const sortUpcoming = (a, b) => {
      if (a.bracket === 'final') return 1;
      if (b.bracket === 'final') return -1;
      if (a.round !== b.round) return a.round - b.round;
      return (a.matchNumber || 0) - (b.matchNumber || 0);
    };
    const activeMatch =
      matches.find((m) => m.id === state.activeMatchId && !m.completed && m.player1Id && m.player2Id) ||
      null;

    // One canonical match per table (live -> paused -> queued), preventing duplicate T1/T2 pills
    const liveList = getTableSlots(state)
      .map((slot) => slot.match)
      .filter(Boolean);

    // Determine which match is featured in the Hero Card
    let hero = null;
    if (selectedTableMatchId && liveList.some((m) => m.id === selectedTableMatchId)) {
      hero = liveList.find((m) => m.id === selectedTableMatchId);
    } else if (activeMatch && liveList.some((m) => m.id === activeMatch.id)) {
      hero = activeMatch;
    } else if (liveList.length > 0) {
      hero = liveList[0];
    } else {
      // Fallback: first ready uncompleted match
      hero =
        matches.filter((m) => !m.completed && m.player1Id && m.player2Id).sort(sortUpcoming)[0] ||
        null;
    }

    // On Deck Queue: ready uncompleted matches not currently started (and not the hero)
    const liveIds = new Set(liveList.map((m) => m.id));
    if (hero) liveIds.add(hero.id);
    const queue = matches
      .filter((m) => !m.completed && !m.started && m.player1Id && m.player2Id && !liveIds.has(m.id))
      .sort(sortUpcoming);

    // Recent completed matches (most recent first)
    const completed = matches
      .filter((m) => m.completed && m.player1Id && m.player2Id)
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
      .slice(0, 12);

    return {
      liveMatches: liveList,
      featuredMatch: hero,
      onDeckQueue: queue,
      recentResults: completed,
    };
  }, [state, allMatches, state.activeMatchId, selectedTableMatchId]);

  // Compute personal status for the claimed player
  const myStatus = useMemo(() => {
    if (!claimedEntrantId || !claimedPlayerObj) return null;
    const team = playerMap.get(claimedEntrantId);
    const myDisplayName = claimedPlayerObj.memberName
      ? `${claimedPlayerObj.memberName} (${team?.name || ''})`
      : team?.name || claimedPlayerObj.displayName;

    if (state.championId && state.championId === claimedEntrantId) {
      return {
        tone: 'champion',
        icon: '🏆',
        title: "YOU'RE THE CHAMPION!",
        detail: `${myDisplayName} won the tournament!`,
      };
    }

    const myLive = allMatches.find(
      (m) =>
        m &&
        !m.isBye &&
        !m.completed &&
        (m.started || m.id === state.activeMatchId) &&
        (m.player1Id === claimedEntrantId || m.player2Id === claimedEntrantId)
    );
    if (myLive) {
      const oppId = myLive.player1Id === claimedEntrantId ? myLive.player2Id : myLive.player1Id;
      const oppName = playerMap.get(oppId)?.name || 'TBD';
      const tableNum = myLive.tableNumber || 1;
      return {
        tone: 'live',
        icon: '🏓',
        title: myLive.started ? "YOU'RE PLAYING NOW!" : "YOU'RE UP ON TABLE!",
        detail: `${myLive.label} · Table ${tableNum} vs ${oppName}`,
        matchId: myLive.id,
      };
    }

    const queueIdx = onDeckQueue.findIndex(
      (m) => m.player1Id === claimedEntrantId || m.player2Id === claimedEntrantId
    );
    if (queueIdx >= 0) {
      const qm = onDeckQueue[queueIdx];
      const oppId = qm.player1Id === claimedEntrantId ? qm.player2Id : qm.player1Id;
      const oppName = playerMap.get(oppId)?.name || 'TBD';
      return {
        tone: queueIdx === 0 ? 'next' : 'queued',
        icon: '⏳',
        title: queueIdx === 0 ? "YOU'RE UP NEXT!" : `#${queueIdx + 1} IN ON DECK QUEUE`,
        detail: `${qm.label} vs ${oppName}`,
      };
    }

    const hasPendingSlot = allMatches.some(
      (m) =>
        m &&
        !m.isBye &&
        !m.completed &&
        (m.player1Id === claimedEntrantId || m.player2Id === claimedEntrantId)
    );
    if (hasPendingSlot) {
      return {
        tone: 'waiting',
        icon: '🎯',
        title: 'STILL IN THE BRACKET',
        detail: `${myDisplayName} — waiting for your next opponent`,
      };
    }

    const hasPlayed = allMatches.some(
      (m) =>
        m &&
        !m.isBye &&
        m.completed &&
        (m.player1Id === claimedEntrantId || m.player2Id === claimedEntrantId)
    );
    if (hasPlayed) {
      return {
        tone: 'done',
        icon: '👏',
        title: 'GREAT RUN!',
        detail: `${myDisplayName} — eliminated from the bracket`,
      };
    }

    return {
      tone: 'waiting',
      icon: '🏓',
      title: 'REGISTERED',
      detail: `${myDisplayName} — awaiting tournament start`,
    };
  }, [claimedEntrantId, claimedPlayerObj, playerMap, state.championId, allMatches, state.activeMatchId, onDeckQueue]);

  // Compute roster rows with live status badges
  const rosterRows = useMemo(() => {
    const recordMap = new Map();
    for (const row of stats.leaderboard || []) {
      recordMap.set(row.playerId, row);
    }
    const liveIds = new Set();
    const onDeckIds = new Set();
    const activeBracketIds = new Set();
    for (const m of allMatches) {
      if (!m || m.isBye || m.completed) continue;
      if (m.player1Id) activeBracketIds.add(m.player1Id);
      if (m.player2Id) activeBracketIds.add(m.player2Id);
      if (m.started || m.id === state.activeMatchId) {
        if (m.player1Id) liveIds.add(m.player1Id);
        if (m.player2Id) liveIds.add(m.player2Id);
      } else if (m.player1Id && m.player2Id) {
        onDeckIds.add(m.player1Id);
        onDeckIds.add(m.player2Id);
      }
    }

    return [...(state.players || [])]
      .sort((a, b) => (a.seed || 999) - (b.seed || 999))
      .map((p) => {
        const rec = recordMap.get(p.id);
        let statusLabel = 'Waiting';
        let statusTone = 'muted';
        if (state.championId === p.id) {
          statusLabel = '🏆 Champ';
          statusTone = 'champion';
        } else if (liveIds.has(p.id)) {
          statusLabel = '🏓 Playing';
          statusTone = 'live';
        } else if (onDeckIds.has(p.id)) {
          statusLabel = '⏳ On Deck';
          statusTone = 'next';
        } else if (activeBracketIds.has(p.id)) {
          statusLabel = 'Active';
          statusTone = 'active';
        } else if (rec && (rec.wins > 0 || rec.losses > 0)) {
          statusLabel = 'Out';
          statusTone = 'out';
        }
        return {
          ...p,
          wins: rec?.wins || 0,
          losses: rec?.losses || 0,
          pointDiff: rec?.pointDiff || 0,
          statusLabel,
          statusTone,
          isMine: claimedEntrantId === p.id,
        };
      });
  }, [state.players, allMatches, state.activeMatchId, state.championId, stats.leaderboard, claimedEntrantId]);

  const flashFeedback = (msg) => {
    setFeedback(msg);
    setTimeout(() => {
      setFeedback((curr) => (curr === msg ? '' : curr));
    }, 3000);
  };

  const handleRequestScorekeeper = async () => {
    setAccessDeniedMsg('');
    const res = await tournamentStore.requestScorekeeperAccess();
    if (res.ok && res.approved) {
      flashFeedback('You are now a Scorekeeper! Opening Scorekeeper view...');
      onNavigateMode?.('scorekeeper');
    } else if (res.ok && res.pending) {
      flashFeedback('Scorekeeper request sent — waiting for Host, Admin, or Moderator approval');
    } else {
      flashFeedback(res.error || 'Could not request Scorekeeper access');
    }
  };

  const handleSelectTab = (tabId) => {
    setActiveTab(tabId);
    trackUsageEvent('spectator:tab_change', { category: 'spectator', tab: tabId });
  };

  const handleSelectTable = (matchId) => {
    setSelectedTableMatchId(matchId);
    trackUsageEvent('spectator:switch_table', { category: 'spectator', matchId });
  };

  const heroEval = useMemo(
    () => (featuredMatch ? evaluateMatchState(featuredMatch, state.rules) : null),
    [featuredMatch, state.rules]
  );

  const championPlayer = state.championId ? playerMap.get(state.championId) : null;
  const finalMatch = useMemo(() => {
    if (!state.championId) return null;
    const completed = allMatches.filter(
      (m) => m && m.completed && !m.isBye && m.winnerId === state.championId
    );
    completed.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    return completed[0] || null;
  }, [state.championId, allMatches]);

  const heroP1 = featuredMatch ? playerMap.get(featuredMatch.player1Id) : null;
  const heroP2 = featuredMatch ? playerMap.get(featuredMatch.player2Id) : null;

  const getHeroStatusBadge = () => {
    if (!featuredMatch || !heroEval) return { text: 'READY', tone: 'ready' };
    if (heroEval.status === MATCH_STATUS.WINNER) return { text: 'FINAL', tone: 'final' };
    if (!featuredMatch.started) return { text: 'READY ON TABLE', tone: 'ready' };
    if (heroEval.isSkunkPoint) return { text: '🦨 SKUNK POINT', tone: 'alert' };
    if (heroEval.status === MATCH_STATUS.GAME_POINT) return { text: '⚡ GAME POINT', tone: 'alert' };
    if (heroEval.isInDeuceZone) return { text: '🔥 DEUCE', tone: 'deuce' };
    return { text: '● LIVE', tone: 'live' };
  };

  const heroBadge = getHeroStatusBadge();

  return (
    <div className="spectator-shell" data-theme={state.ui?.theme || 'arena'}>
      <header className="spectator-topbar" aria-label="Spectator Navigation">
        <ViewNavBar
          activeMode="spectator"
          rolePerms={rolePerms}
          pendingRequestsCount={pendingRequestsCount}
          onNavigateMode={onNavigateMode}
          onOpenTournamentChooser={onOpenTournamentChooser}
        />

        <div className="spectator-submenu" role="toolbar" aria-label="Tournament Info and Actions">
          <div className="spectator-title-block">
            <span className="spectator-title-name">
              {state.tournamentName || 'Jitter Tournament'}
            </span>
            {state.tournamentSubtitle && (
              <>
                <span className="spectator-title-dot" aria-hidden="true">·</span>
                <span className="spectator-title-sub">{state.tournamentSubtitle}</span>
              </>
            )}
          </div>

          <div className="spectator-submenu-actions">
            {!canScoreRole &&
              (hasPendingRequest ? (
                <button
                  type="button"
                  className="btn-secondary btn-sm spectator-pending-btn"
                  disabled
                >
                  ⏳ Requested
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-amber btn-sm"
                  onClick={handleRequestScorekeeper}
                >
                  🙋 Request Scorekeeper
                </button>
              ))}

            <span className="spectator-role-pill">
              {effectiveRole === 'spectator'
                ? '👁️ SPECTATOR'
                : `${roleMeta.icon} ${roleMeta.label.toUpperCase()}`}
            </span>
          </div>
        </div>

        {/* Sticky Live Grandma Commentary Banner (pinned to top for its duration, zero layout shift) */}
        {liveGrandmaQuote && (
          <div className="spec-grandma-sticky-slot" role="status" aria-live="polite">
            <div className="spec-grandma-card">
              <div className="spec-grandma-avatar" aria-hidden="true">👵</div>
              <div className="spec-grandma-body">
                <span className="spec-grandma-label">GRANDMA SAYS</span>
                <p className="spec-grandma-quote">“{liveGrandmaQuote.text}”</p>
              </div>
            </div>
          </div>
        )}
      </header>

      {accessDeniedMsg && (
        <div className="spectator-denied-banner" role="alert">
          <span>
            <strong>🚫 Access Denied:</strong>{' '}
            {accessDeniedMsg.replace(/^Access denied\s*[—:-]?\s*/i, '')}
          </span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => setAccessDeniedMsg('')}
            aria-label="Dismiss access denied alert"
          >
            ✕
          </button>
        </div>
      )}

      {feedback && (
        <div className="spectator-toast" role="status" aria-live="polite">
          {feedback}
        </div>
      )}

      <main className="spectator-body">
        <div className="spectator-container">
          {/* Sticky Host Announcement Banner */}
          {bannerText && (
            <div className="spec-announcement" role="status" aria-live="polite">
              <span className="spec-announcement-icon" aria-hidden="true">📢</span>
              <span className="spec-announcement-text">{bannerText}</span>
            </div>
          )}

          {/* Personal Status Banner when user claimed a player */}
          {myStatus && (
            <div className={`spec-my-status is-${myStatus.tone}`}>
              <span className="spec-my-status-icon" aria-hidden="true">{myStatus.icon}</span>
              <div className="spec-my-status-copy">
                <strong className="spec-my-status-title">{myStatus.title}</strong>
                <span className="spec-my-status-detail">{myStatus.detail}</span>
              </div>
              {myStatus.matchId && featuredMatch?.id !== myStatus.matchId && (
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => handleSelectTable(myStatus.matchId)}
                >
                  Watch
                </button>
              )}
            </div>
          )}

          {/* Hero Section: Champion Celebration OR Live Match Scoreboard OR Waiting */}
          {championPlayer ? (
            <section className="spec-hero-card is-champion" aria-label="Tournament Champion">
              <div className="spec-champ-crown" aria-hidden="true">🏆</div>
              <div className="spec-champ-eyebrow">TOURNAMENT CHAMPION</div>
              <h1 className="spec-champ-name">{championPlayer.name}</h1>
              {isTeams && championPlayer.members?.length > 0 && (
                <div className="spec-champ-members">
                  {formatTeamMembers(championPlayer)}
                </div>
              )}
              {finalMatch && (
                <div className="spec-champ-final">
                  Final: {playerMap.get(finalMatch.player1Id)?.name || 'P1'}{' '}
                  <strong>
                    {finalMatch.score1}–{finalMatch.score2}
                  </strong>{' '}
                  {playerMap.get(finalMatch.player2Id)?.name || 'P2'}
                </div>
              )}
              <div className="spec-hero-footer">
                <span>
                  {stats.completedCount} matches · {stats.totalPointsPlayed} total points
                </span>
                <button
                  type="button"
                  className="spec-tv-link"
                  onClick={() => onNavigateMode?.('present')}
                >
                  📺 TV Display
                </button>
              </div>
            </section>
          ) : featuredMatch ? (
            <section className="spec-hero-card" aria-label="Live Match Scoreboard">
              {/* Multi-table switcher if more than 1 match is live */}
              {liveMatches.length > 1 && (
                <div className="spec-table-switcher" role="tablist" aria-label="Live Tables">
                  {liveMatches.map((lm) => {
                    const p1 = playerMap.get(lm.player1Id);
                    const p2 = playerMap.get(lm.player2Id);
                    const isSelected = lm.id === featuredMatch.id;
                    return (
                      <button
                        key={lm.id}
                        type="button"
                        role="tab"
                        aria-selected={isSelected}
                        className={`spec-table-pill ${isSelected ? 'is-active' : ''}`}
                        onClick={() => handleSelectTable(lm.id)}
                      >
                        <span className="spec-table-pill-num">T{lm.tableNumber || 1}</span>
                        <span className="spec-table-pill-names">
                          {p1?.name || 'TBD'} {lm.score1}–{lm.score2} {p2?.name || 'TBD'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="spec-hero-head">
                <div className="spec-hero-meta">
                  <span className="spec-match-code">{featuredMatch.label}</span>
                  <span className="spec-table-tag">TABLE {featuredMatch.tableNumber || 1}</span>
                </div>
                <div className="spec-hero-status-group">
                  <span className={`spec-status-pill is-${heroBadge.tone}`}>
                    {heroBadge.text}
                  </span>
                  <MatchTimer match={featuredMatch} />
                </div>
              </div>

              <div className="spec-hero-board">
                {/* Side 1 */}
                <div
                  className={`spec-side-card is-p1 ${
                    featuredMatch.started &&
                    heroEval?.activeServer === 1 &&
                    heroEval?.status !== MATCH_STATUS.WINNER
                      ? 'is-serving'
                      : ''
                  } ${heroEval?.winnerSlot === 1 ? 'is-winner' : ''} ${
                    claimedEntrantId && featuredMatch.player1Id === claimedEntrantId ? 'is-mine' : ''
                  }`}
                >
                  <div className="spec-side-top">
                    <span className="spec-seed">#{heroP1?.seed || 1}</span>
                    {claimedEntrantId && featuredMatch.player1Id === claimedEntrantId && (
                      <span className="spec-you-tag">YOU</span>
                    )}
                    {featuredMatch.started &&
                      heroEval?.activeServer === 1 &&
                      heroEval?.status !== MATCH_STATUS.WINNER && (
                        <span className="spec-serve-badge">● SERVING</span>
                      )}
                  </div>
                  <div className="spec-side-name">{heroP1?.name || 'TBD'}</div>
                  {isTeams && heroP1?.members?.length > 0 && (
                    <div className="spec-side-members">
                      {heroP1.members.map((m, idx) => {
                        const isActiveServer =
                          featuredMatch.started &&
                          heroEval?.activeServer === 1 &&
                          heroEval?.status !== MATCH_STATUS.WINNER &&
                          heroEval?.activeServerMemberIndex === idx;
                        return (
                          <span
                            key={`${m}-${idx}`}
                            className={isActiveServer ? 'is-active-server' : ''}
                          >
                            {idx > 0 ? ' · ' : ''}
                            {m}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div className="spec-side-score">
                    {String(featuredMatch.score1 ?? 0).padStart(2, '0')}
                  </div>
                </div>

                {/* Side 2 */}
                <div
                  className={`spec-side-card is-p2 ${
                    featuredMatch.started &&
                    heroEval?.activeServer === 2 &&
                    heroEval?.status !== MATCH_STATUS.WINNER
                      ? 'is-serving'
                      : ''
                  } ${heroEval?.winnerSlot === 2 ? 'is-winner' : ''} ${
                    claimedEntrantId && featuredMatch.player2Id === claimedEntrantId ? 'is-mine' : ''
                  }`}
                >
                  <div className="spec-side-top">
                    <span className="spec-seed">#{heroP2?.seed || 2}</span>
                    {claimedEntrantId && featuredMatch.player2Id === claimedEntrantId && (
                      <span className="spec-you-tag">YOU</span>
                    )}
                    {featuredMatch.started &&
                      heroEval?.activeServer === 2 &&
                      heroEval?.status !== MATCH_STATUS.WINNER && (
                        <span className="spec-serve-badge">● SERVING</span>
                      )}
                  </div>
                  <div className="spec-side-name">{heroP2?.name || 'TBD'}</div>
                  {isTeams && heroP2?.members?.length > 0 && (
                    <div className="spec-side-members">
                      {heroP2.members.map((m, idx) => {
                        const isActiveServer =
                          featuredMatch.started &&
                          heroEval?.activeServer === 2 &&
                          heroEval?.status !== MATCH_STATUS.WINNER &&
                          heroEval?.activeServerMemberIndex === idx;
                        return (
                          <span
                            key={`${m}-${idx}`}
                            className={isActiveServer ? 'is-active-server' : ''}
                          >
                            {idx > 0 ? ' · ' : ''}
                            {m}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div className="spec-side-score">
                    {String(featuredMatch.score2 ?? 0).padStart(2, '0')}
                  </div>
                </div>
              </div>

              <div className="spec-hero-footer">
                <span>
                  Play to {state.rules?.targetPoints ?? 11} · Win by {state.rules?.winBy ?? 2} ·
                  Serve every {state.rules?.serveRotation ?? 2}
                </span>
                <button
                  type="button"
                  className="spec-tv-link"
                  onClick={() => onNavigateMode?.('present')}
                >
                  📺 TV Display
                </button>
              </div>
            </section>
          ) : (
            <section className="spec-hero-card is-waiting" aria-label="Tournament Waiting">
              <div className="spec-waiting-icon" aria-hidden="true">🏓</div>
              <h1 className="spec-waiting-title">
                {state.tournamentName || 'Jitter Tournament'}
              </h1>
              <p className="spec-waiting-sub">
                {(state.players || []).length} {isTeams ? 'Teams' : 'Players'} ·{' '}
                {state.format === 'double' ? 'Double Elimination' : 'Single Elimination'} ·
                Play to {state.rules?.targetPoints ?? 11}
              </p>
              <div className="spec-hero-footer">
                <span>Waiting for the first match to begin</span>
                <button
                  type="button"
                  className="spec-tv-link"
                  onClick={() => onNavigateMode?.('present')}
                >
                  📺 TV Display
                </button>
              </div>
            </section>
          )}

          {/* 3 Native Section Tabs */}
          <nav className="spec-tabs" role="tablist" aria-label="Spectator Sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'live'}
              className={`spec-tab-btn ${activeTab === 'live' ? 'is-active' : ''}`}
              onClick={() => handleSelectTab('live')}
            >
              <span>🔴 Live &amp; Queue</span>
              {onDeckQueue.length > 0 && (
                <span className="spec-tab-count">{onDeckQueue.length}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'bracket'}
              className={`spec-tab-btn ${activeTab === 'bracket' ? 'is-active' : ''}`}
              onClick={() => handleSelectTab('bracket')}
            >
              <span>🏆 Bracket</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'stats'}
              className={`spec-tab-btn ${activeTab === 'stats' ? 'is-active' : ''}`}
              onClick={() => handleSelectTab('stats')}
            >
              <span>📊 Leaders &amp; Roster</span>
            </button>
          </nav>

          {/* TAB 1: LIVE & QUEUE */}
          {activeTab === 'live' && (
            <div className="spec-tab-panel" role="tabpanel">
              {/* On Deck Queue */}
              <section className="spec-section">
                <div className="spec-section-head">
                  <h2>⏳ On Deck Queue</h2>
                  <span className="spec-section-meta">
                    {onDeckQueue.length} upcoming
                  </span>
                </div>

                {onDeckQueue.length === 0 ? (
                  <div className="spec-empty-card">
                    No matches currently queued on deck.
                  </div>
                ) : (
                  <div className="spec-queue-list">
                    {onDeckQueue.map((m, idx) => {
                      const p1 = playerMap.get(m.player1Id);
                      const p2 = playerMap.get(m.player2Id);
                      const p1Sub = isTeams ? formatTeamMembersShort(p1, ' & ') : '';
                      const p2Sub = isTeams ? formatTeamMembersShort(p2, ' & ') : '';
                      const isMine =
                        Boolean(claimedEntrantId) &&
                        (m.player1Id === claimedEntrantId || m.player2Id === claimedEntrantId);
                      return (
                        <div
                          key={m.id}
                          className={`spec-queue-card ${idx === 0 ? 'is-next' : ''} ${
                            isMine ? 'is-mine' : ''
                          }`}
                        >
                          <div className="spec-queue-meta">
                            <span className={`spec-queue-order ${idx === 0 ? 'is-next' : ''}`}>
                              {idx === 0 ? 'UP NEXT' : `#${idx + 1}`}
                            </span>
                            <span className="spec-queue-label">{m.label}</span>
                            {isMine && <span className="spec-you-tag">YOU</span>}
                          </div>

                          <div className="spec-queue-matchup">
                            <div className="spec-qm-side is-left">
                              <span className="spec-qm-name">{p1?.name || 'TBD'}</span>
                              {p1Sub && <span className="spec-qm-sub">{p1Sub}</span>}
                            </div>
                            <span className="spec-qm-vs">vs</span>
                            <div className="spec-qm-side is-right">
                              <span className="spec-qm-name">{p2?.name || 'TBD'}</span>
                              {p2Sub && <span className="spec-qm-sub">{p2Sub}</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Recent Results */}
              <section className="spec-section">
                <div className="spec-section-head">
                  <h2>✅ Recent Results</h2>
                  <span className="spec-section-meta">
                    {stats.completedCount} / {stats.totalMatches} done
                  </span>
                </div>

                {recentResults.length === 0 ? (
                  <div className="spec-empty-card">
                    Completed match results will appear here as games finish.
                  </div>
                ) : (
                  <div className="spec-results-list">
                    {recentResults.map((m) => {
                      const p1 = playerMap.get(m.player1Id);
                      const p2 = playerMap.get(m.player2Id);
                      const p1Won = m.winnerId === m.player1Id;
                      const p2Won = m.winnerId === m.player2Id;
                      const elapsed = computeMatchElapsedMs(m);
                      return (
                        <div key={m.id} className="spec-result-card">
                          <div className="spec-result-head">
                            <span className="spec-result-label">{m.label}</span>
                            {elapsed > 0 && (
                              <span className="spec-result-time">
                                {formatMatchTimer(elapsed)}
                              </span>
                            )}
                          </div>
                          <div className="spec-result-row">
                            <span className={`spec-result-name is-left ${p1Won ? 'is-winner' : ''}`}>
                              {p1Won && <span aria-hidden="true">🏆 </span>}
                              {p1?.name || 'TBD'}
                            </span>
                            <span className="spec-result-score">
                              <strong className={p1Won ? 'is-winner' : ''}>{m.score1}</strong>
                              <span className="spec-result-dash">–</span>
                              <strong className={p2Won ? 'is-winner' : ''}>{m.score2}</strong>
                            </span>
                            <span className={`spec-result-name is-right ${p2Won ? 'is-winner' : ''}`}>
                              {p2?.name || 'TBD'}
                              {p2Won && <span aria-hidden="true"> 🏆</span>}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* TAB 2: BRACKET */}
          {activeTab === 'bracket' && (
            <div className="spec-tab-panel" role="tabpanel">
              <section className="spec-section">
                <div className="spec-section-head">
                  <h2>🏆 Tournament Bracket</h2>
                  {state.format === 'double' && (
                    <div className="spec-bracket-filters" role="group" aria-label="Bracket Filter">
                      {[
                        { id: 'both', label: 'All' },
                        { id: 'winners', label: 'Winners' },
                        { id: 'losers', label: 'Losers' },
                      ].map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          className={`spec-filter-btn ${bracketFilter === f.id ? 'is-active' : ''}`}
                          onClick={() => setBracketFilter(f.id)}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="spec-bracket-scroll">
                  <BracketView
                    matches={state.matches}
                    players={state.players}
                    format={state.format}
                    entryMode={state.entryMode}
                    activeMatchId={state.activeMatchId}
                    championId={state.championId}
                    interactive={false}
                    bracketFilter={bracketFilter}
                  />
                </div>
              </section>
            </div>
          )}

          {/* TAB 3: LEADERS & ROSTER */}
          {activeTab === 'stats' && (
            <div className="spec-tab-panel" role="tabpanel">
              {/* Tournament Progress */}
              <section className="spec-section">
                <div className="spec-progress-card">
                  <div className="spec-progress-head">
                    <span>TOURNAMENT PROGRESS</span>
                    <strong>
                      {stats.completedCount} / {stats.totalMatches} Matches ({stats.progressPct}%)
                    </strong>
                  </div>
                  <div className="spec-progress-bar" role="progressbar" aria-valuenow={stats.progressPct} aria-valuemin={0} aria-valuemax={100}>
                    <div
                      className="spec-progress-fill"
                      style={{ width: `${Math.min(100, Math.max(0, stats.progressPct))}%` }}
                    />
                  </div>
                  <div className="spec-mini-stats">
                    <div className="spec-mini-stat">
                      <span>TOTAL PTS</span>
                      <strong>{stats.totalPointsPlayed}</strong>
                    </div>
                    <div className="spec-mini-stat">
                      <span>AVG PTS/GAME</span>
                      <strong>{stats.avgPointsPerMatch || '—'}</strong>
                    </div>
                    <div className="spec-mini-stat">
                      <span>DEUCES</span>
                      <strong>{stats.deuceMatchesCount}</strong>
                    </div>
                    <div className="spec-mini-stat">
                      <span>REMAINING</span>
                      <strong>{stats.remainingCount}</strong>
                    </div>
                  </div>
                </div>
              </section>

              {/* Leaderboard & Highlights */}
              <section className="spec-section spec-stats-wrap">
                <TournamentStatsPanel
                  stats={stats}
                  playerMap={playerMap}
                  isTeams={isTeams}
                  rules={state.rules}
                  variant="full"
                  leaderCount={8}
                  extras={false}
                />
              </section>

              {/* Full Roster */}
              <section className="spec-section">
                <div className="spec-section-head">
                  <h2>👥 {isTeams ? 'Teams' : 'Players'} Roster</h2>
                  <span className="spec-section-meta">{rosterRows.length} total</span>
                </div>

                <div className="spec-roster-list">
                  {rosterRows.map((p) => (
                    <div
                      key={p.id}
                      className={`spec-roster-row ${p.isMine ? 'is-mine' : ''}`}
                    >
                      <span className="spec-roster-seed">#{p.seed}</span>
                      <div className="spec-roster-info">
                        <div className="spec-roster-name-line">
                          <strong className="spec-roster-name">{p.name}</strong>
                          {p.isMine && <span className="spec-you-tag">YOU</span>}
                        </div>
                        {isTeams && p.members?.length > 0 && (
                          <span className="spec-roster-members">
                            {formatTeamMembers(p)}
                          </span>
                        )}
                      </div>
                      <span className="spec-roster-record">
                        {p.wins}W–{p.losses}L
                      </span>
                      <span className={`spec-roster-badge is-${p.statusTone}`}>
                        {p.statusLabel}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
        </div>
      </main>

      {/* Grandma & 4:3 CRT TV Corner (auto-collapses to clickable coffee cup on mobile) */}
      {grandmaEnabled && (
        <RetroTVCorner
          grandmaConfig={state.grandma}
          tvMuted={state.ui?.tvMuted !== false}
          hasCustomTvMedia={state.ui?.hasCustomTvMedia}
          tvMediaSyncKey={state.ui?.tvMediaUpdatedAt ? String(state.ui.tvMediaUpdatedAt) : ''}
          tvPlaylist={state.ui?.tvPlaylist}
          tvPlaylistIndex={state.ui?.tvPlaylistIndex ?? 0}
          tvPlaylistMode={state.ui?.tvPlaylistMode || 'loop'}
          tvPlaylistPaused={Boolean(state.ui?.tvPlaylistPaused)}
          visible={state.ui?.showCornerScene !== false}
          scale={0.78}
          opacity={state.ui?.cornerOpacity ?? 1.0}
          bubbleScale={state.ui?.bubbleScale ?? 1.0}
          variant="corner"
          inStage={false}
          viewKey="spectator"
          allowLocalToggle={true}
        />
      )}
    </div>
  );
}
