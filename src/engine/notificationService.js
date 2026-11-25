/**
 * Browser / Device / Desktop Notification Framework
 *
 * Provides:
 * - Capability & secure-context detection (Web Notifications API works on HTTPS & localhost;
 *   on plain HTTP LAN devices, gracefully falls back to in-app toast + optional Web Audio chime).
 * - Per-tournament local preference persistence (claimed player, event toggles, sound).
 * - Pure `detectNotificationEvents(prevState, nextState, prefs)` state-diff engine.
 * - `dispatchNotification(event, prefs)` for OS desktop notifications + audio chime.
 */

import { computeTournamentStats } from './bracketGenerator.js';

const PREFS_STORAGE_PREFIX = 'pp_notify_prefs_v1:';

export const DEFAULT_NOTIFICATION_PREFS = Object.freeze({
  enabled: false,
  desktopEnabled: true,
  soundEnabled: true,
  claimedPlayerId: null,
  notifyOnDeck: true,
  notifyMatchStart: true,
  notifyMatchResult: true,
  notifyAllMatches: false,
});

let swRegistrationPromise = null;

/**
 * Registers the minimal `/sw.js` Service Worker required by Android Chrome
 * for `registration.showNotification()`. Safe no-op on insecure HTTP or unsupported browsers.
 */
export function registerNotificationServiceWorker() {
  if (
    typeof window === 'undefined' ||
    !window.isSecureContext ||
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator)
  ) {
    return Promise.resolve(null);
  }
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(() => null);
  }
  return swRegistrationPromise;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

/**
 * Subscribes this device's Service Worker to Web Push (VAPID) and registers
 * the subscription with the sync server so notifications arrive even when
 * the phone is locked or the browser tab is closed (requires HTTPS).
 */
export async function subscribeToWebPush(baseUrl, deviceId) {
  if (!baseUrl || !deviceId) return { ok: false, reason: 'missing_params' };
  const caps = getNotificationCapabilities();
  if (!caps.canUseDesktop || caps.permission !== 'granted') {
    return { ok: false, reason: 'permission_required' };
  }
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return { ok: false, reason: 'no_sw' };
  }
  try {
    const reg = (await registerNotificationServiceWorker()) || (await navigator.serviceWorker.ready);
    if (!reg?.pushManager) return { ok: false, reason: 'no_push_manager' };

    const keyRes = await fetch(`${baseUrl}/__sync/push/vapid-key`);
    const keyData = await keyRes.json().catch(() => ({}));
    if (!keyRes.ok || !keyData?.publicKey) {
      return { ok: false, reason: 'no_vapid_key' };
    }

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
      });
    }

    const subJson = typeof sub.toJSON === 'function' ? sub.toJSON() : sub;
    const saveRes = await fetch(`${baseUrl}/__sync/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, subscription: subJson }),
    });
    return { ok: saveRes.ok };
  } catch (err) {
    return { ok: false, reason: err?.message || 'subscribe_failed' };
  }
}

export function getNotificationCapabilities() {
  const hasWindow = typeof window !== 'undefined';
  const isSupported = hasWindow && 'Notification' in window;
  const isSecureContext = hasWindow ? Boolean(window.isSecureContext) : false;
  const permission = isSupported ? window.Notification.permission : 'unsupported';
  return {
    isSupported,
    isSecureContext,
    canUseDesktop: isSupported && isSecureContext,
    permission,
  };
}

export async function requestDesktopPermission() {
  const caps = getNotificationCapabilities();
  if (!caps.canUseDesktop) {
    return caps.isSupported && !caps.isSecureContext ? 'insecure_context' : 'unsupported';
  }
  if (caps.permission === 'granted' || caps.permission === 'denied') {
    return caps.permission;
  }
  try {
    return await window.Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function loadNotificationPrefs(tournamentId = 't-default') {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
  try {
    const raw = window.localStorage.getItem(`${PREFS_STORAGE_PREFIX}${tournamentId}`);
    if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_NOTIFICATION_PREFS,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
    };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

export function saveNotificationPrefs(tournamentId = 't-default', prefs = {}) {
  const merged = { ...DEFAULT_NOTIFICATION_PREFS, ...prefs };
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(`${PREFS_STORAGE_PREFIX}${tournamentId}`, JSON.stringify(merged));
    } catch {
      // Ignore quota / private-mode storage errors
    }
  }
  return merged;
}

/**
 * Plays a short, pleasant two-tone Web Audio chime (no external audio files required).
 */
export function playNotificationChime() {
  if (typeof window === 'undefined') return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  try {
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes = [660, 880];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.11);
      gain.gain.setValueAtTime(0.001, now + idx * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.11 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.11 + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.11);
      osc.stop(now + idx * 0.11 + 0.2);
    });
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch {
    // Ignore autoplay restrictions before user gesture
  }
}

function getPlayerName(state, playerId, fallback = 'TBD') {
  if (!playerId) return fallback;
  return state?.players?.find((p) => p.id === playerId)?.name || fallback;
}

function matchHasPlayer(match, playerId) {
  if (!match || !playerId) return false;
  return match.player1Id === playerId || match.player2Id === playerId;
}

/**
 * Pure state-diff detector: compares `prevState` and `nextState` and returns
 * an array of notification events `{ id, type, title, body, tag, matchId }`
 * matching the user's preferences and claimed player.
 */
export function detectNotificationEvents(prevState, nextState, prefs = DEFAULT_NOTIFICATION_PREFS) {
  if (!prevState || !nextState || !prefs?.enabled) return [];
  const claimedId = prefs.claimedPlayerId || null;
  const watchAll = Boolean(prefs.notifyAllMatches);
  if (!claimedId && !watchAll) return [];

  const events = [];
  const prevMatches = prevState.matches || {};
  const nextMatches = nextState.matches || {};

  // 1. Match started
  if (prefs.notifyMatchStart) {
    for (const [id, nextM] of Object.entries(nextMatches)) {
      const prevM = prevMatches[id];
      if (!nextM || nextM.isBye || nextM.completed) continue;
      if (!prevM || prevM.started || !nextM.started) continue;
      if (!watchAll && !matchHasPlayer(nextM, claimedId)) continue;

      const p1 = getPlayerName(nextState, nextM.player1Id);
      const p2 = getPlayerName(nextState, nextM.player2Id);
      const tableStr = nextM.tableNumber ? ` on Table ${nextM.tableNumber}` : '';
      events.push({
        id: `start:${id}:${nextM.startedAt || ''}`,
        type: 'match_starting',
        matchId: id,
        tag: `pp-start-${id}`,
        title: claimedId && matchHasPlayer(nextM, claimedId) ? '🏓 Your Match Is Starting!' : `🏓 ${nextM.label} Started`,
        body: `${p1} vs ${p2}${tableStr}`,
      });
    }
  }

  // 2. Match completed
  if (prefs.notifyMatchResult) {
    for (const [id, nextM] of Object.entries(nextMatches)) {
      const prevM = prevMatches[id];
      if (!nextM || nextM.isBye || !nextM.completed) continue;
      if (!prevM || prevM.completed) continue;
      if (!watchAll && !matchHasPlayer(nextM, claimedId)) continue;

      const winnerName = getPlayerName(nextState, nextM.winnerId, 'Winner');
      const p1 = getPlayerName(nextState, nextM.player1Id);
      const p2 = getPlayerName(nextState, nextM.player2Id);
      const isClaimedWin = claimedId && nextM.winnerId === claimedId;
      events.push({
        id: `result:${id}:${nextM.completedAt || ''}`,
        type: 'match_result',
        matchId: id,
        tag: `pp-result-${id}`,
        title: isClaimedWin
          ? '🏆 You Won Your Match!'
          : claimedId && matchHasPlayer(nextM, claimedId)
          ? `Match Complete (${nextM.label})`
          : `Final: ${nextM.label}`,
        body: `${winnerName} wins — ${p1} ${nextM.score1}–${nextM.score2} ${p2}`,
      });
    }
  }

  // 3. On Deck (next up in queue)
  if (prefs.notifyOnDeck) {
    const prevUpNext = computeTournamentStats(prevState).upNext.slice(0, 2);
    const nextUpNext = computeTournamentStats(nextState).upNext.slice(0, 2);
    const prevUpIds = new Set(prevUpNext.map((m) => m.id));

    for (const m of nextUpNext) {
      if (prevUpIds.has(m.id)) continue;
      if (!watchAll && !matchHasPlayer(m, claimedId)) continue;
      const p1 = getPlayerName(nextState, m.player1Id, m.source1Label || 'TBD');
      const p2 = getPlayerName(nextState, m.player2Id, m.source2Label || 'TBD');
      events.push({
        id: `ondeck:${m.id}`,
        type: 'on_deck',
        matchId: m.id,
        tag: `pp-ondeck-${m.id}`,
        title: claimedId && matchHasPlayer(m, claimedId) ? '📣 You Are On Deck!' : `📣 On Deck: ${m.label}`,
        body: `${p1} vs ${p2} — get ready!`,
      });
    }
  }

  return events;
}

/**
 * Dispatches a notification event to the OS/browser (when permitted & enabled)
 * and plays the optional audio chime. Returns `{ desktopSent, event }`.
 */
export function dispatchNotification(event, prefs = DEFAULT_NOTIFICATION_PREFS) {
  if (!event) return { desktopSent: false, event: null };
  let desktopSent = false;

  if (prefs.soundEnabled) {
    playNotificationChime();
  }

  // Haptic alert on mobile devices (Android)
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([160, 80, 160]);
    } catch {
      // Ignore vibrate restrictions
    }
  }

  const caps = getNotificationCapabilities();
  if (prefs.desktopEnabled && caps.canUseDesktop && caps.permission === 'granted') {
    const notifOptions = {
      body: event.body,
      tag: event.tag || `${event.id || Date.now()}`,
      vibrate: [160, 80, 160],
    };

    // Try direct Notification constructor first (instant on desktop Chrome/Edge/Firefox).
    // On Android Chrome, `new Notification()` throws Illegal constructor — fall back to
    // ServiceWorkerRegistration.showNotification() which Android Chrome requires.
    try {
      const n = new window.Notification(event.title, notifOptions);
      n.onclick = () => {
        if (typeof window !== 'undefined' && typeof window.focus === 'function') {
          window.focus();
        }
        n.close();
      };
      desktopSent = true;
    } catch {
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        registerNotificationServiceWorker()
          .then((reg) => reg || navigator.serviceWorker.ready)
          .then((reg) => reg?.showNotification?.(event.title, notifOptions))
          .catch(() => {});
        desktopSent = true;
      }
    }
  }

  return { desktopSent, event };
}
