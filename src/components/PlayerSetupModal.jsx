import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  clampPlayerCount,
  generateAutoTeamName,
  generateRandomTeamName,
  generateDemoPlayerName,
  generateRandomDemoPlayerName,
  isNeutralPlayerName,
  isNeutralTeamName,
  MIN_PLAYERS,
  MAX_PLAYERS,
  nextPowerOfTwo,
} from '../engine/bracketGenerator.js';
import {
  SCORE_FONT_OPTIONS,
  THEME_OPTIONS,
  AMBIANCE_OPTIONS,
} from '../state/tournamentStore.js';

function makeRosterPlayerId() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function shuffleArray(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Normalizes the single-source Player Roster to `count` players.
 */
function resizePlayerRoster(count, prevRoster, { demoMode = false, forceRegenerate = false } = {}) {
  const target = clampPlayerCount(count);
  return Array.from({ length: target }, (_, i) => {
    const prev = prevRoster?.[i];
    const defaultName = demoMode ? generateDemoPlayerName(i) : `Player ${i + 1}`;
    const existing = String(prev?.name || '').trim();
    let name;
    if (forceRegenerate) {
      name = defaultName;
    } else if (existing) {
      name = demoMode && isNeutralPlayerName(existing) ? defaultName : existing;
    } else {
      name = defaultName;
    }
    return {
      id: prev?.id || `r${i + 1}`,
      name,
    };
  });
}

/**
 * Generates Teams (2v2) by randomly pairing the Player Roster.
 * Preserves custom team names unless forceRegenerateTeamNames is true.
 */
function generateRandomTeamsFromRoster(
  roster,
  prevTeams = [],
  { autoTeamNames = false, forceRegenerateTeamNames = false } = {}
) {
  const shuffled = shuffleArray(roster);
  const teamCount = Math.max(2, Math.ceil(shuffled.length / 2));
  return Array.from({ length: teamCount }, (_, i) => {
    const pA = shuffled[i * 2] || null;
    const pB = shuffled[i * 2 + 1] || null;
    const existingName = prevTeams[i]?.name?.trim() || '';
    const defaultTeamName = autoTeamNames ? generateAutoTeamName(i) : `Team ${i + 1}`;
    let teamName;
    if (forceRegenerateTeamNames) {
      teamName = defaultTeamName;
    } else if (existingName) {
      teamName =
        autoTeamNames && isNeutralTeamName(existingName) ? defaultTeamName : existingName;
    } else {
      teamName = defaultTeamName;
    }
    return {
      id: `p${i + 1}`,
      seed: i + 1,
      name: teamName,
      memberIds: [pA?.id || '', pB?.id || ''],
      members: [pA?.name || '', pB?.name || ''],
    };
  });
}

/**
 * Syncs existing Teams with an updated Player Roster:
 *  - Updates member display names if a player was renamed in the roster
 *  - Keeps existing team pairings intact
 *  - Removes deleted roster players and randomly pairs any newly added players into open/new slots
 */
function reconcileTeamsWithRoster(roster, prevTeams, { autoTeamNames = false } = {}) {
  const rosterMap = new Map(roster.map((r) => [r.id, r]));
  const teamCount = Math.max(2, Math.ceil(roster.length / 2));
  const usedIds = new Set();

  // Keep valid existing assignments first
  const teams = Array.from({ length: teamCount }, (_, i) => {
    const prev = prevTeams?.[i];
    const prevIds = Array.isArray(prev?.memberIds) ? prev.memberIds : ['', ''];
    const idA = prevIds[0] && rosterMap.has(prevIds[0]) && !usedIds.has(prevIds[0]) ? prevIds[0] : '';
    if (idA) usedIds.add(idA);
    const idB = prevIds[1] && rosterMap.has(prevIds[1]) && !usedIds.has(prevIds[1]) ? prevIds[1] : '';
    if (idB) usedIds.add(idB);

    const existingName = prev?.name?.trim() || '';
    const defaultTeamName = autoTeamNames ? generateAutoTeamName(i) : `Team ${i + 1}`;
    const teamName = existingName || defaultTeamName;

    return {
      id: `p${i + 1}`,
      seed: i + 1,
      name: teamName,
      memberIds: [idA, idB],
      members: [idA ? rosterMap.get(idA).name : '', idB ? rosterMap.get(idB).name : ''],
    };
  });

  // Randomly assign any unassigned roster players into open team slots
  const unassigned = shuffleArray(roster.filter((r) => !usedIds.has(r.id)));
  let uIdx = 0;
  for (let i = 0; i < teams.length && uIdx < unassigned.length; i++) {
    if (!teams[i].memberIds[0]) {
      const p = unassigned[uIdx++];
      teams[i].memberIds[0] = p.id;
      teams[i].members[0] = p.name;
    }
    if (!teams[i].memberIds[1] && uIdx < unassigned.length) {
      const p = unassigned[uIdx++];
      teams[i].memberIds[1] = p.id;
      teams[i].members[1] = p.name;
    }
  }

  return teams;
}

function extractInitialRosterAndTeams(state) {
  const isTeams = state.entryMode === 'teams';
  let roster;
  if (Array.isArray(state.roster) && state.roster.length > 0) {
    roster = state.roster.map((r, idx) => ({
      id: r.id || `r${idx + 1}`,
      name: r.name || `Player ${idx + 1}`,
    }));
  } else if (isTeams) {
    const names = (state.players || [])
      .flatMap((t) => (Array.isArray(t.members) ? t.members : []))
      .filter(Boolean);
    roster = names.map((name, idx) => ({ id: `r${idx + 1}`, name }));
  } else {
    roster = (state.players || []).map((p, idx) => ({
      id: `r${idx + 1}`,
      name: p.name || `Player ${idx + 1}`,
    }));
  }

  if (roster.length < MIN_PLAYERS) {
    roster = resizePlayerRoster(state.totalPlayers || state.playerCount || 8, roster, {
      demoMode: Boolean(state.demoMode),
    });
  }

  let teams = [];
  if (isTeams) {
    const nameToIds = new Map();
    for (const r of roster) {
      if (!nameToIds.has(r.name)) nameToIds.set(r.name, []);
      nameToIds.get(r.name).push(r.id);
    }
    const usedIds = new Set();
    const resolveMemberId = (explicitId, memberName) => {
      if (explicitId && roster.some((r) => r.id === explicitId) && !usedIds.has(explicitId)) {
        usedIds.add(explicitId);
        return explicitId;
      }
      const candidates = nameToIds.get(memberName) || [];
      const found = candidates.find((id) => !usedIds.has(id));
      if (found) {
        usedIds.add(found);
        return found;
      }
      return '';
    };

    const hydrated = (state.players || []).map((t, idx) => {
      const m0 = t.members?.[0] || '';
      const m1 = t.members?.[1] || '';
      const id0 = resolveMemberId(t.memberIds?.[0], m0);
      const id1 = resolveMemberId(t.memberIds?.[1], m1);
      return {
        id: `p${idx + 1}`,
        seed: idx + 1,
        name: t.name || `Team ${idx + 1}`,
        memberIds: [id0, id1],
        members: [m0, m1],
      };
    });
    teams = reconcileTeamsWithRoster(roster, hydrated, {
      autoTeamNames: Boolean(state.autoTeamNames),
    });
  }

  return { roster, teams };
}

/**
 * Unified Tournament Setup, Game Rules, Themes, Ambiance & Single-Source Player Roster Modal.
 * Always presents a clean Player Roster; in Teams (2v2) mode, teams are generated randomly
 * from the Player Roster and can be freely overridden (team name + partner dropdowns with smart swap).
 */
export default function PlayerSetupModal({
  open,
  onClose,
  state,
  onApplySetup,
  onRandomizeSeeds,
  onResetTournament,
}) {
  const dialogRef = useRef(null);
  const wasOpenRef = useRef(false);

  const initData = useMemo(() => extractInitialRosterAndTeams(state), []);

  const [draftName, setDraftName] = useState(state.tournamentName);
  const [draftFormat, setDraftFormat] = useState(state.format);
  const [draftEntryMode, setDraftEntryMode] = useState(state.entryMode || 'singles');
  const [draftAutoTeamNames, setDraftAutoTeamNames] = useState(Boolean(state.autoTeamNames));
  const [draftTargetPoints, setDraftTargetPoints] = useState(state.rules?.targetPoints ?? 11);
  const [draftServeRotation, setDraftServeRotation] = useState(state.rules?.serveRotation ?? 2);
  const [draftWinBy, setDraftWinBy] = useState(state.rules?.winBy ?? 2);
  const [draftSkunk, setDraftSkunk] = useState(state.rules?.skunkEnabled ? String(state.rules?.skunkScore ?? 7) : '0');
  const [draftDeadMansServe, setDraftDeadMansServe] = useState(
    Boolean(state.rules?.deadMansServe)
  );
  const [draftTableCount, setDraftTableCount] = useState(state.rules?.tableCount ?? 1);
  const [draftRequireScorekeeperApproval, setDraftRequireScorekeeperApproval] = useState(
    state.rules?.requireScorekeeperApproval !== false
  );
  const [draftAllowScorekeeperGrandma, setDraftAllowScorekeeperGrandma] = useState(
    state.rules?.allowScorekeeperGrandma !== false
  );
  const [draftDebounceSec, setDraftDebounceSec] = useState(state.rules?.scoreDebounceSec ?? 1);
  const [draftScoreFont, setDraftScoreFont] = useState(state.ui?.scoreFont || 'barlow');
  const [draftTheme, setDraftTheme] = useState(state.ui?.theme || 'arena');
  const [draftAmbiance, setDraftAmbiance] = useState(state.presentation?.titleAmbiance || 'auto');
  const [draftIntensity, setDraftIntensity] = useState(
    state.presentation?.ambianceIntensity || 'medium'
  );
  const [draftShowMiniBracket, setDraftShowMiniBracket] = useState(
    state.ui?.showMiniBracket !== false
  );
  const [draftRoster, setDraftRoster] = useState(initData.roster);
  const [draftTeams, setDraftTeams] = useState(initData.teams);
  const [draftSeedsRandomized, setDraftSeedsRandomized] = useState(false);
  const [draftApplyMode, setDraftApplyMode] = useState('preserve'); // 'preserve' | 'rebuild'
  const [rosterSearch, setRosterSearch] = useState('');
  const [newPlayerName, setNewPlayerName] = useState('');
  const [suggestedDemoName, setSuggestedDemoName] = useState(() =>
    state.demoMode ? generateRandomDemoPlayerName(initData.roster.map((p) => p.name)) : ''
  );
  const newPlayerInputRef = useRef(null);

  // Snapshot live state only on closed -> open transition
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const { roster, teams } = extractInitialRosterAndTeams(state);
      setDraftName(state.tournamentName);
      setDraftFormat(state.format);
      setDraftEntryMode(state.entryMode || 'singles');
      setDraftAutoTeamNames(Boolean(state.autoTeamNames));
      setDraftTargetPoints(state.rules?.targetPoints ?? 11);
      setDraftServeRotation(state.rules?.serveRotation ?? 2);
      setDraftWinBy(state.rules?.winBy ?? 2);
      setDraftSkunk(state.rules?.skunkEnabled ? String(state.rules?.skunkScore ?? 7) : '0');
      setDraftDeadMansServe(Boolean(state.rules?.deadMansServe));
      setDraftTableCount(state.rules?.tableCount ?? 1);
      setDraftRequireScorekeeperApproval(state.rules?.requireScorekeeperApproval !== false);
      setDraftAllowScorekeeperGrandma(state.rules?.allowScorekeeperGrandma !== false);
      setDraftDebounceSec(state.rules?.scoreDebounceSec ?? 1);
      setDraftScoreFont(state.ui?.scoreFont || 'barlow');
      setDraftTheme(state.ui?.theme || 'arena');
      setDraftAmbiance(state.presentation?.titleAmbiance || 'auto');
      setDraftIntensity(state.presentation?.ambianceIntensity || 'medium');
      setDraftShowMiniBracket(state.ui?.showMiniBracket !== false);
      setDraftRoster(roster);
      setDraftTeams(teams);
      setDraftSeedsRandomized(false);
      setDraftApplyMode('preserve');
      setRosterSearch('');
      setNewPlayerName('');
      setSuggestedDemoName(
        state.demoMode ? generateRandomDemoPlayerName(roster.map((p) => p.name)) : ''
      );
    }
    wasOpenRef.current = open;
  }, [open, state]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const handleClose = () => {
      dialog.returnValue = '';
      onClose?.();
    };
    dialog.addEventListener('close', handleClose);

    let removeFallback = () => {};
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
        if (pressedOutside && isOutside(e)) {
          dialog.close();
        }
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
  }, [onClose]);

  const isTeams = draftEntryMode === 'teams';
  const minHumans = isTeams ? 4 : MIN_PLAYERS;
  const draftHumanCount = draftRoster.length;
  const hasEnoughPlayers = draftHumanCount >= minHumans;
  const safeHumanCount = Math.max(minHumans, draftHumanCount);
  const entrantCount = isTeams ? Math.max(2, Math.ceil(safeHumanCount / 2)) : safeHumanCount;

  const handleModeChange = (nextMode) => {
    if (nextMode === draftEntryMode) return;
    setDraftEntryMode(nextMode);
    if (nextMode === 'teams') {
      // Generate teams randomly from the Player Roster when entering Teams mode
      setDraftTeams(
        generateRandomTeamsFromRoster(draftRoster, draftTeams, {
          autoTeamNames: draftAutoTeamNames,
        })
      );
    }
  };

  const handleToggleAutoTeamNames = (checked) => {
    setDraftAutoTeamNames(checked);
    if (isTeams) {
      setDraftTeams((prev) =>
        prev.map((t, i) => ({
          ...t,
          name: checked ? generateAutoTeamName(i) : `Team ${i + 1}`,
        }))
      );
    }
  };

  const handleRosterNameChange = (idx, value) => {
    const nextRoster = draftRoster.map((p, i) => (i === idx ? { ...p, name: value } : p));
    setDraftRoster(nextRoster);
    if (isTeams) {
      const targetId = nextRoster[idx]?.id;
      setDraftTeams((prev) =>
        prev.map((t) => {
          const m0 = t.memberIds[0] === targetId ? value : t.members[0];
          const m1 = t.memberIds[1] === targetId ? value : t.members[1];
          return { ...t, members: [m0, m1] };
        })
      );
    }
  };

  const handleRandomizeTeams = () => {
    setDraftTeams((prev) =>
      generateRandomTeamsFromRoster(draftRoster, prev, {
        autoTeamNames: draftAutoTeamNames,
      })
    );
  };

  const handleTeamNameOverride = (teamIdx, value) => {
    setDraftTeams((prev) =>
      prev.map((t, i) => (i === teamIdx ? { ...t, name: value } : t))
    );
  };

  const handleRerollTeamName = (teamIdx) => {
    setDraftTeams((prev) => {
      const existingNames = prev.map((t) => t.name);
      const nextName = generateRandomTeamName(existingNames);
      return prev.map((t, i) => (i === teamIdx ? { ...t, name: nextName } : t));
    });
  };

  // Manual team member override with automatic smart-swap (prevents duplicate players across teams)
  const handleTeamMemberOverride = (teamIdx, slotIdx, newRosterId) => {
    const rosterMap = new Map(draftRoster.map((r) => [r.id, r]));
    setDraftTeams((prev) => {
      const next = prev.map((t) => ({
        ...t,
        memberIds: [...t.memberIds],
        members: [...t.members],
      }));
      const prevIdInTarget = next[teamIdx].memberIds[slotIdx];

      // Find if newRosterId is currently assigned elsewhere and swap cleanly
      if (newRosterId) {
        for (let ti = 0; ti < next.length; ti++) {
          for (let si = 0; si < 2; si++) {
            if (ti === teamIdx && si === slotIdx) continue;
            if (next[ti].memberIds[si] === newRosterId) {
              next[ti].memberIds[si] = prevIdInTarget;
              next[ti].members[si] = prevIdInTarget
                ? rosterMap.get(prevIdInTarget)?.name || ''
                : '';
            }
          }
        }
      }

      next[teamIdx].memberIds[slotIdx] = newRosterId;
      next[teamIdx].members[slotIdx] = newRosterId ? rosterMap.get(newRosterId)?.name || '' : '';
      return next;
    });
  };

  const nextDefaultPlayerName = state.demoMode
    ? suggestedDemoName || generateRandomDemoPlayerName(draftRoster.map((p) => p.name))
    : `Player ${draftRoster.length + 1}`;

  const handleAddPlayer = () => {
    if (draftRoster.length >= MAX_PLAYERS) return;
    const typed = newPlayerName.trim();
    const addedName = typed || nextDefaultPlayerName;
    const nextRoster = [
      ...draftRoster,
      { id: makeRosterPlayerId(), name: addedName },
    ];
    setRosterSearch('');
    setNewPlayerName('');
    setDraftRoster(nextRoster);
    if (state.demoMode) {
      setSuggestedDemoName(generateRandomDemoPlayerName(nextRoster.map((p) => p.name)));
    }
    if (isTeams) {
      setDraftTeams((prev) =>
        reconcileTeamsWithRoster(nextRoster, prev, {
          autoTeamNames: draftAutoTeamNames,
        })
      );
    }
    requestAnimationFrame(() => newPlayerInputRef.current?.focus());
  };

  const handleRemovePlayer = (idx) => {
    const nextRoster = draftRoster.filter((_, i) => i !== idx);
    setDraftRoster(nextRoster);
    if (isTeams) {
      setDraftTeams((prev) =>
        reconcileTeamsWithRoster(nextRoster, prev, {
          autoTeamNames: draftAutoTeamNames,
        })
      );
    }
  };

  // Preview-only seed randomization inside the Setup modal (does not close or apply until Saved)
  const handlePreviewRandomizeSeeds = () => {
    setDraftSeedsRandomized(true);
    if (isTeams) {
      setDraftTeams((prev) =>
        shuffleArray(prev).map((t, idx) => ({
          ...t,
          id: `p${idx + 1}`,
          seed: idx + 1,
        }))
      );
    } else {
      setDraftRoster((prev) => shuffleArray(prev));
    }
  };

  const filteredRoster = useMemo(() => {
    const q = rosterSearch.trim().toLowerCase();
    const mapped = draftRoster.map((player, idx) => ({ player, idx }));
    if (!q) return mapped;
    return mapped.filter(
      ({ player, idx }) =>
        `#${idx + 1}`.includes(q) || player.name.toLowerCase().includes(q)
    );
  }, [draftRoster, rosterSearch]);

  const mustFullRebuild =
    draftFormat !== state.format ||
    draftEntryMode !== (state.entryMode || 'singles') ||
    entrantCount < state.playerCount;
  const effectiveApplyMode = mustFullRebuild ? 'rebuild' : draftApplyMode;
  const willRebuildBracket = effectiveApplyMode === 'rebuild';
  const isAddingMidTournament = !willRebuildBracket && entrantCount > state.playerCount;
  const isAddingPlayerToSoloTeam =
    !willRebuildBracket &&
    isTeams &&
    entrantCount === state.playerCount &&
    draftHumanCount > (state.totalPlayers || state.roster?.length || 0);
  const byeCount = nextPowerOfTwo(entrantCount) - entrantCount;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!hasEnoughPlayers) return;
    const finalEntrants = isTeams
      ? draftTeams.map((t, idx) => ({
          id: `p${idx + 1}`,
          seed: idx + 1,
          name: t.name.trim() || `Team ${idx + 1}`,
          memberIds: [...t.memberIds],
          members: [...t.members],
        }))
      : draftRoster.map((r, idx) => ({
          id: `p${idx + 1}`,
          seed: idx + 1,
          name: r.name.trim() || `Player ${idx + 1}`,
        }));

    onApplySetup({
      tournamentName: draftName,
      entryMode: draftEntryMode,
      autoTeamNames: draftAutoTeamNames,
      format: draftFormat,
      playerCount: entrantCount,
      totalPlayers: draftHumanCount,
      roster: draftRoster,
      rules: {
        targetPoints: Math.max(1, Math.floor(Number(draftTargetPoints) || 11)),
        serveRotation: Math.max(1, Math.floor(Number(draftServeRotation) || 2)),
        winBy: Math.max(1, Math.floor(Number(draftWinBy) || 2)),
        skunkEnabled: Math.floor(Number(draftSkunk) || 0) > 0,
        skunkScore: Math.max(1, Math.floor(Number(draftSkunk) || 0) || 7),
        deadMansServe: Boolean(draftDeadMansServe),
        tableCount: Math.max(1, Math.floor(Number(draftTableCount) || 1)),
        requireScorekeeperApproval: Boolean(draftRequireScorekeeperApproval),
        allowScorekeeperGrandma: Boolean(draftAllowScorekeeperGrandma),
        scoreDebounceSec: Math.max(0, Number(draftDebounceSec) || 0),
      },
      theme: draftTheme,
      titleAmbiance: draftAmbiance,
      ambianceIntensity: draftIntensity,
      scoreFont: draftScoreFont,
      showMiniBracket: draftShowMiniBracket,
      players: finalEntrants,
      rebuildBracket: willRebuildBracket,
    });
    dialogRef.current?.close();
  };

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog setup-dialog is-wide"
      closedby="any"
      aria-labelledby="player-setup-heading"
    >
      <div className="dialog-surface">
        <header className="dialog-header">
          <h1 id="player-setup-heading" className="dialog-title">
            ⚙ Tournament Setup, Rules &amp; Player Roster
          </h1>
          <button
            type="button"
            className="dialog-close-btn"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close tournament setup dialog"
          >
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit} className="dialog-body scroller">
          {/* Section 1: Single-Source Player Roster (Always Individual Players!) */}
          <div className="setup-section-box">
            <div className="players-grid-header">
              <h2 className="setup-section-heading">
                Player Roster ({draftHumanCount} Player{draftHumanCount === 1 ? '' : 's'})
              </h2>
              <div className="inline-actions">
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={handlePreviewRandomizeSeeds}
                  disabled={draftHumanCount < 2}
                  title="Preview a randomized seed order (only takes effect when saved)"
                >
                  🎲 Randomize Seeds
                </button>
                <button
                  type="button"
                  className="btn-danger-outline btn-sm"
                  onClick={() => {
                    onResetTournament();
                    dialogRef.current?.close();
                  }}
                >
                  ↺ Reset Scores
                </button>
              </div>
            </div>

            <div
              className="roster-add-row"
              style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.65rem' }}
            >
              <input
                ref={newPlayerInputRef}
                type="text"
                value={newPlayerName}
                onChange={(e) => setNewPlayerName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddPlayer();
                  }
                }}
                autoFocus
                placeholder={nextDefaultPlayerName}
                aria-label="Add player name"
                disabled={draftHumanCount >= MAX_PLAYERS}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={handleAddPlayer}
                disabled={draftHumanCount >= MAX_PLAYERS}
              >
                + Add
              </button>
            </div>

            {!hasEnoughPlayers && (
              <p className="setup-notice" style={{ marginBottom: '0.5rem' }}>
                Add at least {minHumans} players ({isTeams ? '4 required for Teams' : '2 minimum'}) to save the tournament.
              </p>
            )}

            {draftSeedsRandomized && (
              <p className="setup-info">
                🎲 Previewing randomized {isTeams ? 'team' : 'player'} seeds below — changes will
                only take effect when you click Save (Cancel discards this preview).
              </p>
            )}

            {draftHumanCount > 16 && (
              <div className="roster-filter-row">
                <input
                  type="search"
                  value={rosterSearch}
                  onChange={(e) => setRosterSearch(e.target.value)}
                  placeholder={`Filter ${draftHumanCount} players by name or #number...`}
                  aria-label="Filter player roster"
                />
                <span className="roster-filter-count">
                  Showing {filteredRoster.length} / {draftHumanCount}
                </span>
              </div>
            )}

            <div className="roster-scroll-box scroller">
              {draftHumanCount === 0 ? (
                <p className="panel-subtitle" style={{ margin: '0.4rem 0' }}>
                  No players yet — type a name above and click <strong>+ Add</strong>.
                </p>
              ) : (
                <div className="player-inputs-grid">
                  {filteredRoster.map(({ player, idx }) => (
                    <div key={player.id} className="player-input-row">
                      <span className="seed-tag">#{idx + 1}</span>
                      <input
                        type="text"
                        value={player.name}
                        onChange={(e) => handleRosterNameChange(idx, e.target.value)}
                        placeholder={`Player ${idx + 1}`}
                        aria-label={`Player ${idx + 1} name`}
                      />
                      <button
                        type="button"
                        className="btn-danger-outline btn-sm"
                        onClick={() => handleRemovePlayer(idx)}
                        aria-label={`Remove ${player.name || `Player ${idx + 1}`}`}
                        title="Remove player"
                        style={{ padding: '0.25rem 0.45rem', flexShrink: 0 }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Section 2 (Teams Mode Only): Randomly Generated Teams with Manual Override */}
          {isTeams && (
            <div className="setup-section-box">
              <div className="players-grid-header">
                <div>
                  <h2 className="setup-section-heading">
                    Generated Teams ({draftTeams.length} Teams · Override Anytime)
                  </h2>
                  <p className="team-override-hint">
                    Paired randomly from your Player Roster. Pick any player in a dropdown to swap
                    partners or rename any team.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-amber btn-sm"
                  onClick={handleRandomizeTeams}
                >
                  🎲 Re-Roll Random Teams
                </button>
              </div>

              <div className="roster-scroll-box scroller">
                <div className="team-inputs-grid">
                  {draftTeams.map((team, idx) => (
                    <div key={team.id} className="team-input-card">
                      <div className="team-card-top">
                        <span className="seed-tag">#{team.seed}</span>
                        <div className="team-name-field-wrap">
                          <input
                            type="text"
                            value={team.name}
                            onChange={(e) => handleTeamNameOverride(idx, e.target.value)}
                            placeholder={`Team ${team.seed}`}
                            aria-label={`Override Team ${team.seed} name`}
                            className="team-name-input"
                          />
                          <button
                            type="button"
                            className="team-name-reroll-btn"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleRerollTeamName(idx)}
                            title="Roll random team name"
                            aria-label={`Roll random name for Team ${team.seed}`}
                          >
                            🎲
                          </button>
                        </div>
                      </div>
                      <div className="team-members-inputs">
                        <select
                          value={team.memberIds[0] || ''}
                          onChange={(e) => handleTeamMemberOverride(idx, 0, e.target.value)}
                          aria-label={`Team ${team.seed} Player A`}
                          className="team-member-select"
                        >
                          <option value="">— Unassigned —</option>
                          {draftRoster.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <span className="member-amp" aria-hidden="true">
                          &amp;
                        </span>
                        <select
                          value={team.memberIds[1] || ''}
                          onChange={(e) => handleTeamMemberOverride(idx, 1, e.target.value)}
                          aria-label={`Team ${team.seed} Player B`}
                          className="team-member-select"
                        >
                          <option value="">— Solo / None —</option>
                          {draftRoster.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Section 3: Identity & Format */}
          <div className="setup-section-box">
            <h2 className="setup-section-heading">Tournament Format &amp; Size</h2>

            <div className="form-field">
              <label htmlFor="tournament-title-input">Tournament Banner Title</label>
              <input
                id="tournament-title-input"
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Grand Retro Ping Pong Championship"
              />
            </div>

            <div className="setup-config-row">
              <div className="form-field">
                <span className="field-label">Competition Mode</span>
                <div className="segmented-control">
                  <button
                    type="button"
                    className={!isTeams ? 'is-selected' : ''}
                    onClick={() => handleModeChange('singles')}
                  >
                    👤 Singles (1v1)
                  </button>
                  <button
                    type="button"
                    className={isTeams ? 'is-selected' : ''}
                    onClick={() => handleModeChange('teams')}
                  >
                    👥 Teams / Doubles (2v2)
                  </button>
                </div>
              </div>

              <div className="form-field">
                <span className="field-label">Elimination Format</span>
                <div className="segmented-control">
                  <button
                    type="button"
                    className={draftFormat === 'single' ? 'is-selected' : ''}
                    onClick={() => setDraftFormat('single')}
                  >
                    Single Elim
                  </button>
                  <button
                    type="button"
                    className={draftFormat === 'double' ? 'is-selected' : ''}
                    onClick={() => setDraftFormat('double')}
                  >
                    Double Elim
                  </button>
                </div>
              </div>
            </div>

            {isTeams && (
              <p className="setup-info">
                {draftHumanCount} player{draftHumanCount === 1 ? '' : 's'} →{' '}
                <strong>{entrantCount} randomly paired teams</strong> (2v2
                {draftHumanCount % 2 === 1
                  ? ` · ${Math.floor(draftHumanCount / 2)} pairs + 1 solo slot`
                  : ''}
                )
              </p>
            )}

            {byeCount > 0 && (
              <p className="setup-info">
                Top {byeCount} seed{byeCount === 1 ? '' : 's'} will automatically receive a Round 1
                BYE inside a {nextPowerOfTwo(entrantCount)}-{isTeams ? 'team' : 'slot'} bracket.
              </p>
            )}

            {(isAddingMidTournament || isAddingPlayerToSoloTeam) && (
              <p className="setup-info">
                ✓ Adding new {isTeams ? 'player(s) / team(s)' : 'player(s)'} mid-tournament —
                existing match scores and completed rounds will be preserved without rebuilding!
              </p>
            )}

            {mustFullRebuild && (
              <p className="setup-notice">
                Changing competition mode, elimination format, or reducing {isTeams ? 'teams' : 'players'} will rebuild the bracket schedule cleanly.
              </p>
            )}
          </div>

          {/* Section 2: Game Rules, Themes, Ambiance & Display Options */}
          <div className="setup-section-box">
            <h2 className="setup-section-heading">Game Rules, Themes &amp; Display</h2>

            <div className="setup-rules-numbers-grid">
              <div className="form-field">
                <label htmlFor="setup-target-points">Game Points</label>
                <div className="custom-sec-input-wrap">
                  <input
                    id="setup-target-points"
                    type="number"
                    min="1"
                    step="1"
                    value={draftTargetPoints}
                    onChange={(e) => setDraftTargetPoints(e.target.value)}
                    className="count-number-input"
                  />
                  <span className="sec-unit">pts</span>
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="setup-serve-rotation">Switch Serve Every</label>
                <div className="custom-sec-input-wrap">
                  <input
                    id="setup-serve-rotation"
                    type="number"
                    min="1"
                    step="1"
                    value={draftServeRotation}
                    onChange={(e) => setDraftServeRotation(e.target.value)}
                    className="count-number-input"
                  />
                  <span className="sec-unit">pts (1 in Deuce)</span>
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="setup-dead-mans-serve">Dead Man's Serve</label>
                <div className="custom-sec-input-wrap">
                  <label className="toggle-label">
                    <input
                      id="setup-dead-mans-serve"
                      type="checkbox"
                      checked={draftDeadMansServe}
                      onChange={(e) => setDraftDeadMansServe(e.target.checked)}
                    />
                    <span>{draftDeadMansServe ? 'On (trailing player serves at Game Point)' : 'Off'}</span>
                  </label>
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="setup-win-by">Win By</label>
                <div className="custom-sec-input-wrap">
                  <input
                    id="setup-win-by"
                    type="number"
                    min="1"
                    step="1"
                    value={draftWinBy}
                    onChange={(e) => setDraftWinBy(e.target.value)}
                    className="count-number-input"
                  />
                  <span className="sec-unit">
                    {Number(draftWinBy) === 1 ? 'pt (Sudden Death)' : 'pts'}
                  </span>
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="setup-table-count">Number of Tables</label>
                <div className="custom-sec-input-wrap">
                  <input
                    id="setup-table-count"
                    type="number"
                    min="1"
                    step="1"
                    value={draftTableCount}
                    onChange={(e) => setDraftTableCount(e.target.value)}
                    className="count-number-input"
                  />
                  <span className="sec-unit">
                    {Number(draftTableCount) === 1 ? 'table' : 'tables'}
                  </span>
                </div>
              </div>
            </div>

            <div className="setup-config-row">
              <div className="form-field">
                <label htmlFor="setup-skunk-score">Skunk Rule (Shutout Auto-Win)</label>
                <div className="custom-sec-input-wrap">
                  <input
                    id="setup-skunk-score"
                    type="number"
                    min="0"
                    step="1"
                    value={draftSkunk}
                    onChange={(e) => setDraftSkunk(e.target.value)}
                    className="count-number-input"
                  />
                  <span className="sec-unit">
                    {Math.floor(Number(draftSkunk) || 0) > 0
                      ? `pts (${Math.floor(Number(draftSkunk))}–0 shutout wins)`
                      : 'pts (0 = Off)'}
                  </span>
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="debounce-sec-input">
                  Multi-Scorekeeper Debounce Timer (Seconds · 0 = Off)
                </label>
                <div className="custom-sec-input-wrap">
                  <input
                    id="debounce-sec-input"
                    type="number"
                    min="0"
                    step="any"
                    value={draftDebounceSec}
                    onChange={(e) => setDraftDebounceSec(e.target.value)}
                    className="count-number-input"
                    placeholder="0"
                  />
                  <span className="sec-unit">
                    {Number(draftDebounceSec) > 0
                      ? `sec (${Number(draftDebounceSec)}s guard)`
                      : 'sec (Off)'}
                  </span>
                </div>
              </div>
            </div>

            <div className="setup-config-row font-selector-row">
              <div className="form-field">
                <span className="field-label">Scoreboard Font</span>
                <div className="segmented-control compact">
                  {SCORE_FONT_OPTIONS.map((font) => (
                    <button
                      key={font.id}
                      type="button"
                      className={draftScoreFont === font.id ? 'is-selected' : ''}
                      onClick={() => setDraftScoreFont(font.id)}
                    >
                      {font.label}
                    </button>
                  ))}
                </div>
              </div>

              <div
                className={`font-live-preview score-font-${draftScoreFont}`}
                aria-label="Scoreboard font preview"
              >
                <span className="font-preview-lbl">LIVE PREVIEW</span>
                <div className="font-preview-digits">
                  <span className="digital-score fp-p1">11</span>
                  <span className="fp-colon">:</span>
                  <span className="digital-score fp-p2">09</span>
                </div>
              </div>
            </div>

            <div className="form-field">
              <span className="field-label">Seasonal / Holiday Theme (All Slides)</span>
              <div className="theme-pills-grid">
                {THEME_OPTIONS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`theme-pill-btn ${draftTheme === t.id ? 'is-selected' : ''}`}
                    onClick={() => setDraftTheme(t.id)}
                  >
                    <span>{t.icon}</span>
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="setup-config-row">
              <div className="form-field">
                <label htmlFor="setup-ambiance-select">Presentation Ambiance (All Slides)</label>
                <select
                  id="setup-ambiance-select"
                  className="panel-select"
                  value={draftAmbiance}
                  onChange={(e) => setDraftAmbiance(e.target.value)}
                >
                  {AMBIANCE_OPTIONS.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <span className="field-label">Ambiance Intensity</span>
                <div className="segmented-control compact">
                  {['low', 'medium', 'high'].map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      className={draftIntensity === lvl ? 'is-selected' : ''}
                      onClick={() => setDraftIntensity(lvl)}
                    >
                      {lvl[0].toUpperCase() + lvl.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="setup-toggles-row">
              

              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={draftRequireScorekeeperApproval}
                  onChange={(e) => setDraftRequireScorekeeperApproval(e.target.checked)}
                />
                <span>
                  Require approval for Scorekeeper (when off, any guest can become Scorekeeper)
                </span>
              </label>

              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={draftAllowScorekeeperGrandma}
                  onChange={(e) => setDraftAllowScorekeeperGrandma(e.target.checked)}
                />
                <span>
                  Allow Scorekeepers to trigger Grandma phrases (Moderators &amp; up always keep access)
                </span>
              </label>

              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={draftShowMiniBracket}
                  onChange={(e) => setDraftShowMiniBracket(e.target.checked)}
                />
                <span>Show Ticker on Presentation View</span>
              </label>

              {isTeams && (
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={draftAutoTeamNames}
                    onChange={(e) => handleToggleAutoTeamNames(e.target.checked)}
                  />
                  <span>Auto-generate themed team names</span>
                </label>
              )}
            </div>
          </div>

          {/* Apply Strategy Selector: Non-Destructive vs Destructive */}
          <div className="setup-section-box apply-mode-box">
            <h2 className="setup-section-heading">How Should Changes Be Applied?</h2>
            <div className="apply-mode-grid" role="radiogroup" aria-label="Apply Changes Mode">
              <button
                type="button"
                role="radio"
                aria-checked={effectiveApplyMode === 'preserve'}
                className={`apply-mode-option ${
                  effectiveApplyMode === 'preserve' ? 'is-selected is-safe' : ''
                }`}
                disabled={mustFullRebuild}
                onClick={() => setDraftApplyMode('preserve')}
              >
                <div className="amo-title">🛡️ Non-Destructive (Preserve Progress)</div>
                <p className="amo-desc">
                  {mustFullRebuild
                    ? 'Unavailable when changing competition mode, elimination format, or reducing entrants.'
                    : 'Keeps all completed and in-progress match scores intact while updating settings, names, teams, or adding new players.'}
                </p>
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={effectiveApplyMode === 'rebuild'}
                className={`apply-mode-option ${
                  effectiveApplyMode === 'rebuild' ? 'is-selected is-destructive' : ''
                }`}
                onClick={() => setDraftApplyMode('rebuild')}
              >
                <div className="amo-title">🔥 Destructive (Full Bracket Rebuild)</div>
                <p className="amo-desc">
                  Resets all match scores to 0–0 and generates a brand-new optimally seeded bracket
                  from your current roster and seed order.
                </p>
              </button>
            </div>
          </div>

          <footer className="dialog-footer">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={willRebuildBracket ? 'btn-amber' : 'btn-primary'}
              disabled={!hasEnoughPlayers}
            >
              {willRebuildBracket
                ? '🔥 Apply & Rebuild Bracket'
                : isAddingMidTournament
                ? 'Save & Add to Bracket'
                : 'Save Setup & Rules'}
            </button>
          </footer>
        </form>
      </div>
    </dialog>
  );
}
