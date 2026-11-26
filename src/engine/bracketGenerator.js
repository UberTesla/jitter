/**
 * Tournament Bracket Generator & Progression Engine
 * Supports ANY number of players or teams (2..256) with official tournament seeding,
 * automatic BYE placement and propagation across Single Elimination
 * and Double Elimination (Winners Bracket, Losers Bracket, Grand Final).
 *
 * Naming rules:
 *  - Normal mode (demoMode = false): uses clean neutral labels ("Player 1", "Team 1")
 *    without fabricating fictional player names.
 *  - Demo mode (demoMode = true): generates realistic deterministic demo player names
 *    scalable to 256+ players.
 *  - Auto Team Names (autoTeamNames = true): assigns themed ping pong team names
 *    scalable to 256+ unique teams.
 */

import { evaluateMatchState } from './scoringEngine.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 256;

const DEMO_FIRST_NAMES = [
  'Marcus', 'Elena', 'Kenji', 'Chloe', 'Devon', 'Sofia', 'Liam', 'Priya',
  'Hector', 'Hannah', 'Tariq', 'Maya', 'Gabe', 'Nadia', 'Owen', 'Zoe',
  'Carlos', 'Aisha', 'Lucas', 'Freya', 'Mateo', 'Claire', 'Noah', 'Amara',
  'Viktor', 'Yuki', 'Samira', 'Leo', 'Tessa', 'Rafael', 'Sora', 'Mila',
];

const DEMO_LAST_NAMES = [
  'Vance', 'Petrova', 'Takahashi', 'Mercer', 'Brooks', 'Alvarez', 'O\'Connor', 'Nair',
  'Silva', 'Lindqvist', 'Al-Mansoor', 'Chen', 'Kowalski', 'Benali', 'Fletcher', 'Kim',
  'Mendez', 'Patel', 'Meyer', 'Olsen', 'Rossi', 'Dubois', 'Goldstein', 'Okafor',
  'Novak', 'Sato', 'Haddad', 'Costa', 'Berg', 'Morales', 'Cho', 'Bauer',
];

const TEAM_ADJECTIVES = [
  'Spin', 'Net', 'Topspin', 'Deuce', 'Paddle', 'Backhand', 'Basement', 'Rally',
  'Smash', 'Loop', 'Table', 'Slice', 'Edge', 'Drop Shot', 'Match Point', 'Velocity',
  'Turbo', 'Neon', 'Retro', 'Midnight', 'Golden', 'Atomic', 'Phantom', 'Apex',
];

const TEAM_NOUNS = [
  'Doctors', 'Ninjas', 'Titans', 'Caboose', 'Royalty', 'Bandits', 'Legends', 'Syndicate',
  'Sharks', 'Rebels', 'Crew', 'Mafia', 'Wizards', 'Rockets', 'Vipers', 'Falcons',
  'Knights', 'Comets', 'Aces', 'Strikers', 'Dynasty', 'Dragons', 'Outlaws', 'Troop',
];

export function generateDemoPlayerName(index) {
  const first = DEMO_FIRST_NAMES[index % DEMO_FIRST_NAMES.length];
  const last =
    DEMO_LAST_NAMES[(Math.floor(index / DEMO_FIRST_NAMES.length) * 7 + index) % DEMO_LAST_NAMES.length];
  return `${first} ${last}`;
}

export function generateRandomDemoPlayerName(excludeNames = []) {
  const excluded = new Set(
    excludeNames.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean)
  );
  for (let attempt = 0; attempt < 40; attempt++) {
    const first = DEMO_FIRST_NAMES[Math.floor(Math.random() * DEMO_FIRST_NAMES.length)];
    const last = DEMO_LAST_NAMES[Math.floor(Math.random() * DEMO_LAST_NAMES.length)];
    const candidate = `${first} ${last}`;
    if (!excluded.has(candidate.toLowerCase())) return candidate;
  }
  return generateDemoPlayerName(excluded.size);
}

export function generateAutoTeamName(index) {
  if (index < 16) {
    return `${TEAM_ADJECTIVES[index]} ${TEAM_NOUNS[index]}`;
  }
  const adj = TEAM_ADJECTIVES[index % TEAM_ADJECTIVES.length];
  const noun =
    TEAM_NOUNS[(Math.floor(index / TEAM_ADJECTIVES.length) * 5 + index) % TEAM_NOUNS.length];
  return `${adj} ${noun}`;
}

export function generateRandomTeamName(excludeNames = []) {
  const excluded = new Set(
    excludeNames.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean)
  );
  for (let attempt = 0; attempt < 40; attempt++) {
    const adj = TEAM_ADJECTIVES[Math.floor(Math.random() * TEAM_ADJECTIVES.length)];
    const noun = TEAM_NOUNS[Math.floor(Math.random() * TEAM_NOUNS.length)];
    const candidate = `${adj} ${noun}`;
    if (!excluded.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  const adj = TEAM_ADJECTIVES[Math.floor(Math.random() * TEAM_ADJECTIVES.length)];
  const noun = TEAM_NOUNS[Math.floor(Math.random() * TEAM_NOUNS.length)];
  return `${adj} ${noun}`;
}

export function isNeutralPlayerName(name) {
  return /^Player \d+$/i.test(String(name || '').trim());
}

export function isNeutralTeamName(name) {
  return /^Team \d+$/i.test(String(name || '').trim());
}

export function clampPlayerCount(count) {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n)) return 8;
  return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
}

export function nextPowerOfTwo(n) {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

/**
 * Standard balanced tournament seeding order for any power-of-2 bracket size (2..256).
 */
export function getStandardSeedOrder(bracketSize) {
  let order = [1, 2];
  while (order.length < bracketSize) {
    const nextSize = order.length * 2;
    const nextOrder = [];
    for (const seed of order) {
      nextOrder.push(seed);
      nextOrder.push(nextSize + 1 - seed);
    }
    order = nextOrder;
  }
  return order;
}

/**
 * Creates a normalized competitor list for ANY count (2..256), supporting:
 *  - entryMode: 'singles' | 'teams'
 *  - demoMode: boolean (only generates realistic demo player names when true)
 *  - autoTeamNames: boolean (only generates themed team names when true)
 *  - forceRegenerateNames: boolean (overwrites existing names with current naming policy)
 */
export function createPlayers(
  count,
  existingPlayers = [],
  entryMode = 'singles',
  options = {}
) {
  const {
    demoMode = false,
    autoTeamNames = false,
    forceRegenerateNames = false,
    forceRegenerateTeamNames = false,
  } = options;

  const validSize = clampPlayerCount(count);
  const isTeams = entryMode === 'teams';
  const players = [];

  for (let i = 0; i < validSize; i++) {
    const existing = existingPlayers[i];
    const existingMembers = Array.isArray(existing?.members)
      ? existing.members.map((m) => String(m || '').trim())
      : [];

    if (isTeams) {
      const defaultM1 = demoMode ? generateDemoPlayerName(i * 2) : `Player ${i * 2 + 1}`;
      const defaultM2 = demoMode ? generateDemoPlayerName(i * 2 + 1) : `Player ${i * 2 + 2}`;

      const m1 =
        !forceRegenerateNames && existingMembers[0]
          ? demoMode && isNeutralPlayerName(existingMembers[0])
            ? defaultM1
            : existingMembers[0]
          : defaultM1;

      const m2 =
        !forceRegenerateNames && existingMembers[1]
          ? demoMode && isNeutralPlayerName(existingMembers[1])
            ? defaultM2
            : existingMembers[1]
          : defaultM2;

      const hasExistingTeam = Array.isArray(existing?.members) && existing.members.length > 0;
      const existingName = existing?.name?.trim() || '';
      const defaultTeamName = autoTeamNames ? generateAutoTeamName(i) : `Team ${i + 1}`;

      let teamName;
      if (forceRegenerateTeamNames || forceRegenerateNames) {
        teamName = defaultTeamName;
      } else if (hasExistingTeam && existingName) {
        teamName =
          autoTeamNames && isNeutralTeamName(existingName) ? defaultTeamName : existingName;
      } else {
        teamName = defaultTeamName;
      }

      players.push({
        id: `p${i + 1}`,
        seed: i + 1,
        name: teamName,
        members: [m1, m2],
      });
    } else {
      const wasTeam = Array.isArray(existing?.members) && existing.members.length > 0;
      const defaultSingleName = demoMode ? generateDemoPlayerName(i) : `Player ${i + 1}`;
      const existingName = !wasTeam ? existing?.name?.trim() || '' : existingMembers[0] || '';

      let singleName;
      if (forceRegenerateNames) {
        singleName = defaultSingleName;
      } else if (existingName) {
        singleName =
          demoMode && isNeutralPlayerName(existingName) ? defaultSingleName : existingName;
      } else {
        singleName = defaultSingleName;
      }

      players.push({
        id: `p${i + 1}`,
        seed: i + 1,
        name: singleName,
      });
    }
  }
  return players;
}

/**
 * Formats a team's members for compact display (e.g. "Player 1 & Player 2").
 */
export function formatTeamMembers(entrant, separator = ' & ') {
  if (!entrant || !Array.isArray(entrant.members)) return '';
  return entrant.members.map((m) => String(m || '').trim()).filter(Boolean).join(separator);
}

/**
 * Formats a single player's name compactly as "First" or "First L." (preserving numeric suffixes like "Player 1").
 */
export function formatShortPlayerName(name) {
  const cleaned = String(name || '').trim();
  if (!cleaned) return '';
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) return `${first} ${last}`;
  const lastInitial = last[0];
  return lastInitial ? `${first} ${lastInitial.toUpperCase()}.` : first;
}

/**
 * Formats a team's members compactly as "First L. & First L." for space-constrained On Deck banners.
 */
export function formatTeamMembersShort(entrant, separator = ' & ') {
  if (!entrant || !Array.isArray(entrant.members)) return '';
  return entrant.members
    .map((m) => formatShortPlayerName(m))
    .filter(Boolean)
    .join(separator);
}

function getWinnersRoundLabel(round, totalWinnersRounds, format, effectiveDouble) {
  const remaining = totalWinnersRounds - round;
  if (remaining === 0) {
    return effectiveDouble ? 'Winners Final' : 'Championship Final';
  }
  if (remaining === 1) return 'Semifinals';
  if (remaining === 2) return 'Quarterfinals';
  return `Round of ${Math.pow(2, remaining + 1)}`;
}

function getLosersRoundLabel(round, totalLosersRounds) {
  if (round === totalLosersRounds) return 'Losers Final';
  if (round === totalLosersRounds - 1 && totalLosersRounds >= 2) return 'Losers Semifinal';
  return `Losers Round ${round}`;
}

function createEmptyMatch({
  id,
  bracket,
  round,
  roundLabel,
  matchNumber,
  label,
  player1Id = null,
  player2Id = null,
  slot1IsBye = false,
  slot2IsBye = false,
  source1Label = 'TBD',
  source2Label = 'TBD',
  nextWinnerMatchId = null,
  nextWinnerSlot = null,
  nextLoserMatchId = null,
  nextLoserSlot = null,
}) {
  return {
    id,
    bracket,
    round,
    roundLabel,
    matchNumber,
    label,
    player1Id,
    player2Id,
    slot1IsBye,
    slot2IsBye,
    source1Label,
    source2Label,
    score1: 0,
    score2: 0,
    initialServer: 1,
    pointHistory: [],
    started: false,
    completed: false,
    isBye: false,
    winnerIsBye: false,
    winnerId: null,
    loserId: null,
    completedAt: null,
    nextWinnerMatchId,
    nextWinnerSlot,
    nextLoserMatchId,
    nextLoserSlot,
  };
}

function assignSlot(matches, targetMatchId, slot, { playerId = null, isBye = false }) {
  if (!targetMatchId || !matches[targetMatchId]) return;
  const target = { ...matches[targetMatchId] };
  if (slot === 1) {
    target.player1Id = isBye ? null : playerId;
    target.slot1IsBye = Boolean(isBye);
  } else {
    target.player2Id = isBye ? null : playerId;
    target.slot2IsBye = Boolean(isBye);
  }
  matches[targetMatchId] = target;
}

/**
 * Deterministically resolves any match where one or both participants are BYEs,
 * advancing real entrants or propagating BYEs downstream until steady state.
 */
export function propagateByes(inputMatches) {
  const matches = { ...inputMatches };
  let changed = true;
  let guard = 0;

  while (changed && guard < 1000) {
    changed = false;
    guard += 1;

    for (const id of Object.keys(matches)) {
      const m = matches[id];
      if (m.completed) continue;

      const s1Resolved = Boolean(m.player1Id || m.slot1IsBye);
      const s2Resolved = Boolean(m.player2Id || m.slot2IsBye);
      if (!s1Resolved || !s2Resolved) continue;
      if (!m.slot1IsBye && !m.slot2IsBye) continue;

      changed = true;

      if (m.slot1IsBye && m.slot2IsBye) {
        matches[id] = {
          ...m,
          completed: true,
          isBye: true,
          winnerIsBye: true,
          winnerId: null,
          loserId: null,
        };
        assignSlot(matches, m.nextWinnerMatchId, m.nextWinnerSlot, { isBye: true });
        assignSlot(matches, m.nextLoserMatchId, m.nextLoserSlot, { isBye: true });
      } else {
        const advancingId = m.slot1IsBye ? m.player2Id : m.player1Id;
        matches[id] = {
          ...m,
          completed: true,
          isBye: true,
          winnerIsBye: false,
          winnerId: advancingId,
          loserId: null,
        };
        assignSlot(matches, m.nextWinnerMatchId, m.nextWinnerSlot, { playerId: advancingId });
        assignSlot(matches, m.nextLoserMatchId, m.nextLoserSlot, { isBye: true });
      }
    }
  }

  return matches;
}

/**
 * Generates all matches for ANY number of players or teams (2..256)
 * in Single Elimination or Double Elimination.
 */
export function generateBracket(players, format = 'single', options = {}) {
  const count = clampPlayerCount(players.length);
  const isTeams = Array.isArray(players[0]?.members);
  const normalizedPlayers = createPlayers(count, players, isTeams ? 'teams' : 'singles');
  const { customR1Pairs = null, bracketSizeOverride = null } = options || {};
  const bracketSize = Math.max(
    nextPowerOfTwo(count),
    bracketSizeOverride ? nextPowerOfTwo(bracketSizeOverride) : 2
  );
  const totalWinnersRounds = Math.log2(bracketSize);
  const effectiveDouble = format === 'double' && bracketSize >= 4;
  const seedOrder = getStandardSeedOrder(bracketSize);
  const playerById = new Map(normalizedPlayers.map((p) => [p.id, p]));

  const matches = {};

  // 1. Build Winners Bracket
  for (let r = 1; r <= totalWinnersRounds; r++) {
    const matchCount = bracketSize / Math.pow(2, r);
    const roundLabel = getWinnersRoundLabel(r, totalWinnersRounds, format, effectiveDouble);

    for (let m = 1; m <= matchCount; m++) {
      const id = `W-R${r}-M${m}`;
      let player1Id = null;
      let player2Id = null;
      let slot1IsBye = false;
      let slot2IsBye = false;
      let source1Label = 'TBD';
      let source2Label = 'TBD';

      if (r === 1) {
        if (Array.isArray(customR1Pairs)) {
          const pair = customR1Pairs[m - 1] || { player1Id: null, player2Id: null };
          const p1 = pair.player1Id ? playerById.get(pair.player1Id) || null : null;
          const p2 = pair.player2Id ? playerById.get(pair.player2Id) || null : null;
          player1Id = p1?.id || null;
          player2Id = p2?.id || null;
          slot1IsBye = !p1;
          slot2IsBye = !p2;
          source1Label = p1 ? `Seed #${p1.seed}` : 'BYE';
          source2Label = p2 ? `Seed #${p2.seed}` : 'BYE';
        } else {
          const seed1 = seedOrder[(m - 1) * 2];
          const seed2 = seedOrder[(m - 1) * 2 + 1];
          const p1 = normalizedPlayers[seed1 - 1] || null;
          const p2 = normalizedPlayers[seed2 - 1] || null;
          player1Id = p1?.id || null;
          player2Id = p2?.id || null;
          slot1IsBye = !p1;
          slot2IsBye = !p2;
          source1Label = p1 ? `Seed #${seed1}` : 'BYE';
          source2Label = p2 ? `Seed #${seed2}` : 'BYE';
        }
      } else {
        source1Label = `Winner W-R${r - 1}-M${m * 2 - 1}`;
        source2Label = `Winner W-R${r - 1}-M${m * 2}`;
      }

      const nextWinnerMatchId =
        r < totalWinnersRounds
          ? `W-R${r + 1}-M${Math.ceil(m / 2)}`
          : effectiveDouble
          ? 'GF-M1'
          : null;
      const nextWinnerSlot =
        r < totalWinnersRounds ? (m % 2 === 1 ? 1 : 2) : effectiveDouble ? 1 : null;

      const shortPrefix =
        r === totalWinnersRounds
          ? effectiveDouble
            ? 'WF'
            : 'FINAL'
          : r === totalWinnersRounds - 1
          ? 'SF'
          : r === totalWinnersRounds - 2
          ? 'QF'
          : `R${r}`;
      const label = matchCount === 1 ? shortPrefix : `${shortPrefix} M${m}`;

      matches[id] = createEmptyMatch({
        id,
        bracket: 'winners',
        round: r,
        roundLabel,
        matchNumber: m,
        label,
        player1Id,
        player2Id,
        slot1IsBye,
        slot2IsBye,
        source1Label,
        source2Label,
        nextWinnerMatchId,
        nextWinnerSlot,
      });
    }
  }

  // 2. Build Losers Bracket & Grand Final (for Double Elimination when bracketSize >= 4)
  if (effectiveDouble) {
    const totalLosersRounds = 2 * (totalWinnersRounds - 1);

    for (let lr = 1; lr <= totalLosersRounds; lr++) {
      const pairStep = Math.ceil(lr / 2);
      const matchCount = bracketSize / Math.pow(2, pairStep + 1);
      const roundLabel = getLosersRoundLabel(lr, totalLosersRounds);

      for (let m = 1; m <= matchCount; m++) {
        const id = `L-R${lr}-M${m}`;
        let nextWinnerMatchId = null;
        let nextWinnerSlot = null;

        if (lr < totalLosersRounds) {
          if (lr % 2 === 1) {
            nextWinnerMatchId = `L-R${lr + 1}-M${m}`;
            nextWinnerSlot = 1;
          } else {
            nextWinnerMatchId = `L-R${lr + 1}-M${Math.ceil(m / 2)}`;
            nextWinnerSlot = m % 2 === 1 ? 1 : 2;
          }
        } else {
          nextWinnerMatchId = 'GF-M1';
          nextWinnerSlot = 2;
        }

        let source1Label = 'TBD';
        let source2Label = 'TBD';
        if (lr === 1) {
          source1Label = `Loser W-R1-M${m * 2 - 1}`;
          source2Label = `Loser W-R1-M${m * 2}`;
        } else if (lr % 2 === 0) {
          const dropRound = lr / 2 + 1;
          const dropSourceMatch = matchCount + 1 - m;
          source1Label = `Winner L-R${lr - 1}-M${m}`;
          source2Label = `Loser W-R${dropRound}-M${dropSourceMatch}`;
        } else {
          source1Label = `Winner L-R${lr - 1}-M${m * 2 - 1}`;
          source2Label = `Winner L-R${lr - 1}-M${m * 2}`;
        }

        const label =
          lr === totalLosersRounds
            ? 'LF'
            : matchCount === 1
            ? 'L-SF'
            : `L-R${lr} M${m}`;

        matches[id] = createEmptyMatch({
          id,
          bracket: 'losers',
          round: lr,
          roundLabel,
          matchNumber: m,
          label,
          source1Label,
          source2Label,
          nextWinnerMatchId,
          nextWinnerSlot,
        });
      }
    }

    const r1Count = bracketSize / 2;
    for (let m = 1; m <= r1Count; m++) {
      const wId = `W-R1-M${m}`;
      matches[wId].nextLoserMatchId = `L-R1-M${Math.ceil(m / 2)}`;
      matches[wId].nextLoserSlot = m % 2 === 1 ? 1 : 2;
    }

    for (let r = 2; r <= totalWinnersRounds; r++) {
      const wCount = bracketSize / Math.pow(2, r);
      const targetLr = 2 * (r - 1);
      for (let m = 1; m <= wCount; m++) {
        const wId = `W-R${r}-M${m}`;
        const targetMatchNum = wCount + 1 - m;
        matches[wId].nextLoserMatchId = `L-R${targetLr}-M${targetMatchNum}`;
        matches[wId].nextLoserSlot = 2;
      }
    }

    matches['GF-M1'] = createEmptyMatch({
      id: 'GF-M1',
      bracket: 'final',
      round: 1,
      roundLabel: 'Grand Final',
      matchNumber: 1,
      label: 'GRAND FINAL',
      source1Label: 'Winners Champion',
      source2Label: 'Losers Champion',
    });
  }

  return propagateByes(matches);
}

export function getChampionshipMatchId(playerCount, format) {
  const bracketSize = nextPowerOfTwo(clampPlayerCount(playerCount));
  if (format === 'double' && bracketSize >= 4) return 'GF-M1';
  const totalRounds = Math.log2(bracketSize);
  return `W-R${totalRounds}-M1`;
}

export function findNextReadyMatchId(matches, excludeMatchId = null) {
  const ordered = Object.values(matches).sort((a, b) => {
    const bracketOrder = { winners: 0, losers: 1, final: 2 };
    if (a.bracket !== b.bracket) {
      if (a.bracket === 'final') return 1;
      if (b.bracket === 'final') return -1;
      if (a.round !== b.round) return a.round - b.round;
      return bracketOrder[a.bracket] - bracketOrder[b.bracket];
    }
    if (a.round !== b.round) return a.round - b.round;
    return a.matchNumber - b.matchNumber;
  });

  const preferred = ordered.find(
    (m) => m.id !== excludeMatchId && !m.completed && !m.isBye && m.player1Id && m.player2Id
  );
  if (preferred) return preferred.id;

  const fallback = ordered.find((m) => !m.completed && !m.isBye && m.player1Id && m.player2Id);
  return fallback?.id || null;
}

export function completeMatchAndAdvance(matches, matchId, rules, playerCount, format) {
  const match = matches[matchId];
  if (!match || match.completed || match.isBye) {
    return { matches, nextActiveMatchId: matchId, championId: null, completed: false };
  }

  const evalState = evaluateMatchState(match, rules);
  if (!evalState.canComplete || !evalState.winnerSlot) {
    return { matches, nextActiveMatchId: matchId, championId: null, completed: false };
  }

  const winnerId = evalState.winnerSlot === 1 ? match.player1Id : match.player2Id;
  const loserId = evalState.winnerSlot === 1 ? match.player2Id : match.player1Id;
  const completedAt = Date.now();
  const baseOffset = Math.max(0, Number(match.timerOffsetMs) || 0);
  const effectiveEndAt = match.winnerReachedAt ? Number(match.winnerReachedAt) : completedAt;
  const elapsedMs = match.startedAt
    ? baseOffset + Math.max(0, effectiveEndAt - Number(match.startedAt))
    : baseOffset;

  let updatedMatches = {
    ...matches,
    [matchId]: {
      ...match,
      completed: true,
      winnerId,
      loserId,
      completedAt,
      elapsedMs,
    },
  };

  if (match.nextWinnerMatchId && updatedMatches[match.nextWinnerMatchId]) {
    assignSlot(updatedMatches, match.nextWinnerMatchId, match.nextWinnerSlot, {
      playerId: winnerId,
    });
  }

  if (match.nextLoserMatchId && updatedMatches[match.nextLoserMatchId]) {
    assignSlot(updatedMatches, match.nextLoserMatchId, match.nextLoserSlot, {
      playerId: loserId,
    });
  }

  updatedMatches = propagateByes(updatedMatches);

  const championshipId = getChampionshipMatchId(playerCount, format);
  const champMatch = updatedMatches[championshipId];
  const championId = champMatch?.completed && !champMatch?.winnerIsBye ? champMatch.winnerId : null;

  const nextReady = findNextReadyMatchId(updatedMatches, matchId);
  const nextActiveMatchId = nextReady || matchId;

  return {
    matches: updatedMatches,
    nextActiveMatchId,
    championId,
    completed: true,
    recommendedMatchId: nextReady,
  };
}

/**
 * Checks whether any downstream match fed by `matchId` has already started,
 * recorded points, or been completed (excluding auto-BYE resolutions).
 */
export function hasDownstreamMatchProgress(matches, matchId) {
  const visited = new Set();
  const walk = (id) => {
    if (!id || visited.has(id)) return false;
    visited.add(id);
    const m = matches?.[id];
    if (!m) return false;
    const targets = [m.nextWinnerMatchId, m.nextLoserMatchId].filter(Boolean);
    for (const tid of targets) {
      const t = matches?.[tid];
      if (!t) continue;
      if (
        !t.isBye &&
        (t.completed || t.started || (t.score1 || 0) > 0 || (t.score2 || 0) > 0)
      ) {
        return true;
      }
      if (walk(tid)) return true;
    }
    return false;
  };
  return walk(matchId);
}

/**
 * Reopens a completed real match for live editing/resumption, cleanly clearing
 * any downstream bracket slots and scores that depended on its prior result.
 */
export function reopenCompletedMatch(matches, matchId, playerCount, format) {
  const match = matches?.[matchId];
  if (!match || !match.completed || match.isBye) {
    return { matches, reopened: false, championId: null };
  }

  let updatedMatches = { ...matches };

  const clearDownstreamSlot = (targetId, slot) => {
    if (!targetId || !updatedMatches[targetId]) return;
    const prev = updatedMatches[targetId];
    const next = {
      ...prev,
      score1: 0,
      score2: 0,
      pointHistory: [],
      started: false,
      completed: false,
      isBye: false,
      winnerIsBye: false,
      winnerId: null,
      loserId: null,
      completedAt: null,
    };
    if (slot === 1) {
      next.player1Id = null;
      next.slot1IsBye = false;
    } else if (slot === 2) {
      next.player2Id = null;
      next.slot2IsBye = false;
    }
    updatedMatches[targetId] = next;

    if (prev.nextWinnerMatchId) {
      clearDownstreamSlot(prev.nextWinnerMatchId, prev.nextWinnerSlot);
    }
    if (prev.nextLoserMatchId) {
      clearDownstreamSlot(prev.nextLoserMatchId, prev.nextLoserSlot);
    }
  };

  if (match.nextWinnerMatchId) {
    clearDownstreamSlot(match.nextWinnerMatchId, match.nextWinnerSlot);
  }
  if (match.nextLoserMatchId) {
    clearDownstreamSlot(match.nextLoserMatchId, match.nextLoserSlot);
  }

  const prevElapsedMs = Number.isFinite(match.elapsedMs)
    ? Math.max(0, match.elapsedMs)
    : match.startedAt && match.completedAt
      ? Math.max(0, Number(match.timerOffsetMs) || 0) +
        Math.max(0, Number(match.completedAt) - Number(match.startedAt))
      : Math.max(0, Number(match.timerOffsetMs) || 0);

  updatedMatches[matchId] = {
    ...match,
    started: true,
    startedAt: Date.now(),
    timerOffsetMs: prevElapsedMs,
    completed: false,
    winnerId: null,
    loserId: null,
    winnerReachedAt: null,
    completedAt: null,
    elapsedMs: null,
  };

  updatedMatches = propagateByes(updatedMatches);

  const championshipId = getChampionshipMatchId(playerCount, format);
  const champMatch = updatedMatches[championshipId];
  const championId =
    champMatch?.completed && !champMatch?.winnerIsBye ? champMatch.winnerId : null;

  return {
    matches: updatedMatches,
    reopened: true,
    championId,
  };
}

/**
 * Edits the final score of an already-completed match.
 * - If the winner is unchanged, updates the recorded score in-place with zero downstream disruption.
 * - If the winner changes, cleanly rolls back downstream slots and re-advances the new winner/loser.
 */
export function editCompletedMatchScore(
  matches,
  matchId,
  rawScore1,
  rawScore2,
  rules,
  playerCount,
  format
) {
  const match = matches?.[matchId];
  if (!match || !match.completed || match.isBye) {
    return { matches, edited: false, reason: 'Match is not completed', winnerChanged: false, championId: null };
  }

  const s1 = Math.max(0, Math.floor(Number(rawScore1) || 0));
  const s2 = Math.max(0, Math.floor(Number(rawScore2) || 0));
  const candidate = { ...match, score1: s1, score2: s2, completed: false };
  const evalState = evaluateMatchState(candidate, rules);

  if (!evalState.canComplete || !evalState.winnerSlot) {
    const winBy = Math.max(1, Math.floor(Number(rules?.winBy ?? 2) || 2));
    const skunkNote = rules?.skunkEnabled
      ? ` or win by ${Math.max(1, Math.floor(Number(rules?.skunkScore ?? 7) || 7))}–0 skunk`
      : '';
    return {
      matches,
      edited: false,
      reason: `Score must reach ${rules.targetPoints} and win by at least ${winBy}${skunkNote}`,
      winnerChanged: false,
      championId: null,
    };
  }

  const nextWinnerId = evalState.winnerSlot === 1 ? match.player1Id : match.player2Id;
  const winnerChanged = nextWinnerId !== match.winnerId;

  if (!winnerChanged) {
    const updatedMatches = {
      ...matches,
      [matchId]: {
        ...match,
        score1: s1,
        score2: s2,
        started: true,
      },
    };
    const championshipId = getChampionshipMatchId(playerCount, format);
    const champMatch = updatedMatches[championshipId];
    const championId =
      champMatch?.completed && !champMatch?.winnerIsBye ? champMatch.winnerId : null;
    return {
      matches: updatedMatches,
      edited: true,
      winnerChanged: false,
      championId,
    };
  }

  // Winner flipped: rollback downstream dependencies and re-complete with new score
  const reopened = reopenCompletedMatch(matches, matchId, playerCount, format);
  if (!reopened.reopened) {
    return { matches, edited: false, reason: 'Unable to reopen match', winnerChanged: false, championId: null };
  }

  const patched = {
    ...reopened.matches,
    [matchId]: {
      ...reopened.matches[matchId],
      score1: s1,
      score2: s2,
      pointHistory: [],
      started: true,
    },
  };

  const completed = completeMatchAndAdvance(patched, matchId, rules, playerCount, format);
  return {
    matches: completed.matches,
    edited: completed.completed,
    winnerChanged: true,
    championId: completed.championId,
    nextActiveMatchId: completed.nextActiveMatchId,
  };
}

/**
 * Adds new entrants mid-tournament WITHOUT losing completed or in-progress match scores:
 *  1. If no matches have started/scored yet, builds a cleanly seeded bracket.
 *  2. First slots new entrants into any unplayed Round 1 BYE matches (zero bracket rebuild).
 *  3. If more slots are needed (e.g., 4 -> 5 or 8 -> 9), expands the bracket power-of-2 size
 *     keeping all existing Round 1 pairings in the top half, seeding new entrants into the bottom
 *     half, and replaying every completed & in-progress match score cleanly.
 */
export function addEntrantsPreservingBracket(
  oldMatches,
  oldPlayers,
  nextPlayers,
  format = 'single',
  rules = { targetPoints: 11, serveRotation: 2, winBy: 2 },
  prevActiveMatchId = null
) {
  const oldIds = new Set((oldPlayers || []).map((p) => p.id));
  const addedPlayers = (nextPlayers || []).filter((p) => !oldIds.has(p.id));

  const hasAnyProgress = Object.values(oldMatches || {}).some(
    (m) => !m.isBye && (m.completed || m.started || (m.score1 || 0) > 0 || (m.score2 || 0) > 0)
  );

  // If no matches have been played/started yet, clean optimal seeding loses nothing
  if (!hasAnyProgress) {
    const fresh = generateBracket(nextPlayers, format);
    return {
      matches: fresh,
      activeMatchId: findNextReadyMatchId(fresh) || Object.keys(fresh)[0] || 'W-R1-M1',
      championId: null,
      expanded: false,
    };
  }

  // If no new entrants were added (e.g., renamed players or filled a solo team slot), keep matches untouched
  if (addedPlayers.length === 0) {
    const championshipId = getChampionshipMatchId(nextPlayers.length, format);
    const champMatch = oldMatches?.[championshipId];
    const championId =
      champMatch?.completed && !champMatch?.winnerIsBye ? champMatch.winnerId : null;
    return {
      matches: oldMatches,
      activeMatchId:
        prevActiveMatchId && oldMatches?.[prevActiveMatchId]
          ? prevActiveMatchId
          : findNextReadyMatchId(oldMatches) || Object.keys(oldMatches || {})[0] || 'W-R1-M1',
      championId,
      expanded: false,
    };
  }

  // Step 1: Attempt to slot new entrants into unplayed Round 1 BYE matches (zero rebuild!)
  let working = {};
  for (const [k, v] of Object.entries(oldMatches || {})) {
    working[k] = { ...v };
  }

  const clearDownstreamFrom = (targetId, slot) => {
    if (!targetId || !working[targetId]) return;
    const prev = working[targetId];
    const next = {
      ...prev,
      score1: 0,
      score2: 0,
      pointHistory: [],
      started: false,
      completed: false,
      isBye: false,
      winnerIsBye: false,
      winnerId: null,
      loserId: null,
      completedAt: null,
    };
    if (slot === 1) {
      next.player1Id = null;
      next.slot1IsBye = false;
    } else if (slot === 2) {
      next.player2Id = null;
      next.slot2IsBye = false;
    }
    working[targetId] = next;

    if (prev.nextWinnerMatchId) {
      clearDownstreamFrom(prev.nextWinnerMatchId, prev.nextWinnerSlot);
    }
    if (prev.nextLoserMatchId) {
      clearDownstreamFrom(prev.nextLoserMatchId, prev.nextLoserSlot);
    }
  };

  const remainingNew = [...addedPlayers];
  const r1ByeCandidates = Object.values(working)
    .filter(
      (m) =>
        m.bracket === 'winners' &&
        m.round === 1 &&
        m.isBye &&
        (m.slot1IsBye || m.slot2IsBye) &&
        !hasDownstreamMatchProgress(working, m.id)
    )
    .sort((a, b) => b.matchNumber - a.matchNumber);

  for (const byeMatch of r1ByeCandidates) {
    if (remainingNew.length === 0) break;
    const cur = working[byeMatch.id];
    if (!cur || !cur.isBye) continue;

    // Clear premature BYE advance before making this a real match
    if (cur.nextWinnerMatchId) clearDownstreamFrom(cur.nextWinnerMatchId, cur.nextWinnerSlot);
    if (cur.nextLoserMatchId) clearDownstreamFrom(cur.nextLoserMatchId, cur.nextLoserSlot);

    const updated = {
      ...cur,
      isBye: false,
      winnerIsBye: false,
      completed: false,
      winnerId: null,
      loserId: null,
      completedAt: null,
      started: false,
      score1: 0,
      score2: 0,
      pointHistory: [],
    };

    if (updated.slot1IsBye && updated.slot2IsBye) {
      const pA = remainingNew.shift();
      updated.player1Id = pA.id;
      updated.slot1IsBye = false;
      updated.source1Label = `Seed #${pA.seed}`;
      if (remainingNew.length > 0) {
        const pB = remainingNew.shift();
        updated.player2Id = pB.id;
        updated.slot2IsBye = false;
        updated.source2Label = `Seed #${pB.seed}`;
      }
    } else if (updated.slot2IsBye) {
      const pB = remainingNew.shift();
      updated.player2Id = pB.id;
      updated.slot2IsBye = false;
      updated.source2Label = `Seed #${pB.seed}`;
    } else if (updated.slot1IsBye) {
      const pA = remainingNew.shift();
      updated.player1Id = pA.id;
      updated.slot1IsBye = false;
      updated.source1Label = `Seed #${pA.seed}`;
    }

    working[byeMatch.id] = updated;
    working = propagateByes(working);
  }

  if (remainingNew.length === 0) {
    const championshipId = getChampionshipMatchId(nextPlayers.length, format);
    const champMatch = working[championshipId];
    const championId =
      champMatch?.completed && !champMatch?.winnerIsBye ? champMatch.winnerId : null;
    const validPrev =
      prevActiveMatchId && working[prevActiveMatchId] && !working[prevActiveMatchId].isBye;
    return {
      matches: working,
      activeMatchId: validPrev
        ? prevActiveMatchId
        : findNextReadyMatchId(working) || Object.keys(working)[0] || 'W-R1-M1',
      championId,
      expanded: false,
    };
  }

  // Step 2: Expand bracket size (oldSize -> newSize) keeping existing matches in top half & replaying scores!
  const oldR1 = Object.values(oldMatches || {})
    .filter((m) => m.bracket === 'winners' && m.round === 1)
    .sort((a, b) => a.matchNumber - b.matchNumber);
  const oldSize = Math.max(2, oldR1.length * 2);
  const newSize = Math.max(oldSize * 2, nextPowerOfTwo(nextPlayers.length));
  const totalNewR1 = newSize / 2;
  const bottomR1Count = totalNewR1 - oldR1.length;

  const customR1Pairs = oldR1.map((m) => ({
    player1Id: m.player1Id || null,
    player2Id: m.player2Id || null,
  }));

  // Distribute all newly added players evenly across the bottom-half Round 1 matches
  const bottomPairs = Array.from({ length: bottomR1Count }, () => ({
    player1Id: null,
    player2Id: null,
  }));
  const allAdded = [...addedPlayers];
  for (let i = 0; i < bottomPairs.length && allAdded.length > 0; i++) {
    bottomPairs[i].player1Id = allAdded.shift().id;
  }
  for (let i = 0; i < bottomPairs.length && allAdded.length > 0; i++) {
    bottomPairs[i].player2Id = allAdded.shift().id;
  }
  customR1Pairs.push(...bottomPairs);

  let expanded = generateBracket(nextPlayers, format, {
    customR1Pairs,
    bracketSizeOverride: newSize,
  });

  // Collect all prior real matches with progress (completed OR started/scored)
  const pairKey = (a, b) => [a, b].sort().join('::');
  const pendingReplay = Object.values(oldMatches || {})
    .filter(
      (m) =>
        !m.isBye &&
        m.player1Id &&
        m.player2Id &&
        (m.completed || m.started || (m.score1 || 0) > 0 || (m.score2 || 0) > 0)
    )
    .map((m) => ({
      oldId: m.id,
      bracket: m.bracket,
      key: pairKey(m.player1Id, m.player2Id),
      match: m,
      used: false,
    }));

  let preservedActiveMatchId = null;
  const prevActiveOld = prevActiveMatchId ? oldMatches?.[prevActiveMatchId] : null;
  const prevActivePairKey =
    prevActiveOld && prevActiveOld.player1Id && prevActiveOld.player2Id
      ? pairKey(prevActiveOld.player1Id, prevActiveOld.player2Id)
      : null;

  let progressed = true;
  let guard = 0;
  while (progressed && guard < 100) {
    progressed = false;
    guard += 1;

    const orderedNew = Object.values(expanded).sort((a, b) => {
      const order = { winners: 0, losers: 1, final: 2 };
      if (a.bracket !== b.bracket) return order[a.bracket] - order[b.bracket];
      if (a.round !== b.round) return a.round - b.round;
      return a.matchNumber - b.matchNumber;
    });

    for (const m of orderedNew) {
      const liveM = expanded[m.id];
      if (!liveM || liveM.completed || liveM.isBye || !liveM.player1Id || !liveM.player2Id) continue;
      const key = pairKey(liveM.player1Id, liveM.player2Id);

      // Prefer exact bracket match (winners/losers/final), then fallback if old Final became earlier round
      const entry =
        pendingReplay.find((r) => !r.used && r.key === key && r.bracket === liveM.bracket) ||
        pendingReplay.find((r) => !r.used && r.key === key);
      if (!entry) continue;

      entry.used = true;
      const src = entry.match;
      const sameOrientation = liveM.player1Id === src.player1Id;
      const s1 = sameOrientation ? src.score1 : src.score2;
      const s2 = sameOrientation ? src.score2 : src.score1;
      const initSrv = sameOrientation
        ? src.initialServer
        : src.initialServer === 1
        ? 2
        : 1;
      const mappedHistory = Array.isArray(src.pointHistory)
        ? src.pointHistory.map((slot) => (sameOrientation ? slot : slot === 1 ? 2 : 1))
        : [];

      expanded = {
        ...expanded,
        [liveM.id]: {
          ...liveM,
          score1: s1,
          score2: s2,
          initialServer: initSrv,
          pointHistory: mappedHistory,
          started: Boolean(src.started || src.completed || s1 > 0 || s2 > 0),
        },
      };

      if (src.completed) {
        const res = completeMatchAndAdvance(expanded, liveM.id, rules, newSize, format);
        if (res.completed) {
          expanded = res.matches;
          progressed = true;
        }
      } else if (prevActivePairKey && key === prevActivePairKey) {
        preservedActiveMatchId = liveM.id;
      }
    }
  }

  const championshipId = getChampionshipMatchId(newSize, format);
  const champMatch = expanded[championshipId];
  const championId =
    champMatch?.completed && !champMatch?.winnerIsBye ? champMatch.winnerId : null;

  return {
    matches: expanded,
    activeMatchId:
      preservedActiveMatchId ||
      findNextReadyMatchId(expanded) ||
      Object.keys(expanded)[0] ||
      'W-R1-M1',
    championId,
    expanded: true,
  };
}

export function groupBracketRounds(matches) {
  const winnersMap = new Map();
  const losersMap = new Map();
  let grandFinal = null;

  for (const match of Object.values(matches)) {
    if (match.bracket === 'winners') {
      if (!winnersMap.has(match.round)) winnersMap.set(match.round, []);
      winnersMap.get(match.round).push(match);
    } else if (match.bracket === 'losers') {
      if (!losersMap.has(match.round)) losersMap.set(match.round, []);
      losersMap.get(match.round).push(match);
    } else if (match.bracket === 'final') {
      grandFinal = match;
    }
  }

  const sortRounds = (map) =>
    Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([round, list]) => ({
        round,
        label: list[0]?.roundLabel || `Round ${round}`,
        matches: list.sort((a, b) => a.matchNumber - b.matchNumber),
      }));

  return {
    winnersRounds: sortRounds(winnersMap),
    losersRounds: sortRounds(losersMap),
    grandFinal,
  };
}

export function computeTournamentStats(state) {
  const allMatches = Object.values(state.matches || {});
  const allRealMatches = allMatches.filter((m) => !m.isBye);
  const byeCount = allMatches.length - allRealMatches.length;

  const completedMatches = allRealMatches
    .filter((m) => m.completed)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  const sortUpcoming = (a, b) => {
    if (a.bracket === 'final') return 1;
    if (b.bracket === 'final') return -1;
    if (a.round !== b.round) return a.round - b.round;
    return a.matchNumber - b.matchNumber;
  };

  const readyMatches = allRealMatches
    .filter((m) => !m.completed && m.player1Id && m.player2Id && m.id !== state.activeMatchId)
    .sort(sortUpcoming);

  // Include partially-filled upcoming matches (e.g. Final waiting on winner of current match)
  // so On Deck stays visible whenever another match remains in the tournament.
  const pendingUpcomingMatches = allRealMatches
    .filter(
      (m) =>
        !m.completed &&
        m.id !== state.activeMatchId &&
        !(m.player1Id && m.player2Id) &&
        (m.player1Id || m.player2Id || m.source1Label || m.source2Label)
    )
    .sort(sortUpcoming);

  const upNextQueue = [...readyMatches, ...pendingUpcomingMatches];

  const playerMap = new Map();
  for (const p of state.players || []) {
    if (p?.id) playerMap.set(p.id, p);
  }

  let totalPointsPlayed = 0;
  let highestScoringMatch = null;
  let biggestBlowout = null;
  let longestMatch = null;
  let longestPointStreak = null;
  let closestMarginCount = 0;
  let deuceMatchesCount = 0;
  let timedMatchesCount = 0;
  let totalElapsedMs = 0;

  const perPlayer = new Map();
  const ensurePlayerStat = (id) => {
    if (!id) return null;
    if (!perPlayer.has(id)) {
      const p = playerMap.get(id);
      perPlayer.set(id, {
        playerId: id,
        name: p?.name || 'Player',
        seed: p?.seed ?? 999,
        wins: 0,
        losses: 0,
        matchesPlayed: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        pointDiff: 0,
        bestStreak: 0,
      });
    }
    return perPlayer.get(id);
  };

  for (const p of state.players || []) {
    ensurePlayerStat(p?.id);
  }

  const targetPoints = Math.max(1, Math.floor(Number(state.rules?.targetPoints) || 11));
  const winBy = Math.max(1, Math.floor(Number(state.rules?.winBy ?? 2) || 2));

  for (const m of allRealMatches) {
    const s1 = Number(m.score1) || 0;
    const s2 = Number(m.score2) || 0;
    const pts = s1 + s2;
    totalPointsPlayed += pts;

    // Scan consecutive point streaks from pointHistory (including active & completed matches)
    if (Array.isArray(m.pointHistory) && m.pointHistory.length > 0) {
      let currSlot = null;
      let currRun = 0;
      const bestBySlot = { 1: 0, 2: 0 };
      for (const slot of m.pointHistory) {
        if (slot === currSlot) {
          currRun += 1;
        } else {
          currSlot = slot;
          currRun = 1;
        }
        if ((slot === 1 || slot === 2) && currRun > bestBySlot[slot]) {
          bestBySlot[slot] = currRun;
        }
      }
      for (const slot of [1, 2]) {
        const pid = slot === 1 ? m.player1Id : m.player2Id;
        const run = bestBySlot[slot];
        if (pid && run > 0) {
          const st = ensurePlayerStat(pid);
          if (st && run > st.bestStreak) st.bestStreak = run;
          if (!longestPointStreak || run > longestPointStreak.streak) {
            longestPointStreak = {
              playerId: pid,
              playerName: playerMap.get(pid)?.name || `Player ${slot}`,
              streak: run,
              matchLabel: m.label || m.id,
            };
          }
        }
      }
    }

    if (m.completed) {
      const margin = Math.abs(s1 - s2);
      if (!highestScoringMatch || pts > highestScoringMatch.total) {
        highestScoringMatch = { match: m, total: pts };
      }
      if (!biggestBlowout || margin > biggestBlowout.margin) {
        biggestBlowout = {
          match: m,
          margin,
          winnerName: playerMap.get(m.winnerId)?.name || 'Winner',
        };
      }
      if (margin === winBy) {
        closestMarginCount += 1;
      }
      if (s1 >= targetPoints - 1 && s2 >= targetPoints - 1) {
        deuceMatchesCount += 1;
      }

      const elapsedMs = Number.isFinite(m.elapsedMs)
        ? Math.max(0, m.elapsedMs)
        : m.startedAt && m.completedAt
          ? Math.max(0, Number(m.timerOffsetMs) || 0) +
            Math.max(0, Number(m.completedAt) - Number(m.startedAt))
          : 0;
      if (elapsedMs > 0) {
        timedMatchesCount += 1;
        totalElapsedMs += elapsedMs;
        if (!longestMatch || elapsedMs > longestMatch.elapsedMs) {
          longestMatch = { match: m, elapsedMs };
        }
      }

      const p1Stat = ensurePlayerStat(m.player1Id);
      const p2Stat = ensurePlayerStat(m.player2Id);
      if (p1Stat) {
        p1Stat.matchesPlayed += 1;
        p1Stat.pointsFor += s1;
        p1Stat.pointsAgainst += s2;
        p1Stat.pointDiff = p1Stat.pointsFor - p1Stat.pointsAgainst;
        if (m.winnerId === m.player1Id) p1Stat.wins += 1;
        else if (m.winnerId) p1Stat.losses += 1;
      }
      if (p2Stat) {
        p2Stat.matchesPlayed += 1;
        p2Stat.pointsFor += s2;
        p2Stat.pointsAgainst += s1;
        p2Stat.pointDiff = p2Stat.pointsFor - p2Stat.pointsAgainst;
        if (m.winnerId === m.player2Id) p2Stat.wins += 1;
        else if (m.winnerId) p2Stat.losses += 1;
      }
    }
  }

  const leaderboard = Array.from(perPlayer.values()).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
    if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
    return a.seed - b.seed;
  });

  const completedPointsTotal = completedMatches.reduce(
    (sum, m) => sum + (Number(m.score1) || 0) + (Number(m.score2) || 0),
    0
  );
  const avgPointsPerMatch =
    completedMatches.length > 0 ? Math.round((completedPointsTotal / completedMatches.length) * 10) / 10 : 0;
  const avgMatchDurationMs =
    timedMatchesCount > 0 ? Math.round(totalElapsedMs / timedMatchesCount) : 0;
  const progressPct =
    allRealMatches.length > 0 ? Math.round((completedMatches.length / allRealMatches.length) * 100) : 0;

  return {
    totalMatches: allRealMatches.length,
    totalSlotsIncludingByes: allMatches.length,
    byeCount,
    completedCount: completedMatches.length,
    remainingCount: allRealMatches.length - completedMatches.length,
    progressPct,
    totalPointsPlayed,
    avgPointsPerMatch,
    avgMatchDurationMs,
    highestScoringMatch,
    biggestBlowout,
    longestMatch,
    longestPointStreak,
    closestMarginCount,
    deuceMatchesCount,
    leaderboard,
    recentCompleted: completedMatches.slice(0, 6),
    upNext: upNextQueue.slice(0, 6),
  };
}
