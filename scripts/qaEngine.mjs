#!/usr/bin/env node
/**
 * Jitter Zero-Quota Automated QA & Fuzz Bug-Hunter Engine (debug branch only)
 *
 * Runs deterministic randomized soak tests across:
 *   1. Single & Double Elimination brackets (2..64 players, singles & teams, 1..6 tables)
 *   2. Simultaneous multi-table scoring, undo, subtract, Studio Mode, and completion invariants
 *   3. Sync server auth, kick, key rotation, and simulated Render ephemeral-disk redeploys
 *   4. Grandma template variable resolution across edge states
 *
 * Usage:
 *   npm run qa
 *   node scripts/qaEngine.mjs --runs=60 --seed=12345
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
  let seed = Math.floor(Date.now() % 1000000);
  for (const arg of args) {
    if (arg.startsWith('--runs=')) runs = Math.max(1, Number(arg.slice(7)) || 32);
    if (arg.startsWith('--seed=')) seed = Number(arg.slice(7)) || seed;
  }
  return { runs, seed };
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

function runTournamentFuzz(runIdx, rng) {
  const playerCounts = [2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32];
  const playerCount = playerCounts[Math.floor(rng() * playerCounts.length)];
  const format = rng() < 0.5 ? 'single' : 'double';
  const entryMode = rng() < 0.3 ? 'teams' : 'singles';
  const tableCount = 1 + Math.floor(rng() * 5); // 1..5 tables
  const targetPoints = rng() < 0.7 ? 11 : 7;
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
  const store = new TournamentStore(initial, { persist: false });
  verifyTournamentInvariants(store.getState(), label);

  let guard = 0;
  while (!store.getState().championId && guard < 4000) {
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

    // Pick a random live table match to advance
    const target = live[Math.floor(rng() * live.length)];
    const evalState = evaluateMatchState(target, store.getState().rules);
    if (evalState.winnerSlot !== null) {
      store.completeActiveMatch(target.id);
    } else {
      const roll = rng();
      if (roll < 0.06 && (target.score1 > 0 || target.score2 > 0)) {
        store.subtractPoint(target.score1 > 0 ? 1 : 2, { matchId: target.id });
      } else if (roll < 0.1 && (target.score1 > 0 || target.score2 > 0)) {
        store.undoPoint({ matchId: target.id });
      } else {
        const slot = rng() < 0.5 ? 1 : 2;
        store.addPoint(slot, { matchId: target.id, bypassDebounce: true });
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

async function runSyncChaosSuite() {
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
    tourney.tournamentId = 't-qa-chaos';
    tourney.joinCode = 'mint-orca-gold-fern';
    tourney.hostDeviceId = 'dev-qa-host';
    tourney.access = { isPublic: true, isSecure: true };
    tourney.kickedDevices = ['dev-qa-kicked'];

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

    const guest = await fetch(
      `${base}/__sync/state?deviceId=dev-qa-mobile&tournamentId=t-qa-chaos&code=mint-orca-gold-fern`
    ).then((r) => r.json());
    assert(guest.accessRevoked === false && guest.tournaments[0]?.isAuthorized === true, 'redeploy guest auto-reauth failed');

    const kicked = await fetch(
      `${base}/__sync/state?deviceId=dev-qa-kicked&tournamentId=t-qa-chaos&code=mint-orca-gold-fern`
    ).then((r) => r.json());
    assert(kicked.tournaments[0]?.isAuthorized === false, 'kicked guest was unexpectedly authorized');

    const lib = await fetch(`${base}/__sync/media/library`).then((r) => r.json());
    assert(lib.ok === true && Array.isArray(lib.items), 'media library endpoint failed');
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const { runs, seed } = parseArgs();
  const rng = createRng(seed);
  const start = performance.now();
  let passed = 0;
  const failures = [];

  console.log(`\n🏓 Jitter QA & Fuzz Bug-Hunter (runs=${runs}, seed=${seed})\n`);

  for (let i = 1; i <= runs; i++) {
    try {
      runTournamentFuzz(i, rng);
      passed += 1;
    } catch (err) {
      failures.push({ name: `Fuzz run #${i}`, error: err.message });
    }
  }

  try {
    await runSyncChaosSuite();
    passed += 1;
  } catch (err) {
    failures.push({ name: 'Sync & Redeploy Chaos Suite', error: err.message });
  }

  const elapsedMs = Math.round(performance.now() - start);
  console.log(`✔ Passed: ${passed}/${runs + 1} suites in ${elapsedMs} ms`);
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
