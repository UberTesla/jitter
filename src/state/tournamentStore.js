/**
 * Zero-Friction Tournament Store with localStorage Persistence, Cross-Tab Sync,
 * OBS-Style Studio / Live Mode, Multi-Scorekeeper Debounce Filter,
 * and Categorized Grandma Commentary (Idle Banter, Random Contextual, Always Game Point).
 */

import {
  clampPlayerCount,
  createPlayers,
  generateBracket,
  completeMatchAndAdvance,
  reopenCompletedMatch,
  editCompletedMatchScore,
  addEntrantsPreservingBracket,
  findNextReadyMatchId,
  getChampionshipMatchId,
  resolveClaimedPlayer,
} from '../engine/bracketGenerator.js';
import {
  adjustMatchScore,
  evaluateMatchState,
  MATCH_STATUS,
  undoLastPoint,
  toggleInitialServer,
} from '../engine/scoringEngine.js';
import { resolveGrandmaPhrase } from '../engine/grandmaVariables.js';
import { dispatchNotification } from '../engine/notificationService.js';

const INBOX_STORAGE_KEY = 'pp_championship_inbox_v1';

function loadInboxMessages() {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(INBOX_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
  } catch {
    return [];
  }
}

function saveInboxMessages(list) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(INBOX_STORAGE_KEY, JSON.stringify((list || []).slice(0, 50)));
  } catch {
    // Ignore storage quota errors
  }
}
import {
  generateFourWordId,
  matchTournamentJoinKey,
  normalizeFourWordId,
  resolveTournamentJoinCode,
} from '../engine/tournamentId.js';
import {
  ROLES,
  ROLE_LEVEL,
  ROLE_META,
  ROLE_ORDER,
  canAssignRole,
  canAssignTabRole,
  canDisconnectRole,
  getAssignableRoles,
  getRolePermissions,
  isHubAdminDevice,
  isPreviousTournamentHost,
  normalizeRole,
  resolveDeviceRole,
  resolveEffectiveRole,
} from '../engine/roles.js';

export {
  ROLES,
  ROLE_LEVEL,
  ROLE_META,
  ROLE_ORDER,
  canAssignRole,
  canAssignTabRole,
  canDisconnectRole,
  getAssignableRoles,
  getRolePermissions,
  isHubAdminDevice,
  isPreviousTournamentHost,
  normalizeRole,
  resolveDeviceRole,
  resolveEffectiveRole,
};

export const STORAGE_KEY = 'pingpong-championship-state-v4';
export const TOURNAMENT_LIBRARY_KEY = 'pingpong-tournaments-library-v1';
export const STUDIO_STORAGE_KEY = 'pingpong-championship-studio-v1';
export const LAST_POINT_STORAGE_KEY = 'pingpong-last-point-at-v1';
export const SYNC_SERVER_URL_KEY = 'pingpong-sync-server-url-v1';
export const DEVICE_ID_KEY = 'pingpong-device-id-v1';
export const DEVICE_NAME_KEY = 'pingpong-device-name-v1';
export const DEVICE_NAME_CUSTOM_KEY = 'pingpong-device-name-custom-v1';
export const GUEST_KEYS_STORAGE_KEY = 'pingpong-guest-unlocked-keys-v1';
export const SESSION_PICKED_STORAGE_KEY = 'pingpong-tournament-picked-v1';
export const SESSION_TAB_ID_STORAGE_KEY = 'pingpong-tab-id-v1';
export const LAST_SERVER_BOOT_ID_KEY = 'pingpong-last-server-boot-id-v1';
export const DISCONNECTED_STORAGE_KEY = 'pingpong-disconnected-v1';

function readDisconnectedNotice() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(DISCONNECTED_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeDisconnectedNotice(notice) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (notice) {
      localStorage.setItem(DISCONNECTED_STORAGE_KEY, JSON.stringify(notice));
    } else {
      localStorage.removeItem(DISCONNECTED_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

function readUnlockedGuestKeys() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(GUEST_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveUnlockedGuestKey(tournamentId, joinCode) {
  if (!tournamentId || !joinCode) return readUnlockedGuestKeys();
  const map = readUnlockedGuestKeys();
  map[tournamentId] = normalizeFourWordId(joinCode);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(GUEST_KEYS_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // Ignore storage errors
  }
  return map;
}

function removeUnlockedGuestKey(tournamentId) {
  const map = readUnlockedGuestKeys();
  if (!tournamentId || !Object.prototype.hasOwnProperty.call(map, tournamentId)) {
    return map;
  }
  delete map[tournamentId];
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(GUEST_KEYS_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // Ignore storage errors
  }
  return map;
}
export const SYNC_CHANNEL_NAME = 'pingpong-championship-sync-v4';
export const STUDIO_SCORE_DELAY_MS = 3000;

function generateTournamentId(existingIds = null) {
  return generateFourWordId(existingIds);
}

export function canDeviceAccessHostControls(stateObj, remoteSync) {
  const role = resolveEffectiveRole(stateObj, remoteSync?.deviceId || '', '', {
    adminDeviceIds: remoteSync?.admins || [],
  });
  return getRolePermissions(role).canManageAccessSettings;
}

/**
 * Pure helper ensuring Cloud and Local tournament lists NEVER duplicate on the selection screen.
 * Any local tournament whose `id` or 4-word `joinCode` already exists in Cloud is excluded
 * from `localOnly`, and flagged in `backedUpCloudIds` so Cloud cards can indicate offline backup.
 */
export function deduplicateTournamentLists(cloudTournaments = [], localTournaments = []) {
  const cloudIdSet = new Set();
  const cloudCodeSet = new Set();
  for (const ct of cloudTournaments || []) {
    if (!ct) continue;
    if (ct.id) cloudIdSet.add(ct.id);
    const code = normalizeFourWordId(ct.joinCode || ct.id);
    if (code) cloudCodeSet.add(code);
  }

  const seenLocalIds = new Set();
  const seenLocalCodes = new Set();
  const localOnly = [];
  const backedUpCloudIds = new Set();
  const backedUpCloudCodes = new Set();

  for (const lt of localTournaments || []) {
    if (!lt) continue;
    const code = normalizeFourWordId(lt.joinCode || lt.id);
    const inCloud = (lt.id && cloudIdSet.has(lt.id)) || (code && cloudCodeSet.has(code));
    if (inCloud) {
      if (lt.id) backedUpCloudIds.add(lt.id);
      if (code) backedUpCloudCodes.add(code);
      continue;
    }
    if ((lt.id && seenLocalIds.has(lt.id)) || (code && seenLocalCodes.has(code))) {
      continue;
    }
    if (lt.id) seenLocalIds.add(lt.id);
    if (code) seenLocalCodes.add(code);
    localOnly.push(lt);
  }

  return { localOnly, backedUpCloudIds, backedUpCloudCodes };
}

function detectBrowserInfo(ua = '') {
  if (!ua) return { name: 'Browser', version: '', label: 'Browser' };
  const rules = [
    { name: 'Edge', re: /Edg(?:A|iOS)?\/([\d.]+)/i },
    { name: 'Opera', re: /(?:OPR|Opera)\/([\d.]+)/i },
    { name: 'Samsung Internet', re: /SamsungBrowser\/([\d.]+)/i },
    { name: 'Silk', re: /Silk\/([\d.]+)/i },
    { name: 'Firefox', re: /(?:Firefox|FxiOS)\/([\d.]+)/i },
    { name: 'Chrome', re: /(?:Chrome|CriOS)\/([\d.]+)/i },
    { name: 'Safari', re: /Version\/([\d.]+).*Safari/i },
  ];
  for (const r of rules) {
    const m = ua.match(r.re);
    if (m) {
      const major = (m[1] || '').split('.')[0] || '';
      return { name: r.name, version: m[1] || '', label: major ? `${r.name} ${major}` : r.name };
    }
  }
  if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return { name: 'Safari', version: '', label: 'Safari' };
  return { name: 'Browser', version: '', label: 'Browser' };
}

function detectDeviceLabel(ua = '', modelHint = '') {
  const cleanModel = String(modelHint || '').trim();
  if (cleanModel && cleanModel.toUpperCase() !== 'K') return cleanModel;
  const androidModelMatch = ua.match(/Android\s+[^;)]+;\s*([^;)]+?)\s+Build\//i);
  if (androidModelMatch?.[1]) {
    const model = androidModelMatch[1].trim();
    if (model && model.toUpperCase() !== 'K') return model;
  }
  if (/AFT[A-Z0-9]+|FireTV|Silk/i.test(ua)) return 'Fire TV';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)) {
    return 'iPad';
  }
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android Phone' : 'Android Tablet';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Device';
}

function detectFallbackDeviceName(modelHint = '') {
  if (typeof navigator === 'undefined') return 'Browser Device';
  const ua = navigator.userAgent || '';
  const device = detectDeviceLabel(ua, modelHint);
  const browser = detectBrowserInfo(ua);
  return `${device} · ${browser.name}`;
}

function collectClientEnvironmentSync(modelHint = '', hostname = '') {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  const device = detectDeviceLabel(ua, modelHint);
  const browser = detectBrowserInfo(ua);
  const scr = typeof window !== 'undefined' && window.screen ? window.screen : null;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  let timezone = '';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    // Ignore
  }
  let standalone = false;
  let colorScheme = '';
  let reducedMotion = false;
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        Boolean(navigator.standalone);
      colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
  } catch {
    // Ignore
  }

  return {
    device,
    browser: browser.label,
    browserName: browser.name,
    deviceBrowser: `${device} · ${browser.name}`,
    platform: navigator.userAgentData?.platform || navigator.platform || '',
    mobile:
      navigator.userAgentData?.mobile !== undefined
        ? Boolean(navigator.userAgentData.mobile)
        : /Mobi|Android|iPhone/i.test(ua),
    screen: scr ? `${scr.width}×${scr.height}` : '',
    viewport: typeof window !== 'undefined' ? `${window.innerWidth}×${window.innerHeight}` : '',
    dpr: typeof window !== 'undefined' && window.devicePixelRatio ? Number(window.devicePixelRatio.toFixed(2)) : 1,
    touchPoints: typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0,
    language: navigator.language || '',
    languages: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 5).join(', ') : '',
    timezone,
    connection: conn?.effectiveType || '',
    downlinkMbps: typeof conn?.downlink === 'number' ? conn.downlink : null,
    saveData: Boolean(conn?.saveData),
    cores: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    memoryGb: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
    standalone,
    online: navigator.onLine !== false,
    colorScheme,
    reducedMotion,
    ...(hostname ? { hostname } : {}),
    userAgent: ua.slice(0, 320),
  };
}

async function collectClientEnvironmentHighEntropy(baseEnv = null) {
  const base = baseEnv || collectClientEnvironmentSync();
  if (!base || typeof navigator === 'undefined') return base;
  const enriched = { ...base };
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const hints = await navigator.userAgentData.getHighEntropyValues([
        'model',
        'platform',
        'platformVersion',
        'architecture',
        'bitness',
        'fullVersionList',
      ]);
      const model = String(hints?.model || '').trim();
      if (model) {
        enriched.model = model;
        enriched.device = detectDeviceLabel(navigator.userAgent || '', model);
        enriched.deviceBrowser = `${enriched.device} · ${enriched.browserName || 'Browser'}`;
      }
      if (hints?.platform) {
        enriched.platform = hints.platformVersion
          ? `${hints.platform} ${hints.platformVersion}`
          : hints.platform;
      }
      if (hints?.architecture) {
        enriched.architecture = hints.bitness
          ? `${hints.architecture} (${hints.bitness}-bit)`
          : hints.architecture;
      }
    }
  } catch {
    // Ignore unsupported client hints
  }
  return enriched;
}

function getOrCreateDeviceIdentity() {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return { deviceId: 'dev-node', deviceName: 'Node Test', isCustom: false };
  }
  let deviceId = '';
  let deviceName = '';
  let isCustom = false;
  try {
    deviceId = localStorage.getItem(DEVICE_ID_KEY) || '';
    if (!deviceId) {
      deviceId = `dev-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
    isCustom = localStorage.getItem(DEVICE_NAME_CUSTOM_KEY) === '1';
    deviceName = localStorage.getItem(DEVICE_NAME_KEY) || '';
    if (!deviceName) {
      deviceName = detectFallbackDeviceName();
      localStorage.setItem(DEVICE_NAME_KEY, deviceName);
    }
  } catch {
    deviceId = deviceId || `dev-${Math.random().toString(36).slice(2, 8)}`;
    deviceName = deviceName || detectFallbackDeviceName();
  }
  return { deviceId, deviceName, isCustom };
}

export function resolveSyncServerBaseUrl() {
  if (typeof window === 'undefined') return '';
  try {
    const saved = String(localStorage.getItem(SYNC_SERVER_URL_KEY) || '').trim();
    if (saved) return saved.replace(/\/+$/, '');
  } catch {
    // Ignore storage errors
  }
  return window.location.origin.replace(/\/+$/, '');
}

function detectInitialViewMode() {
  if (typeof window === 'undefined') return 'control';
  const path = window.location.pathname.toLowerCase();
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get('view');
  if (path.startsWith('/present') || viewParam === 'present') return 'present';
  if (path.startsWith('/spectator') || viewParam === 'spectator') return 'spectator';
  if (path.startsWith('/score') || viewParam === 'score' || viewParam === 'scorekeeper') {
    return 'scorekeeper';
  }
  if (path.startsWith('/users') || viewParam === 'users') return 'users';
  if (
    path.startsWith('/host') ||
    path.startsWith('/system') ||
    path.startsWith('/debug') ||
    viewParam === 'host' ||
    viewParam === 'system' ||
    viewParam === 'debug'
  ) {
    return 'system';
  }
  return 'control';
}

export const DEFAULT_BANTER_QUOTES = [
  'Raymond would have knocked over the coffee table by now.',
  'Back in \'68, your grandfather played with a wooden paddle and won!',
  'Watch your elbows, sweetheart — keep your wrist loose!',
  'Somebody turn up the TV, my show is getting to the good part!',
  'Don\'t forget to hydrate between sets, dear.',
  'Nice footwork! You\'re lighter on your feet than Frank ever was.',
];

export const DEFAULT_CONTEXTUAL_QUOTES = [
  'Oh! Look at the spin on that little white ball!',
  'That point had more mustard on it than a deli sandwich!',
  'Ooh, what a rally! My knitting needles are shaking!',
  'Right down the line! Did you see that angle?!',
  'Whoa! Keep your eye on the ball, honey!',
  'What a comeback shot — pure magic!',
];

export const DEFAULT_GAME_POINT_QUOTES = [
  'Game point! Hold your breath, everyone!',
  'One more point and this match is in the books!',
  'Oh my nerves — it\'s Game Point on $table!',
  'Don\'t blink now, sweetheart — Game Point!',
];

export const SCORE_FONT_OPTIONS = [
  { id: 'barlow', label: 'Sports Bold' },
  { id: 'chakra', label: 'Stadium Tech' },
  { id: 'orbitron', label: 'Geometric Neo' },
  { id: 'mono', label: 'Clean Mono' },
];

export const THEME_OPTIONS = [
  { id: 'arena', label: 'Classic Arena', icon: '🏓', defaultAmbiance: 'none' },
  { id: 'thanksgiving', label: 'Thanksgiving', icon: '🦃', defaultAmbiance: 'leaves' },
  { id: 'christmas', label: 'Christmas', icon: '🎄', defaultAmbiance: 'snow' },
  { id: 'halloween', label: 'Halloween', icon: '🎃', defaultAmbiance: 'embers' },
  { id: 'spring', label: 'Spring', icon: '🌸', defaultAmbiance: 'petals' },
  { id: 'summer', label: 'Summer', icon: '☀️', defaultAmbiance: 'fireflies' },
  { id: 'newyear', label: 'New Year', icon: '🥂', defaultAmbiance: 'confetti' },
];

export const AMBIANCE_OPTIONS = [
  { id: 'auto', label: 'Auto (Theme)' },
  { id: 'none', label: 'None' },
  { id: 'leaves', label: '🍂 Leaves' },
  { id: 'snow', label: '❄️ Snow' },
  { id: 'rain', label: '🌧️ Rain' },
  { id: 'embers', label: '🔥 Embers' },
  { id: 'fireflies', label: '✨ Fireflies' },
  { id: 'petals', label: '🌸 Petals' },
  { id: 'confetti', label: '🎉 Confetti' },
];

export function resolveEffectiveAmbiance(ambiance, themeId) {
  if (ambiance && ambiance !== 'auto') return ambiance;
  const theme = THEME_OPTIONS.find((t) => t.id === themeId);
  return theme?.defaultAmbiance || 'none';
}

export const SLIDE_DEFINITIONS = [
  { id: 'title', number: 1, label: 'Welcome', shortLabel: '1 · Welcome' },
  { id: 'arena', number: 2, label: 'Live Match Arena', shortLabel: '2 · Arena' },
  { id: 'bracket', number: 3, label: 'Full Tournament Bracket', shortLabel: '3 · Bracket' },
  { id: 'split', number: 4, label: 'Split View', shortLabel: '4 · Split' },
  { id: 'spotlight', number: 5, label: 'Spotlight', shortLabel: '5 · Spotlight' },
];

export const TICKER_ITEM_DEFS = [
  { id: 'bracket', label: 'Mini Bracket' },
  { id: 'recent', label: 'Recent Results' },
  { id: 'upnext', label: 'On Deck / Up Next' },
  { id: 'stats', label: 'Tournament Stats' },
  { id: 'chat', label: 'Live Chat' },
];

/** Resolves ticker mode: 'static' | 'rotate' | 'scroll' (falls back to legacy boolean flags). */
export function resolveTickerMode(ui = {}) {
  if (['static', 'rotate', 'scroll'].includes(ui?.tickerMode)) return ui.tickerMode;
  return ui?.tickerScroll ? 'scroll' : ui?.tickerAutoRotate ? 'rotate' : 'static';
}

/** Sanitizes the list of ticker item ids (defaults to the mini bracket only). */
export function normalizeTickerItems(list) {
  const all = TICKER_ITEM_DEFS.map((d) => d.id);
  if (!Array.isArray(list)) return ['bracket'];
  return all.filter((id) => list.includes(id));
}

/** Sanitizes the list of slide ids included in auto-rotation (defaults to every slide). */
export function normalizeAutoRotateSlides(list) {
  const all = SLIDE_DEFINITIONS.map((s) => s.id);
  if (!Array.isArray(list)) return all;
  return all.filter((id) => list.includes(id));
}

const DEFAULT_COLLAPSED_PANELS = {
  presentation: false,
  grandma: false,
  crt: false,
  bracket: false,
};

function pickRandomPhrase(list, lastText = '') {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (list.length === 1) return list[0];
  const filtered = list.filter((q) => q !== lastText);
  const pool = filtered.length > 0 ? filtered : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function computeGrandmaSpeechTiming(text, stayDurationSec = 5.5) {
  const cleaned = String(text || '').trim();
  const typeSec = Math.min(2.8, cleaned.length / 36);
  const staySec = Math.max(2, Number(stayDurationSec) || 5.5);
  return {
    typeSec,
    totalVisibleSec: typeSec + staySec,
    totalVisibleMs: Math.round((typeSec + staySec) * 1000),
  };
}

export function createGrandmaSpeech({
  text,
  category = 'banter',
  grandmaConfig = {},
  now = Date.now(),
  randomFn = Math.random,
}) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return null;
  const { totalVisibleMs } = computeGrandmaSpeechTiming(
    cleaned,
    grandmaConfig.stayDurationSec ?? 5.5
  );
  const minInt = Math.max(1, Number(grandmaConfig.minIntervalSec ?? 6) || 6);
  const maxInt = Math.max(minInt, Number(grandmaConfig.maxIntervalSec ?? 13) || 13);
  const nextGapMs = Math.round((minInt + randomFn() * (maxInt - minInt)) * 1000);

  return {
    id: now + Math.floor(randomFn() * 100000),
    text: cleaned,
    category,
    isLive: category !== 'banter',
    startedAt: now,
    expiresAt: now + totalVisibleMs,
    nextBanterAt: now + totalVisibleMs + nextGapMs,
    durationMs: totalVisibleMs,
    nextGapMs,
    timestamp: now,
  };
}

export function createInitialState(overrides = {}) {
  const playerCount = clampPlayerCount(overrides.playerCount ?? 8);
  const format = overrides.format === 'double' ? 'double' : 'single';
  const entryMode = overrides.entryMode === 'teams' ? 'teams' : 'singles';
  const demoMode = Boolean(overrides.demoMode ?? false);
  const autoTeamNames = Boolean(overrides.autoTeamNames ?? false);

  const players = createPlayers(playerCount, overrides.players || [], entryMode, {
    demoMode,
    autoTeamNames,
  });
  const totalPlayers =
    overrides.totalPlayers !== undefined
      ? clampPlayerCount(overrides.totalPlayers)
      : entryMode === 'teams'
        ? Math.min(256, playerCount * 2)
        : playerCount;

  const roster =
    Array.isArray(overrides.roster) && overrides.roster.length > 0
      ? overrides.roster
      : entryMode === 'teams'
        ? players
          .flatMap((t) => (Array.isArray(t.members) ? t.members : []))
          .filter(Boolean)
          .slice(0, totalPlayers)
          .map((name, idx) => ({ id: `r${idx + 1}`, name }))
        : players.map((p, idx) => ({ id: `r${idx + 1}`, name: p.name }));

  const matches = generateBracket(players, format);
  const firstMatchId = findNextReadyMatchId(matches) || Object.keys(matches)[0] || 'W-R1-M1';

  const banterQuotes =
    Array.isArray(overrides.grandma?.banterQuotes) && overrides.grandma.banterQuotes.length > 0
      ? [...overrides.grandma.banterQuotes]
      : Array.isArray(overrides.grandma?.quotes) && overrides.grandma.quotes.length > 0
        ? [...overrides.grandma.quotes]
        : [...DEFAULT_BANTER_QUOTES];

  const contextualQuotes =
    Array.isArray(overrides.grandma?.contextualQuotes) &&
      overrides.grandma.contextualQuotes.length > 0
      ? [...overrides.grandma.contextualQuotes]
      : [...DEFAULT_CONTEXTUAL_QUOTES];

  const gamePointQuotes =
    Array.isArray(overrides.grandma?.gamePointQuotes) &&
      overrides.grandma.gamePointQuotes.length > 0
      ? [...overrides.grandma.gamePointQuotes]
      : [...DEFAULT_GAME_POINT_QUOTES];

  const tournamentId = overrides.tournamentId || generateTournamentId();
  const joinCode = resolveTournamentJoinCode({
    tournamentId,
    joinCode: overrides.joinCode,
    tournamentName: overrides.tournamentName,
  });

  return {
    version: 5,
    tournamentId,
    joinCode,
    hostDeviceId: overrides.hostDeviceId ?? null,
    hostDeviceName: overrides.hostDeviceName ?? (overrides.hostDeviceId ? 'Tournament Host' : 'Sync Host'),
    hostIp: overrides.hostIp ?? null,
    hostHistory: Array.from(
      new Set([
        ...(Array.isArray(overrides.hostHistory) ? overrides.hostHistory : []),
        ...(overrides.hostDeviceId ? [overrides.hostDeviceId] : []),
      ])
    ),
    destruction: overrides.destruction || null,
    access: {
      isSecure: overrides.access?.isSecure !== undefined ? Boolean(overrides.access.isSecure) : true,
      isPublic: overrides.access?.isPublic !== undefined ? Boolean(overrides.access.isPublic) : true,
    },
    userRoles:
      overrides.userRoles && typeof overrides.userRoles === 'object'
        ? { ...overrides.userRoles }
        : {},
    tabRoles:
      overrides.tabRoles && typeof overrides.tabRoles === 'object'
        ? { ...overrides.tabRoles }
        : {},
    scorekeeperRequests: Array.isArray(overrides.scorekeeperRequests)
      ? [...overrides.scorekeeperRequests]
      : [],
    joinRequests: Array.isArray(overrides.joinRequests)
      ? [...overrides.joinRequests]
      : [],
    demotedScorekeepers: Array.isArray(overrides.demotedScorekeepers)
      ? [...overrides.demotedScorekeepers]
      : [],
    deniedDevices: Array.isArray(overrides.deniedDevices) ? [...overrides.deniedDevices] : [],
    kickedDevices: Array.isArray(overrides.kickedDevices) ? [...overrides.kickedDevices] : [],
    playerClaims:
      overrides.playerClaims && typeof overrides.playerClaims === 'object'
        ? { ...overrides.playerClaims }
        : {},
    createdAt: overrides.createdAt || Date.now(),
    tournamentName: overrides.tournamentName || 'GRAND RETRO PING PONG CHAMPIONSHIP',
    tournamentSubtitle:
      typeof overrides.tournamentSubtitle === 'string' ? overrides.tournamentSubtitle.trim() : '',
    entryMode,
    demoMode,
    autoTeamNames,
    format,
    playerCount,
    totalPlayers,
    roster,
    rules: {
      targetPoints: Math.max(1, Math.floor(Number(overrides.rules?.targetPoints) || 11)),
      serveRotation: Math.max(1, Math.floor(Number(overrides.rules?.serveRotation) || 2)),
      winBy: Math.max(1, Math.floor(Number(overrides.rules?.winBy ?? 2) || 2)),
      skunkEnabled: Boolean(overrides.rules?.skunkEnabled ?? false),
      skunkScore: Math.max(1, Math.floor(Number(overrides.rules?.skunkScore ?? 7) || 7)),
      deadMansServe: Boolean(overrides.rules?.deadMansServe ?? false),
      tableCount: Math.max(1, Math.floor(Number(overrides.rules?.tableCount ?? 1) || 1)),
      requireScorekeeperApproval:
        overrides.rules?.requireScorekeeperApproval !== undefined
          ? Boolean(overrides.rules.requireScorekeeperApproval)
          : true,
      allowScorekeeperGrandma:
        overrides.rules?.allowScorekeeperGrandma !== undefined
          ? Boolean(overrides.rules.allowScorekeeperGrandma)
          : true,
      grandmaEnabled:
        overrides.rules?.grandmaEnabled !== undefined
          ? Boolean(overrides.rules.grandmaEnabled)
          : true,
      scoreDebounceSec:
        overrides.rules?.scoreDebounceSec !== undefined
          ? Math.max(0, Number(overrides.rules.scoreDebounceSec) || 0)
          : overrides.rules?.scoreDebounceMs !== undefined
            ? Math.max(0, (Number(overrides.rules.scoreDebounceMs) || 0) / 1000)
            : 1,
    },
    lastPointAt: 0,
    debouncedClicks: 0,
    setupVersion: Math.max(0, Math.floor(Number(overrides.setupVersion) || 0)),
    players,
    matches,
    activeMatchId: firstMatchId,
    championId: null,
    lastCompletedEvent: null,
    ui: {
      theme: THEME_OPTIONS.some((t) => t.id === overrides.ui?.theme) ? overrides.ui.theme : 'arena',
      showCornerScene: overrides.ui?.showCornerScene ?? true,
      cornerScale: overrides.ui?.cornerScale ?? 1.0,
      cornerOpacity: overrides.ui?.cornerOpacity ?? 1.0,
      bubbleScale: overrides.ui?.bubbleScale ?? 1.0,
      scoreFont: overrides.ui?.scoreFont || 'barlow',
      showMiniBracket: overrides.ui?.showMiniBracket ?? true,
      tickerItems: normalizeTickerItems(overrides.ui?.tickerItems),
      tickerMode: resolveTickerMode(overrides.ui),
      tickerAutoRotate: Boolean(overrides.ui?.tickerAutoRotate ?? false),
      tickerScroll: Boolean(overrides.ui?.tickerScroll ?? false),
      tickerRotateSec: Math.max(3, Number(overrides.ui?.tickerRotateSec) || 10),
      tvMuted: overrides.ui?.tvMuted ?? true,
      tvMediaLabel: overrides.ui?.tvMediaLabel ?? 'Default Sitcom (6s Loop)',
      hasCustomTvMedia: overrides.ui?.hasCustomTvMedia ?? false,
      tvPlaylist:
        Array.isArray(overrides.ui?.tvPlaylist) && overrides.ui.tvPlaylist.length > 0
          ? overrides.ui.tvPlaylist
          : [
              {
                id: 'builtin-default-tv',
                kind: 'url',
                name: 'Raymond Thanksgiving (Default)',
                url: '/raymond-thanksgiving.mp4',
                muted: true,
                durationSec: 2640,
                updatedAt: 0,
              },
            ],
      tvPlaylistIndex: Math.max(0, Number(overrides.ui?.tvPlaylistIndex) || 0),
      tvPlaylistMode: ['loop', 'shuffle', 'single'].includes(overrides.ui?.tvPlaylistMode)
        ? overrides.ui.tvPlaylistMode
        : 'loop',
      tvPlaylistPaused: Boolean(overrides.ui?.tvPlaylistPaused),
      collapsedPanels: {
        ...DEFAULT_COLLAPSED_PANELS,
        ...(overrides.ui?.collapsedPanels || {}),
      },
    },
    grandma: {
      quotes: banterQuotes, // Idle banter alias consumed by RetroTVScene
      banterQuotes,
      contextualQuotes,
      gamePointQuotes,
      contextualChancePct: overrides.grandma?.contextualChancePct ?? 25,
      stayDurationSec: overrides.grandma?.stayDurationSec ?? 5.5,
      minIntervalSec: overrides.grandma?.minIntervalSec ?? 6,
      maxIntervalSec: overrides.grandma?.maxIntervalSec ?? 13,
      liveQuote: null,
      activeSpeech: null,
      nextBanterAt: Date.now() + 2200,
    },
    presentation: {
      activeSlide: overrides.presentation?.activeSlide || 'title',
      autoRotate: overrides.presentation?.autoRotate ?? false,
    autoRotateSec: overrides.presentation?.autoRotateSec ?? 18,
    autoRotateSlides: normalizeAutoRotateSlides(overrides.presentation?.autoRotateSlides),
      titleAmbiance: AMBIANCE_OPTIONS.some((a) => a.id === overrides.presentation?.titleAmbiance)
        ? overrides.presentation.titleAmbiance
        : 'auto',
      ambianceIntensity: ['low', 'medium', 'high'].includes(
        overrides.presentation?.ambianceIntensity
      )
        ? overrides.presentation.ambianceIntensity
        : 'medium',
      titleSubtitle:
        overrides.presentation?.titleSubtitle !== undefined
          ? overrides.presentation.titleSubtitle
          : 'Welcome to Table 1 · Grab a paddle and get ready for kickoff!',
      arenaSubtitle: overrides.presentation?.arenaSubtitle ?? '',
      bracketSubtitle: overrides.presentation?.bracketSubtitle ?? '',
      bracketViewFilter: ['both', 'winners', 'losers'].includes(
        overrides.presentation?.bracketViewFilter
      )
        ? overrides.presentation.bracketViewFilter
        : 'both',
      onDeckMode: ['hide', 'show', 'nearing_end'].includes(overrides.presentation?.onDeckMode)
        ? overrides.presentation.onDeckMode
        : 'nearing_end',
      spotlightBetweenMatches: Boolean(overrides.presentation?.spotlightBetweenMatches ?? false),
      splitSubtitle: overrides.presentation?.splitSubtitle ?? '',
      intermissionMessage:
        overrides.presentation?.intermissionMessage !== undefined
          ? overrides.presentation.intermissionMessage
          : 'Next match warming up on Table 1 — Grab a fresh mug of coffee!',
    },
    updatedAt: Date.now(),
  };
}

function normalizePersistedState(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.matches || !parsed.players) {
    return null;
  }
  const base = createInitialState();
  const banterQuotes =
    Array.isArray(parsed.grandma?.banterQuotes) && parsed.grandma.banterQuotes.length > 0
      ? parsed.grandma.banterQuotes
      : Array.isArray(parsed.grandma?.quotes) && parsed.grandma.quotes.length > 0
        ? parsed.grandma.quotes
        : base.grandma.banterQuotes;

  const contextualQuotes =
    Array.isArray(parsed.grandma?.contextualQuotes) &&
      parsed.grandma.contextualQuotes.length > 0
      ? parsed.grandma.contextualQuotes
      : base.grandma.contextualQuotes;

  const gamePointQuotes =
    Array.isArray(parsed.grandma?.gamePointQuotes) &&
      parsed.grandma.gamePointQuotes.length > 0
      ? parsed.grandma.gamePointQuotes
      : base.grandma.gamePointQuotes;

  const entryMode = parsed.entryMode === 'teams' ? 'teams' : 'singles';
  const playerCount = clampPlayerCount(parsed.playerCount ?? parsed.players.length);

  const normalizedRoster =
    Array.isArray(parsed.roster) && parsed.roster.length > 0
      ? parsed.roster.map((r, idx) => ({
        id: r.id || `r${idx + 1}`,
        name: String(r.name || '').trim() || `Player ${idx + 1}`,
      }))
      : entryMode === 'teams'
        ? parsed.players
          .flatMap((t) => (Array.isArray(t.members) ? t.members : []))
          .filter(Boolean)
          .map((name, idx) => ({ id: `r${idx + 1}`, name }))
        : parsed.players.map((p, idx) => ({
          id: `r${idx + 1}`,
          name: p.name || `Player ${idx + 1}`,
        }));

  const totalPlayers =
    parsed.totalPlayers !== undefined
      ? clampPlayerCount(parsed.totalPlayers)
      : normalizedRoster.length >= 2
        ? clampPlayerCount(normalizedRoster.length)
        : entryMode === 'teams'
          ? Math.min(256, playerCount * 2)
          : playerCount;

  // Preserve active in-flight speech on reload, or schedule fresh banter cleanly
  const now = Date.now();
  const rawActiveSpeech = parsed.grandma?.activeSpeech || null;
  const freshActiveSpeech =
    rawActiveSpeech &&
      rawActiveSpeech.text &&
      Number(rawActiveSpeech.expiresAt) > now
      ? rawActiveSpeech
      : null;

  const rawLiveQuote = parsed.grandma?.liveQuote || null;
  const freshLiveQuote =
    rawLiveQuote && now - (Number(rawLiveQuote.timestamp) || 0) < 15000
      ? rawLiveQuote
      : null;

  const maxIntervalMs =
    Math.max(1, Math.min(120, Number(parsed.grandma?.maxIntervalSec ?? 13) || 13)) * 1000;
  const rawNextBanterAt = Number(
    parsed.grandma?.nextBanterAt ?? rawActiveSpeech?.nextBanterAt ?? 0
  );
  const normalizedNextBanterAt = freshActiveSpeech
    ? Math.max(freshActiveSpeech.expiresAt + 1000, rawNextBanterAt || freshActiveSpeech.expiresAt + 3000)
    : rawNextBanterAt > now && rawNextBanterAt <= now + maxIntervalMs
      ? rawNextBanterAt
      : now + 2200;

  const normalizedTableCount = Math.max(
    1,
    Math.floor(Number(parsed.rules?.tableCount ?? 1) || 1)
  );

  // Ensure legacy saved matches have normalized `started` boolean and clamped `tableNumber`
  const normalizedMatches = {};
  for (const [id, m] of Object.entries(parsed.matches || {})) {
    const rawTable = Number(m.tableNumber);
    const normalizedTable =
      Number.isFinite(rawTable) && rawTable >= 1
        ? Math.min(normalizedTableCount, Math.floor(rawTable))
        : null;
    normalizedMatches[id] = {
      ...m,
      started: Boolean(m.started || m.completed || (m.score1 || 0) > 0 || (m.score2 || 0) > 0),
      ...(normalizedTable ? { tableNumber: normalizedTable } : {}),
    };
  }

  const resolvedId = parsed.tournamentId || 't-default';
  const resolvedJoinCode = resolveTournamentJoinCode({
    ...parsed,
    tournamentId: resolvedId,
  });

  const merged = {
    ...base,
    ...parsed,
    tournamentId: resolvedId,
    joinCode: resolvedJoinCode,
    hostDeviceId: parsed.hostDeviceId ?? null,
    hostDeviceName:
      parsed.hostDeviceId
        ? parsed.hostDeviceName || 'Tournament Host'
        : parsed.hostDeviceName || 'Sync Host',
    hostIp: parsed.hostDeviceId ? parsed.hostIp || null : null,
    hostHistory: Array.from(
      new Set([
        ...(Array.isArray(parsed.hostHistory) ? parsed.hostHistory : []),
        ...(parsed.hostDeviceId ? [parsed.hostDeviceId] : []),
      ])
    ),
    destruction:
      parsed.destruction && typeof parsed.destruction === 'object' && parsed.destruction.destroyAt
        ? { ...parsed.destruction }
        : null,
    access: {
      isSecure: parsed.access?.isSecure !== undefined ? Boolean(parsed.access.isSecure) : true,
      isPublic: parsed.access?.isPublic !== undefined ? Boolean(parsed.access.isPublic) : true,
    },
    userRoles:
      parsed.userRoles && typeof parsed.userRoles === 'object' ? { ...parsed.userRoles } : {},
    tabRoles:
      parsed.tabRoles && typeof parsed.tabRoles === 'object' ? { ...parsed.tabRoles } : {},
    scorekeeperRequests: Array.isArray(parsed.scorekeeperRequests)
      ? [...parsed.scorekeeperRequests]
      : [],
    joinRequests: Array.isArray(parsed.joinRequests)
      ? [...parsed.joinRequests]
      : [],
    demotedScorekeepers: Array.isArray(parsed.demotedScorekeepers)
      ? [...parsed.demotedScorekeepers]
      : [],
    deniedDevices: Array.isArray(parsed.deniedDevices) ? [...parsed.deniedDevices] : [],
    kickedDevices: Array.isArray(parsed.kickedDevices) ? [...parsed.kickedDevices] : [],
    createdAt: parsed.createdAt || parsed.updatedAt || Date.now(),
    tournamentSubtitle:
      typeof parsed.tournamentSubtitle === 'string' ? parsed.tournamentSubtitle.trim() : '',
    matches: normalizedMatches,
    lastCompletedEvent: parsed.lastCompletedEvent || null,
    setupVersion: Math.max(0, Math.floor(Number(parsed.setupVersion) || 0)),
    entryMode,
    demoMode: Boolean(parsed.demoMode),
    autoTeamNames: Boolean(parsed.autoTeamNames),
    playerCount,
    totalPlayers,
    roster: normalizedRoster,
    rules: {
      ...base.rules,
      ...(parsed.rules || {}),
      targetPoints: Math.max(1, Math.floor(Number(parsed.rules?.targetPoints) || 11)),
      serveRotation: Math.max(1, Math.floor(Number(parsed.rules?.serveRotation) || 2)),
      winBy: Math.max(1, Math.floor(Number(parsed.rules?.winBy ?? 2) || 2)),
      skunkEnabled: Boolean(parsed.rules?.skunkEnabled ?? false),
      skunkScore: Math.max(1, Math.floor(Number(parsed.rules?.skunkScore ?? 7) || 7)),
      deadMansServe: Boolean(parsed.rules?.deadMansServe ?? false),
      tableCount: normalizedTableCount,
      requireScorekeeperApproval:
        parsed.rules?.requireScorekeeperApproval !== undefined
          ? Boolean(parsed.rules.requireScorekeeperApproval)
          : true,
      allowScorekeeperGrandma:
        parsed.rules?.allowScorekeeperGrandma !== undefined
          ? Boolean(parsed.rules.allowScorekeeperGrandma)
          : true,
      grandmaEnabled:
        parsed.rules?.grandmaEnabled !== undefined
          ? Boolean(parsed.rules.grandmaEnabled)
          : true,
      scoreDebounceSec:
        parsed.rules?.scoreDebounceSec !== undefined
          ? Math.max(0, Number(parsed.rules.scoreDebounceSec) || 0)
          : parsed.rules?.scoreDebounceMs !== undefined
            ? Math.max(0, (Number(parsed.rules.scoreDebounceMs) || 0) / 1000)
            : base.rules.scoreDebounceSec,
    },
    ui: {
      ...base.ui,
      ...(parsed.ui || {}),
      theme: THEME_OPTIONS.some((t) => t.id === parsed.ui?.theme) ? parsed.ui.theme : 'arena',
      cornerScale: Math.max(0.4, Math.min(1.5, Number(parsed.ui?.cornerScale ?? 1.0) || 1.0)),
      cornerOpacity: Math.max(
        0.15,
        Math.min(1.0, Number(parsed.ui?.cornerOpacity ?? 1.0) || 1.0)
      ),
      bubbleScale: Math.max(
        0.75,
        Math.min(1.5, Number(parsed.ui?.bubbleScale ?? 1.0) || 1.0)
      ),
      scoreFont: SCORE_FONT_OPTIONS.some((f) => f.id === parsed.ui?.scoreFont)
        ? parsed.ui.scoreFont
        : 'barlow',
      collapsedPanels: {
        ...DEFAULT_COLLAPSED_PANELS,
        ...(parsed.ui?.collapsedPanels || {}),
      },
    },
    grandma: {
      ...base.grandma,
      ...(parsed.grandma || {}),
      quotes: banterQuotes,
      banterQuotes,
      contextualQuotes,
      gamePointQuotes,
      contextualChancePct: Math.max(
        0,
        Math.min(100, Number(parsed.grandma?.contextualChancePct ?? 25))
      ),
      stayDurationSec: Math.max(
        2,
        Math.min(20, Number(parsed.grandma?.stayDurationSec ?? 5.5) || 5.5)
      ),
      minIntervalSec: Math.max(
        1,
        Math.min(60, Number(parsed.grandma?.minIntervalSec ?? 6) || 6)
      ),
      maxIntervalSec: Math.max(
        1,
        Math.min(120, Number(parsed.grandma?.maxIntervalSec ?? 13) || 13)
      ),
      liveQuote: freshLiveQuote,
      activeSpeech: freshActiveSpeech,
      nextBanterAt: normalizedNextBanterAt,
    },
    presentation: {
      ...base.presentation,
      ...(parsed.presentation || {}),
      activeSlide: SLIDE_DEFINITIONS.some((s) => s.id === parsed.presentation?.activeSlide)
        ? parsed.presentation.activeSlide
        : 'title',
      autoRotate: Boolean(parsed.presentation?.autoRotate),
      autoRotateSlides: normalizeAutoRotateSlides(parsed.presentation?.autoRotateSlides),
      autoRotateSec: Math.max(
        5,
        Math.min(120, Number(parsed.presentation?.autoRotateSec ?? 18) || 18)
      ),
      titleAmbiance: AMBIANCE_OPTIONS.some((a) => a.id === parsed.presentation?.titleAmbiance)
        ? parsed.presentation.titleAmbiance
        : 'auto',
      ambianceIntensity: ['low', 'medium', 'high'].includes(
        parsed.presentation?.ambianceIntensity
      )
        ? parsed.presentation.ambianceIntensity
        : 'medium',
      bracketViewFilter: ['both', 'winners', 'losers'].includes(
        parsed.presentation?.bracketViewFilter
      )
        ? parsed.presentation.bracketViewFilter
        : 'both',
      onDeckMode: ['hide', 'show', 'nearing_end'].includes(parsed.presentation?.onDeckMode)
        ? parsed.presentation.onDeckMode
        : 'nearing_end',
      spotlightBetweenMatches: Boolean(parsed.presentation?.spotlightBetweenMatches ?? false),
      titleSubtitle:
        parsed.presentation?.titleSubtitle !== undefined
          ? String(parsed.presentation.titleSubtitle)
          : base.presentation.titleSubtitle,
      arenaSubtitle:
        parsed.presentation?.arenaSubtitle !== undefined
          ? String(parsed.presentation.arenaSubtitle)
          : '',
      bracketSubtitle:
        parsed.presentation?.bracketSubtitle !== undefined
          ? String(parsed.presentation.bracketSubtitle)
          : '',
      splitSubtitle:
        parsed.presentation?.splitSubtitle !== undefined
          ? String(parsed.presentation.splitSubtitle)
          : '',
      intermissionMessage:
        parsed.presentation?.intermissionMessage !== undefined
          ? String(parsed.presentation.intermissionMessage)
          : base.presentation.intermissionMessage,
    },
  };
  if (!merged.matches[merged.activeMatchId] || merged.matches[merged.activeMatchId]?.isBye) {
    merged.activeMatchId =
      findNextReadyMatchId(merged.matches) || Object.keys(merged.matches)[0] || 'W-R1-M1';
  }
  return merged;
}

export function loadPersistedState() {
  try {
    if (typeof localStorage === 'undefined') return createInitialState();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw);
    return normalizePersistedState(parsed) || createInitialState();
  } catch {
    return createInitialState();
  }
}

export function loadPersistedStudioDraft() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STUDIO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.syncMode !== 'studio') return null;
    const stagedState = parsed.stagedState
      ? normalizePersistedState(parsed.stagedState)
      : null;
    return {
      syncMode: 'studio',
      hasUnpublishedChanges: Boolean(parsed.hasUnpublishedChanges && stagedState),
      stagedState,
    };
  } catch {
    return null;
  }
}

function readTournamentLibraryMap() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(TOURNAMENT_LIBRARY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeTournamentLibraryMap(map) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(TOURNAMENT_LIBRARY_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota errors
  }
}

function summarizeTournamentEntry(stateObj) {
  if (!stateObj) return null;
  const allMatches = Object.values(stateObj.matches || {});
  const realMatches = allMatches.filter((m) => !m.isBye);
  const completedMatches = realMatches.filter((m) => m.completed).length;
  const champ = stateObj.championId
    ? (stateObj.players || []).find((p) => p.id === stateObj.championId)
    : null;
  return {
    id: stateObj.tournamentId || 't-default',
    joinCode: resolveTournamentJoinCode(stateObj),
    hostDeviceId: stateObj.hostDeviceId || null,
    hostDeviceName: stateObj.hostDeviceName || 'Sync Host',
    hostIp: stateObj.hostIp || null,
    isSecure: stateObj.access?.isSecure !== undefined ? Boolean(stateObj.access.isSecure) : true,
    isPublic: stateObj.access?.isPublic !== undefined ? Boolean(stateObj.access.isPublic) : true,
    tournamentName: stateObj.tournamentName || 'Ping Pong Championship',
    tournamentSubtitle:
      typeof stateObj.tournamentSubtitle === 'string' ? stateObj.tournamentSubtitle.trim() : '',
    entryMode: stateObj.entryMode === 'teams' ? 'teams' : 'singles',
    format: stateObj.format === 'double' ? 'double' : 'single',
    playerCount: stateObj.playerCount || (stateObj.players || []).length,
    totalPlayers: stateObj.totalPlayers || stateObj.roster?.length || stateObj.playerCount || 8,
    completedMatches,
    totalMatches: realMatches.length,
    championName: champ?.name || null,
    theme: stateObj.ui?.theme || 'arena',
    createdAt: stateObj.createdAt || stateObj.updatedAt || Date.now(),
    updatedAt: stateObj.updatedAt || Date.now(),
  };
}

export function pickNextAvailableTableNumber(matches, tableCount = 1, excludeMatchId = null) {
  const count = Math.max(1, Math.floor(Number(tableCount) || 1));
  if (count <= 1) return 1;
  const busy = new Set();
  for (const m of Object.values(matches || {})) {
    if (!m || m.id === excludeMatchId || m.isBye || m.completed || !m.started) continue;
    const t = Math.floor(Number(m.tableNumber) || 1);
    if (t >= 1 && t <= count) busy.add(t);
  }
  for (let i = 1; i <= count; i++) {
    if (!busy.has(i)) return i;
  }
  return 1;
}

/**
 * Finds the next ready, unstarted, uncompleted match that is not already assigned to another table.
 */
export function findNextUnassignedMatchForTable(matches, tableCount = 1, excludeIds = []) {
  const excluded = new Set(Array.isArray(excludeIds) ? excludeIds.filter(Boolean) : [excludeIds].filter(Boolean));
  const bracketOrder = { winners: 0, losers: 1, finals: 2 };
  const candidates = Object.values(matches || {})
    .filter((m) => {
      if (!m || m.isBye || m.completed || m.started) return false;
      if (!m.player1Id || !m.player2Id) return false;
      if (excluded.has(m.id)) return false;
      return true;
    })
    .sort((a, b) => {
      const ba = bracketOrder[a.bracket] ?? 9;
      const bb = bracketOrder[b.bracket] ?? 9;
      if (ba !== bb) return ba - bb;
      if ((a.round || 0) !== (b.round || 0)) return (a.round || 0) - (b.round || 0);
      return (a.matchNumber || 0) - (b.matchNumber || 0);
    });
  return candidates[0] || null;
}

/**
 * Returns one slot descriptor per configured table (`1..tableCount`):
 * `{ tableNumber, match, isLive, isQueued }`.
 */
export function getTableSlots(state) {
  const count = Math.max(1, Math.floor(Number(state?.rules?.tableCount ?? 1) || 1));
  const matchesObj = state?.matches || {};
  const slots = Array.from({ length: count }, (_, idx) => ({
    tableNumber: idx + 1,
    match: null,
    isLive: false,
    isPaused: false,
    isQueued: false,
  }));
  const usedMatchIds = new Set();

  // 1. Place all live (or paused while assigned to a table) started uncompleted matches
  const liveMatches = Object.values(matchesObj)
    .filter(
      (m) =>
        m &&
        !m.isBye &&
        !m.completed &&
        m.started &&
        m.player1Id &&
        m.player2Id &&
        (!m.paused || (Number(m.tableNumber) >= 1 && Number(m.tableNumber) <= count))
    )
    .sort((a, b) => (a.tableNumber || 1) - (b.tableNumber || 1) || (a.startedAt || 0) - (b.startedAt || 0));

  for (const m of liveMatches) {
    const t = Math.max(1, Math.min(count, Math.floor(Number(m.tableNumber) || 1)));
    const slot = slots[t - 1];
    if (slot && !slot.match) {
      slot.match = m;
      slot.isLive = !m.paused;
      slot.isPaused = Boolean(m.paused);
      usedMatchIds.add(m.id);
    }
  }

  // 2. Place explicitly table-assigned unstarted matches onto open tables
  const queuedMatches = Object.values(matchesObj)
    .filter(
      (m) =>
        m &&
        !m.isBye &&
        !m.completed &&
        !m.started &&
        m.player1Id &&
        m.player2Id &&
        !usedMatchIds.has(m.id) &&
        Number(m.tableNumber) >= 1 &&
        Number(m.tableNumber) <= count
    )
    .sort((a, b) => (a.tableNumber || 1) - (b.tableNumber || 1));

  for (const m of queuedMatches) {
    const t = Math.max(1, Math.min(count, Math.floor(Number(m.tableNumber) || 1)));
    const slot = slots[t - 1];
    if (slot && !slot.match) {
      slot.match = m;
      slot.isQueued = true;
      usedMatchIds.add(m.id);
    }
  }

  // 3. Ensure activeMatchId (if ready, uncompleted, and not explicitly cleared) is shown on its table if open
  const active = state?.activeMatchId ? matchesObj[state.activeMatchId] : null;
  if (
    active &&
    !active.isBye &&
    !active.completed &&
    active.player1Id &&
    active.player2Id &&
    !usedMatchIds.has(active.id) &&
    (count === 1 || active.tableNumber !== null)
  ) {
    const t = Math.max(1, Math.min(count, Math.floor(Number(active.tableNumber) || 1)));
    const slot = slots[t - 1];
    if (slot && !slot.match) {
      slot.match = active;
      slot.isLive = Boolean(active.started && !active.paused);
      slot.isPaused = Boolean(active.started && active.paused);
      slot.isQueued = !active.started;
      usedMatchIds.add(active.id);
    }
  }

  return slots;
}

/**
 * Returns the list of matches to display simultaneously across tables on Presentation & Spectator views.
 * - When 1+ matches are actively started/queued across multiple tables, returns them ordered by tableNumber.
 * - Falls back to `[activeMatch]` so 1-table and pre-start views work seamlessly.
 */
export function getLiveTableMatches(state) {
  const slots = getTableSlots(state);
  const live = slots.filter((s) => s.match && s.isLive).map((s) => s.match);
  if (live.length > 0) return live;
  const queued = slots.filter((s) => s.match).map((s) => s.match);
  if (queued.length > 0) return queued;
  const active = state?.activeMatchId ? state?.matches?.[state.activeMatchId] : null;
  return active ? [active] : [];
}

/**
 * Pure helper evaluating whether a scored point should trigger a Game Point or
 * random Contextual Grandma quote. Exported for unit testing.
 */
export function selectScoreGrandmaQuote(prevMatch, nextMatch, rules, grandmaConfig, options = {}) {
  const { now = Date.now(), randomFn = Math.random, state = null, scoringSlot = null } = options;
  if (!nextMatch || !grandmaConfig) return null;

  const prevEval = evaluateMatchState(prevMatch, rules);
  const nextEval = evaluateMatchState(nextMatch, rules);
  const lastText = grandmaConfig.liveQuote?.text || '';

  // 1. GAME POINT: Grandma ALWAYS comments when a match reaches Game Point (or changes Game Point holder)
  const enteredGamePoint =
    nextEval.status === MATCH_STATUS.GAME_POINT &&
    (prevEval.status !== MATCH_STATUS.GAME_POINT ||
      prevEval.gamePointFor !== nextEval.gamePointFor ||
      nextMatch.score1 !== prevMatch.score1 ||
      nextMatch.score2 !== prevMatch.score2);

  if (enteredGamePoint && Array.isArray(grandmaConfig.gamePointQuotes) && grandmaConfig.gamePointQuotes.length > 0) {
    const phrase = pickRandomPhrase(grandmaConfig.gamePointQuotes, lastText);
    if (phrase) {
      const resolved = state
        ? resolveGrandmaPhrase(phrase, state, { match: nextMatch, scoringSlot })
        : phrase;
      return {
        id: now + Math.floor(randomFn() * 10000),
        text: resolved,
        category: 'gamePoint',
        timestamp: now,
      };
    }
  }

  // 2. CONTEXTUAL POINT COMMENTARY: Random chance (not every point!) with anti-spam cooldown
  if (
    nextEval.status === MATCH_STATUS.IN_PROGRESS ||
    nextEval.status === MATCH_STATUS.DEUCE
  ) {
    const chance = Math.max(0, Math.min(100, Number(grandmaConfig.contextualChancePct ?? 25))) / 100;
    const cooldownMs = Math.max(3000, ((grandmaConfig.stayDurationSec ?? 5.5) + 1.5) * 1000);
    const lastTs = grandmaConfig.liveQuote?.timestamp || 0;
    const cooledDown = now - lastTs >= cooldownMs;

    if (
      cooledDown &&
      chance > 0 &&
      Array.isArray(grandmaConfig.contextualQuotes) &&
      grandmaConfig.contextualQuotes.length > 0 &&
      randomFn() < chance
    ) {
      const phrase = pickRandomPhrase(grandmaConfig.contextualQuotes, lastText);
      if (phrase) {
        const resolved = state
          ? resolveGrandmaPhrase(phrase, state, { match: nextMatch, scoringSlot })
          : phrase;
        return {
          id: now + Math.floor(randomFn() * 10000),
          text: resolved,
          category: 'contextual',
          timestamp: now,
        };
      }
    }
  }

  return null;
}

function generateRandomWinScore(targetPoints, winBy = 2) {
  const target = Math.max(1, Math.floor(Number(targetPoints) || 11));
  const margin = Math.max(1, Math.floor(Number(winBy) || 2));
  const winner = Math.random() < 0.5 ? 1 : 2;
  if (margin >= 2 && target >= 2 && Math.random() < 0.2) {
    const extra = Math.floor(Math.random() * 4);
    const high = target + 1 + extra;
    const low = Math.max(0, high - margin);
    return winner === 1 ? [high, low] : [low, high];
  }
  const maxLoser = Math.max(0, target - margin);
  const loserPts = maxLoser > 0 ? Math.floor(Math.random() * (maxLoser + 1)) : 0;
  return winner === 1 ? [target, loserPts] : [loserPts, target];
}

export class TournamentStore {
  constructor(initialStateOverride = null, { persist = !initialStateOverride, viewMode } = {}) {
    this.persistEnabled = Boolean(persist);
    this.activeViewMode = viewMode || detectInitialViewMode();
    const liveLoaded = initialStateOverride || loadPersistedState();
    const studioDraft =
      this.persistEnabled && this.activeViewMode === 'control'
        ? loadPersistedStudioDraft()
        : null;

    this.programState = liveLoaded; // What is currently published/Live on Presentation & Scorekeeper Views
    this.syncMode = studioDraft?.syncMode === 'studio' ? 'studio' : 'live';
    this.hasUnpublishedChanges = Boolean(studioDraft?.hasUnpublishedChanges);
    this.state =
      this.syncMode === 'studio' && studioDraft?.stagedState
        ? studioDraft.stagedState
        : liveLoaded;
    this.lastDebouncedAt = 0;
    this.localPreviewMatchId = null;
    this.pendingScorePush = null;
    this.pendingScoreTimer = null;

    const initialKicked = this.persistEnabled ? readDisconnectedNotice() : null;
    this.suppressAutoReconnect = Boolean(initialKicked);
    this.isOnHub = false;
    this.hasActiveTournament = Boolean(
      initialStateOverride ||
      (this.persistEnabled &&
        typeof localStorage !== 'undefined' &&
        (() => {
          try {
            return Boolean(localStorage.getItem(STORAGE_KEY));
          } catch {
            return false;
          }
        })())
    );

    const identity = getOrCreateDeviceIdentity();
    this.remoteSync = {
      connected: false,
      serverUrl: resolveSyncServerBaseUrl(),
      customServerUrl: (() => {
        try {
          return typeof localStorage !== 'undefined'
            ? String(localStorage.getItem(SYNC_SERVER_URL_KEY) || '').trim()
            : '';
        } catch {
          return '';
        }
      })(),
      cloudTournaments: [],
      totalCloudTournaments: 0,
      privateCloudCount: 0,
      cloudActiveTournamentId: null,
      hosts: [],
      hostDevice: null,
      isThisDeviceHost: false,
      admins: [],
      isThisDeviceAdmin: false,
      adminKey: null,
      hubSettings: {
        hubTitle: 'JITTER',
        allowPublicCreation: true,
        defaultIsPublic: true,
        defaultIsSecure: true,
        defaultRequireScorekeeperApproval: true,
        allowedKeyTypos: 2,
      },
      unlockedGuestKeys: readUnlockedGuestKeys(),
      currentRole: 'local', // 'host' | 'guest' | 'local'
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      isDeviceNameCustom: Boolean(identity.isCustom),
      connectedClients: 0,
      clients: [],
      kickedNotice: initialKicked,
      inboxMessages: this.persistEnabled ? loadInboxMessages() : [],
      chatLiveMessages: [],
      chatThreads: [],
      unreadLiveChat: 0,
      unreadThreadCounts: {},
      unreadByTournament: {},
      joinResolutionNotice: null,
      scorekeeperResolutionNotice: null,
      serverInfo: null,
      activeSource: 'local', // 'cloud' | 'local'
      error: null,
    };
    this.eventSource = null;
    this.reconnectTimer = null;
    this.localDestroyTimer = null;
    this.hasCompletedInitialRemoteSync = false;
    this.serverClockOffsetMs = 0; // serverTime - Date.now() to eliminate Fire Stick / TV clock skew

    this.listeners = new Set();
    const generateSessionId = () => {
      const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
      let code = '';
      for (let i = 0; i < 4; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      return `id-${code}`;
    };
    this.tabId = (() => {
      if (this.persistEnabled && typeof sessionStorage !== 'undefined') {
        try {
          const existing = sessionStorage.getItem(SESSION_TAB_ID_STORAGE_KEY);
          if (existing && /^id-[a-z0-9]{4}$/i.test(existing)) return existing;
          const freshId = generateSessionId();
          sessionStorage.setItem(SESSION_TAB_ID_STORAGE_KEY, freshId);
          return freshId;
        } catch {
          // Ignore sessionStorage restrictions
        }
      }
      return generateSessionId();
    })();
    this.channel =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(SYNC_CHANNEL_NAME)
        : null;

    if (this.channel) {
      if (typeof this.channel.unref === 'function') {
        this.channel.unref();
      }
      this.channel.onmessage = (event) => {
        const msg = event.data;
        if (!msg || msg.sender === this.tabId) return;
        if (msg.type === 'STATE_SYNC' && msg.state) {
          this.handleExternalSync(msg.state);
        } else if (msg.type === 'GRANDMA_SPEECH' && msg.activeSpeech) {
          this.handleExternalGrandmaSpeech(msg.activeSpeech);
        } else if (msg.type === 'POINT_RECORDED' && typeof msg.lastPointAt === 'number') {
          this.handleExternalPointTimestamp(msg.lastPointAt);
        }
      };
    }

    this._onStorage = null;
    this._onPageHide = null;
    this.grandmaTimer = null;

    if (typeof window !== 'undefined') {
      this._onStorage = (event) => {
        if (event.key === STORAGE_KEY && event.newValue) {
          try {
            const incoming = JSON.parse(event.newValue);
            if (incoming && incoming.updatedAt !== this.programState.updatedAt) {
              this.handleExternalSync(incoming);
            }
          } catch {
            // Ignore malformed external writes
          }
        }
      };
      window.addEventListener('storage', this._onStorage);

      // Flush pending scores & persist latest state synchronously before page reload/close
      this._onPageHide = () => {
        if (this.pendingScorePush) {
          this.flushPendingScorePush();
        }
        this.persistSnapshot();
      };
      window.addEventListener('beforeunload', this._onPageHide);
      window.addEventListener('pagehide', this._onPageHide);

      // Engine-driven Grandma speech scheduler (synced across all tabs, views & slides)
      if (this.persistEnabled) {
        this.startGrandmaEngine();
        this.connectRemoteSync();
      }
    }
  }

  // ---- Cross-Device LAN / Cloud Real-Time Sync Hub ----

  getSyncBaseUrl() {
    return this.remoteSync.serverUrl || resolveSyncServerBaseUrl();
  }

  mergePublicSseSummaries(publicSummaries) {
    const incoming = Array.isArray(publicSummaries) ? publicSummaries : [];
    const myId = this.remoteSync.deviceId;
    const prevById = new Map();
    for (const prev of this.remoteSync.cloudTournaments || []) {
      if (prev?.id) prevById.set(prev.id, prev);
    }
    const myOwnPrivate = (this.remoteSync.cloudTournaments || []).filter(
      (t) => t && t.isPublic === false && t.hostDeviceId && t.hostDeviceId === myId
    );
    const byId = new Map();
    for (const t of incoming) {
      if (!t?.id) continue;
      const prev = prevById.get(t.id);
      const preservedAuth =
        t.isAuthorized !== undefined
          ? t.isAuthorized
          : prev && prev.isAuthorized !== undefined
            ? prev.isAuthorized
            : undefined;
      byId.set(t.id, preservedAuth !== undefined ? { ...t, isAuthorized: preservedAuth } : t);
    }
    for (const priv of myOwnPrivate) {
      if (priv?.id && !byId.has(priv.id)) {
        byId.set(priv.id, priv);
      }
    }
    return Array.from(byId.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  connectRemoteSync({ force = false } = {}) {
    if (!this.persistEnabled || typeof window === 'undefined' || typeof fetch === 'undefined') {
      return;
    }
    this.disconnectRemoteSync();
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl) return;

    // Always fetch the Cloud Hub directory (read-only), even if previously disconnected
    this.syncWithRemoteServer();

    // If this device was explicitly disconnected by a host, do NOT auto-open/rejoin SSE
    // until the user explicitly joins a tournament with a valid key (or creates one)!
    if (!force && this.suppressAutoReconnect) {
      return;
    }

    // Open SSE stream for real-time updates from laptops, phones, tablets & TVs
    if (typeof EventSource === 'undefined') return;
    try {
      const sseTid = this.isOnHub ? '' : this.programState?.tournamentId || '';
      const sseCode = sseTid
        ? this.remoteSync.unlockedGuestKeys?.[sseTid] || readUnlockedGuestKeys()[sseTid] || ''
        : '';
      this._sseAuthSignature = `${sseTid}|${sseCode}`;
      const qs = new URLSearchParams({
        tabId: this.tabId,
        deviceId: this.remoteSync.deviceId || '',
        deviceName: this.remoteSync.deviceName || '',
        viewMode: this.activeViewMode || 'control',
        tournamentId: sseTid,
        code: sseCode,
      });
      const es = new EventSource(`${baseUrl}/__sync/events?${qs.toString()}`);
      this.eventSource = es;

      es.addEventListener('CONNECTED', (ev) => {
        if (this.keepalivePingTimer) clearInterval(this.keepalivePingTimer);
        // Periodic lightweight HTTP ping (every 4 min) keeps Render Free awake during active tournaments
        this.keepalivePingTimer = setInterval(() => {
          if (typeof fetch === 'function') {
            fetch(`${baseUrl}/__sync/ping`, { cache: 'no-store' }).catch(() => {});
          }
        }, 4 * 60 * 1000);
        if (typeof this.keepalivePingTimer?.unref === 'function') {
          this.keepalivePingTimer.unref();
        }
        try {
          const data = JSON.parse(ev.data || '{}');
          this.updateServerClockOffset(data.serverTime);
          this.remoteSync = {
            ...this.remoteSync,
            connected: true,
            connectedClients: data.clients ?? this.remoteSync.connectedClients,
            clients: Array.isArray(data.connectedClientsList)
              ? data.connectedClientsList
              : this.remoteSync.clients,
            error: null,
          };
          this.emit();
          this.pushClientStatusToRemote();
          if (data.serverBootId) {
            this.resyncHostedTournamentIfNeeded({
              serverBootId: data.serverBootId,
              tournamentIds: Array.isArray(data.tournamentIds) ? data.tournamentIds : null,
              totalCloudTournaments: data.totalCloudTournaments,
            });
          }
        } catch {
          // Ignore parse error
        }
      });

      es.addEventListener('CLIENTS_UPDATE', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          this.remoteSync = {
            ...this.remoteSync,
            connectedClients: data.connectedClients ?? this.remoteSync.connectedClients,
            clients: Array.isArray(data.clients) ? data.clients : this.remoteSync.clients,
          };
          this.emit();
        } catch {
          // Ignore
        }
      });

      es.addEventListener('CLIENT_KICKED', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          const kickedId = data.tournamentId || this.programState?.tournamentId || null;
          this.handleAccessRevoked(kickedId, data.reason || 'Kicked by host');
        } catch {
          // Ignore
        }
      });

      es.addEventListener('CHAT_LIVE', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          const msg = data?.message;
          if (!msg || !msg.id) return;
          const isFromMe = msg.fromDeviceId === this.remoteSync.deviceId;
          const tid = data.tournamentId || this.programState?.tournamentId || '';
          const isActiveTournament =
            !data.tournamentId ||
            !this.programState?.tournamentId ||
            data.tournamentId === this.programState.tournamentId;

          const nextByT = { ...(this.remoteSync.unreadByTournament || {}) };
          if (!isFromMe && tid) {
            const prevT = nextByT[tid] || { live: 0, dm: 0 };
            nextByT[tid] = { ...prevT, live: (prevT.live || 0) + 1 };
          }

          if (!isActiveTournament) {
            if (!isFromMe && tid) {
              this.remoteSync = { ...this.remoteSync, unreadByTournament: nextByT };
              this.emit();
            }
            return;
          }

          const prev = Array.isArray(this.remoteSync.chatLiveMessages)
            ? this.remoteSync.chatLiveMessages
            : [];
          if (prev.some((m) => m.id === msg.id)) return;
          this.remoteSync = {
            ...this.remoteSync,
            chatLiveMessages: [...prev, msg].slice(-250),
            unreadLiveChat: isFromMe
              ? this.remoteSync.unreadLiveChat || 0
              : (this.remoteSync.unreadLiveChat || 0) + 1,
            unreadByTournament: nextByT,
          };
          this.emit();
        } catch {
          // Ignore
        }
      });

      es.addEventListener('CHAT_LIVE_DELETE', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          if (!data?.messageId) return;
          const prev = Array.isArray(this.remoteSync.chatLiveMessages)
            ? this.remoteSync.chatLiveMessages
            : [];
          this.remoteSync = {
            ...this.remoteSync,
            chatLiveMessages: prev.filter((m) => m.id !== data.messageId),
          };
          this.emit();
        } catch {
          // Ignore
        }
      });

      const handleIncomingThreadEvent = (data) => {
        const thread = data?.thread;
        if (!thread || !thread.id) return;
        const msg = data?.message || data?.newMessage || null;
        const isFromOther = Boolean(msg && msg.fromDeviceId !== this.remoteSync.deviceId);
        const tid = data.tournamentId || this.programState?.tournamentId || '';
        const isActiveTournament =
          !data.tournamentId ||
          !this.programState?.tournamentId ||
          data.tournamentId === this.programState.tournamentId;

        const nextByT = { ...(this.remoteSync.unreadByTournament || {}) };
        if (isFromOther && tid) {
          const prevT = nextByT[tid] || { live: 0, dm: 0 };
          nextByT[tid] = { ...prevT, dm: (prevT.dm || 0) + 1 };
        }

        if (!isActiveTournament) {
          if (isFromOther && tid) {
            this.remoteSync = { ...this.remoteSync, unreadByTournament: nextByT };
            this.emit();
          }
          return;
        }

        const prev = Array.isArray(this.remoteSync.chatThreads) ? this.remoteSync.chatThreads : [];
        const without = prev.filter((t) => t.id !== thread.id);
        const nextThreads = [thread, ...without].sort(
          (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        );
        const nextUnread = { ...(this.remoteSync.unreadThreadCounts || {}) };
        if (isFromOther) {
          nextUnread[thread.id] = (nextUnread[thread.id] || 0) + 1;
        }
        this.remoteSync = {
          ...this.remoteSync,
          chatThreads: nextThreads,
          unreadThreadCounts: nextUnread,
          unreadByTournament: nextByT,
        };
        this.emit();
      };

      es.addEventListener('CHAT_THREAD_UPDATE', (ev) => {
        try {
          handleIncomingThreadEvent(JSON.parse(ev.data || '{}'));
        } catch {
          // Ignore
        }
      });

      es.addEventListener('CHAT_MESSAGE', (ev) => {
        try {
          handleIncomingThreadEvent(JSON.parse(ev.data || '{}'));
        } catch {
          // Ignore
        }
      });

      es.addEventListener('USER_MESSAGE', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          if (!data?.message) return;
          const msgEntry = {
            id: data.id || `msg-${Date.now()}`,
            kind: data.kind === 'announcement' ? 'announcement' : 'message',
            sticky: Boolean(data.sticky),
            dismissAt: Number(data.dismissAt) > 0 ? Number(data.dismissAt) : null,
            dismissalLabel: data.dismissalLabel || null,
            countdownTargetAt: Number(data.countdownTargetAt) > 0 ? Number(data.countdownTargetAt) : null,
            liveTemplate: data.liveTemplate || data.message,
            autoDismissMs:
              data.sticky || Number(data.dismissAt) > 0
                ? 0
                : Number(data.autoDismissMs) || (data.kind === 'announcement' ? 10000 : 0),
            title: data.title || '💬 Tournament Message',
            message: data.message,
            fromName: data.fromName || 'Host',
            fromRole: data.fromRole || 'host',
            sentAt: data.sentAt || Date.now(),
            read: false,
          };
          dispatchNotification(
            {
              id: msgEntry.id,
              type: 'user_message',
              tag: msgEntry.id,
              title: msgEntry.title,
              body: msgEntry.message,
            },
            { desktopEnabled: true, soundEnabled: true }
          );
          const prevInbox = Array.isArray(this.remoteSync.inboxMessages)
            ? this.remoteSync.inboxMessages
            : [];
          const nextInbox = [
            msgEntry,
            ...prevInbox.filter((m) => m.id !== msgEntry.id),
          ].slice(0, 50);
          if (this.persistEnabled) saveInboxMessages(nextInbox);
          const isDocActive =
            typeof document === 'undefined' || document.visibilityState !== 'hidden';
          this.remoteSync = {
            ...this.remoteSync,
            inboxMessages: nextInbox,
            ...(isDocActive ? { lastUserMessage: msgEntry } : {}),
          };
          this.emit();
        } catch {
          // Ignore
        }
      });

      es.addEventListener('PRESENTER_BANNER_CLEAR', () => {
        this.remoteSync = { ...this.remoteSync, lastUserMessage: null };
        this.emit();
      });

      es.addEventListener('ACCESS_REVOKED', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          const revokedId = data.tournamentId || this.programState?.tournamentId || null;
          this.handleAccessRevoked(
            revokedId,
            data.reason || 'Kicked by host — enter the current 4-word key to rejoin'
          );
        } catch {
          // Ignore
        }
      });

      es.addEventListener('STATE_SYNC', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          this.updateServerClockOffset(data.serverTime);
          const nextHosts = Array.isArray(data.hosts) ? data.hosts : this.remoteSync.hosts;
          if (Array.isArray(data.tournaments) || Array.isArray(data.hosts)) {
            const mergedList = Array.isArray(data.tournaments)
              ? this.mergePublicSseSummaries(data.tournaments)
              : this.remoteSync.cloudTournaments;
            this.remoteSync = {
              ...this.remoteSync,
              connected: true,
              cloudTournaments: mergedList,
              totalCloudTournaments:
                data.totalCloudTournaments !== undefined
                  ? Number(data.totalCloudTournaments)
                  : mergedList.length,
              privateCloudCount:
                data.privateCloudCount !== undefined
                  ? Number(data.privateCloudCount)
                  : this.remoteSync.privateCloudCount,
              cloudActiveTournamentId:
                data.activeTournamentId || this.remoteSync.cloudActiveTournamentId,
              hosts: nextHosts,
              isThisDeviceHost: nextHosts.some((h) => h.deviceId === this.remoteSync.deviceId),
            };
          }
          if (data.sender === this.tabId) {
            this.emit();
            return;
          }
          if (data.state) {
            const normalized = normalizePersistedState(data.state);
            // Only apply live state updates for the tournament THIS device is currently in
            // (so simultaneous hosts and guests on different tournaments never overwrite each other!)
            if (normalized && normalized.tournamentId === this.programState?.tournamentId) {
              const role = !normalized.hostDeviceId
                ? 'unclaimed'
                : normalized.hostDeviceId === this.remoteSync.deviceId
                  ? 'host'
                  : 'guest';
              this.remoteSync = { ...this.remoteSync, activeSource: 'cloud', currentRole: role };
              this.handleExternalSync(normalized);
              try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
              } catch {
                // Ignore
              }
            } else {
              this.emit();
            }
          }
        } catch {
          // Ignore malformed SSE payload
        }
      });

      es.addEventListener('TOURNAMENT_DESTROYED', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          const mergedList = Array.isArray(data.tournaments)
            ? this.mergePublicSseSummaries(data.tournaments)
            : this.remoteSync.cloudTournaments.filter((t) => t?.id !== data.tournamentId);
          this.handleTournamentDestroyed(data.tournamentId, data.tournamentName, {
            cloudTournaments: mergedList,
            totalCloudTournaments:
              data.totalCloudTournaments !== undefined
                ? Number(data.totalCloudTournaments)
                : mergedList.length,
            privateCloudCount:
              data.privateCloudCount !== undefined
                ? Number(data.privateCloudCount)
                : this.remoteSync.privateCloudCount,
            cloudActiveTournamentId: data.activeTournamentId || null,
          });
        } catch {
          // Ignore
        }
      });

      es.addEventListener('LIBRARY_UPDATE', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          const nextHosts = Array.isArray(data.hosts) ? data.hosts : this.remoteSync.hosts;
          const mergedList = Array.isArray(data.tournaments)
            ? this.mergePublicSseSummaries(data.tournaments)
            : this.remoteSync.cloudTournaments;
          this.remoteSync = {
            ...this.remoteSync,
            connected: true,
            cloudTournaments: mergedList,
            totalCloudTournaments:
              data.totalCloudTournaments !== undefined
                ? Number(data.totalCloudTournaments)
                : mergedList.length,
            privateCloudCount:
              data.privateCloudCount !== undefined
                ? Number(data.privateCloudCount)
                : this.remoteSync.privateCloudCount,
            cloudActiveTournamentId:
              data.activeTournamentId !== undefined
                ? data.activeTournamentId
                : this.remoteSync.cloudActiveTournamentId,
            hosts: nextHosts,
            isThisDeviceHost: nextHosts.some((h) => h.deviceId === this.remoteSync.deviceId),
          };
          this.emit();
        } catch {
          // Ignore
        }
      });

      es.addEventListener('GRANDMA_SPEECH', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          this.updateServerClockOffset(data.serverTime);
          if (data.sender === this.tabId || !data.activeSpeech) return;
          if (
            data.tournamentId &&
            this.programState?.tournamentId &&
            data.tournamentId !== this.programState.tournamentId
          ) {
            return;
          }
          this.handleExternalGrandmaSpeech(data.activeSpeech, { liveArrival: true });
        } catch {
          // Ignore
        }
      });

      es.addEventListener('POINT_RECORDED', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          if (data.sender === this.tabId || typeof data.lastPointAt !== 'number') return;
          this.handleExternalPointTimestamp(data.lastPointAt);
        } catch {
          // Ignore
        }
      });

      es.addEventListener('HOST_UPDATE', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          const nextHosts = Array.isArray(data.hosts) ? data.hosts : this.remoteSync.hosts;
          const host = data.hostDevice || nextHosts[0] || null;
          const mergedList = Array.isArray(data.tournaments)
            ? this.mergePublicSseSummaries(data.tournaments)
            : this.remoteSync.cloudTournaments;
          this.remoteSync = {
            ...this.remoteSync,
            hosts: nextHosts,
            hostDevice: host,
            isThisDeviceHost: nextHosts.some((h) => h.deviceId === this.remoteSync.deviceId),
            ...(Array.isArray(data.tournaments)
              ? {
                cloudTournaments: mergedList,
                totalCloudTournaments:
                  data.totalCloudTournaments !== undefined
                    ? Number(data.totalCloudTournaments)
                    : mergedList.length,
                privateCloudCount:
                  data.privateCloudCount !== undefined
                    ? Number(data.privateCloudCount)
                    : this.remoteSync.privateCloudCount,
              }
              : {}),
          };
          this.emit();
        } catch {
          // Ignore
        }
      });

      es.addEventListener('JOIN_REQUEST_RESOLVED', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          this.remoteSync = {
            ...this.remoteSync,
            ...(Array.isArray(data.tournaments) ? { cloudTournaments: data.tournaments } : {}),
            ...(data.totalCloudTournaments !== undefined
              ? { totalCloudTournaments: Number(data.totalCloudTournaments) }
              : {}),
            ...(data.privateCloudCount !== undefined
              ? { privateCloudCount: Number(data.privateCloudCount) }
              : {}),
            joinResolutionNotice: {
              id: data.at || Date.now(),
              tournamentId: data.tournamentId || null,
              tournamentName: data.tournamentName || 'Tournament',
              approved: Boolean(data.approved),
            },
          };
          this.emit();
        } catch {
          // Ignore
        }
      });

      es.addEventListener('SCOREKEEPER_REQUEST_RESOLVED', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          this.remoteSync = {
            ...this.remoteSync,
            scorekeeperResolutionNotice: {
              id: data.at || Date.now(),
              tournamentId: data.tournamentId || null,
              tournamentName: data.tournamentName || 'Tournament',
              approved: Boolean(data.approved),
              message: data.message || (data.approved ? 'Scorekeeper access approved' : 'Access denied'),
            },
          };
          this.emit();
        } catch {
          // Ignore
        }
      });

      es.addEventListener('ADMIN_UPDATE', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          const nextAdmins = Array.isArray(data.admins) ? data.admins : this.remoteSync.admins;
          const isAdminNow =
            data.isAdmin !== undefined
              ? Boolean(data.isAdmin)
              : isHubAdminDevice(this.remoteSync.deviceId, nextAdmins);
          this.remoteSync = {
            ...this.remoteSync,
            admins: nextAdmins,
            isThisDeviceAdmin: isAdminNow,
            adminKey: isAdminNow ? data.adminKey || this.remoteSync.adminKey || null : null,
            hubSettings:
              data.hubSettings && typeof data.hubSettings === 'object'
                ? { ...this.remoteSync.hubSettings, ...data.hubSettings }
                : this.remoteSync.hubSettings,
            ...(Array.isArray(data.tournaments) ? { cloudTournaments: data.tournaments } : {}),
            ...(data.totalCloudTournaments !== undefined
              ? { totalCloudTournaments: Number(data.totalCloudTournaments) }
              : {}),
            ...(data.privateCloudCount !== undefined
              ? { privateCloudCount: Number(data.privateCloudCount) }
              : {}),
            ...(Array.isArray(data.clients)
              ? {
                  connectedClients: data.connectedClients ?? data.clients.length,
                  clients: data.clients,
                }
              : {}),
          };
          this.emit();
        } catch {
          // Ignore
        }
      });

      es.addEventListener('MEDIA_UPDATE', (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          if (data.sender === this.tabId) return;
          window.dispatchEvent(new CustomEvent('pingpong-remote-media-update', { detail: data }));
        } catch {
          // Ignore
        }
      });

      es.onerror = () => {
        if (this.eventSource) {
          this.eventSource.close();
          this.eventSource = null;
        }
        // Never auto-reconnect after being explicitly disconnected by a host!
        if (this.suppressAutoReconnect) {
          return;
        }
        this.remoteSync = {
          ...this.remoteSync,
          connected: false,
        };
        this.emit();
        if (!this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.suppressAutoReconnect) {
              this.connectRemoteSync();
            }
          }, 3500);
        }
      };
    } catch {
      this.remoteSync = { ...this.remoteSync, connected: false };
    }
  }

  disconnectRemoteSync() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  handleAccessRevoked(revokedTournamentId, reason = 'Kicked by host') {
    // Stop SSE immediately and suppress 3.5s auto-reconnect so this device stays disconnected!
    this.suppressAutoReconnect = true;
    this.disconnectRemoteSync();

    const unlocked = readUnlockedGuestKeys();
    if (revokedTournamentId && unlocked[revokedTournamentId]) {
      delete unlocked[revokedTournamentId];
      try {
        localStorage.setItem(GUEST_KEYS_STORAGE_KEY, JSON.stringify(unlocked));
      } catch {
        // Ignore
      }
    }

    const notice = {
      id: Date.now(),
      tournamentId: revokedTournamentId || null,
      reason,
      at: Date.now(),
    };
    // Persist disconnect flag across browser refresh so reloading CANNOT auto-rejoin!
    writeDisconnectedNotice(notice);

    // Clear persisted live snapshot & session pick flag so a browser refresh NEVER rejoins the kicked tournament!
    const wasViewingRevoked =
      !revokedTournamentId || this.programState?.tournamentId === revokedTournamentId;
    if (wasViewingRevoked) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(STUDIO_STORAGE_KEY);
        }
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.removeItem(SESSION_PICKED_STORAGE_KEY);
        }
      } catch {
        // Ignore
      }
      const freshLocal = createInitialState();
      this.clearPendingScoreTimer();
      this.pendingScorePush = null;
      this.localPreviewMatchId = null;
      this.syncMode = 'live';
      this.hasUnpublishedChanges = false;
      this.hasActiveTournament = false;
      this.programState = freshLocal;
      this.state = freshLocal;
    }

    this.remoteSync = {
      ...this.remoteSync,
      unlockedGuestKeys: unlocked,
      activeSource: 'local',
      currentRole: 'local',
      kickedNotice: notice,
    };
    this.emit();
  }

  handleTournamentDestroyed(destroyedTournamentId, destroyedName = 'Tournament', syncPatch = {}) {
    if (this.localDestroyTimer) {
      clearTimeout(this.localDestroyTimer);
      this.localDestroyTimer = null;
    }
    const nextUnlocked = removeUnlockedGuestKey(destroyedTournamentId);
    const wasViewing =
      Boolean(destroyedTournamentId) && this.programState?.tournamentId === destroyedTournamentId;
    let notice = this.remoteSync.kickedNotice;
    if (wasViewing) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(STUDIO_STORAGE_KEY);
        }
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(SESSION_PICKED_STORAGE_KEY, '__hub__');
        }
      } catch {
        // Ignore storage errors
      }
      const freshLocal = createInitialState();
      this.clearPendingScoreTimer();
      this.pendingScorePush = null;
      this.localPreviewMatchId = null;
      this.syncMode = 'live';
      this.hasUnpublishedChanges = false;
      this.hasActiveTournament = false;
      this.programState = freshLocal;
      this.state = freshLocal;
      notice = {
        id: Date.now(),
        kind: 'destroyed',
        tournamentId: destroyedTournamentId,
        reason: `💥 "${destroyedName}" was permanently destroyed after the 5-minute countdown.`,
        at: Date.now(),
      };
    }
    this.remoteSync = {
      ...this.remoteSync,
      ...syncPatch,
      unlockedGuestKeys: nextUnlocked,
      ...(wasViewing ? { activeSource: 'local', currentRole: 'local', kickedNotice: notice } : {}),
    };
    this.emit();
  }

  resumeAfterDisconnect() {
    this.suppressAutoReconnect = false;
    writeDisconnectedNotice(null);
    const activeTid = this.isOnHub ? '' : this.programState?.tournamentId || '';
    const activeCode = activeTid
      ? this.remoteSync.unlockedGuestKeys?.[activeTid] || readUnlockedGuestKeys()[activeTid] || ''
      : '';
    const nextSig = `${activeTid}|${activeCode}`;
    if (!this.eventSource || this._sseAuthSignature !== nextSig) {
      this.connectRemoteSync({ force: true });
    } else {
      this.pushClientStatusToRemote();
    }
  }

  async syncWithRemoteServer() {
    if (!this.persistEnabled || typeof fetch === 'undefined') return null;
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl) return null;

    try {
      const isDisconnected = Boolean(this.suppressAutoReconnect || readDisconnectedNotice());
      const currentTid = isDisconnected ? '' : this.programState?.tournamentId || '';
      const currentGuestKey = currentTid ? readUnlockedGuestKeys()[currentTid] || '' : '';
      const qs = new URLSearchParams({
        deviceId: this.remoteSync.deviceId || '',
        ...(currentTid ? { tournamentId: currentTid } : {}),
        ...(currentGuestKey ? { code: currentGuestKey } : {}),
      });
      const [stateRes, infoRes] = await Promise.all([
        fetch(`${baseUrl}/__sync/state?${qs.toString()}`, { cache: 'no-store' }),
        fetch(`${baseUrl}/__server-info`, { cache: 'no-store' }).catch(() => null),
      ]);
      if (!stateRes.ok) {
        this.remoteSync = { ...this.remoteSync, connected: false, error: 'Sync server unavailable' };
        this.emit();
        return null;
      }

      const data = await stateRes.json();
      this.updateServerClockOffset(data.serverTime);
      const info = infoRes && infoRes.ok ? await infoRes.json() : this.remoteSync.serverInfo;
      const nextHosts = Array.isArray(data.hosts) ? data.hosts : [];
      const host = data.hostDevice || nextHosts[0] || null;

      // Always collect rich browser environment details and default non-custom deviceName to "Device · Browser"
      const serverHostname = String(info?.clientDeviceName || '').trim();
      const baseEnv = collectClientEnvironmentSync('', serverHostname);
      const enrichedEnv = await collectClientEnvironmentHighEntropy(baseEnv);
      if (enrichedEnv) {
        this.clientEnv = enrichedEnv;
      }

      let resolvedDeviceName = this.remoteSync.deviceName;
      if (!this.remoteSync.isDeviceNameCustom) {
        const candidate = enrichedEnv?.deviceBrowser || detectFallbackDeviceName();
        if (candidate && candidate !== resolvedDeviceName) {
          resolvedDeviceName = candidate;
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem(DEVICE_NAME_KEY, candidate);
            }
          } catch {
            // Ignore
          }
        }
      }

      let unlockedGuestKeys = readUnlockedGuestKeys();
      const isListedHost = nextHosts.some((h) => h.deviceId === this.remoteSync.deviceId);

      const visibleCloud = Array.isArray(data.tournaments) ? data.tournaments : [];
      // Prune any cached guest join keys for tournaments where the server reports this device is NOT authorized
      // (e.g. after being kicked or having access revoked) so the Hub immediately prompts for the current key.
      let prunedAnyGuestKey = false;
      for (const ct of visibleCloud) {
        if (
          ct &&
          ct.id &&
          ct.isAuthorized === false &&
          ct.isSecure !== false &&
          ct.hostDeviceId &&
          ct.hostDeviceId !== this.remoteSync.deviceId &&
          Object.prototype.hasOwnProperty.call(unlockedGuestKeys, ct.id)
        ) {
          delete unlockedGuestKeys[ct.id];
          prunedAnyGuestKey = true;
        }
      }
      if (prunedAnyGuestKey) {
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(GUEST_KEYS_STORAGE_KEY, JSON.stringify(unlockedGuestKeys));
          }
        } catch {
          // Ignore storage errors
        }
      }
      const nextAdmins = Array.isArray(data.admins) ? data.admins : this.remoteSync.admins || [];
      const isListedAdmin =
        data.isAdmin !== undefined
          ? Boolean(data.isAdmin)
          : isHubAdminDevice(this.remoteSync.deviceId, nextAdmins);
      this.remoteSync = {
        ...this.remoteSync,
        deviceName: resolvedDeviceName,
        connected: true,
        serverUrl: baseUrl,
        cloudTournaments: visibleCloud,
        totalCloudTournaments:
          data.totalCloudTournaments !== undefined
            ? Number(data.totalCloudTournaments)
            : visibleCloud.length,
        privateCloudCount:
          data.privateCloudCount !== undefined ? Number(data.privateCloudCount) : 0,
        cloudActiveTournamentId: data.activeTournamentId || null,
        hosts: nextHosts,
        hostDevice: host,
        isThisDeviceHost: isListedHost,
        admins: nextAdmins,
        isThisDeviceAdmin: isListedAdmin,
        adminKey: isListedAdmin ? data.adminKey || this.remoteSync.adminKey || null : null,
        hubSettings:
          data.hubSettings && typeof data.hubSettings === 'object'
            ? { ...this.remoteSync.hubSettings, ...data.hubSettings }
            : this.remoteSync.hubSettings,
        unlockedGuestKeys,
        connectedClients: data.connectedClients ?? this.remoteSync.connectedClients,
        clients: Array.isArray(data.clients) ? data.clients : this.remoteSync.clients,
        serverInfo: info,
        error: null,
      };
      this.pushClientStatusToRemote();

      // Option C Auto-Bootstrap: When the server computer opens the app in a browser and
      // no Hub Admin exists yet, automatically claim local Hub Admin for this machine!
      if (
        this.persistEnabled &&
        info?.isLocalClient &&
        !isListedAdmin &&
        nextAdmins.length === 0
      ) {
        this.claimLocalHubAdmin();
      }

      if (data.accessRevoked) {
        this.handleAccessRevoked(
          data.revokedTournamentId || this.programState?.tournamentId,
          'You were kicked from this tournament — enter the current 4-word key to rejoin'
        );
        this.hasCompletedInitialRemoteSync = true;
        return data;
      }

      // While disconnected by host, stay strictly on the Hub without auto-adopting any tournament!
      if (this.suppressAutoReconnect || readDisconnectedNotice()) {
        this.hasCompletedInitialRemoteSync = true;
        this.emit();
        return data;
      }

      if (Number(data.lastPointAt) > 0) {
        this.handleExternalPointTimestamp(Number(data.lastPointAt));
      }

      const hasLocalSaved = (() => {
        try {
          return Boolean(typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY));
        } catch {
          return false;
        }
      })();

      if (data.state) {
        const remoteNormalized = normalizePersistedState(data.state);
        if (remoteNormalized) {
          const sameTournament =
            remoteNormalized.tournamentId === this.programState?.tournamentId;
          const isOwnHosted = Boolean(
            remoteNormalized.hostDeviceId &&
            remoteNormalized.hostDeviceId === this.remoteSync.deviceId
          );
          const hasGuestKey = Boolean(unlockedGuestKeys[remoteNormalized.tournamentId]);
          const remoteIsNewer =
            (remoteNormalized.updatedAt || 0) > (this.programState?.updatedAt || 0);
          // Hosts always sync their own tournaments automatically; guests only sync tournaments
          // they have already unlocked with the 4-word Tournament ID (never bypassing the key gate!)
          if (
            (isOwnHosted || hasGuestKey) &&
            (!hasLocalSaved || !this.hasCompletedInitialRemoteSync || (sameTournament && remoteIsNewer))
          ) {
            this.remoteSync = {
              ...this.remoteSync,
              activeSource: 'cloud',
              currentRole: isOwnHosted ? 'host' : 'guest',
            };
            this.handleExternalSync(remoteNormalized);
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify(remoteNormalized));
            } catch {
              // Ignore
            }
          }
        }
      }

      this.hasCompletedInitialRemoteSync = true;
      this.emit();
      await this.resyncHostedTournamentIfNeeded({
        serverBootId: data.serverBootId || null,
        tournamentIds: visibleCloud.map((t) => t.id),
        totalCloudTournaments:
          data.totalCloudTournaments !== undefined
            ? Number(data.totalCloudTournaments)
            : visibleCloud.length,
      });
      return data;
    } catch {
      this.remoteSync = {
        ...this.remoteSync,
        connected: false,
        error: 'Unable to reach sync server',
      };
      this.emit();
      return null;
    }
  }

  /**
   * Automatically re-pushes this device's active hosted tournament back to the server
   * when the server restarts/redeploys with an empty ephemeral disk (e.g. Render Free tier).
   * Safe against resurrecting intentionally deleted tournaments: only runs when the server
   * boot ID changed (server restarted) or the server came back completely empty while this
   * device still holds an active hosted tournament in memory/localStorage.
   */
  async resyncHostedTournamentIfNeeded({
    serverBootId = null,
    tournamentIds = null,
    totalCloudTournaments = null,
  } = {}) {
    if (!this.persistEnabled || !this.remoteSync.connected) return false;
    if (this.suppressAutoReconnect || readDisconnectedNotice()) return false;
    if (this._resyncInFlight) return false;

    let prevBootId = this.lastServerBootId || null;
    if (!prevBootId && typeof localStorage !== 'undefined') {
      try {
        prevBootId = localStorage.getItem(LAST_SERVER_BOOT_ID_KEY) || null;
      } catch {
        // Ignore
      }
    }
    const serverRestarted = Boolean(serverBootId && prevBootId && serverBootId !== prevBootId);
    if (serverBootId) {
      this.lastServerBootId = serverBootId;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(LAST_SERVER_BOOT_ID_KEY, serverBootId);
        }
      } catch {
        // Ignore
      }
    }

    const active = this.programState;
    const isMyHostedTournament = Boolean(
      active &&
        active.tournamentId &&
        !active.destruction &&
        active.hostDeviceId &&
        active.hostDeviceId === this.remoteSync.deviceId
    );
    if (!isMyHostedTournament) return false;

    const serverHasIt = Array.isArray(tournamentIds)
      ? tournamentIds.includes(active.tournamentId)
      : (this.remoteSync.cloudTournaments || []).some((t) => t.id === active.tournamentId);
    if (serverHasIt) return false;

    const serverIsEmpty =
      totalCloudTournaments !== null ? Number(totalCloudTournaments) === 0 : false;
    // Only auto-resync if the server restarted (new bootId) OR if we have an active hosted
    // tournament on this tab and the server is completely empty (e.g. fresh deploy before bootId existed)
    const shouldResync =
      serverRestarted || (this.hasActiveTournament && serverIsEmpty);
    if (!shouldResync) return false;

    this._resyncInFlight = true;
    try {
      const res = await this.pushStateToRemote(active, { activate: true });
      if (res) {
        this.remoteSync = {
          ...this.remoteSync,
          activeSource: 'cloud',
          currentRole: 'host',
        };
        this.emit();
        return true;
      }
      return false;
    } finally {
      this._resyncInFlight = false;
    }
  }

  async pushStateToRemote(stateObj, { activate = true } = {}) {
    if (!this.persistEnabled || typeof fetch === 'undefined' || !stateObj) return null;
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl) return null;
    try {
      const res = await fetch(`${baseUrl}/__sync/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.tabId,
          deviceId: this.remoteSync.deviceId,
          deviceName: this.remoteSync.deviceName,
          joinCode: this.remoteSync.unlockedGuestKeys?.[stateObj.tournamentId] || '',
          state: stateObj,
          activate,
        }),
      });
      if (res.status === 403) {
        const errData = await res.json().catch(() => ({}));
        if (errData.accessRevoked) {
          this.handleAccessRevoked(
            stateObj.tournamentId,
            errData.error || 'Kicked by host'
          );
        }
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json();
      if (data.stale && data.state) {
        this.handleExternalSync(data.state);
      }
      if (Array.isArray(data.tournaments)) {
        const nextHosts = Array.isArray(data.hosts) ? data.hosts : this.remoteSync.hosts;
        this.remoteSync = {
          ...this.remoteSync,
          connected: true,
          cloudTournaments: data.tournaments,
          totalCloudTournaments:
            data.totalCloudTournaments !== undefined
              ? Number(data.totalCloudTournaments)
              : data.tournaments.length,
          privateCloudCount:
            data.privateCloudCount !== undefined
              ? Number(data.privateCloudCount)
              : this.remoteSync.privateCloudCount,
          cloudActiveTournamentId: data.activeTournamentId || this.remoteSync.cloudActiveTournamentId,
          hosts: nextHosts,
          hostDevice: data.hostDevice || this.remoteSync.hostDevice,
          isThisDeviceHost: nextHosts.some((h) => h.deviceId === this.remoteSync.deviceId),
          ...(activate ? { activeSource: 'cloud' } : {}),
        };
        this.emit();
      }
      return data;
    } catch {
      return null;
    }
  }

  updateServerClockOffset(serverTime) {
    const st = Number(serverTime);
    if (!Number.isFinite(st) || st <= 0) return;
    const sample = st - Date.now();
    // Smooth minor jitter, snap immediately if skew is large (>1.5s, e.g. Fire Stick clock drift)
    if (this.serverClockOffsetMs === 0 || Math.abs(sample - this.serverClockOffsetMs) > 1500) {
      this.serverClockOffsetMs = sample;
    } else {
      this.serverClockOffsetMs = Math.round(this.serverClockOffsetMs * 0.7 + sample * 0.3);
    }
  }

  rebaseGrandmaSpeechToLocalClock(speech, { liveArrival = false } = {}) {
    if (!speech || !speech.text) return speech;
    const now = Date.now();
    const rawStart = Number(speech.startedAt ?? speech.timestamp ?? now);
    const rawExp = Number(speech.expiresAt ?? rawStart + 6000);
    const rawNext = Number(speech.nextBanterAt ?? rawExp + 7000);
    const durationMs = Math.max(
      1500,
      Math.min(60000, Number(speech.durationMs) || rawExp - rawStart || 6000)
    );
    const nextGapMs = Math.max(
      1000,
      Math.min(120000, Number(speech.nextGapMs) || rawNext - rawExp || 7000)
    );

    if (liveArrival) {
      // Live SSE speech just arrived: anchor directly to THIS device's local clock for 0ms skew delay!
      return {
        ...speech,
        startedAt: now,
        expiresAt: now + durationMs,
        nextBanterAt: now + durationMs + nextGapMs,
        durationMs,
        nextGapMs,
        timestamp: now,
      };
    }

    const offset = speech.clockSource === 'server' ? this.serverClockOffsetMs || 0 : 0;
    let localStart = rawStart - offset;
    let localExp = rawExp - offset;
    let localNext = rawNext - offset;
    // If local clock is still slightly behind, clamp start to now so the bubble never waits!
    if (localStart > now) {
      const shift = localStart - now;
      localStart = now;
      localExp = Math.max(now + 1000, localExp - shift);
      localNext = Math.max(localExp + 1000, localNext - shift);
    }
    return {
      ...speech,
      clockSource: 'local',
      startedAt: localStart,
      expiresAt: localExp,
      nextBanterAt: localNext,
      durationMs,
      nextGapMs,
    };
  }

  pushGrandmaSpeechToRemote(speech) {
    if (!this.persistEnabled || typeof fetch === 'undefined' || !speech) return;
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || !this.remoteSync.connected) return;
    fetch(`${baseUrl}/__sync/grandma`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        sender: this.tabId,
        tournamentId: this.programState?.tournamentId || null,
        activeSpeech: speech,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.throttled) return;
        if (data.serverTime) this.updateServerClockOffset(data.serverTime);
        const serverNext = Number(data.nextBanterAt || 0);
        const localNext = serverNext > 0 ? serverNext - (this.serverClockOffsetMs || 0) : 0;
        if (data.activeSpeech?.id && data.activeSpeech.id !== this.programState?.grandma?.activeSpeech?.id) {
          this.handleExternalGrandmaSpeech(data.activeSpeech, { liveArrival: false });
        } else if (localNext > Date.now()) {
          this.programState = {
            ...this.programState,
            grandma: { ...this.programState.grandma, nextBanterAt: localNext },
          };
          this.state = {
            ...this.state,
            grandma: { ...this.state.grandma, nextBanterAt: localNext },
          };
        }
      })
      .catch(() => {});
  }

  setHubPresence(onHub) {
    const next = Boolean(onHub);
    if (this.isOnHub === next) return;
    this.isOnHub = next;
    if (!next && this.eventSource && !this.suppressAutoReconnect) {
      const activeTid = this.programState?.tournamentId || '';
      const activeCode = activeTid
        ? this.remoteSync.unlockedGuestKeys?.[activeTid] || readUnlockedGuestKeys()[activeTid] || ''
        : '';
      if (this._sseAuthSignature !== `${activeTid}|${activeCode}`) {
        this.connectRemoteSync({ force: true });
        return;
      }
    }
    this.pushClientStatusToRemote();
  }

  pushClientStatusToRemote() {
    if (!this.persistEnabled || typeof fetch === 'undefined') return;
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl) return;
    const activeTid = this.isOnHub ? null : this.programState?.tournamentId || null;
    const guestCode = activeTid ? this.remoteSync.unlockedGuestKeys?.[activeTid] || '' : '';
    const clientInfo = this.clientEnv || collectClientEnvironmentSync();
    fetch(`${baseUrl}/__sync/client-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tabId: this.tabId,
        deviceId: this.remoteSync.deviceId,
        deviceName: this.remoteSync.deviceName,
        viewMode: this.isOnHub ? 'hub' : this.activeViewMode,
        tournamentId: activeTid,
        code: guestCode,
        ...(clientInfo ? { clientInfo } : {}),
      }),
    }).catch(() => { });
  }

  pushLastPointToRemote(ts) {
    if (!this.persistEnabled || typeof fetch === 'undefined') return;
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || !this.remoteSync.connected) return;
    fetch(`${baseUrl}/__sync/point`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: this.tabId, lastPointAt: ts }),
    }).catch(() => { });
  }

  async setSyncServerUrl(rawUrl) {
    const cleaned = String(rawUrl || '').trim().replace(/\/+$/, '');
    try {
      if (typeof localStorage !== 'undefined') {
        if (cleaned) localStorage.setItem(SYNC_SERVER_URL_KEY, cleaned);
        else localStorage.removeItem(SYNC_SERVER_URL_KEY);
      }
    } catch {
      // Ignore
    }
    const nextUrl = cleaned || resolveSyncServerBaseUrl();
    this.remoteSync = {
      ...this.remoteSync,
      customServerUrl: cleaned,
      serverUrl: nextUrl,
      connected: false,
      error: null,
    };
    this.hasCompletedInitialRemoteSync = false;
    this.emit();
    this.connectRemoteSync();
    return this.syncWithRemoteServer();
  }

  setDeviceName(name) {
    const rawTrimmed = String(name || '').trim();
    const isResetToDefault = !rawTrimmed;
    const defaultName =
      String(this.remoteSync.serverInfo?.clientDeviceName || '').trim() ||
      detectFallbackDeviceName();
    const cleaned = rawTrimmed || defaultName;
    const markCustom = !isResetToDefault && cleaned !== defaultName;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(DEVICE_NAME_KEY, cleaned);
        if (markCustom) localStorage.setItem(DEVICE_NAME_CUSTOM_KEY, '1');
        else localStorage.removeItem(DEVICE_NAME_CUSTOM_KEY);
      }
    } catch {
      // Ignore
    }
    this.remoteSync = {
      ...this.remoteSync,
      deviceName: cleaned,
      isDeviceNameCustom: markCustom,
    };
    this.pushClientStatusToRemote();
    if (this.remoteSync.isThisDeviceHost) {
      this.claimHostRole({ publishCurrent: false });
    } else {
      this.emit();
    }
  }

  async claimHostRole({ publishCurrent = true } = {}) {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined') return false;
    try {
      const res = await fetch(`${baseUrl}/__sync/host-claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.tabId,
          deviceId: this.remoteSync.deviceId,
          deviceName: this.remoteSync.deviceName,
          state: publishCurrent ? this.programState : null,
        }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      const nextHosts = Array.isArray(data.hosts) ? data.hosts : this.remoteSync.hosts;
      this.remoteSync = {
        ...this.remoteSync,
        connected: true,
        hosts: nextHosts,
        hostDevice: data.hostDevice || nextHosts[0] || null,
        isThisDeviceHost: true,
        ...(Array.isArray(data.tournaments) ? { cloudTournaments: data.tournaments } : {}),
      };
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  async releaseHostRole() {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined') return false;
    try {
      const res = await fetch(`${baseUrl}/__sync/host-claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.tabId,
          deviceId: this.remoteSync.deviceId,
          release: true,
        }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      const nextHosts = Array.isArray(data.hosts) ? data.hosts : [];
      this.remoteSync = {
        ...this.remoteSync,
        hosts: nextHosts,
        hostDevice: data.hostDevice || nextHosts[0] || null,
        isThisDeviceHost: nextHosts.some((h) => h.deviceId === this.remoteSync.deviceId),
        ...(Array.isArray(data.tournaments)
          ? {
            cloudTournaments: data.tournaments,
            totalCloudTournaments:
              data.totalCloudTournaments !== undefined
                ? Number(data.totalCloudTournaments)
                : data.tournaments.length,
            privateCloudCount:
              data.privateCloudCount !== undefined
                ? Number(data.privateCloudCount)
                : this.remoteSync.privateCloudCount,
          }
          : {}),
      };
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  async selectCloudTournament(tournamentId, { joinCode = '' } = {}) {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined' || !tournamentId) {
      return { ok: false, error: 'Sync server unreachable' };
    }
    try {
      const savedGuestKey = this.remoteSync.unlockedGuestKeys?.[tournamentId] || '';
      const effectiveCode = normalizeFourWordId(joinCode || savedGuestKey);
      const res = await fetch(`${baseUrl}/__sync/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.tabId,
          tournamentId,
          deviceId: this.remoteSync.deviceId,
          joinCode: effectiveCode,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.requiresKey) {
        // Purge any stale cached key for this tournament so the Hub immediately shows the key entry prompt!
        const nextUnlocked = removeUnlockedGuestKey(tournamentId);
        const nextCloud = (this.remoteSync.cloudTournaments || []).map((t) =>
          t && t.id === tournamentId ? { ...t, isAuthorized: false } : t
        );
        this.remoteSync = {
          ...this.remoteSync,
          unlockedGuestKeys: nextUnlocked,
          cloudTournaments: nextCloud,
        };
        this.emit();
        return {
          ok: false,
          requiresKey: true,
          error: data.error || 'Enter the 4-word Tournament ID to join as a guest',
        };
      }
      if (!res.ok) {
        return { ok: false, error: data.error || 'Could not load cloud tournament' };
      }
      const normalized = data.state ? normalizePersistedState(data.state) : null;
      if (!normalized) return { ok: false, error: 'Invalid tournament state' };

      const role = data.role === 'host' ? 'host' : 'guest';
      let nextUnlocked = this.remoteSync.unlockedGuestKeys || {};
      if (role === 'guest' && (normalized.joinCode || effectiveCode)) {
        nextUnlocked = saveUnlockedGuestKey(
          normalized.tournamentId,
          normalized.joinCode || effectiveCode
        );
      }

      this.clearPendingScoreTimer();
      this.pendingScorePush = null;
      this.localPreviewMatchId = null;
      this.syncMode = 'live';
      this.hasUnpublishedChanges = false;
      this.hasActiveTournament = true;
      this.programState = normalized;
      this.state = normalized;
      this.remoteSync = {
        ...this.remoteSync,
        connected: true,
        cloudActiveTournamentId: data.activeTournamentId || this.remoteSync.cloudActiveTournamentId,
        cloudTournaments: Array.isArray(data.tournaments)
          ? data.tournaments
          : this.remoteSync.cloudTournaments,
        hosts: Array.isArray(data.hosts) ? data.hosts : this.remoteSync.hosts,
        unlockedGuestKeys: nextUnlocked,
        activeSource: 'cloud',
        currentRole: role,
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      } catch {
        // Ignore
      }
      this.persistStudioDraft();
      this.resumeAfterDisconnect();
      this.emit();
      return { ok: true, role, state: normalized };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  async publishLocalTournamentToCloud(tournamentId, { activate = true } = {}) {
    const map = readTournamentLibraryMap();
    const entry = map[tournamentId] || (this.programState?.tournamentId === tournamentId ? this.programState : null);
    if (!entry) return null;
    const res = await this.pushStateToRemote(entry, { activate });
    if (res && map[tournamentId]) {
      // Remove from local-only library once promoted to Cloud so it doesn't duplicate
      delete map[tournamentId];
      writeTournamentLibraryMap(map);
      this.emit();
    }
    return res;
  }

  async joinTournamentByCode(rawCode) {
    const normalized = normalizeFourWordId(rawCode);
    if (!normalized) return { found: false, normalizedCode: '' };

    // 1. Check connected Cloud / Network server first
    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected) {
      try {
        const res = await fetch(`${baseUrl}/__sync/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            deviceId: this.remoteSync.deviceId,
            code: normalized,
            activate: true,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const loaded = data.state ? normalizePersistedState(data.state) : null;
          if (loaded) {
            const role = data.role === 'host' ? 'host' : 'guest';
            const nextUnlocked =
              role === 'guest'
                ? saveUnlockedGuestKey(loaded.tournamentId, data.joinCode || normalized)
                : this.remoteSync.unlockedGuestKeys;
            this.clearPendingScoreTimer();
            this.pendingScorePush = null;
            this.localPreviewMatchId = null;
            this.syncMode = 'live';
            this.hasUnpublishedChanges = false;
            this.hasActiveTournament = true;
            this.programState = loaded;
            this.state = loaded;
            this.remoteSync = {
              ...this.remoteSync,
              connected: true,
              cloudActiveTournamentId: data.activeTournamentId || this.remoteSync.cloudActiveTournamentId,
              cloudTournaments: Array.isArray(data.tournaments)
                ? data.tournaments
                : this.remoteSync.cloudTournaments,
              hosts: Array.isArray(data.hosts) ? data.hosts : this.remoteSync.hosts,
              unlockedGuestKeys: nextUnlocked,
              activeSource: 'cloud',
              currentRole: role,
            };
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded));
            } catch {
              // Ignore
            }
            this.persistStudioDraft();
            this.resumeAfterDisconnect();
            this.emit();
            return { found: true, source: 'cloud', role, state: loaded };
          }
        }
      } catch {
        // Fall through to local lookup
      }
    }

    // 2. Check Local tournaments on this device (supports run-on & configured typo tolerance)
    const maxTypos = this.remoteSync.hubSettings?.allowedKeyTypos ?? 2;
    const map = readTournamentLibraryMap();
    for (const [id, entry] of Object.entries(map)) {
      if (
        normalizeFourWordId(id) === normalized ||
        matchTournamentJoinKey(rawCode, resolveTournamentJoinCode(entry), { maxTypos }).matched
      ) {
        const loaded = this.selectTournament(id);
        if (loaded) {
          return { found: true, source: 'local', state: loaded };
        }
      }
    }

    // 3. Also check currently active in-memory tournament
    if (
      this.programState &&
      (normalizeFourWordId(this.programState.tournamentId) === normalized ||
        matchTournamentJoinKey(rawCode, resolveTournamentJoinCode(this.programState), { maxTypos })
          .matched)
    ) {
      return { found: true, source: this.remoteSync.activeSource || 'local', state: this.programState };
    }

    return { found: false, normalizedCode: normalized };
  }

  async copyCloudTournamentToLocal(tournamentId, joinCode = '') {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined' || !tournamentId) return null;
    try {
      const code = normalizeFourWordId(
        joinCode || this.remoteSync.unlockedGuestKeys?.[tournamentId] || ''
      );
      const qs = new URLSearchParams({
        deviceId: this.remoteSync.deviceId || '',
        ...(code ? { code } : {}),
      });
      const res = await fetch(
        `${baseUrl}/__sync/tournaments/${encodeURIComponent(tournamentId)}?${qs.toString()}`,
        { cache: 'no-store' }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const normalized = data.state ? normalizePersistedState(data.state) : null;
      if (!normalized) return null;
      this.saveToLibrary(normalized);
      this.emit();
      return normalized;
    } catch {
      return null;
    }
  }

  async deleteCloudTournament(tournamentId) {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined' || !tournamentId) return false;
    try {
      const qs = new URLSearchParams({ deviceId: this.remoteSync.deviceId || '' });
      const res = await fetch(
        `${baseUrl}/__sync/tournaments/${encodeURIComponent(tournamentId)}?${qs.toString()}`,
        { method: 'DELETE' }
      );
      if (!res.ok) return false;
      const data = await res.json();
      const visible = Array.isArray(data.tournaments) ? data.tournaments : [];
      const wasActiveCloud =
        this.programState?.tournamentId === tournamentId ||
        (this.remoteSync.activeSource === 'cloud' && visible.length === 0);
      if (wasActiveCloud) {
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(STUDIO_STORAGE_KEY);
          }
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.removeItem(SESSION_PICKED_STORAGE_KEY);
          }
        } catch {
          // Ignore storage errors
        }
        const fresh = createInitialState();
        this.clearPendingScoreTimer();
        this.pendingScorePush = null;
        this.localPreviewMatchId = null;
        this.syncMode = 'live';
        this.hasUnpublishedChanges = false;
        this.hasActiveTournament = false;
        this.programState = fresh;
        this.state = fresh;
      }
      const nextUnlocked = removeUnlockedGuestKey(tournamentId);
      this.remoteSync = {
        ...this.remoteSync,
        unlockedGuestKeys: nextUnlocked,
        cloudTournaments: visible,
        totalCloudTournaments:
          data.totalCloudTournaments !== undefined
            ? Number(data.totalCloudTournaments)
            : visible.length,
        privateCloudCount:
          data.privateCloudCount !== undefined ? Number(data.privateCloudCount) : 0,
        cloudActiveTournamentId: data.activeTournamentId || null,
        ...(wasActiveCloud ? { activeSource: 'local', currentRole: 'local' } : {}),
      };
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  async updateTournamentAccess({ isSecure, isPublic, requireScorekeeperApproval }) {
    const target = this.programState || this.state;
    if (!target) return { ok: false, error: 'No active tournament' };
    const myRole = resolveEffectiveRole(target, this.remoteSync.deviceId, this.tabId, {
      adminDeviceIds: this.remoteSync.admins,
    });
    if (!getRolePermissions(myRole).canManageAccessSettings) {
      return { ok: false, error: 'Only a host or admin can change security and visibility settings' };
    }
    const nextIsPublic =
      isPublic !== undefined ? Boolean(isPublic) : Boolean(target.access?.isPublic ?? true);
    const nextAccess = {
      isSecure: isSecure !== undefined ? Boolean(isSecure) : Boolean(target.access?.isSecure ?? true),
      isPublic: isPublic !== undefined ? Boolean(isPublic) : Boolean(target.access?.isPublic ?? true),
      isPublic: nextIsPublic,
      isSecure: nextIsPublic
        ? isSecure !== undefined
          ? Boolean(isSecure)
          : Boolean(target.access?.isSecure ?? true)
        : true,
    };
    const nextReqApproval =
      requireScorekeeperApproval !== undefined
        ? Boolean(requireScorekeeperApproval)
        : Boolean(target.rules?.requireScorekeeperApproval ?? true);

    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected && this.remoteSync.activeSource === 'cloud') {
      try {
        const res = await fetch(`${baseUrl}/__sync/tournament/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            tournamentId: target.tournamentId,
            deviceId: this.remoteSync.deviceId,
            isSecure: nextAccess.isSecure,
            isPublic: nextAccess.isPublic,
            requireScorekeeperApproval: nextReqApproval,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { ok: false, error: data.error || 'Failed to update access settings' };
        }
        const updated = data.state ? normalizePersistedState(data.state) : null;
        if (updated) {
          this.programState = updated;
          this.state = { ...this.state, access: updated.access, rules: updated.rules };
          if (Array.isArray(data.tournaments)) {
            this.remoteSync = {
              ...this.remoteSync,
              cloudTournaments: data.tournaments,
              totalCloudTournaments:
                data.totalCloudTournaments !== undefined
                  ? Number(data.totalCloudTournaments)
                  : data.tournaments.length,
              privateCloudCount:
                data.privateCloudCount !== undefined ? Number(data.privateCloudCount) : 0,
            };
          }
          this.persistSnapshot();
          this.emit();
          return { ok: true, state: updated };
        }
      } catch {
        // Fall through to local update
      }
    }

    const updated = this.commit((s) => ({
      ...s,
      access: nextAccess,
      rules: {
        ...s.rules,
        requireScorekeeperApproval: nextReqApproval,
      },
    }));
    return { ok: true, state: updated };
  }

  async assignUserRole(targetDeviceId, role) {
    const target = this.programState || this.state;
    if (!target || !targetDeviceId) return { ok: false, error: 'Missing target user' };
    const adminIds = this.remoteSync.admins;
    const actorRole = resolveEffectiveRole(target, this.remoteSync.deviceId, this.tabId, {
      adminDeviceIds: adminIds,
    });
    const targetCurrentRole = resolveDeviceRole(target, targetDeviceId, {
      adminDeviceIds: adminIds,
    });
    const nextRole = normalizeRole(role);
    if (!canAssignRole(actorRole, targetCurrentRole, nextRole)) {
      return {
        ok: false,
        error: `Your role (${actorRole}) cannot change ${targetCurrentRole} to ${nextRole}`,
      };
    }

    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected) {
      try {
        const res = await fetch(`${baseUrl}/__sync/tournament/role`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            actorTabId: this.tabId,
            tournamentId: target.tournamentId,
            actorDeviceId: this.remoteSync.deviceId,
            targetDeviceId,
            role: nextRole,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: data.error || 'Could not update role' };
        if (data.role && normalizeRole(data.role) !== nextRole) {
          return {
            ok: false,
            error: `Sync server does not recognize role "${nextRole}" yet — restart npm run dev and retry`,
          };
        }
        const updated = data.state ? normalizePersistedState(data.state) : null;
        if (updated) {
          this.programState = updated;
          this.state = {
            ...this.state,
            hostDeviceId: updated.hostDeviceId,
            hostDeviceName: updated.hostDeviceName,
            hostIp: updated.hostIp,
            hostHistory: updated.hostHistory,
            userRoles: updated.userRoles,
            tabRoles: updated.tabRoles,
            scorekeeperRequests: updated.scorekeeperRequests,
            demotedScorekeepers: updated.demotedScorekeepers,
          };
          if (Array.isArray(data.clients)) {
            this.remoteSync = { ...this.remoteSync, clients: data.clients };
          }
          this.persistSnapshot();
          if (this.channel) {
            try {
              this.channel.postMessage({ type: 'STATE_SYNC', sender: this.tabId, state: updated });
            } catch {
              // Ignore
            }
          }
          this.emit();
          return { ok: true, role: nextRole, state: updated };
        }
      } catch {
        // Fall through to local commit
      }
    }

    const updated = this.commit((s) => {
      const nextRoles = { ...(s.userRoles || {}) };
      if (nextRole === 'spectator') delete nextRoles[targetDeviceId];
      else nextRoles[targetDeviceId] = nextRole;
      return {
        ...s,
        userRoles: nextRoles,
        scorekeeperRequests: (s.scorekeeperRequests || []).filter(
          (r) => r && r.deviceId !== targetDeviceId
        ),
      };
    });
    return { ok: true, role: nextRole, state: updated };
  }

  async assignTabRole(targetTabId, role, targetDeviceId = '') {
    const target = this.programState || this.state;
    if (!target || !targetTabId) return { ok: false, error: 'Missing target session' };
    if (targetTabId === this.tabId) {
      return { ok: false, error: 'Cannot override the role of the session you are currently using' };
    }
    const adminIds = this.remoteSync.admins;
    const actorRole = resolveEffectiveRole(target, this.remoteSync.deviceId, this.tabId, {
      adminDeviceIds: adminIds,
    });
    const targetDeviceRole = resolveDeviceRole(target, targetDeviceId, {
      adminDeviceIds: adminIds,
    });
    const isOwnOtherTab = Boolean(
      this.remoteSync.deviceId && targetDeviceId && this.remoteSync.deviceId === targetDeviceId
    );
    const isClear = role === null || role === '' || role === 'inherit';
    const nextTabRole = isClear ? null : normalizeRole(role);

    if (!canAssignTabRole(actorRole, targetDeviceRole, nextTabRole, { isOwnOtherTab })) {
      return {
        ok: false,
        error: `Your role (${actorRole}) cannot set that tab to ${nextTabRole || 'Device Default'}`,
      };
    }

    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected) {
      try {
        const res = await fetch(`${baseUrl}/__sync/tournament/role`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            actorTabId: this.tabId,
            tournamentId: target.tournamentId,
            actorDeviceId: this.remoteSync.deviceId,
            targetDeviceId,
            targetTabId,
            role: isClear ? 'inherit' : nextTabRole,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: data.error || 'Could not update tab role' };
        const updated = data.state ? normalizePersistedState(data.state) : null;
        if (updated) {
          this.programState = updated;
          this.state = {
            ...this.state,
            hostDeviceId: updated.hostDeviceId,
            hostDeviceName: updated.hostDeviceName,
            hostIp: updated.hostIp,
            hostHistory: updated.hostHistory,
            userRoles: updated.userRoles,
            tabRoles: updated.tabRoles,
            scorekeeperRequests: updated.scorekeeperRequests,
            demotedScorekeepers: updated.demotedScorekeepers,
          };
          if (Array.isArray(data.clients)) {
            this.remoteSync = { ...this.remoteSync, clients: data.clients };
          }
          this.persistSnapshot();
          if (this.channel) {
            try {
              this.channel.postMessage({ type: 'STATE_SYNC', sender: this.tabId, state: updated });
            } catch {
              // Ignore
            }
          }
          this.emit();
          return { ok: true, role: nextTabRole || 'inherit', state: updated };
        }
      } catch {
        // Fall through to local commit
      }
    }

    const updated = this.commit((s) => {
      const nextTabRoles = { ...(s.tabRoles || {}) };
      if (isClear) delete nextTabRoles[targetTabId];
      else nextTabRoles[targetTabId] = nextTabRole;
      return {
        ...s,
        tabRoles: nextTabRoles,
      };
    });
    return { ok: true, role: nextTabRole || 'inherit', state: updated };
  }

  async requestTournamentJoinAccess(tournamentId) {
    if (!tournamentId) return { ok: false, error: 'Missing tournament ID' };
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined') {
      return { ok: false, error: 'Not connected to sync server' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/tournament/request-join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.tabId,
          tournamentId,
          deviceId: this.remoteSync.deviceId,
          deviceName: this.remoteSync.deviceName,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Could not request access' };
      // Ensure SSE is connected so the requesting user receives real-time Approved / Access Denied events!
      if (!this.eventSource) {
        this.suppressAutoReconnect = false;
        this.connectRemoteSync({ force: true });
      }
      if (Array.isArray(data.tournaments)) {
        this.remoteSync = {
          ...this.remoteSync,
          cloudTournaments: data.tournaments,
          ...(data.totalCloudTournaments !== undefined
            ? { totalCloudTournaments: Number(data.totalCloudTournaments) }
            : {}),
          ...(data.privateCloudCount !== undefined
            ? { privateCloudCount: Number(data.privateCloudCount) }
            : {}),
        };
        this.emit();
      }
      return {
        ok: true,
        approved: Boolean(data.approved),
        pending: Boolean(data.pending),
        state: data.state || null,
      };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  async resolveTournamentJoinRequest(targetDeviceId, approve) {
    const target = this.programState || this.state;
    if (!target || !targetDeviceId) return { ok: false, error: 'Invalid request' };
    const actorRole = resolveEffectiveRole(target, this.remoteSync.deviceId, this.tabId, {
      adminDeviceIds: this.remoteSync.admins,
    });
    if (!getRolePermissions(actorRole).canApproveRequests) {
      return { ok: false, error: 'Only admin, host, or moderator can resolve join requests' };
    }
    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected) {
      try {
        const res = await fetch(`${baseUrl}/__sync/tournament/resolve-join-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            tournamentId: target.tournamentId,
            actorDeviceId: this.remoteSync.deviceId,
            targetDeviceId,
            approve: Boolean(approve),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: data.error || 'Could not resolve join request' };
        const updated = data.state ? normalizePersistedState(data.state) : null;
        if (updated) {
          this.programState = updated;
          this.state = {
            ...this.state,
            joinRequests: updated.joinRequests,
          };
          if (Array.isArray(data.clients)) {
            this.remoteSync = { ...this.remoteSync, clients: data.clients };
          }
          this.persistSnapshot();
          this.emit();
        }
        return { ok: true, approved: Boolean(approve) };
      } catch {
        return { ok: false, error: 'Unable to reach sync server' };
      }
    }
    return { ok: false, error: 'Not connected to sync server' };
  }

  clearJoinResolutionNotice() {
    if (!this.remoteSync.joinResolutionNotice) return;
    this.remoteSync = { ...this.remoteSync, joinResolutionNotice: null };
    this.emit();
  }

  clearScorekeeperResolutionNotice() {
    if (!this.remoteSync.scorekeeperResolutionNotice) return;
    this.remoteSync = { ...this.remoteSync, scorekeeperResolutionNotice: null };
    this.emit();
  }

  async requestScorekeeperAccess() {
    const target = this.programState || this.state;
    if (!target) return { ok: false, error: 'No active tournament' };
    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected) {
      try {
        const res = await fetch(`${baseUrl}/__sync/tournament/request-scorekeeper`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            tournamentId: target.tournamentId,
            deviceId: this.remoteSync.deviceId,
            deviceName: this.remoteSync.deviceName,
            joinCode: this.remoteSync.unlockedGuestKeys?.[target.tournamentId] || '',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: data.error || 'Request failed' };
        const updated = data.state ? normalizePersistedState(data.state) : null;
        if (updated) {
          this.programState = updated;
          this.state = {
            ...this.state,
            userRoles: updated.userRoles,
            scorekeeperRequests: updated.scorekeeperRequests,
          };
          if (Array.isArray(data.clients)) {
            this.remoteSync = { ...this.remoteSync, clients: data.clients };
          }
          this.emit();
        }
        return {
          ok: true,
          approved: Boolean(data.approved),
          pending: Boolean(data.pending),
          role: data.role || 'spectator',
        };
      } catch {
        return { ok: false, error: 'Unable to reach sync server' };
      }
    }
    return { ok: false, error: 'Not connected to sync server' };
  }

  async resolveScorekeeperRequest(targetDeviceId, approve) {
    const target = this.programState || this.state;
    if (!target || !targetDeviceId) return { ok: false, error: 'Invalid request' };
    const actorRole = resolveEffectiveRole(target, this.remoteSync.deviceId, this.tabId, {
      adminDeviceIds: this.remoteSync.admins,
    });
    if (!getRolePermissions(actorRole).canApproveRequests) {
      return { ok: false, error: 'Only admin, host, or moderator can resolve requests' };
    }
    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected) {
      try {
        const res = await fetch(`${baseUrl}/__sync/tournament/resolve-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            tournamentId: target.tournamentId,
            actorDeviceId: this.remoteSync.deviceId,
            targetDeviceId,
            approve: Boolean(approve),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: data.error || 'Could not resolve request' };
        const updated = data.state ? normalizePersistedState(data.state) : null;
        if (updated) {
          this.programState = updated;
          this.state = {
            ...this.state,
            userRoles: updated.userRoles,
            scorekeeperRequests: updated.scorekeeperRequests,
          };
          if (Array.isArray(data.clients)) {
            this.remoteSync = { ...this.remoteSync, clients: data.clients };
          }
          this.persistSnapshot();
          this.emit();
        }
        return { ok: true, approved: Boolean(approve) };
      } catch {
        return { ok: false, error: 'Unable to reach sync server' };
      }
    }
    return { ok: false, error: 'Not connected to sync server' };
  }

  async claimTournamentHost(tournamentIdOverride = null) {
    const target = this.programState || this.state;
    const targetId = tournamentIdOverride || target?.tournamentId;
    if (!targetId) return { ok: false, error: 'No active tournament' };
    const isAdmin = Boolean(this.remoteSync.isThisDeviceAdmin);
    if (!tournamentIdOverride && target) {
      if (target.destruction) {
        if (!isAdmin && !isPreviousTournamentHost(target, this.remoteSync.deviceId)) {
          return {
            ok: false,
            error: 'Only a Hub Admin or previous host of this tournament can claim and cancel destruction',
          };
        }
      } else if (!isAdmin && target.hostDeviceId && target.hostDeviceId !== this.remoteSync.deviceId) {
        return { ok: false, error: `Already hosted by ${target.hostDeviceName || 'another device'}` };
      }
    }

    if (this.localDestroyTimer) {
      clearTimeout(this.localDestroyTimer);
      this.localDestroyTimer = null;
    }

    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected) {
      try {
        const res = await fetch(`${baseUrl}/__sync/tournament/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            tournamentId: targetId,
            deviceId: this.remoteSync.deviceId,
            deviceName: this.remoteSync.deviceName,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.state) {
          const updated = normalizePersistedState(data.state);
          if (updated) {
            const matchesCurrent =
              !tournamentIdOverride || this.programState?.tournamentId === updated.tournamentId;
            if (matchesCurrent) {
              this.hasActiveTournament = true;
              this.programState = updated;
              this.state = {
                ...this.state,
                hostDeviceId: updated.hostDeviceId,
                hostDeviceName: updated.hostDeviceName,
                hostIp: updated.hostIp,
                hostHistory: updated.hostHistory,
                destruction: null,
                access: updated.access,
              };
            }
            const nextHosts = Array.isArray(data.hosts) ? data.hosts : this.remoteSync.hosts;
            this.remoteSync = {
              ...this.remoteSync,
              hosts: nextHosts,
              hostDevice: data.hostDevice || this.remoteSync.hostDevice,
              isThisDeviceHost: true,
              ...(matchesCurrent ? { currentRole: 'host', activeSource: 'cloud' } : {}),
              ...(Array.isArray(data.tournaments) ? { cloudTournaments: data.tournaments } : {}),
              ...(data.totalCloudTournaments !== undefined
                ? { totalCloudTournaments: Number(data.totalCloudTournaments) }
                : {}),
              ...(data.privateCloudCount !== undefined
                ? { privateCloudCount: Number(data.privateCloudCount) }
                : {}),
            };
            if (matchesCurrent) this.persistSnapshot();
            this.emit();
            return {
              ok: true,
              cancelledDestruction: Boolean(data.cancelledDestruction),
              state: updated,
            };
          }
        } else if (res.status === 403) {
          return { ok: false, error: data.error || 'Tournament already claimed by another host' };
        }
      } catch {
        // Fall through to local claim
      }
    }

    const hadLocalDestruction = Boolean(target?.destruction);
    const updated = this.commit((s) => ({
      ...s,
      hostDeviceId: this.remoteSync.deviceId,
      hostDeviceName: this.remoteSync.deviceName,
      hostHistory: Array.from(
        new Set([...(s.hostHistory || []), ...(s.hostDeviceId ? [s.hostDeviceId] : []), this.remoteSync.deviceId])
      ),
      destruction: null,
      access: {
        isPublic: s.access?.isPublic !== undefined ? Boolean(s.access.isPublic) : true,
        isSecure: true,
      },
    }));
    this.remoteSync = { ...this.remoteSync, isThisDeviceHost: true, currentRole: 'host' };
    this.emit();
    return { ok: true, cancelledDestruction: hadLocalDestruction, state: updated };
  }

  async abandonTournamentHost(tournamentIdOverride = null) {
    const target = this.programState || this.state;
    const targetId = tournamentIdOverride || target?.tournamentId;
    if (!targetId) return { ok: false, error: 'No active tournament' };
    const isAdmin = Boolean(this.remoteSync.isThisDeviceAdmin);
    if (
      !tournamentIdOverride &&
      target?.hostDeviceId &&
      target.hostDeviceId !== this.remoteSync.deviceId &&
      !isAdmin
    ) {
      return { ok: false, error: 'Only the current host or a Hub Admin can abandon this tournament' };
    }

    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected) {
      try {
        const res = await fetch(`${baseUrl}/__sync/tournament/abandon`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            tournamentId: targetId,
            deviceId: this.remoteSync.deviceId,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.state) {
          const updated = normalizePersistedState(data.state);
          if (updated) {
            const matchesCurrent =
              !tournamentIdOverride || this.programState?.tournamentId === updated.tournamentId;
            if (matchesCurrent) {
              this.programState = updated;
              this.state = {
                ...this.state,
                hostDeviceId: null,
                hostDeviceName: 'Sync Host',
                hostIp: null,
                hostHistory: updated.hostHistory,
                access: { isPublic: true, isSecure: false },
              };
            }
            this.remoteSync = {
              ...this.remoteSync,
              ...(matchesCurrent ? { currentRole: isAdmin ? 'admin' : 'unclaimed' } : {}),
              ...(Array.isArray(data.tournaments) ? { cloudTournaments: data.tournaments } : {}),
              ...(data.totalCloudTournaments !== undefined
                ? { totalCloudTournaments: Number(data.totalCloudTournaments) }
                : {}),
              ...(data.privateCloudCount !== undefined
                ? { privateCloudCount: Number(data.privateCloudCount) }
                : {}),
            };
            if (matchesCurrent) this.persistSnapshot();
            this.emit();
            return { ok: true, state: updated };
          }
        } else if (res.status === 403) {
          return { ok: false, error: data.error || 'Only the host or Hub Admin can abandon this tournament' };
        }
      } catch {
        // Fall through to local abandon
      }
    }

    const updated = this.commit((s) => ({
      ...s,
      hostHistory: Array.from(
        new Set([...(s.hostHistory || []), ...(s.hostDeviceId ? [s.hostDeviceId] : []), this.remoteSync.deviceId])
      ),
      hostDeviceId: null,
      hostDeviceName: 'Sync Host',
      hostIp: null,
      access: { isPublic: true, isSecure: false },
    }));
    this.remoteSync = { ...this.remoteSync, currentRole: 'unclaimed' };
    this.emit();
    return { ok: true, state: updated };
  }

  async scheduleTournamentDestruction({ delayMs = 5 * 60 * 1000, tournamentIdOverride = null } = {}) {
    const target = this.programState || this.state;
    const targetId = tournamentIdOverride || target?.tournamentId;
    if (!targetId) return { ok: false, error: 'No active tournament' };
    const isAdmin = Boolean(this.remoteSync.isThisDeviceAdmin);
    if (
      !tournamentIdOverride &&
      target?.hostDeviceId &&
      target.hostDeviceId !== this.remoteSync.deviceId &&
      !isAdmin
    ) {
      return { ok: false, error: 'Only the current host or a Hub Admin can destroy this tournament' };
    }

    const baseUrl = this.getSyncBaseUrl();
    if (
      baseUrl &&
      typeof fetch !== 'undefined' &&
      this.remoteSync.connected &&
      (tournamentIdOverride || this.remoteSync.activeSource === 'cloud')
    ) {
      try {
        const res = await fetch(`${baseUrl}/__sync/tournament/destroy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            tournamentId: targetId,
            deviceId: this.remoteSync.deviceId,
            deviceName: this.remoteSync.deviceName,
            delayMs,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.state) {
          const updated = normalizePersistedState(data.state);
          if (updated) {
            const matchesCurrent =
              !tournamentIdOverride || this.programState?.tournamentId === updated.tournamentId;
            if (matchesCurrent) {
              this.programState = updated;
              this.state = {
                ...this.state,
                hostDeviceId: null,
                hostDeviceName: 'Sync Host',
                hostIp: null,
                hostHistory: updated.hostHistory,
                destruction: updated.destruction,
              };
            }
            this.remoteSync = {
              ...this.remoteSync,
              ...(Array.isArray(data.tournaments) ? { cloudTournaments: data.tournaments } : {}),
              ...(data.totalCloudTournaments !== undefined
                ? { totalCloudTournaments: Number(data.totalCloudTournaments) }
                : {}),
              ...(data.privateCloudCount !== undefined
                ? { privateCloudCount: Number(data.privateCloudCount) }
                : {}),
            };
            if (matchesCurrent) this.persistSnapshot();
            this.emit();
            return { ok: true, destruction: updated.destruction, state: updated };
          }
        } else if (res.status === 403) {
          return { ok: false, error: data.error || 'Only the current host or Hub Admin can destroy this tournament' };
        }
      } catch {
        // Fall through to local timer
      }
    }

    // Local-only tournament fallback with 5-minute grace timer
    const now = Date.now();
    const destruction = {
      scheduledAt: now,
      destroyAt: now + delayMs,
      initiatedByDeviceId: this.remoteSync.deviceId,
      initiatedByName: this.remoteSync.deviceName || 'Host',
    };
    const updated = this.commit((s) => ({
      ...s,
      hostHistory: Array.from(
        new Set([...(s.hostHistory || []), ...(s.hostDeviceId ? [s.hostDeviceId] : []), this.remoteSync.deviceId])
      ),
      hostDeviceId: null,
      hostDeviceName: 'Sync Host',
      hostIp: null,
      destruction,
    }));
    if (this.localDestroyTimer) clearTimeout(this.localDestroyTimer);
    const localId = updated.tournamentId;
    const localName = updated.tournamentName;
    this.localDestroyTimer = setTimeout(() => {
      this.localDestroyTimer = null;
      if (this.programState?.tournamentId === localId && this.programState?.destruction) {
        this.deleteTournament(localId);
        this.handleTournamentDestroyed(localId, localName);
      }
    }, Math.max(50, delayMs));
    if (typeof this.localDestroyTimer.unref === 'function') this.localDestroyTimer.unref();
    return { ok: true, destruction, state: updated };
  }

  async rotateTournamentJoinKey() {
    const target = this.programState || this.state;
    if (!target) return { ok: false, error: 'No active tournament' };
    if (!canDeviceAccessHostControls(target, this.remoteSync)) {
      return { ok: false, error: 'Only the host can generate a new tournament key' };
    }

    const baseUrl = this.getSyncBaseUrl();
    if (
      baseUrl &&
      typeof fetch !== 'undefined' &&
      this.remoteSync.connected &&
      this.remoteSync.activeSource === 'cloud'
    ) {
      try {
        const res = await fetch(`${baseUrl}/__sync/tournament/rotate-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: this.tabId,
            tournamentId: target.tournamentId,
            deviceId: this.remoteSync.deviceId,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { ok: false, error: data.error || 'Could not generate a new key' };
        }
        const updated = data.state ? normalizePersistedState(data.state) : null;
        if (updated) {
          this.programState = updated;
          this.state = { ...this.state, joinCode: updated.joinCode };
          if (Array.isArray(data.tournaments)) {
            this.remoteSync = {
              ...this.remoteSync,
              cloudTournaments: data.tournaments,
              totalCloudTournaments:
                data.totalCloudTournaments !== undefined
                  ? Number(data.totalCloudTournaments)
                  : data.tournaments.length,
              privateCloudCount:
                data.privateCloudCount !== undefined ? Number(data.privateCloudCount) : 0,
            };
          }
          this.persistSnapshot();
          this.emit();
          return { ok: true, joinCode: updated.joinCode, state: updated };
        }
      } catch {
        // Fall through to local key rotation
      }
    }

    const taken = new Set([target.joinCode].filter(Boolean));
    const nextCode = generateFourWordId(taken);
    const updated = this.commit((s) => ({
      ...s,
      joinCode: nextCode,
    }));
    return { ok: true, joinCode: nextCode, state: updated };
  }

  async disconnectClient({
    targetTabId,
    targetDeviceId,
    tournamentId = undefined,
    reason = 'Kicked by host',
  } = {}) {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined') {
      return { ok: false, error: 'Sync server unreachable' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/clients/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: tournamentId !== undefined ? tournamentId : this.programState?.tournamentId || null,
          deviceId: this.remoteSync.deviceId,
          targetTabId,
          targetDeviceId,
          reason,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data.error || 'Could not disconnect client' };
      }
      if (Array.isArray(data.clients)) {
        this.remoteSync = {
          ...this.remoteSync,
          connectedClients: data.connectedClients ?? data.clients.length,
          clients: data.clients,
        };
        this.emit();
      }
      return { ok: true, disconnectedCount: data.disconnectedCount || 0 };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  // ---- Hub Admin Actions (Hub-Wide Server Administration) ----

  applyAdminResponse(data) {
    if (!data || typeof data !== 'object') return;
    const nextAdmins = Array.isArray(data.admins) ? data.admins : this.remoteSync.admins;
    const isAdminNow =
      data.isAdmin !== undefined
        ? Boolean(data.isAdmin)
        : isHubAdminDevice(this.remoteSync.deviceId, nextAdmins);
    this.remoteSync = {
      ...this.remoteSync,
      admins: nextAdmins,
      isThisDeviceAdmin: isAdminNow,
      adminKey: isAdminNow ? data.adminKey || this.remoteSync.adminKey || null : null,
      hubSettings:
        data.hubSettings && typeof data.hubSettings === 'object'
          ? { ...this.remoteSync.hubSettings, ...data.hubSettings }
          : this.remoteSync.hubSettings,
      ...(Array.isArray(data.tournaments) ? { cloudTournaments: data.tournaments } : {}),
      ...(data.totalCloudTournaments !== undefined
        ? { totalCloudTournaments: Number(data.totalCloudTournaments) }
        : {}),
      ...(data.privateCloudCount !== undefined
        ? { privateCloudCount: Number(data.privateCloudCount) }
        : {}),
      ...(Array.isArray(data.clients)
        ? { connectedClients: data.clients.length, clients: data.clients }
        : {}),
    };
    this.emit();
  }

  async claimLocalHubAdmin() {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined') {
      return { ok: false, error: 'Sync server unreachable' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/admin/claim-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.tabId,
          deviceId: this.remoteSync.deviceId,
          deviceName: this.remoteSync.deviceName,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Could not enable local Hub Admin' };
      this.applyAdminResponse(data);
      return { ok: true, ...data };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  async unlockHubAdminWithKey(key) {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined') {
      return { ok: false, error: 'Sync server unreachable' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/admin/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.tabId,
          deviceId: this.remoteSync.deviceId,
          deviceName: this.remoteSync.deviceName,
          key: String(key || '').trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Invalid Hub Admin Key' };
      this.applyAdminResponse(data);
      return { ok: true, ...data };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  async setDeviceHubAdmin(targetDeviceId, grant = true, { deviceName = '', ip = '' } = {}) {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined') {
      return { ok: false, error: 'Sync server unreachable' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/admin/grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.tabId,
          actorDeviceId: this.remoteSync.deviceId,
          targetDeviceId,
          targetDeviceName: deviceName,
          targetIp: ip,
          grant: Boolean(grant),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Could not update Hub Admin status' };
      this.applyAdminResponse(data);
      return { ok: true, ...data };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  async rotateHubAdminKey() {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined') {
      return { ok: false, error: 'Sync server unreachable' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/admin/rotate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.tabId,
          actorDeviceId: this.remoteSync.deviceId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Could not rotate Hub Admin Key' };
      this.applyAdminResponse(data);
      return { ok: true, adminKey: data.adminKey };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  async updateHubSettings(settingsPatch) {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined') {
      return { ok: false, error: 'Sync server unreachable' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/admin/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: this.tabId,
          actorDeviceId: this.remoteSync.deviceId,
          settings: settingsPatch,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Could not update Hub settings' };
      this.applyAdminResponse(data);
      return { ok: true, hubSettings: data.hubSettings };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  clearKickedNotice() {
    if (!this.remoteSync.kickedNotice) return;
    this.remoteSync = { ...this.remoteSync, kickedNotice: null };
    this.emit();
  }

  clearUserMessage() {
    if (!this.remoteSync.lastUserMessage) return;
    this.remoteSync = { ...this.remoteSync, lastUserMessage: null };
    this.emit();
  }

  markInboxRead() {
    const cur = Array.isArray(this.remoteSync.inboxMessages) ? this.remoteSync.inboxMessages : [];
    if (!cur.some((m) => !m.read)) return;
    const next = cur.map((m) => ({ ...m, read: true }));
    if (this.persistEnabled) saveInboxMessages(next);
    this.remoteSync = { ...this.remoteSync, inboxMessages: next };
    this.emit();
  }

  deleteInboxMessage(id) {
    const cur = Array.isArray(this.remoteSync.inboxMessages) ? this.remoteSync.inboxMessages : [];
    const next = cur.filter((m) => m.id !== id);
    if (this.persistEnabled) saveInboxMessages(next);
    this.remoteSync = { ...this.remoteSync, inboxMessages: next };
    this.emit();
  }

  clearInbox() {
    if (this.persistEnabled) saveInboxMessages([]);
    this.remoteSync = { ...this.remoteSync, inboxMessages: [] };
    this.emit();
  }

  async fetchTournamentChat(tournamentId = null) {
    const baseUrl = this.getSyncBaseUrl();
    const tid = tournamentId || this.programState?.tournamentId;
    if (!baseUrl || !tid || typeof fetch === 'undefined') return null;
    try {
      const qs = new URLSearchParams({
        tournamentId: tid,
        deviceId: this.remoteSync.deviceId || '',
      });
      const res = await fetch(`${baseUrl}/__sync/chat?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      this.remoteSync = {
        ...this.remoteSync,
        chatLiveMessages: Array.isArray(data.liveMessages) ? data.liveMessages : [],
        chatThreads: Array.isArray(data.threads) ? data.threads : [],
      };
      this.emit();
      return data;
    } catch {
      return null;
    }
  }

  async sendLiveChatMessage(text) {
    const baseUrl = this.getSyncBaseUrl();
    const tid = this.programState?.tournamentId;
    const cleaned = String(text || '').trim();
    if (!baseUrl || !tid || !cleaned || typeof fetch === 'undefined') {
      return { ok: false, error: 'Cannot send live chat message right now' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/chat/live`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: tid,
          deviceId: this.remoteSync.deviceId,
          deviceName: this.remoteSync.deviceName,
          tabId: this.tabId,
          text: cleaned,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Failed to send message' };
      if (data.message) {
        const prev = Array.isArray(this.remoteSync.chatLiveMessages)
          ? this.remoteSync.chatLiveMessages
          : [];
        if (!prev.some((m) => m.id === data.message.id)) {
          this.remoteSync = {
            ...this.remoteSync,
            chatLiveMessages: [...prev, data.message].slice(-250),
          };
          this.emit();
        }
      }
      return { ok: true, message: data.message };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  async deleteLiveChatMessage(messageId) {
    const baseUrl = this.getSyncBaseUrl();
    const tid = this.programState?.tournamentId;
    if (!baseUrl || !tid || !messageId || typeof fetch === 'undefined') {
      return { ok: false, error: 'Unable to delete message' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/chat/live/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: tid,
          deviceId: this.remoteSync.deviceId,
          tabId: this.tabId,
          messageId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Could not delete message' };
      const prev = Array.isArray(this.remoteSync.chatLiveMessages)
        ? this.remoteSync.chatLiveMessages
        : [];
      this.remoteSync = {
        ...this.remoteSync,
        chatLiveMessages: prev.filter((m) => m.id !== messageId),
      };
      this.emit();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  async createOrOpenChatThread({ targetDeviceIds = [], groupName = '', initialMessage = '' } = {}) {
    const baseUrl = this.getSyncBaseUrl();
    const tid = this.programState?.tournamentId;
    if (!baseUrl || !tid || typeof fetch === 'undefined') {
      return { ok: false, error: 'Sync server unreachable' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/chat/thread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: tid,
          deviceId: this.remoteSync.deviceId,
          deviceName: this.remoteSync.deviceName,
          tabId: this.tabId,
          targetDeviceIds,
          groupName,
          initialMessage,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Could not start chat' };
      if (data.thread) {
        const prev = Array.isArray(this.remoteSync.chatThreads) ? this.remoteSync.chatThreads : [];
        const nextThreads = [data.thread, ...prev.filter((t) => t.id !== data.thread.id)].sort(
          (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        );
        this.remoteSync = { ...this.remoteSync, chatThreads: nextThreads };
        this.emit();
      }
      return { ok: true, thread: data.thread, message: data.message };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  async sendThreadMessage(threadId, text) {
    const baseUrl = this.getSyncBaseUrl();
    const tid = this.programState?.tournamentId;
    const cleaned = String(text || '').trim();
    if (!baseUrl || !tid || !threadId || !cleaned || typeof fetch === 'undefined') {
      return { ok: false, error: 'Cannot send message right now' };
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: tid,
          threadId,
          deviceId: this.remoteSync.deviceId,
          deviceName: this.remoteSync.deviceName,
          tabId: this.tabId,
          text: cleaned,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Failed to send message' };
      if (data.thread) {
        const prev = Array.isArray(this.remoteSync.chatThreads) ? this.remoteSync.chatThreads : [];
        const nextThreads = [data.thread, ...prev.filter((t) => t.id !== data.thread.id)].sort(
          (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        );
        this.remoteSync = { ...this.remoteSync, chatThreads: nextThreads };
        this.emit();
      }
      return { ok: true, thread: data.thread, message: data.message };
    } catch {
      return { ok: false, error: 'Unable to reach sync server' };
    }
  }

  markLiveChatRead() {
    const tid = this.programState?.tournamentId || this.state?.tournamentId || '';
    const hasTUnread = Boolean(tid && this.remoteSync.unreadByTournament?.[tid]?.live);
    if (!this.remoteSync.unreadLiveChat && !hasTUnread) return;
    const nextByT = { ...(this.remoteSync.unreadByTournament || {}) };
    if (tid && nextByT[tid]) {
      nextByT[tid] = { ...nextByT[tid], live: 0 };
    }
    this.remoteSync = {
      ...this.remoteSync,
      unreadLiveChat: 0,
      unreadByTournament: nextByT,
    };
    this.emit();
  }

  markThreadRead(threadId) {
    if (!threadId || !this.remoteSync.unreadThreadCounts?.[threadId]) return;
    const cleared = Number(this.remoteSync.unreadThreadCounts[threadId]) || 0;
    const next = { ...(this.remoteSync.unreadThreadCounts || {}) };
    delete next[threadId];
    const tid = this.programState?.tournamentId || this.state?.tournamentId || '';
    const nextByT = { ...(this.remoteSync.unreadByTournament || {}) };
    if (tid && nextByT[tid]) {
      nextByT[tid] = {
        ...nextByT[tid],
        dm: Math.max(0, (nextByT[tid].dm || 0) - cleared),
      };
    }
    this.remoteSync = {
      ...this.remoteSync,
      unreadThreadCounts: next,
      unreadByTournament: nextByT,
    };
    this.emit();
  }

  async claimPlayer(playerId) {
    const devId = this.remoteSync.deviceId;
    if (!devId) return { ok: false, error: 'Device ID unavailable' };
    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected) {
      try {
        const res = await fetch(`${baseUrl}/__sync/player-claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: devId,
            tabId: this.tabId,
            tournamentId: this.programState?.tournamentId || this.state?.tournamentId || '',
            playerId,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: data.error || 'Could not claim player' };
        this.applyLocalPlayerClaims(data.playerClaims);
        return { ok: true, playerClaims: data.playerClaims };
      } catch {
        return { ok: false, error: 'Could not reach LAN sync server' };
      }
    }
    // Local offline fallback
    const curClaims = { ...(this.state.playerClaims || {}) };
    if (curClaims[devId]) {
      return {
        ok: false,
        error: 'Once claimed, only a Moderator or Host can change or release a player claim.',
      };
    }
    curClaims[devId] = playerId;
    this.commit((s) => ({ ...s, playerClaims: curClaims }), { forcePublish: true });
    return { ok: true, playerClaims: curClaims };
  }

  async managePlayerClaim(targetDeviceId, playerId = null) {
    const devId = this.remoteSync.deviceId;
    if (!targetDeviceId) return { ok: false, error: 'Target device is required' };
    const baseUrl = this.getSyncBaseUrl();
    if (baseUrl && typeof fetch !== 'undefined' && this.remoteSync.connected) {
      try {
        const res = await fetch(`${baseUrl}/__sync/player-claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: devId,
            tabId: this.tabId,
            tournamentId: this.programState?.tournamentId || this.state?.tournamentId || '',
            targetDeviceId,
            playerId,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: data.error || 'Could not update player claim' };
        this.applyLocalPlayerClaims(data.playerClaims);
        return { ok: true, playerClaims: data.playerClaims };
      } catch {
        return { ok: false, error: 'Could not reach LAN sync server' };
      }
    }
    const curClaims = { ...(this.state.playerClaims || {}) };
    if (!playerId) {
      delete curClaims[targetDeviceId];
    } else {
      for (const [d, p] of Object.entries(curClaims)) {
        if (p === playerId) delete curClaims[d];
      }
      curClaims[targetDeviceId] = playerId;
    }
    this.commit((s) => ({ ...s, playerClaims: curClaims }), { forcePublish: true });
    return { ok: true, playerClaims: curClaims };
  }

  applyLocalPlayerClaims(claims) {
    if (!claims || typeof claims !== 'object') return;
    this.programState = { ...this.programState, playerClaims: { ...claims } };
    this.state = { ...this.state, playerClaims: { ...claims } };
    this.emit();
  }

  async sendUserMessage({
    targetTabId = '',
    targetDeviceId = '',
    message = '',
    broadcast = false,
    kind = 'message',
    title = '',
    sticky = false,
    dismissOnCountdown = false,
    dismissAt = null,
    clearBanner = false,
  } = {}) {
    const baseUrl = this.getSyncBaseUrl();
    if (!baseUrl || typeof fetch === 'undefined') {
      return { ok: false, error: 'Sync server unavailable' };
    }
    const activeState = this.programState || this.state;
    const myClaimPid = activeState?.playerClaims?.[this.remoteSync.deviceId] || null;
    const myClaimName = myClaimPid
      ? resolveClaimedPlayer(activeState, myClaimPid)?.name || ''
      : '';
    try {
      const res = await fetch(`${baseUrl}/__sync/notify-client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: this.remoteSync.deviceId,
          tabId: this.tabId,
          tournamentId: this.programState?.tournamentId || this.state?.tournamentId || '',
          fromName: myClaimName || this.remoteSync.deviceName || 'Host',
          targetTabId,
          targetDeviceId,
          broadcast,
          kind,
          title,
          sticky,
          dismissOnCountdown,
          dismissAt,
          clearBanner,
          message,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || 'Could not send message' };
      if (clearBanner || Object.prototype.hasOwnProperty.call(data, 'activeBanner')) {
        const nextBanner = clearBanner ? null : data.activeBanner ?? null;
        this.programState = {
          ...this.programState,
          presentation: { ...(this.programState.presentation || {}), activeBanner: nextBanner },
        };
        this.state = {
          ...this.state,
          presentation: { ...(this.state.presentation || {}), activeBanner: nextBanner },
        };
        this.emit();
      }
      return { ok: true, deliveredCount: data.deliveredCount ?? 0 };
    } catch {
      return { ok: false, error: 'Could not reach LAN sync server' };
    }
  }

  /**
   * Computes a tiny deterministic stagger so Control tabs trigger idle banter first,
   * while secondary views (Presentation/Scorekeeper) seamlessly take over as failover
   * if Control View isn't open.
   */
  getGrandmaLeaderOffsetMs() {
    if (typeof window === 'undefined') return 0;
    if (this.remoteSync?.isThisDeviceHost) return 0;
    const path = window.location.pathname.toLowerCase();
    const isSecondary =
      path.startsWith('/present') ||
      path.startsWith('/spectator') ||
      path.startsWith('/score') ||
      path.startsWith('/debug') ||
      path.startsWith('/host') ||
      path.startsWith('/system') ||
      Boolean(window.opener);
    let hash = 0;
    for (let i = 0; i < this.tabId.length; i++) {
      hash = (hash * 31 + this.tabId.charCodeAt(i)) % 350;
    }
    return (isSecondary ? 750 : 0) + hash;
  }

  startGrandmaEngine() {
    if (this.grandmaTimer) return;
    const leaderOffsetMs = this.getGrandmaLeaderOffsetMs();
    this.grandmaTimer = setInterval(() => {
      this.tickGrandmaEngine(Date.now(), leaderOffsetMs);
    }, 450);
    if (typeof this.grandmaTimer.unref === 'function') {
      this.grandmaTimer.unref();
    }
  }

  tickGrandmaEngine(now = Date.now(), leaderOffsetMs = 0) {
    if (!this.hasActiveTournament || this.isOnHub) return null;
    if (this.programState?.rules?.grandmaEnabled === false || this.state?.rules?.grandmaEnabled === false) {
      return null;
    }
    const g = this.programState?.grandma;
    if (!g) return null;

    // If a speech bubble is currently visible, let it finish cleanly
    const active = g.activeSpeech;
    if (active && Number(active.expiresAt) > now) {
      return null;
    }

    const dueAt = Number(g.nextBanterAt ?? active?.nextBanterAt ?? 0);
    if (dueAt > 0 && now < dueAt + leaderOffsetMs) {
      return null;
    }

    // Re-check localStorage right before speaking so two tabs never collide on the same tick
    if (this.persistEnabled && typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          const storedSpeech = parsed?.grandma?.activeSpeech;
          const storedNext = Number(parsed?.grandma?.nextBanterAt ?? storedSpeech?.nextBanterAt ?? 0);
          if (
            (storedSpeech && Number(storedSpeech.expiresAt) > now) ||
            storedNext > now
          ) {
            if (storedSpeech && storedSpeech.id !== active?.id) {
              this.handleExternalGrandmaSpeech(storedSpeech);
            }
            return null;
          }
        }
      } catch {
        // Proceed if storage read fails
      }
    }

    return this.triggerNextBanterQuote({ now });
  }

  triggerNextBanterQuote({ now = Date.now(), randomFn = Math.random } = {}) {
    const ctxState = this.programState || this.state;
    const g = ctxState?.grandma;
    const list =
      Array.isArray(g?.banterQuotes) && g.banterQuotes.length > 0
        ? g.banterQuotes
        : DEFAULT_BANTER_QUOTES;
    const lastText = g?.activeSpeech?.text || '';
    const phrase = pickRandomPhrase(list, lastText);
    if (!phrase) return null;
    const resolvedText = resolveGrandmaPhrase(phrase, ctxState);

    const speech = createGrandmaSpeech({
      text: resolvedText,
      category: 'banter',
      grandmaConfig: g,
      now,
      randomFn,
    });
    if (!speech) return null;
    return this.broadcastGrandmaSpeech(speech);
  }

  broadcastGrandmaSpeech(speech) {
    if (!speech) return null;
    if (this.state?.rules?.grandmaEnabled === false) return null;
    const applySpeech = (target) => ({
      ...target,
      grandma: {
        ...target.grandma,
        activeSpeech: speech,
        nextBanterAt: speech.nextBanterAt,
        ...(speech.isLive ? { liveQuote: speech } : {}),
      },
      updatedAt: Math.max(Date.now(), (target.updatedAt || 0) + 1),
    });

    this.state = applySpeech(this.state);
    this.programState = applySpeech(this.programState);

    if (this.persistEnabled && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.programState));
      } catch {
        // Ignore storage quota errors
      }
      this.persistStudioDraft();
    }

    if (this.channel) {
      try {
        this.channel.postMessage({
          type: 'GRANDMA_SPEECH',
          sender: this.tabId,
          activeSpeech: speech,
        });
      } catch {
        // Ignore channel post errors
      }
    }

    this.pushGrandmaSpeechToRemote(speech);
    this.emit();
    return speech;
  }

  handleExternalGrandmaSpeech(speech, { liveArrival = false } = {}) {
    if (!speech || !speech.id) return;
    if (this.programState?.grandma?.activeSpeech?.id === speech.id) return;

    const rebased = this.rebaseGrandmaSpeechToLocalClock(speech, { liveArrival });
    const applySpeech = (target) => ({
      ...target,
      grandma: {
        ...target.grandma,
        activeSpeech: rebased,
        nextBanterAt: rebased.nextBanterAt,
        ...(rebased.isLive ? { liveQuote: rebased } : {}),
      },
    });

    this.programState = applySpeech(this.programState);
    this.state = applySpeech(this.state);
    this.emit();
  }

  isStudioActive() {
    return this.syncMode === 'studio' && this.activeViewMode === 'control';
  }

  setActiveViewMode(viewMode) {
    const normalized =
      viewMode === 'present' ||
        viewMode === 'spectator' ||
        viewMode === 'scorekeeper' ||
        viewMode === 'users' ||
        viewMode === 'system'
        ? viewMode
        : viewMode === 'debug'
          ? 'system'
          : 'control';
    if (normalized === this.activeViewMode) return this.activeViewMode;

    // If leaving Control View with a pending Studio score push, flush it live cleanly
    if (this.activeViewMode === 'control' && this.pendingScorePush) {
      this.flushPendingScorePush();
    }

    this.activeViewMode = normalized;
    this.pushClientStatusToRemote();

    // When returning to Control View, restore any persisted Studio draft cleanly
    if (normalized === 'control' && this.syncMode === 'live' && this.persistEnabled) {
      const studioDraft = loadPersistedStudioDraft();
      if (studioDraft?.syncMode === 'studio') {
        this.syncMode = 'studio';
        this.hasUnpublishedChanges = Boolean(studioDraft.hasUnpublishedChanges);
        if (studioDraft.stagedState) {
          this.state = {
            ...studioDraft.stagedState,
            matches: this.programState.matches,
            activeMatchId: this.programState.activeMatchId,
            championId: this.programState.championId,
            lastPointAt: Math.max(
              studioDraft.stagedState.lastPointAt || 0,
              this.programState.lastPointAt || 0
            ),
            grandma: {
              ...studioDraft.stagedState.grandma,
              activeSpeech:
                this.programState.grandma?.activeSpeech ??
                studioDraft.stagedState.grandma?.activeSpeech ??
                null,
              nextBanterAt:
                this.programState.grandma?.nextBanterAt ??
                studioDraft.stagedState.grandma?.nextBanterAt,
            },
          };
        }
      }
    }

    this.emit();
    return this.activeViewMode;
  }

  readSharedLastPointAt() {
    if (!this.persistEnabled || typeof localStorage === 'undefined') return 0;
    try {
      const raw = localStorage.getItem(LAST_POINT_STORAGE_KEY);
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  writeSharedLastPointAt(ts) {
    if (this.persistEnabled && typeof localStorage !== 'undefined') {
      try {
        if (ts > 0) {
          localStorage.setItem(LAST_POINT_STORAGE_KEY, String(ts));
        } else {
          localStorage.removeItem(LAST_POINT_STORAGE_KEY);
        }
      } catch {
        // Ignore storage quota errors
      }
    }
    if (this.channel && ts > 0) {
      try {
        this.channel.postMessage({
          type: 'POINT_RECORDED',
          sender: this.tabId,
          lastPointAt: ts,
        });
      } catch {
        // Ignore channel post failures
      }
    }
    this.pushLastPointToRemote(ts);
  }

  handleExternalPointTimestamp(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return;
    if (ts > (this.programState.lastPointAt || 0)) {
      this.programState = { ...this.programState, lastPointAt: ts };
    }
    if (ts > (this.state.lastPointAt || 0)) {
      this.state = { ...this.state, lastPointAt: ts };
    }
  }

  saveToLibrary(stateObj) {
    if (!this.persistEnabled || !stateObj) return;
    const id = stateObj.tournamentId || 't-default';
    const joinCode = resolveTournamentJoinCode(stateObj);
    const map = readTournamentLibraryMap();
    // Deduplicate any stale local entry sharing the exact same 4-word joinCode under a different key
    for (const [existingId, existingEntry] of Object.entries(map)) {
      if (existingId !== id && resolveTournamentJoinCode(existingEntry) === joinCode) {
        delete map[existingId];
      }
    }
    map[id] = {
      ...stateObj,
      tournamentId: id,
      joinCode,
    };
    writeTournamentLibraryMap(map);
  }

  listTournaments() {
    const map = this.persistEnabled ? readTournamentLibraryMap() : {};
    // Ensure currently active LOCAL persisted tournament is represented (without duplicating Cloud-only tournaments)
    if (
      this.persistEnabled &&
      this.hasActiveTournament &&
      this.programState &&
      this.remoteSync.activeSource !== 'cloud'
    ) {
      const hasSavedMain = (() => {
        try {
          return Boolean(typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY));
        } catch {
          return false;
        }
      })();
      const activeId = this.programState.tournamentId || 't-default';
      const activeCode = resolveTournamentJoinCode(this.programState);
      const alreadyInCloud = (this.remoteSync.cloudTournaments || []).some(
        (ct) => ct.id === activeId || normalizeFourWordId(ct.joinCode || ct.id) === activeCode
      );
      if ((hasSavedMain || Object.keys(map).length > 0) && !map[activeId] && !alreadyInCloud) {
        map[activeId] = { ...this.programState, tournamentId: activeId, joinCode: activeCode };
        writeTournamentLibraryMap(map);
      }
    }
    const seenCodes = new Set();
    return Object.values(map)
      .map((entry) => summarizeTournamentEntry(entry))
      .filter((item) => {
        if (!item) return false;
        const code = normalizeFourWordId(item.joinCode || item.id);
        if (code && seenCodes.has(code)) return false;
        if (code) seenCodes.add(code);
        return true;
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  selectTournament(tournamentId, { publishToCloud = false } = {}) {
    const map = readTournamentLibraryMap();
    const raw = map[tournamentId];
    const normalized = raw ? normalizePersistedState(raw) : null;
    if (!normalized) return null;

    this.clearPendingScoreTimer();
    this.pendingScorePush = null;
    this.localPreviewMatchId = null;
    this.syncMode = 'live';
    this.hasUnpublishedChanges = false;
    this.hasActiveTournament = true;
    const stamped = { ...normalized, updatedAt: Date.now() };
    this.programState = stamped;
    this.state = stamped;
    const shouldPush = Boolean(publishToCloud);
    this.remoteSync = {
      ...this.remoteSync,
      activeSource: shouldPush ? 'cloud' : 'local',
    };
    this.broadcastState(stamped, { skipRemote: !shouldPush });
    this.persistStudioDraft();
    this.emit();
    return stamped;
  }

  createNewTournament(config = {}, { hostOnCloud = true, isSecure = true, isPublic = true } = {}) {
    // Save current tournament before switching away (only if local — Cloud tournaments already live on server!)
    if (this.persistEnabled && this.programState && this.remoteSync.activeSource !== 'cloud') {
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) {
          this.saveToLibrary(this.programState);
        }
      } catch {
        // Ignore
      }
    }

    const existingIds = new Set([
      ...Object.keys(readTournamentLibraryMap()),
      ...(this.remoteSync.cloudTournaments || []).map((t) => t.id),
      ...(this.remoteSync.cloudTournaments || []).map((t) => t.joinCode).filter(Boolean),
    ]);
    const newCode = generateTournamentId(existingIds);

    const pushCloud = Boolean(hostOnCloud && this.remoteSync.connected);
    const fresh = createInitialState({
      ...config,
      tournamentId: newCode,
      joinCode: newCode,
      access: {
        isSecure: Boolean(isSecure),
        isPublic: Boolean(isPublic),
      },
      ...(pushCloud
        ? {
          hostDeviceId: this.remoteSync.deviceId,
          hostDeviceName: this.remoteSync.deviceName,
        }
        : {}),
      createdAt: Date.now(),
    });
    this.clearPendingScoreTimer();
    this.pendingScorePush = null;
    this.localPreviewMatchId = null;
    this.syncMode = 'live';
    this.hasUnpublishedChanges = false;
    this.hasActiveTournament = true;
    this.programState = fresh;
    this.state = fresh;
    this.remoteSync = {
      ...this.remoteSync,
      activeSource: pushCloud ? 'cloud' : 'local',
      currentRole: pushCloud ? 'host' : 'local',
    };
    this.broadcastState(fresh, { skipRemote: !pushCloud });
    this.persistStudioDraft();
    this.resumeAfterDisconnect();
    this.emit();
    return fresh;
  }

  deleteTournament(tournamentId) {
    if (!this.persistEnabled || !tournamentId) return false;
    const map = readTournamentLibraryMap();
    if (!map[tournamentId]) return false;
    delete map[tournamentId];
    writeTournamentLibraryMap(map);

    if (this.programState?.tournamentId === tournamentId) {
      const remaining = Object.values(map).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (remaining.length > 0) {
        this.selectTournament(remaining[0].tournamentId);
      } else {
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(STUDIO_STORAGE_KEY);
          }
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.removeItem(SESSION_PICKED_STORAGE_KEY);
          }
        } catch {
          // Ignore
        }
        const fresh = createInitialState();
        this.hasActiveTournament = false;
        this.programState = fresh;
        this.state = fresh;
        this.emit();
      }
    } else {
      this.emit();
    }
    return true;
  }

  persistSnapshot() {
    if (!this.persistEnabled || !this.hasActiveTournament || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.programState));
    } catch {
      // Ignore quota errors gracefully
    }
    // Keep Cloud tournaments from duplicating into the local-only library unless already saved locally
    const existingLocal = readTournamentLibraryMap();
    const id = this.programState?.tournamentId || 't-default';
    if (this.remoteSync.activeSource !== 'cloud' || Boolean(existingLocal[id])) {
      this.saveToLibrary(this.programState);
    }
    if (this.activeViewMode === 'control') {
      this.persistStudioDraft();
    }
  }

  persistStudioDraft() {
    if (!this.persistEnabled || this.activeViewMode !== 'control' || typeof localStorage === 'undefined') {
      return;
    }
    try {
      if (this.syncMode === 'studio') {
        localStorage.setItem(
          STUDIO_STORAGE_KEY,
          JSON.stringify({
            syncMode: 'studio',
            hasUnpublishedChanges: this.hasUnpublishedChanges,
            stagedState: this.state,
            savedAt: Date.now(),
          })
        );
      } else {
        localStorage.removeItem(STUDIO_STORAGE_KEY);
      }
    } catch {
      // Ignore quota errors gracefully
    }
  }

  handleExternalSync(incoming) {
    const prevProgram = this.programState;
    // Never let a stale snapshot from another tab/device revert a newer setup/roster revision
    if (
      incoming?.tournamentId &&
      prevProgram?.tournamentId === incoming.tournamentId &&
      Number(incoming.setupVersion || 0) < Number(prevProgram.setupVersion || 0)
    ) {
      return;
    }
    // Rebase incoming Grandma speech timestamps to this device's local clock (zero skew delay on Fire Stick/TVs)
    if (incoming?.grandma?.activeSpeech?.id) {
      const prevSpeech = prevProgram?.grandma?.activeSpeech || null;
      const isSameSpeech = prevSpeech && incoming.grandma.activeSpeech.id === prevSpeech.id;
      const rebasedSpeech = isSameSpeech
        ? prevSpeech
        : this.rebaseGrandmaSpeechToLocalClock(incoming.grandma.activeSpeech, {
            liveArrival: true,
          });
      incoming = {
        ...incoming,
        grandma: {
          ...incoming.grandma,
          activeSpeech: rebasedSpeech,
          nextBanterAt: Math.max(
            Number(rebasedSpeech?.nextBanterAt || 0),
            isSameSpeech ? Number(prevProgram?.grandma?.nextBanterAt || 0) : 0
          ),
        },
      };
    }
    const incomingActive = incoming?.matches?.[incoming.activeMatchId];
    const incomingStartedLive = Boolean(
      incomingActive && incomingActive.started && !incomingActive.completed
    );
    const prevActiveId = prevProgram?.activeMatchId;
    const prevActiveMatch = prevProgram?.matches?.[prevActiveId];
    const activeMatchNewlyStarted =
      incomingStartedLive &&
      (incoming.activeMatchId !== prevActiveId || !prevActiveMatch?.started);
    const matchJustCompleted =
      Boolean(incoming?.lastCompletedEvent?.id) &&
      incoming.lastCompletedEvent.id !== prevProgram?.lastCompletedEvent?.id;
    const tournamentChanged =
      incoming?.tournamentId && incoming.tournamentId !== prevProgram?.tournamentId;

    // Clear any local unstarted match preview when another window actually begins or completes a match
    if (
      activeMatchNewlyStarted ||
      matchJustCompleted ||
      tournamentChanged ||
      (this.localPreviewMatchId && !incoming?.matches?.[this.localPreviewMatchId])
    ) {
      this.localPreviewMatchId = null;
    }

    this.hasActiveTournament = true;
    this.programState = incoming;
    if (!this.isStudioActive()) {
      this.state = this.localPreviewMatchId
        ? { ...incoming, activeMatchId: this.localPreviewMatchId }
        : incoming;
    } else {
      // In Studio Mode (Control View only), preserve the operator's staged presentation/UI/grandma edits
      // while still merging incoming live match scores & synced Grandma speech from court-side Scorekeepers!
      this.state = {
        ...this.state,
        matches: incoming.matches,
        activeMatchId: this.localPreviewMatchId || incoming.activeMatchId,
        championId: incoming.championId,
        userRoles: incoming.userRoles ?? this.state.userRoles,
        tabRoles: incoming.tabRoles ?? this.state.tabRoles,
        scorekeeperRequests: incoming.scorekeeperRequests ?? this.state.scorekeeperRequests,
        joinRequests: incoming.joinRequests ?? this.state.joinRequests,
        demotedScorekeepers: incoming.demotedScorekeepers ?? this.state.demotedScorekeepers,
        deniedDevices: incoming.deniedDevices ?? this.state.deniedDevices,
        kickedDevices: incoming.kickedDevices ?? this.state.kickedDevices,
        lastPointAt: Math.max(incoming.lastPointAt || 0, this.state.lastPointAt || 0),
        lastCompletedEvent:
          incoming.lastCompletedEvent ?? this.state.lastCompletedEvent ?? null,
        grandma: {
          ...this.state.grandma,
          activeSpeech:
            incoming.grandma?.activeSpeech ?? this.state.grandma?.activeSpeech ?? null,
          nextBanterAt:
            incoming.grandma?.nextBanterAt ?? this.state.grandma?.nextBanterAt,
          liveQuote: incoming.grandma?.liveQuote ?? this.state.grandma?.liveQuote ?? null,
        },
      };
      this.persistStudioDraft();
    }
    this.emit();
  }

  getTabId() {
    return this.tabId;
  }

  destroy() {
    if (this.pendingScoreTimer) {
      clearTimeout(this.pendingScoreTimer);
      this.pendingScoreTimer = null;
    }
    if (this.grandmaTimer) {
      clearInterval(this.grandmaTimer);
      this.grandmaTimer = null;
    }
    this.disconnectRemoteSync();
    this.pendingScorePush = null;
    if (typeof window !== 'undefined') {
      if (this._onStorage) window.removeEventListener('storage', this._onStorage);
      if (this._onPageHide) {
        window.removeEventListener('beforeunload', this._onPageHide);
        window.removeEventListener('pagehide', this._onPageHide);
      }
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.listeners.clear();
  }

  getState() {
    return this.state;
  }

  getSyncMeta() {
    const studioActive = this.isStudioActive();
    return {
      syncMode: studioActive ? 'studio' : 'live',
      hasUnpublishedChanges: studioActive ? this.hasUnpublishedChanges : false,
      programState: this.programState,
      localPreviewMatchId: this.localPreviewMatchId,
      lastDebouncedAt: this.lastDebouncedAt,
      remoteSync: this.remoteSync,
      pendingScorePush:
        studioActive && this.pendingScorePush
          ? {
            id: this.pendingScorePush.id,
            expiresAt: this.pendingScorePush.expiresAt,
            durationMs: this.pendingScorePush.durationMs,
            summary: this.pendingScorePush.summary,
          }
          : null,
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    const meta = this.getSyncMeta();
    for (const listener of this.listeners) {
      listener(this.state, meta);
    }
  }

  broadcastState(stamped, { skipRemote = false } = {}) {
    if (this.persistEnabled) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped));
        }
      } catch {
        // Ignore quota errors gracefully
      }
      this.saveToLibrary(stamped);
    }

    if (this.channel) {
      try {
        this.channel.postMessage({
          type: 'STATE_SYNC',
          sender: this.tabId,
          state: stamped,
        });
      } catch {
        // Ignore channel post failures
      }
    }

    if (!skipRemote && this.remoteSync?.connected && this.remoteSync.activeSource !== 'local-offline') {
      this.pushStateToRemote(stamped, { activate: true });
    }
  }

  commit(updater, { forcePublish = false } = {}) {
    const studioActive = this.isStudioActive();
    const baseState = studioActive ? this.state : this.programState;
    const next = typeof updater === 'function' ? updater(baseState) : updater;
    if (!next || next === baseState) return baseState;

    const stamped = {
      ...next,
      updatedAt: Date.now(),
    };
    this.hasActiveTournament = true;

    if (!studioActive || forcePublish) {
      this.programState = stamped;
      if (this.syncMode === 'studio' && this.activeViewMode !== 'control') {
        // Non-Control views (Scorekeeper/Debug) publish live immediately while preserving
        // any parked Control View studio presentation draft in this tab.
        this.state = {
          ...this.state,
          matches: stamped.matches,
          activeMatchId: stamped.activeMatchId,
          championId: stamped.championId,
          lastPointAt: stamped.lastPointAt,
          players: stamped.players,
          roster: stamped.roster,
          rules: stamped.rules,
          grandma: {
            ...this.state.grandma,
            activeSpeech: stamped.grandma?.activeSpeech ?? this.state.grandma?.activeSpeech ?? null,
            nextBanterAt: stamped.grandma?.nextBanterAt ?? this.state.grandma?.nextBanterAt,
            liveQuote: stamped.grandma?.liveQuote ?? this.state.grandma?.liveQuote ?? null,
          },
        };
      } else {
        this.state = stamped;
        this.hasUnpublishedChanges = false;
      }
      this.broadcastState(stamped);
      if (this.activeViewMode === 'control') {
        this.persistStudioDraft();
      }
    } else {
      this.state = stamped;
      this.hasUnpublishedChanges = true;
      this.persistStudioDraft();
    }

    this.emit();
    return stamped;
  }

  // ---- OBS-Style Studio vs Live Sync Controls (Control View Only) ----

  setSyncMode(mode) {
    if (this.activeViewMode !== 'control') return 'live';
    const nextMode = mode === 'studio' ? 'studio' : 'live';
    if (nextMode === this.syncMode) return this.syncMode;

    this.syncMode = nextMode;
    if (nextMode === 'live') {
      this.publishStudioToLive();
    } else {
      this.persistStudioDraft();
      this.emit();
    }
    return this.syncMode;
  }

  toggleSyncMode() {
    return this.setSyncMode(this.syncMode === 'live' ? 'studio' : 'live');
  }

  clearPendingScoreTimer() {
    if (this.pendingScoreTimer) {
      clearTimeout(this.pendingScoreTimer);
      this.pendingScoreTimer = null;
    }
  }

  /**
   * Commits a score/match update.
   * - In Live Mode (and ALWAYS in Scorekeeper / non-Control views): publishes immediately.
   * - In Studio Mode (Control View only): updates local score immediately and starts a 3-second
   *   cancellable countdown before pushing ONLY the score/match state live
   *   (without prematurely leaking staged slide or banner changes).
   */
  commitScoreAction(updater, summaryLabel = '', delayMs = STUDIO_SCORE_DELAY_MS) {
    if (!this.isStudioActive()) {
      return this.commit(updater, { forcePublish: true });
    }

    const prevState = this.state;
    const next = typeof updater === 'function' ? updater(prevState) : updater;
    if (!next || next === prevState) return prevState;

    const now = Date.now();
    const stamped = { ...next, updatedAt: now };
    this.state = stamped;

    const activeMatch = stamped.matches?.[stamped.activeMatchId];
    const scoreSummary =
      summaryLabel ||
      (activeMatch
        ? `${activeMatch.label}: ${String(activeMatch.score1).padStart(2, '0')} – ${String(
          activeMatch.score2
        ).padStart(2, '0')}`
        : 'Score update');

    // Preserve rollback snapshot from Program state on the first queued score edit
    const rollback = this.pendingScorePush
      ? this.pendingScorePush.rollback
      : {
        matches: this.programState.matches,
        activeMatchId: this.programState.activeMatchId,
        championId: this.programState.championId,
        lastPointAt: this.programState.lastPointAt,
        liveQuote: this.programState.grandma?.liveQuote || null,
      };

    this.clearPendingScoreTimer();
    const effectiveDelay = Math.max(0, Number(delayMs) || STUDIO_SCORE_DELAY_MS);
    this.pendingScorePush = {
      id: now + Math.floor(Math.random() * 1000),
      expiresAt: now + effectiveDelay,
      durationMs: effectiveDelay,
      summary: scoreSummary,
      rollback,
    };

    const timer = setTimeout(() => {
      this.flushPendingScorePush();
    }, effectiveDelay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pendingScoreTimer = timer;
    this.persistStudioDraft();

    this.emit();
    return stamped;
  }

  /**
   * Immediately pushes the pending Studio Mode score update live to Program
   * without publishing unrelated staged slide/banner edits.
   */
  flushPendingScorePush() {
    this.clearPendingScoreTimer();
    if (!this.pendingScorePush) return this.programState;
    this.pendingScorePush = null;

    const nextProgram = {
      ...this.programState,
      matches: this.state.matches,
      activeMatchId: this.state.activeMatchId,
      championId: this.state.championId,
      lastPointAt: this.state.lastPointAt,
      lastCompletedEvent:
        this.state.lastCompletedEvent || this.programState.lastCompletedEvent || null,
      grandma: {
        ...this.programState.grandma,
        liveQuote: this.state.grandma?.liveQuote || this.programState.grandma?.liveQuote || null,
        activeSpeech:
          this.state.grandma?.activeSpeech || this.programState.grandma?.activeSpeech || null,
        nextBanterAt:
          this.state.grandma?.nextBanterAt ?? this.programState.grandma?.nextBanterAt,
      },
      updatedAt: Date.now(),
    };

    this.programState = nextProgram;
    this.broadcastState(nextProgram);
    this.persistStudioDraft();
    this.emit();
    return nextProgram;
  }

  /**
   * Cancels the 3-second Studio Mode score countdown and reverts the pending
   * score/match change back to the published Program state.
   */
  cancelPendingScorePush() {
    this.clearPendingScoreTimer();
    if (!this.pendingScorePush) return this.state;

    const { rollback } = this.pendingScorePush;
    this.pendingScorePush = null;

    this.state = {
      ...this.state,
      matches: rollback.matches,
      activeMatchId: rollback.activeMatchId,
      championId: rollback.championId,
      lastPointAt: rollback.lastPointAt,
      grandma: {
        ...this.state.grandma,
        liveQuote: rollback.liveQuote,
      },
      updatedAt: Date.now(),
    };

    this.writeSharedLastPointAt(rollback.lastPointAt || 0);
    this.persistStudioDraft();
    this.emit();
    return this.state;
  }

  publishStudioToLive() {
    this.clearPendingScoreTimer();
    this.pendingScorePush = null;
    const stamped = {
      ...this.state,
      updatedAt: Date.now(),
    };
    this.state = stamped;
    this.programState = stamped;
    this.hasUnpublishedChanges = false;
    this.broadcastState(stamped);
    this.persistStudioDraft();
    this.emit();
    return stamped;
  }

  discardStudioChanges() {
    if (this.syncMode !== 'studio') return this.state;
    this.clearPendingScoreTimer();
    this.pendingScorePush = null;
    this.state = this.programState;
    this.hasUnpublishedChanges = false;
    this.persistStudioDraft();
    this.emit();
    return this.state;
  }

  // ---- Scoring Actions (with Multi-Scorekeeper Debounce Filter & Grandma Auto-Commentary) ----

  /**
   * True when a Scorekeeper has locally picked a match that differs from the one
   * currently shown on the (Program) scoreboard and has not yet pushed it live.
   */
  hasUnpublishedMatchSelection() {
    const previewId = this.localPreviewMatchId;
    if (!previewId) return false;
    const base = this.isStudioActive() ? this.state : this.programState;
    return previewId !== base.activeMatchId;
  }

  /**
   * Pushes the locally selected (unstarted) match to the scoreboard / presentation
   * without starting it. Begin Match is only offered afterwards.
   */
  publishSelectedMatch() {
    const targetId = this.localPreviewMatchId;
    if (!targetId) return this.state;
    const localMatch = this.state.matches?.[targetId];
    const localInitialServer = localMatch?.initialServer;
    const localTable = localMatch?.tableNumber;
    this.localPreviewMatchId = null;
    return this.commit(
      (s) => {
        const m = s.matches?.[targetId];
        if (!m || m.isBye || m.completed) return s;
        return {
          ...s,
          activeMatchId: targetId,
          matches: {
            ...s.matches,
            [targetId]: {
              ...m,
              ...(localInitialServer ? { initialServer: localInitialServer === 2 ? 2 : 1 } : {}),
              ...(localTable ? { tableNumber: localTable } : {}),
            },
          },
        };
      },
      { forcePublish: true }
    );
  }
  startMatch(matchId = null, tableNumber = null, { claimForScorekeeper = false, deviceId = '', deviceName = '' } = {}) {
    const targetId = matchId || this.localPreviewMatchId || this.state.activeMatchId;
    const localMatch = this.state.matches?.[targetId];
    const localInitialServer = localMatch?.initialServer;
    const localTable = localMatch?.tableNumber;
    this.localPreviewMatchId = null;

    const claimDevId = claimForScorekeeper
      ? String(deviceId || this.remoteSync?.deviceId || this.tabId || '').trim()
      : '';
    const claimDevName = claimForScorekeeper
      ? String(deviceName || this.remoteSync?.deviceName || 'Scorekeeper').trim()
      : '';

    return this.commit(
      (s) => {
        const m = s.matches?.[targetId];
        if (!m || m.isBye || m.completed || !m.player1Id || !m.player2Id) return s;
        const tableCount = Math.max(1, Math.floor(Number(s.rules?.tableCount ?? 1) || 1));
        const requestedTable = tableNumber ?? localTable ?? m.tableNumber;
        const resolvedTable =
          requestedTable && Number.isFinite(Number(requestedTable))
            ? Math.max(1, Math.min(tableCount, Math.floor(Number(requestedTable))))
            : pickNextAvailableTableNumber(s.matches, tableCount, targetId);
        const resolvedServer = localInitialServer === 2 ? 2 : m.initialServer === 2 ? 2 : 1;
        const shouldAttachClaim = Boolean(
          claimDevId && (!m.scorekeeperDeviceId || m.scorekeeperDeviceId === claimDevId)
        );
        if (
          m.started &&
          !m.paused &&
          s.activeMatchId === targetId &&
          m.initialServer === resolvedServer &&
          m.tableNumber === resolvedTable &&
          (!shouldAttachClaim || m.scorekeeperDeviceId === claimDevId)
        ) {
          return s;
        }
        return {
          ...s,
          activeMatchId: targetId,
          matches: {
            ...s.matches,
            [targetId]: {
              ...m,
              initialServer: resolvedServer,
              tableNumber: resolvedTable,
              started: true,
              paused: false,
              startedAt: m.startedAt || this.getServerNow(),
              ...(shouldAttachClaim
                ? {
                    scorekeeperDeviceId: claimDevId,
                    scorekeeperDeviceName: claimDevName || 'Scorekeeper',
                    scorekeeperClaimedAt: m.scorekeeperClaimedAt || Date.now(),
                  }
                : {}),
            },
          },
        };
      },
      { forcePublish: true }
    );
  }

  /**
   * Claims a match for a single Scorekeeper device so two phones cannot score the same match.
   * Each Scorekeeper device can only hold ONE active uncompleted match claim at a time unless `force` is true.
   */
  claimMatchScorekeeper(matchId = null, { deviceId = '', deviceName = '', force = false } = {}) {
    const base = this.isStudioActive() ? this.state : this.programState;
    const targetId = matchId || base.activeMatchId;
    const m = base.matches?.[targetId];
    if (!m || m.isBye || m.completed) {
      return { ok: false, reason: 'Match cannot be claimed' };
    }
    const devId = String(deviceId || this.remoteSync?.deviceId || this.tabId || '').trim();
    const devName = String(deviceName || this.remoteSync?.deviceName || 'Scorekeeper').trim();
    if (!devId) return { ok: false, reason: 'Missing device identity' };

    if (m.scorekeeperDeviceId && m.scorekeeperDeviceId !== devId && !force) {
      return {
        ok: false,
        claimedByOther: true,
        claimedByName: m.scorekeeperDeviceName || 'another Scorekeeper',
        reason: `Already being scored by ${m.scorekeeperDeviceName || 'another Scorekeeper'}`,
      };
    }

    // Ensure this device does not hold a claim on another active match at the same time
    const otherClaimed = Object.values(base.matches || {}).find(
      (x) =>
        x &&
        x.id !== targetId &&
        !x.isBye &&
        !x.completed &&
        x.scorekeeperDeviceId === devId
    );
    if (otherClaimed && !force) {
      return {
        ok: false,
        otherMatchId: otherClaimed.id,
        otherMatchLabel: otherClaimed.label || otherClaimed.id,
        reason: `Release your claim on ${otherClaimed.label || 'your other match'} first`,
      };
    }

    this.commit(
      (s) => {
        const cur = s.matches?.[targetId];
        if (!cur || cur.isBye || cur.completed) return s;
        const nextMatches = { ...s.matches };
        if (otherClaimed && force && nextMatches[otherClaimed.id]) {
          nextMatches[otherClaimed.id] = {
            ...nextMatches[otherClaimed.id],
            scorekeeperDeviceId: null,
            scorekeeperDeviceName: null,
            scorekeeperClaimedAt: null,
          };
        }
        nextMatches[targetId] = {
          ...cur,
          scorekeeperDeviceId: devId,
          scorekeeperDeviceName: devName || 'Scorekeeper',
          scorekeeperClaimedAt: Date.now(),
        };
        return { ...s, matches: nextMatches };
      },
      { forcePublish: true }
    );
    return { ok: true, matchId: targetId, deviceId: devId, deviceName: devName };
  }

  releaseMatchScorekeeper(matchId = null, { deviceId = '', force = false } = {}) {
    const base = this.isStudioActive() ? this.state : this.programState;
    const targetId = matchId || base.activeMatchId;
    const m = base.matches?.[targetId];
    if (!m || !m.scorekeeperDeviceId) return { ok: true };
    const devId = String(deviceId || this.remoteSync?.deviceId || this.tabId || '').trim();
    if (!force && m.scorekeeperDeviceId !== devId) {
      return { ok: false, reason: 'Only the claiming Scorekeeper or a Host/Admin can release this claim' };
    }
    this.commit(
      (s) => {
        const cur = s.matches?.[targetId];
        if (!cur || !cur.scorekeeperDeviceId) return s;
        return {
          ...s,
          matches: {
            ...s.matches,
            [targetId]: {
              ...cur,
              scorekeeperDeviceId: null,
              scorekeeperDeviceName: null,
              scorekeeperClaimedAt: null,
            },
          },
        };
      },
      { forcePublish: true }
    );
    return { ok: true, matchId: targetId };
  }

  cancelMatchStart(matchId = null) {
    const targetId = matchId || this.state.activeMatchId;
    return this.commit(
      (s) => {
        const m = s.matches?.[targetId];
        if (!m || m.isBye || m.completed || !m.started) return s;
        if ((m.score1 || 0) > 0 || (m.score2 || 0) > 0) return s;
        return {
          ...s,
          matches: {
            ...s.matches,
            [targetId]: {
              ...m,
              started: false,
              paused: false,
              startedAt: null,
              winnerReachedAt: null,
              timerOffsetMs: 0,
              scorekeeperDeviceId: null,
              scorekeeperDeviceName: null,
              scorekeeperClaimedAt: null,
            },
          },
        };
      },
      { forcePublish: true }
    );
  }

  pauseMatch(matchId = null) {
    const targetId = matchId || this.state.activeMatchId;
    return this.commit(
      (s) => {
        const m = s.matches?.[targetId];
        if (!m || m.isBye || m.completed || !m.started || m.paused) return s;
        const now = this.getServerNow();
        const elapsed = m.startedAt
          ? Math.max(0, Number(m.timerOffsetMs) || 0) + Math.max(0, now - Number(m.startedAt))
          : Math.max(0, Number(m.timerOffsetMs) || 0);
        return {
          ...s,
          matches: {
            ...s.matches,
            [targetId]: {
              ...m,
              paused: true,
              pausedAt: now,
              startedAt: null,
              timerOffsetMs: elapsed,
            },
          },
        };
      },
      { forcePublish: true }
    );
  }

  resumeMatch(matchId = null, tableNumber = null) {
    const targetId = matchId || this.state.activeMatchId;
    return this.commit(
      (s) => {
        const m = s.matches?.[targetId];
        if (!m || m.isBye || m.completed || !m.started || !m.paused) return s;
        const tableCount = Math.max(1, Math.floor(Number(s.rules?.tableCount ?? 1) || 1));
        const resolvedTable =
          tableNumber && Number.isFinite(Number(tableNumber))
            ? Math.max(1, Math.min(tableCount, Math.floor(Number(tableNumber))))
            : m.tableNumber || pickNextAvailableTableNumber(s.matches, tableCount, targetId);
        return {
          ...s,
          matches: {
            ...s.matches,
            [targetId]: {
              ...m,
              paused: false,
              pausedAt: null,
              tableNumber: resolvedTable,
              startedAt: this.getServerNow(),
            },
          },
        };
      },
      { forcePublish: true }
    );
  }

  /**
   * Explicitly assigns a ready or paused match onto `tableNumber`.
   * Refuses if `tableNumber` currently has an active (live, unpaused) match in session!
   */
  assignMatchToTable(tableNumber, matchId) {
    const base = this.isStudioActive() ? this.state : this.programState;
    const tableCount = Math.max(1, Math.floor(Number(base.rules?.tableCount ?? 1) || 1));
    const clampedTable = Math.max(1, Math.min(tableCount, Math.floor(Number(tableNumber) || 1)));
    const target = base.matches?.[matchId];
    if (!target || target.isBye || target.completed || !target.player1Id || !target.player2Id) {
      return { ok: false, reason: 'Selected match is not ready' };
    }
    if (target.started && !target.paused) {
      return { ok: false, reason: 'That match is already live on another table' };
    }
    const slots = getTableSlots(base);
    const currentSlot = slots[clampedTable - 1];
    if (
      currentSlot?.match &&
      currentSlot.match.id !== matchId &&
      currentSlot.match.started &&
      !currentSlot.match.paused
    ) {
      return {
        ok: false,
        reason: `Pause or cancel the live match on Table ${clampedTable} before changing it`,
      };
    }

    this.commit(
      (s) => {
        const nextMatches = { ...s.matches };
        // Clear any previous ready or paused match sitting on this table
        for (const [id, m] of Object.entries(nextMatches)) {
          if (
            m &&
            id !== matchId &&
            !m.completed &&
            m.tableNumber === clampedTable &&
            (!m.started || m.paused)
          ) {
            nextMatches[id] = { ...m, tableNumber: null };
          }
        }
        nextMatches[matchId] = { ...nextMatches[matchId], tableNumber: clampedTable };
        return {
          ...s,
          ...(tableCount === 1 ? { activeMatchId: matchId } : {}),
          matches: nextMatches,
        };
      },
      { forcePublish: true }
    );
    return { ok: true, tableNumber: clampedTable, matchId };
  }

  /**
   * Clears a ready or paused match off `tableNumber` so the table returns to OPEN.
   * Refuses if the table currently has an active (live, unpaused) match.
   */
  clearTableMatch(tableNumber) {
    const base = this.isStudioActive() ? this.state : this.programState;
    const tableCount = Math.max(1, Math.floor(Number(base.rules?.tableCount ?? 1) || 1));
    const clampedTable = Math.max(1, Math.min(tableCount, Math.floor(Number(tableNumber) || 1)));
    const slots = getTableSlots(base);
    const currentSlot = slots[clampedTable - 1];
    if (!currentSlot?.match) return { ok: true };
    if (currentSlot.match.started && !currentSlot.match.paused) {
      return {
        ok: false,
        reason: `Pause or cancel the live match on Table ${clampedTable} first`,
      };
    }
    const clearId = currentSlot.match.id;
    this.commit(
      (s) => {
        const m = s.matches?.[clearId];
        if (!m) return s;
        return {
          ...s,
          matches: {
            ...s.matches,
            [clearId]: { ...m, tableNumber: null },
          },
        };
      },
      { forcePublish: true }
    );
    return { ok: true, tableNumber: clampedTable };
  }

  getServerNow() {
    return Date.now() + (this.serverClockOffsetMs || 0);
  }

  setMatchTable(matchId, tableNumber) {
    const targetId = matchId || this.localPreviewMatchId || this.state.activeMatchId;
    const tableCount = Math.max(1, Math.floor(Number(this.state.rules?.tableCount ?? 1) || 1));
    const clampedTable = Math.max(1, Math.min(tableCount, Math.floor(Number(tableNumber) || 1)));

    // If locally previewing an unstarted match, assign table locally until Begin Match is clicked
    if (this.localPreviewMatchId && this.localPreviewMatchId === targetId) {
      const m = this.state.matches?.[targetId];
      if (!m || m.isBye) return this.state;
      this.state = {
        ...this.state,
        matches: {
          ...this.state.matches,
          [targetId]: { ...m, tableNumber: clampedTable },
        },
      };
      this.emit();
      return this.state;
    }

    return this.commit((s) => {
      const m = s.matches?.[targetId];
      if (!m || m.isBye) return s;
      if (m.tableNumber === clampedTable) return s;
      return {
        ...s,
        matches: {
          ...s.matches,
          [targetId]: { ...m, tableNumber: clampedTable },
        },
      };
    });
  }

  /**
   * Switches to a specific table (1..tableCount):
   * - If that table already has a live or queued match, returns that match.
   * - If that table is open, automatically queues the next ready unassigned match onto that table
   *   so Table 2+ never shows Table 1's players!
   */
  selectOrQueueTable(tableNumber, { setAsActive = true } = {}) {
    const base = this.isStudioActive() ? this.state : this.programState;
    const tableCount = Math.max(1, Math.floor(Number(base.rules?.tableCount ?? 1) || 1));
    const clampedTable = Math.max(1, Math.min(tableCount, Math.floor(Number(tableNumber) || 1)));
    const slots = getTableSlots(base);
    const slot = slots[clampedTable - 1];

    if (slot?.match) {
      if (setAsActive && base.activeMatchId !== slot.match.id) {
        this.commit((s) => ({ ...s, activeMatchId: slot.match.id }));
      }
      return {
        ok: true,
        tableNumber: clampedTable,
        matchId: slot.match.id,
        queued: false,
        isLive: slot.isLive,
      };
    }

    const occupiedIds = slots.map((s) => s.match?.id).filter(Boolean);
    const nextMatch = findNextUnassignedMatchForTable(base.matches, tableCount, occupiedIds);
    if (!nextMatch) {
      return {
        ok: false,
        open: true,
        tableNumber: clampedTable,
        matchId: null,
        reason: `No other ready matches to queue on Table ${clampedTable} yet`,
      };
    }

    this.commit(
      (s) => {
        const m = s.matches?.[nextMatch.id];
        if (!m || m.isBye || m.completed) return s;
        return {
          ...s,
          ...(setAsActive ? { activeMatchId: m.id } : {}),
          matches: {
            ...s.matches,
            [m.id]: { ...m, tableNumber: clampedTable },
          },
        };
      },
      { forcePublish: true }
    );

    return {
      ok: true,
      tableNumber: clampedTable,
      matchId: nextMatch.id,
      queued: true,
      isLive: false,
    };
  }

  addPoint(
    playerSlot,
    { matchId = null, bypassDebounce = false, requireStarted = false, now = Date.now(), randomFn = Math.random } = {}
  ) {
    const activeState = this.isStudioActive() ? this.state : this.programState;
    const effectiveMatchId = matchId || this.localPreviewMatchId || activeState.activeMatchId;
    const currentMatch = activeState.matches?.[effectiveMatchId];
    if (
      requireStarted &&
      currentMatch &&
      !currentMatch.started &&
      (currentMatch.score1 || 0) === 0 &&
      (currentMatch.score2 || 0) === 0
    ) {
      return { accepted: false, remainingMs: 0, requiresStart: true };
    }

    const debounceSec = Math.max(0, Number(activeState.rules?.scoreDebounceSec ?? 1) || 0);
    const debounceMs = Math.round(debounceSec * 1000);
    const sharedLastAt = this.readSharedLastPointAt();
    const lastAt = Math.max(
      this.state.lastPointAt || 0,
      this.programState.lastPointAt || 0,
      sharedLastAt
    );

    if (!bypassDebounce && debounceMs > 0 && lastAt > 0 && now - lastAt < debounceMs) {
      this.lastDebouncedAt = now;
      const nextClicks = (activeState.debouncedClicks || 0) + 1;
      this.state = { ...this.state, debouncedClicks: nextClicks };
      this.programState = { ...this.programState, debouncedClicks: nextClicks };
      this.emit();
      return {
        accepted: false,
        remainingMs: debounceMs - (now - lastAt),
        remainingSec: Number(((debounceMs - (now - lastAt)) / 1000).toFixed(1)),
      };
    }

    let changed = false;
    const targetMatchId = matchId || this.localPreviewMatchId || activeState.activeMatchId;
    if (!matchId) {
      this.localPreviewMatchId = null;
    }

    this.commitScoreAction((s) => {
      const match = s.matches[targetMatchId];
      if (!match || match.isBye) return s;
      const updated = adjustMatchScore(match, playerSlot, 1, s.rules);
      if (updated === match) return s;
      changed = true;

      const autoQuote = selectScoreGrandmaQuote(match, updated, s.rules, s.grandma, {
        now,
        randomFn,
        state: s,
        scoringSlot: playerSlot,
      });
      const autoSpeech = autoQuote
        ? createGrandmaSpeech({
          text: autoQuote.text,
          category: autoQuote.category,
          grandmaConfig: s.grandma,
          now,
          randomFn,
        })
        : null;

      const serverNow = this.getServerNow();
      const updatedEval = evaluateMatchState(updated, s.rules);
      const winnerReachedAt =
        updatedEval.winnerSlot !== null ? match.winnerReachedAt || serverNow : null;

      return {
        ...s,
        activeMatchId: targetMatchId,
        lastPointAt: now,
        matches: {
          ...s.matches,
          [match.id]: {
            ...updated,
            started: true,
            startedAt: match.startedAt || serverNow,
            winnerReachedAt,
          },
        },
        grandma: autoSpeech
          ? {
            ...s.grandma,
            liveQuote: autoSpeech,
            activeSpeech: autoSpeech,
            nextBanterAt: autoSpeech.nextBanterAt,
          }
          : s.grandma,
      };
    });

    if (changed) {
      this.writeSharedLastPointAt(now);
    }

    return { accepted: changed, remainingMs: 0 };
  }

  subtractPoint(playerSlot, { matchId = null } = {}) {
    return this.commitScoreAction((s) => {
      const targetId = matchId || s.activeMatchId;
      const match = s.matches[targetId];
      if (!match || match.isBye) return s;
      const updated = adjustMatchScore(match, playerSlot, -1, s.rules);
      if (updated === match) return s;
      const updatedEval = evaluateMatchState(updated, s.rules);
      const winnerReachedAt =
        updatedEval.winnerSlot !== null ? match.winnerReachedAt || this.getServerNow() : null;
      return {
        ...s,
        matches: {
          ...s.matches,
          [match.id]: {
            ...updated,
            winnerReachedAt,
          },
        },
      };
    });
  }

  undoPoint({ matchId = null } = {}) {
    return this.commitScoreAction((s) => {
      const targetId = matchId || s.activeMatchId;
      const match = s.matches[targetId];
      if (!match || match.isBye) return s;
      const updated = undoLastPoint(match);
      if (updated === match) return s;
      const updatedEval = evaluateMatchState(updated, s.rules);
      const winnerReachedAt =
        updatedEval.winnerSlot !== null ? match.winnerReachedAt || this.getServerNow() : null;
      return {
        ...s,
        matches: {
          ...s.matches,
          [match.id]: {
            ...updated,
            winnerReachedAt,
          },
        },
      };
    });
  }

  switchFirstServer({ matchId = null } = {}) {
    // If locally previewing an unstarted match, toggle initial server locally until Begin Match is clicked
    const previewId = matchId || this.localPreviewMatchId;
    if (!matchId && previewId) {
      const m = this.state.matches?.[previewId];
      if (!m || m.isBye || m.completed) return this.state;
      const updated = toggleInitialServer(m);
      if (updated === m) return this.state;
      this.state = {
        ...this.state,
        matches: { ...this.state.matches, [previewId]: updated },
      };
      this.emit();
      return this.state;
    }

    return this.commitScoreAction((s) => {
      const targetId = matchId || s.activeMatchId;
      const match = s.matches[targetId];
      if (!match || match.isBye) return s;
      const updated = toggleInitialServer(match);
      if (updated === match) return s;
      return {
        ...s,
        matches: { ...s.matches, [match.id]: updated },
      };
    }, 'Switched 1st Server');
  }

  selectMatch(matchId, { allowDuringGame = false } = {}) {
    const base = this.isStudioActive() ? this.state : this.programState;
    const target = base.matches?.[matchId];
    if (!target || target.isBye) return this.state;

    // Prevent Scorekeeper from switching away while a live match is in progress (score > 0-0 & not completed)
    if (!allowDuringGame && this.activeViewMode === 'scorekeeper') {
      const currentId = this.localPreviewMatchId || base.activeMatchId;
      const current = base.matches?.[currentId];
      const inProgress =
        current &&
        !current.completed &&
        ((current.score1 || 0) > 0 || (current.score2 || 0) > 0);
      if (inProgress) return this.state;
    }

    // Do NOT broadcast unstarted (or completed inspection) match selections to other scorekeepers/control/presentation
    // until somebody clicks Begin Match (startMatch)!
    const targetIsLiveInProgress = Boolean(target.started && !target.completed);
    if (!targetIsLiveInProgress) {
      this.localPreviewMatchId = matchId;
      this.state = {
        ...this.state,
        activeMatchId: matchId,
      };
      this.emit();
      return this.state;
    }

    // Resuming an already-started live match publishes cleanly
    const hadLocalPreview = Boolean(this.localPreviewMatchId);
    this.localPreviewMatchId = null;
    if (hadLocalPreview && this.programState.activeMatchId === matchId) {
      this.state = { ...this.state, activeMatchId: matchId };
      this.emit();
      return this.state;
    }
    return this.commit((s) => {
      if (s.activeMatchId === matchId) return s;
      return {
        ...s,
        activeMatchId: matchId,
      };
    });
  }

  completeActiveMatch(matchId = null) {
    return this.commitScoreAction((s) => {
      const prevMatchId = matchId || s.activeMatchId;
      const finishedTable = Math.max(1, Math.floor(Number(s.matches?.[prevMatchId]?.tableNumber) || 1));
      const result = completeMatchAndAdvance(
        s.matches,
        prevMatchId,
        s.rules,
        s.playerCount,
        s.format
      );
      if (!result.completed) return s;

      const tableCount = Math.max(1, Math.floor(Number(s.rules?.tableCount ?? 1) || 1));
      let nextMatches = result.matches;
      if (nextMatches[prevMatchId]?.scorekeeperDeviceId) {
        nextMatches = {
          ...nextMatches,
          [prevMatchId]: {
            ...nextMatches[prevMatchId],
            scorekeeperDeviceId: null,
            scorekeeperDeviceName: null,
            scorekeeperClaimedAt: null,
          },
        };
      }
      let nextActiveMatchId = result.nextActiveMatchId;
      if (tableCount > 1) {
        // Queue the next unassigned ready match directly onto the table that just finished
        // without disturbing any other table's live match!
        const occupiedIds = Object.values(nextMatches || {})
          .filter((m) => m && !m.isBye && !m.completed && m.started)
          .map((m) => m.id);
        const nextForFinishedTable = findNextUnassignedMatchForTable(nextMatches, tableCount, occupiedIds);
        if (nextForFinishedTable) {
          nextMatches = {
            ...nextMatches,
            [nextForFinishedTable.id]: {
              ...nextForFinishedTable,
              tableNumber: finishedTable,
            },
          };
          nextActiveMatchId = nextForFinishedTable.id;
        }
      }

      const finishedMatch = nextMatches[prevMatchId];
      const now = Date.now();
      const completedEvent = {
        id: now + Math.floor(Math.random() * 10000),
        completedMatchId: prevMatchId,
        completedMatchLabel: finishedMatch?.label || prevMatchId,
        player1Id: finishedMatch?.player1Id || null,
        player2Id: finishedMatch?.player2Id || null,
        winnerId: finishedMatch?.winnerId || null,
        score1: finishedMatch?.score1 || 0,
        score2: finishedMatch?.score2 || 0,
        recommendedMatchId: result.recommendedMatchId || null,
        timestamp: now,
      };

      const nextPresentation = result.championId
        ? { ...s.presentation, activeSlide: 'spotlight' }
        : s.presentation;

      return {
        ...s,
        matches: nextMatches,
        activeMatchId: nextActiveMatchId,
        championId: result.championId || s.championId,
        lastCompletedEvent: completedEvent,
        presentation: nextPresentation,
      };
    }, 'Match Completed & Bracket Advanced');
  }

  reopenMatch(matchId) {
    let outcome = { reopened: false };
    this.localPreviewMatchId = null;
    this.commit(
      (s) => {
        const targetId = matchId || s.activeMatchId;
        const res = reopenCompletedMatch(s.matches, targetId, s.playerCount, s.format);
        if (!res.reopened) return s;
        outcome = { reopened: true, matchId: targetId };
        return {
          ...s,
          matches: res.matches,
          activeMatchId: targetId,
          championId: res.championId,
        };
      },
      { forcePublish: true }
    );
    return outcome;
  }

  editCompletedMatch(matchId, score1, score2) {
    let outcome = { edited: false, reason: '' };
    this.commit(
      (s) => {
        const targetId = matchId || s.activeMatchId;
        const res = editCompletedMatchScore(
          s.matches,
          targetId,
          score1,
          score2,
          s.rules,
          s.playerCount,
          s.format
        );
        outcome = {
          edited: res.edited,
          winnerChanged: res.winnerChanged,
          reason: res.reason || '',
        };
        if (!res.edited) return s;
        return {
          ...s,
          matches: res.matches,
          championId: res.championId,
        };
      },
      { forcePublish: true }
    );
    return outcome;
  }

  // ---- Tournament Setup, Rules & Appearance ----

  applyFullSetup({
    tournamentName,
    tournamentSubtitle,
    entryMode,
    demoMode,
    autoTeamNames,
    format,
    playerCount,
    totalPlayers,
    roster,
    rules,
    theme,
    titleAmbiance,
    ambianceIntensity,
    scoreFont,
    showMiniBracket,
    players,
    rebuildBracket,
  }) {
    return this.commit((s) => {
      const nextEntryMode =
        entryMode !== undefined ? (entryMode === 'teams' ? 'teams' : 'singles') : s.entryMode;
      const nextDemoMode = demoMode !== undefined ? Boolean(demoMode) : s.demoMode;
      const nextAutoTeamNames =
        autoTeamNames !== undefined ? Boolean(autoTeamNames) : s.autoTeamNames;
      const nextFormat = format || s.format;
      const nextCount =
        playerCount !== undefined ? clampPlayerCount(playerCount) : s.playerCount;
      const nextRules = {
        targetPoints:
          rules?.targetPoints !== undefined
            ? Math.max(1, Math.floor(Number(rules.targetPoints) || 11))
            : s.rules.targetPoints,
        serveRotation:
          rules?.serveRotation !== undefined
            ? Math.max(1, Math.floor(Number(rules.serveRotation) || 2))
            : s.rules.serveRotation,
        winBy:
          rules?.winBy !== undefined
            ? Math.max(1, Math.floor(Number(rules.winBy) || 2))
            : s.rules.winBy ?? 2,
        skunkEnabled:
          rules?.skunkEnabled !== undefined
            ? Boolean(rules.skunkEnabled)
            : Boolean(s.rules.skunkEnabled ?? false),
        skunkScore:
          rules?.skunkScore !== undefined
            ? Math.max(1, Math.floor(Number(rules.skunkScore) || 7))
            : Math.max(1, Math.floor(Number(s.rules.skunkScore ?? 7) || 7)),
        deadMansServe:
          rules?.deadMansServe !== undefined
            ? Boolean(rules.deadMansServe)
            : Boolean(s.rules.deadMansServe ?? false),
        tableCount:
          rules?.tableCount !== undefined
            ? Math.max(1, Math.floor(Number(rules.tableCount) || 1))
            : s.rules.tableCount ?? 1,
        requireScorekeeperApproval:
          rules?.requireScorekeeperApproval !== undefined
            ? Boolean(rules.requireScorekeeperApproval)
            : s.rules.requireScorekeeperApproval ?? true,
        allowScorekeeperGrandma:
          rules?.allowScorekeeperGrandma !== undefined
            ? Boolean(rules.allowScorekeeperGrandma)
            : s.rules.allowScorekeeperGrandma ?? true,
        scoreDebounceSec:
          rules?.scoreDebounceSec !== undefined
            ? Math.max(0, Number(rules.scoreDebounceSec) || 0)
            : s.rules.scoreDebounceSec,
      };
      const nextTheme = THEME_OPTIONS.some((t) => t.id === theme) ? theme : s.ui.theme || 'arena';
      const nextAmbiance = AMBIANCE_OPTIONS.some((a) => a.id === titleAmbiance)
        ? titleAmbiance
        : s.presentation.titleAmbiance || 'auto';
      const nextIntensity = ['low', 'medium', 'high'].includes(ambianceIntensity)
        ? ambianceIntensity
        : s.presentation.ambianceIntensity || 'medium';
      const nextFont = SCORE_FONT_OPTIONS.some((f) => f.id === scoreFont)
        ? scoreFont
        : s.ui.scoreFont;
      const nextShowMini =
        showMiniBracket !== undefined ? Boolean(showMiniBracket) : s.ui.showMiniBracket;

      let nextPlayers = createPlayers(nextCount, players || s.players, nextEntryMode, {
        demoMode: nextDemoMode,
        autoTeamNames: nextAutoTeamNames,
      });

      const resolvedTotalPlayers =
        totalPlayers !== undefined
          ? clampPlayerCount(totalPlayers)
          : nextEntryMode === 'teams'
            ? Math.min(256, nextCount * 2)
            : nextCount;

      // Preserve intentional solo slot and memberIds when teams are configured from Player Roster
      if (nextEntryMode === 'teams' && Array.isArray(players)) {
        nextPlayers = nextPlayers.map((t, idx) => {
          const src = players[idx];
          if (!src) return t;
          const preservedMembers = Array.isArray(src.members)
            ? [src.members[0] ?? t.members[0], src.members[1] !== undefined ? src.members[1] : t.members[1]]
            : t.members;
          return {
            ...t,
            members: preservedMembers,
            ...(Array.isArray(src.memberIds) ? { memberIds: [...src.memberIds] } : {}),
          };
        });
      }

      const nextRoster =
        Array.isArray(roster) && roster.length > 0
          ? roster.map((r, idx) => ({
            id: r.id || `r${idx + 1}`,
            name: String(r.name || '').trim() || `Player ${idx + 1}`,
          }))
          : nextEntryMode === 'teams'
            ? nextPlayers
              .flatMap((t) => (Array.isArray(t.members) ? t.members : []))
              .filter(Boolean)
              .map((name, idx) => ({ id: `r${idx + 1}`, name }))
            : nextPlayers.map((p, idx) => ({ id: `r${idx + 1}`, name: p.name }));

      const mustFullRebuild =
        Boolean(rebuildBracket) ||
        nextFormat !== s.format ||
        nextEntryMode !== s.entryMode ||
        nextCount < s.playerCount;

      let nextMatches = s.matches;
      let nextActive = s.activeMatchId;
      let nextChampionId = s.championId;

      if (mustFullRebuild) {
        nextMatches = generateBracket(nextPlayers, nextFormat);
        nextActive =
          findNextReadyMatchId(nextMatches) || Object.keys(nextMatches)[0] || 'W-R1-M1';
        nextChampionId = null;
      } else if (nextCount > s.playerCount) {
        // Non-destructive mid-tournament player/team addition! Preserves completed & in-progress matches
        const preserved = addEntrantsPreservingBracket(
          s.matches,
          s.players,
          nextPlayers,
          nextFormat,
          nextRules,
          s.activeMatchId
        );
        nextMatches = preserved.matches;
        nextActive = preserved.activeMatchId;
        nextChampionId = preserved.championId;
      }

      return {
        ...s,
        setupVersion: (Number(s.setupVersion) || 0) + 1,
        tournamentName:
          tournamentName !== undefined && tournamentName.trim()
            ? tournamentName.trim()
            : s.tournamentName,
        tournamentSubtitle:
          tournamentSubtitle !== undefined
            ? String(tournamentSubtitle).trim()
            : s.tournamentSubtitle || '',
        entryMode: nextEntryMode,
        demoMode: nextDemoMode,
        autoTeamNames: nextAutoTeamNames,
        format: nextFormat,
        playerCount: nextCount,
        totalPlayers: resolvedTotalPlayers,
        roster: nextRoster,
        rules: nextRules,
        players: nextPlayers,
        matches: nextMatches,
        activeMatchId: nextActive,
        championId: nextChampionId,
        ui: {
          ...s.ui,
          theme: nextTheme,
          scoreFont: nextFont,
          showMiniBracket: nextShowMini,
        },
        presentation: {
          ...s.presentation,
          titleAmbiance: nextAmbiance,
          ambianceIntensity: nextIntensity,
        },
      };
    }, { forcePublish: true });
  }

  setDemoMode(enabled) {
    const isDemo = Boolean(enabled);
    return this.commit((s) => {
      const nextPlayers = createPlayers(s.playerCount, s.players, s.entryMode, {
        demoMode: isDemo,
        autoTeamNames: s.autoTeamNames,
        forceRegenerateNames: true,
      });
      return {
        ...s,
        demoMode: isDemo,
        players: nextPlayers,
      };
    });
  }

  setAutoTeamNames(enabled) {
    const useAuto = Boolean(enabled);
    return this.commit((s) => {
      const nextPlayers =
        s.entryMode === 'teams'
          ? createPlayers(s.playerCount, s.players, 'teams', {
            demoMode: s.demoMode,
            autoTeamNames: useAuto,
            forceRegenerateTeamNames: true,
          })
          : s.players;
      return {
        ...s,
        autoTeamNames: useAuto,
        players: nextPlayers,
      };
    });
  }

  setScoreDebounceSec(sec) {
    const clamped = Math.max(0, Number(sec) || 0);
    return this.commit((s) => ({
      ...s,
      rules: {
        ...s.rules,
        scoreDebounceSec: clamped,
      },
    }));
  }

  setAllowScorekeeperGrandma(enabled) {
    const next = Boolean(enabled);
    return this.commit((s) => ({
      ...s,
      rules: {
        ...s.rules,
        allowScorekeeperGrandma: next,
      },
    }));
  }

  randomizeSeeds() {
    return this.commit((s) => {
      const entries = s.players.map((p) => ({
        name: p.name,
        ...(Array.isArray(p.members) ? { members: [...p.members] } : {}),
      }));
      for (let i = entries.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [entries[i], entries[j]] = [entries[j], entries[i]];
      }
      const shuffledPlayers = entries.map((entry, idx) => ({
        id: `p${idx + 1}`,
        seed: idx + 1,
        ...entry,
      }));
      const nextMatches = generateBracket(shuffledPlayers, s.format);
      const nextActive =
        findNextReadyMatchId(nextMatches) || Object.keys(nextMatches)[0] || 'W-R1-M1';
      return {
        ...s,
        players: shuffledPlayers,
        matches: nextMatches,
        activeMatchId: nextActive,
        championId: null,
      };
    });
  }

  shuffleTeamPartners() {
    return this.commit((s) => {
      if (s.entryMode !== 'teams') return s;
      const pool = [];
      for (const t of s.players) {
        if (Array.isArray(t.members)) {
          pool.push(t.members[0] || '', t.members[1] || '');
        }
      }
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const nextPlayers = s.players.map((t, idx) => ({
        ...t,
        members: [
          pool[idx * 2] || `Player ${idx * 2 + 1}`,
          pool[idx * 2 + 1] || `Player ${idx * 2 + 2}`,
        ],
      }));
      return {
        ...s,
        players: nextPlayers,
      };
    });
  }

  resetTournament() {
    return this.commit((s) => {
      const nextMatches = generateBracket(s.players, s.format);
      const nextActive =
        findNextReadyMatchId(nextMatches) || Object.keys(nextMatches)[0] || 'W-R1-M1';
      return {
        ...s,
        matches: nextMatches,
        activeMatchId: nextActive,
        championId: null,
      };
    });
  }

  factoryReset() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore
    }
    this.syncMode = 'live';
    return this.commit(() => createInitialState(), { forcePublish: true });
  }

  // ---- System & QA Simulation Actions ----

  setActiveMatchScoreDirect(score1, score2) {
    return this.commit((s) => {
      const m = s.matches[s.activeMatchId];
      if (!m || m.completed || m.isBye || !m.player1Id || !m.player2Id) return s;
      const updated = {
        ...m,
        score1: Math.max(0, Number(score1) || 0),
        score2: Math.max(0, Number(score2) || 0),
      };
      const autoQuote = selectScoreGrandmaQuote(m, updated, s.rules, s.grandma, { state: s });
      return {
        ...s,
        matches: {
          ...s.matches,
          [m.id]: updated,
        },
        grandma: autoQuote ? { ...s.grandma, liveQuote: autoQuote } : s.grandma,
      };
    });
  }

  simulateNextMatch() {
    return this.commit((s) => {
      const m = s.matches[s.activeMatchId];
      if (!m || m.completed || m.isBye || !m.player1Id || !m.player2Id) return s;
      const [sc1, sc2] = generateRandomWinScore(s.rules.targetPoints, s.rules.winBy ?? 2);
      const scored = {
        ...s.matches,
        [m.id]: { ...m, score1: sc1, score2: sc2 },
      };
      const res = completeMatchAndAdvance(scored, m.id, s.rules, s.playerCount, s.format);
      if (!res.completed) return s;
      return {
        ...s,
        matches: res.matches,
        activeMatchId: res.nextActiveMatchId,
        championId: res.championId || s.championId,
        presentation: res.championId
          ? { ...s.presentation, activeSlide: 'spotlight' }
          : s.presentation,
      };
    });
  }

  simulateCurrentRound() {
    return this.commit((s) => {
      let matches = { ...s.matches };
      const readyNow = Object.values(matches).filter(
        (m) => !m.completed && !m.isBye && m.player1Id && m.player2Id
      );
      if (readyNow.length === 0) return s;

      let championId = s.championId;
      let nextActive = s.activeMatchId;

      for (const m of readyNow) {
        const latest = matches[m.id];
        if (!latest || latest.completed || !latest.player1Id || !latest.player2Id) continue;
        const [sc1, sc2] = generateRandomWinScore(s.rules.targetPoints, s.rules.winBy ?? 2);
        matches[m.id] = { ...latest, score1: sc1, score2: sc2 };
        const res = completeMatchAndAdvance(matches, m.id, s.rules, s.playerCount, s.format);
        if (res.completed) {
          matches = res.matches;
          nextActive = res.nextActiveMatchId;
          if (res.championId) championId = res.championId;
        }
      }

      return {
        ...s,
        matches,
        activeMatchId: nextActive,
        championId,
        presentation: championId
          ? { ...s.presentation, activeSlide: 'spotlight' }
          : s.presentation,
      };
    });
  }

  simulateTournamentToEnd() {
    return this.commit((s) => {
      let matches = { ...s.matches };
      let activeId = findNextReadyMatchId(matches) || s.activeMatchId;
      let championId = s.championId;
      let guard = 0;

      while (!championId && activeId && guard < 600) {
        guard += 1;
        const m = matches[activeId];
        if (!m || m.completed || m.isBye || !m.player1Id || !m.player2Id) break;
        const [sc1, sc2] = generateRandomWinScore(s.rules.targetPoints, s.rules.winBy ?? 2);
        matches[activeId] = { ...m, score1: sc1, score2: sc2 };
        const res = completeMatchAndAdvance(matches, activeId, s.rules, s.playerCount, s.format);
        if (!res.completed) break;
        matches = res.matches;
        activeId = res.nextActiveMatchId;
        if (res.championId) championId = res.championId;
      }

      return {
        ...s,
        matches,
        activeMatchId: activeId || s.activeMatchId,
        championId,
        presentation: championId
          ? { ...s.presentation, activeSlide: 'spotlight' }
          : s.presentation,
      };
    });
  }

  // ---- UI, Collapsible Panels, Appearance & CRT Controls ----

  togglePanelCollapsed(panelKey) {
    return this.commit((s) => {
      const current = Boolean(s.ui?.collapsedPanels?.[panelKey]);
      return {
        ...s,
        ui: {
          ...s.ui,
          collapsedPanels: {
            ...DEFAULT_COLLAPSED_PANELS,
            ...(s.ui?.collapsedPanels || {}),
            [panelKey]: !current,
          },
        },
      };
    });
  }

  setAllPanelsCollapsed(collapsed) {
    const val = Boolean(collapsed);
    return this.commit((s) => ({
      ...s,
      ui: {
        ...s.ui,
        collapsedPanels: {
          presentation: val,
          grandma: val,
          crt: val,
          bracket: val,
        },
      },
    }));
  }

  setTheme(themeId) {
    if (!THEME_OPTIONS.some((t) => t.id === themeId)) return this.state;
    return this.commit((s) => ({
      ...s,
      ui: {
        ...s.ui,
        theme: themeId,
      },
    }));
  }

  setGrandmaEnabled(enabled) {
    const nextEnabled = Boolean(enabled);
    return this.commit(
      (s) => ({
        ...s,
        rules: {
          ...s.rules,
          grandmaEnabled: nextEnabled,
        },
        grandma: nextEnabled
          ? s.grandma
          : {
              ...s.grandma,
              activeSpeech: null,
              liveQuote: null,
            },
      }),
      { forcePublish: true }
    );
  }

  toggleCornerScene() {
    return this.commit((s) => ({
      ...s,
      ui: { ...s.ui, showCornerScene: !s.ui.showCornerScene },
    }));
  }

  setCornerAppearance({ cornerScale, cornerOpacity, bubbleScale }) {
    return this.commit((s) => ({
      ...s,
      ui: {
        ...s.ui,
        cornerScale:
          cornerScale !== undefined
            ? Math.max(0.4, Math.min(1.5, Number(cornerScale) || 1.0))
            : s.ui.cornerScale,
        cornerOpacity:
          cornerOpacity !== undefined
            ? Math.max(0.15, Math.min(1.0, Number(cornerOpacity) || 1.0))
            : s.ui.cornerOpacity,
        bubbleScale:
          bubbleScale !== undefined
            ? Math.max(0.75, Math.min(1.5, Number(bubbleScale) || 1.0))
            : s.ui.bubbleScale ?? 1.0,
      },
    }));
  }

  setTickerConfig(partial) {
    return this.commit((s) => ({
      ...s,
      ui: {
        ...s.ui,
        ...(partial.showTicker !== undefined ? { showMiniBracket: Boolean(partial.showTicker) } : {}),
        ...(partial.items !== undefined ? { tickerItems: normalizeTickerItems(partial.items) } : {}),
        ...(partial.mode !== undefined
          ? {
              tickerMode: ['static', 'rotate', 'scroll'].includes(partial.mode) ? partial.mode : 'static',
              tickerScroll: partial.mode === 'scroll',
              tickerAutoRotate: partial.mode === 'rotate',
            }
          : {}),
        ...(partial.rotateSec !== undefined ? { tickerRotateSec: Math.max(3, Math.min(120, Number(partial.rotateSec) || 10)) } : {}),
      },
    }));
  }

  setShowMiniBracket(show) {
    return this.commit((s) => ({
      ...s,
      ui: { ...s.ui, showMiniBracket: Boolean(show) },
    }));
  }

  setTvMuted(muted) {
    return this.commit((s) => ({
      ...s,
      ui: { ...s.ui, tvMuted: Boolean(muted) },
    }));
  }

  setTvMediaStatus({ hasCustomTvMedia, tvMediaLabel, tvMediaUpdatedAt, tvMuted }) {
    return this.commit((s) => ({
      ...s,
      ui: {
        ...s.ui,
        hasCustomTvMedia: Boolean(hasCustomTvMedia),
        tvMediaLabel: tvMediaLabel || 'Default Sitcom (6s Loop)',
        tvMediaUpdatedAt:
          tvMediaUpdatedAt !== undefined ? Number(tvMediaUpdatedAt) || Date.now() : Date.now(),
        tvMuted: tvMuted !== undefined ? Boolean(tvMuted) : s.ui.tvMuted,
      },
    }));
  }

  addTvPlaylistItem(item) {
    if (!item || !item.id) return this.state;
    return this.commit(
      (s) => {
        const cur = Array.isArray(s.ui?.tvPlaylist) ? s.ui.tvPlaylist : [];
        const entry = {
          id: String(item.id),
          kind: ['sitcom', 'video', 'image', 'url'].includes(item.kind) ? item.kind : 'image',
          name: String(item.name || 'TV Media').trim() || 'TV Media',
          type: item.type || '',
          url: item.url || '',
          gcsObject: item.gcsObject || '',
          muted: Boolean(item.muted),
          cacheLocal: Boolean(item.cacheLocal),
          ...(item.quality ? { quality: String(item.quality) } : {}),
          ...(item.autoDuration !== undefined ? { autoDuration: Boolean(item.autoDuration) } : {}),
          durationSec: Math.max(1, Math.min(86400, Math.round(Number(item.durationSec) || 12))),
          updatedAt: Number(item.updatedAt) || Date.now(),
        };
        const nextList = [...cur, entry];
        return {
          ...s,
          ui: {
            ...s.ui,
            tvPlaylist: nextList,
            tvPlaylistIndex: nextList.length - 1,
            hasCustomTvMedia: nextList.some((x) => x.kind !== 'sitcom'),
            tvMediaLabel:
              nextList.length === 1 ? entry.name : `Playlist (${nextList.length} items)`,
            tvMediaUpdatedAt: Date.now(),
          },
        };
      },
      { forcePublish: true }
    );
  }

  removeTvPlaylistItem(itemId) {
    return this.commit(
      (s) => {
        const cur = Array.isArray(s.ui?.tvPlaylist) ? s.ui.tvPlaylist : [];
        const filtered = cur.filter((x) => x.id !== itemId);
        const nextList =
          filtered.length > 0
            ? filtered
            : [
                {
                  id: 'builtin-default-tv',
                  kind: 'url',
                  name: 'Raymond Thanksgiving (Default)',
                  url: '/raymond-thanksgiving.mp4',
                  muted: true,
                  durationSec: 2640,
                  updatedAt: 0,
                },
              ];
        const curIdx = Number(s.ui?.tvPlaylistIndex) || 0;
        const nextIdx = Math.min(curIdx, nextList.length - 1);
        return {
          ...s,
          ui: {
            ...s.ui,
            tvPlaylist: nextList,
            tvPlaylistIndex: Math.max(0, nextIdx),
            hasCustomTvMedia: nextList.some((x) => x.kind !== 'sitcom'),
            tvMediaLabel:
              nextList.length === 1 ? nextList[0].name : `Playlist (${nextList.length} items)`,
            tvMediaUpdatedAt: Date.now(),
          },
        };
      },
      { forcePublish: true }
    );
  }

  moveTvPlaylistItem(itemId, delta) {
    return this.commit(
      (s) => {
        const cur = Array.isArray(s.ui?.tvPlaylist) ? [...s.ui.tvPlaylist] : [];
        const idx = cur.findIndex((x) => x.id === itemId);
        const target = idx + delta;
        if (idx === -1 || target < 0 || target >= cur.length) return s;
        const [moved] = cur.splice(idx, 1);
        cur.splice(target, 0, moved);
        return {
          ...s,
          ui: {
            ...s.ui,
            tvPlaylist: cur,
            tvMediaUpdatedAt: Date.now(),
          },
        };
      },
      { forcePublish: true }
    );
  }

  updateTvPlaylistItem(itemId, partial = {}) {
    return this.commit(
      (s) => {
        const cur = Array.isArray(s.ui?.tvPlaylist) ? s.ui.tvPlaylist : [];
        const nextList = cur.map((x) =>
          x.id === itemId
            ? {
                ...x,
                ...(partial.name !== undefined ? { name: String(partial.name).trim() || x.name } : {}),
                ...(partial.durationSec !== undefined
                  ? { durationSec: Math.max(1, Math.min(86400, Math.round(Number(partial.durationSec) || 12))) }
                  : {}),
                ...(partial.muted !== undefined ? { muted: Boolean(partial.muted) } : {}),
                ...(partial.cacheLocal !== undefined ? { cacheLocal: Boolean(partial.cacheLocal) } : {}),
                ...(partial.quality !== undefined ? { quality: String(partial.quality) } : {}),
                ...(partial.autoDuration !== undefined ? { autoDuration: Boolean(partial.autoDuration) } : {}),
              }
            : x
        );
        return {
          ...s,
          ui: {
            ...s.ui,
            tvPlaylist: nextList,
          },
        };
      },
      { forcePublish: true }
    );
  }

  setTvPlaylistPlayback({ index, mode, paused } = {}) {
    return this.commit(
      (s) => {
        const list = Array.isArray(s.ui?.tvPlaylist) ? s.ui.tvPlaylist : [];
        const len = Math.max(1, list.length);
        const nextIndex =
          index !== undefined ? ((Number(index) % len) + len) % len : s.ui?.tvPlaylistIndex ?? 0;
        const nextMode =
          mode !== undefined && ['loop', 'shuffle', 'single'].includes(mode)
            ? mode
            : s.ui?.tvPlaylistMode || 'loop';
        const nextPaused = paused !== undefined ? Boolean(paused) : Boolean(s.ui?.tvPlaylistPaused);
        return {
          ...s,
          ui: {
            ...s.ui,
            tvPlaylistIndex: nextIndex,
            tvPlaylistMode: nextMode,
            tvPlaylistPaused: nextPaused,
          },
        };
      },
      { forcePublish: true }
    );
  }

  // ---- Grandma Speech & Categorized Phrase Manager ----

  triggerLiveQuote(text, category = 'manual') {
    if (this.state?.rules?.grandmaEnabled === false) return this.state;
    const cleaned = String(text || '').trim();
    if (!cleaned) return this.state;
    const resolved = resolveGrandmaPhrase(cleaned, this.state);
    const speech = createGrandmaSpeech({
      text: resolved,
      category,
      grandmaConfig: this.state.grandma,
    });
    if (!speech) return this.state;
    this.broadcastGrandmaSpeech(speech);
    return this.state;
  }

  updateGrandmaSettings({
    banterQuotes,
    contextualQuotes,
    gamePointQuotes,
    contextualChancePct,
    stayDurationSec,
    minIntervalSec,
    maxIntervalSec,
  }) {
    return this.commit((s) => {
      const stay = Math.max(
        2,
        Math.min(20, Number(stayDurationSec ?? s.grandma.stayDurationSec) || 5.5)
      );
      const minInt = Math.max(
        1,
        Math.min(60, Number(minIntervalSec ?? s.grandma.minIntervalSec) || 6)
      );
      const maxInt = Math.max(
        minInt,
        Math.min(120, Number(maxIntervalSec ?? s.grandma.maxIntervalSec) || 13)
      );
      const chance = Math.max(
        0,
        Math.min(100, Number(contextualChancePct ?? s.grandma.contextualChancePct ?? 25))
      );

      const cleanList = (arr, fallback) => {
        if (!Array.isArray(arr)) return fallback;
        const cleaned = arr.map((q) => String(q).trim()).filter(Boolean);
        return cleaned.length > 0 ? cleaned : fallback;
      };

      const nextBanter = cleanList(banterQuotes, s.grandma.banterQuotes || DEFAULT_BANTER_QUOTES);
      const nextContextual = cleanList(
        contextualQuotes,
        s.grandma.contextualQuotes || DEFAULT_CONTEXTUAL_QUOTES
      );
      const nextGamePoint = cleanList(
        gamePointQuotes,
        s.grandma.gamePointQuotes || DEFAULT_GAME_POINT_QUOTES
      );

      const now = Date.now();
      const activeExp = Math.max(now, Number(s.grandma.activeSpeech?.expiresAt || 0));
      const intervalChanged =
        minInt !== Number(s.grandma.minIntervalSec) || maxInt !== Number(s.grandma.maxIntervalSec);
      const currentNext = Number(s.grandma.nextBanterAt || 0);
      const nextBanterAt = intervalChanged
        ? activeExp + Math.round(minInt * 1000)
        : currentNext > activeExp + maxInt * 1000
        ? activeExp + Math.round(minInt * 1000)
        : currentNext < activeExp + minInt * 1000 && currentNext > now
        ? activeExp + Math.round(minInt * 1000)
        : currentNext || activeExp + Math.round(minInt * 1000);

      return {
        ...s,
        grandma: {
          ...s.grandma,
          quotes: nextBanter,
          banterQuotes: nextBanter,
          contextualQuotes: nextContextual,
          gamePointQuotes: nextGamePoint,
          contextualChancePct: chance,
          stayDurationSec: stay,
          minIntervalSec: minInt,
          maxIntervalSec: maxInt,
          nextBanterAt,
        },
      };
    }, { forcePublish: true });
  }

  // ---- Presentation Slides ----

  setActiveSlide(slideId) {
    const valid = SLIDE_DEFINITIONS.some((sl) => sl.id === slideId);
    if (!valid) return this.state;
    return this.commit((s) => ({
      ...s,
      presentation: {
        ...s.presentation,
        activeSlide: slideId,
      },
    }));
  }

  setPresentationConfig(partial) {
    return this.commit((s) => ({
      ...s,
      presentation: {
        ...s.presentation,
        ...partial,
        autoRotateSec:
          partial.autoRotateSec !== undefined
            ? Math.max(5, Math.min(120, Number(partial.autoRotateSec) || 18))
            : s.presentation.autoRotateSec,
        autoRotateSlides:
          partial.autoRotateSlides !== undefined
            ? normalizeAutoRotateSlides(partial.autoRotateSlides)
            : s.presentation.autoRotateSlides,
      },
    }));
  }

  exportBackupJSON() {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'Jitter — Live Tournament & Scoreboard',
      championshipMatchId: getChampionshipMatchId(this.state.playerCount, this.state.format),
      state: this.state,
    };
    return JSON.stringify(payload, null, 2);
  }

  /**
   * Import one or more tournaments from JSON:
   *  - Exported backup JSON ({ state: { ... } })
   *  - Raw tournament state JSON ({ tournamentId, matches, players, ... })
   *  - Server sync file (.pingpong-sync-data.json: { activeTournamentId, tournaments: { ... } })
   */
  async importBackupJSON(rawInput, { hostOnCloud = true, assignAsHost = true } = {}) {
    let parsed;
    try {
      parsed = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
    } catch {
      return { ok: false, error: 'Invalid JSON file — could not parse.' };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'JSON file does not contain a valid tournament object.' };
    }

    const isTournamentLike = (obj) =>
      Boolean(obj && typeof obj === 'object' && (obj.matches || obj.players || obj.roster));

    let rawList = [];
    let preferredActiveId = null;

    if (isTournamentLike(parsed.state)) {
      rawList = [parsed.state];
    } else if (
      parsed.tournaments &&
      typeof parsed.tournaments === 'object' &&
      !Array.isArray(parsed.tournaments)
    ) {
      rawList = Object.values(parsed.tournaments).filter(isTournamentLike);
      preferredActiveId = parsed.activeTournamentId || null;
    } else if (isTournamentLike(parsed)) {
      rawList = [parsed];
    }

    if (rawList.length === 0) {
      return {
        ok: false,
        error: 'Unrecognized JSON format — expected an exported tournament backup or sync data file.',
      };
    }

    const pushCloud = Boolean(hostOnCloud && this.remoteSync.connected);
    const cloudById = new Map((this.remoteSync.cloudTournaments || []).map((t) => [t.id, t]));
    const existingIds = new Set([
      ...Object.keys(readTournamentLibraryMap()),
      ...(this.remoteSync.cloudTournaments || []).map((t) => t.id),
      ...(this.remoteSync.cloudTournaments || []).map((t) => t.joinCode).filter(Boolean),
    ]);

    const importedStates = [];
    let primaryState = null;

    for (const rawItem of rawList) {
      const normalized = normalizePersistedState(rawItem);
      const originalId = normalized.tournamentId;
      let targetId = normalized.tournamentId;
      let targetJoinCode = normalized.joinCode;

      // Avoid overwriting a cloud tournament owned by another device if we aren't host/admin
      const existingCloud = cloudById.get(targetId);
      const canOverwriteCloud =
        !existingCloud ||
        !existingCloud.hostDeviceId ||
        existingCloud.hostDeviceId === this.remoteSync.deviceId ||
        Boolean(this.remoteSync.isThisDeviceAdmin);

      if (!targetId || (pushCloud && !canOverwriteCloud)) {
        const freshCode = generateTournamentId(existingIds);
        existingIds.add(freshCode);
        targetId = freshCode;
        targetJoinCode = freshCode;
      } else if (!targetJoinCode) {
        const freshCode = generateTournamentId(existingIds);
        existingIds.add(freshCode);
        targetJoinCode = freshCode;
      }

      const prevHistory = Array.isArray(normalized.hostHistory) ? normalized.hostHistory : [];
      const nextHistory =
        pushCloud && assignAsHost && this.remoteSync.deviceId
          ? Array.from(new Set([...prevHistory, this.remoteSync.deviceId]))
          : prevHistory;

      const prepared = {
        ...normalized,
        tournamentId: targetId,
        joinCode: targetJoinCode,
        destruction: null,
        ...(pushCloud && assignAsHost && this.remoteSync.deviceId
          ? {
            hostDeviceId: this.remoteSync.deviceId,
            hostDeviceName: this.remoteSync.deviceName || normalized.hostDeviceName || 'Host',
            hostHistory: nextHistory,
          }
          : {}),
        updatedAt: Date.now(),
      };

      importedStates.push(prepared);
      if (!primaryState || (preferredActiveId && originalId === preferredActiveId)) {
        primaryState = prepared;
      }
    }

    if (!primaryState) {
      return { ok: false, error: 'No valid tournaments found in JSON file.' };
    }

    // Push to cloud server if connected, otherwise save to local library
    if (pushCloud) {
      for (const item of importedStates) {
        const isPrimary = item.tournamentId === primaryState.tournamentId;
        const res = await this.pushStateToRemote(item, { activate: isPrimary });
        if (!res && isPrimary) {
          return {
            ok: false,
            error: 'Server rejected the import (check Admin / creation permissions).',
          };
        }
      }
    } else if (this.persistEnabled) {
      for (const item of importedStates) {
        this.saveToLibrary(item);
      }
    }

    this.clearPendingScoreTimer();
    this.pendingScorePush = null;
    this.localPreviewMatchId = null;
    this.syncMode = 'live';
    this.hasUnpublishedChanges = false;
    this.hasActiveTournament = true;
    this.programState = primaryState;
    this.state = primaryState;
    this.remoteSync = {
      ...this.remoteSync,
      activeSource: pushCloud ? 'cloud' : 'local',
      currentRole: pushCloud ? 'host' : 'local',
    };
    this.broadcastState(primaryState, { skipRemote: true });
    this.persistStudioDraft();
    this.resumeAfterDisconnect();
    this.emit();

    return {
      ok: true,
      count: importedStates.length,
      tournament: primaryState,
      tournaments: importedStates,
      pushedToCloud: pushCloud,
    };
  }
}

export const tournamentStore = new TournamentStore();
