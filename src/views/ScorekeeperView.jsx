import React, { useEffect, useMemo, useRef, useState } from 'react';
import { tournamentStore, getTableSlots } from '../state/tournamentStore.js';
import { evaluateMatchState, MATCH_STATUS } from '../engine/scoringEngine.js';
import { ROLE_LEVEL } from '../engine/roles.js';
import { formatTeamMembers, findNextReadyMatchId } from '../engine/bracketGenerator.js';
import { hasGrandmaVariables, resolveGrandmaPhrase } from '../engine/grandmaVariables.js';
import DebounceOverrideDialog from '../components/DebounceOverrideDialog.jsx';
import GrandmaPhraseInput from '../components/GrandmaPhraseInput.jsx';
import MatchTimer from '../components/MatchTimer.jsx';
import PointRemovalTooltip, { usePendingPointRemoval } from '../components/PointRemovalTooltip.jsx';
import ViewNavBar from '../components/ViewNavBar.jsx';
import { useFullscreenMenu } from '../hooks/useFullscreenMenu.js';

/**
 * Dedicated Table-Side Scorekeeper View (/scorekeeper)
 * Built for fast, zero-clutter scoring on a tablet, phone, or court-side laptop.
 * Features huge tap-to-score cards, keyboard shortcuts (1, 2, Z, S, X),
 * local left/right court side swap, match switcher, instant match advancement,
 * first-5 Phrase Manager quick Grandma buttons, and a full Grandma phrase menu modal.
 */
const SCOREKEEPER_SWAP_KEY = 'pingpong-scorekeeper-swapped-v1';

export default function ScorekeeperView({
  state,
  effectiveRole = 'host',
  rolePerms = null,
  myDeviceId = '',
  onNavigateMode,
  onOpenTournamentChooser,
}) {
  const canScoreRole = rolePerms ? Boolean(rolePerms.canScore) : effectiveRole !== 'spectator' && effectiveRole !== 'presenter';
  const requireScorekeeperApproval = state.rules?.requireScorekeeperApproval !== false;
  const isModeratorOrAbove = (ROLE_LEVEL[effectiveRole] ?? 0) >= ROLE_LEVEL.moderator;
  const grandmaEnabled = state.rules?.grandmaEnabled !== false;
  const allowScorekeeperGrandma =
    grandmaEnabled && (isModeratorOrAbove || state.rules?.allowScorekeeperGrandma !== false);
  const tabId = tournamentStore.getTabId();
  const pendingRequestsCount =
    (state.scorekeeperRequests?.length || 0) + (state.joinRequests?.length || 0);
  const hasPendingScorekeeperRequest = Boolean(
    myDeviceId &&
      (state.scorekeeperRequests || []).some((r) => r && r.deviceId === myDeviceId)
  );
  const [swappedSides, setSwappedSides] = useState(() => {
    try {
      return localStorage.getItem(SCOREKEEPER_SWAP_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [feedback, setFeedback] = useState('');
  const [debounceRequest, setDebounceRequest] = useState(null);
  const { isFullscreen, isMenuRevealed, toggleFullscreen, barHoverHandlers } = useFullscreenMenu();

  useEffect(() => {
    try {
      localStorage.setItem(SCOREKEEPER_SWAP_KEY, swappedSides ? '1' : '0');
    } catch {
      // Ignore storage errors
    }
  }, [swappedSides]);
  const [phraseMenuOpen, setPhraseMenuOpen] = useState(false);
  const [matchMenuOpen, setMatchMenuOpen] = useState(false);
  const [postCompleteBanner, setPostCompleteBanner] = useState(null);
  const [customCue, setCustomCue] = useState('');
  const phraseDialogRef = useRef(null);
  const matchDialogRef = useRef(null);
  const lastSeenCompletedEventIdRef = useRef(state.lastCompletedEvent?.id || 0);

  const isPopout = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('popout') === '1' || Boolean(window.opener);
  }, []);

  const isTeams = state.entryMode === 'teams';
  const tableCount = Math.max(1, Math.floor(Number(state.rules?.tableCount ?? 1) || 1));
  const [lockedTableNum, setLockedTableNum] = useState(null);
  const [pendingTableSwitch, setPendingTableSwitch] = useState(null);
  const tableSlots = useMemo(() => getTableSlots(state), [state]);
  const lockedSlotMatch =
    tableCount > 1 && lockedTableNum && lockedTableNum >= 1 && lockedTableNum <= tableCount
      ? tableSlots[lockedTableNum - 1]?.match || null
      : null;
  const activeMatch = lockedSlotMatch || state.matches?.[state.activeMatchId] || null;
  const evalState = evaluateMatchState(activeMatch, state.rules);

  const myEffectiveDeviceId = String(myDeviceId || tournamentStore.getTabId() || '').trim();
  const isPrivilegedOverride = ['admin', 'host', 'moderator'].includes(effectiveRole);
  const claimedByDeviceId = activeMatch?.scorekeeperDeviceId || null;
  const claimedByName = activeMatch?.scorekeeperDeviceName || 'another Scorekeeper';
  const isClaimedByMe = Boolean(claimedByDeviceId && claimedByDeviceId === myEffectiveDeviceId);
  const isClaimedByOther = Boolean(claimedByDeviceId && claimedByDeviceId !== myEffectiveDeviceId);
  const needsClaimToScore = Boolean(
    canScoreRole &&
      !isPrivilegedOverride &&
      activeMatch &&
      !activeMatch.completed &&
      !isClaimedByMe
  );
  const canScoreThisMatch = Boolean(
    canScoreRole &&
      activeMatch &&
      !activeMatch.completed &&
      !activeMatch.paused &&
      (isPrivilegedOverride || isClaimedByMe)
  );

  const playerMap = useMemo(() => {
    const map = new Map();
    for (const p of state.players || []) map.set(p.id, p);
    return map;
  }, [state.players]);

  const recommendedMatchId = useMemo(
    () => findNextReadyMatchId(state.matches || {}),
    [state.matches]
  );

  // Auto-open Next Match Selection Modal on Scorekeepers whenever any game completes
  useEffect(() => {
    const evt = state.lastCompletedEvent;
    if (!evt || !evt.id || evt.id === lastSeenCompletedEventIdRef.current) return;
    lastSeenCompletedEventIdRef.current = evt.id;

    // If a Champion was crowned or no ready matches remain, don't force next-match picker
    if (state.championId || !evt.recommendedMatchId) return;

    const winnerName = evt.winnerId ? playerMap.get(evt.winnerId)?.name : null;
    setPostCompleteBanner({
      matchLabel: evt.completedMatchLabel,
      winnerName,
      score1: evt.score1,
      score2: evt.score2,
      recommendedMatchId: evt.recommendedMatchId,
    });
    setMatchMenuOpen(true);
  }, [state.lastCompletedEvent, state.championId, playerMap]);

  const selectableMatches = useMemo(() => {
    const recId = postCompleteBanner?.recommendedMatchId || recommendedMatchId;
    return Object.values(state.matches || {})
      .filter((m) => !m.isBye && (m.player1Id || m.player2Id))
      .sort((a, b) => {
        if (recId) {
          if (a.id === recId && b.id !== recId) return -1;
          if (b.id === recId && a.id !== recId) return 1;
        }
        const aReady = !a.completed && Boolean(a.player1Id && a.player2Id);
        const bReady = !b.completed && Boolean(b.player1Id && b.player2Id);
        if (aReady !== bReady) return aReady ? -1 : 1;
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        if (a.bracket !== b.bracket) {
          const order = { winners: 0, losers: 1, final: 2 };
          return (order[a.bracket] ?? 0) - (order[b.bracket] ?? 0);
        }
        return a.round - b.round || a.matchNumber - b.matchNumber;
      });
  }, [state.matches, recommendedMatchId, postCompleteBanner]);

  // Contextual phrases ONLY for Scorekeeper (first 5 in dock, full contextual list in menu)
  const contextualPhrases = useMemo(
    () => (state.grandma?.contextualQuotes || []).filter(Boolean),
    [state.grandma]
  );
  const quickGrandmaPhrases = useMemo(() => contextualPhrases.slice(0, 5), [contextualPhrases]);

  // Automatically close Grandma phrase menu if disabled by tournament rules
  useEffect(() => {
    if (!allowScorekeeperGrandma && phraseMenuOpen) {
      setPhraseMenuOpen(false);
    }
  }, [allowScorekeeperGrandma, phraseMenuOpen]);

  // Sync native <dialog> for Full Grandma Phrase Menu
  useEffect(() => {
    const dialog = phraseDialogRef.current;
    if (!dialog) return undefined;
    if (phraseMenuOpen && !dialog.open) {
      dialog.showModal();
    } else if (!phraseMenuOpen && dialog.open) {
      dialog.close();
    }
    return undefined;
  }, [phraseMenuOpen]);

  useEffect(() => {
    const dialog = phraseDialogRef.current;
    if (!dialog) return undefined;

    const handleClose = () => {
      dialog.returnValue = '';
      setPhraseMenuOpen(false);
    };
    dialog.addEventListener('close', handleClose);

    let removeFallback = () => { };
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const isOutside = (e) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      let pressedOutside = false;
      const onPointerDown = (e) => {
        pressedOutside = isOutside(e);
      };
      const onPointerUp = (e) => {
        if (pressedOutside && isOutside(e)) dialog.close();
        pressedOutside = false;
      };
      dialog.addEventListener('pointerdown', onPointerDown);
      dialog.addEventListener('pointerup', onPointerUp);
      removeFallback = () => {
        dialog.removeEventListener('pointerdown', onPointerDown);
        dialog.removeEventListener('pointerup', onPointerUp);
      };
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      removeFallback();
    };
  }, []);

  // Sync native <dialog> for Game Selection Menu
  useEffect(() => {
    const dialog = matchDialogRef.current;
    if (!dialog) return undefined;
    if (matchMenuOpen && !dialog.open) {
      dialog.showModal();
    } else if (!matchMenuOpen && dialog.open) {
      dialog.close();
    }
    return undefined;
  }, [matchMenuOpen]);

  useEffect(() => {
    const dialog = matchDialogRef.current;
    if (!dialog) return undefined;

    const handleClose = () => {
      dialog.returnValue = '';
      setMatchMenuOpen(false);
      setPostCompleteBanner(null);
    };
    dialog.addEventListener('close', handleClose);

    let removeFallback = () => { };
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const isOutside = (e) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      let pressedOutside = false;
      const onPointerDown = (e) => {
        pressedOutside = isOutside(e);
      };
      const onPointerUp = (e) => {
        if (pressedOutside && isOutside(e)) dialog.close();
        pressedOutside = false;
      };
      dialog.addEventListener('pointerdown', onPointerDown);
      dialog.addEventListener('pointerup', onPointerUp);
      removeFallback = () => {
        dialog.removeEventListener('pointerdown', onPointerDown);
        dialog.removeEventListener('pointerup', onPointerUp);
      };
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      removeFallback();
    };
  }, []);

  const flashFeedback = (msg) => {
    setFeedback(msg);
    setTimeout(() => {
      setFeedback((curr) => (curr === msg ? '' : curr));
    }, 2200);
  };

  const leftSlot = swappedSides ? 2 : 1;
  const rightSlot = swappedSides ? 1 : 2;

  const resolveSlotName = (slot) => {
    const id = slot === 1 ? activeMatch?.player1Id : activeMatch?.player2Id;
    const found = id ? playerMap.get(id) : null;
    return found?.name || (isTeams ? `Team ${slot}` : `Player ${slot}`);
  };

  const { pendingRemoval, requestRemovePoint, cancelPendingRemoval } = usePendingPointRemoval({
    matchId: activeMatch?.id,
    score1: activeMatch?.score1 || 0,
    score2: activeMatch?.score2 || 0,
    onCommit: (slot, count, playerName) => {
      for (let i = 0; i < count; i += 1) {
        tournamentStore.subtractPoint(slot, { matchId: activeMatch?.id });
      }
      flashFeedback(`Removed ${count} ${count === 1 ? 'point' : 'points'} from ${playerName}`);
    },
    onCancel: (entry) => {
      flashFeedback(`Cancelled removing point from ${entry.playerName}`);
    },
  });

  const handleScoreTap = (slot) => {
    if (!canScoreRole) {
      flashFeedback(
        requireScorekeeperApproval
          ? 'Guest view is read-only — request Scorekeeper access above'
          : 'Tap 🎯 Become Scorekeeper above to start scoring'
      );
      return;
    }
    if (isClaimedByOther && !isPrivilegedOverride) {
      flashFeedback(`🔒 This match is being scored by ${claimedByName}`);
      return;
    }
    if (needsClaimToScore) {
      flashFeedback('✋ Tap "Claim Match to Score" above before scoring points');
      return;
    }
    if (activeMatch?.paused) {
      flashFeedback('⏸ Match is paused — resume before scoring');
      return;
    }
    cancelPendingRemoval(true);
    const res = tournamentStore.addPoint(slot, { matchId: activeMatch?.id, requireStarted: true });
    if (res && res.requiresStart) {
      flashFeedback('Tap ▶ BEGIN MATCH to start scoring');
      return;
    }
    if (res && !res.accepted && res.remainingMs > 0) {
      setDebounceRequest({
        id: Date.now(),
        slot,
        playerName: resolveSlotName(slot),
        remainingSec: res.remainingSec,
      });
    }
  };

  const handleConfirmDebounceOverride = (slot) => {
    setDebounceRequest(null);
    tournamentStore.addPoint(slot, { matchId: activeMatch?.id, bypassDebounce: true, requireStarted: true });
    flashFeedback(`+1 point added for ${resolveSlotName(slot)} (override)`);
  };

  const handleFirePhrase = (text, closeMenu = false) => {
    if (!canScoreRole || !allowScorekeeperGrandma) return;
    const cleaned = String(text || '').trim();
    if (!cleaned) return;
    const resolved = resolveGrandmaPhrase(cleaned, state);
    tournamentStore.triggerLiveQuote(cleaned);
    flashFeedback(`Grandma: "${resolved}"`);
    if (closeMenu) {
      phraseDialogRef.current?.close();
    }
  };

  // Keyboard shortcuts: 1 (Left +1), 2 (Right +1), S (Switch 1st Server), X (Swap Sides)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (phraseMenuOpen || matchMenuOpen) return;
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '1') {
        e.preventDefault();
        handleScoreTap(leftSlot);
      } else if (e.key === '2') {
        e.preventDefault();
        handleScoreTap(rightSlot);
      } else if (e.key === 's' || e.key === 'S') {
        if (!canScoreRole) return;
        e.preventDefault();
        tournamentStore.switchFirstServer({ matchId: activeMatch?.id });
      } else if (e.key === 'x' || e.key === 'X') {
        if (!canScoreRole) return;
        e.preventDefault();
        setSwappedSides((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [leftSlot, rightSlot, phraseMenuOpen, matchMenuOpen, activeMatch, playerMap, canScoreRole, requireScorekeeperApproval]);

  const formatScore = (n) => String(Math.max(0, Number(n) || 0)).padStart(2, '0');

  const statusTone =
    evalState.status === MATCH_STATUS.WINNER
      ? 'status-winner'
      : evalState.status === MATCH_STATUS.DEUCE
        ? 'status-deuce'
        : evalState.status === MATCH_STATUS.GAME_POINT
          ? 'status-gamepoint'
          : evalState.status === MATCH_STATUS.WAITING
            ? 'status-waiting'
            : 'status-live';

  const getSlotData = (slot) => {
    const playerId = slot === 1 ? activeMatch?.player1Id : activeMatch?.player2Id;
    const entrant = playerId ? playerMap.get(playerId) : null;
    const score = slot === 1 ? activeMatch?.score1 || 0 : activeMatch?.score2 || 0;
    const fallbackLabel =
      slot === 1
        ? activeMatch?.source1Label || (isTeams ? 'Awaiting Team' : 'Awaiting Player')
        : activeMatch?.source2Label || (isTeams ? 'Awaiting Team' : 'Awaiting Player');
    const membersText = isTeams ? formatTeamMembers(entrant, ' · ') : '';
    const isServing =
      evalState.activeServer === slot &&
      Boolean(activeMatch?.player1Id && activeMatch?.player2Id) &&
      !activeMatch?.completed &&
      evalState.winnerSlot === null;
    const isWinner =
      evalState.winnerSlot === slot ||
      (activeMatch?.completed && activeMatch?.winnerId === playerId && Boolean(playerId));

    let serveDetail = evalState.isDeadMansServe
      ? "Dead Man's Serve"
      : evalState.isInDeuceZone
      ? 'Deuce · 1 serve'
      : `${evalState.pointsUntilServeSwitch} serve${evalState.pointsUntilServeSwitch === 1 ? '' : 's'
      } left`;

    if (isTeams && Array.isArray(entrant?.members)) {
      const serverMember =
        entrant.members[evalState.activeServerMemberIndex] || entrant.members[0];
      if (serverMember) serveDetail = `${serverMember} serving · ${serveDetail}`;
    }

    return {
      slot,
      entrant,
      score,
      fallbackLabel,
      membersText,
      isServing,
      isWinner,
      serveDetail,
    };
  };

  const leftData = getSlotData(leftSlot);
  const rightData = getSlotData(rightSlot);
  const isMatchStarted = Boolean(
    activeMatch &&
    (activeMatch.started ||
      activeMatch.completed ||
      (activeMatch.score1 || 0) > 0 ||
      (activeMatch.score2 || 0) > 0)
  );
  const needsScoreboardUpdate = tournamentStore.hasUnpublishedMatchSelection();
  const canStartMatch = Boolean(
    canScoreRole &&
    activeMatch &&
    activeMatch.player1Id &&
    activeMatch.player2Id &&
    !activeMatch.completed &&
    !isMatchStarted
  );
  const canScore = Boolean(
    canScoreRole &&
    activeMatch &&
    activeMatch.player1Id &&
    activeMatch.player2Id &&
    isMatchStarted &&
    !activeMatch.completed &&
    evalState.winnerSlot === null
  );

  const renderTapPad = (data, sideKey, shortcutKey) => {
    const colorClass = data.slot === 1 ? 'sk-side-p1' : 'sk-side-p2';
    return (
      <div
        className={`sk-tap-pad ${colorClass} ${data.isServing ? 'is-serving' : ''} ${data.isWinner ? 'is-winner' : ''
          } score-font-${state.ui?.scoreFont || 'barlow'}`}
      >
        <button
          type="button"
          className="sk-pad-main-btn"
          onClick={() => handleScoreTap(data.slot)}
          disabled={!canScore}
          aria-label={`Add 1 point to ${data.entrant?.name || data.fallbackLabel}`}
        >
          <div className="sk-pad-top">
            <div className="sk-identity">
              <span className="seed-badge">{data.entrant ? `#${data.entrant.seed}` : 'TBD'}</span>
              <div className="sk-name-stack">
                <span className="sk-name">
                  {data.entrant ? data.entrant.name : data.fallbackLabel}
                </span>
                {data.membersText && <span className="sk-members">{data.membersText}</span>}
              </div>
            </div>

            {data.isServing && (
              <span className="serving-badge">
                <span className="serving-ball" aria-hidden="true" />
                SERVING
              </span>
            )}
            {data.isWinner && <span className="winner-tag">WINNER</span>}
          </div>

          <div className="sk-score-center">
            <div className="digital-score sk-huge-score">{formatScore(data.score)}</div>
            {data.isServing && <div className="sk-serve-sub">{data.serveDetail}</div>}
          </div>

          <div className="sk-tap-prompt">
            <span>
              {canScore
                ? 'TAP ANYWHERE FOR +1'
                : canStartMatch
                  ? 'BEGIN MATCH TO SCORE'
                  : activeMatch?.completed
                    ? 'MATCH COMPLETE'
                    : 'READY'}
            </span>
            <kbd>{shortcutKey}</kbd>
          </div>
        </button>

        {pendingRemoval?.slot === data.slot && (
          <PointRemovalTooltip
            pending={pendingRemoval}
            onCancel={() => cancelPendingRemoval()}
            className="sk-remove-tooltip"
          />
        )}

        <button
          type="button"
          className={`sk-minus-btn ${pendingRemoval?.slot === data.slot ? 'is-pending-remove' : ''}`}
          onClick={() => requestRemovePoint(data.slot, resolveSlotName(data.slot))}
          disabled={
            !canScoreRole ||
            !activeMatch ||
            activeMatch.completed ||
            data.score <= 0
          }
          aria-label={`Subtract 1 point from ${data.entrant?.name || sideKey}`}
        >
          −1
        </button>
      </div>
    );
  };

  const isMatchInProgress = Boolean(
    activeMatch &&
    !activeMatch.completed &&
    ((activeMatch.score1 || 0) > 0 || (activeMatch.score2 || 0) > 0)
  );

  const activeTableNum = Math.max(
    1,
    Math.min(tableCount, Math.floor(Number(lockedTableNum || activeMatch?.tableNumber) || 1))
  );

  const commitScorekeeperTableSwitch = (clamped) => {
    const res = tournamentStore.selectOrQueueTable(clamped, { setAsActive: false });
    setLockedTableNum(clamped);
    if (res.ok && res.queued) {
      flashFeedback(`🏓 Queued next match on Table ${clamped}`);
    } else if (res.ok) {
      flashFeedback(`🏓 Switched to Table ${clamped}`);
    } else {
      flashFeedback(res.reason || `Table ${clamped} is open`);
    }
  };

  const handleSelectScorekeeperTable = (nextTableNum) => {
    const clamped = Math.max(1, Math.min(tableCount, Math.floor(Number(nextTableNum) || 1)));
    if (clamped === activeTableNum) return;

    const isScoringLiveMatch = Boolean(
      activeMatch &&
        !activeMatch.completed &&
        !activeMatch.paused &&
        (activeMatch.started ||
          (activeMatch.score1 || 0) > 0 ||
          (activeMatch.score2 || 0) > 0)
    );
    if (isScoringLiveMatch) {
      const p1Name = activeMatch.player1Id
        ? playerMap.get(activeMatch.player1Id)?.name || activeMatch.source1Label
        : activeMatch.source1Label || 'Player 1';
      const p2Name = activeMatch.player2Id
        ? playerMap.get(activeMatch.player2Id)?.name || activeMatch.source2Label
        : activeMatch.source2Label || 'Player 2';
      setPendingTableSwitch({
        fromTable: activeTableNum,
        toTable: clamped,
        matchLabel: activeMatch.label || 'Current Match',
        playersText: `${p1Name} vs ${p2Name}`,
        scoreText: `${activeMatch.score1 ?? 0}–${activeMatch.score2 ?? 0}`,
      });
      return;
    }

    commitScorekeeperTableSwitch(clamped);
  };

  const activeP1 = activeMatch?.player1Id ? playerMap.get(activeMatch.player1Id) : null;
  const activeP2 = activeMatch?.player2Id ? playerMap.get(activeMatch.player2Id) : null;
  const activeTriggerLabel = activeMatch
    ? `${activeMatch.label}: ${activeP1?.name || activeMatch.source1Label} vs ${activeP2?.name || activeMatch.source2Label
    }`
    : 'Select Match';

  return (
    <div className="scorekeeper-shell">
      {/* Uniform Top Navigation Bar (Hub + Role Views + Contextual Match Picker + Full Screen on Top-Left) */}
      <header
        className={`sk-topbar ${isFullscreen ? 'is-fullscreen-sk' : ''} ${
          isFullscreen && isMenuRevealed ? 'is-revealed' : ''
        }`}
        {...barHoverHandlers}
      >
        {!isPopout && (
          <div className={`sk-nav-row ${isFullscreen && !isMenuRevealed ? 'is-collapsed-fs' : ''}`}>
            <ViewNavBar
              activeMode="scorekeeper"
              rolePerms={rolePerms}
              pendingRequestsCount={pendingRequestsCount}
              onNavigateMode={onNavigateMode}
              onOpenTournamentChooser={onOpenTournamentChooser}
              isFullscreen={isFullscreen}
            />
          </div>
        )}

        <div
          className="sk-submenu"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.5rem 0.85rem',
            width: '100%',
            minWidth: 0,
          }}
        >
          <div className="sk-top-left">
            {!isPopout && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen (hover top edge for menu)'}
              >
                {isFullscreen ? '⤢ Exit Full Screen' : '⛶ Full Screen'}
              </button>
            )}
            {isPopout && <span className="sk-badge-title">🎯 SCOREKEEPER</span>}
            {tableCount > 1 && (
              <select
                className="table-select-pill"
                value={activeTableNum}
                onChange={(e) => handleSelectScorekeeperTable(Number(e.target.value))}
                aria-label="Switch active table"
                title="Switch which table this Scorekeeper device is scoring"
              >
                {Array.from({ length: tableCount }, (_, idx) => {
                  const slot = tableSlots[idx];
                  const tag = slot?.isLive ? ' ●' : slot?.isQueued ? ' ○' : '';
                  return (
                    <option key={idx + 1} value={idx + 1}>
                      Table {idx + 1}{tag}
                    </option>
                  );
                })}
              </select>
            )}
            <button
              type="button"
              className={`sk-match-trigger ${isMatchInProgress || !canScoreRole ? 'is-locked' : ''}`}
              disabled={isMatchInProgress || !canScoreRole}
              title={
                !canScoreRole
                  ? 'Spectator view is read-only — become a Scorekeeper to switch matches'
                  : isMatchInProgress
                  ? 'Match in progress — complete the match, return score to 0–0, or change matches from Control View'
                  : 'Open game selection menu'
              }
              onClick={() => {
                if (!isMatchInProgress && canScoreRole) setMatchMenuOpen(true);
              }}
              aria-label="Open game selection menu"
            >
              <span className="sk-match-trigger-text">{activeTriggerLabel}</span>
              <span className="sk-match-trigger-caret" aria-hidden="true">
                {isMatchInProgress ? '🔒' : '▾'}
              </span>
            </button>
            {!isPopout && isMatchInProgress && (
              <span
                className="sk-lock-chip"
                title="Return score to 0–0, complete the match, or switch from Control View"
              >
                Locked (0–0 to switch)
              </span>
            )}
          </div>

          <div className="sk-top-right">
          <div
            className={`match-status-banner ${canStartMatch ? 'status-waiting' : statusTone}`}
            role="status"
            aria-live="polite"
          >
            <span className="status-dot" aria-hidden="true" />
            <span>
              {canStartMatch
                ? 'READY TO START'
                : evalState.status === MATCH_STATUS.WINNER && evalState.isSkunkWin
                ? '🦨 SKUNK WIN'
                : evalState.status === MATCH_STATUS.GAME_POINT && evalState.isSkunkPoint
                ? '🦨 SKUNK POINT'
                : evalState.status}
            </span>
            <MatchTimer match={activeMatch} inline />
          </div>
          <span className="sk-rules-chip">
            To {state.rules.targetPoints} · Win by {state.rules.winBy ?? 2} · Serve{' '}
            {evalState.isInDeuceZone ? '1' : state.rules.serveRotation}
            {state.rules?.skunkEnabled ? ` · Skunk ${state.rules.skunkScore ?? 7}–0` : ''}
            {state.rules?.deadMansServe ? " · Dead Man's Serve" : ''}
            {tableCount > 1 ? ` · Table ${activeTableNum}/${tableCount}` : ''}
          </span>
          </div>
        </div>
      </header>

      {feedback && (
        <div className="operator-toast" role="status" aria-live="polite">
          {feedback}
        </div>
      )}

      {canStartMatch && (
        <div className="sk-begin-match-bar" role="region" aria-label="Begin Match">
          <div className="sk-begin-copy">
            <strong>
              {activeMatch.label} Ready on Table {activeTableNum}
            </strong>
            <span>
              {needsScoreboardUpdate
                ? 'This match differs from the live scoreboard — press Update Scoreboard first, then Begin Match.'
                : `Confirm players${tableCount > 1 ? ', table,' : ''} & first server, then press Begin Match to start & sync across all screens.`}
            </span>
          </div>
          <div className="inline-actions">
            {tableCount > 1 && (
              <select
                className="table-select-pill"
                value={activeTableNum}
                onChange={(e) => handleSelectScorekeeperTable(Number(e.target.value))}
                aria-label="Switch active table"
              >
                {Array.from({ length: tableCount }, (_, idx) => {
                  const slot = tableSlots[idx];
                  const tag = slot?.isLive ? ' (Live)' : slot?.isQueued ? ' (Ready)' : ' (Open)';
                  return (
                    <option key={idx + 1} value={idx + 1}>
                      Table {idx + 1}{tag}
                    </option>
                  );
                })}
              </select>
            )}
            {needsScoreboardUpdate && (
              <button
                type="button"
                className="btn-amber sk-update-scoreboard-btn"
                onClick={() => {
                  tournamentStore.publishSelectedMatch();
                  flashFeedback(`📺 Scoreboard updated to ${activeMatch.label}`);
                }}
              >
                📺 Update Scoreboard
              </button>
            )}
            <button
              type="button"
              className="btn-amber sk-begin-match-btn"
              disabled={needsScoreboardUpdate || (isClaimedByOther && !isPrivilegedOverride)}
              title={
                needsScoreboardUpdate
                  ? 'Update the scoreboard first'
                  : isClaimedByOther && !isPrivilegedOverride
                  ? `Already claimed by ${claimedByName}`
                  : undefined
              }
              onClick={() => {
                if (!isPrivilegedOverride) {
                  const claimRes = tournamentStore.claimMatchScorekeeper(activeMatch.id, {
                    deviceId: myEffectiveDeviceId,
                  });
                  if (!claimRes.ok) {
                    flashFeedback(`⚠️ ${claimRes.reason || 'Could not claim match'}`);
                    return;
                  }
                }
                tournamentStore.startMatch(activeMatch.id, activeTableNum, {
                  claimForScorekeeper: !isPrivilegedOverride,
                  deviceId: myEffectiveDeviceId,
                });
                flashFeedback(
                  `▶ ${activeMatch.label} started on Table ${activeTableNum} & claimed for scoring!`
                );
              }}
            >
              ▶ Begin Match
            </button>
          </div>
        </div>
      )}

      {/* Per-Match Scorekeeper Claim Lock Banner (1 Scorekeeper per match, Host/Admin/Mod can override) */}
      {canScoreRole && activeMatch && !activeMatch.completed && (isClaimedByMe || isClaimedByOther || activeMatch.started) && (
        <div
          role="region"
          aria-label="Match Scorekeeper Claim"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.5rem',
            padding: '0.45rem 0.85rem',
            margin: '0 0.75rem',
            borderRadius: '10px',
            fontSize: '0.8rem',
            background: isClaimedByOther
              ? 'rgba(239, 68, 68, 0.14)'
              : isClaimedByMe
              ? 'rgba(16, 185, 129, 0.14)'
              : 'rgba(245, 158, 11, 0.14)',
            border: `1px solid ${
              isClaimedByOther
                ? 'rgba(248, 113, 113, 0.5)'
                : isClaimedByMe
                ? 'rgba(52, 211, 153, 0.45)'
                : 'rgba(251, 191, 36, 0.5)'
            }`,
            color: '#f8fafc',
          }}
        >
          <span>
            {isClaimedByOther ? (
              <>
                🔒 Scored by <strong>{claimedByName}</strong>
                {isPrivilegedOverride ? ' (Host/Admin override enabled)' : ' — scoring locked'}
              </>
            ) : isClaimedByMe ? (
              <>🎯 You are the active Scorekeeper for <strong>{activeMatch.label}</strong></>
            ) : (
              <>✋ No Scorekeeper has claimed <strong>{activeMatch.label}</strong> yet</>
            )}
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            {isClaimedByMe && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  tournamentStore.releaseMatchScorekeeper(activeMatch.id, {
                    deviceId: myEffectiveDeviceId,
                  });
                  flashFeedback(`Released Scorekeeper claim on ${activeMatch.label}`);
                }}
              >
                Release Claim
              </button>
            )}
            {!isClaimedByMe && !isClaimedByOther && (
              <button
                type="button"
                className="btn-amber btn-sm"
                onClick={() => {
                  const res = tournamentStore.claimMatchScorekeeper(activeMatch.id, {
                    deviceId: myEffectiveDeviceId,
                    force: isPrivilegedOverride,
                  });
                  if (res.ok) {
                    flashFeedback(`🎯 Claimed ${activeMatch.label} for scoring`);
                  } else {
                    flashFeedback(`⚠️ ${res.reason || 'Could not claim match'}`);
                  }
                }}
              >
                ✋ Claim Match to Score
              </button>
            )}
            {isClaimedByOther && isPrivilegedOverride && (
              <>
                <button
                  type="button"
                  className="btn-amber btn-sm"
                  onClick={() => {
                    tournamentStore.claimMatchScorekeeper(activeMatch.id, {
                      deviceId: myEffectiveDeviceId,
                      force: true,
                    });
                    flashFeedback(`🎯 Took over scoring ${activeMatch.label}`);
                  }}
                >
                  Take Over
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    tournamentStore.releaseMatchScorekeeper(activeMatch.id, { force: true });
                    flashFeedback(`Released ${claimedByName}'s claim on ${activeMatch.label}`);
                  }}
                >
                  Release
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {!canScoreRole && (
        <div className="sk-guest-gate-bar" role="region" aria-label="Guest Scorekeeper Access">
          <div className="sk-begin-copy">
            <strong>
              👤 Guest Mode (Read-Only Scoreboard)
            </strong>
            <span>
              {hasPendingScorekeeperRequest
                ? 'Your Scorekeeper access request has been sent — waiting for a Host, Admin, or Moderator to approve.'
                : requireScorekeeperApproval
                ? 'Request Scorekeeper access from the Host, Admin, or Moderator to score matches.'
                : 'Scorekeeper approval is disabled — click below to become a Scorekeeper immediately.'}
            </span>
          </div>
          <button
            type="button"
            className="btn-amber sk-begin-match-btn"
            disabled={hasPendingScorekeeperRequest}
            onClick={async () => {
              const res = await tournamentStore.requestScorekeeperAccess();
              if (res.ok && res.approved) {
                flashFeedback('🎯 You are now a Scorekeeper!');
              } else if (res.ok && res.pending) {
                flashFeedback('🙋 Request sent — waiting for approval in Users tab');
              } else {
                flashFeedback(res.error || 'Could not request Scorekeeper access');
              }
            }}
          >
            {hasPendingScorekeeperRequest
              ? '⏳ Approval Pending...'
              : requireScorekeeperApproval
              ? '🙋 Request Access'
              : '🎯 Become Scorekeeper'}
          </button>
        </div>
      )}

      {/* Main Giant Dual-Pad Tap Arena */}
      <main
        className={`sk-arena ${canStartMatch ? 'is-awaiting-start' : ''} ${
          !canScoreThisMatch ? 'is-guest-readonly' : ''
        }`}
      >
        {renderTapPad(leftData, 'left', '1')}
        {renderTapPad(rightData, 'right', '2')}
      </main>

      {/* Bottom Action & Phrase Manager Quick Grandma Dock */}
      <footer className={`sk-dock ${!canScoreRole ? 'is-guest-readonly' : ''}`}>
        <div className="sk-dock-controls">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => tournamentStore.switchFirstServer({ matchId: activeMatch?.id })}
            disabled={!canScoreRole || !activeMatch || activeMatch.completed}
          >
            ⇄ 1st Server <kbd>S</kbd>
          </button>

          <button
            type="button"
            className={`btn-secondary ${swappedSides ? 'is-toggled-on' : ''}`}
            onClick={() => {
              setSwappedSides((prev) => !prev);
              flashFeedback('Court sides swapped locally');
            }}
          >
            ↔ Swap Sides <kbd>X</kbd>
          </button>
        </div>

        {/* Clickable Grandma Icon (Opens Full Phrase Menu) + First 5 Phrase Manager Buttons */}
        {allowScorekeeperGrandma && (
          <div className="sk-dock-cues" aria-label="Grandma Quick Phrases">
            <button
              type="button"
              className="sk-grandma-menu-btn"
              onClick={() => setPhraseMenuOpen(true)}
              title="Open full Grandma phrase menu"
              aria-label="Open full Grandma phrase menu"
            >
              👵
            </button>
            {quickGrandmaPhrases.map((phrase, idx) => {
              const resolved = resolveGrandmaPhrase(phrase, state);
              return (
                <button
                  key={idx}
                  type="button"
                  className="cue-chip sk-phrase-chip"
                  title={resolved}
                  onClick={() => handleFirePhrase(phrase)}
                >
                  {resolved}
                </button>
              );
            })}
          </div>
        )}

        <button
          type="button"
          className={`btn-advance sk-complete-btn ${evalState.canComplete ? 'is-ready' : ''}`}
          disabled={!evalState.canComplete}
          onClick={() => {
            cancelPendingRemoval(true);
            const label = activeMatch?.label;
            tournamentStore.completeActiveMatch(activeMatch?.id);
            flashFeedback(`Completed ${label} — next match loaded!`);
          }}
        >
          {activeMatch?.completed
            ? '✓ Match Completed'
            : evalState.canComplete
              ? '🏆 Complete & Next Match'
              : `Win at ${state.rules.targetPoints} (+2)`}
        </button>
      </footer>

      {/* Native <dialog> Contextual Grandma Phrase Menu (Contextual Phrases Only) */}
      <dialog
        ref={phraseDialogRef}
        className="app-dialog sk-phrase-menu-dialog is-wide"
        closedby="any"
        aria-labelledby="sk-grandma-menu-heading"
      >
        <div className="dialog-surface">
          <header className="dialog-header">
            <h1 id="sk-grandma-menu-heading" className="dialog-title">
              👵 Grandma Contextual Phrases
            </h1>
            <button
              type="button"
              className="dialog-close-btn"
              onClick={() => phraseDialogRef.current?.close()}
              aria-label="Close Grandma phrase menu"
            >
              ✕
            </button>
          </header>

          <div className="dialog-body scroller">
            <form
              className="live-quote-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!customCue.trim()) return;
                handleFirePhrase(customCue, true);
                setCustomCue('');
              }}
            >
              <GrandmaPhraseInput
                state={state}
                value={customCue}
                onChange={(val) => setCustomCue(val)}
                autoFocus
                placeholder="Type a custom Grandma phrase (type $ for variables)..."
                aria-label="Custom Grandma phrase"
              />
              <button type="submit" className="btn-amber">
                💬 Say Now
              </button>
            </form>
            {hasGrandmaVariables(customCue) && (
              <div className="grandma-live-preview is-compact" role="status" aria-live="polite">
                <span className="glp-label">Preview:</span>
                <span className="glp-text">“{resolveGrandmaPhrase(customCue, state)}”</span>
              </div>
            )}

            <div className="sk-menu-category">
              <h2>⚡ Contextual Phrases ({contextualPhrases.length})</h2>
              <div className="sk-menu-list">
                {contextualPhrases.map((q, i) => {
                  const resolved = resolveGrandmaPhrase(q, state);
                  return (
                    <button
                      key={`c-${i}`}
                      type="button"
                      className="sk-menu-phrase-btn"
                      onClick={() => handleFirePhrase(q, true)}
                    >
                      <span>▶</span>
                      <span>{resolved}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </dialog>
      {/* Game Selection Menu Modal (Auto-Opens on Match Completion with Highlighted Recommended Next Match) */}
      <dialog
        ref={matchDialogRef}
        className="app-dialog sk-match-dialog"
        closedby="any"
        aria-labelledby="sk-match-menu-title"
      >
        <div className="dialog-surface">
          <header className="dialog-header">
            <h1 id="sk-match-menu-title" className="dialog-title">
              {postCompleteBanner
                ? '🏆 Match Complete — Select Next Game'
                : `🏓 Select Game (${selectableMatches.length})`}
            </h1>
            <button
              type="button"
              className="dialog-close-btn"
              onClick={() => matchDialogRef.current?.close()}
              aria-label="Close game selection menu"
            >
              ✕
            </button>
          </header>

          <div className="dialog-body scroller">
            {postCompleteBanner && (
              <div className="sk-postgame-banner">
                <strong>
                  ✓ {postCompleteBanner.matchLabel} Final ({postCompleteBanner.score1}–
                  {postCompleteBanner.score2})
                  {postCompleteBanner.winnerName ? ` · Winner: ${postCompleteBanner.winnerName}` : ''}
                </strong>
                <span>
                  Choose the next match for {tableCount > 1 ? 'your table' : 'Table 1'} (the
                  recommended next game is highlighted below).
                </span>
              </div>
            )}

            <div className="sk-match-picker-list">
              {selectableMatches.map((m) => {
                const p1 = m.player1Id ? playerMap.get(m.player1Id) : null;
                const p2 = m.player2Id ? playerMap.get(m.player2Id) : null;
                const p1Members = isTeams && p1 ? formatTeamMembers(p1, ' & ') : '';
                const p2Members = isTeams && p2 ? formatTeamMembers(p2, ' & ') : '';
                const isSelected = m.id === state.activeMatchId;
                const isReady = Boolean(p1 && p2 && !m.completed);
                const activeRecId = postCompleteBanner?.recommendedMatchId || recommendedMatchId;
                const isRecommended = Boolean(activeRecId && m.id === activeRecId && isReady);
                const hasScore = m.completed || (m.score1 || 0) > 0 || (m.score2 || 0) > 0;
                const statusLabel = isSelected
                  ? 'ACTIVE'
                  : m.completed
                    ? 'FINAL'
                    : isReady
                      ? 'READY'
                      : 'TBD';

                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`sk-match-picker-card ${isRecommended ? 'is-recommended' : ''} ${isSelected ? 'is-selected' : ''
                      } ${m.completed ? 'is-completed' : isReady ? 'is-ready' : ''}`}
                    onClick={() => {
                      tournamentStore.selectMatch(m.id);
                      matchDialogRef.current?.close();
                    }}
                  >
                    <div className="sk-mp-head">
                      <div className="sk-mp-head-left">
                        <span className="sk-mp-code">
                          {m.label} · {m.roundLabel}
                          {tableCount > 1 && m.tableNumber ? ` · Table ${m.tableNumber}` : ''}
                        </span>
                        {isRecommended && (
                          <span className="sk-mp-recommended-badge">★ RECOMMENDED NEXT</span>
                        )}
                      </div>
                      <div className="sk-mp-badges">
                        {hasScore && (
                          <span className="sk-mp-score">
                            {m.score1}–{m.score2}
                          </span>
                        )}
                        <span className={`sk-mp-status is-${statusLabel.toLowerCase()}`}>
                          {statusLabel}
                        </span>
                      </div>
                    </div>

                    <div className="sk-mp-matchup">
                      <div className="sk-mp-side">
                        <strong className="sk-mp-name">
                          {p1 ? `#${p1.seed} ${p1.name}` : m.source1Label}
                        </strong>
                        {p1Members && <span className="sk-mp-members">{p1Members}</span>}
                      </div>

                      <span className="sk-mp-vs">vs</span>

                      <div className="sk-mp-side is-right">
                        <strong className="sk-mp-name">
                          {p2 ? `#${p2.seed} ${p2.name}` : m.source2Label}
                        </strong>
                        {p2Members && <span className="sk-mp-members">{p2Members}</span>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </dialog>

      {pendingTableSwitch && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="sk-table-switch-warn-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingTableSwitch(null);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 120,
            background: 'rgba(2, 6, 23, 0.82)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
          }}
        >
          <div
            style={{
              width: 'min(460px, 100%)',
              borderRadius: '16px',
              padding: '1.25rem 1.35rem',
              background: 'linear-gradient(180deg, #1e1312 0%, #0f172a 100%)',
              border: '2px solid rgba(245, 158, 11, 0.82)',
              boxShadow: '0 24px 60px rgba(0, 0, 0, 0.65), 0 0 28px rgba(245, 158, 11, 0.22)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <span style={{ fontSize: '1.55rem', lineHeight: 1 }} aria-hidden="true">
                ⚠️
              </span>
              <h2
                id="sk-table-switch-warn-title"
                style={{
                  margin: 0,
                  fontSize: '1.08rem',
                  fontWeight: 800,
                  color: '#fde68a',
                }}
              >
                Live Game In Progress on Table {pendingTableSwitch.fromTable}
              </h2>
            </div>

            <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5, color: '#e2e8f0' }}>
              You are currently scoring{' '}
              <strong>
                {pendingTableSwitch.matchLabel} ({pendingTableSwitch.playersText},{' '}
                {pendingTableSwitch.scoreText})
              </strong>{' '}
              on <strong>Table {pendingTableSwitch.fromTable}</strong>.
            </p>

            <p style={{ margin: 0, fontSize: '0.84rem', lineHeight: 1.45, color: '#cbd5e1' }}>
              Scorekeepers should normally stay on one table until the game finishes so points
              aren&apos;t accidentally recorded on the wrong match. Are you sure you want to leave{' '}
              <strong>Table {pendingTableSwitch.fromTable}</strong> and switch to{' '}
              <strong>Table {pendingTableSwitch.toTable}</strong>?
            </p>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
                gap: '0.55rem',
                marginTop: '0.25rem',
              }}
            >
              <button
                type="button"
                className="btn-amber"
                onClick={() => setPendingTableSwitch(null)}
              >
                Stay on Table {pendingTableSwitch.fromTable}
              </button>
              <button
                type="button"
                className="btn-danger-outline"
                onClick={() => {
                  const target = pendingTableSwitch.toTable;
                  setPendingTableSwitch(null);
                  commitScorekeeperTableSwitch(target);
                }}
              >
                Switch to Table {pendingTableSwitch.toTable} Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      <DebounceOverrideDialog
        request={debounceRequest}
        onConfirm={handleConfirmDebounceOverride}
        onCancel={() => setDebounceRequest(null)}
      />

      {(isFullscreen || isPopout) && tabId && (
        <span className="floating-session-id-pill" title={`Current Session ID: ${tabId}`}>
          {tabId}
        </span>
      )}
    </div>
  );
}
