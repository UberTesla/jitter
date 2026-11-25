/**
 * Accessible & Contextual Template Variables for Grandma's Commentary Phrases.
 * Supports `$var` and `${var}` syntax (case-insensitive), single-pass safe replacement,
 * and rich metadata for accessible variable picker chips & live previews.
 */
import { evaluateMatchState } from './scoringEngine.js';

export const GRANDMA_VARIABLES = [
  // Match & Entrants
  {
    key: 'player1',
    token: '$player1',
    group: 'Match',
    label: 'Player 1',
    description: 'Player or Team 1 in the active match',
  },
  {
    key: 'player2',
    token: '$player2',
    group: 'Match',
    label: 'Player 2',
    description: 'Player or Team 2 in the active match',
  },
  {
    key: 'scoringPlayer',
    token: '$scoringPlayer',
    group: 'Match',
    label: 'Scoring Player',
    description: 'Player or team that most recently scored a point',
  },
  {
    key: 'leader',
    token: '$leader',
    group: 'Match',
    label: 'Leader',
    description: 'Currently leading player/team (falls back to "both sides" if tied)',
  },
  {
    key: 'trailer',
    token: '$trailer',
    group: 'Match',
    label: 'Trailer',
    description: 'Currently trailing player/team (falls back to "both sides" if tied)',
  },
  {
    key: 'server',
    token: '$server',
    group: 'Match',
    label: 'Server',
    description: 'Current serving player or doubles teammate',
  },
  {
    key: 'winner',
    token: '$winner',
    group: 'Match',
    label: 'Winner',
    description: 'Match winner (or last completed match winner / current leader)',
  },
  {
    key: 'loser',
    token: '$loser',
    group: 'Match',
    label: 'Runner-Up',
    description: 'Match runner-up (or trailing player)',
  },
  {
    key: 'round',
    token: '$round',
    group: 'Match',
    label: 'Round',
    description: 'Current match round name (e.g. Round 1, Semifinals)',
  },
  {
    key: 'match',
    token: '$match',
    group: 'Match',
    label: 'Match ID',
    description: 'Active match label (e.g. M1, GF)',
  },

  // Score & Rules
  {
    key: 'score1',
    token: '$score1',
    group: 'Score',
    label: 'Score 1',
    description: 'Player or Team 1 current points',
  },
  {
    key: 'score2',
    token: '$score2',
    group: 'Score',
    label: 'Score 2',
    description: 'Player or Team 2 current points',
  },
  {
    key: 'score',
    token: '$score',
    group: 'Score',
    label: 'Scoreline',
    description: 'Formatted scoreline (e.g. 10-8)',
  },
  {
    key: 'pointDiff',
    token: '$pointDiff',
    group: 'Score',
    label: 'Point Diff',
    description: 'Absolute point difference between both sides',
  },
  {
    key: 'targetPoints',
    token: '$targetPoints',
    group: 'Score',
    label: 'Game Points',
    description: 'Target points to win a game (e.g. 11 or 21)',
  },
  {
    key: 'winBy',
    token: '$winBy',
    group: 'Score',
    label: 'Win By',
    description: 'Minimum winning margin rule (e.g. 2)',
  },

  // Tables & Tournament
  {
    key: 'table',
    token: '$table',
    group: 'Tournament',
    label: 'Current Table',
    description: 'Table assigned to the active match (e.g. Table 1)',
  },
  {
    key: 'tables',
    token: '$tables',
    group: 'Tournament',
    label: 'Total Tables',
    description: 'Total number of tables configured in tournament rules',
  },
  {
    key: 'tournament',
    token: '$tournament',
    group: 'Tournament',
    label: 'Tournament',
    description: 'Tournament banner title',
  },
  {
    key: 'playersRemaining',
    token: '$playersRemaining',
    group: 'Tournament',
    label: 'Remaining',
    description: 'Entrants still active in the tournament',
  },
  {
    key: 'totalPlayers',
    token: '$totalPlayers',
    group: 'Tournament',
    label: 'Total Entrants',
    description: 'Total players/teams in the tournament',
  },

  // Time & Broadcast
  {
    key: 'time',
    token: '$time',
    group: 'Time',
    label: 'Current Time',
    description: 'Current local clock time (e.g. 1:00 pm)',
  },
  {
    key: 'date',
    token: '$date',
    group: 'Time',
    label: 'Current Date',
    description: 'Current local date (e.g. Nov 20, 2026)',
  },
  {
    key: 'day',
    token: '$day',
    group: 'Time',
    label: 'Day of Week',
    description: 'Current day of the week (e.g. Wednesday)',
  },
  {
    key: 'upNext',
    token: '$upNext',
    group: 'Tournament',
    label: 'Up Next',
    description: 'Next upcoming matchup on deck (e.g. Alice vs Bob)',
  },
  {
    key: 'joinCode',
    token: '$joinCode',
    group: 'Tournament',
    label: 'Join Key',
    description: '4-word tournament join key',
  },
  {
    key: 'countdown',
    token: '$countdown',
    group: 'Time',
    label: 'Live Countdown',
    description: 'Live countdown to a clock time or duration (e.g. $countdown 10m or $countdown 1:00pm)',
  },
  {
    key: 'matchesLeft',
    token: '$matchesLeft',
    group: 'Tournament',
    label: 'Matches Left',
    description: 'Remaining uncompleted matches in the bracket',
  },
  {
    key: 'champion',
    token: '$champion',
    group: 'Tournament',
    label: 'Champion',
    description: 'Crowned champion name (or "our future champion" before finals)',
  },
];

const KNOWN_KEY_SET = new Set([
  ...GRANDMA_VARIABLES.map((v) => v.key.toLowerCase()),
  'scorer',
]);
const VAR_TOKEN_REGEX = /\$\$|\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Computes a live map of lowercase variable keys -> resolved string values
 * from the current tournament state (and optional in-flight match snapshot).
 */
export function buildGrandmaVariableMap(state, extraContext = {}) {
  const s = state || {};
  const players = Array.isArray(s.players) ? s.players : [];
  const playerMap = new Map(players.map((p) => [p.id, p]));
  const matchesObj = s.matches || {};
  const activeMatch =
    extraContext.match ||
    (s.activeMatchId ? matchesObj[s.activeMatchId] : null) ||
    Object.values(matchesObj).find((m) => m && !m.isBye) ||
    null;

  const isTeams = s.entryMode === 'teams';
  const rules = s.rules || {};
  const targetPoints = Math.max(1, Math.floor(Number(rules.targetPoints) || 11));
  const winBy = Math.max(1, Math.floor(Number(rules.winBy ?? 2) || 2));
  const tableCount = Math.max(1, Math.floor(Number(rules.tableCount ?? 1) || 1));

  const p1 = activeMatch?.player1Id ? playerMap.get(activeMatch.player1Id) : null;
  const p2 = activeMatch?.player2Id ? playerMap.get(activeMatch.player2Id) : null;

  const p1Name = p1?.name || activeMatch?.source1Label || (isTeams ? 'Team 1' : 'Player 1');
  const p2Name = p2?.name || activeMatch?.source2Label || (isTeams ? 'Team 2' : 'Player 2');

  const score1 = Math.max(0, Number(activeMatch?.score1) || 0);
  const score2 = Math.max(0, Number(activeMatch?.score2) || 0);
  const pointDiff = Math.abs(score1 - score2);

  // Determine the player/team who most recently scored a point
  const history = Array.isArray(activeMatch?.pointHistory) ? activeMatch.pointHistory : [];
  const lastSlot =
    extraContext.scoringSlot === 1 || extraContext.scoringSlot === 2
      ? extraContext.scoringSlot
      : history.length > 0
      ? history[history.length - 1]
      : null;
  let scoringPlayer = 'the player';
  if (lastSlot === 1) {
    scoringPlayer = p1Name;
  } else if (lastSlot === 2) {
    scoringPlayer = p2Name;
  } else if (score1 > score2) {
    scoringPlayer = p1Name;
  } else if (score2 > score1) {
    scoringPlayer = p2Name;
  }

  let leader = 'both sides';
  let trailer = 'both sides';
  if (score1 > score2) {
    leader = p1Name;
    trailer = p2Name;
  } else if (score2 > score1) {
    leader = p2Name;
    trailer = p1Name;
  }

  const evalState = activeMatch ? evaluateMatchState(activeMatch, rules) : null;
  let serverName = p1Name;
  if (evalState?.activeServer === 2) {
    if (isTeams && Array.isArray(p2?.members)) {
      const mName = p2.members[evalState.activeServerMemberIndex] || p2.members[0];
      serverName = mName || p2Name;
    } else {
      serverName = p2Name;
    }
  } else if (evalState?.activeServer === 1) {
    if (isTeams && Array.isArray(p1?.members)) {
      const mName = p1.members[evalState.activeServerMemberIndex] || p1.members[0];
      serverName = mName || p1Name;
    } else {
      serverName = p1Name;
    }
  }

  let winnerName = null;
  let loserName = null;
  if (activeMatch?.winnerId) {
    winnerName = playerMap.get(activeMatch.winnerId)?.name || null;
    const loserId =
      activeMatch.winnerId === activeMatch.player1Id
        ? activeMatch.player2Id
        : activeMatch.player1Id;
    loserName = loserId ? playerMap.get(loserId)?.name || null : null;
  } else if (evalState?.winnerSlot === 1) {
    winnerName = p1Name;
    loserName = p2Name;
  } else if (evalState?.winnerSlot === 2) {
    winnerName = p2Name;
    loserName = p1Name;
  } else if (s.lastCompletedEvent?.winnerId) {
    winnerName = playerMap.get(s.lastCompletedEvent.winnerId)?.name || null;
    const evtLoserId =
      s.lastCompletedEvent.winnerId === s.lastCompletedEvent.player1Id
        ? s.lastCompletedEvent.player2Id
        : s.lastCompletedEvent.player1Id;
    loserName = evtLoserId ? playerMap.get(evtLoserId)?.name || null : null;
  }

  if (!winnerName) winnerName = score1 !== score2 ? leader : 'the winner';
  if (!loserName) loserName = score1 !== score2 ? trailer : 'the challenger';

  const matchTableNum = Math.max(
    1,
    Math.min(tableCount, Math.floor(Number(activeMatch?.tableNumber) || 1))
  );

  // Count remaining matches and non-eliminated entrants
  const realMatches = Object.values(matchesObj).filter((m) => m && !m.isBye);
  const matchesLeft = realMatches.filter((m) => !m.completed).length;

  const lossCounts = new Map();
  for (const m of realMatches) {
    if (m.completed && m.winnerId) {
      const lostId = m.winnerId === m.player1Id ? m.player2Id : m.player1Id;
      if (lostId) {
        lossCounts.set(lostId, (lossCounts.get(lostId) || 0) + 1);
      }
    }
  }
  const elimThreshold = s.format === 'double' ? 2 : 1;
  const playersRemaining = players.filter(
    (p) => (lossCounts.get(p.id) || 0) < elimThreshold
  ).length;

  const championName = s.championId
    ? playerMap.get(s.championId)?.name || 'our champion'
    : 'our future champion';

  const nowDate = extraContext.now ? new Date(extraContext.now) : new Date();
  const fmtClock = (d) =>
    d
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
      .toLowerCase();
  const currentTimeStr = fmtClock(nowDate);
  const currentDateStr = nowDate.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const currentDayStr = nowDate.toLocaleDateString([], { weekday: 'long' });

  // Find next upcoming match for $upNext
  const upcomingMatch = Object.values(s.matches || {})
    .filter((m) => m && !m.isBye && !m.completed && m.id !== activeMatch?.id)
    .sort((a, b) => (a.round || 0) - (b.round || 0) || (a.matchNumber || 0) - (b.matchNumber || 0))[0];
  const upNextStr = upcomingMatch
    ? `${(upcomingMatch.player1Id ? playerMap.get(upcomingMatch.player1Id)?.name : null) || upcomingMatch.source1Label || 'TBD'} vs ${(upcomingMatch.player2Id ? playerMap.get(upcomingMatch.player2Id)?.name : null) || upcomingMatch.source2Label || 'TBD'}`
    : 'TBD';

  const raw = {
    player1: p1Name,
    player2: p2Name,
    scoringPlayer,
    scorer: scoringPlayer,
    leader,
    trailer,
    server: serverName,
    winner: winnerName,
    loser: loserName,
    round: activeMatch?.roundLabel || 'Current Round',
    match: activeMatch?.label || 'Match 1',
    score1: String(score1),
    score2: String(score2),
    score: `${score1}-${score2}`,
    pointDiff: String(pointDiff),
    targetPoints: String(targetPoints),
    winBy: String(winBy),
    table: `Table ${matchTableNum}`,
    tables: String(tableCount),
    tournament: s.tournamentName || 'Ping Pong Championship',
    playersRemaining: String(playersRemaining || players.length || 0),
    totalPlayers: String(s.playerCount || players.length || 0),
    matchesLeft: String(matchesLeft),
    champion: championName,
    time: currentTimeStr,
    date: currentDateStr,
    day: currentDayStr,
    upNext: upNextStr,
    joinCode: s.joinCode || '',
  };

  const lowerMap = {};
  for (const [k, v] of Object.entries(raw)) {
    lowerMap[k.toLowerCase()] = v;
  }
  return lowerMap;
}

/**
 * Resolves all known `$variable` and `${variable}` tokens in `template`
 * using a single-pass regex replacement. `$$` escapes a literal `$` (e.g. `$$player1` -> `$player1`).
 */
export function resolveGrandmaPhrase(template, state, extraContext = {}) {
  const text = String(template ?? '');
  if (!text || !text.includes('$')) return text;
  const varMap = buildGrandmaVariableMap(state, extraContext);
  return text.replace(VAR_TOKEN_REGEX, (fullMatch, bracedName, plainName) => {
    if (fullMatch === '$$') return '$';
    const key = String(bracedName || plainName || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(varMap, key)) {
      return varMap[key];
    }
    return fullMatch;
  });
}

const COUNTDOWN_TOKEN_REGEX =
  /\$countdown(?:\s+|\()?(?:(\d{1,2})(?::?(\d{2}))?\s*([ap]m?)|(\d+)\s*(?:(seconds?|secs?|s)|(minutes?|mins?|m)|(hours?|hrs?|h)))(?:\)|(?![a-zA-Z0-9]))/gi;
const LIVE_CD_MARKER_REGEX = /\[\[CD:(\d+)\]\]/g;

/**
 * Formats a remaining duration until `targetMs` as `MM:SS` (or `H:MM:SS` if >= 1 hour).
 */
export function formatCountdownRemaining(targetMs, nowMs = Date.now()) {
  const totalSec = Math.max(0, Math.ceil((Number(targetMs) - Number(nowMs)) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

/**
 * Renders a message object (or string) with live `[[CD:<targetMs>]]` countdown markers resolved at `nowMs`.
 */
export function renderLiveMessageText(msgOrText, nowMs = Date.now()) {
  const src =
    typeof msgOrText === 'string'
      ? msgOrText
      : msgOrText?.liveTemplate || msgOrText?.message || '';
  if (!src || !src.includes('[[CD:')) return src;
  return src.replace(LIVE_CD_MARKER_REGEX, (_, ts) =>
    formatCountdownRemaining(Number(ts), nowMs)
  );
}

/**
 * Parses a `$dismissal...` time token such as `$dismissal100p`, `$dismissal1:30pm`,
 * `$dismissal9a`, or relative `$dismissal15m` / `$dismissal30s`.
 * Returns `{ dismissAt, label }` (e.g. `label: '1:00 pm'`).
 */
export function parseDismissalMatch(hStr, mStr, merStr, relNumStr, relUnitStr, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (relNumStr && relUnitStr) {
    const qty = Math.max(1, Number(relNumStr) || 1);
    const unit = relUnitStr.toLowerCase();
    const mult = unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000;
    const target = new Date(nowMs + qty * mult);
    const label = target
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
      .toLowerCase();
    return { dismissAt: target.getTime(), label };
  }
  if (hStr && merStr) {
    let hour12 = Number(hStr);
    let min = mStr ? Number(mStr) : 0;
    if (hour12 < 1 || hour12 > 12 || min < 0 || min > 59) return null;
    const isPm = merStr.toLowerCase().startsWith('p');
    let hour24 = hour12 % 12;
    if (isPm) hour24 += 12;
    const target = new Date(now);
    target.setHours(hour24, min, 0, 0);
    // If that clock time already passed today, schedule for tomorrow
    if (target.getTime() <= nowMs) {
      target.setDate(target.getDate() + 1);
    }
    const label = `${hour12}:${String(min).padStart(2, '0')} ${isPm ? 'pm' : 'am'}`;
    return { dismissAt: target.getTime(), label };
  }
  return null;
}

/**
 * Resolves all template variables (including Grandma variables, `$time`, `$date`, `$upNext`,
 * `$joinCode`, and dynamic `$dismissal<time>` tokens like `$dismissal100p` -> `1:00 pm`).
 * Returns `{ text, dismissAt, dismissalLabel }`.
 */
export function resolveMessageTemplate(template, state, extraContext = {}) {
  const raw = String(template ?? '');
  if (!raw || !raw.includes('$')) {
    return { text: raw, liveTemplate: raw, countdownTargetAt: null, countdownLabel: null };
  }
  const nowMs = extraContext.now || Date.now();
  let countdownTargetAt = null;
  let countdownLabel = null;

  const afterCountdown = raw.replace(
    COUNTDOWN_TOKEN_REGEX,
    (fullMatch, hStr, mStr, merStr, relNumStr, secUnit, minUnit, hrUnit) => {
      const relUnitStr = hrUnit ? 'h' : minUnit ? 'm' : secUnit ? 's' : '';
      const parsed = parseDismissalMatch(hStr, mStr, merStr, relNumStr, relUnitStr, nowMs);
      if (!parsed) return fullMatch;
      countdownTargetAt = parsed.dismissAt;
      countdownLabel = parsed.label;
      return `[[CD:${parsed.dismissAt}]]`;
    }
  );

  const liveTemplate = resolveGrandmaPhrase(afterCountdown, state, extraContext);
  const text = renderLiveMessageText(liveTemplate, nowMs);
  return { text, liveTemplate, countdownTargetAt, countdownLabel };
}

/**
 * Returns true if the template contains at least one recognized Grandma/message variable,
 * a `$countdown...` token, or an escaped `$$` literal that will transform on display.
 */
export function hasGrandmaVariables(template) {
  const text = String(template ?? '');
  if (!text || !text.includes('$')) return false;
  COUNTDOWN_TOKEN_REGEX.lastIndex = 0;
  if (COUNTDOWN_TOKEN_REGEX.test(text)) return true;
  VAR_TOKEN_REGEX.lastIndex = 0;
  let match;
  while ((match = VAR_TOKEN_REGEX.exec(text)) !== null) {
    if (match[0] === '$$') return true;
    const key = String(match[1] || match[2] || '').toLowerCase();
    if (KNOWN_KEY_SET.has(key)) return true;
  }
  return false;
}

const ACTIVE_VAR_QUERY_REGEX = /(?:^|[\s([{"'—–-])(\$+)(?:([a-zA-Z0-9_]*))$/;

/**
 * Detects whether the cursor is currently typing an unescaped `$variable` token.
 * Even runs of `$` (e.g. `$$`, `$$pl`) are treated as escaped literals and return `null`.
 * Returns `{ start, end, query }` where `start` is the index of the active `$`, or `null`.
 */
export function findActiveVariableQuery(text, cursorPos) {
  const str = String(text ?? '');
  const pos =
    typeof cursorPos === 'number' && Number.isFinite(cursorPos)
      ? Math.max(0, Math.min(str.length, cursorPos))
      : str.length;
  const before = str.slice(0, pos);
  const match = before.match(ACTIVE_VAR_QUERY_REGEX);
  if (!match) return null;
  const dollars = match[1];
  const query = match[2] || '';
  // Even number of `$` signs means every `$` is escaped (`$$` -> `$`), so don't open autocomplete
  if (dollars.length % 2 === 0) return null;
  const start = pos - query.length - 1;
  return { start, end: pos, query };
}

/**
 * Filters and ranks Grandma variables matching `query` (case-insensitive):
 * 1. Key prefix matches first
 * 2. Key or label substring matches second
 * 3. Description substring matches third
 */
export function filterGrandmaVariables(query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return GRANDMA_VARIABLES;
  const prefix = [];
  const sub = [];
  const desc = [];
  for (const v of GRANDMA_VARIABLES) {
    const keyLow = v.key.toLowerCase();
    const lblLow = v.label.toLowerCase();
    const descLow = v.description.toLowerCase();
    if (keyLow.startsWith(q)) prefix.push(v);
    else if (keyLow.includes(q) || lblLow.includes(q)) sub.push(v);
    else if (descLow.includes(q)) desc.push(v);
  }
  return [...prefix, ...sub, ...desc];
}

/**
 * Replaces the active `$query` span in `text` with `token` and calculates the new cursor position.
 */
export function applyVariableCompletion(text, queryRange, token) {
  const str = String(text ?? '');
  if (!queryRange || typeof queryRange.start !== 'number') {
    const sep = str && !str.endsWith(' ') ? ' ' : '';
    const next = `${str}${sep}${token}`;
    return { value: next, cursorPos: next.length };
  }
  const before = str.slice(0, queryRange.start);
  const after = str.slice(queryRange.end);
  const needsTrailingSpace = after.length === 0 || !/^[\s!.,?;:)'"}\]]/.test(after);
  const inserted = `${token}${needsTrailingSpace ? ' ' : ''}`;
  const value = `${before}${inserted}${after}`;
  return {
    value,
    cursorPos: before.length + inserted.length,
  };
}

