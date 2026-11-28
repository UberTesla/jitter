import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateMatchState,
  adjustMatchScore,
  undoLastPoint,
  toggleInitialServer,
  computeMatchElapsedMs,
  formatMatchTimer,
  MATCH_STATUS,
} from '../src/engine/scoringEngine.js';
import {
  detectNotificationEvents,
  DEFAULT_NOTIFICATION_PREFS,
} from '../src/engine/notificationService.js';
import {
  resolveMessageTemplate,
  renderLiveMessageText,
} from '../src/engine/grandmaVariables.js';
import {
  createPlayers,
  generateBracket,
  completeMatchAndAdvance,
  computeTournamentStats,
  getStandardSeedOrder,
} from '../src/engine/bracketGenerator.js';
import {
  TournamentStore,
  createInitialState,
  selectScoreGrandmaQuote,
  deduplicateTournamentLists,
  canDeviceAccessHostControls,
  resolveEffectiveRole,
  getRolePermissions,
  getAssignableRoles,
  canAssignRole,
} from '../src/state/tournamentStore.js';
import { createLanSyncHandler } from '../src/server/lanSyncMiddleware.js';
import { generateQrMatrix, qrMatrixToSvgPath } from '../src/engine/qrCode.js';
import { rankLanAddresses, resolveShareOrigin } from '../src/engine/lanAddress.js';
import {
  resolveGrandmaPhrase,
  hasGrandmaVariables,
  findActiveVariableQuery,
  filterGrandmaVariables,
  applyVariableCompletion,
} from '../src/engine/grandmaVariables.js';
import {
  generateFourWordId,
  isFourWordId,
  normalizeFourWordId,
  deriveDeterministicFourWordId,
} from '../src/engine/tournamentId.js';

test('11-point game: 2-point serve rotation, deuce 1-point switch, strict win-by-2', () => {
  const rules = { targetPoints: 11, serveRotation: 2 };
  let m = { player1Id: 'p1', player2Id: 'p2', score1: 0, score2: 0, initialServer: 1, pointHistory: [], completed: false };

  // 0-0 -> P1 serves (2 left)
  let ev = evaluateMatchState(m, rules);
  assert.equal(ev.activeServer, 1);
  assert.equal(ev.pointsUntilServeSwitch, 2);
  assert.equal(ev.status, MATCH_STATUS.READY);

  // 1-0 -> P1 serves (1 left)
  m = adjustMatchScore(m, 1, 1, rules);
  ev = evaluateMatchState(m, rules);
  assert.equal(ev.activeServer, 1);
  assert.equal(ev.pointsUntilServeSwitch, 1);

  // 2-0 -> switches to P2
  m = adjustMatchScore(m, 1, 1, rules);
  ev = evaluateMatchState(m, rules);
  assert.equal(ev.activeServer, 2);

  // Undo last point -> back to 1-0, P1 serving
  m = undoLastPoint(m);
  assert.equal(m.score1, 1);
  assert.equal(evaluateMatchState(m, rules).activeServer, 1);

  // Jump to 10-9 (Game Point P1, not yet deuce)
  m = { ...m, score1: 10, score2: 9 };
  ev = evaluateMatchState(m, rules);
  assert.equal(ev.status, MATCH_STATUS.GAME_POINT);
  assert.equal(ev.gamePointFor, 1);
  assert.equal(ev.activeServer, 2); // total 19 -> floor(19/2) = 9 (odd) -> P2

  // 10-10 -> DEUCE, switches every 1 point
  m = { ...m, score1: 10, score2: 10 };
  ev = evaluateMatchState(m, rules);
  assert.equal(ev.status, MATCH_STATUS.DEUCE);
  assert.equal(ev.isDeuce, true);
  assert.equal(ev.activeServer, 1); // total 20 -> P1

  // 11-10 -> GAME POINT P1 (not winner yet because win-by-2), server switches to P2
  m = { ...m, score1: 11, score2: 10 };
  ev = evaluateMatchState(m, rules);
  assert.equal(ev.status, MATCH_STATUS.GAME_POINT);
  assert.equal(ev.winnerSlot, null);
  assert.equal(ev.activeServer, 2);

  // 12-10 -> WINNER P1
  m = { ...m, score1: 12, score2: 10 };
  ev = evaluateMatchState(m, rules);
  assert.equal(ev.status, MATCH_STATUS.WINNER);
  assert.equal(ev.winnerSlot, 1);
  assert.equal(ev.canComplete, true);
});

test('21-point game: 5-point classic serve rotation & Switch 1st Server toggle', () => {
  const rules = { targetPoints: 21, serveRotation: 5 };
  let m = { player1Id: 'p1', player2Id: 'p2', score1: 3, score2: 2, initialServer: 1, pointHistory: [], completed: false };

  // Total 5 -> switched to P2
  assert.equal(evaluateMatchState(m, rules).activeServer, 2);

  // Switch 1st server -> now P1 serves at total 5
  m = toggleInitialServer(m);
  assert.equal(m.initialServer, 2);
  assert.equal(evaluateMatchState(m, rules).activeServer, 1);

  // 20-20 -> DEUCE in 21-point game
  m = { ...m, score1: 20, score2: 20 };
  let ev = evaluateMatchState(m, rules);
  assert.equal(ev.status, MATCH_STATUS.DEUCE);
  assert.equal(ev.activeServer, 2); // initialServer=2, 40/5=8 (even) -> P2

  // 21-20 -> server alternates every 1 point
  m = { ...m, score1: 21, score2: 20 };
  assert.equal(evaluateMatchState(m, rules).activeServer, 1);
});

test('Standard tournament seeding for 4, 8, and 16 players', () => {
  assert.deepEqual(getStandardSeedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(getStandardSeedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.deepEqual(getStandardSeedOrder(16), [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]);
});

test('Double Elimination 8-player full bracket progression to Grand Final champion', () => {
  const players = createPlayers(8);
  let matches = generateBracket(players, 'double');
  const rules = { targetPoints: 11, serveRotation: 2 };

  // 8-player Double Elim: 7 Winners + 6 Losers + 1 Grand Final = 14 matches
  assert.equal(Object.keys(matches).length, 14);
  assert.equal(matches['W-R1-M1'].label, 'QF M1');
  assert.equal(matches['W-R1-M1'].player1Id, 'p1');
  assert.equal(matches['W-R1-M1'].player2Id, 'p8');
  assert.equal(matches['W-R1-M2'].player1Id, 'p4');
  assert.equal(matches['W-R1-M2'].player2Id, 'p5');

  // Verify R1 M3 standard formatting on 16-player bracket
  const matches16 = generateBracket(createPlayers(16), 'single');
  assert.equal(matches16['W-R1-M3'].label, 'R1 M3');

  // Simulate playing every ready match until Grand Final concludes
  let activeId = 'W-R1-M1';
  let championId = null;
  let safety = 0;

  while (!championId && safety < 20) {
    safety += 1;
    const m = matches[activeId];
    assert.ok(m.player1Id && m.player2Id, `Match ${activeId} must have both players ready`);
    matches = {
      ...matches,
      [activeId]: { ...m, score1: 11, score2: 6 },
    };
    const res = completeMatchAndAdvance(matches, activeId, rules, 8, 'double');
    assert.equal(res.completed, true);
    matches = res.matches;
    activeId = res.nextActiveMatchId;
    championId = res.championId;
  }

  assert.equal(safety, 14, 'All 14 matches should complete cleanly');
  assert.ok(championId, 'A tournament champion must be crowned after Grand Final');
  assert.equal(matches['GF-M1'].completed, true);
});

test('Single Elimination 4, 8, and 16 player match counts', () => {
  for (const count of [4, 8, 16]) {
    const players = createPlayers(count);
    const single = generateBracket(players, 'single');
    assert.equal(Object.keys(single).length, count - 1);

    const dbl = generateBracket(players, 'double');
    assert.equal(Object.keys(dbl).length, 2 * count - 2);
  }
});

test('ANY player count (2, 3, 5, 6, 7, 9, 10, 12, 13, 19) resolves cleanly with BYEs in Single & Double Elimination', () => {
  const rules = { targetPoints: 11, serveRotation: 2 };
  const testCounts = [2, 3, 5, 6, 7, 9, 10, 12, 13, 19];

  for (const format of ['single', 'double']) {
    for (const count of testCounts) {
      const players = createPlayers(count);
      let matches = generateBracket(players, format);

      let activeId = Object.values(matches).find(
        (m) => !m.completed && !m.isBye && m.player1Id && m.player2Id
      )?.id;
      assert.ok(activeId, `Expected an initial playable match for ${count}p ${format}`);

      let championId = null;
      let played = 0;

      while (!championId && played < 120) {
        const m = matches[activeId];
        assert.ok(m && !m.isBye && m.player1Id && m.player2Id, `Invalid active match ${activeId} for ${count}p ${format}`);
        matches = {
          ...matches,
          [activeId]: { ...m, score1: 11, score2: 7 },
        };
        const res = completeMatchAndAdvance(matches, activeId, rules, count, format);
        assert.equal(res.completed, true);
        played += 1;
        matches = res.matches;
        activeId = res.nextActiveMatchId;
        championId = res.championId;
      }

      assert.ok(championId, `Champion must be crowned for ${count}p ${format} (played ${played})`);
      if (format === 'single') {
        assert.equal(played, count - 1, `Single elim ${count}p must play exactly N-1 real matches`);
      } else if (count >= 3) {
        assert.equal(played, 2 * count - 2, `Double elim ${count}p must play exactly 2N-2 real matches`);
      } else {
        assert.equal(played, 1, `2-player tournament plays 1 decisive match`);
      }
    }
  }
});

test('Teams / Doubles mode: team roster creation, doubles server teammate rotation, and team bracket progression', () => {
  const teams = createPlayers(5, [], 'teams');
  assert.equal(teams.length, 5);
  for (const t of teams) {
    assert.ok(t.name.length > 0);
    assert.ok(Array.isArray(t.members) && t.members.length === 2);
  }

  // Verify official Doubles server rotation (Team 1 M0 -> Team 2 M0 -> Team 1 M1 -> Team 2 M1)
  const rules = { targetPoints: 11, serveRotation: 2 };
  let match = { player1Id: 'p1', player2Id: 'p2', score1: 0, score2: 0, initialServer: 1, pointHistory: [], completed: false };

  // 0 pts: Team 1, Member 0
  let ev = evaluateMatchState(match, rules);
  assert.equal(ev.activeServer, 1);
  assert.equal(ev.activeServerMemberIndex, 0);

  // 2 pts: Team 2, Member 0
  match = { ...match, score1: 2, score2: 0 };
  ev = evaluateMatchState(match, rules);
  assert.equal(ev.activeServer, 2);
  assert.equal(ev.activeServerMemberIndex, 0);

  // 4 pts: Team 1, Member 1
  match = { ...match, score1: 2, score2: 2 };
  ev = evaluateMatchState(match, rules);
  assert.equal(ev.activeServer, 1);
  assert.equal(ev.activeServerMemberIndex, 1);

  // 6 pts: Team 2, Member 1
  match = { ...match, score1: 4, score2: 2 };
  ev = evaluateMatchState(match, rules);
  assert.equal(ev.activeServer, 2);
  assert.equal(ev.activeServerMemberIndex, 1);

  // 5-team Double Elimination bracket resolves cleanly to a winning team
  let matches = generateBracket(teams, 'double');
  let activeId = Object.values(matches).find(
    (m) => !m.completed && !m.isBye && m.player1Id && m.player2Id
  )?.id;
  let champId = null;
  let played = 0;

  while (!champId && played < 20) {
    const m = matches[activeId];
    matches = { ...matches, [activeId]: { ...m, score1: 11, score2: 8 } };
    const res = completeMatchAndAdvance(matches, activeId, rules, 5, 'double');
    assert.equal(res.completed, true);
    matches = res.matches;
    activeId = res.nextActiveMatchId;
    champId = res.championId;
    played += 1;
  }

  assert.equal(played, 8, '5-team Double Elim plays exactly 2*5 - 2 = 8 real matches');
  assert.ok(teams.some((t) => t.id === champId));
});

test('Naming policies: neutral names when Demo Mode & Auto Team Names are OFF, generated names only when toggled ON', () => {
  // Neutral Singles (demoMode = false)
  const neutralSingles = createPlayers(4, [], 'singles', { demoMode: false });
  assert.deepEqual(
    neutralSingles.map((p) => p.name),
    ['Player 1', 'Player 2', 'Player 3', 'Player 4']
  );

  // Neutral Teams (demoMode = false, autoTeamNames = false)
  const neutralTeams = createPlayers(3, [], 'teams', { demoMode: false, autoTeamNames: false });
  assert.deepEqual(
    neutralTeams.map((t) => t.name),
    ['Team 1', 'Team 2', 'Team 3']
  );
  assert.deepEqual(neutralTeams[0].members, ['Player 1', 'Player 2']);

  // Auto Team Names ON, Demo Mode OFF
  const themedTeams = createPlayers(3, [], 'teams', { demoMode: false, autoTeamNames: true });
  assert.notEqual(themedTeams[0].name, 'Team 1');
  assert.deepEqual(themedTeams[0].members, ['Player 1', 'Player 2']);

  // Demo Mode ON (generates realistic player names up to 256)
  const demo256 = createPlayers(256, [], 'singles', { demoMode: true });
  assert.equal(demo256.length, 256);
  assert.ok(!/^Player \d+$/.test(demo256[0].name));
  assert.ok(!/^Player \d+$/.test(demo256[255].name));
});

test('Large brackets up to 256 players (including non-power-of-2 like 100 and 256) complete cleanly', () => {
  const rules = { targetPoints: 11, serveRotation: 2 };

  for (const { count, format, expectedMatches } of [
    { count: 100, format: 'single', expectedMatches: 99 },
    { count: 256, format: 'single', expectedMatches: 255 },
    { count: 256, format: 'double', expectedMatches: 510 },
  ]) {
    const players = createPlayers(count, [], 'singles', { demoMode: false });
    let matches = generateBracket(players, format);

    let activeId = Object.values(matches).find(
      (m) => !m.completed && !m.isBye && m.player1Id && m.player2Id
    )?.id;
    let champId = null;
    let played = 0;

    while (!champId && played < 600) {
      const m = matches[activeId];
      assert.ok(m && !m.isBye && m.player1Id && m.player2Id);
      matches = { ...matches, [activeId]: { ...m, score1: 11, score2: 5 } };
      const res = completeMatchAndAdvance(matches, activeId, rules, count, format);
      assert.equal(res.completed, true);
      matches = res.matches;
      activeId = res.nextActiveMatchId;
      champId = res.championId;
      played += 1;
    }

    assert.equal(played, expectedMatches, `${count}p ${format} must play exactly ${expectedMatches} real matches`);
    assert.ok(champId, `Champion must be crowned for ${count}p ${format}`);
  }
});

test('Grandma categorized phrases: Game Point ALWAYS triggers; Contextual triggers randomly with cooldown', () => {
  const rules = { targetPoints: 11, serveRotation: 2 };
  const grandma = {
    banterQuotes: ['Idle banter'],
    contextualQuotes: ['Nice shot!'],
    gamePointQuotes: ['Game point alert!'],
    contextualChancePct: 25,
    stayDurationSec: 5,
    liveQuote: null,
  };

  // Normal point: randomFn=0.80 (> 0.25) -> should NOT comment
  const m1 = { player1Id: 'p1', player2Id: 'p2', score1: 3, score2: 2, completed: false };
  const m2 = { ...m1, score1: 4 };
  assert.equal(
    selectScoreGrandmaQuote(m1, m2, rules, grandma, { now: 10000, randomFn: () => 0.8 }),
    null
  );

  // Normal point: randomFn=0.10 (< 0.25) -> SHOULD trigger contextual quote
  const ctxQuote = selectScoreGrandmaQuote(m1, m2, rules, grandma, {
    now: 10000,
    randomFn: () => 0.1,
  });
  assert.equal(ctxQuote?.category, 'contextual');
  assert.equal(ctxQuote?.text, 'Nice shot!');

  // Immediately next point (within cooldown) -> should NOT spam contextual quote even if randomFn=0.01
  const grandmaWithRecent = { ...grandma, liveQuote: ctxQuote };
  assert.equal(
    selectScoreGrandmaQuote(m2, { ...m2, score1: 5 }, rules, grandmaWithRecent, {
      now: 12000,
      randomFn: () => 0.01,
    }),
    null
  );

  // Reaching Game Point (9-7 -> 10-7): MUST ALWAYS fire even with randomFn=0.99 and recent quote!
  const preGp = { player1Id: 'p1', player2Id: 'p2', score1: 9, score2: 7, completed: false };
  const atGp = { ...preGp, score1: 10 };
  const gpQuote = selectScoreGrandmaQuote(preGp, atGp, rules, grandmaWithRecent, {
    now: 12500,
    randomFn: () => 0.99,
  });
  assert.equal(gpQuote?.category, 'gamePoint');
  assert.equal(gpQuote?.text, 'Game point alert!');
});

test('Multi-scorekeeper debounce filter (in seconds) blocks rapid duplicate taps and allows valid taps after window', () => {
  const initial = createInitialState({
    playerCount: 4,
    rules: { targetPoints: 11, serveRotation: 2, scoreDebounceSec: 3 },
  });
  const store = new TournamentStore(initial);

  // First point at t=1000 -> accepted
  const r1 = store.addPoint(1, { now: 1000 });
  assert.equal(r1.accepted, true);
  assert.equal(store.getState().matches[store.getState().activeMatchId].score1, 1);

  // Rapid duplicate tap at t=2200 (1.2s later < 3s) -> rejected!
  const r2 = store.addPoint(1, { now: 2200 });
  assert.equal(r2.accepted, false);
  assert.equal(r2.remainingSec, 1.8);
  assert.equal(store.getState().matches[store.getState().activeMatchId].score1, 1);
  assert.equal(store.getState().debouncedClicks, 1);

  // Valid tap at t=4100 (3.1s later >= 3s) -> accepted!
  const r3 = store.addPoint(2, { now: 4100 });
  assert.equal(r3.accepted, true);
  assert.equal(store.getState().matches[store.getState().activeMatchId].score2, 1);
  store.destroy();
});

test('OBS-style Studio Mode stages edits separately from Program until Push Live or Discard', () => {
  const initial = createInitialState({
    playerCount: 4,
    presentation: { activeSlide: 'title' },
  });
  const store = new TournamentStore(initial);

  // Switch to Studio Mode
  store.setSyncMode('studio');
  assert.equal(store.getSyncMeta().syncMode, 'studio');
  assert.equal(store.getSyncMeta().hasUnpublishedChanges, false);

  // Change slide to 'bracket' in Studio Mode -> Preview changes, Program stays on 'title'
  store.setActiveSlide('bracket');
  assert.equal(store.getState().presentation.activeSlide, 'bracket');
  assert.equal(store.getSyncMeta().programState.presentation.activeSlide, 'title');
  assert.equal(store.getSyncMeta().hasUnpublishedChanges, true);

  // Discard -> reverts staged Preview back to 'title'
  store.discardStudioChanges();
  assert.equal(store.getState().presentation.activeSlide, 'title');
  assert.equal(store.getSyncMeta().hasUnpublishedChanges, false);

  // Stage 'arena' and Push Live -> Program transitions to 'arena'
  store.setActiveSlide('arena');
  store.publishStudioToLive();
  assert.equal(store.getSyncMeta().programState.presentation.activeSlide, 'arena');
  assert.equal(store.getSyncMeta().hasUnpublishedChanges, false);
  store.destroy();
});

test('Studio Mode score updates start a 3s cancellable timer and push ONLY scores live without leaking staged slides', () => {
  const initial = createInitialState({
    playerCount: 4,
    rules: { targetPoints: 11, serveRotation: 2, scoreDebounceSec: 0 },
    presentation: { activeSlide: 'arena' },
  });
  const store = new TournamentStore(initial);
  const matchId = store.getState().activeMatchId;

  // Enter Studio Mode and stage Slide 3 ('bracket')
  store.setSyncMode('studio');
  store.setActiveSlide('bracket');
  assert.equal(store.getSyncMeta().programState.presentation.activeSlide, 'arena');

  // Score a point in Studio Mode -> local score updates, 3s pending timer starts, Program not yet updated
  store.addPoint(1);
  assert.equal(store.getState().matches[matchId].score1, 1);
  assert.equal(store.getSyncMeta().programState.matches[matchId].score1, 0);
  assert.ok(store.getSyncMeta().pendingScorePush, 'Pending 3s score push must be active');
  assert.equal(store.getSyncMeta().pendingScorePush.durationMs, 3000);

  // Cancel within 3s -> reverts local score to 0 while keeping staged 'bracket' slide intact!
  store.cancelPendingScorePush();
  assert.equal(store.getState().matches[matchId].score1, 0);
  assert.equal(store.getSyncMeta().pendingScorePush, null);
  assert.equal(store.getState().presentation.activeSlide, 'bracket');

  // Score again and flush (simulating 3s timer completion / Send Now) ->
  // Program receives updated score (1-0) while Program slide stays 'arena' (does NOT leak 'bracket')!
  store.addPoint(1);
  store.flushPendingScorePush();
  assert.equal(store.getSyncMeta().programState.matches[matchId].score1, 1);
  assert.equal(store.getSyncMeta().programState.presentation.activeSlide, 'arena');
  assert.equal(store.getState().presentation.activeSlide, 'bracket');
  store.destroy();
});

test('LocalStorage persistence retains tournament progress, all options, blank subtitles, and Studio Mode across refresh', () => {
  const mem = new Map();
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
    },
  });

  try {
    // Session 1: configure tournament, options, play points, complete a match, stage Studio edits
    const store1 = new TournamentStore();
    store1.applyFullSetup({
      tournamentName: 'Holiday Basement Open',
      entryMode: 'teams',
      format: 'double',
      playerCount: 4,
      totalPlayers: 8,
      rules: { targetPoints: 21, serveRotation: 5, scoreDebounceSec: 2.5 },
      theme: 'christmas',
      titleAmbiance: 'snow',
      ambianceIntensity: 'high',
      scoreFont: 'orbitron',
      showMiniBracket: false,
      rebuildBracket: true,
    });
    store1.setPresentationConfig({
      activeSlide: 'bracket',
      titleSubtitle: '',
      bracketSubtitle: 'Winners Side Only',
      bracketViewFilter: 'winners',
      intermissionMessage: '',
      autoRotate: true,
      autoRotateSec: 25,
    });
    store1.setCornerAppearance({ cornerScale: 0.75, cornerOpacity: 0.8, bubbleScale: 1.25 });
    store1.togglePanelCollapsed('grandma');
    store1.updateGrandmaSettings({
      banterQuotes: ['Custom banter line'],
      contextualQuotes: ['Custom point line'],
      gamePointQuotes: ['Custom game point line'],
      contextualChancePct: 40,
      stayDurationSec: 7,
      minIntervalSec: 8,
      maxIntervalSec: 15,
    });

    const firstMatchId = store1.getState().activeMatchId;
    store1.addPoint(1, { bypassDebounce: true });
    store1.addPoint(1, { bypassDebounce: true });
    store1.addPoint(2, { bypassDebounce: true });

    // Switch to Studio Mode and stage an unpublished slide change
    store1.setSyncMode('studio');
    store1.setActiveSlide('split');
    store1.destroy();

    // Session 2: Simulate full browser refresh by constructing a fresh TournamentStore()
    const store2 = new TournamentStore();
    const s2 = store2.getState();
    const meta2 = store2.getSyncMeta();

    // Verify Live Program state persisted completely
    assert.equal(meta2.programState.tournamentName, 'Holiday Basement Open');
    assert.equal(meta2.programState.entryMode, 'teams');
    assert.equal(meta2.programState.format, 'double');
    assert.equal(meta2.programState.totalPlayers, 8);
    assert.equal(meta2.programState.roster.length, 8);
    assert.equal(meta2.programState.rules.targetPoints, 21);
    assert.equal(meta2.programState.rules.serveRotation, 5);
    assert.equal(meta2.programState.rules.scoreDebounceSec, 2.5);
    assert.equal(meta2.programState.ui.theme, 'christmas');
    assert.equal(meta2.programState.ui.scoreFont, 'orbitron');
    assert.equal(meta2.programState.ui.showMiniBracket, false);
    assert.equal(meta2.programState.ui.cornerScale, 0.75);
    assert.equal(meta2.programState.ui.cornerOpacity, 0.8);
    assert.equal(meta2.programState.ui.bubbleScale, 1.25);
    assert.equal(meta2.programState.ui.collapsedPanels.grandma, true);
    assert.equal(meta2.programState.presentation.activeSlide, 'bracket');
    assert.equal(meta2.programState.presentation.titleAmbiance, 'snow');
    assert.equal(meta2.programState.presentation.ambianceIntensity, 'high');
    assert.equal(meta2.programState.presentation.titleSubtitle, '');
    assert.equal(meta2.programState.presentation.bracketSubtitle, 'Winners Side Only');
    assert.equal(meta2.programState.presentation.bracketViewFilter, 'winners');
    assert.equal(meta2.programState.presentation.intermissionMessage, '');
    assert.equal(meta2.programState.presentation.autoRotate, true);
    assert.equal(meta2.programState.presentation.autoRotateSec, 25);
    assert.deepEqual(meta2.programState.grandma.banterQuotes, ['Custom banter line']);
    assert.equal(meta2.programState.grandma.contextualChancePct, 40);
    assert.equal(meta2.programState.matches[firstMatchId].score1, 2);
    assert.equal(meta2.programState.matches[firstMatchId].score2, 1);

    // Verify Studio Mode & staged preview slide survived refresh without leaking to Program
    assert.equal(meta2.syncMode, 'studio');
    assert.equal(meta2.hasUnpublishedChanges, true);
    assert.equal(s2.presentation.activeSlide, 'split');
    store2.destroy();
  } finally {
    if (prevStorage) {
      Object.defineProperty(globalThis, 'localStorage', prevStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('Engine-driven Grandma phrases sync activeSpeech across tabs & Studio Mode without leaking staged slides', () => {
  const initial = createInitialState({
    playerCount: 4,
    rules: { targetPoints: 11, serveRotation: 2, scoreDebounceSec: 0 },
    presentation: { activeSlide: 'arena' },
  });
  const controlStore = new TournamentStore(initial);
  const presentStore = new TournamentStore(initial);

  // Put Control into Studio Mode and stage a different slide
  controlStore.setSyncMode('studio');
  controlStore.setActiveSlide('bracket');
  assert.equal(controlStore.getSyncMeta().hasUnpublishedChanges, true);

  // Engine triggers idle banter -> updates both state & programState with synchronized timestamps
  const t0 = 1000000;
  const banter = controlStore.triggerNextBanterQuote({ now: t0, randomFn: () => 0.5 });
  assert.ok(banter && banter.text);
  assert.equal(banter.category, 'banter');
  assert.equal(banter.isLive, false);
  assert.equal(banter.startedAt, t0);
  assert.ok(banter.expiresAt > t0);
  assert.ok(banter.nextBanterAt > banter.expiresAt);
  assert.equal(controlStore.getSyncMeta().programState.grandma.activeSpeech.id, banter.id);
  assert.equal(controlStore.getSyncMeta().programState.presentation.activeSlide, 'arena');

  // Sync peer Presentation store via external speech handler -> identical activeSpeech
  presentStore.handleExternalGrandmaSpeech(banter);
  assert.equal(presentStore.getState().grandma.activeSpeech.id, banter.id);
  assert.equal(presentStore.getState().grandma.activeSpeech.text, banter.text);

  // While banter is still active, tickGrandmaEngine does NOT interrupt it
  assert.equal(controlStore.tickGrandmaEngine(t0 + 1000, 0), null);

  // Manual live cue overrides immediately with isLive=true and keeps Studio slide unpublished
  controlStore.triggerLiveQuote('What a backhand!', 'manual');
  const liveSpeech = controlStore.getSyncMeta().programState.grandma.activeSpeech;
  assert.equal(liveSpeech.text, 'What a backhand!');
  assert.equal(liveSpeech.isLive, true);
  assert.equal(controlStore.getSyncMeta().programState.presentation.activeSlide, 'arena');

  controlStore.destroy();
  presentStore.destroy();
});

test('Studio Mode only affects Control View; cross-view debounce blocks rapid taps across views with override support', () => {
  const mem = new Map();
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
    },
  });

  try {
    // Control tab enters Studio Mode and stages Slide 3 ('bracket')
    const control = new TournamentStore(null, { persist: true, viewMode: 'control' });
    control.applyFullSetup({
      playerCount: 4,
      rules: { targetPoints: 11, serveRotation: 2, scoreDebounceSec: 3 },
      rebuildBracket: true,
    });
    control.setActiveSlide('arena');
    control.setSyncMode('studio');
    control.setActiveSlide('bracket');
    assert.equal(control.getSyncMeta().syncMode, 'studio');
    assert.equal(control.getSyncMeta().programState.presentation.activeSlide, 'arena');

    // Separate Scorekeeper tab opens -> MUST NOT inherit Studio Mode!
    const scorekeeper = new TournamentStore(null, { persist: true, viewMode: 'scorekeeper' });
    assert.equal(scorekeeper.getSyncMeta().syncMode, 'live');
    assert.equal(scorekeeper.getState().presentation.activeSlide, 'arena');

    // Scorekeeper scores at t=10000 -> commits LIVE immediately (no pending 3s Studio countdown)
    const matchId = scorekeeper.getState().activeMatchId;
    const r1 = scorekeeper.addPoint(1, { now: 10000 });
    assert.equal(r1.accepted, true);
    assert.equal(scorekeeper.getSyncMeta().pendingScorePush, null);
    assert.equal(scorekeeper.getSyncMeta().programState.matches[matchId].score1, 1);

    // Control tab taps +1 just 500ms later (t=10500) -> cross-view debounce MUST block it!
    const r2 = control.addPoint(1, { now: 10500 });
    assert.equal(r2.accepted, false);
    assert.equal(r2.remainingMs, 2500);

    // Operator confirms Debounce Override dialog -> bypassDebounce succeeds immediately!
    const r3 = control.addPoint(1, { now: 10600, bypassDebounce: true });
    assert.equal(r3.accepted, true);

    // Switching same tab from Control -> Scorekeeper -> Control keeps Studio Mode isolated to Control
    control.setActiveViewMode('scorekeeper');
    assert.equal(control.getSyncMeta().syncMode, 'live');
    control.setActiveViewMode('control');
    assert.equal(control.getSyncMeta().syncMode, 'studio');
    assert.equal(control.getState().presentation.activeSlide, 'bracket');

    control.destroy();
    scorekeeper.destroy();
  } finally {
    if (prevStorage) {
      Object.defineProperty(globalThis, 'localStorage', prevStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('Scorekeeper cannot switch matches while a game is in progress unless returned to 0-0 or switched from Control', () => {
  const initial = createInitialState({
    playerCount: 4,
    rules: { targetPoints: 11, serveRotation: 2, scoreDebounceSec: 0 },
  });
  const store = new TournamentStore(initial, { persist: false, viewMode: 'scorekeeper' });
  const m1 = 'W-R1-M1';
  const m2 = 'W-R1-M2';

  // At 0-0, Scorekeeper CAN switch freely
  store.selectMatch(m2);
  assert.equal(store.getState().activeMatchId, m2);
  store.selectMatch(m1);
  assert.equal(store.getState().activeMatchId, m1);

  // Score 1-0 -> game is in progress; Scorekeeper CANNOT switch away
  store.addPoint(1);
  store.selectMatch(m2);
  assert.equal(store.getState().activeMatchId, m1, 'Scorekeeper must stay locked on in-progress match');

  // Control view CAN still switch away during an in-progress game
  store.setActiveViewMode('control');
  store.selectMatch(m2);
  assert.equal(store.getState().activeMatchId, m2);
  store.selectMatch(m1);
  assert.equal(store.getState().activeMatchId, m1);

  // Back in Scorekeeper: returning score to 0-0 unlocks match switching again!
  store.setActiveViewMode('scorekeeper');
  store.subtractPoint(1);
  store.selectMatch(m2);
  assert.equal(store.getState().activeMatchId, m2, 'Returning to 0-0 unlocks Scorekeeper match switch');

  store.destroy();
});

test('Match start gate, next-match recommendation event, and Control edit/reopen completed match with downstream rollback', () => {
  const initial = createInitialState({
    playerCount: 4,
    format: 'double',
    rules: { targetPoints: 11, serveRotation: 2, scoreDebounceSec: 0 },
  });
  const store = new TournamentStore(initial, { persist: false, viewMode: 'control' });
  const m1 = 'W-R1-M1';
  const m2 = 'W-R1-M2';

  // Require start before scoring when requireStarted=true
  assert.equal(store.getState().matches[m1].started, false);
  const blocked = store.addPoint(1, { requireStarted: true });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.requiresStart, true);

  // Starting the match unlocks scoring
  store.startMatch(m1);
  assert.equal(store.getState().matches[m1].started, true);
  assert.equal(store.addPoint(1, { requireStarted: true }).accepted, true);

  // Complete W-R1-M1 (11-7) -> populates lastCompletedEvent with recommendedMatchId
  store.setActiveMatchScoreDirect(11, 7);
  store.completeActiveMatch();
  const sAfter1 = store.getState();
  assert.equal(sAfter1.matches[m1].completed, true);
  assert.equal(sAfter1.matches[m1].winnerId, sAfter1.matches[m1].player1Id);
  assert.equal(sAfter1.lastCompletedEvent?.completedMatchId, m1);
  assert.equal(sAfter1.lastCompletedEvent?.recommendedMatchId, m2);
  assert.equal(sAfter1.matches['W-R2-M1'].player1Id, sAfter1.matches[m1].player1Id);
  assert.equal(sAfter1.matches['L-R1-M1'].player1Id, sAfter1.matches[m1].player2Id);

  // Edit completed W-R1-M1 with SAME winner (11-9) -> updates score without clearing W-R2-M1
  const sameWinnerEdit = store.editCompletedMatch(m1, 11, 9);
  assert.equal(sameWinnerEdit.edited, true);
  assert.equal(sameWinnerEdit.winnerChanged, false);
  assert.equal(store.getState().matches[m1].score2, 9);
  assert.equal(store.getState().matches['W-R2-M1'].player1Id, sAfter1.matches[m1].player1Id);

  // Edit completed W-R1-M1 with FLIPPED winner (8-11) -> re-seeds W-R2-M1 and L-R1-M1 cleanly!
  const flippedEdit = store.editCompletedMatch(m1, 8, 11);
  assert.equal(flippedEdit.edited, true);
  assert.equal(flippedEdit.winnerChanged, true);
  assert.equal(store.getState().matches[m1].winnerId, sAfter1.matches[m1].player2Id);
  assert.equal(store.getState().matches['W-R2-M1'].player1Id, sAfter1.matches[m1].player2Id);
  assert.equal(store.getState().matches['L-R1-M1'].player1Id, sAfter1.matches[m1].player1Id);

  // Reopen completed W-R1-M1 -> returns to active play & clears downstream W-R2-M1 and L-R1-M1 slots
  const reopened = store.reopenMatch(m1);
  assert.equal(reopened.reopened, true);
  assert.equal(store.getState().activeMatchId, m1);
  assert.equal(store.getState().matches[m1].completed, false);
  assert.equal(store.getState().matches[m1].started, true);
  assert.equal(store.getState().matches['W-R2-M1'].player1Id, null);
  assert.equal(store.getState().matches['L-R1-M1'].player1Id, null);

  store.destroy();
});

test('Custom game rules: arbitrary targetPoints, serveRotation, and winBy (sudden-death winBy=1 and winBy=3)', () => {
  // Game to 7, serve every 3, sudden-death win by 1
  const suddenDeathRules = { targetPoints: 7, serveRotation: 3, winBy: 1 };
  let m = { player1Id: 'p1', player2Id: 'p2', score1: 0, score2: 0, initialServer: 1, completed: false };

  // 2 pts -> still P1 (1 serve left in 3-serve rotation)
  m = { ...m, score1: 2, score2: 0 };
  let ev = evaluateMatchState(m, suddenDeathRules);
  assert.equal(ev.activeServer, 1);
  assert.equal(ev.pointsUntilServeSwitch, 1);

  // 3 pts -> switches to P2
  m = { ...m, score1: 2, score2: 1 };
  ev = evaluateMatchState(m, suddenDeathRules);
  assert.equal(ev.activeServer, 2);
  assert.equal(ev.pointsUntilServeSwitch, 3);

  // 6-6 -> DEUCE sudden death; 7-6 -> immediate WINNER (winBy=1)
  ev = evaluateMatchState({ ...m, score1: 6, score2: 6 }, suddenDeathRules);
  assert.equal(ev.status, MATCH_STATUS.DEUCE);
  ev = evaluateMatchState({ ...m, score1: 7, score2: 6 }, suddenDeathRules);
  assert.equal(ev.status, MATCH_STATUS.WINNER);
  assert.equal(ev.winnerSlot, 1);

  // Game to 15, serve every 4, win by 3
  const winBy3Rules = { targetPoints: 15, serveRotation: 4, winBy: 3 };
  // 15-13 is only margin 2 -> NOT winner yet, but P1 holds Game Point (16-13 wins!)
  ev = evaluateMatchState({ ...m, score1: 15, score2: 13 }, winBy3Rules);
  assert.equal(ev.winnerSlot, null);
  assert.equal(ev.status, MATCH_STATUS.GAME_POINT);
  assert.equal(ev.gamePointFor, 1);

  // 16-13 -> margin 3 -> WINNER!
  ev = evaluateMatchState({ ...m, score1: 16, score2: 13 }, winBy3Rules);
  assert.equal(ev.winnerSlot, 1);
  assert.equal(ev.status, MATCH_STATUS.WINNER);
});

test('Adding players mid-tournament preserves completed & in-progress matches without full rebuild (BYE fill & bracket expansion)', () => {
  // 1. Expanding 4 -> 5 in Single Elimination mid-tournament preserves completed + live match scores!
  const initial4 = createInitialState({
    playerCount: 4,
    format: 'single',
    rules: { targetPoints: 11, serveRotation: 2, winBy: 2, scoreDebounceSec: 0 },
  });
  const store = new TournamentStore(initial4, { persist: false, viewMode: 'control' });

  // Complete W-R1-M1 (11-5) and start W-R1-M2 (7-4 in progress)
  store.startMatch('W-R1-M1');
  store.setActiveMatchScoreDirect(11, 5);
  store.completeActiveMatch();
  const winnerM1 = store.getState().matches['W-R1-M1'].winnerId;

  store.selectMatch('W-R1-M2');
  store.startMatch('W-R1-M2');
  store.setActiveMatchScoreDirect(7, 4);

  // Add Player 5 mid-tournament WITHOUT rebuildBracket
  const nextPlayers5 = [
    ...store.getState().players,
    { id: 'p5', seed: 5, name: 'Late Arrival Dave' },
  ];
  store.applyFullSetup({
    playerCount: 5,
    totalPlayers: 5,
    players: nextPlayers5,
    roster: nextPlayers5.map((p, i) => ({ id: `r${i + 1}`, name: p.name })),
    rebuildBracket: false,
  });

  const s5 = store.getState();
  assert.equal(s5.playerCount, 5);
  // W-R1-M1 MUST remain completed 11-5 with winner advanced into W-R2-M1!
  assert.equal(s5.matches['W-R1-M1'].completed, true);
  assert.equal(s5.matches['W-R1-M1'].score1, 11);
  assert.equal(s5.matches['W-R1-M1'].score2, 5);
  assert.equal(s5.matches['W-R2-M1'].player1Id, winnerM1);
  // W-R1-M2 MUST keep its exact in-progress score 7-4 and remain active!
  assert.equal(s5.matches['W-R1-M2'].score1, 7);
  assert.equal(s5.matches['W-R1-M2'].score2, 4);
  assert.equal(s5.activeMatchId, 'W-R1-M2');
  // Player 5 is now in the expanded 8-slot bracket!
  const p5Present = Object.values(s5.matches).some(
    (m) => m.player1Id === 'p5' || m.player2Id === 'p5'
  );
  assert.equal(p5Present, true, 'Late player p5 must be placed in expanded bracket');

  // 2. Adding Player 6 into an existing BYE slot of that 8-slot bracket preserves everything with zero rebuild!
  const nextPlayers6 = [
    ...s5.players,
    { id: 'p6', seed: 6, name: 'Late Arrival Sam' },
  ];
  store.applyFullSetup({
    playerCount: 6,
    totalPlayers: 6,
    players: nextPlayers6,
    roster: nextPlayers6.map((p, i) => ({ id: `r${i + 1}`, name: p.name })),
    rebuildBracket: false,
  });

  const s6 = store.getState();
  assert.equal(s6.playerCount, 6);
  assert.equal(s6.matches['W-R1-M1'].completed, true);
  assert.equal(s6.matches['W-R1-M2'].score1, 7);
  assert.equal(s6.matches['W-R1-M2'].score2, 4);
  const p6Present = Object.values(s6.matches).some(
    (m) => m.player1Id === 'p6' || m.player2Id === 'p6'
  );
  assert.equal(p6Present, true, 'Second late player p6 must fill an open BYE slot cleanly');
  store.destroy();
});

test('Multi-tournament library creates, lists, switches, and deletes tournaments independently in localStorage', () => {
  const mem = new Map();
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
    },
  });

  try {
    const store = new TournamentStore(null, { persist: true, viewMode: 'control' });
    const t1 = store.createNewTournament({
      tournamentName: 'Thanksgiving Cup',
      playerCount: 4,
      format: 'single',
    });
    store.startMatch('W-R1-M1');
    store.addPoint(1, { bypassDebounce: true });
    store.addPoint(1, { bypassDebounce: true });
    assert.equal(store.getState().matches['W-R1-M1'].score1, 2);

    // Create a second independent tournament
    const t2 = store.createNewTournament({
      tournamentName: 'Christmas Doubles',
      entryMode: 'teams',
      playerCount: 4,
      totalPlayers: 8,
      format: 'double',
    });
    assert.equal(store.getState().tournamentName, 'Christmas Doubles');
    assert.equal(store.getState().matches['W-R1-M1'].score1, 0);

    // Library lists both tournaments
    const list = store.listTournaments();
    assert.equal(list.length, 2);
    assert.ok(list.some((x) => x.id === t1.tournamentId && x.tournamentName === 'Thanksgiving Cup'));
    assert.ok(list.some((x) => x.id === t2.tournamentId && x.tournamentName === 'Christmas Doubles'));

    // Switching back to Tournament 1 restores its 2-0 score!
    store.selectTournament(t1.tournamentId);
    assert.equal(store.getState().tournamentName, 'Thanksgiving Cup');
    assert.equal(store.getState().matches['W-R1-M1'].score1, 2);

    // Deleting Tournament 2 leaves only Tournament 1
    store.deleteTournament(t2.tournamentId);
    assert.equal(store.listTournaments().length, 1);

    store.destroy();
  } finally {
    if (prevStorage) {
      Object.defineProperty(globalThis, 'localStorage', prevStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('Selecting an unstarted match stays local to that window and only propagates to Control/other Scorekeepers when Begin Match is clicked', () => {
  const mem = new Map();
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
    },
  });

  try {
    const control = new TournamentStore(null, { persist: true, viewMode: 'control' });
    control.createNewTournament({
      tournamentName: 'Sync Isolation Open',
      playerCount: 4,
      format: 'single',
    });

    const sk1 = new TournamentStore(null, { persist: true, viewMode: 'scorekeeper' });
    const sk2 = new TournamentStore(null, { persist: true, viewMode: 'scorekeeper' });

    assert.equal(control.getState().activeMatchId, 'W-R1-M1');
    assert.equal(sk1.getState().activeMatchId, 'W-R1-M1');
    assert.equal(sk2.getState().activeMatchId, 'W-R1-M1');

    // Scorekeeper 1 selects unstarted W-R1-M2 -> stays local ONLY to Scorekeeper 1!
    sk1.selectMatch('W-R1-M2');
    assert.equal(sk1.getState().activeMatchId, 'W-R1-M2');
    assert.equal(sk1.getSyncMeta().localPreviewMatchId, 'W-R1-M2');
    assert.equal(sk1.getSyncMeta().programState.activeMatchId, 'W-R1-M1');
    assert.equal(control.getState().activeMatchId, 'W-R1-M1');
    assert.equal(sk2.getState().activeMatchId, 'W-R1-M1');

    // Scorekeeper 1 clicks Begin Match -> now propagates to Control & Scorekeeper 2!
    const startedState = sk1.startMatch('W-R1-M2');
    assert.equal(sk1.getSyncMeta().localPreviewMatchId, null);
    assert.equal(sk1.getSyncMeta().programState.activeMatchId, 'W-R1-M2');
    assert.equal(sk1.getSyncMeta().programState.matches['W-R1-M2'].started, true);

    // Simulate BroadcastChannel delivery to Control & Scorekeeper 2
    control.handleExternalSync(startedState);
    sk2.handleExternalSync(startedState);
    assert.equal(control.getState().activeMatchId, 'W-R1-M2');
    assert.equal(sk2.getState().activeMatchId, 'W-R1-M2');
    assert.equal(sk2.getState().matches['W-R1-M2'].started, true);

    control.destroy();
    sk1.destroy();
    sk2.destroy();
  } finally {
    if (prevStorage) {
      Object.defineProperty(globalThis, 'localStorage', prevStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('LAN Sync Hub server shares cloud tournaments, host claims from any device, debounce timestamps, and Grandma cues', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-sync-test-'));
  let port = 0;
  const handler = createLanSyncHandler({
    rootDir: tmpDir,
    getPort: () => port,
    appMeta: { name: 'test-pingpong', version: '1.0.0' },
  });

  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Laptop publishes an active tournament to the Cloud Sync Hub
    const laptopState = createInitialState({
      tournamentId: 't-laptop-1',
      tournamentName: 'Laptop Living Room Open',
      playerCount: 4,
      format: 'single',
    });
    laptopState.matches['W-R1-M1'].score1 = 6;
    laptopState.matches['W-R1-M1'].score2 = 3;
    laptopState.matches['W-R1-M1'].started = true;

    const postRes = await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'laptop-tab', state: laptopState, activate: true }),
    });
    assert.equal(postRes.status, 200);

    // 2. Cellphone fetches GET /__sync/state -> immediately sees laptop's live tournament & 6-3 score!
    const getRes = await fetch(`${baseUrl}/__sync/state`);
    const synced = await getRes.json();
    assert.equal(synced.activeTournamentId, 't-laptop-1');
    assert.equal(synced.state.tournamentName, 'Laptop Living Room Open');
    assert.equal(synced.state.matches['W-R1-M1'].score1, 6);
    assert.equal(synced.tournaments.length, 1);

    // 3. Cellphone claims Host role ("Allow any device to be a server")!
    const hostRes = await fetch(`${baseUrl}/__sync/host-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-phone-1', deviceName: 'Dave iPhone' }),
    });
    const hostData = await hostRes.json();
    assert.equal(hostData.hostDevice.deviceName, 'Dave iPhone');

    // 4. Cross-device debounce timestamp syncs cleanly
    await fetch(`${baseUrl}/__sync/point`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'phone-tab', lastPointAt: 555555 }),
    });
    const afterPoint = await (await fetch(`${baseUrl}/__sync/state`)).json();
    assert.equal(afterPoint.lastPointAt, 555555);

    // 5. Server info reports LAN metadata, cloud count, and actual local device hostname
    const info = await (await fetch(`${baseUrl}/__server-info`)).json();
    assert.equal(info.syncAvailable, true);
    assert.equal(info.cloudTournamentCount, 1);
    assert.equal(info.hostDevice.deviceName, 'Dave iPhone');
    assert.equal(info.isLocalClient, true);
    assert.equal(info.clientDeviceName, os.hostname());

    // 6. Delete cloud tournament cleanly
    const delRes = await fetch(`${baseUrl}/__sync/tournaments/t-laptop-1`, { method: 'DELETE' });
    const delData = await delRes.json();
    assert.equal(delData.tournaments.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('Number of tables rule (tableCount) persists, auto-assigns free tables on startMatch, and supports manual table changes', () => {
  const initial = createInitialState({
    playerCount: 4,
    rules: { targetPoints: 11, serveRotation: 2, winBy: 2, tableCount: 3, scoreDebounceSec: 0 },
  });
  const store = new TournamentStore(initial);
  assert.equal(store.getState().rules.tableCount, 3);

  // Starting M1 auto-assigns Table 1
  store.startMatch('W-R1-M1');
  assert.equal(store.getState().matches['W-R1-M1'].tableNumber, 1);

  // Starting M2 while M1 is active on Table 1 auto-assigns free Table 2!
  store.startMatch('W-R1-M2');
  assert.equal(store.getState().matches['W-R1-M2'].tableNumber, 2);

  // Manual override moves M2 to Table 3
  store.setMatchTable('W-R1-M2', 3);
  assert.equal(store.getState().matches['W-R1-M2'].tableNumber, 3);

  // applyFullSetup updates tableCount cleanly without losing scores
  store.applyFullSetup({
    rules: { targetPoints: 11, serveRotation: 2, winBy: 2, tableCount: 4, scoreDebounceSec: 0 },
    rebuildBracket: false,
  });
  assert.equal(store.getState().rules.tableCount, 4);
  store.destroy();
});

test('Grandma contextual variables resolve player, score, table, and tournament tokens safely across live, banter, and game-point speech', () => {
  const initial = createInitialState({
    tournamentName: 'Garage Open',
    playerCount: 4,
    players: [
      { id: 'p1', seed: 1, name: 'Alice' },
      { id: 'p2', seed: 2, name: 'Bob' },
      { id: 'p3', seed: 3, name: 'Cara' },
      { id: 'p4', seed: 4, name: 'Dan' },
    ],
    rules: { targetPoints: 11, serveRotation: 2, winBy: 2, tableCount: 2, scoreDebounceSec: 0 },
  });
  const store = new TournamentStore(initial);
  const m1Id = store.getState().activeMatchId;
  store.startMatch(m1Id, 2);

  // Tied at 0-0 -> $leader falls back cleanly; $table resolves to Table 2; $tables resolves to 2; $5 literal stays untouched!
  assert.equal(hasGrandmaVariables('Go $player1 on $table!'), true);
  assert.equal(hasGrandmaVariables('That paddle cost $5!'), false);
  const tiedResolved = resolveGrandmaPhrase(
    '$player1 vs ${player2} on $table of $tables ($tournament) — $leader leading, bet $5!',
    store.getState()
  );
  assert.equal(
    tiedResolved,
    'Alice vs Dan on Table 2 of 2 (Garage Open) — both sides leading, bet $5!'
  );

  // Score points so Alice leads 10-7 (Game Point!)
  store.setActiveMatchScoreDirect(9, 7);
  store.updateGrandmaSettings({
    banterQuotes: ['$playersRemaining players left across $tables tables!'],
    contextualQuotes: ['Nice spin by $server!'],
    gamePointQuotes: ['Game point for $leader ($score) on $table!'],
  });

  // Trigger Game Point via addPoint(1) -> resolves against NEW 10-7 score & $scoringPlayer immediately!
  store.addPoint(1, { now: 10000 });
  assert.equal(
    store.getState().grandma.activeSpeech?.text,
    'Game point for Alice (10-7) on Table 2!'
  );
  assert.equal(
    resolveGrandmaPhrase('Nice point by $scoringPlayer!', store.getState()),
    'Nice point by Alice!'
  );

  // When Dan scores next (even while still trailing 10-8), $scoringPlayer switches to Dan!
  store.addPoint(2, { now: 20000 });
  assert.equal(
    resolveGrandmaPhrase('$scoringPlayer gets one back while $leader leads!', store.getState()),
    'Dan gets one back while Alice leads!'
  );
  // Undo Dan's point -> $scoringPlayer reverts back to Alice!
  store.undoPoint();
  assert.equal(
    resolveGrandmaPhrase('Last point by $scoringPlayer!', store.getState()),
    'Last point by Alice!'
  );

  // Live quote & Banter quote also resolve variables cleanly (no prefix collision between $playersRemaining and $player1)
  store.triggerLiveQuote('Keep pushing, $trailer — down by $pointDiff to $leader!');
  assert.equal(
    store.getState().grandma.activeSpeech?.text,
    'Keep pushing, Dan — down by 3 to Alice!'
  );

  const banter = store.triggerNextBanterQuote({ now: 30000 });
  assert.equal(banter?.text, '4 players left across 2 tables!');
  store.destroy();
});


test('4-random-word tournament join keys, zero Cloud/Local duplication, and joining by 4-word key over HTTP', async () => {
  // 1. Every new tournament gets a unique 4-word join key
  const tA = createInitialState({ tournamentName: 'Basement Cup' });
  const tB = createInitialState({ tournamentName: 'Garage Open' });
  assert.equal(isFourWordId(tA.tournamentId), true);
  assert.equal(isFourWordId(tA.joinCode), true);
  assert.equal(tA.tournamentId, tA.joinCode);
  assert.notEqual(tA.joinCode, tB.joinCode);

  // 2. Normalization accepts spaces, mixed case, underscores, or hyphens
  assert.equal(normalizeFourWordId('  Amber Paddle_SWIFT  Comet '), 'amber-paddle-swift-comet');
  // Legacy IDs derive a deterministic 4-word key so local & server agree
  const legacyKey1 = deriveDeterministicFourWordId('t-default');
  const legacyKey2 = deriveDeterministicFourWordId('t-default');
  assert.equal(isFourWordId(legacyKey1), true);
  assert.equal(legacyKey1, legacyKey2);

  // 3. Deduplication prevents Cloud & Local lists from showing the same tournament twice
  const cloudList = [
    { id: 'amber-paddle-swift-comet', joinCode: 'amber-paddle-swift-comet', tournamentName: 'Cloud Cup' },
    { id: 't-legacy-1', joinCode: 'coral-falcon-lucky-prism', tournamentName: 'Legacy Cloud' },
  ];
  const localList = [
    { id: 'amber-paddle-swift-comet', joinCode: 'amber-paddle-swift-comet', tournamentName: 'Cloud Cup' },
    { id: 'different-local-key', joinCode: 'coral-falcon-lucky-prism', tournamentName: 'Legacy Local Dup' },
    { id: 'maple-rocket-vivid-otter', joinCode: 'maple-rocket-vivid-otter', tournamentName: 'Offline Only' },
  ];
  const { localOnly, backedUpCloudIds, backedUpCloudCodes } = deduplicateTournamentLists(cloudList, localList);
  assert.equal(localOnly.length, 1);
  assert.equal(localOnly[0].id, 'maple-rocket-vivid-otter');
  assert.equal(backedUpCloudIds.has('amber-paddle-swift-comet'), true);
  assert.equal(backedUpCloudCodes.has('coral-falcon-lucky-prism'), true);

  // 4. Server-side deduplication by joinCode + POST /__sync/join using spaces & uppercase
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-4word-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const customCode = generateFourWordId();
    const state1 = createInitialState({
      tournamentId: customCode,
      joinCode: customCode,
      tournamentName: 'Online Ready Open',
      playerCount: 4,
    });

    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: state1, activate: true }),
    });

    // Pushing same joinCode under a different legacy ID updates in-place instead of duplicating!
    const dupAttempt = { ...state1, tournamentId: 'legacy-alias-id', tournamentName: 'Online Ready Open v2' };
    const dupRes = await (
      await fetch(`${baseUrl}/__sync/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: dupAttempt, activate: true }),
      })
    ).json();
    assert.equal(dupRes.tournaments.length, 1, 'Cloud server must not duplicate tournaments with same joinCode');
    assert.equal(dupRes.tournaments[0].joinCode, customCode);

    // Join using spaces & uppercase version of the 4-word key!
    const spacedKey = customCode.split('-').join(' ').toUpperCase();
    const joinRes = await fetch(`${baseUrl}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: spacedKey }),
    });
    assert.equal(joinRes.status, 200);
    const joinData = await joinRes.json();
    assert.equal(joinData.joinCode, customCode);
    assert.equal(joinData.state.tournamentName, 'Online Ready Open v2');

    // Unknown 4-word key returns 404 cleanly
    const badRes = await fetch(`${baseUrl}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'does not exist here' }),
    });
    assert.equal(badRes.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('Unlimited simultaneous hosts, per-tournament host name & IP, host free rejoin vs guest 4-word ID gate, and simultaneous host+guest', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-multihost-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Device A (Laptop) hosts Tournament A; Device B (Phone) ALSO hosts Tournament B simultaneously!
    const tA = createInitialState({ tournamentName: 'Laptop Open', playerCount: 4 });
    const tB = createInitialState({ tournamentName: 'Phone Cup', playerCount: 4 });

    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'dev-laptop',
        deviceName: 'Daves-Laptop',
        state: tA,
        activate: true,
      }),
    });

    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'dev-phone',
        deviceName: 'Daves-iPhone',
        state: tB,
        activate: true,
      }),
    });

    // 2. Both devices remain active hosts simultaneously (no limit of hosts!) and cloud view includes host name + IP
    const listData = await (await fetch(`${baseUrl}/__sync/tournaments`)).json();
    assert.equal(listData.hosts.length, 2, 'Both devices must be active hosts simultaneously');
    assert.equal(listData.tournaments.length, 2);

    const summaryA = listData.tournaments.find((t) => t.id === tA.tournamentId);
    const summaryB = listData.tournaments.find((t) => t.id === tB.tournamentId);
    assert.equal(summaryA.hostDeviceId, 'dev-laptop');
    assert.equal(summaryA.hostDeviceName, 'Daves-Laptop');
    assert.ok(summaryA.hostIp && summaryA.hostIp.length > 0, 'Cloud view must include host IP');
    assert.equal(summaryB.hostDeviceId, 'dev-phone');
    assert.equal(summaryB.hostDeviceName, 'Daves-iPhone');
    assert.ok(summaryB.hostIp && summaryB.hostIp.length > 0, 'Cloud view must include host IP');

    // 3. Host (Laptop) can ALWAYS join its own tournament without providing a key!
    const hostJoinOwn = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: tA.tournamentId, deviceId: 'dev-laptop' }),
    });
    assert.equal(hostJoinOwn.status, 200);
    const hostJoinData = await hostJoinOwn.json();
    assert.equal(hostJoinData.role, 'host');

    // 4. Another device (Phone, which is ALSO hosting tB!) trying to join Laptop's tA WITHOUT the 4-word ID is blocked (403)!
    const guestNoKey = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: tA.tournamentId, deviceId: 'dev-phone' }),
    });
    assert.equal(guestNoKey.status, 403);
    const blockedBody = await guestNoKey.json();
    assert.equal(blockedBody.requiresKey, true);

    // 5. Phone provides Laptop's 4-word Tournament ID -> joins tA as Guest while STILL remaining Host of tB!
    const guestWithKey = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: tA.tournamentId,
        deviceId: 'dev-phone',
        joinCode: tA.joinCode.split('-').join(' '),
      }),
    });
    assert.equal(guestWithKey.status, 200);
    const guestJoinData = await guestWithKey.json();
    assert.equal(guestJoinData.role, 'guest');
    assert.equal(guestJoinData.hosts.length, 2, 'Phone remains a Host while simultaneously acting as Guest!');
    assert.ok(guestJoinData.hosts.some((h) => h.deviceId === 'dev-phone'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('Public/Private & Secure/Unsecure access rules, total count including private games, host-only menu gate, abandon to Sync Host, and claim', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-access-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Host A creates 3 tournaments: Public+Open, Public+Secure, and Private+Secure
    const tOpen = createInitialState({
      tournamentName: 'Public Open Cup',
      access: { isPublic: true, isSecure: false },
    });
    const tPubSec = createInitialState({
      tournamentName: 'Public Secure Cup',
      access: { isPublic: true, isSecure: true },
    });
    const tPrivSec = createInitialState({
      tournamentName: 'Secret Private Cup',
      access: { isPublic: false, isSecure: true },
    });

    for (const t of [tOpen, tPubSec, tPrivSec]) {
      await fetch(`${baseUrl}/__sync/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'dev-host-a',
          deviceName: 'Host-A',
          state: t,
          activate: true,
        }),
      });
    }

    // 2. Guest B lists tournaments -> sees 2 public tournaments, NOT private, while totalCloudTournaments=3 & privateCloudCount=1!
    const guestList = await (await fetch(`${baseUrl}/__sync/tournaments?deviceId=dev-guest-b`)).json();
    assert.equal(guestList.tournaments.length, 2);
    assert.equal(guestList.totalCloudTournaments, 3);
    assert.equal(guestList.privateCloudCount, 1);
    assert.ok(!guestList.tournaments.some((t) => t.id === tPrivSec.tournamentId));

    // Host A sees all 3 including its own Private tournament
    const hostList = await (await fetch(`${baseUrl}/__sync/tournaments?deviceId=dev-host-a`)).json();
    assert.equal(hostList.tournaments.length, 3);
    assert.equal(hostList.totalCloudTournaments, 3);
    assert.equal(hostList.privateCloudCount, 1);

    // 3. Guest B joins Public+Open WITHOUT a key -> 200 OK!
    const openJoin = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: tOpen.tournamentId, deviceId: 'dev-guest-b' }),
    });
    assert.equal(openJoin.status, 200);

    // 4. Guest B tries Public+Secure without key -> 403; joins Private+Secure WITH key via /__sync/join -> 200 OK!
    const secBlocked = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: tPubSec.tournamentId, deviceId: 'dev-guest-b' }),
    });
    assert.equal(secBlocked.status, 403);

    const privJoinWithKey = await fetch(`${baseUrl}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: tPrivSec.joinCode, deviceId: 'dev-guest-b' }),
    });
    assert.equal(privJoinWithKey.status, 200);
    const privJoinData = await privJoinWithKey.json();
    assert.equal(privJoinData.state.tournamentName, 'Secret Private Cup');

    // 5. Control & Debug menu gate: Host A has access, Guest B does NOT
    assert.equal(canDeviceAccessHostControls(privJoinData.state, { deviceId: 'dev-host-a' }), true);
    assert.equal(canDeviceAccessHostControls(privJoinData.state, { deviceId: 'dev-guest-b' }), false);

    // 6. Guest B cannot change Host A's access settings (403); Host A CAN (200)
    const guestAccessEdit = await fetch(`${baseUrl}/__sync/tournament/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: tPrivSec.tournamentId,
        deviceId: 'dev-guest-b',
        isPublic: true,
      }),
    });
    assert.equal(guestAccessEdit.status, 403);

    // 7. Host A abandons Private+Secure tournament -> becomes Public, Unsecure, and hosted by "Sync Host" (unclaimed)!
    const abandonRes = await fetch(`${baseUrl}/__sync/tournament/abandon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: tPrivSec.tournamentId, deviceId: 'dev-host-a' }),
    });
    assert.equal(abandonRes.status, 200);
    const abandoned = await abandonRes.json();
    assert.equal(abandoned.state.hostDeviceId, null);
    assert.equal(abandoned.state.hostDeviceName, 'Sync Host');
    assert.equal(abandoned.state.access.isPublic, true);
    assert.equal(abandoned.state.access.isSecure, false);
    assert.equal(abandoned.privateCloudCount, 0);
    // While unclaimed ("Sync Host"), ALL devices can access Control & Debug!
    assert.equal(canDeviceAccessHostControls(abandoned.state, { deviceId: 'dev-guest-b' }), true);

    // 8. Guest B claims the unclaimed "Sync Host" tournament from Debug menu -> becomes new Host!
    const claimRes = await fetch(`${baseUrl}/__sync/tournament/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: tPrivSec.tournamentId,
        deviceId: 'dev-guest-b',
        deviceName: 'Guest-B-Phone',
      }),
    });
    assert.equal(claimRes.status, 200);
    const claimed = await claimRes.json();
    assert.equal(claimed.state.hostDeviceId, 'dev-guest-b');
    assert.equal(claimed.state.hostDeviceName, 'Guest-B-Phone');
    assert.equal(claimed.state.access.isSecure, true, 'Claiming a tournament automatically sets it to Secure');
    // Now ONLY Guest B (the new host) can access Control & Debug!
    assert.equal(canDeviceAccessHostControls(claimed.state, { deviceId: 'dev-guest-b' }), true);
    assert.equal(canDeviceAccessHostControls(claimed.state, { deviceId: 'dev-host-a' }), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('Grandma $ autocomplete detects active queries, ranks matching variables, and applies completions cleanly', () => {
  // Typing bare "$" triggers all variables
  const qBare = findActiveVariableQuery('Nice shot $', 11);
  assert.deepEqual(qBare, { start: 10, end: 11, query: '' });
  assert.ok(filterGrandmaVariables(qBare.query).length >= 20);

  // Typing "$scor" ranks prefix matches ($scoringPlayer, $score, $score1, $score2) first
  const qScor = findActiveVariableQuery('Go $scor', 8);
  assert.deepEqual(qScor, { start: 3, end: 8, query: 'scor' });
  const scorMatches = filterGrandmaVariables(qScor.query).map((v) => v.token);
  assert.ok(scorMatches.includes('$scoringPlayer'));
  assert.ok(scorMatches.includes('$score'));

  // Mid-sentence completion preserves trailing punctuation without adding an extra space before "!"
  const mid = findActiveVariableQuery('Wow $sc!', 7);
  assert.deepEqual(mid, { start: 4, end: 7, query: 'sc' });
  const completedMid = applyVariableCompletion('Wow $sc!', mid, '$scoringPlayer');
  assert.equal(completedMid.value, 'Wow $scoringPlayer!');
  assert.equal(completedMid.cursorPos, 18);

  // End-of-input completion appends a trailing space for fluent continued typing
  const completedEnd = applyVariableCompletion('Go $pl', { start: 3, end: 6, query: 'pl' }, '$player1');
  assert.equal(completedEnd.value, 'Go $player1 ');
  assert.equal(completedEnd.cursorPos, 12);

  // Literal currency like "$5" yields zero autocomplete matches
  assert.equal(filterGrandmaVariables('5').length, 0);

  // Escaping `$` with `$$` displays literal `$` and suppresses autocomplete
  const escapeState = createInitialState({
    players: [
      { id: 'p1', seed: 1, name: 'Alice' },
      { id: 'p2', seed: 2, name: 'Bob' },
      { id: 'p3', seed: 3, name: 'Cara' },
      { id: 'p4', seed: 4, name: 'Dan' },
    ],
  });
  assert.equal(resolveGrandmaPhrase('Win $$100, $player1!', escapeState), 'Win $100, Alice!');
  assert.equal(resolveGrandmaPhrase('Literal $$player1 stays escaped!', escapeState), 'Literal $player1 stays escaped!');
  assert.equal(resolveGrandmaPhrase('$$$player1 and $$$$', escapeState), '$Alice and $$');
  assert.equal(hasGrandmaVariables('Cost $$50'), true);
  assert.equal(findActiveVariableQuery('Win $$', 6), null);
  assert.equal(findActiveVariableQuery('Literal $$pl', 12), null);
  assert.deepEqual(findActiveVariableQuery('Price $$$pl', 11), { start: 8, end: 11, query: 'pl' });
});


test('Sync Hub tracks live connected SSE clients with device name, IP, view mode, and updates via /__sync/client-status', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-clients-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Open an SSE client connection as a Phone Scorekeeper
    const sseReq = http.get(
      `${baseUrl}/__sync/events?tabId=tab-phone-1&deviceId=dev-phone-1&deviceName=Daves-iPhone&viewMode=scorekeeper`
    );
    await new Promise((resolve, reject) => {
      sseReq.on('response', (res) => {
        res.once('data', () => resolve());
      });
      sseReq.on('error', reject);
    });

    // Server info & state both list the connected client
    const info1 = await (await fetch(`${baseUrl}/__server-info`)).json();
    assert.equal(info1.connectedClients, 1);
    assert.equal(info1.clients.length, 1);
    assert.equal(info1.clients[0].deviceName, 'Daves-iPhone');
    assert.equal(info1.clients[0].viewMode, 'scorekeeper');
    assert.ok(info1.clients[0].ip);

    // Client updates view mode via POST /__sync/client-status
    const statusRes = await (
      await fetch(`${baseUrl}/__sync/client-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: 'tab-phone-1', viewMode: 'present' }),
      })
    ).json();
    assert.equal(statusRes.clients[0].viewMode, 'present');

    // Close SSE stream -> client disconnects cleanly
    sseReq.destroy();
    await new Promise((r) => setTimeout(r, 40));
    const info2 = await (await fetch(`${baseUrl}/__server-info`)).json();
    assert.equal(info2.connectedClients, 0);
    assert.equal(info2.clients.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('Host can rotate 4-word join key without disconnecting clients, and can actively disconnect specific clients', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-rotate-kick-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Host creates a secure tournament
    const t = createInitialState({
      tournamentName: 'Key Rotation Cup',
      access: { isPublic: true, isSecure: true },
    });
    const oldKey = t.joinCode;
    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'dev-host',
        deviceName: 'Host-Laptop',
        state: t,
        activate: true,
      }),
    });

    // 2. Guest connects via SSE to the tournament
    let guestReceivedEvents = '';
    let guestClosed = false;
    const guestReq = http.get(
      `${baseUrl}/__sync/events?tabId=tab-guest-1&deviceId=dev-guest&deviceName=Guest-Phone&viewMode=scorekeeper&tournamentId=${encodeURIComponent(t.tournamentId)}`
    );
    await new Promise((resolve, reject) => {
      guestReq.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          guestReceivedEvents += chunk;
          resolve();
        });
        res.on('end', () => {
          guestClosed = true;
        });
      });
      guestReq.on('error', reject);
    });

    // 3. Guest cannot rotate key (403); Host rotates key (200) -> tournamentId stays same, joinCode changes, guest stays connected!
    const guestRotate = await fetch(`${baseUrl}/__sync/tournament/rotate-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-guest' }),
    });
    assert.equal(guestRotate.status, 403);

    const hostRotate = await fetch(`${baseUrl}/__sync/tournament/rotate-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-host' }),
    });
    assert.equal(hostRotate.status, 200);
    const rotated = await hostRotate.json();
    assert.equal(rotated.state.tournamentId, t.tournamentId, 'tournamentId must stay stable');
    assert.notEqual(rotated.joinCode, oldKey, 'New 4-word key must differ from old key');
    assert.equal(isFourWordId(rotated.joinCode), true);
    assert.equal(guestClosed, false, 'Connected guest must NOT be disconnected by key rotation');

    // Old key fails for a new guest, new key succeeds!
    const oldKeyJoin = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-new-guest', joinCode: oldKey }),
    });
    assert.equal(oldKeyJoin.status, 403);

    const newKeyJoin = await fetch(`${baseUrl}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: rotated.joinCode, deviceId: 'dev-new-guest' }),
    });
    assert.equal(newKeyJoin.status, 200);

    // 4. Guest cannot disconnect clients (403); Host disconnects tab-guest-1 (200) -> CLIENT_KICKED sent & stream closed!
    const guestKick = await fetch(`${baseUrl}/__sync/clients/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-guest',
        targetTabId: 'tab-guest-1',
      }),
    });
    assert.equal(guestKick.status, 403);

    const hostKick = await fetch(`${baseUrl}/__sync/clients/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-host',
        targetTabId: 'tab-guest-1',
      }),
    });
    assert.equal(hostKick.status, 200);
    const kickData = await hostKick.json();
    assert.equal(kickData.disconnectedCount, 1);
    assert.equal(kickData.connectedClients, 0);

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(guestClosed, true, 'Disconnected client SSE stream must be ended');
    assert.ok(guestReceivedEvents.includes('event: CLIENT_KICKED'));

    // 5. Refreshing on the disconnected device MUST NOT rejoin the tournament (even with old key)!
    const refreshStateRes = await (
      await fetch(
        `${baseUrl}/__sync/state?deviceId=dev-guest&tournamentId=${encodeURIComponent(
          t.tournamentId
        )}&code=${encodeURIComponent(oldKey)}`
      )
    ).json();
    assert.equal(refreshStateRes.accessRevoked, true);
    assert.equal(refreshStateRes.state, null, 'Disconnected guest must NOT receive tournament state on refresh');

    // Reconnecting SSE after refresh immediately receives ACCESS_REVOKED and is NOT subscribed to the tournament
    let reconnectEvents = '';
    const reconnectReq = http.get(
      `${baseUrl}/__sync/events?tabId=tab-guest-refresh&deviceId=dev-guest&tournamentId=${encodeURIComponent(
        t.tournamentId
      )}&code=${encodeURIComponent(oldKey)}`
    );
    await new Promise((resolve, reject) => {
      reconnectReq.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          reconnectEvents += chunk;
          if (reconnectEvents.includes('ACCESS_REVOKED')) resolve();
        });
      });
      reconnectReq.on('error', reject);
    });
    reconnectReq.destroy();
    assert.ok(reconnectEvents.includes('event: ACCESS_REVOKED'));

    // Disconnected guest attempting to push stale scores back is also blocked (403)
    const stalePush = await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-guest', state: t, activate: true }),
    });
    assert.equal(stalePush.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('6-tier role hierarchy (admin > host > moderator > presenter > scorekeeper > spectator), strict down-promotion, tab permissions, and scorekeeper approval requests', async () => {
  // 1. Down-promotion hierarchy checks
  assert.deepEqual(getAssignableRoles('admin'), [
    'host',
    'moderator',
    'presenter',
    'scorekeeper',
    'spectator',
  ]);
  assert.deepEqual(getAssignableRoles('host'), [
    'moderator',
    'presenter',
    'scorekeeper',
    'spectator',
  ]);
  assert.deepEqual(getAssignableRoles('moderator'), ['presenter', 'scorekeeper', 'spectator']);
  assert.deepEqual(getAssignableRoles('presenter'), []);
  assert.deepEqual(getAssignableRoles('scorekeeper'), []);
  assert.deepEqual(getAssignableRoles('spectator'), []);

  assert.equal(canAssignRole('admin', 'spectator', 'host'), true);
  assert.equal(canAssignRole('admin', 'spectator', 'admin'), false, 'Admin cannot assign Admin via tournament role endpoint');
  assert.equal(canAssignRole('host', 'spectator', 'admin'), false, 'Host cannot promote to Admin');
  assert.equal(canAssignRole('host', 'spectator', 'host'), false, 'Host cannot promote peer Host');
  assert.equal(canAssignRole('host', 'spectator', 'moderator'), true);
  assert.equal(canAssignRole('moderator', 'spectator', 'presenter'), true);
  assert.equal(canAssignRole('moderator', 'spectator', 'scorekeeper'), true);
  assert.equal(canAssignRole('moderator', 'spectator', 'moderator'), false);
  assert.equal(canAssignRole('presenter', 'spectator', 'scorekeeper'), false);

  // 2. Exact Tab & Feature Access Matrix
  // Spectator (0): Hub + Spectator + Presentation (with local slides & sync)
  assert.deepEqual(
    {
      hub: getRolePermissions('spectator').canAccessHub,
      admin: getRolePermissions('spectator').canAccessAdmin,
      spectator: getRolePermissions('spectator').canAccessSpectator,
      scorekeeper: getRolePermissions('spectator').canScore,
      users: getRolePermissions('spectator').canAccessUsers,
      control: getRolePermissions('spectator').canAccessControl,
      system: getRolePermissions('spectator').canAccessSystem,
      present: getRolePermissions('spectator').canAccessPresent,
      localSlides: getRolePermissions('spectator').canSelectLocalSlides,
    },
    { hub: true, admin: false, spectator: true, scorekeeper: false, users: false, control: false, system: false, present: true, localSlides: true }
  );
  // Scorekeeper (1): Hub + Spectator + Scorekeeper + Presentation (with local slides & sync)
  assert.deepEqual(
    {
      hub: getRolePermissions('scorekeeper').canAccessHub,
      admin: getRolePermissions('scorekeeper').canAccessAdmin,
      spectator: getRolePermissions('scorekeeper').canAccessSpectator,
      scorekeeper: getRolePermissions('scorekeeper').canScore,
      users: getRolePermissions('scorekeeper').canAccessUsers,
      control: getRolePermissions('scorekeeper').canAccessControl,
      system: getRolePermissions('scorekeeper').canAccessSystem,
      present: getRolePermissions('scorekeeper').canAccessPresent,
      localSlides: getRolePermissions('scorekeeper').canSelectLocalSlides,
    },
    { hub: true, admin: false, spectator: true, scorekeeper: true, users: false, control: false, system: false, present: true, localSlides: true }
  );
  // Presenter (2): Hub + Presentation ONLY (locked to live sync, no local slide picker)
  assert.deepEqual(
    {
      hub: getRolePermissions('presenter').canAccessHub,
      admin: getRolePermissions('presenter').canAccessAdmin,
      spectator: getRolePermissions('presenter').canAccessSpectator,
      scorekeeper: getRolePermissions('presenter').canScore,
      users: getRolePermissions('presenter').canAccessUsers,
      control: getRolePermissions('presenter').canAccessControl,
      system: getRolePermissions('presenter').canAccessSystem,
      present: getRolePermissions('presenter').canAccessPresent,
      localSlides: getRolePermissions('presenter').canSelectLocalSlides,
    },
    { hub: true, admin: false, spectator: false, scorekeeper: false, users: false, control: false, system: false, present: true, localSlides: false }
  );
  // Moderator (3): Hub + Spectator + Scorekeeper + Users + Control + Presentation (NO System, NO Admin)
  assert.deepEqual(
    {
      hub: getRolePermissions('moderator').canAccessHub,
      admin: getRolePermissions('moderator').canAccessAdmin,
      spectator: getRolePermissions('moderator').canAccessSpectator,
      scorekeeper: getRolePermissions('moderator').canScore,
      users: getRolePermissions('moderator').canAccessUsers,
      control: getRolePermissions('moderator').canAccessControl,
      system: getRolePermissions('moderator').canAccessSystem,
      present: getRolePermissions('moderator').canAccessPresent,
      localSlides: getRolePermissions('moderator').canSelectLocalSlides,
    },
    { hub: true, admin: false, spectator: true, scorekeeper: true, users: true, control: true, system: false, present: true, localSlides: true }
  );
  // Host (4): ALL tournament views (Hub, System, Users, Control, Presentation, Scorekeeper, Spectator), NO Hub Admin Panel
  assert.deepEqual(
    {
      hub: getRolePermissions('host').canAccessHub,
      admin: getRolePermissions('host').canAccessAdmin,
      spectator: getRolePermissions('host').canAccessSpectator,
      scorekeeper: getRolePermissions('host').canScore,
      users: getRolePermissions('host').canAccessUsers,
      control: getRolePermissions('host').canAccessControl,
      system: getRolePermissions('host').canAccessSystem,
      present: getRolePermissions('host').canAccessPresent,
    },
    { hub: true, admin: false, spectator: true, scorekeeper: true, users: true, control: true, system: true, present: true }
  );
  // Admin (5): ALL views INCLUDING Hub Admin Panel
  assert.deepEqual(
    {
      hub: getRolePermissions('admin').canAccessHub,
      admin: getRolePermissions('admin').canAccessAdmin,
      spectator: getRolePermissions('admin').canAccessSpectator,
      scorekeeper: getRolePermissions('admin').canScore,
      users: getRolePermissions('admin').canAccessUsers,
      control: getRolePermissions('admin').canAccessControl,
      system: getRolePermissions('admin').canAccessSystem,
      present: getRolePermissions('admin').canAccessPresent,
    },
    { hub: true, admin: true, spectator: true, scorekeeper: true, users: true, control: true, system: true, present: true }
  );

  // 3. End-to-end HTTP RBAC test: down-promotion + scorekeeper approval ON vs OFF
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-rbac-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Register Hub Admin on local server
    const claimAdminRes = await fetch(`${baseUrl}/__sync/admin/claim-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-admin', deviceName: 'HubAdminPC' }),
    });
    assert.equal(claimAdminRes.status, 200);

    const t = createInitialState({
      tournamentName: 'RBAC Championship',
      access: { isPublic: true, isSecure: false },
      rules: { targetPoints: 11, serveRotation: 2, winBy: 2, requireScorekeeperApproval: true },
    });

    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-host', deviceName: 'HostPC', state: t, activate: true }),
    });

    // Host CANNOT promote User B to Admin (403) or Host (403), CAN promote User B to Moderator (200)
    const hostPromoteAdmin = await fetch(`${baseUrl}/__sync/tournament/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        actorDeviceId: 'dev-host',
        targetDeviceId: 'dev-b',
        role: 'admin',
      }),
    });
    assert.equal(hostPromoteAdmin.status, 403);

    const hostPromoteMod = await fetch(`${baseUrl}/__sync/tournament/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        actorDeviceId: 'dev-host',
        targetDeviceId: 'dev-b',
        role: 'moderator',
      }),
    });
    assert.equal(hostPromoteMod.status, 200);

    // Moderator B promotes User P to Presenter (200) and Presenter cannot request Scorekeeper (403)
    const modPromotePresenter = await fetch(`${baseUrl}/__sync/tournament/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        actorDeviceId: 'dev-b',
        targetDeviceId: 'dev-presenter',
        role: 'presenter',
      }),
    });
    assert.equal(modPromotePresenter.status, 200);
    const presenterData = await modPromotePresenter.json();
    assert.equal(presenterData.role, 'presenter');
    assert.equal(resolveEffectiveRole(presenterData.state, 'dev-presenter'), 'presenter');

    const presenterReqSk = await fetch(`${baseUrl}/__sync/tournament/request-scorekeeper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-presenter',
        deviceName: 'LivingRoomTV',
      }),
    });
    assert.equal(presenterReqSk.status, 403);

    // Individual Tab Role Override: Host sets 2nd tab on Host's OWN device to Presenter without affecting Host's device role!
    const hostTabOverride = await fetch(`${baseUrl}/__sync/tournament/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        actorDeviceId: 'dev-host',
        actorTabId: 'tab-host-1',
        targetDeviceId: 'dev-host',
        targetTabId: 'tab-host-2',
        role: 'presenter',
      }),
    });
    assert.equal(hostTabOverride.status, 200);
    const hostTabData = await hostTabOverride.json();
    assert.equal(hostTabData.scope, 'tab');
    assert.equal(resolveEffectiveRole(hostTabData.state, 'dev-host', 'tab-host-2'), 'presenter');
    assert.equal(resolveEffectiveRole(hostTabData.state, 'dev-host', 'tab-host-1'), 'host');
    assert.equal(resolveEffectiveRole(hostTabData.state, 'dev-host'), 'host', 'Device role overall stays Host!');

    // Moderator B CANNOT override Host's tab (403); Hub Admin CAN override Spectator's 2nd tab to Scorekeeper!
    const modBlockedOnHostTab = await fetch(`${baseUrl}/__sync/tournament/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        actorDeviceId: 'dev-b',
        actorTabId: 'tab-mod-1',
        targetDeviceId: 'dev-host',
        targetTabId: 'tab-host-2',
        role: 'spectator',
      }),
    });
    assert.equal(modBlockedOnHostTab.status, 403);

    const adminTabOverride = await fetch(`${baseUrl}/__sync/tournament/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        actorDeviceId: 'dev-admin',
        actorTabId: 'tab-admin-1',
        targetDeviceId: 'dev-guest-c',
        targetTabId: 'tab-guest-c-2',
        role: 'scorekeeper',
      }),
    });
    assert.equal(adminTabOverride.status, 200);
    const adminTabData = await adminTabOverride.json();
    assert.equal(resolveEffectiveRole(adminTabData.state, 'dev-guest-c', 'tab-guest-c-2'), 'scorekeeper');
    assert.equal(resolveEffectiveRole(adminTabData.state, 'dev-guest-c', 'tab-guest-c-1'), 'spectator');
    assert.equal(resolveEffectiveRole(adminTabData.state, 'dev-guest-c'), 'spectator');

    // Clearing a tab override ('inherit') restores the tab to its device role
    const clearTabOverride = await fetch(`${baseUrl}/__sync/tournament/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        actorDeviceId: 'dev-host',
        actorTabId: 'tab-host-1',
        targetDeviceId: 'dev-host',
        targetTabId: 'tab-host-2',
        role: 'inherit',
      }),
    });
    assert.equal(clearTabOverride.status, 200);
    const clearedData = await clearTabOverride.json();
    assert.equal(resolveEffectiveRole(clearedData.state, 'dev-host', 'tab-host-2'), 'host');

    // Guest C requests scorekeeper access while requireScorekeeperApproval = true -> pending!
    const reqPending = await (
      await fetch(`${baseUrl}/__sync/tournament/request-scorekeeper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          deviceId: 'dev-guest-c',
          deviceName: 'GuestC-Phone',
        }),
      })
    ).json();
    assert.equal(reqPending.pending, true);
    assert.equal(reqPending.approved, false);
    assert.equal(resolveEffectiveRole(reqPending.state, 'dev-guest-c'), 'spectator');

    // Moderator B approves Guest C's request -> Guest C becomes Scorekeeper!
    const modApprove = await (
      await fetch(`${baseUrl}/__sync/tournament/resolve-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          actorDeviceId: 'dev-b',
          targetDeviceId: 'dev-guest-c',
          approve: true,
        }),
      })
    ).json();
    assert.equal(modApprove.ok, true);
    assert.equal(resolveEffectiveRole(modApprove.state, 'dev-guest-c'), 'scorekeeper');
    assert.equal(modApprove.state.scorekeeperRequests.length, 0);

    // Hub Admin turns OFF requireScorekeeperApproval -> Guest D becomes Scorekeeper immediately without approval!
    const openApproval = await fetch(`${baseUrl}/__sync/tournament/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-admin',
        requireScorekeeperApproval: false,
      }),
    });
    assert.equal(openApproval.status, 200);

    const instantScorekeeper = await (
      await fetch(`${baseUrl}/__sync/tournament/request-scorekeeper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          deviceId: 'dev-guest-d',
          deviceName: 'GuestD-Phone',
        }),
      })
    ).json();
    assert.equal(instantScorekeeper.approved, true);
    assert.equal(instantScorekeeper.pending, false);
    assert.equal(resolveEffectiveRole(instantScorekeeper.state, 'dev-guest-d'), 'scorekeeper');

    // If Guest D is manually demoted back to Spectator while Open Scorekeeper is ON,
    // requesting Scorekeeper again MUST require manual approval instead of auto-approving!
    const demoteD = await fetch(`${baseUrl}/__sync/tournament/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        actorDeviceId: 'dev-host',
        targetDeviceId: 'dev-guest-d',
        role: 'spectator',
      }),
    });
    assert.equal(demoteD.status, 200);

    const reRequestAfterDemote = await (
      await fetch(`${baseUrl}/__sync/tournament/request-scorekeeper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          deviceId: 'dev-guest-d',
          deviceName: 'GuestD-Phone',
        }),
      })
    ).json();
    assert.equal(reRequestAfterDemote.approved, false, 'Manually demoted user must NOT auto-approve');
    assert.equal(reRequestAfterDemote.pending, true, 'Manually demoted user must enter pending approval queue');
    assert.equal(reRequestAfterDemote.state.scorekeeperRequests[0].previouslyDemoted, true);
    assert.equal(resolveEffectiveRole(reRequestAfterDemote.state, 'dev-guest-d'), 'spectator');

    // Moderator approves Guest D again -> becomes Scorekeeper and clears demoted flag
    const reApproveD = await (
      await fetch(`${baseUrl}/__sync/tournament/resolve-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          actorDeviceId: 'dev-b',
          targetDeviceId: 'dev-guest-d',
          approve: true,
        }),
      })
    ).json();
    assert.equal(reApproveD.ok, true);
    assert.equal(resolveEffectiveRole(reApproveD.state, 'dev-guest-d'), 'scorekeeper');
    assert.equal(reApproveD.state.demotedScorekeepers.includes('dev-guest-d'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Stop hosting + delete tournaments stays empty, and rotated-key kicked guest is marked unauthorized until entering new key', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-stop-rejoin-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Host creates a Secure Public tournament with initial key K1
    const t = createInitialState({
      tournamentName: 'Key Rotate Kick Cup',
      access: { isPublic: true, isSecure: true },
    });
    const k1 = t.joinCode;
    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-host', deviceName: 'HostPC', state: t, activate: true }),
    });

    // 2. Guest joins with K1 -> summary reports isAuthorized: true
    const join1 = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-guest', joinCode: k1 }),
    });
    assert.equal(join1.status, 200);
    const listBeforeKick = await (
      await fetch(`${baseUrl}/__sync/tournaments?deviceId=dev-guest`)
    ).json();
    assert.equal(listBeforeKick.tournaments[0].isAuthorized, true);

    // 3. Host rotates key K1 -> K2 without kicking yet -> guest STILL authorized on /__sync/select!
    const rot = await (
      await fetch(`${baseUrl}/__sync/tournament/rotate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-host' }),
      })
    ).json();
    const k2 = rot.joinCode;
    assert.notEqual(k2, k1);

    const stillAllowed = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-guest', joinCode: k1 }),
    });
    assert.equal(stillAllowed.status, 200, 'Non-kicked guest remains authorized across key rotation');

    // 4. Host kicks guest -> summary reports isAuthorized: false, old key K1 returns 403 requiresKey, new key K2 rejoins!
    const kickRes = await fetch(`${baseUrl}/__sync/clients/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-host',
        targetDeviceId: 'dev-guest',
      }),
    });
    assert.equal(kickRes.status, 200);

    const listAfterKick = await (
      await fetch(`${baseUrl}/__sync/tournaments?deviceId=dev-guest`)
    ).json();
    assert.equal(
      listAfterKick.tournaments[0].isAuthorized,
      false,
      'Hub directory must flag kicked guest as unauthorized so Rejoin button becomes Enter ID'
    );

    const retryOldKey = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-guest', joinCode: k1 }),
    });
    assert.equal(retryOldKey.status, 403);
    const retryOldBody = await retryOldKey.json();
    assert.equal(retryOldBody.requiresKey, true);

    const rejoinNewKey = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-guest', joinCode: k2 }),
    });
    assert.equal(rejoinNewKey.status, 200, 'Kicked guest can rejoin via card prompt with new key K2');

    // 5. Host stops hosting & deletes tournament -> hosts list is empty and 0 tournaments remain
    const releaseRes = await (
      await fetch(`${baseUrl}/__sync/host-claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-host', release: true }),
      })
    ).json();
    assert.equal(releaseRes.hosts.length, 0);

    const delRes = await (
      await fetch(`${baseUrl}/__sync/tournaments/${encodeURIComponent(t.tournamentId)}?deviceId=dev-host`, {
        method: 'DELETE',
      })
    ).json();
    assert.equal(delRes.tournaments.length, 0);

    const stateAfter = await (await fetch(`${baseUrl}/__sync/state?deviceId=dev-host`)).json();
    assert.equal(stateAfter.state, null);
    assert.equal(stateAfter.hosts.length, 0);
    assert.equal(stateAfter.tournaments.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Tournament Destroy starts countdown, only previous hosts can claim & cancel, and expiry permanently destroys it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-destroy-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Host A creates tournament, Abandons, Host B Claims -> hostHistory contains both A and B
    const t = createInitialState({
      tournamentName: 'Doomsday Cup',
      access: { isPublic: true, isSecure: true },
    });
    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-host-a', deviceName: 'HostA', state: t, activate: true }),
    });
    await fetch(`${baseUrl}/__sync/tournament/abandon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-host-a' }),
    });
    const hostBClaim = await (
      await fetch(`${baseUrl}/__sync/tournament/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          deviceId: 'dev-host-b',
          deviceName: 'HostB',
        }),
      })
    ).json();
    assert.equal(hostBClaim.ok, true);
    assert.ok(hostBClaim.state.hostHistory.includes('dev-host-a'));
    assert.ok(hostBClaim.state.hostHistory.includes('dev-host-b'));

    // 2. Host B initiates Destroy (with short 250ms test timer)
    const destroyStart = await (
      await fetch(`${baseUrl}/__sync/tournament/destroy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          deviceId: 'dev-host-b',
          deviceName: 'HostB',
          delayMs: 250,
        }),
      })
    ).json();
    assert.equal(destroyStart.ok, true);
    assert.ok(destroyStart.destruction.destroyAt > Date.now());

    // 3. Random non-host Guest C CANNOT claim & cancel destruction (403)!
    const guestCancel = await fetch(`${baseUrl}/__sync/tournament/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-guest-c',
        deviceName: 'GuestC',
      }),
    });
    assert.equal(guestCancel.status, 403);

    // 4. Previous Host A claims within timer -> cancels destruction & becomes Host!
    const hostACancel = await (
      await fetch(`${baseUrl}/__sync/tournament/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          deviceId: 'dev-host-a',
          deviceName: 'HostA',
        }),
      })
    ).json();
    assert.equal(hostACancel.ok, true);
    assert.equal(hostACancel.cancelledDestruction, true);
    assert.equal(hostACancel.state.destruction, null);
    assert.equal(hostACancel.state.hostDeviceId, 'dev-host-a');

    // Wait past original 250ms deadline -> tournament MUST still exist because destruction was cancelled!
    await new Promise((r) => setTimeout(r, 320));
    const stillAlive = await (
      await fetch(`${baseUrl}/__sync/tournaments?deviceId=dev-host-a`)
    ).json();
    assert.equal(stillAlive.tournaments.length, 1);

    // 5. Now Host A initiates Destroy (100ms) and nobody claims -> permanently destroyed!
    const finalDestroy = await (
      await fetch(`${baseUrl}/__sync/tournament/destroy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          deviceId: 'dev-host-a',
          deviceName: 'HostA',
          delayMs: 100,
        }),
      })
    ).json();
    assert.equal(finalDestroy.ok, true);

    await new Promise((r) => setTimeout(r, 180));
    const afterExpiry = await (
      await fetch(`${baseUrl}/__sync/tournaments?deviceId=dev-host-a`)
    ).json();
    assert.equal(afterExpiry.tournaments.length, 0, 'Tournament must be permanently destroyed after timer expires');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Hub Admin (Option C: local server claim + 4-word Admin Key) manages private tournaments, Hub policies, Host transfer, and deletion', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-hub-admin-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Server computer claims local Hub Admin and receives the 4-word Admin Key
    const claimRes = await (
      await fetch(`${baseUrl}/__sync/admin/claim-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-server', deviceName: 'MainServer' }),
      })
    ).json();
    assert.equal(claimRes.ok, true);
    assert.equal(claimRes.isAdmin, true);
    assert.ok(claimRes.adminKey && claimRes.adminKey.split('-').length === 4);

    // Non-admin /__sync/state MUST NOT leak adminKey
    const guestState = await (
      await fetch(`${baseUrl}/__sync/state?deviceId=dev-remote`)
    ).json();
    assert.equal(guestState.isAdmin, false);
    assert.equal(guestState.adminKey, undefined);

    // 2. Remote device tries wrong key -> 403; valid 4-word Admin Key -> 200 Admin!
    const badUnlock = await fetch(`${baseUrl}/__sync/admin/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-remote', deviceName: 'Phone', key: 'wrong-key-here-now' }),
    });
    assert.equal(badUnlock.status, 403);

    const goodUnlock = await (
      await fetch(`${baseUrl}/__sync/admin/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-remote', deviceName: 'Phone', key: claimRes.adminKey }),
      })
    ).json();
    assert.equal(goodUnlock.ok, true);
    assert.equal(goodUnlock.isAdmin, true);

    // Promoted/remote Admin CANNOT revoke the original server Admin (403); original server Admin CAN revoke promoted Admin (200)
    const blockRevokeOriginal = await fetch(`${baseUrl}/__sync/admin/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actorDeviceId: 'dev-remote',
        targetDeviceId: 'dev-server',
        grant: false,
      }),
    });
    assert.equal(blockRevokeOriginal.status, 403);

    const allowRevokePromoted = await fetch(`${baseUrl}/__sync/admin/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actorDeviceId: 'dev-server',
        targetDeviceId: 'dev-remote',
        grant: false,
      }),
    });
    assert.equal(allowRevokePromoted.status, 200);

    // 3. Another user creates a Private Secure tournament -> normal guest cannot see it, Hub Admin sees & opens it without a key!
    const priv = createInitialState({
      tournamentName: 'Secret Private Cup',
      access: { isPublic: false, isSecure: true },
    });
    const pubRes = await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-host-x', deviceName: 'HostX', state: priv, activate: true }),
    });
    assert.equal(pubRes.status, 200);

    const normalList = await (await fetch(`${baseUrl}/__sync/tournaments?deviceId=dev-nobody`)).json();
    assert.equal(normalList.tournaments.length, 0);

    const adminList = await (await fetch(`${baseUrl}/__sync/tournaments?deviceId=dev-server`)).json();
    assert.equal(adminList.tournaments.length, 1);
    assert.equal(adminList.tournaments[0].tournamentName, 'Secret Private Cup');
    assert.equal(adminList.tournaments[0].isAuthorized, true);

    const adminEnter = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: priv.tournamentId, deviceId: 'dev-server' }),
    });
    assert.equal(adminEnter.status, 200);

    // 4. Hub Admin transfers Host ownership of that tournament to dev-new-host, then restricts creation to Admins Only!
    const transferRes = await (
      await fetch(`${baseUrl}/__sync/tournament/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: priv.tournamentId,
          actorDeviceId: 'dev-server',
          targetDeviceId: 'dev-new-host',
          role: 'host',
        }),
      })
    ).json();
    assert.equal(transferRes.ok, true);
    assert.equal(transferRes.state.hostDeviceId, 'dev-new-host');

    const lockCreation = await (
      await fetch(`${baseUrl}/__sync/admin/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actorDeviceId: 'dev-server',
          settings: { allowPublicCreation: false, hubTitle: 'CLUB PING PONG' },
        }),
      })
    ).json();
    assert.equal(lockCreation.ok, true);
    assert.equal(lockCreation.hubSettings.allowPublicCreation, false);
    assert.equal(lockCreation.hubSettings.hubTitle, 'CLUB PING PONG');

    const blockedCreate = await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'dev-nobody',
        deviceName: 'RandomPhone',
        state: createInitialState({ tournamentName: 'Blocked Cup' }),
      }),
    });
    assert.equal(blockedCreate.status, 403);

    // 5. Hub Admin rotates Admin Key & deletes another host's tournament cleanly
    const rot = await (
      await fetch(`${baseUrl}/__sync/admin/rotate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorDeviceId: 'dev-server' }),
      })
    ).json();
    assert.equal(rot.ok, true);
    assert.notEqual(rot.adminKey, claimRes.adminKey);

    const delByNobody = await fetch(
      `${baseUrl}/__sync/tournaments/${encodeURIComponent(priv.tournamentId)}?deviceId=dev-nobody`,
      { method: 'DELETE' }
    );
    assert.equal(delByNobody.status, 403);

    const delByAdmin = await fetch(
      `${baseUrl}/__sync/tournaments/${encodeURIComponent(priv.tournamentId)}?deviceId=dev-server`,
      { method: 'DELETE' }
    );
    assert.equal(delByAdmin.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('New user can request join access on a Secure tournament instead of entering the 4-word key, and Host can deny or approve', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-join-req-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Host creates a Secure Public tournament
    const t = createInitialState({
      tournamentName: 'Approval Entry Cup',
      access: { isPublic: true, isSecure: true },
    });
    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-host', deviceName: 'HostPC', state: t, activate: true }),
    });

    // 2. New user cannot join directly without key (403 requiresKey)
    const blocked = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-new-user' }),
    });
    assert.equal(blocked.status, 403);

    // 3. New user requests join access -> pending on Hub summary & visible in host state.joinRequests
    const reqJoin = await (
      await fetch(`${baseUrl}/__sync/tournament/request-join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          deviceId: 'dev-new-user',
          deviceName: 'NewUserPhone',
        }),
      })
    ).json();
    assert.equal(reqJoin.ok, true);
    assert.equal(reqJoin.pending, true);
    assert.equal(reqJoin.approved, false);
    assert.equal(reqJoin.tournaments[0].joinRequestPending, true);
    assert.equal(reqJoin.tournaments[0].isAuthorized, false);

    // 4. Host denies first -> request cleared, user still blocked (403)
    const denyRes = await (
      await fetch(`${baseUrl}/__sync/tournament/resolve-join-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          actorDeviceId: 'dev-host',
          targetDeviceId: 'dev-new-user',
          approve: false,
        }),
      })
    ).json();
    assert.equal(denyRes.ok, true);
    assert.equal(denyRes.approved, false);
    assert.equal(denyRes.state.joinRequests.length, 0);

    const stillBlocked = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-new-user' }),
    });
    assert.equal(stillBlocked.status, 403);

    // 5. New user requests again -> tagged previouslyDenied: true; Host approves -> enters without key!
    await fetch(`${baseUrl}/__sync/tournament/request-join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-new-user',
        deviceName: 'NewUserPhone',
      }),
    });

    const hostStateWithDeniedFlag = await (
      await fetch(`${baseUrl}/__sync/state?deviceId=dev-host&tournamentId=${encodeURIComponent(t.tournamentId)}`)
    ).json();
    assert.equal(
      hostStateWithDeniedFlag.state.joinRequests[0].previouslyDenied,
      true,
      'Re-requested join after denial must carry previouslyDenied: true'
    );

    const approveRes = await (
      await fetch(`${baseUrl}/__sync/tournament/resolve-join-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: t.tournamentId,
          actorDeviceId: 'dev-host',
          targetDeviceId: 'dev-new-user',
          approve: true,
        }),
      })
    ).json();
    assert.equal(approveRes.ok, true);
    assert.equal(approveRes.approved, true);
    assert.equal(approveRes.state.joinRequests.length, 0);

    const afterApproveList = await (
      await fetch(`${baseUrl}/__sync/tournaments?deviceId=dev-new-user`)
    ).json();
    assert.equal(afterApproveList.tournaments[0].isAuthorized, true);
    assert.equal(afterApproveList.tournaments[0].joinRequestPending, false);

    const enterWithoutKey = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: t.tournamentId, deviceId: 'dev-new-user' }),
    });
    assert.equal(enterWithoutKey.status, 200);

    // 6. Host kicks dev-new-user -> requesting join again carries previouslyKicked: true!
    const kickRes = await fetch(`${baseUrl}/__sync/clients/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-host',
        targetDeviceId: 'dev-new-user',
      }),
    });
    assert.equal(kickRes.status, 200);

    await fetch(`${baseUrl}/__sync/tournament/request-join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-new-user',
        deviceName: 'NewUserPhone',
      }),
    });
    const hostStateAfterKick = await (
      await fetch(`${baseUrl}/__sync/state?deviceId=dev-host&tournamentId=${encodeURIComponent(t.tournamentId)}`)
    ).json();
    assert.equal(
      hostStateAfterKick.state.joinRequests[0].previouslyKicked,
      true,
      'Re-requested join after kick must carry previouslyKicked: true'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Joining tournaments allows run-on keys and configurable typo tolerance controlled by Hub Admin', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-fuzzy-key-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Claim Hub Admin
    await fetch(`${baseUrl}/__sync/admin/claim-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-admin', deviceName: 'Server' }),
    });

    // Create a Secure Private tournament with a known 4-word key
    const t = createInitialState({
      tournamentId: 'amber-paddle-swift-comet',
      joinCode: 'amber-paddle-swift-comet',
      tournamentName: 'Fuzzy Key Cup',
      access: { isPublic: false, isSecure: true },
    });
    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-host', deviceName: 'HostPC', state: t, activate: true }),
    });

    // 1. Default allowedKeyTypos = 2:
    //    - Run-on exact key works (`amberpaddleswiftcomet`)
    const runOnJoin = await fetch(`${baseUrl}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-u1', code: 'amberpaddleswiftcomet' }),
    });
    assert.equal(runOnJoin.status, 200);

    //    - Run-on with 1 adjacent swap + 1 missing letter (2 typos: `amberpadleswiftcomte`) works!
    const twoTypoJoin = await fetch(`${baseUrl}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-u2', code: 'amberpadleswiftcomte' }),
    });
    assert.equal(twoTypoJoin.status, 200);

    //    - 3 typos (`xmberpadleswiftcomte`) is rejected when limit is 2!
    const threeTypoBlocked = await fetch(`${baseUrl}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-u3', code: 'xmberpadleswiftcomte' }),
    });
    assert.equal(threeTypoBlocked.status, 404);

    //    - /__sync/select also accepts run-on + 1 typo (`amber padlde swift comet`)!
    const selectTypo = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-u4',
        joinCode: 'amber padlde swift comet',
      }),
    });
    assert.equal(selectTypo.status, 200);

    // 2. Hub Admin sets allowedKeyTypos = 0 (Exact spelling, run-on still OK)
    const setZero = await (
      await fetch(`${baseUrl}/__sync/admin/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorDeviceId: 'dev-admin', settings: { allowedKeyTypos: 0 } }),
      })
    ).json();
    assert.equal(setZero.hubSettings.allowedKeyTypos, 0);

    const exactRunOnAtZero = await fetch(`${baseUrl}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-u5', code: 'AmberPaddleSwiftComet' }),
    });
    assert.equal(exactRunOnAtZero.status, 200, 'Exact run-on key still works when typos=0');

    const oneTypoBlockedAtZero = await fetch(`${baseUrl}/__sync/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: t.tournamentId,
        deviceId: 'dev-u6',
        joinCode: 'amber-padlde-swift-comet',
      }),
    });
    assert.equal(oneTypoBlockedAtZero.status, 403, '1 typo is blocked when typos=0');

    // 3. Hub Admin sets allowedKeyTypos = 3 -> 3 typos now succeed!
    await fetch(`${baseUrl}/__sync/admin/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorDeviceId: 'dev-admin', settings: { allowedKeyTypos: 3 } }),
    });
    const threeTypoAllowed = await fetch(`${baseUrl}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-u7', code: 'xmberpadleswiftcomte' }),
    });
    assert.equal(threeTypoAllowed.status, 200, '3 typos succeed when Admin sets allowedKeyTypos=3');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('QR code generator produces valid ISO QR matrices and Grandma sync eliminates 15-second receiver clock skew', () => {
  // 1. QR matrix validation for a typical LAN auto-join URL
  const url = 'http://192.168.1.50:5173/?join=amber-paddle-swift-comet';
  const { size, version, modules } = generateQrMatrix(url);
  assert.ok(version >= 3 && version <= 10);
  assert.equal(size, version * 4 + 17);
  assert.equal(modules.length, size);
  // Top-left, top-right, bottom-left 7x7 finder centers & borders
  assert.equal(modules[0][0], true);
  assert.equal(modules[3][3], true);
  assert.equal(modules[0][size - 1], true);
  assert.equal(modules[size - 1][0], true);
  // Mandatory dark module at (size - 8, 8)
  assert.equal(modules[size - 8][8], true);
  // Timing pattern alternates dark/light along row 6
  assert.equal(modules[6][8], true);
  assert.equal(modules[6][9], false);
  const pathStr = qrMatrixToSvgPath(modules);
  assert.ok(pathStr.startsWith('M') && pathStr.length > 500);

  // 2. Grandma clock-skew elimination: simulate a sender whose clock is 15 seconds ahead of a Fire Stick
  const store = new TournamentStore(createInitialState(), { persist: false });
  const now = Date.now();
  const skewedSpeech = {
    id: 999001,
    text: 'What a backhand!',
    category: 'contextual',
    isLive: true,
    startedAt: now + 15000, // Sender clock 15s ahead of receiver!
    expiresAt: now + 21000,
    nextBanterAt: now + 29000,
    durationMs: 6000,
    nextGapMs: 8000,
  };
  store.handleExternalGrandmaSpeech(skewedSpeech, { liveArrival: true });
  const synced = store.getState().grandma.activeSpeech;
  assert.ok(synced, 'Rebased speech must exist immediately');
  assert.ok(
    Math.abs(synced.startedAt - Date.now()) < 500,
    'Live SSE Grandma speech must anchor immediately to receiver local clock (0ms skew delay)'
  );
  assert.equal(synced.expiresAt - synced.startedAt, 6000, 'Duration must be preserved exactly');
});

test('Share origin always prefers local Wi-Fi/Ethernet IP over Tailscale (even unsorted) and uses online domain when deployed', () => {
  // Unsorted serverInfo with Tailscale listed first (as Windows os.networkInterfaces() returns)
  const unsortedServerInfo = {
    port: 5173,
    lanAddresses: [
      { interfaceName: 'Tailscale', address: '100.72.165.110' },
      { interfaceName: 'vEthernet (WSL)', address: '172.25.16.1' },
      { interfaceName: 'Wi-Fi', address: '10.0.3.170' },
    ],
  };

  const ranked = rankLanAddresses(unsortedServerInfo.lanAddresses);
  assert.equal(ranked[0].address, '10.0.3.170');
  assert.equal(ranked[0].interfaceName, 'Wi-Fi');
  assert.equal(ranked[ranked.length - 1].interfaceName, 'Tailscale');

  // Localhost -> local Wi-Fi IP
  assert.equal(
    resolveShareOrigin(unsortedServerInfo, '', {
      protocol: 'http:',
      hostname: 'localhost',
      port: '5173',
      origin: 'http://localhost:5173',
    }),
    'http://10.0.3.170:5173'
  );

  // Accessing via Tailscale IP or Tailscale MagicDNS (.ts.net) -> still shares local Wi-Fi IP
  assert.equal(
    resolveShareOrigin(unsortedServerInfo, '', {
      protocol: 'http:',
      hostname: '100.72.165.110',
      port: '5173',
      origin: 'http://100.72.165.110:5173',
    }),
    'http://10.0.3.170:5173'
  );
  assert.equal(
    resolveShareOrigin(unsortedServerInfo, '', {
      protocol: 'http:',
      hostname: 'hp-elitebook.tail1234.ts.net',
      port: '5173',
      origin: 'http://hp-elitebook.tail1234.ts.net:5173',
    }),
    'http://10.0.3.170:5173'
  );

  // Single-label LAN hostname -> local Wi-Fi IP
  assert.equal(
    resolveShareOrigin(unsortedServerInfo, '', {
      protocol: 'http:',
      hostname: 'hp-elitebook',
      port: '5173',
      origin: 'http://hp-elitebook:5173',
    }),
    'http://10.0.3.170:5173'
  );

  // Deployed online on a real public domain -> uses the deployed URL
  assert.equal(
    resolveShareOrigin(unsortedServerInfo, '', {
      protocol: 'https:',
      hostname: 'pingpong.example.com',
      port: '',
      origin: 'https://pingpong.example.com',
    }),
    'https://pingpong.example.com'
  );
});

test('Custom CRT TV media uploads broadcast MEDIA_UPDATE over SSE, persist across restarts, and clear cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-tv-media-'));
  const startServer = async () => {
    const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
    const srv = http.createServer((req, res) => {
      handler(req, res, () => {
        res.statusCode = 404;
        res.end('Not found');
      });
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    return { srv, baseUrl: `http://127.0.0.1:${srv.address().port}` };
  };

  let s1 = null;
  let s2 = null;
  let sseReq = null;
  try {
    s1 = await startServer();

    // Connect a remote SSE listener (e.g., Fire Stick / Presentation TV)
    let sseBuf = '';
    let gotMediaEvent = null;
    sseReq = http.get(`${s1.baseUrl}/__sync/events?tabId=id-tv01&deviceId=dev-tv&viewMode=present`);
    await new Promise((resolve, reject) => {
      sseReq.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          sseBuf += chunk;
          if (sseBuf.includes('event: CONNECTED')) resolve();
          if (sseBuf.includes('event: MEDIA_UPDATE')) gotMediaEvent = sseBuf;
        });
      });
      sseReq.on('error', reject);
    });

    // Upload a GIF payload from Control View
    const fakeGif = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'binary');
    const uploadRes = await fetch(`${s1.baseUrl}/__sync/media`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/gif',
        'X-Media-Name': encodeURIComponent('retro-rally.gif'),
        'X-Media-Type': 'image/gif',
        'X-Media-Kind': 'image',
        'X-Sync-Sender': 'id-ctrl',
      },
      body: fakeGif,
    });
    assert.equal(uploadRes.status, 200);
    const uploadJson = await uploadRes.json();
    assert.equal(uploadJson.ok, true);
    assert.equal(uploadJson.name, 'retro-rally.gif');
    assert.ok(uploadJson.updatedAt > 0);

    // Wait briefly for SSE delivery
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(gotMediaEvent && gotMediaEvent.includes('"action":"set"'), 'Remote screen must receive MEDIA_UPDATE SSE');

    // Remote screen probes lightweight metadata endpoint and verifies HTTP 206 Range streaming
    const metaRes = await fetch(`${s1.baseUrl}/__sync/media?meta=1`);
    assert.equal(metaRes.status, 200);
    const metaJson = await metaRes.json();
    assert.equal(metaJson.hasMedia, true);
    assert.equal(metaJson.name, 'retro-rally.gif');
    assert.equal(metaJson.bytes, fakeGif.length);

    const rangeRes = await fetch(`${s1.baseUrl}/__sync/media`, {
      headers: { Range: 'bytes=0-5' },
    });
    assert.equal(rangeRes.status, 206, 'MP4/WebM streaming must support HTTP 206 Partial Content');
    assert.equal(rangeRes.headers.get('accept-ranges'), 'bytes');
    assert.equal(rangeRes.headers.get('content-range'), `bytes 0-5/${fakeGif.length}`);
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
    assert.equal(rangeBuf.toString('ascii'), 'GIF89a');

    // Remote screen fetches the full media and checks exposed headers
    const getRes = await fetch(`${s1.baseUrl}/__sync/media`);
    assert.equal(getRes.status, 200);
    assert.equal(decodeURIComponent(getRes.headers.get('x-media-name') || ''), 'retro-rally.gif');
    assert.ok((getRes.headers.get('access-control-expose-headers') || '').includes('X-Media-Name'));
    const fetchedBuf = Buffer.from(await getRes.arrayBuffer());
    assert.equal(Buffer.compare(fetchedBuf, fakeGif), 0);

    // Close server 1 and start server 2 (simulating Vite restart) -> media MUST survive on disk!
    sseReq.destroy();
    sseReq = null;
    await new Promise((resolve) => s1.srv.close(resolve));
    s1 = null;

    s2 = await startServer();
    const afterRestartRes = await fetch(`${s2.baseUrl}/__sync/media`);
    assert.equal(afterRestartRes.status, 200, 'Custom TV media must persist across server restarts');
    assert.equal(decodeURIComponent(afterRestartRes.headers.get('x-media-name') || ''), 'retro-rally.gif');

    // Reset Sitcom (DELETE /__sync/media) removes disk media
    const delRes = await fetch(`${s2.baseUrl}/__sync/media`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const emptyRes = await fetch(`${s2.baseUrl}/__sync/media`);
    assert.equal(emptyRes.status, 204);
  } finally {
    if (sseReq) sseReq.destroy();
    if (s1?.srv) await new Promise((resolve) => s1.srv.close(resolve));
    if (s2?.srv) await new Promise((resolve) => s2.srv.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Count-up match timer starts on Begin Match, freezes on completion, and resumes elapsed time on reopen', () => {
  assert.equal(formatMatchTimer(0), '00:00');
  assert.equal(formatMatchTimer(65000), '01:05');
  assert.equal(formatMatchTimer(3661000), '1:01:01');

  const store = new TournamentStore(createInitialState({ playerCount: 4, rules: { targetPoints: 3, winBy: 1 } }), {
    persist: false,
  });
  const m0 = store.getState().matches[store.getState().activeMatchId];
  assert.equal(computeMatchElapsedMs(m0), 0, 'Unstarted match timer must be 00:00');

  store.startMatch(m0.id);
  const started = store.getState().matches[m0.id];
  assert.ok(started.startedAt > 0, 'startMatch must record startedAt');
  assert.equal(computeMatchElapsedMs(started, started.startedAt + 125000), 125000);
  assert.equal(formatMatchTimer(computeMatchElapsedMs(started, started.startedAt + 125000)), '02:05');

  // Score to win -> timer stops immediately at winnerReachedAt, but resumes background clock if point removed
  store.addPoint(1, { bypassDebounce: true });
  store.addPoint(1, { bypassDebounce: true });
  store.addPoint(1, { bypassDebounce: true });
  const wonNotCompleted = store.getState().matches[m0.id];
  assert.equal(wonNotCompleted.completed, false);
  assert.ok(wonNotCompleted.winnerReachedAt >= wonNotCompleted.startedAt, 'Winning point must stamp winnerReachedAt');
  const stoppedAtWinnerMs = computeMatchElapsedMs(wonNotCompleted, wonNotCompleted.startedAt + 60000);
  assert.equal(
    stoppedAtWinnerMs,
    Math.max(0, wonNotCompleted.winnerReachedAt - wonNotCompleted.startedAt),
    'Displayed timer must stay stopped at winnerReachedAt even as wall clock advances'
  );

  // Subtracting the mistaken winning point clears winnerReachedAt and reveals the continuously running background timer
  store.subtractPoint(1);
  const corrected = store.getState().matches[m0.id];
  assert.equal(corrected.winnerReachedAt, null, 'Subtracting below winning score must clear winnerReachedAt');
  assert.equal(
    computeMatchElapsedMs(corrected, corrected.startedAt + 60000),
    60000,
    'Background clock must have kept running continuously from startedAt'
  );

  // Re-score winning point and complete -> elapsedMs freezes cleanly at winnerReachedAt
  store.addPoint(1, { bypassDebounce: true });
  const wonAgain = store.getState().matches[m0.id];
  assert.ok(wonAgain.winnerReachedAt >= wonAgain.startedAt);
  store.completeActiveMatch();
  const completed = store.getState().matches[m0.id];
  assert.equal(completed.completed, true);
  assert.equal(typeof completed.elapsedMs, 'number');
  assert.equal(
    completed.elapsedMs,
    Math.max(0, wonAgain.winnerReachedAt - wonAgain.startedAt),
    'Completed elapsedMs must match the time when winner was reached'
  );
  const frozenMs = computeMatchElapsedMs(completed, Date.now() + 999999);
  assert.equal(frozenMs, completed.elapsedMs, 'Completed match timer must stay frozen');

  // Reopen match -> preserves previous elapsedMs in timerOffsetMs and resumes counting up
  store.reopenMatch(m0.id);
  const reopened = store.getState().matches[m0.id];
  assert.equal(reopened.completed, false);
  assert.equal(reopened.timerOffsetMs, completed.elapsedMs);
  assert.ok(computeMatchElapsedMs(reopened, reopened.startedAt + 5000) >= completed.elapsedMs + 5000);

  // Intermission tournament stats compute leaderboard, streaks, blowout, and average points
  const sStore = new TournamentStore(
    createInitialState({ playerCount: 4, rules: { targetPoints: 3, winBy: 1 } }),
    { persist: false }
  );
  const mId = sStore.getState().activeMatchId;
  sStore.startMatch(mId);
  sStore.addPoint(1, { bypassDebounce: true });
  sStore.addPoint(1, { bypassDebounce: true });
  sStore.addPoint(1, { bypassDebounce: true });
  sStore.completeActiveMatch();
  const tStats = computeTournamentStats(sStore.getState());
  assert.equal(tStats.completedCount, 1);
  assert.equal(tStats.progressPct, Math.round((1 / tStats.totalMatches) * 100));
  assert.equal(tStats.leaderboard[0].wins, 1);
  assert.equal(tStats.leaderboard[0].pointDiff, 3);
  assert.equal(tStats.longestPointStreak?.streak, 3);
  assert.equal(tStats.biggestBlowout?.margin, 3);
  assert.equal(tStats.avgPointsPerMatch, 3);
});

test('Configurable skunk rule ends shutout matches at custom threshold and exposes skunk point/win state', () => {
  const baseMatch = {
    id: 'W-R1-M1',
    player1Id: 'p1',
    player2Id: 'p2',
    score1: 7,
    score2: 0,
    initialServer: 1,
    completed: false,
  };

  // Off by default: 7-0 in an 11-pt game does NOT end the match
  const offEval = evaluateMatchState(baseMatch, {
    targetPoints: 11,
    serveRotation: 2,
    winBy: 2,
    skunkEnabled: false,
    skunkScore: 7,
  });
  assert.equal(offEval.winnerSlot, null);
  assert.equal(offEval.isSkunkWin, false);

  // Enabled at 7-0: 6-0 is Skunk Point, 7-0 is Skunk Win, 7-1 is NOT a skunk win
  const skunkRules = {
    targetPoints: 11,
    serveRotation: 2,
    winBy: 2,
    skunkEnabled: true,
    skunkScore: 7,
  };
  const skunkPtEval = evaluateMatchState({ ...baseMatch, score1: 6, score2: 0 }, skunkRules);
  assert.equal(skunkPtEval.status, MATCH_STATUS.GAME_POINT);
  assert.equal(skunkPtEval.gamePointFor, 1);
  assert.equal(skunkPtEval.isSkunkPoint, true);
  assert.equal(skunkPtEval.winnerSlot, null);

  const skunkWinEval = evaluateMatchState(baseMatch, skunkRules);
  assert.equal(skunkWinEval.status, MATCH_STATUS.WINNER);
  assert.equal(skunkWinEval.winnerSlot, 1);
  assert.equal(skunkWinEval.isSkunkWin, true);
  assert.equal(skunkWinEval.canComplete, true);

  const brokenShutoutEval = evaluateMatchState({ ...baseMatch, score1: 7, score2: 1 }, skunkRules);
  assert.equal(brokenShutoutEval.winnerSlot, null);
  assert.equal(brokenShutoutEval.isSkunkWin, false);

  // Store integration: custom 11-0 skunk in a 21-point game
  const store = new TournamentStore(
    createInitialState({
      playerCount: 4,
      rules: { targetPoints: 21, serveRotation: 5, winBy: 2, skunkEnabled: true, skunkScore: 11 },
    }),
    { persist: false }
  );
  const mId = store.getState().activeMatchId;
  store.startMatch(mId);
  for (let i = 0; i < 11; i += 1) {
    store.addPoint(2, { bypassDebounce: true });
  }
  const m = store.getState().matches[mId];
  assert.equal(m.score2, 11);
  assert.equal(m.score1, 0);
  // Extra point should be blocked because Skunk winner is already reached
  store.addPoint(2, { bypassDebounce: true });
  assert.equal(store.getState().matches[mId].score2, 11);
  store.completeActiveMatch();
  const completed = store.getState().matches[mId];
  assert.equal(completed.completed, true);
  assert.equal(completed.winnerId, completed.player2Id);
});

test("Dead Man's Serve gives serve to the player facing Game Point (including Deuce advantage & Skunk Point)", () => {
  const baseMatch = {
    id: 'W-R1-M1',
    player1Id: 'p1',
    player2Id: 'p2',
    score1: 10,
    score2: 6, // 16 total points -> normal 2-pt rotation gives serve to P1
    initialServer: 1,
    completed: false,
  };

  // Off by default: normal rotation gives P1 the serve at 10-6
  const offEval = evaluateMatchState(baseMatch, {
    targetPoints: 11,
    serveRotation: 2,
    winBy: 2,
    deadMansServe: false,
  });
  assert.equal(offEval.gamePointFor, 1);
  assert.equal(offEval.activeServer, 1);
  assert.equal(offEval.isDeadMansServe, false);

  // Enabled: P1 has game point -> P2 ("dead man") must serve!
  const onRules = {
    targetPoints: 11,
    serveRotation: 2,
    winBy: 2,
    deadMansServe: true,
    skunkEnabled: true,
    skunkScore: 7,
  };
  const onEval = evaluateMatchState(baseMatch, onRules);
  assert.equal(onEval.gamePointFor, 1);
  assert.equal(onEval.activeServer, 2);
  assert.equal(onEval.isDeadMansServe, true);

  // Tied at Deuce (10-10): neither player faces game point -> normal rotation applies
  const deuceEval = evaluateMatchState({ ...baseMatch, score1: 10, score2: 10 }, onRules);
  assert.equal(deuceEval.isDeuce, true);
  assert.equal(deuceEval.isDeadMansServe, false);

  // Advantage in Deuce (10-11, P2 has game point): P1 must serve!
  const advEval = evaluateMatchState({ ...baseMatch, score1: 10, score2: 11 }, onRules);
  assert.equal(advEval.gamePointFor, 2);
  assert.equal(advEval.activeServer, 1);
  assert.equal(advEval.isDeadMansServe, true);

  // Skunk Point (6-0, total 6 -> switches=3 -> P2 serves; 0-6 with P2 serving -> P1 serves!)
  const skunkPtEval = evaluateMatchState({ ...baseMatch, score1: 0, score2: 6 }, onRules);
  assert.equal(skunkPtEval.isSkunkPoint, true);
  assert.equal(skunkPtEval.gamePointFor, 2);
  assert.equal(skunkPtEval.activeServer, 1);
  assert.equal(skunkPtEval.isDeadMansServe, true);
});

test('Notification framework detects match start, match result, and on-deck events for claimed player', () => {
  const store = new TournamentStore(
    createInitialState({ playerCount: 4, rules: { targetPoints: 3, winBy: 1 } }),
    { persist: false }
  );
  const s0 = store.getState();
  const m1 = s0.matches[s0.activeMatchId];
  const claimedPlayerId = m1.player1Id;
  const prefs = { ...DEFAULT_NOTIFICATION_PREFS, enabled: true, claimedPlayerId };

  // Starting the claimed player's match emits match_starting
  store.startMatch(m1.id);
  const s1 = store.getState();
  const startEvents = detectNotificationEvents(s0, s1, prefs);
  assert.equal(startEvents.length, 1);
  assert.equal(startEvents[0].type, 'match_starting');
  assert.equal(startEvents[0].matchId, m1.id);

  // Scoring points without completing emits nothing
  store.addPoint(1, { bypassDebounce: true });
  store.addPoint(1, { bypassDebounce: true });
  store.addPoint(1, { bypassDebounce: true });
  const s2 = store.getState();
  assert.equal(detectNotificationEvents(s1, s2, prefs).length, 0);

  // Completing the match emits match_result for the claimed player
  store.completeActiveMatch();
  const s3 = store.getState();
  const resultEvents = detectNotificationEvents(s2, s3, prefs);
  assert.ok(resultEvents.some((e) => e.type === 'match_result' && e.matchId === m1.id));

  // Disabled prefs emit nothing
  assert.equal(detectNotificationEvents(s0, s1, { ...prefs, enabled: false }).length, 0);
});

test('$countdown variable resolves durations and clock times to remaining time only and ticks live', () => {
  const baseNow = new Date(2026, 10, 25, 12, 0, 0, 0).getTime(); // 12:00:00 PM

  const dur1 = resolveMessageTemplate('Starts in $countdown 5m!', {}, { now: baseNow });
  assert.equal(dur1.text, 'Starts in 05:00!');
  assert.equal(renderLiveMessageText(dur1.liveTemplate, baseNow + 65000), 'Starts in 03:55!');

  const dur2 = resolveMessageTemplate('Break: $countdown(90s)', {}, { now: baseNow });
  assert.equal(dur2.text, 'Break: 01:30');

  const dur3 = resolveMessageTemplate('Back in $countdown 10 mins', {}, { now: baseNow });
  assert.equal(dur3.text, 'Back in 10:00');

  const clk1 = resolveMessageTemplate('Begins in $countdown 1:00pm', {}, { now: baseNow });
  assert.equal(clk1.text, 'Begins in 1:00:00');
  assert.equal(clk1.countdownLabel, '1:00 pm');

  const clk2 = resolveMessageTemplate('Begins in $countdown 12:15 pm', {}, { now: baseNow });
  assert.equal(clk2.text, 'Begins in 15:00');
});

test('importBackupJSON imports exported backup, raw tournament state, and multi-tournament sync files', async () => {
  const sourceStore = new TournamentStore(
    createInitialState({
      tournamentId: 't-export-test',
      joinCode: 'alpha-bravo-charlie-delta',
      tournamentName: 'Thanksgiving Classic',
      playerCount: 4,
    }),
    { persist: false }
  );
  const exportedJson = sourceStore.exportBackupJSON();

  // 1. Exported backup wrapper ({ exportedAt, state })
  const target1 = new TournamentStore(createInitialState({ playerCount: 4 }), { persist: false });
  const r1 = await target1.importBackupJSON(exportedJson, { hostOnCloud: false });
  assert.equal(r1.ok, true);
  assert.equal(r1.count, 1);
  assert.equal(target1.getState().tournamentName, 'Thanksgiving Classic');
  assert.equal(target1.getState().joinCode, 'alpha-bravo-charlie-delta');

  // 2. Raw tournament state JSON
  const target2 = new TournamentStore(createInitialState({ playerCount: 4 }), { persist: false });
  const r2 = await target2.importBackupJSON(JSON.stringify(sourceStore.getState()), {
    hostOnCloud: false,
  });
  assert.equal(r2.ok, true);
  assert.equal(target2.getState().tournamentName, 'Thanksgiving Classic');

  // 3. Server sync data bundle (.pingpong-sync-data.json)
  const secondState = createInitialState({
    tournamentId: 't-second',
    joinCode: 'echo-foxtrot-golf-hotel',
    tournamentName: 'Doubles Side Bracket',
    playerCount: 4,
  });
  const syncBundle = JSON.stringify({
    activeTournamentId: 't-second',
    tournaments: {
      't-export-test': sourceStore.getState(),
      't-second': secondState,
    },
  });
  const target3 = new TournamentStore(createInitialState({ playerCount: 4 }), { persist: false });
  const r3 = await target3.importBackupJSON(syncBundle, { hostOnCloud: false });
  assert.equal(r3.ok, true);
  assert.equal(r3.count, 2);
  assert.equal(target3.getState().tournamentName, 'Doubles Side Bracket');

  // 4. Invalid JSON fails cleanly
  const bad = await target3.importBackupJSON('{not valid json', { hostOnCloud: false });
  assert.equal(bad.ok, false);
});

test('summarizeUsageEvents filters by Demo Mode, role, tournament type, and ranks views & actions', async () => {
  const { summarizeUsageEvents } = await import('../src/engine/usageAnalytics.js');
  const sampleEvents = [
    { ts: 1, type: 'view', name: 'view:control', view: 'control', role: 'host', demoMode: false, entryMode: 'singles', format: 'single', deviceType: 'desktop', deviceId: 'd1' },
    { ts: 2, type: 'view_duration', name: 'view:control', view: 'control', durationMs: 45000, role: 'host', demoMode: false, entryMode: 'singles', format: 'single', deviceType: 'desktop', deviceId: 'd1' },
    { ts: 3, type: 'action', name: '+1 Point', view: 'scorekeeper', role: 'scorekeeper', demoMode: false, entryMode: 'singles', format: 'single', deviceType: 'mobile', deviceId: 'd2' },
    { ts: 4, type: 'action', name: '+1 Point', view: 'scorekeeper', role: 'scorekeeper', demoMode: false, entryMode: 'singles', format: 'single', deviceType: 'mobile', deviceId: 'd2' },
    { ts: 5, type: 'action', name: 'Sim Entire Tournament', view: 'host', role: 'admin', demoMode: true, entryMode: 'teams', format: 'double', deviceType: 'desktop', deviceId: 'd1' },
  ];

  const realOnly = summarizeUsageEvents(sampleEvents, { demoFilter: 'real' });
  assert.equal(realOnly.totalEvents, 4);
  assert.equal(realOnly.uniqueDevices, 2);
  assert.equal(realOnly.views[0].view, 'control');
  assert.equal(realOnly.views[0].durationMs, 45000);
  assert.equal(realOnly.topActions[0].name, '+1 Point');
  assert.equal(realOnly.topActions[0].count, 2);

  const demoOnly = summarizeUsageEvents(sampleEvents, { demoFilter: 'demo' });
  assert.equal(demoOnly.totalEvents, 1);
  assert.equal(demoOnly.topActions[0].name, 'Sim Entire Tournament');

  const mobileOnly = summarizeUsageEvents(sampleEvents, { demoFilter: 'all', deviceType: 'mobile' });
  assert.equal(mobileOnly.totalEvents, 2);
  assert.equal(mobileOnly.byRole[0].role, 'scorekeeper');
});

test('2-way messaging supports public Live Chat, 1-to-1 DMs (deduped), and 1-to-many Group Chats', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chat-test-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    // Seed a tournament
    const initial = createInitialState({ tournamentId: 't-chat', tournamentName: 'Chat Open', playerCount: 4 });
    await fetch(`${base}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-a', deviceName: 'Alice', state: initial, activate: true }),
    });

    // 1. Public live game chat
    const liveRes = await fetch(`${base}/__sync/chat/live`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentId: 't-chat', deviceId: 'dev-b', deviceName: 'Bob', text: 'What a rally!' }),
    }).then((r) => r.json());
    assert.equal(liveRes.ok, true);
    assert.equal(liveRes.message.text, 'What a rally!');

    // 2. 1-to-1 DM (reuses same thread ID both ways)
    const dm1 = await fetch(`${base}/__sync/chat/thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: 't-chat',
        deviceId: 'dev-a',
        deviceName: 'Alice',
        targetDeviceIds: ['dev-b'],
        initialMessage: 'Ready for table 1?',
      }),
    }).then((r) => r.json());
    assert.equal(dm1.ok, true);
    assert.equal(dm1.thread.kind, 'dm');

    const dm2 = await fetch(`${base}/__sync/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: 't-chat',
        threadId: dm1.thread.id,
        deviceId: 'dev-b',
        deviceName: 'Bob',
        text: 'On my way!',
      }),
    }).then((r) => r.json());
    assert.equal(dm2.ok, true);
    assert.equal(dm2.thread.messages.length, 2);

    // 3. 1-to-many Group Chat
    const grp = await fetch(`${base}/__sync/chat/thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: 't-chat',
        deviceId: 'dev-a',
        deviceName: 'Alice',
        targetDeviceIds: ['dev-b', 'dev-c'],
        groupName: 'Table 1 Crew',
        initialMessage: 'Warming up now!',
      }),
    }).then((r) => r.json());
    assert.equal(grp.ok, true);
    assert.equal(grp.thread.kind, 'group');
    assert.equal(grp.thread.name, 'Table 1 Crew');

    // Privacy check: dev-c sees Live Chat + Group Chat, NOT Alice<->Bob DM
    const cChat = await fetch(`${base}/__sync/chat?tournamentId=t-chat&deviceId=dev-c`).then((r) => r.json());
    assert.equal(cChat.liveMessages.length, 1);
    assert.equal(cChat.threads.length, 1);
    assert.equal(cChat.threads[0].id, grp.thread.id);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Returning guest with valid 4-word key auto-reauthorizes after ephemeral server redeploy, while kicked guest stays revoked', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jitter-redeploy-'));
  let port = 0;
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => port });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Simulate Render Free ephemeral redeploy: brand-new empty server, host re-pushes Secure tournament
    const tourney = createInitialState();
    tourney.tournamentId = 't-redeploy';
    tourney.tournamentName = 'Render Redeploy Cup';
    tourney.joinCode = 'blue-tiger-mint-lamp';
    tourney.hostDeviceId = 'dev-desktop-host';
    tourney.access = { isPublic: true, isSecure: true };
    tourney.kickedDevices = ['dev-kicked-guest'];

    const pushRes = await fetch(`${base}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'dev-desktop-host',
        deviceName: 'Desktop Host',
        state: tourney,
        activate: true,
      }),
    });
    assert.equal(pushRes.status, 200);

    // 1. Mobile guest reconnects with its saved 4-word key -> server re-authorizes it AND marks summary isAuthorized: true
    const guestSync = await fetch(
      `${base}/__sync/state?deviceId=dev-mobile-guest&tournamentId=t-redeploy&code=blue-tiger-mint-lamp`
    ).then((r) => r.json());
    assert.equal(guestSync.accessRevoked, false);
    assert.equal(guestSync.state?.tournamentId, 't-redeploy');
    assert.equal(guestSync.tournaments[0]?.isAuthorized, true);

    // 2. Subsequent sync without code still recognizes the re-authorized mobile guest
    const guestFollowup = await fetch(
      `${base}/__sync/state?deviceId=dev-mobile-guest&tournamentId=t-redeploy`
    ).then((r) => r.json());
    assert.equal(guestFollowup.accessRevoked, false);
    assert.equal(guestFollowup.state?.tournamentId, 't-redeploy');
    assert.equal(guestFollowup.tournaments[0]?.isAuthorized, true);

    // 3. Explicitly kicked guest is NOT auto-reauthorized even if it sends the old key
    const kickedSync = await fetch(
      `${base}/__sync/state?deviceId=dev-kicked-guest&tournamentId=t-redeploy&code=blue-tiger-mint-lamp`
    ).then((r) => r.json());
    assert.equal(kickedSync.tournaments[0]?.isAuthorized, false);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CRT TV media library endpoint lists uploaded files and parses GCS ListObjectsV2 XML', async () => {
  const { parseGcsListXml } = await import('../src/server/gcsMediaSigner.js');
  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult>
      <Contents>
        <Key>jitter-tv/tvm-1700000000000-ab12-rally-clip.mp4</Key>
        <LastModified>2026-11-26T22:00:00.000Z</LastModified>
        <Size>1234567</Size>
      </Contents>
      <Contents>
        <Key>jitter-tv/tvm-1700000001000-cd34-retro-logo.gif</Key>
        <LastModified>2026-11-26T23:00:00.000Z</LastModified>
        <Size>45000</Size>
      </Contents>
    </ListBucketResult>`;
  const parsed = parseGcsListXml(sampleXml, 'jitter-tv/');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 'tvm-1700000001000-cd34');
  assert.equal(parsed[0].name, 'retro-logo.gif');
  assert.equal(parsed[0].kind, 'image');
  assert.equal(parsed[1].id, 'tvm-1700000000000-ab12');
  assert.equal(parsed[1].name, 'rally-clip.mp4');
  assert.equal(parsed[1].kind, 'video');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jitter-medialib-'));
  let port = 0;
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => port });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const uploadRes = await fetch(`${base}/__sync/media?id=tvm-123-abc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'X-Media-Name': encodeURIComponent('demo-clip.mp4'),
        'X-Media-Type': 'video/mp4',
        'X-Media-Kind': 'video',
      },
      body: Buffer.from('fake-mp4-bytes'),
    });
    assert.equal(uploadRes.status, 200);

    const lib = await fetch(`${base}/__sync/media/library`).then((r) => r.json());
    assert.equal(lib.ok, true);
    assert.equal(lib.items.length, 1);
    assert.equal(lib.items[0].id, 'tvm-123-abc');
    assert.equal(lib.items[0].name, 'demo-clip.mp4');
    assert.equal(lib.items[0].kind, 'video');

    // Invalid YouTube URL returns 400 cleanly
    const badYt = await fetch(`${base}/__sync/media/youtube-meta?url=https://example.com/not-yt`);
    assert.equal(badYt.status, 400);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Multi-table setup queues independent matches per table, scores simultaneously, and advances finished table only', async () => {
  const { getTableSlots, getLiveTableMatches } = await import('../src/state/tournamentStore.js');
  const initial = createInitialState({
    playerCount: 8,
    format: 'single',
    rules: { targetPoints: 11, winBy: 2, serveRotation: 2, tableCount: 2 },
  });
  const store = new TournamentStore(initial, { persist: false });

  const m1Id = store.getState().activeMatchId;
  store.startMatch(m1Id, 1);

  // Selecting Table 2 automatically queues a DIFFERENT ready match onto Table 2 (not Table 1's players!)
  const t2Res = store.selectOrQueueTable(2);
  assert.equal(t2Res.ok, true);
  assert.equal(t2Res.queued, true);
  assert.notEqual(t2Res.matchId, m1Id);
  const m2Id = t2Res.matchId;

  store.startMatch(m2Id, 2);

  // Score independently on Table 1 and Table 2 without colliding
  store.addPoint(1, { matchId: m1Id, bypassDebounce: true });
  store.addPoint(1, { matchId: m1Id, bypassDebounce: true });
  store.addPoint(2, { matchId: m2Id, bypassDebounce: true });

  const s = store.getState();
  assert.equal(s.matches[m1Id].score1, 2);
  assert.equal(s.matches[m1Id].tableNumber, 1);
  assert.equal(s.matches[m2Id].score2, 1);
  assert.equal(s.matches[m2Id].tableNumber, 2);

  const slots = getTableSlots(s);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].match.id, m1Id);
  assert.equal(slots[0].isLive, true);
  assert.equal(slots[1].match.id, m2Id);
  assert.equal(slots[1].isLive, true);

  const liveMatches = getLiveTableMatches(s);
  assert.equal(liveMatches.length, 2);
  assert.equal(liveMatches[0].id, m1Id);
  assert.equal(liveMatches[1].id, m2Id);

  // Completing Table 1 queues the next unassigned match onto Table 1 while Table 2 keeps playing untouched
  for (let i = 0; i < 9; i++) {
    store.addPoint(1, { matchId: m1Id, bypassDebounce: true });
  }
  store.completeActiveMatch(m1Id);
  const after = store.getState();
  assert.equal(after.matches[m1Id].completed, true);
  assert.equal(after.matches[m2Id].completed, false);
  assert.equal(after.matches[m2Id].score2, 1);
  assert.equal(after.matches[m2Id].tableNumber, 2);
  const afterSlots = getTableSlots(after);
  assert.notEqual(afterSlots[0].match.id, m1Id);
  assert.notEqual(afterSlots[0].match.id, m2Id);
  assert.equal(afterSlots[0].match.tableNumber, 1);
  assert.equal(afterSlots[1].match.id, m2Id);
});

test('Mid-tournament added players increment setupVersion and survive stale client state pushes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-setup-ver-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const initial = createInitialState({
      tournamentName: 'Roster Stability Cup',
      playerCount: 4,
      access: { isPublic: true, isSecure: false },
    });
    const store = new TournamentStore(initial, { persist: false });
    const staleSnapshot = structuredClone(store.getState());

    // Push initial 4-player state
    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-host', state: staleSnapshot, activate: true }),
    });

    // Host adds 2 players mid-tournament -> increments setupVersion
    const updatedPlayers = [
      ...staleSnapshot.players,
      { id: 'p5', seed: 5, name: 'Late Arrival 1' },
      { id: 'p6', seed: 6, name: 'Late Arrival 2' },
    ];
    store.applyFullSetup({
      playerCount: 6,
      players: updatedPlayers,
      rebuildBracket: false,
    });
    const newerState = store.getState();
    assert.equal(newerState.players.length, 6);
    assert.ok(newerState.setupVersion > staleSnapshot.setupVersion);

    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-host', state: newerState, activate: true }),
    });

    // Another client pushes the older 4-player snapshot -> server rejects overwrite & returns stale:true + 6-player state!
    const staleRes = await (
      await fetch(`${baseUrl}/__sync/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-other', state: staleSnapshot, activate: true }),
      })
    ).json();
    assert.equal(staleRes.stale, true);
    assert.equal(staleRes.state.players.length, 6);

    // Local store also ignores stale incoming external sync
    store.handleExternalSync(staleSnapshot);
    assert.equal(store.getState().players.length, 6);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Switching activeMatchId across different concurrent tables does NOT fire Match Order Changed alerts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-table-alerts-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const initial = createInitialState({
      tournamentName: 'Concurrent Tables Cup',
      playerCount: 8,
      rules: { tableCount: 2 },
      access: { isPublic: true, isSecure: false },
    });
    const store = new TournamentStore(initial, { persist: false });
    const m1Id = store.getState().activeMatchId;
    store.startMatch(m1Id, 1);
    const t2 = store.selectOrQueueTable(2, { setAsActive: false });
    store.startMatch(t2.matchId, 2);

    const stateT1Active = { ...store.getState(), activeMatchId: m1Id };
    const m1 = stateT1Active.matches[m1Id];
    stateT1Active.playerClaims = { 'dev-p1': m1.player1Id };

    // Push initial state with Table 1 active
    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-host', state: stateT1Active, activate: true }),
    });

    // Connect claimed player via SSE
    let receivedSse = '';
    const sseReq = http.get(
      `${baseUrl}/__sync/events?tabId=tab-p1&deviceId=dev-p1&viewMode=spectator&tournamentId=${encodeURIComponent(stateT1Active.tournamentId)}`
    );
    await new Promise((resolve, reject) => {
      sseReq.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          receivedSse += chunk;
          resolve();
        });
      });
      sseReq.on('error', reject);
    });

    // Now switch activeMatchId to Table 2's match -> different tableNumber, so NO "Match Order Changed" alert!
    const stateT2Active = { ...stateT1Active, activeMatchId: t2.matchId };
    await fetch(`${baseUrl}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-host', state: stateT2Active, activate: true }),
    });
    await new Promise((r) => setTimeout(r, 60));
    sseReq.destroy();

    assert.equal(
      receivedSse.includes('Match Order Changed'),
      false,
      'Switching between concurrent tables must not fire Match Order Changed alerts'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Admin Key and Room Join Key endpoints enforce rate-limit lockout (429 Too Many Requests) after repeated failures', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingpong-ratelimit-'));
  const handler = createLanSyncHandler({ rootDir: tmpDir, getPort: () => 0 });
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 4 bad Admin Key attempts return 403; 5th triggers 429 Too Many Requests with Retry-After!
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${baseUrl}/__sync/admin/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-brute-admin', key: 'wrong-key-attempt-here' }),
      });
      assert.equal(r.status, 403);
    }
    const lockedAdmin = await fetch(`${baseUrl}/__sync/admin/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-brute-admin', key: 'wrong-key-attempt-here' }),
    });
    assert.equal(lockedAdmin.status, 429);
    assert.ok(Number(lockedAdmin.headers.get('retry-after')) >= 1);

    // 9 bad Room Join Key attempts return 404; 10th triggers 429 Too Many Requests!
    for (let i = 0; i < 9; i++) {
      const r = await fetch(`${baseUrl}/__sync/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-brute-room', code: 'fake-room-code-guess' }),
      });
      assert.equal(r.status, 404);
    }
    const lockedRoom = await fetch(`${baseUrl}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-brute-room', code: 'fake-room-code-guess' }),
    });
    assert.equal(lockedRoom.status, 429);
    assert.ok(Number(lockedRoom.headers.get('retry-after')) >= 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TV playlist items persist the cacheLocal flag via addTvPlaylistItem and updateTvPlaylistItem', () => {
  const initial = createInitialState();
  const store = new TournamentStore(initial, { persist: false });
  store.addTvPlaylistItem({
    id: 'tv-local-1',
    kind: 'url',
    name: 'Clip',
    url: '/raymond-thanksgiving.mp4',
    cacheLocal: true,
    durationSec: 60,
  });
  let item = store.getState().ui.tvPlaylist.find((x) => x.id === 'tv-local-1');
  assert.equal(item?.cacheLocal, true);

  store.updateTvPlaylistItem('tv-local-1', { cacheLocal: false });
  item = store.getState().ui.tvPlaylist.find((x) => x.id === 'tv-local-1');
  assert.equal(item?.cacheLocal, false);
});

test('assignMatchToTable refuses to replace a live match until paused or cancelled, then allows swapping cleanly', () => {
  const initial = createInitialState({
    playerCount: 8,
    format: 'single',
    rules: { tableCount: 2 },
  });
  const store = new TournamentStore(initial, { persist: false });
  const readyIds = Object.values(store.getState().matches)
    .filter((m) => !m.isBye && m.player1Id && m.player2Id)
    .map((m) => m.id);
  const [m1, m2] = readyIds;

  // Start m1 live on Table 1
  store.startMatch(m1, 1);
  store.addPoint(1, { matchId: m1, bypassDebounce: true });

  // Attempting to swap m1 while live must be refused
  const blocked = store.assignMatchToTable(1, m2);
  assert.equal(blocked.ok, false);
  const blockedClear = store.clearTableMatch(1);
  assert.equal(blockedClear.ok, false);

  // Pausing m1 freezes it and allows changing Table 1 to m2 (or clearing)
  store.pauseMatch(m1);
  assert.equal(store.getState().matches[m1].paused, true);

  const swapped = store.assignMatchToTable(1, m2);
  assert.equal(swapped.ok, true);
  assert.equal(store.getState().matches[m2].tableNumber, 1);
  assert.equal(store.getState().matches[m1].tableNumber, null);

  // Resuming m1 on Table 2 restores it cleanly with its preserved score
  store.resumeMatch(m1, 2);
  assert.equal(store.getState().matches[m1].paused, false);
  assert.equal(store.getState().matches[m1].tableNumber, 2);
  assert.equal(store.getState().matches[m1].score1, 1);
});
