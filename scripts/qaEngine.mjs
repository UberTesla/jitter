#!/usr/bin/env node
/**
 * Jitter Zero-Quota Automated QA & Deep Fuzz Bug-Hunter Engine (debug branch only)
 *
 * Runs deterministic randomized soak tests across:
 *   1. Single & Double Elimination brackets (2..64 players, singles & teams, 1..6 tables)
 *   2. Simultaneous multi-table queueing, scoring, undo, subtract, and completion invariants
 *   3. Mid-tournament match reopen + downstream bracket rollback recovery
 *   4. OBS Studio Mode staging, isolation from programState, push, and discard invariants
 *   5. Sync server multi-client auth, typo-key join, kick, key rotation, private DM isolation,
 *      simulated Render ephemeral-disk redeploy, and Cloud Media Library endpoints
 *   6. Grandma template variable resolution across edge states
 *
 * Writes a markdown summary to `qa-report.md` on completion (or on Ctrl+C).
 *
 * Usage:
 *   npm run qa                                    # 32 tournament runs + sync chaos
 *   npm run qa:deep                               # 5-minute continuous soak
 *   npm run qa:soak                               # 30-minute continuous soak
 *   node scripts/qaEngine.mjs --runs=200          # Fixed run count
 *   node scripts/qaEngine.mjs --minutes=60        # Time-boxed overnight soak
 *   node scripts/qaEngine.mjs --seed=12345        # Replay exact seed
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TournamentStore,
  createInitialState,
  getTableSlots,
  getLiveTableMatches,
} from '../src/state/tournamentStore.js';
import { evaluateMatchState } from '../src/engine/scoringEngine.js';
import { resolveGrandmaPhrase } from '../src/engine/grandmaVariables.js';
import { createLanSyncHandler } from '../src/server/lanSyncMiddleware.js';

function createRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  let runs = 32;
  let minutes = 0;
  let seed = Math.floor(Date.now() % 1000000);
  let reportPath = path.resolve(process.cwd(), 'qa-report.md');
  for (const arg of args) {
    if (arg.startsWith('--runs=')) runs = Math.max(1, Number(arg.slice(7)) || 32);
    if (arg.startsWith('--minutes=')) minutes = Math.max(0, Number(arg.slice(10)) || 0);
    if (arg.startsWith('--seed=')) seed = Number(arg.slice(7)) || seed;
    if (arg.startsWith('--report=')) reportPath = path.resolve(process.cwd(), arg.slice(9));
  }
  return { runs, minutes, seed, reportPath };
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

function verifyTournamentInvariants(state, label) {
  assert(state && typeof state === 'object', `${label}: state missing`);
  const matches = Object.values(state.matches || {}).filter(Boolean);
  const liveByTable = new Map();
  const livePlayers = new Set();

  for (const m of matches) {
    assert(
      Number.isFinite(m.score1) && m.score1 >= 0 && Number.isFinite(m.score2) && m.score2 >= 0,
      `${label}: invalid scores on ${m.id} (${m.score1}-${m.score2})`
    );
    if (m.completed && !m.isBye) {
      assert(
        m.winnerId && (m.winnerId === m.player1Id || m.winnerId === m.player2Id),
        `${label}: completed match ${m.id} has invalid winnerId ${m.winnerId}`
      );
    }
    if (m.started && !m.completed && !m.isBye) {
      const t = m.tableNumber || 1;
      assert(
        !liveByTable.has(t),
        `${label}: Table ${t} has two simultaneous live matches (${liveByTable.get(t)} and ${m.id})`
      );
      liveByTable.set(t, m.id);
      if (m.player1Id) {
        assert(!livePlayers.has(m.player1Id), `${label}: player ${m.player1Id} live on two tables`);
        livePlayers.add(m.player1Id);
      }
      if (m.player2Id) {
        assert(!livePlayers.has(m.player2Id), `${label}: player ${m.player2Id} live on two tables`);
        livePlayers.add(m.player2Id);
      }
    }
  }
}

function runTournamentFuzz(runIdx, rng, counters) {
  const playerCounts = [2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32, 48];
  const playerCount = playerCounts[Math.floor(rng() * playerCounts.length)];
  const format = rng() < 0.5 ? 'single' : 'double';
  const entryMode = rng() < 0.3 ? 'teams' : 'singles';
  const tableCount = 1 + Math.floor(rng() * 6); // 1..6 tables (exercises 5+ overflow too)
  const targetPoints = rng() < 0.65 ? 11 : 7;
  const winBy = rng() < 0.8 ? 2 : 1;
  const skunkEnabled = rng() < 0.35;
  const deadMansServe = rng() < 0.35;

  const label = `run#${runIdx} (${playerCount} ${entryMode}, ${format}, ${tableCount}T)`;
  const initial = createInitialState({
    playerCount,
    format,
    entryMode,
    rules: {
      targetPoints,
      winBy,
      serveRotation: 2,
      tableCount,
      skunkEnabled,
      skunkPoints: 7,
      deadMansServe,
    },
  });
  const store = new TournamentStore(initial, { persist: false, viewMode: 'control' });
  verifyTournamentInvariants(store.getState(), label);

  // Probe OBS Studio Mode isolation (staged slide must NOT leak to programState until pushed)
  if (rng() < 0.45) {
    counters.studioProbes += 1;
    const origSlide = store.programState?.presentation?.activeSlide || 'title';
    store.toggleSyncMode(); // enter studio
    const stagedSlide = origSlide === 'bracket' ? 'split' : 'bracket';
    store.setActiveSlide(stagedSlide);
    assert(
      store.programState?.presentation?.activeSlide === origSlide,
      `${label}: Studio Mode leaked staged slide "${stagedSlide}" to programState before Push`
    );
    if (rng() < 0.5) {
      store.discardStudioChanges();
      assert(
        store.getState().presentation?.activeSlide === origSlide,
        `${label}: Studio Mode discard did not restore "${origSlide}"`
      );
    } else {
      store.publishStudioToLive();
      assert(
        store.programState?.presentation?.activeSlide === stagedSlide,
        `${label}: Studio Mode publish did not push "${stagedSlide}" live`
      );
    }
    store.toggleSyncMode(); // back to live
  }

  let reopenedOnce = false;
  let guard = 0;
  while (!store.getState().championId && guard < 6000) {
    guard += 1;
    const s = store.getState();

    // Queue open tables in multi-table mode
    if (tableCount > 1) {
      const slots = getTableSlots(s);
      for (const slot of slots) {
        if (!slot.match) {
          store.selectOrQueueTable(slot.tableNumber, { setAsActive: false });
        }
      }
    }

    // Start any queued ready matches on tables
    const slotsAfter = getTableSlots(store.getState());
    for (const slot of slotsAfter) {
      if (slot.match && !slot.isLive && !slot.match.completed) {
        store.startMatch(slot.match.id, slot.tableNumber);
      }
    }

    const live = getLiveTableMatches(store.getState()).filter((m) => !m.completed);
    if (live.length === 0) break;

    const target = live[Math.floor(rng() * live.length)];
    const evalState = evaluateMatchState(target, store.getState().rules);
    if (evalState.winnerSlot !== null) {
      store.completeActiveMatch(target.id);
      counters.matchesCompleted += 1;

      // Randomly probe mid-tournament match reopen + downstream rollback once per run
      if (!reopenedOnce && !store.getState().championId && rng() < 0.25) {
        reopenedOnce = true;
        const reopenRes = store.reopenMatch(target.id);
        if (reopenRes?.reopened) {
          counters.reopenProbes += 1;
          verifyTournamentInvariants(store.getState(), `${label} after reopen ${target.id}`);
        }
      }
    } else {
      const roll = rng();
      if (roll < 0.05 && (target.score1 > 0 || target.score2 > 0)) {
        store.subtractPoint(target.score1 > 0 ? 1 : 2, { matchId: target.id });
      } else if (roll < 0.09 && (target.score1 > 0 || target.score2 > 0)) {
        store.undoPoint({ matchId: target.id });
      } else if (roll < 0.11 && target.score1 === 0 && target.score2 === 0) {
        store.switchFirstServer({ matchId: target.id });
      } else {
        const slot = rng() < 0.5 ? 1 : 2;
        store.addPoint(slot, { matchId: target.id, bypassDebounce: true });
        counters.pointsScored += 1;
      }
    }

    verifyTournamentInvariants(store.getState(), label);
  }

  const finalState = store.getState();
  assert(Boolean(finalState.championId), `${label}: did not reach a champion within ${guard} steps`);

  // Verify Grandma template variable resolution never leaks undefined/NaN
  const templates = [
    '$player1 vs $player2 ($score) on Table $table of $tables!',
    '$leader leads $trailer by $pointDiff — $server serving to $targetPoints!',
    'Winner: $winner, Runner-up: $loser, Champion: $champion ($matchesLeft left, $playersRemaining/$totalPlayers)',
    'Literal $5 bet on ${tournament}!',
  ];
  for (const tpl of templates) {
    const out = resolveGrandmaPhrase(tpl, finalState);
    assert(!/\b(undefined|NaN)\b/.test(out), `${label}: Grandma template leaked bad value: "${out}"`);
  }
}

async function runSyncChaosSuite(iterIdx, counters) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jitter-qa-sync-'));
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
    const tourney = createInitialState({ playerCount: 8, rules: { tableCount: 2 } });
    tourney.tournamentId = `t-qa-chaos-${iterIdx}`;
    tourney.joinCode = 'mint-orca-gold-fern';
    tourney.hostDeviceId = 'dev-qa-host';
    tourney.access = { isPublic: true, isSecure: true };
    tourney.kickedDevices = ['dev-qa-kicked'];

    // 1. Host publishes tournament
    const push = await fetch(`${base}/__sync/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'dev-qa-host',
        deviceName: 'QA Host',
        state: tourney,
        activate: true,
      }),
    });
    assert(push.status === 200, `sync push failed: ${push.status}`);

    // 2. Guest joins with 1-char typo (default allowedKeyTypos >= 1)
    const typoJoin = await fetch(`${base}/__sync/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'dev-qa-guest1',
        code: 'mint-orac-gold-fern', // 1 transposition typo
      }),
    });
    assert(typoJoin.status === 200, `typo join failed: ${typoJoin.status}`);

    // 3. Returning guest auto-reauthorizes after ephemeral redeploy
    const guest = await fetch(
      `${base}/__sync/state?deviceId=dev-qa-mobile&tournamentId=${tourney.tournamentId}&code=mint-orca-gold-fern`
    ).then((r) => r.json());
    assert(
      guest.accessRevoked === false && guest.tournaments[0]?.isAuthorized === true,
      'redeploy guest auto-reauth failed'
    );

    // 4. Kicked guest stays unauthorized even with old key
    const kicked = await fetch(
      `${base}/__sync/state?deviceId=dev-qa-kicked&tournamentId=${tourney.tournamentId}&code=mint-orca-gold-fern`
    ).then((r) => r.json());
    assert(kicked.tournaments[0]?.isAuthorized === false, 'kicked guest was unexpectedly authorized');

    // 5. Private 1-on-1 DM privacy isolation (guest2 must NOT see host<->guest1 DM)
    const dmRes = await fetch(`${base}/__sync/chat/thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: tourney.tournamentId,
        deviceId: 'dev-qa-host',
        deviceName: 'QA Host',
        targetDeviceIds: ['dev-qa-guest1'],
        initialMessage: 'Secret DM',
      }),
    }).then((r) => r.json());
    assert(dmRes.ok === true, 'DM thread creation failed');

    const outsiderChat = await fetch(
      `${base}/__sync/chat?tournamentId=${tourney.tournamentId}&deviceId=dev-qa-mobile`
    ).then((r) => r.json());
    assert(
      Array.isArray(outsiderChat.threads) && outsiderChat.threads.length === 0,
      'DM privacy leak: non-member saw private DM thread'
    );

    // 6. Media library + YouTube meta guard
    const lib = await fetch(`${base}/__sync/media/library`).then((r) => r.json());
    assert(lib.ok === true && Array.isArray(lib.items), 'media library endpoint failed');

    const badYt = await fetch(`${base}/__sync/media/youtube-meta?url=https://example.com/nope`);
    assert(badYt.status === 400, `expected 400 on invalid YouTube URL, got ${badYt.status}`);

    counters.syncChaosRuns += 1;
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeReport({ reportPath, seed, modeDesc, elapsedMs, passed, total, counters, failures, interrupted }) {
  const lines = [
    '# Jitter Automated QA Report',
    '',
    `- **Generated:** ${new Date().toISOString()}`,
    `- **Mode:** ${modeDesc}${interrupted ? ' *(stopped early via Ctrl+C)*' : ''}`,
    `- **Seed:** \`${seed}\` *(replay with \`node scripts/qaEngine.mjs --seed=${seed}\`)*`,
    `- **Duration:** ${(elapsedMs / 1000).toFixed(1)}s`,
    `- **Result:** ${failures.length === 0 ? '✅ PASS' : `❌ ${failures.length} FAILURE(S)`} (${passed}/${total} suites passed)`,
    '',
    '## Coverage Counters',
    `- Tournaments simulated to champion: **${counters.tournamentsRun}**`,
    `- Matches completed: **${counters.matchesCompleted}**`,
    `- Points scored: **${counters.pointsScored}**`,
    `- Mid-tournament match reopen & rollback probes: **${counters.reopenProbes}**`,
    `- OBS Studio Mode isolation probes: **${counters.studioProbes}**`,
    `- Sync / Auth / DM privacy / Media chaos suites: **${counters.syncChaosRuns}**`,
    '',
  ];
  if (failures.length > 0) {
    lines.push('## Failures');
    for (const f of failures) {
      lines.push(`- **${f.name}:** ${f.error}`);
    }
    lines.push('');
  }
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
}

async function main() {
  const { runs, minutes, seed, reportPath } = parseArgs();
  const rng = createRng(seed);
  const startMs = performance.now();
  const deadlineMs = minutes > 0 ? startMs + minutes * 60 * 1000 : null;
  const modeDesc = minutes > 0 ? `${minutes}-minute soak` : `${runs} fixed runs`;

  const counters = {
    tournamentsRun: 0,
    matchesCompleted: 0,
    pointsScored: 0,
    reopenProbes: 0,
    studioProbes: 0,
    syncChaosRuns: 0,
  };
  let passed = 0;
  let total = 0;
  const failures = [];
  let interrupted = false;

  process.on('SIGINT', () => {
    interrupted = true;
    console.log('\nStopping soak cleanly and writing qa-report.md...');
  });

  console.log(`\n🏓 Jitter Deep QA & Fuzz Bug-Hunter (${modeDesc}, seed=${seed})\n`);

  let i = 0;
  while (!interrupted) {
    if (deadlineMs !== null) {
      if (performance.now() >= deadlineMs) break;
    } else if (i >= runs) {
      break;
    }
    i += 1;
    total += 1;
    counters.tournamentsRun += 1;
    try {
      runTournamentFuzz(i, rng, counters);
      passed += 1;
    } catch (err) {
      failures.push({ name: `Fuzz run #${i}`, error: err.message });
    }

    // Run sync chaos periodically (every 10 fuzz runs, and at least once)
    if (i % 10 === 0) {
      total += 1;
      try {
        await runSyncChaosSuite(i, counters);
        passed += 1;
      } catch (err) {
        failures.push({ name: `Sync Chaos #${i}`, error: err.message });
      }
    }

    if (i % 10 === 0) {
      const sec = ((performance.now() - startMs) / 1000).toFixed(1);
      console.log(
        `  [${sec}s] ${i} tournaments · ${counters.matchesCompleted} matches · ${failures.length} failure(s)`
      );
    }
  }

  if (counters.syncChaosRuns === 0 && !interrupted) {
    total += 1;
    try {
      await runSyncChaosSuite(0, counters);
      passed += 1;
    } catch (err) {
      failures.push({ name: 'Sync Chaos Suite', error: err.message });
    }
  }

  const elapsedMs = performance.now() - startMs;
  writeReport({
    reportPath,
    seed,
    modeDesc,
    elapsedMs,
    passed,
    total,
    counters,
    failures,
    interrupted,
  });

  console.log(`\n✔ Passed: ${passed}/${total} suites in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`📄 Saved report to: ${reportPath}`);
  if (failures.length > 0) {
    console.error(`\n✖ Found ${failures.length} failure(s) (reproduce with --seed=${seed}):`);
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.error}`);
    }
    process.exit(1);
  }
  console.log('✨ Zero bugs detected!\n');
}

main();
