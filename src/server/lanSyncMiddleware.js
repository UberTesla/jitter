import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import * as webpush from 'web-push';
import {
  generateFourWordId,
  matchTournamentJoinKey,
  normalizeFourWordId,
  resolveTournamentJoinCode,
} from '../engine/tournamentId.js';
import {
  ROLE_LEVEL,
  canAssignRole,
  canAssignTabRole,
  canDisconnectRole,
  getRolePermissions,
  isPreviousTournamentHost,
  normalizeRole,
  resolveDeviceRole,
  resolveEffectiveRole,
} from '../engine/roles.js';
import { rankLanAddresses } from '../engine/lanAddress.js';
import { computeTournamentStats } from '../engine/bracketGenerator.js';
import { isMatchNearingEnd } from '../engine/scoringEngine.js';
import { resolveMessageTemplate } from '../engine/grandmaVariables.js';

const DESTROY_GRACE_MS = 5 * 60 * 1000;

function mergeHostHistory(...sources) {
  const seen = new Set();
  for (const src of sources) {
    if (Array.isArray(src)) {
      for (const id of src) {
        if (typeof id === 'string' && id.trim()) seen.add(id.trim());
      }
    } else if (typeof src === 'string' && src.trim()) {
      seen.add(src.trim());
    }
  }
  return Array.from(seen);
}

function normalizeRemoteIp(rawIp) {
  const ip = String(rawIp || '').trim();
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function cleanHostnameLabel(rawHost) {
  const cleaned = String(rawHost || '')
    .trim()
    .replace(/\.(local|lan|home|localdomain|arpa)\.?$/i, '')
    .replace(/\.+$/, '');
  if (!cleaned || /^\d+\.\d+\.\d+\.\d+$/.test(cleaned)) return '';
  return cleaned;
}

function getRequestClientIp(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0].trim();
    if (first) return normalizeRemoteIp(first);
  }
  const realIp = req?.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return normalizeRemoteIp(realIp.trim());
  }
  return normalizeRemoteIp(req?.socket?.remoteAddress);
}

function isPrivateLanIp(ip = '') {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return false;
  if (s === '127.0.0.1' || s === '::1') return true;
  if (s.startsWith('10.') || s.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true;
  if (s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
  return false;
}

async function resolveClientDeviceName(req, serverInfo) {
  const clientIp = getRequestClientIp(req);
  const localLanIps = new Set((serverInfo?.lanAddresses || []).map((a) => a.address));
  const isLocalClient =
    !clientIp ||
    clientIp === '127.0.0.1' ||
    clientIp === '::1' ||
    localLanIps.has(clientIp);

  if (isLocalClient) {
    return {
      clientIp: clientIp || '127.0.0.1',
      isLocalClient: true,
      clientDeviceName: cleanHostnameLabel(serverInfo?.hostname) || serverInfo?.hostname || '',
    };
  }

  // Only run reverse-DNS for private LAN IPs (avoid slow/ugly ISP PTR records on public cloud deploys)
  let clientDeviceName = '';
  if (isPrivateLanIp(clientIp)) {
    try {
      const names = await Promise.race([
        dns.promises.reverse(clientIp),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve([]), 350);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
      if (Array.isArray(names) && names.length > 0) {
        clientDeviceName = cleanHostnameLabel(names[0]);
      }
    } catch {
      // Reverse DNS not available for this LAN IP — browser will fall back to model/UA detection
    }
  }

  return {
    clientIp,
    isLocalClient: false,
    clientDeviceName,
  };
}

const DATA_FILENAME = '.pingpong-sync-data.json';
const MEDIA_BIN_FILENAME = '.pingpong-sync-media.bin';
const MEDIA_META_FILENAME = '.pingpong-sync-media.json';
const ANALYTICS_FILENAME = '.pingpong-usage-stats.json';
const MAX_ANALYTICS_EVENTS = 15000;

const DEFAULT_HUB_SETTINGS = Object.freeze({
  hubTitle: 'JITTER',
  allowPublicCreation: true,
  defaultIsPublic: true,
  defaultIsSecure: true,
  defaultRequireScorekeeperApproval: true,
  allowedKeyTypos: 2,
  telemetryEnabled: true,
});

function normalizeHubSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const defaultIsPublic =
    src.defaultIsPublic !== undefined ? Boolean(src.defaultIsPublic) : DEFAULT_HUB_SETTINGS.defaultIsPublic;
  const rawTypos =
    src.allowedKeyTypos !== undefined
      ? Number(src.allowedKeyTypos)
      : DEFAULT_HUB_SETTINGS.allowedKeyTypos;
  const allowedKeyTypos = Number.isFinite(rawTypos)
    ? Math.max(0, Math.min(5, Math.floor(rawTypos)))
    : DEFAULT_HUB_SETTINGS.allowedKeyTypos;
  return {
    hubTitle: String(src.hubTitle || DEFAULT_HUB_SETTINGS.hubTitle).trim() || DEFAULT_HUB_SETTINGS.hubTitle,
    allowPublicCreation:
      src.allowPublicCreation !== undefined
        ? Boolean(src.allowPublicCreation)
        : DEFAULT_HUB_SETTINGS.allowPublicCreation,
    defaultIsPublic,
    defaultIsSecure: defaultIsPublic
      ? src.defaultIsSecure !== undefined
        ? Boolean(src.defaultIsSecure)
        : DEFAULT_HUB_SETTINGS.defaultIsSecure
      : true,
    defaultRequireScorekeeperApproval:
      src.defaultRequireScorekeeperApproval !== undefined
        ? Boolean(src.defaultRequireScorekeeperApproval)
        : DEFAULT_HUB_SETTINGS.defaultRequireScorekeeperApproval,
    allowedKeyTypos,
    telemetryEnabled:
      src.telemetryEnabled !== undefined
        ? Boolean(src.telemetryEnabled)
        : DEFAULT_HUB_SETTINGS.telemetryEnabled,
  };
}

function isLocalServerRequest(req, serverInfo) {
  const clientIp = normalizeRemoteIp(req?.socket?.remoteAddress);
  const localLanIps = new Set((serverInfo?.lanAddresses || []).map((a) => a.address));
  return !clientIp || clientIp === '127.0.0.1' || clientIp === '::1' || localLanIps.has(clientIp);
}

export function collectLocalServerInfo(port = 5173, appMeta = {}) {
  const nets = os.networkInterfaces();
  const rawLanAddresses = [];
  for (const [iface, infos] of Object.entries(nets)) {
    for (const info of infos || []) {
      const isV4 = info.family === 'IPv4' || info.family === 4;
      if (isV4 && !info.internal) {
        rawLanAddresses.push({
          interfaceName: iface,
          address: info.address,
        });
      }
    }
  }
  // Always prioritize real physical LAN Wi-Fi / Ethernet IPv4 addresses over VPN/Tailscale/WSL/virtual adapters
  const lanAddresses = rankLanAddresses(rawLanAddresses);
  return {
    appName: appMeta.name || 'ping-pong-championship-scoreboard',
    appVersion: appMeta.version || '1.0.0',
    hostname: os.hostname(),
    platform: `${process.platform} (${process.arch})`,
    nodeVersion: process.version,
    port,
    lanAddresses,
    collectedAt: new Date().toISOString(),
  };
}

function getDisplayIpForRequest(req, serverInfo) {
  const ip = getRequestClientIp(req);
  const primaryLanIp = serverInfo?.lanAddresses?.[0]?.address || '127.0.0.1';
  if (!ip || ip === '127.0.0.1' || ip === '::1') {
    return primaryLanIp;
  }
  return ip;
}

function normalizeAccessConfig(rawAccess) {
  return {
    isSecure: rawAccess?.isSecure !== undefined ? Boolean(rawAccess.isSecure) : true,
    isPublic: rawAccess?.isPublic !== undefined ? Boolean(rawAccess.isPublic) : true,
  };
}

function summarizeTournament(stateObj) {
  if (!stateObj || typeof stateObj !== 'object') return null;
  const allMatches = Object.values(stateObj.matches || {});
  const realMatches = allMatches.filter((m) => !m.isBye);
  const completedMatches = realMatches.filter((m) => m.completed).length;
  const champ = stateObj.championId
    ? (stateObj.players || []).find((p) => p.id === stateObj.championId)
    : null;
  const id = stateObj.tournamentId || 't-default';
  const joinCode = resolveTournamentJoinCode(stateObj);
  const access = normalizeAccessConfig(stateObj.access);
  return {
    id,
    joinCode,
    tournamentName: stateObj.tournamentName || 'Ping Pong Championship',
    entryMode: stateObj.entryMode === 'teams' ? 'teams' : 'singles',
    format: stateObj.format === 'double' ? 'double' : 'single',
    playerCount: stateObj.playerCount || (stateObj.players || []).length,
    totalPlayers: stateObj.totalPlayers || stateObj.roster?.length || stateObj.playerCount || 8,
    completedMatches,
    totalMatches: realMatches.length,
    championName: champ?.name || null,
    theme: stateObj.ui?.theme || 'arena',
    hostDeviceId: stateObj.hostDeviceId || null,
    hostDeviceName: stateObj.hostDeviceName || 'Sync Host',
    hostIp: stateObj.hostIp || null,
    hostHistory: mergeHostHistory(stateObj.hostHistory, stateObj.hostDeviceId),
    destruction: stateObj.destruction || null,
    isSecure: access.isSecure,
    isPublic: access.isPublic,
    createdAt: stateObj.createdAt || stateObj.updatedAt || Date.now(),
    updatedAt: stateObj.updatedAt || Date.now(),
    source: 'cloud',
  };
}

function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Media file too large (max 50MB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Zero-dependency LAN/Cloud Sync Hub Middleware.
 * Persists all shared tournaments & active live state to `.pingpong-sync-data.json`
 * and streams real-time SSE updates to every connected laptop, phone, tablet, and TV.
 */
export function createLanSyncHandler({
  rootDir = process.cwd(),
  getPort = () => 5173,
  appMeta = {},
} = {}) {
  const dataPath = path.join(rootDir, DATA_FILENAME);
  const mediaBinPath = path.join(rootDir, MEDIA_BIN_FILENAME);
  const mediaMetaPath = path.join(rootDir, MEDIA_META_FILENAME);
  const analyticsPath = path.join(rootDir, ANALYTICS_FILENAME);
  const sseClients = new Map(); // res -> { tabId, deviceId, deviceName, ip, viewMode, tournamentId, connectedAt }
  const destructionTimers = new Map(); // tournamentId -> Timeout
  const serverBootId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  let analyticsEvents = [];
  let analyticsSaveTimer = null;
  try {
    if (fs.existsSync(analyticsPath)) {
      const parsedAnalytics = JSON.parse(fs.readFileSync(analyticsPath, 'utf8'));
      if (Array.isArray(parsedAnalytics)) {
        analyticsEvents = parsedAnalytics.slice(-MAX_ANALYTICS_EVENTS);
      }
    }
  } catch {
    analyticsEvents = [];
  }
  const scheduleAnalyticsSave = () => {
    if (analyticsSaveTimer) return;
    analyticsSaveTimer = setTimeout(() => {
      analyticsSaveTimer = null;
      try {
        fs.writeFileSync(analyticsPath, JSON.stringify(analyticsEvents), 'utf8');
      } catch {
        // Ignore disk errors
      }
    }, 500);
    if (typeof analyticsSaveTimer.unref === 'function') analyticsSaveTimer.unref();
  };

  let store = {
    activeTournamentId: null,
    tournaments: {},
    lastPointAt: 0,
    hosts: {}, // Unlimited simultaneous hosts keyed by deviceId: { deviceId, deviceName, ip, claimedAt }
    admins: {}, // Hub-wide Admins keyed by deviceId: { deviceId, deviceName, ip, grantedAt, source }
    adminKey: generateFourWordId(),
    hubSettings: normalizeHubSettings(),
    authorizedGuests: {}, // { [tournamentId]: { [deviceId]: { authorizedAt } } }
    hostDevice: null, // Most recent host (backward-compatible alias)
    vapidKeys: null, // { publicKey, privateKey } auto-generated once for Web Push
    pushSubscriptions: {}, // { [deviceId]: Array<PushSubscriptionJSON> }
  };

  const ensureVapidKeys = () => {
    const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
    const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
    const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:scoreboard@localhost';
    if (envPub && envPriv) {
      try {
        webpush.setVapidDetails(subject, envPub, envPriv);
        return { publicKey: envPub, privateKey: envPriv };
      } catch {
        return null;
      }
    }
    if (!store.vapidKeys?.publicKey || !store.vapidKeys?.privateKey) {
      store.vapidKeys = webpush.generateVAPIDKeys();
      scheduleDiskSave();
    }
    try {
      webpush.setVapidDetails(subject, store.vapidKeys.publicKey, store.vapidKeys.privateKey);
      return store.vapidKeys;
    } catch {
      return null;
    }
  };

  const sendWebPushToDevices = async (deviceIds, pushPayload) => {
    const keys = ensureVapidKeys();
    if (!keys) return 0;
    const ids = Array.from(new Set((deviceIds || []).filter(Boolean)));
    if (ids.length === 0) return 0;
    const bodyStr = JSON.stringify(pushPayload);
    let sent = 0;
    let mutated = false;

    for (const devId of ids) {
      const subs = Array.isArray(store.pushSubscriptions?.[devId])
        ? store.pushSubscriptions[devId]
        : [];
      if (subs.length === 0) continue;
      const keep = [];
      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub, bodyStr);
          sent += 1;
          keep.push(sub);
        } catch (err) {
          const code = err?.statusCode;
          // Prune expired/unsubscribed endpoints (404 / 410)
          if (code === 404 || code === 410) {
            mutated = true;
          } else {
            keep.push(sub);
          }
        }
      }
      if (keep.length !== subs.length) {
        if (keep.length === 0) delete store.pushSubscriptions[devId];
        else store.pushSubscriptions[devId] = keep;
      }
    }
    if (mutated) scheduleDiskSave();
    return sent;
  };

  const isDeviceAdmin = (deviceId = '') => Boolean(deviceId && store.admins?.[deviceId]);

  const getAdminsList = () =>
    Object.values(store.admins || {}).sort((a, b) => (a.grantedAt || 0) - (b.grantedAt || 0));

  const getAdminDeviceIds = () => Object.keys(store.admins || {});

  const registerAdminDevice = ({ deviceId, deviceName, ip, source = 'grant' }) => {
    if (!deviceId) return null;
    const prev = store.admins[deviceId] || {};
    const resolvedSource = prev.source || source;
    const isOriginalServerAdmin =
      Boolean(prev.isOriginalServerAdmin) ||
      resolvedSource === 'local';
    const record = {
      deviceId,
      deviceName: String(deviceName || prev.deviceName || 'Hub Admin').trim(),
      ip: ip || prev.ip || '127.0.0.1',
      grantedAt: prev.grantedAt || Date.now(),
      source: resolvedSource,
      isOriginalServerAdmin,
    };
    store.admins[deviceId] = record;
    return record;
  };

  const getAdminPayloadFor = (viewerDeviceId = '') => {
    const viewerIsAdmin = isDeviceAdmin(viewerDeviceId);
    return {
      admins: getAdminsList(),
      isAdmin: viewerIsAdmin,
      hubSettings: normalizeHubSettings(store.hubSettings),
      ...(viewerIsAdmin ? { adminKey: store.adminKey } : {}),
    };
  };

  const authorizeGuest = (tournamentId, deviceId) => {
    if (!tournamentId || !deviceId) return;
    if (!store.authorizedGuests || typeof store.authorizedGuests !== 'object') {
      store.authorizedGuests = {};
    }
    if (!store.authorizedGuests[tournamentId]) {
      store.authorizedGuests[tournamentId] = {};
    }
    store.authorizedGuests[tournamentId][deviceId] = { authorizedAt: Date.now() };
  };

  const revokeGuest = (deviceId, tournamentId = null) => {
    if (!deviceId || !store.authorizedGuests) return;
    if (tournamentId) {
      if (store.authorizedGuests[tournamentId]) {
        delete store.authorizedGuests[tournamentId][deviceId];
      }
      return;
    }
    for (const tid of Object.keys(store.authorizedGuests)) {
      if (store.authorizedGuests[tid]) {
        delete store.authorizedGuests[tid][deviceId];
      }
    }
  };

  const isDeviceAuthorizedForTournament = (entry, deviceId = '', providedCode = '') => {
    if (!entry) return false;
    // Hub Admins are always authorized to view & manage every tournament (including Private & Secure)
    if (deviceId && isDeviceAdmin(deviceId)) return true;
    // Previous hosts retain access during a pending destruction countdown so they can claim & cancel
    if (entry.destruction && deviceId && isPreviousTournamentHost(entry, deviceId)) return true;
    // Unclaimed ("Sync Host") or Open/Unsecure tournaments allow any device
    if (!entry.hostDeviceId) return true;
    const access = normalizeAccessConfig(entry.access);
    if (!access.isSecure) return true;
    // Host is always authorized for their own tournament
    if (deviceId && entry.hostDeviceId === deviceId) return true;
    // Valid current 4-word join key (supports run-on keys + configured Hub typo tolerance)
    const expectedCode = resolveTournamentJoinCode(entry);
    const maxTypos = store.hubSettings?.allowedKeyTypos ?? DEFAULT_HUB_SETTINGS.allowedKeyTypos;
    if (providedCode && matchTournamentJoinKey(providedCode, expectedCode, { maxTypos }).matched) {
      return true;
    }
    // Currently authorized guest (who has NOT been disconnected by host)
    if (deviceId && store.authorizedGuests?.[entry.tournamentId]?.[deviceId]) {
      return true;
    }
    return false;
  };

  const getHostsList = () =>
    Object.values(store.hosts || {}).sort((a, b) => (b.claimedAt || 0) - (a.claimedAt || 0));

  const syncPrimaryHostAlias = () => {
    const list = getHostsList();
    store.hostDevice = list[0] || null;
  };

  const registerHostDevice = ({ deviceId, deviceName, ip }) => {
    if (!deviceId) return null;
    const prev = store.hosts[deviceId] || {};
    const record = {
      deviceId,
      deviceName: String(deviceName || prev.deviceName || 'Tournament Host').trim(),
      ip: ip || prev.ip || '127.0.0.1',
      claimedAt: Date.now(),
    };
    store.hosts[deviceId] = record;
    // Also refresh display name / IP on any tournaments hosted by this device
    for (const t of Object.values(store.tournaments)) {
      if (t && t.hostDeviceId === deviceId) {
        t.hostDeviceName = record.deviceName;
        t.hostIp = record.ip;
      }
    }
    syncPrimaryHostAlias();
    return record;
  };

  // Disk-backed custom TV media cache so cross-device CRT video/GIF sync survives server restarts
  let activeMedia = null; // { buffer: Buffer, name: string, type: string, kind: string, updatedAt: number }
  try {
    if (fs.existsSync(mediaBinPath) && fs.existsSync(mediaMetaPath)) {
      const meta = JSON.parse(fs.readFileSync(mediaMetaPath, 'utf8'));
      const buffer = fs.readFileSync(mediaBinPath);
      if (buffer && buffer.length > 0 && meta && typeof meta === 'object') {
        activeMedia = {
          buffer,
          name: String(meta.name || 'tv-media'),
          type: String(meta.type || 'application/octet-stream'),
          kind: String(meta.kind || (String(meta.type || '').startsWith('video/') ? 'video' : 'image')),
          updatedAt: Number(meta.updatedAt) || Date.now(),
        };
      }
    }
  } catch {
    activeMedia = null;
  }

  const persistActiveMediaToDisk = (mediaObj) => {
    try {
      if (!mediaObj) {
        if (fs.existsSync(mediaBinPath)) fs.unlinkSync(mediaBinPath);
        if (fs.existsSync(mediaMetaPath)) fs.unlinkSync(mediaMetaPath);
        return;
      }
      fs.writeFileSync(mediaBinPath, mediaObj.buffer);
      fs.writeFileSync(
        mediaMetaPath,
        JSON.stringify({
          name: mediaObj.name,
          type: mediaObj.type,
          kind: mediaObj.kind,
          updatedAt: mediaObj.updatedAt,
        }),
        'utf8'
      );
    } catch {
      // Non-fatal: keep in-memory cache even if disk write is unavailable
    }
  };

  const findTournamentKeyByCodeOrId = (rawCodeOrId, { allowFuzzy = false } = {}) => {
    if (!rawCodeOrId) return null;
    if (store.tournaments[rawCodeOrId]) return rawCodeOrId;
    const normalized = normalizeFourWordId(rawCodeOrId);
    if (!normalized) return null;
    // 1. Exact canonical match (also checks run-on exact match when allowFuzzy is true)
    for (const [key, entry] of Object.entries(store.tournaments)) {
      const code = resolveTournamentJoinCode(entry);
      if (
        normalizeFourWordId(key) === normalized ||
        normalizeFourWordId(entry?.tournamentId) === normalized ||
        code === normalized
      ) {
        return key;
      }
      if (allowFuzzy && matchTournamentJoinKey(rawCodeOrId, code, { maxTypos: 0 }).matched) {
        return key;
      }
    }
    if (!allowFuzzy) return null;

    // 2. Fuzzy typo match up to Hub Admin's configured `allowedKeyTypos`
    const maxTypos = store.hubSettings?.allowedKeyTypos ?? DEFAULT_HUB_SETTINGS.allowedKeyTypos;
    if (maxTypos <= 0) return null;

    let bestKey = null;
    let bestDist = Infinity;
    let tied = false;
    for (const [key, entry] of Object.entries(store.tournaments)) {
      const code = resolveTournamentJoinCode(entry);
      const { matched, distance } = matchTournamentJoinKey(rawCodeOrId, code, { maxTypos });
      if (!matched) continue;
      if (distance < bestDist) {
        bestDist = distance;
        bestKey = key;
        tied = false;
      } else if (distance === bestDist) {
        tied = true;
      }
    }
    return bestKey && !tied ? bestKey : null;
  };

  const upsertTournament = (incoming, hostMeta = null) => {
    const joinCode = resolveTournamentJoinCode(incoming);
    const requestedId = incoming.tournamentId || joinCode;
    // Prevent duplicate cloud entries sharing the same 4-word joinCode
    const existingKey =
      store.tournaments[requestedId]
        ? requestedId
        : findTournamentKeyByCodeOrId(joinCode);
    const canonicalId = existingKey || requestedId;
    const prev = store.tournaments[canonicalId] || null;

    const existingHostId = prev
      ? prev.hostDeviceId || null
      : incoming.hostDeviceId || null;
    const incomingHostId = hostMeta?.deviceId || null;
    const isNewOrOwner =
      !prev || !existingHostId || (incomingHostId && incomingHostId === existingHostId);

    // Preserve unclaimed ("Sync Host") status when an already-abandoned tournament receives score updates;
    // for a brand-new tournament pushed to Cloud, assign host ownership to the publishing device!
    const hostDeviceId = prev
      ? existingHostId
      : incoming.hostDeviceId || incomingHostId || null;
    const hostDeviceName = hostDeviceId
      ? isNewOrOwner
        ? hostMeta?.deviceName || incoming.hostDeviceName || prev?.hostDeviceName || 'Sync Host'
        : prev?.hostDeviceName || incoming.hostDeviceName || 'Sync Host'
      : 'Sync Host';
    const hostIp = hostDeviceId
      ? isNewOrOwner
        ? hostMeta?.ip || incoming.hostIp || prev?.hostIp || null
        : prev?.hostIp || incoming.hostIp || null
      : null;

    const access = isNewOrOwner
      ? normalizeAccessConfig(incoming.access ?? prev?.access)
      : normalizeAccessConfig(prev?.access ?? incoming.access);

    // Preserve authoritative server userRoles, tabRoles, scorekeeperRequests, hostHistory & destruction
    // Preserve authoritative server userRoles, tabRoles, scorekeeperRequests, joinRequests, hostHistory & destruction
    const userRoles =
      prev?.userRoles && typeof prev.userRoles === 'object'
        ? { ...prev.userRoles }
        : incoming.userRoles && typeof incoming.userRoles === 'object'
          ? { ...incoming.userRoles }
          : {};
    const tabRoles =
      prev?.tabRoles && typeof prev.tabRoles === 'object'
        ? { ...prev.tabRoles }
        : incoming.tabRoles && typeof incoming.tabRoles === 'object'
          ? { ...incoming.tabRoles }
          : {};
    const scorekeeperRequests = Array.isArray(prev?.scorekeeperRequests)
      ? [...prev.scorekeeperRequests]
      : Array.isArray(incoming.scorekeeperRequests)
        ? [...incoming.scorekeeperRequests]
        : [];
    const joinRequests = Array.isArray(prev?.joinRequests)
      ? [...prev.joinRequests]
      : Array.isArray(incoming.joinRequests)
        ? [...incoming.joinRequests]
        : [];
    const demotedScorekeepers = Array.isArray(prev?.demotedScorekeepers)
      ? [...prev.demotedScorekeepers]
      : Array.isArray(incoming.demotedScorekeepers)
        ? [...incoming.demotedScorekeepers]
        : [];
    const deniedDevices = Array.isArray(prev?.deniedDevices)
      ? [...prev.deniedDevices]
      : Array.isArray(incoming.deniedDevices)
        ? [...incoming.deniedDevices]
        : [];
    const kickedDevices = Array.isArray(prev?.kickedDevices)
      ? [...prev.kickedDevices]
      : Array.isArray(incoming.kickedDevices)
        ? [...incoming.kickedDevices]
        : [];
    const playerClaims =
      prev?.playerClaims && typeof prev.playerClaims === 'object'
        ? { ...prev.playerClaims }
        : incoming.playerClaims && typeof incoming.playerClaims === 'object'
          ? { ...incoming.playerClaims }
          : {};
    const preservedActiveBanner =
      prev?.presentation?.activeBanner !== undefined
        ? prev.presentation.activeBanner
        : incoming.presentation?.activeBanner ?? null;
    const hostHistory = mergeHostHistory(
      prev?.hostHistory,
      incoming.hostHistory,
      prev?.hostDeviceId,
      hostDeviceId
    );
    const destruction = prev ? prev.destruction || null : incoming.destruction || null;

    const stamped = {
      ...incoming,
      tournamentId: canonicalId,
      joinCode,
      hostDeviceId,
      hostDeviceName,
      hostIp,
      hostHistory,
      destruction,
      access,
      userRoles,
      tabRoles,
      scorekeeperRequests,
      joinRequests,
      demotedScorekeepers,
      deniedDevices,
      kickedDevices,
      playerClaims,
      presentation: {
        ...(incoming.presentation || {}),
        activeBanner: preservedActiveBanner,
      },
      updatedAt: incoming.updatedAt || Date.now(),
    };
    store.tournaments[canonicalId] = stamped;
    return stamped;
  };

  // Load persisted hub state from disk if available (and deduplicate by joinCode)
  try {
    if (fs.existsSync(dataPath)) {
      const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const loadedHosts =
          parsed.hosts && typeof parsed.hosts === 'object' ? { ...parsed.hosts } : {};
        if (parsed.hostDevice?.deviceId && !loadedHosts[parsed.hostDevice.deviceId]) {
          loadedHosts[parsed.hostDevice.deviceId] = parsed.hostDevice;
        }
        store = {
          activeTournamentId: parsed.activeTournamentId || null,
          tournaments: {},
          lastPointAt: Number(parsed.lastPointAt) || 0,
          hosts: loadedHosts,
          admins:
            parsed.admins && typeof parsed.admins === 'object' ? { ...parsed.admins } : {},
          adminKey:
            typeof parsed.adminKey === 'string' && normalizeFourWordId(parsed.adminKey)
              ? normalizeFourWordId(parsed.adminKey)
              : generateFourWordId(),
          hubSettings: normalizeHubSettings(parsed.hubSettings),
          authorizedGuests:
            parsed.authorizedGuests && typeof parsed.authorizedGuests === 'object'
              ? parsed.authorizedGuests
              : {},
          hostDevice: parsed.hostDevice || null,
          vapidKeys:
            parsed.vapidKeys?.publicKey && parsed.vapidKeys?.privateKey ? parsed.vapidKeys : null,
          pushSubscriptions:
            parsed.pushSubscriptions && typeof parsed.pushSubscriptions === 'object'
              ? parsed.pushSubscriptions
              : {},
          chatByTournament:
            parsed.chatByTournament && typeof parsed.chatByTournament === 'object'
              ? parsed.chatByTournament
              : {},
        };
        syncPrimaryHostAlias();
        if (parsed.tournaments && typeof parsed.tournaments === 'object') {
          for (const entry of Object.values(parsed.tournaments)) {
            if (entry && entry.matches && entry.players) {
              upsertTournament(entry);
            }
          }
        }
      }
    }
  } catch {
    // Start fresh if file is malformed
  }

  let saveTimer = null;
  const scheduleDiskSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.writeFileSync(dataPath, JSON.stringify(store, null, 2), 'utf8');
      } catch {
        // Ignore disk write errors gracefully
      }
    }, 150);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  };

  const getActiveState = () => {
    if (store.activeTournamentId && store.tournaments[store.activeTournamentId]) {
      return store.tournaments[store.activeTournamentId];
    }
    const all = Object.values(store.tournaments).sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
    );
    if (all.length > 0) {
      store.activeTournamentId = all[0].tournamentId || 't-default';
      return all[0];
    }
    return null;
  };

  const getLibraryStats = () => {
    const all = Object.values(store.tournaments).filter(Boolean);
    const totalCloudTournaments = all.length;
    const privateCloudCount = all.filter((e) => normalizeAccessConfig(e.access).isPublic === false).length;
    return { totalCloudTournaments, privateCloudCount };
  };

  const getLibrarySummaries = (viewerDeviceId = null) => {
    const viewerIsAdmin = isDeviceAdmin(viewerDeviceId);
    return Object.values(store.tournaments)
      .filter((entry) => {
        if (!entry) return false;
        if (viewerIsAdmin) return true;
        const access = normalizeAccessConfig(entry.access);
        if (access.isPublic !== false) return true;
        // Private tournaments are visible to their own host (and previous hosts during a destruction countdown)
        if (viewerDeviceId && entry.hostDeviceId && entry.hostDeviceId === viewerDeviceId) return true;
        if (viewerDeviceId && entry.destruction && isPreviousTournamentHost(entry, viewerDeviceId)) {
          return true;
        }
        return false;
      })
      .map((entry) => {
        const summary = summarizeTournament(entry);
        if (!summary) return null;
        return {
          ...summary,
          ...(viewerDeviceId
            ? {
              isAuthorized: isDeviceAuthorizedForTournament(entry, viewerDeviceId),
              joinRequestPending: Boolean(
                Array.isArray(entry.joinRequests) &&
                entry.joinRequests.some((r) => r && r.deviceId === viewerDeviceId)
              ),
              canCancelDestruction: Boolean(
                entry.destruction &&
                (viewerIsAdmin || isPreviousTournamentHost(entry, viewerDeviceId))
              ),
              canManageAsAdmin: viewerIsAdmin,
            }
            : {}),
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  };

  const getConnectedClientsList = () => {
    const adminIds = getAdminDeviceIds();
    const list = [];
    for (const meta of sseClients.values()) {
      const t = meta.tournamentId ? store.tournaments[meta.tournamentId] : null;
      const isAdmin = isDeviceAdmin(meta.deviceId);
      const deviceRole = t
        ? resolveDeviceRole(t, meta.deviceId, { adminDeviceIds: adminIds })
        : isAdmin
          ? 'admin'
          : 'spectator';
      const effectiveRole = t
        ? resolveEffectiveRole(t, meta.deviceId, meta.tabId, { adminDeviceIds: adminIds })
        : isAdmin
          ? 'admin'
          : 'spectator';
      const tabRoleOverride =
        t && meta.tabId && t.tabRoles?.[meta.tabId] ? normalizeRole(t.tabRoles[meta.tabId]) : null;
      const isRegisteredHost = Boolean(meta.deviceId && store.hosts[meta.deviceId]);
      list.push({
        tabId: meta.tabId,
        deviceId: meta.deviceId,
        deviceName: meta.deviceName,
        ip: meta.ip,
        viewMode: meta.viewMode,
        tournamentId: meta.tournamentId || null,
        tournamentName: t?.tournamentName || null,
        isAdmin,
        isHost: effectiveRole === 'host' || isRegisteredHost,
        deviceRole,
        tabRoleOverride,
        role: effectiveRole,
        connectedAt: meta.connectedAt,
        clientInfo: meta.clientInfo || null,
      });
    }
    return list.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
  };

  const broadcastSSE = (eventName, payload) => {
    const encoded = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients.keys()) {
      try {
        res.write(encoded);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  /**
   * Sends viewer-scoped ADMIN_UPDATE events over SSE so Hub Admins receive the current
   * adminKey and full private+public tournament list while non-admins never see adminKey.
   */
  const broadcastAdminUpdateSSE = (sender = null) => {
    const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
    const hosts = getHostsList();
    const clients = getConnectedClientsList();
    for (const [res, meta] of sseClients.entries()) {
      const payload = {
        sender,
        ...getAdminPayloadFor(meta.deviceId),
        tournaments: getLibrarySummaries(meta.deviceId),
        totalCloudTournaments,
        privateCloudCount,
        activeTournamentId: store.activeTournamentId,
        hosts,
        connectedClients: sseClients.size,
        clients,
      };
      try {
        res.write(`event: ADMIN_UPDATE\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  /**
   * Sends STATE_SYNC to connected SSE clients, stripping `state` for any client
   * that is NOT authorized for that secure tournament so kicked/unauthorized devices
   * never receive live updates for a tournament they don't have access to.
   */
  const broadcastStateSyncSSE = (payload) => {
    const tournamentEntry = payload?.state || null;
    const serverTime = Date.now();
    for (const [res, meta] of sseClients.entries()) {
      const canSeeState =
        tournamentEntry && isDeviceAuthorizedForTournament(tournamentEntry, meta.deviceId);
      const viewerSummaries = isDeviceAdmin(meta.deviceId)
        ? getLibrarySummaries(meta.deviceId)
        : payload.tournaments;
      const clientPayload = canSeeState
        ? { ...payload, serverTime, tournaments: viewerSummaries }
        : {
          ...payload,
          serverTime,
          tournaments: viewerSummaries,
          state: null,
        };
      try {
        res.write(`event: STATE_SYNC\ndata: ${JSON.stringify(clientPayload)}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  // Periodic SSE keepalive heartbeat so mobile browsers keep the connection alive
  const heartbeat = setInterval(() => {
    for (const res of sseClients.keys()) {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
  }, 20000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const clearDestructionTimer = (tournamentId) => {
    const existing = destructionTimers.get(tournamentId);
    if (existing) {
      clearTimeout(existing);
      destructionTimers.delete(tournamentId);
    }
  };

  const executeTournamentDestruction = (tournamentId) => {
    clearDestructionTimer(tournamentId);
    const entry = store.tournaments[tournamentId];
    if (!entry || !entry.destruction) return false;
    const destroyedName = entry.tournamentName || 'Tournament';
    delete store.tournaments[tournamentId];
    if (store.authorizedGuests && store.authorizedGuests[tournamentId]) {
      delete store.authorizedGuests[tournamentId];
    }
    if (store.activeTournamentId === tournamentId) {
      const next = Object.values(store.tournaments).sort(
        (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
      )[0];
      store.activeTournamentId = next?.tournamentId || null;
    }
    for (const meta of sseClients.values()) {
      if (meta.tournamentId === tournamentId) {
        meta.tournamentId = null;
      }
    }
    scheduleDiskSave();
    const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
    broadcastSSE('TOURNAMENT_DESTROYED', {
      tournamentId,
      tournamentName: destroyedName,
      destroyedAt: Date.now(),
      activeTournamentId: store.activeTournamentId,
      tournaments: getLibrarySummaries(null),
      totalCloudTournaments,
      privateCloudCount,
      hosts: getHostsList(),
    });
    broadcastSSE('LIBRARY_UPDATE', {
      activeTournamentId: store.activeTournamentId,
      tournaments: getLibrarySummaries(null),
      totalCloudTournaments,
      privateCloudCount,
      hosts: getHostsList(),
    });
    broadcastSSE('CLIENTS_UPDATE', {
      connectedClients: sseClients.size,
      clients: getConnectedClientsList(),
    });
    return true;
  };

  const scheduleDestructionTimer = (entry) => {
    if (!entry?.tournamentId || !entry.destruction?.destroyAt) return;
    const id = entry.tournamentId;
    clearDestructionTimer(id);
    const remainingMs = Number(entry.destruction.destroyAt) - Date.now();
    if (remainingMs <= 0) {
      executeTournamentDestruction(id);
      return;
    }
    const timer = setTimeout(() => {
      executeTournamentDestruction(id);
    }, remainingMs);
    if (typeof timer.unref === 'function') timer.unref();
    destructionTimers.set(id, timer);
  };

  // Re-arm any persisted destruction timers on server startup
  for (const entry of Object.values(store.tournaments)) {
    if (entry?.destruction?.destroyAt) {
      scheduleDestructionTimer(entry);
    }
  }

  const setCors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Range, X-Media-Name, X-Media-Type, X-Media-Kind, X-Sync-Sender'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Type, Content-Length, Content-Range, Accept-Ranges, X-Media-Name, X-Media-Type, X-Media-Kind, X-Media-Updated'
    );
    res.setHeader('Cache-Control', 'no-store');
  };

  const sendJson = (res, statusCode, data) => {
    setCors(res);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  };

  const lanSyncMiddleware = async function lanSyncMiddleware(req, res, next) {
    const rawUrl = req.url || '/';
    const urlObj = new URL(rawUrl, 'http://localhost');
    const pathname = urlObj.pathname;

    if (!pathname.startsWith('/__server-info') && !pathname.startsWith('/__sync')) {
      return next();
    }

    if (req.method === 'OPTIONS') {
      setCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    // 1. Live Host Server Info
    if (pathname === '/__server-info' && req.method === 'GET') {
      const info = collectLocalServerInfo(getPort(), appMeta);
      const clientMeta = await resolveClientDeviceName(req, info);
      const active = getActiveState();
      return sendJson(res, 200, {
        ...info,
        ...clientMeta,
        syncAvailable: true,
        connectedClients: sseClients.size,
        clients: getConnectedClientsList(),
        cloudTournamentCount: Object.keys(store.tournaments).length,
        activeTournamentId: store.activeTournamentId,
        activeTournamentName: active?.tournamentName || null,
        hosts: getHostsList(),
        hostDevice: store.hostDevice,
      });
    }

    // 1b. Lightweight healthcheck & Render Free keepalive ping
    if (pathname === '/__sync/ping' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, serverTime: Date.now() });
    }

    // 1c. Embedded Usage Analytics (batched client telemetry + dashboard read/clear)
    if (pathname === '/__sync/analytics') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          count: analyticsEvents.length,
          events: analyticsEvents,
        });
      }
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const incoming = Array.isArray(body?.events) ? body.events : [];
          for (const raw of incoming.slice(0, 100)) {
            if (!raw || typeof raw !== 'object') continue;
            analyticsEvents.push({
              ts: Number(raw.ts) || Date.now(),
              type: String(raw.type || 'action').slice(0, 24),
              name: String(raw.name || 'unknown').slice(0, 64),
              category: String(raw.category || 'ui').slice(0, 24),
              ...(typeof raw.durationMs === 'number' && raw.durationMs > 0
                ? { durationMs: Math.round(raw.durationMs) }
                : {}),
              view: String(raw.view || 'hub').slice(0, 24),
              role: String(raw.role || 'spectator').slice(0, 24),
              demoMode: Boolean(raw.demoMode),
              entryMode: String(raw.entryMode || 'none').slice(0, 16),
              format: String(raw.format || 'none').slice(0, 16),
              playerCount: Number(raw.playerCount) || 0,
              deviceType: raw.deviceType === 'mobile' ? 'mobile' : 'desktop',
              browser: String(raw.browser || 'Browser').slice(0, 32),
              standalone: Boolean(raw.standalone),
              deviceId: String(raw.deviceId || '').slice(0, 40),
            });
          }
          if (analyticsEvents.length > MAX_ANALYTICS_EVENTS) {
            analyticsEvents = analyticsEvents.slice(-MAX_ANALYTICS_EVENTS);
          }
          scheduleAnalyticsSave();
          return sendJson(res, 200, { ok: true, count: analyticsEvents.length });
        } catch {
          return sendJson(res, 400, { error: 'Invalid analytics payload' });
        }
      }
      if (req.method === 'DELETE') {
        analyticsEvents = [];
        scheduleAnalyticsSave();
        return sendJson(res, 200, { ok: true, count: 0 });
      }
    }

    // 1d. 2-Way Messaging (1-to-1 DM, 1-to-Many / Group Chats, & Public Live Game Chat)
    const getOrCreateTournamentChat = (tid) => {
      if (!store.chatByTournament || typeof store.chatByTournament !== 'object') {
        store.chatByTournament = {};
      }
      if (!store.chatByTournament[tid] || typeof store.chatByTournament[tid] !== 'object') {
        store.chatByTournament[tid] = { liveMessages: [], threads: {} };
      }
      const bucket = store.chatByTournament[tid];
      if (!Array.isArray(bucket.liveMessages)) bucket.liveMessages = [];
      if (!bucket.threads || typeof bucket.threads !== 'object') bucket.threads = {};
      return bucket;
    };

    const resolveChatDisplayName = (entry, devId, fallbackName = '') => {
      if (entry && devId && entry.playerClaims?.[devId]) {
        const pid = entry.playerClaims[devId];
        const player = Array.isArray(entry.players) ? entry.players.find((p) => p.id === pid) : null;
        if (player?.name) return player.name;
      }
      const cleanFallback = String(fallbackName || '').trim();
      if (cleanFallback && cleanFallback !== 'Device' && cleanFallback !== 'Connected Device') {
        return cleanFallback;
      }
      for (const meta of sseClients.values()) {
        if (meta.deviceId === devId) {
          if (meta.deviceName && meta.deviceName !== 'Device' && meta.deviceName !== 'Connected Device') {
            return meta.deviceName;
          }
          if (meta.clientInfo?.deviceBrowser) return meta.clientInfo.deviceBrowser;
        }
      }
      return 'Player';
    };

    const getVisibleThreadsForDevice = (bucket, devId) =>
      Object.values(bucket.threads || {})
        .filter((th) => th && Array.isArray(th.memberDeviceIds) && th.memberDeviceIds.includes(devId))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const postSystemLiveChat = (
      tid,
      { kind = 'event', fromName = 'Tournament', text = '', liveTemplate = null, countdownTargetAt = null }
    ) => {
      const cleanText = String(text || '').trim().slice(0, 500);
      if (!tid || !cleanText) return null;
      const bucket = getOrCreateTournamentChat(tid);
      const msg = {
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tournamentId: tid,
        kind,
        fromDeviceId: 'system',
        fromName: String(fromName || 'Tournament').slice(0, 60),
        fromRole: 'system',
        text: cleanText,
        ...(liveTemplate ? { liveTemplate } : {}),
        ...(countdownTargetAt ? { countdownTargetAt } : {}),
        sentAt: Date.now(),
      };
      bucket.liveMessages.push(msg);
      if (bucket.liveMessages.length > 250) {
        bucket.liveMessages = bucket.liveMessages.slice(-250);
      }
      scheduleDiskSave();
      for (const [clientRes, meta] of sseClients.entries()) {
        if (meta.tournamentId && meta.tournamentId !== tid) continue;
        try {
          clientRes.write(`event: CHAT_LIVE\ndata: ${JSON.stringify({ tournamentId: tid, message: msg })}\n\n`);
        } catch {
          sseClients.delete(clientRes);
        }
      }
      return msg;
    };

    if (pathname === '/__sync/chat' && req.method === 'GET') {
      const tid = String(urlObj.searchParams.get('tournamentId') || store.activeTournamentId || '').trim();
      const devId = String(urlObj.searchParams.get('deviceId') || '').trim();
      if (!tid) return sendJson(res, 200, { ok: true, liveMessages: [], threads: [] });
      const bucket = getOrCreateTournamentChat(tid);
      return sendJson(res, 200, {
        ok: true,
        tournamentId: tid,
        liveMessages: bucket.liveMessages.slice(-200),
        threads: devId ? getVisibleThreadsForDevice(bucket, devId) : [],
      });
    }

    if (pathname === '/__sync/chat/live' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const tid = String(body?.tournamentId || store.activeTournamentId || '').trim();
        const devId = String(body?.deviceId || '').trim();
        const text = String(body?.text || '').trim().slice(0, 500);
        if (!tid || !devId || !text) {
          return sendJson(res, 400, { error: 'tournamentId, deviceId, and message text are required' });
        }
        const entry = store.tournaments[tid] || null;
        const adminIds = getAdminDeviceIds();
        const senderRole = entry
          ? resolveEffectiveRole(entry, devId, body?.tabId || '', { adminDeviceIds: adminIds })
          : isDeviceAdmin(devId)
            ? 'admin'
            : 'spectator';
        const fromName = resolveChatDisplayName(entry, devId, body?.deviceName);
        const bucket = getOrCreateTournamentChat(tid);
        const msg = {
          id: `live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          tournamentId: tid,
          fromDeviceId: devId,
          fromName,
          fromRole: senderRole,
          text,
          sentAt: Date.now(),
        };
        bucket.liveMessages.push(msg);
        if (bucket.liveMessages.length > 250) {
          bucket.liveMessages = bucket.liveMessages.slice(-250);
        }
        scheduleDiskSave();
        for (const [clientRes, meta] of sseClients.entries()) {
          if (meta.tournamentId && meta.tournamentId !== tid) continue;
          try {
            clientRes.write(`event: CHAT_LIVE\ndata: ${JSON.stringify({ tournamentId: tid, message: msg })}\n\n`);
          } catch {
            sseClients.delete(clientRes);
          }
        }
        return sendJson(res, 200, { ok: true, message: msg });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    if (pathname === '/__sync/chat/live/delete' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const tid = String(body?.tournamentId || store.activeTournamentId || '').trim();
        const actorDeviceId = String(body?.deviceId || '').trim();
        const messageId = String(body?.messageId || '').trim();
        if (!tid || !messageId) return sendJson(res, 400, { error: 'tournamentId and messageId required' });
        const entry = store.tournaments[tid] || null;
        const adminIds = getAdminDeviceIds();
        const actorRole = entry
          ? resolveEffectiveRole(entry, actorDeviceId, body?.tabId || '', { adminDeviceIds: adminIds })
          : isDeviceAdmin(actorDeviceId)
            ? 'admin'
            : 'spectator';
        const bucket = getOrCreateTournamentChat(tid);
        const existing = bucket.liveMessages.find((m) => m.id === messageId);
        const isOwn = Boolean(existing && existing.fromDeviceId === actorDeviceId);
        if (!isOwn && (ROLE_LEVEL[actorRole] ?? 0) < ROLE_LEVEL.moderator) {
          return sendJson(res, 403, { error: 'Only Moderators, Hosts, Admins, or the author can delete messages' });
        }
        bucket.liveMessages = bucket.liveMessages.filter((m) => m.id !== messageId);
        scheduleDiskSave();
        for (const [clientRes, meta] of sseClients.entries()) {
          if (meta.tournamentId && meta.tournamentId !== tid) continue;
          try {
            clientRes.write(
              `event: CHAT_LIVE_DELETE\ndata: ${JSON.stringify({ tournamentId: tid, messageId })}\n\n`
            );
          } catch {
            sseClients.delete(clientRes);
          }
        }
        return sendJson(res, 200, { ok: true, messageId });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    if (pathname === '/__sync/chat/thread' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const tid = String(body?.tournamentId || store.activeTournamentId || '').trim();
        const creatorDeviceId = String(body?.deviceId || '').trim();
        const rawTargets = Array.isArray(body?.targetDeviceIds) ? body.targetDeviceIds : [];
        const targets = Array.from(
          new Set(rawTargets.map((id) => String(id || '').trim()).filter((id) => id && id !== creatorDeviceId))
        );
        if (!tid || !creatorDeviceId || targets.length === 0) {
          return sendJson(res, 400, { error: 'Select at least one recipient' });
        }
        const entry = store.tournaments[tid] || null;
        const bucket = getOrCreateTournamentChat(tid);
        const groupName = String(body?.groupName || '').trim().slice(0, 60);
        const isGroup = targets.length > 1 || Boolean(groupName);
        const memberDeviceIds = Array.from(new Set([creatorDeviceId, ...targets])).sort();
        const threadId = isGroup
          ? `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
          : `dm-${memberDeviceIds.join('__')}`;

        let thread = bucket.threads[threadId];
        const memberNames = { ...(thread?.memberNames || {}) };
        for (const mId of memberDeviceIds) {
          memberNames[mId] = resolveChatDisplayName(
            entry,
            mId,
            mId === creatorDeviceId ? body?.deviceName : ''
          );
        }

        if (!thread) {
          thread = {
            id: threadId,
            tournamentId: tid,
            kind: isGroup ? 'group' : 'dm',
            name: isGroup ? groupName || memberDeviceIds.map((id) => memberNames[id]).join(', ').slice(0, 50) : '',
            memberDeviceIds,
            memberNames,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
          };
          bucket.threads[threadId] = thread;
        } else {
          thread.memberNames = memberNames;
        }

        const initialText = String(body?.initialMessage || '').trim().slice(0, 500);
        let initialMsg = null;
        if (initialText) {
          const adminIds = getAdminDeviceIds();
          const senderRole = entry
            ? resolveEffectiveRole(entry, creatorDeviceId, body?.tabId || '', { adminDeviceIds: adminIds })
            : isDeviceAdmin(creatorDeviceId)
              ? 'admin'
              : 'spectator';
          initialMsg = {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            threadId,
            fromDeviceId: creatorDeviceId,
            fromName: memberNames[creatorDeviceId] || 'Player',
            fromRole: senderRole,
            text: initialText,
            sentAt: Date.now(),
          };
          thread.messages.push(initialMsg);
          if (thread.messages.length > 120) thread.messages = thread.messages.slice(-120);
          thread.updatedAt = initialMsg.sentAt;
        }

        scheduleDiskSave();
        const memberSet = new Set(thread.memberDeviceIds);
        for (const [clientRes, meta] of sseClients.entries()) {
          if (!memberSet.has(meta.deviceId)) continue;
          try {
            clientRes.write(
              `event: CHAT_THREAD_UPDATE\ndata: ${JSON.stringify({
                tournamentId: tid,
                thread,
                newMessage: initialMsg,
              })}\n\n`
            );
          } catch {
            sseClients.delete(clientRes);
          }
        }
        if (initialMsg) {
          const pushTargets = thread.memberDeviceIds.filter((id) => id !== creatorDeviceId);
          sendWebPushToDevices(pushTargets, {
            id: initialMsg.id,
            tag: `pp-chat-${threadId}`,
            title:
              thread.kind === 'group'
                ? `💬 ${thread.name} · ${initialMsg.fromName}`
                : `💬 ${initialMsg.fromName}`,
            body: initialMsg.text,
            url: '/',
          }).catch(() => {});
        }
        return sendJson(res, 200, { ok: true, thread, message: initialMsg });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    if (pathname === '/__sync/chat/send' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const tid = String(body?.tournamentId || store.activeTournamentId || '').trim();
        const threadId = String(body?.threadId || '').trim();
        const devId = String(body?.deviceId || '').trim();
        const text = String(body?.text || '').trim().slice(0, 500);
        if (!tid || !threadId || !devId || !text) {
          return sendJson(res, 400, { error: 'tournamentId, threadId, deviceId, and text are required' });
        }
        const entry = store.tournaments[tid] || null;
        const bucket = getOrCreateTournamentChat(tid);
        const thread = bucket.threads[threadId];
        if (!thread || !Array.isArray(thread.memberDeviceIds) || !thread.memberDeviceIds.includes(devId)) {
          return sendJson(res, 403, { error: 'You are not a member of this chat thread' });
        }
        const adminIds = getAdminDeviceIds();
        const senderRole = entry
          ? resolveEffectiveRole(entry, devId, body?.tabId || '', { adminDeviceIds: adminIds })
          : isDeviceAdmin(devId)
            ? 'admin'
            : 'spectator';
        const fromName = resolveChatDisplayName(entry, devId, body?.deviceName);
        thread.memberNames = { ...(thread.memberNames || {}), [devId]: fromName };
        const msg = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          threadId,
          fromDeviceId: devId,
          fromName,
          fromRole: senderRole,
          text,
          sentAt: Date.now(),
        };
        thread.messages.push(msg);
        if (thread.messages.length > 120) thread.messages = thread.messages.slice(-120);
        thread.updatedAt = msg.sentAt;
        scheduleDiskSave();

        const memberSet = new Set(thread.memberDeviceIds);
        for (const [clientRes, meta] of sseClients.entries()) {
          if (!memberSet.has(meta.deviceId)) continue;
          try {
            clientRes.write(
              `event: CHAT_MESSAGE\ndata: ${JSON.stringify({
                tournamentId: tid,
                threadId,
                thread,
                message: msg,
              })}\n\n`
            );
          } catch {
            sseClients.delete(clientRes);
          }
        }
        const pushTargets = thread.memberDeviceIds.filter((id) => id !== devId);
        sendWebPushToDevices(pushTargets, {
          id: msg.id,
          tag: `pp-chat-${threadId}`,
          title:
            thread.kind === 'group'
              ? `💬 ${thread.name} · ${msg.fromName}`
              : `💬 ${msg.fromName}`,
          body: msg.text,
          url: '/',
        }).catch(() => {});
        return sendJson(res, 200, { ok: true, thread, message: msg });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 2. Real-Time Server-Sent Events Stream (tracks live connected clients!)
    if (pathname === '/__sync/events' && req.method === 'GET') {
      const serverInfo = collectLocalServerInfo(getPort(), appMeta);
      const clientIp = getDisplayIpForRequest(req, serverInfo);
      const tabId = urlObj.searchParams.get('tabId') || `id-${Math.random().toString(36).slice(2, 6)}`;
      const deviceId = urlObj.searchParams.get('deviceId') || tabId;
      const deviceName =
        String(urlObj.searchParams.get('deviceName') || '').trim() ||
        (clientIp === serverInfo.lanAddresses?.[0]?.address ? serverInfo.hostname : '') ||
        'Connected Device';
      const viewMode = urlObj.searchParams.get('viewMode') || 'control';
      const requestedTournamentId = urlObj.searchParams.get('tournamentId') || null;
      const providedCode = urlObj.searchParams.get('code') || '';
      const requestedEntry = requestedTournamentId ? store.tournaments[requestedTournamentId] : null;
      const authorizedForRequested =
        !requestedEntry ||
        isDeviceAuthorizedForTournament(requestedEntry, deviceId, providedCode);
      const tournamentId = authorizedForRequested ? requestedTournamentId : null;

      setCors(res);
      req.socket?.setNoDelay?.(true);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      res.flushHeaders?.();

      sseClients.set(res, {
        tabId,
        deviceId,
        deviceName,
        ip: clientIp,
        viewMode,
        tournamentId,
        connectedAt: Date.now(),
        clientInfo: {
          userAgent: String(req.headers['user-agent'] || '').slice(0, 320),
        },
      });

      const clientsList = getConnectedClientsList();
      const { totalCloudTournaments } = getLibraryStats();
      res.write(
        `event: CONNECTED\ndata: ${JSON.stringify({
          serverTime: Date.now(),
          serverBootId,
          totalCloudTournaments,
          tournamentIds: Object.keys(store.tournaments || {}),
          clients: sseClients.size,
          connectedClientsList: clientsList,
        })}\n\n`
      );
      if (requestedEntry && !authorizedForRequested) {
        res.write(
          `event: ACCESS_REVOKED\ndata: ${JSON.stringify({
            tournamentId: requestedTournamentId,
            reason: 'Access revoked — enter the current 4-word Tournament ID to rejoin',
            at: Date.now(),
          })}\n\n`
        );
      }
      broadcastSSE('CLIENTS_UPDATE', {
        connectedClients: sseClients.size,
        clients: clientsList,
      });

      req.on('close', () => {
        sseClients.delete(res);
        broadcastSSE('CLIENTS_UPDATE', {
          connectedClients: sseClients.size,
          clients: getConnectedClientsList(),
        });
      });
      return;
    }

    // 2b. Live Client Presence Status Update (viewMode, deviceName, active tournament)
    if (pathname === '/__sync/client-status' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const tabId = body?.tabId || '';
        const deviceId = body?.deviceId || '';
        let updatedAny = false;
        for (const meta of sseClients.values()) {
          if ((tabId && meta.tabId === tabId) || (!tabId && deviceId && meta.deviceId === deviceId)) {
            if (body.deviceName) meta.deviceName = String(body.deviceName).trim();
            if (body.viewMode) meta.viewMode = String(body.viewMode).trim();
            if (body.clientInfo && typeof body.clientInfo === 'object') {
              const incomingInfo = {};
              for (const [k, v] of Object.entries(body.clientInfo)) {
                if (v === undefined) continue;
                incomingInfo[k] = typeof v === 'string' ? v.slice(0, 320) : v;
              }
              meta.clientInfo = { ...(meta.clientInfo || {}), ...incomingInfo };
            }
            if (body.tournamentId !== undefined) {
              const reqTid = body.tournamentId || null;
              const reqEntry = reqTid ? store.tournaments[reqTid] : null;
              meta.tournamentId =
                !reqEntry || isDeviceAuthorizedForTournament(reqEntry, meta.deviceId, body.code || '')
                  ? reqTid
                  : null;
            }
            updatedAny = true;
          }
        }
        const clientsList = getConnectedClientsList();
        if (updatedAny) {
          broadcastSSE('CLIENTS_UPDATE', {
            connectedClients: sseClients.size,
            clients: clientsList,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          connectedClients: sseClients.size,
          clients: clientsList,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 2c. Host / Admin / Moderator Disconnects Lower-Ranked Connected Client(s) Immediately
    if (pathname === '/__sync/clients/disconnect' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const reqDeviceId = body?.deviceId || '';
        const tournamentId = body?.tournamentId || store.activeTournamentId || null;
        const entry = tournamentId ? store.tournaments[tournamentId] : null;
        const adminIds = getAdminDeviceIds();
        const actorRole = entry
          ? resolveEffectiveRole(entry, reqDeviceId, '', { adminDeviceIds: adminIds })
          : isDeviceAdmin(reqDeviceId)
            ? 'admin'
            : 'host';
        const isAnyRegisteredHost = Boolean(reqDeviceId && store.hosts[reqDeviceId]);
        const effectiveActorRole =
          actorRole === 'spectator' && isAnyRegisteredHost && !entry ? 'host' : actorRole;

        if ((ROLE_LEVEL[effectiveActorRole] ?? 0) < ROLE_LEVEL.moderator) {
          return sendJson(res, 403, { error: 'Only an admin, host, or moderator can kick clients' });
        }

        const targetTabId = body?.targetTabId || '';
        const targetDeviceId = body?.targetDeviceId || '';
        if (!targetTabId && !targetDeviceId) {
          return sendJson(res, 400, { error: 'targetTabId or targetDeviceId is required' });
        }

        const reason = String(body?.reason || 'Kicked by host').trim();
        let disconnectedCount = 0;
        const revokedDeviceIds = new Set();
        const revokedTournamentIds = new Set();
        if (targetDeviceId) revokedDeviceIds.add(targetDeviceId);
        if (tournamentId) revokedTournamentIds.add(tournamentId);

        for (const [clientRes, meta] of Array.from(sseClients.entries())) {
          const matches =
            (targetTabId && meta.tabId === targetTabId) ||
            (!targetTabId && targetDeviceId && meta.deviceId === targetDeviceId);
          if (!matches) continue;
          const targetEntry = meta.tournamentId ? store.tournaments[meta.tournamentId] : entry;
          const targetRole = targetEntry
            ? resolveEffectiveRole(targetEntry, meta.deviceId, meta.tabId, { adminDeviceIds: adminIds })
            : isDeviceAdmin(meta.deviceId)
              ? 'admin'
              : 'spectator';
          if ((entry?.hostDeviceId || targetRole === 'admin') && !canDisconnectRole(effectiveActorRole, targetRole)) {
            return sendJson(res, 403, {
              error: `Your role (${effectiveActorRole}) cannot kick a ${targetRole}`,
            });
          }
          disconnectedCount += 1;
          if (meta.deviceId) revokedDeviceIds.add(meta.deviceId);
          if (meta.tournamentId) revokedTournamentIds.add(meta.tournamentId);
          try {
            clientRes.end(
              `event: CLIENT_KICKED\ndata: ${JSON.stringify({
                tabId: meta.tabId,
                deviceId: meta.deviceId,
                tournamentId: meta.tournamentId || tournamentId || null,
                reason,
                at: Date.now(),
              })}\n\n`
            );
          } catch {
            // Ignore write/end errors on already-closed socket
          }
          sseClients.delete(clientRes);
        }

        // Revoke guest authorization for kicked device(s) across their tournament(s) so refreshing CANNOT rejoin,
        // and record them in `kickedDevices` so future requests clearly show the "Previously Kicked" pill!
        for (const revokedDevId of revokedDeviceIds) {
          if (revokedTournamentIds.size > 0) {
            for (const tid of revokedTournamentIds) {
              revokeGuest(revokedDevId, tid);
              const tEntry = store.tournaments[tid];
              if (tEntry) {
                const kickedSet = new Set(Array.isArray(tEntry.kickedDevices) ? tEntry.kickedDevices : []);
                kickedSet.add(revokedDevId);
                tEntry.kickedDevices = Array.from(kickedSet);
              }
            }
          } else {
            revokeGuest(revokedDevId, null);
          }
        }
        scheduleDiskSave();

        const clientsList = getConnectedClientsList();
        broadcastSSE('CLIENTS_UPDATE', {
          connectedClients: sseClients.size,
          clients: clientsList,
        });

        return sendJson(res, 200, {
          ok: true,
          disconnectedCount,
          connectedClients: sseClients.size,
          clients: clientsList,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 5c. Send a direct notification message to a connected user/device (Moderator & above)
    if (pathname === '/__sync/notify-client' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const reqDeviceId = body?.deviceId || '';
        const tournamentId = body?.tournamentId || '';
        const entry = tournamentId ? store.tournaments[tournamentId] : null;
        const adminIds = getAdminDeviceIds();
        const actorRole = entry
          ? resolveEffectiveRole(entry, reqDeviceId, body?.tabId || null, { adminDeviceIds: adminIds })
          : isDeviceAdmin(reqDeviceId)
            ? 'admin'
            : 'spectator';
        const isAnyRegisteredHost = Boolean(reqDeviceId && store.hosts[reqDeviceId]);
        const effectiveActorRole =
          actorRole === 'spectator' && isAnyRegisteredHost && !entry ? 'host' : actorRole;

        if ((ROLE_LEVEL[effectiveActorRole] ?? 0) < ROLE_LEVEL.moderator) {
          return sendJson(res, 403, { error: 'Only an admin, host, or moderator can message users' });
        }

        const targetTabId = body?.targetTabId || '';
        const targetDeviceId = body?.targetDeviceId || '';
        const isBroadcast = Boolean(body?.broadcast);
        const isClearBanner = Boolean(body?.clearBanner);
        const requestedSticky = Boolean(body?.sticky);

        if (isClearBanner) {
          if (entry) {
            entry.presentation = { ...(entry.presentation || {}), activeBanner: null };
            entry.updatedAt = Date.now();
            scheduleDiskSave();
            broadcastStateSyncSSE({
              sender: null,
              state: entry,
              activeTournamentId: store.activeTournamentId,
              hosts: getHostsList(),
            });
          }
          for (const [clientRes, meta] of Array.from(sseClients.entries())) {
            if (tournamentId && meta.tournamentId && meta.tournamentId !== tournamentId) continue;
            try {
              clientRes.write(`event: PRESENTER_BANNER_CLEAR\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
            } catch {
              // Ignore closed socket
            }
          }
          return sendJson(res, 200, { ok: true, cleared: true });
        }

        const requestedKind = body?.kind === 'announcement' || isBroadcast ? 'announcement' : 'alert';
        const rawMessage = String(body?.message || '').trim().slice(0, 300);
        if (!isBroadcast && !targetTabId && !targetDeviceId) {
          return sendJson(res, 400, { error: 'targetTabId, targetDeviceId, or broadcast is required' });
        }
        if (!rawMessage) {
          return sendJson(res, 400, { error: 'Message text is required' });
        }

        const resolved = resolveMessageTemplate(rawMessage, entry || {});
        const message = resolved.text;
        const liveTemplate = resolved.liveTemplate || message;
        const countdownTargetAt = resolved.countdownTargetAt || null;
        const dismissOnCountdown = Boolean(body?.dismissOnCountdown);
        const dismissAt =
          Number(body?.dismissAt) > 0
            ? Number(body.dismissAt)
            : dismissOnCountdown && countdownTargetAt
              ? countdownTargetAt
              : null;
        const dismissalLabel = dismissAt && resolved.countdownLabel ? resolved.countdownLabel : null;
        const isSticky = requestedSticky || Boolean(dismissAt);

        const fromName = 'Host';
        const baseId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const basePayload = {
          id: baseId,
          kind: requestedKind,
          sticky: isSticky,
          dismissAt,
          dismissalLabel,
          countdownTargetAt,
          liveTemplate,
          autoDismissMs: isSticky ? 0 : requestedKind === 'announcement' ? 10000 : 0,
          title: String(
            body?.title ||
              (requestedKind === 'announcement'
                ? '📢 Announcement from Host'
                : '🔔 Alert from Host')
          )
            .trim()
            .slice(0, 80),
          message,
          fromName,
          fromRole: effectiveActorRole,
          sentAt: Date.now(),
        };

        let deliveredCount = 0;
        let hitPresenter = isBroadcast || requestedKind === 'announcement';
        const targetDeviceIds = new Set();
        if (targetDeviceId) targetDeviceIds.add(targetDeviceId);
        for (const [clientRes, meta] of Array.from(sseClients.entries())) {
          const matches = isBroadcast
            ? !tournamentId || !meta.tournamentId || meta.tournamentId === tournamentId
            : (targetTabId && meta.tabId === targetTabId) ||
              (!targetTabId && targetDeviceId && meta.deviceId === targetDeviceId);
          if (!matches) continue;
          if (meta.deviceId) targetDeviceIds.add(meta.deviceId);
          // All messages sent to a presenter role are treated as announcements (auto-dismiss in 10s unless sticky/dismissAt)
          const recipientRole = entry
            ? resolveEffectiveRole(entry, meta.deviceId, meta.tabId, { adminDeviceIds: adminIds })
            : 'spectator';
          const isPresenterClient = recipientRole === 'presenter' || meta.viewMode === 'present';
          if (isPresenterClient) hitPresenter = true;
          const treatAsAnnouncement = requestedKind === 'announcement' || isPresenterClient;
          const clientPayload = treatAsAnnouncement
            ? {
                ...basePayload,
                kind: 'announcement',
                autoDismissMs: isSticky ? 0 : 10000,
                title:
                  requestedKind === 'announcement'
                    ? basePayload.title
                    : `📢 Announcement from ${fromName}`,
              }
            : basePayload;
          try {
            clientRes.write(`event: USER_MESSAGE\ndata: ${JSON.stringify(clientPayload)}\n\n`);
            deliveredCount += 1;
          } catch {
            // Ignore closed socket
          }
        }

        // Persist sticky / scheduled banner on the tournament state so Presenter views stay synced (even on refresh)
        if (entry && isSticky) {
          entry.presentation = {
            ...(entry.presentation || {}),
            activeBanner: {
              ...basePayload,
              kind: 'announcement',
              sticky: true,
              autoDismissMs: 0,
            },
          };
          entry.updatedAt = Date.now();
          scheduleDiskSave();
          broadcastStateSyncSSE({
            sender: null,
            state: entry,
            activeTournamentId: store.activeTournamentId,
            hosts: getHostsList(),
          });
        }

        // Mirror public announcements/broadcasts into the tournament Live Chat stream
        if (tournamentId && (isBroadcast || requestedKind === 'announcement')) {
          postSystemLiveChat(tournamentId, {
            kind: 'announcement',
            fromName: '📢 Announcement from Host',
            text: message,
            liveTemplate,
            countdownTargetAt,
          });
        }

        // Also deliver via Web Push (wakes locked/screen-off mobile devices & closed tabs)
        if (isBroadcast && store.pushSubscriptions) {
          for (const devId of Object.keys(store.pushSubscriptions)) {
            targetDeviceIds.add(devId);
          }
        }
        const pushDeliveredCount = await sendWebPushToDevices(Array.from(targetDeviceIds), {
          id: basePayload.id,
          tag: basePayload.id,
          title: basePayload.title,
          body: basePayload.message,
          url: '/',
        });

        return sendJson(res, 200, {
          ok: true,
          deliveredCount: deliveredCount + pushDeliveredCount,
          sseDeliveredCount: deliveredCount,
          pushDeliveredCount,
          message: basePayload,
          activeBanner: entry?.presentation?.activeBanner ?? null,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 5d. Web Push (VAPID) public key & subscription management
    if (pathname === '/__sync/push/vapid-key' && req.method === 'GET') {
      const keys = ensureVapidKeys();
      if (!keys?.publicKey) {
        return sendJson(res, 500, { ok: false, error: 'Web Push VAPID keys unavailable' });
      }
      return sendJson(res, 200, { ok: true, publicKey: keys.publicKey });
    }

    if (pathname === '/__sync/push/subscribe' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const devId = String(body?.deviceId || '').trim();
        const sub = body?.subscription;
        if (!devId || !sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          return sendJson(res, 400, { error: 'deviceId and valid PushSubscription are required' });
        }
        if (!store.pushSubscriptions || typeof store.pushSubscriptions !== 'object') {
          store.pushSubscriptions = {};
        }
        const existing = Array.isArray(store.pushSubscriptions[devId])
          ? store.pushSubscriptions[devId]
          : [];
        const filtered = existing.filter((s) => s?.endpoint !== sub.endpoint);
        filtered.push({
          endpoint: sub.endpoint,
          expirationTime: sub.expirationTime ?? null,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        });
        store.pushSubscriptions[devId] = filtered.slice(-5);
        scheduleDiskSave();
        return sendJson(res, 200, { ok: true, subscriptionCount: store.pushSubscriptions[devId].length });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    if (pathname === '/__sync/push/unsubscribe' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const devId = String(body?.deviceId || '').trim();
        const endpoint = String(body?.endpoint || '').trim();
        if (devId && Array.isArray(store.pushSubscriptions?.[devId])) {
          store.pushSubscriptions[devId] = endpoint
            ? store.pushSubscriptions[devId].filter((s) => s?.endpoint !== endpoint)
            : [];
          if (store.pushSubscriptions[devId].length === 0) {
            delete store.pushSubscriptions[devId];
          }
          scheduleDiskSave();
        }
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 5e. Player Claiming (users can claim once; Moderators & above can modify or release any claim)
    if (pathname === '/__sync/player-claim' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const reqDeviceId = String(body?.deviceId || '').trim();
        const tournamentId = String(body?.tournamentId || store.activeTournamentId || '').trim();
        const entry = tournamentId ? store.tournaments[tournamentId] : null;
        if (!entry) {
          return sendJson(res, 404, { error: 'Tournament not found' });
        }
        if (!reqDeviceId) {
          return sendJson(res, 400, { error: 'deviceId is required' });
        }

        const adminIds = getAdminDeviceIds();
        const actorRole = resolveEffectiveRole(entry, reqDeviceId, body?.tabId || null, {
          adminDeviceIds: adminIds,
        });
        const isAnyRegisteredHost = Boolean(store.hosts[reqDeviceId]);
        const effectiveActorRole =
          actorRole === 'spectator' && isAnyRegisteredHost && !entry.hostDeviceId ? 'host' : actorRole;
        const isModOrAbove = (ROLE_LEVEL[effectiveActorRole] ?? 0) >= ROLE_LEVEL.moderator;

        const targetDev = String(body?.targetDeviceId || reqDeviceId).trim();
        const rawPlayerId = body?.playerId ? String(body.playerId).trim() : null;
        const claims =
          entry.playerClaims && typeof entry.playerClaims === 'object'
            ? { ...entry.playerClaims }
            : {};
        const existingClaim = claims[targetDev] || null;
        const isTargetingOther = targetDev !== reqDeviceId;
        const isModifyingOrReleasing = Boolean(existingClaim);

        if ((isTargetingOther || isModifyingOrReleasing) && !isModOrAbove) {
          return sendJson(res, 403, {
            error: 'Once claimed, only a Moderator or Host can change or release a player claim.',
          });
        }

        if (!rawPlayerId) {
          delete claims[targetDev];
        } else {
          const validPlayer = (entry.players || []).some((p) => p.id === rawPlayerId);
          if (!validPlayer) {
            return sendJson(res, 404, { error: 'Selected player not found in this tournament' });
          }
          const otherHolder = Object.entries(claims).find(
            ([dev, pid]) => dev !== targetDev && pid === rawPlayerId
          );
          if (otherHolder) {
            if (!isModOrAbove) {
              return sendJson(res, 409, { error: 'That player has already been claimed by another user.' });
            }
            delete claims[otherHolder[0]];
          }
          claims[targetDev] = rawPlayerId;
        }

        entry.playerClaims = claims;
        entry.updatedAt = Date.now();
        scheduleDiskSave();

        broadcastStateSyncSSE({
          sender: body?.tabId || null,
          state: entry,
          activeTournamentId: store.activeTournamentId,
          hosts: getHostsList(),
        });
        return sendJson(res, 200, { ok: true, playerClaims: claims });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 3. Get Current Active Cloud State + Library Summary (enforces guest authorization!)
    if (pathname === '/__sync/state' && req.method === 'GET') {
      const viewerDeviceId = urlObj.searchParams.get('deviceId') || '';
      const requestedTournamentId = urlObj.searchParams.get('tournamentId') || '';
      const providedCode = urlObj.searchParams.get('code') || '';
      const targetEntry = requestedTournamentId
        ? store.tournaments[requestedTournamentId] || null
        : getActiveState();
      const hasExplicitAuthContext = Boolean(viewerDeviceId || requestedTournamentId);
      const isAuthorized =
        !targetEntry ||
        !hasExplicitAuthContext ||
        isDeviceAuthorizedForTournament(targetEntry, viewerDeviceId, providedCode);
      const accessRevoked = Boolean(requestedTournamentId && targetEntry && !isAuthorized);
      const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
      return sendJson(res, 200, {
        activeTournamentId: store.activeTournamentId,
        state: isAuthorized ? targetEntry : null,
        accessRevoked,
        revokedTournamentId: accessRevoked ? requestedTournamentId : null,
        tournaments: getLibrarySummaries(viewerDeviceId),
        totalCloudTournaments,
        privateCloudCount,
        lastPointAt: store.lastPointAt,
        hosts: getHostsList(),
        hostDevice: store.hostDevice,
        ...getAdminPayloadFor(viewerDeviceId),
        hasMedia: Boolean(activeMedia),
        connectedClients: sseClients.size,
        clients: getConnectedClientsList(),
        serverTime: Date.now(),
        serverBootId,
      });
    }

    // 4. Push Updated Tournament State (and save to Cloud Library)
    if (pathname === '/__sync/state' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const incoming = body?.state;
        if (!incoming || typeof incoming !== 'object' || !incoming.matches || !incoming.players) {
          return sendJson(res, 400, { error: 'Invalid tournament state payload' });
        }
        const serverInfo = collectLocalServerInfo(getPort(), appMeta);
        const reqIp = getDisplayIpForRequest(req, serverInfo);
        const reqDeviceId = body.deviceId || incoming.hostDeviceId || null;
        const reqDeviceName = body.deviceName || incoming.hostDeviceName || serverInfo.hostname;
        const existingKey = store.tournaments[incoming.tournamentId]
          ? incoming.tournamentId
          : findTournamentKeyByCodeOrId(resolveTournamentJoinCode(incoming));
        const existingEntry = existingKey ? store.tournaments[existingKey] : null;
        const existedBefore = Boolean(existingEntry);

        // Enforce Hub-wide creation policy when a non-Admin tries to create a brand-new Cloud tournament
        if (
          !existedBefore &&
          store.hubSettings?.allowPublicCreation === false &&
          !isDeviceAdmin(reqDeviceId)
        ) {
          return sendJson(res, 403, {
            error: 'Only Hub Admins can create new live tournaments right now',
            adminCreationOnly: true,
          });
        }

        // Reject state writes from revoked/unauthorized devices on a hosted Secure tournament!
        if (
          existingEntry &&
          existingEntry.hostDeviceId &&
          reqDeviceId &&
          !isDeviceAuthorizedForTournament(existingEntry, reqDeviceId, body.joinCode || '')
        ) {
          return sendJson(res, 403, {
            error: 'Not authorized to update this tournament — rejoin with the current 4-word key',
            accessRevoked: true,
          });
        }

        const stamped = upsertTournament(incoming, {
          deviceId: reqDeviceId,
          deviceName: reqDeviceName,
          ip: reqIp,
        });
        // Automatically register the publishing device as an active host when creating/publishing a hosted tournament
        if (!existedBefore && stamped.hostDeviceId && reqDeviceId) {
          registerHostDevice({
            deviceId: reqDeviceId,
            deviceName: reqDeviceName,
            ip: reqIp,
          });
        }
        const id = stamped.tournamentId;
        if (body.activate !== false) {
          store.activeTournamentId = id;
        }
        if (Number(stamped.lastPointAt) > store.lastPointAt) {
          store.lastPointAt = Number(stamped.lastPointAt);
        }
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        const publicSummaries = getLibrarySummaries(null);

        if (body.activate !== false) {
          broadcastStateSyncSSE({
            sender: body.sender || null,
            state: stamped,
            activeTournamentId: store.activeTournamentId,
            tournaments: publicSummaries,
            totalCloudTournaments,
            privateCloudCount,
            hosts: getHostsList(),
          });
        }

        // System Auto-Announcements: notify claimed players when they move On Deck, when their match starts,
        // and re-notify claimed players + all presenters when the current match is nearing the end.
        if (existingEntry) {
          try {
            const claims =
              stamped.playerClaims && typeof stamped.playerClaims === 'object'
                ? stamped.playerClaims
                : {};
            const prevUpIds = new Set(
              computeTournamentStats(existingEntry).upNext.slice(0, 2).map((m) => m.id)
            );
            const nextUp = computeTournamentStats(stamped).upNext.slice(0, 2);
            const nameOf = (pid, fallback = 'TBD') =>
              (stamped.players || []).find((p) => p.id === pid)?.name || fallback;

            const sendSystemAnnouncementToDevices = (devIds, title, message, tag) => {
              const uniqueDevs = Array.from(new Set((devIds || []).filter(Boolean)));
              if (uniqueDevs.length === 0) return;
              const payload = {
                id: `${tag}-${Date.now()}`,
                kind: 'alert',
                autoDismissMs: 10000,
                title,
                message,
                fromName: 'System',
                fromRole: 'system',
                sentAt: Date.now(),
              };
              const devSet = new Set(uniqueDevs);
              for (const [clientRes, meta] of Array.from(sseClients.entries())) {
                if (!devSet.has(meta.deviceId)) continue;
                try {
                  clientRes.write(`event: USER_MESSAGE\ndata: ${JSON.stringify(payload)}\n\n`);
                } catch {
                  // Ignore closed socket
                }
              }
              sendWebPushToDevices(uniqueDevs, {
                id: payload.id,
                tag,
                title: payload.title,
                body: payload.message,
                url: '/',
              }).catch(() => {});
            };

            const sendAnnouncementToPresenters = (title, message, tag) => {
              const adminIds = getAdminDeviceIds();
              const payload = {
                id: `${tag}-pres-${Date.now()}`,
                kind: 'announcement',
                autoDismissMs: 10000,
                title,
                message,
                fromName: 'System',
                fromRole: 'system',
                sentAt: Date.now(),
              };
              for (const [clientRes, meta] of Array.from(sseClients.entries())) {
                if (meta.tournamentId && meta.tournamentId !== id) continue;
                const role = resolveEffectiveRole(stamped, meta.deviceId, meta.tabId, {
                  adminDeviceIds: adminIds,
                });
                if (role !== 'presenter' && meta.viewMode !== 'present') continue;
                try {
                  clientRes.write(`event: USER_MESSAGE\ndata: ${JSON.stringify(payload)}\n\n`);
                } catch {
                  // Ignore closed socket
                }
              }
            };

            // 1. Newly On Deck -> notify claimed players
            for (const m of nextUp) {
              if (prevUpIds.has(m.id)) continue;
              const matchup = `${nameOf(m.player1Id, m.source1Label)} vs ${nameOf(m.player2Id, m.source2Label)}`;
              const devs = Object.entries(claims)
                .filter(([, pid]) => pid === m.player1Id || pid === m.player2Id)
                .map(([devId]) => devId);
              sendSystemAnnouncementToDevices(
                devs,
                '📢 You Are On Deck!',
                `${m.label}: ${matchup} — head to the table soon!`,
                `pp-ondeck-${m.id}`
              );
            }

            // 2. Match Just Started -> notify claimed players
            const justStartedIds = new Set();
            for (const [mid, nextM] of Object.entries(stamped.matches || {})) {
              const prevM = existingEntry.matches?.[mid];
              if (!nextM || nextM.isBye || nextM.completed || !nextM.started || prevM?.started) {
                continue;
              }
              justStartedIds.add(mid);
              const matchup = `${nameOf(nextM.player1Id)} vs ${nameOf(nextM.player2Id)}`;
              const tableStr = nextM.tableNumber ? ` on Table ${nextM.tableNumber}` : '';
              const devs = Object.entries(claims)
                .filter(([, pid]) => pid === nextM.player1Id || pid === nextM.player2Id)
                .map(([devId]) => devId);
              sendSystemAnnouncementToDevices(
                devs,
                '📢 Your Match Is Starting!',
                `${nextM.label}: ${matchup}${tableStr}`,
                `pp-start-${mid}`
              );
              postSystemLiveChat(id, {
                kind: 'event',
                fromName: '🏓 Match Started',
                text: `${nextM.roundLabel} (${nextM.label}): ${matchup}${tableStr}`,
              });
            }

            // 2b. Active Match Switched Before Completion (match order changed!) -> notify both bumped & newly-up players
            const prevActiveForSwitch = existingEntry.matches?.[existingEntry.activeMatchId];
            const nextActiveForSwitch = stamped.matches?.[stamped.activeMatchId];
            if (
              prevActiveForSwitch &&
              nextActiveForSwitch &&
              prevActiveForSwitch.id !== nextActiveForSwitch.id &&
              !prevActiveForSwitch.isBye &&
              !prevActiveForSwitch.completed &&
              !nextActiveForSwitch.isBye &&
              !nextActiveForSwitch.completed
            ) {
              const prevMatchup = `${nameOf(prevActiveForSwitch.player1Id, prevActiveForSwitch.source1Label)} vs ${nameOf(prevActiveForSwitch.player2Id, prevActiveForSwitch.source2Label)}`;
              const nextMatchup = `${nameOf(nextActiveForSwitch.player1Id, nextActiveForSwitch.source1Label)} vs ${nameOf(nextActiveForSwitch.player2Id, nextActiveForSwitch.source2Label)}`;
              const nextTableStr = nextActiveForSwitch.tableNumber
                ? ` on Table ${nextActiveForSwitch.tableNumber}`
                : '';

              // Notify players who were up on the previous uncompleted match
              const bumpedDevs = Object.entries(claims)
                .filter(
                  ([, pid]) =>
                    (pid === prevActiveForSwitch.player1Id || pid === prevActiveForSwitch.player2Id) &&
                    pid !== nextActiveForSwitch.player1Id &&
                    pid !== nextActiveForSwitch.player2Id
                )
                .map(([devId]) => devId);
              sendSystemAnnouncementToDevices(
                bumpedDevs,
                '🔔 Match Order Changed — Hold On',
                `${nextActiveForSwitch.label} (${nextMatchup}) is playing before your match (${prevActiveForSwitch.label}: ${prevMatchup}).`,
                `pp-bumped-${prevActiveForSwitch.id}-${nextActiveForSwitch.id}`
              );

              // Notify players who are now up instead (skip if Match Started already alerted them this tick)
              if (!justStartedIds.has(nextActiveForSwitch.id)) {
                const nowUpDevs = Object.entries(claims)
                  .filter(
                    ([, pid]) =>
                      pid === nextActiveForSwitch.player1Id || pid === nextActiveForSwitch.player2Id
                  )
                  .map(([devId]) => devId);
                sendSystemAnnouncementToDevices(
                  nowUpDevs,
                  '🏓 You Are Up Now!',
                  `${nextActiveForSwitch.label}: ${nextMatchup}${nextTableStr} is now up on the table!`,
                  `pp-nowup-${nextActiveForSwitch.id}`
                );
              }
            }

            // 3. Active Match Nearing End (in-progress score > 0) -> re-notify up-next players AND presenters
            const prevActive = existingEntry.matches?.[existingEntry.activeMatchId];
            const nextActive = stamped.matches?.[stamped.activeMatchId];
            const isNearingEndInPlay = (m, rules) =>
              Boolean(
                m &&
                  !m.isBye &&
                  !m.completed &&
                  ((Number(m.score1) || 0) > 0 || (Number(m.score2) || 0) > 0) &&
                  isMatchNearingEnd(m, rules)
              );
            const wasNear =
              prevActive &&
              nextActive &&
              prevActive.id === nextActive.id &&
              isNearingEndInPlay(prevActive, existingEntry.rules);
            const isNowNear = isNearingEndInPlay(nextActive, stamped.rules);
            if (!wasNear && isNowNear && nextUp.length > 0) {
              const up = nextUp[0];
              const matchup = `${nameOf(up.player1Id, up.source1Label)} vs ${nameOf(up.player2Id, up.source2Label)}`;
              const upDevs = Object.entries(claims)
                .filter(([, pid]) => pid === up.player1Id || pid === up.player2Id)
                .map(([devId]) => devId);
              sendSystemAnnouncementToDevices(
                upDevs,
                '📢 Heads Up — Almost Your Turn!',
                `${up.label}: ${matchup} — current match is nearing the end!`,
                `pp-nearend-${nextActive.id}-${up.id}`
              );
              sendAnnouncementToPresenters(
                '📢 On Deck — Match Nearing End',
                `Up Next (${up.label}): ${matchup}`,
                `pp-nearend-${nextActive.id}-${up.id}`
              );
            }

            // 4. Match Completed -> notify claimed winner & runner-up of result + advancement/elimination
            for (const [mid, nextM] of Object.entries(stamped.matches || {})) {
              const prevM = existingEntry.matches?.[mid];
              if (!nextM || nextM.isBye || !nextM.completed || prevM?.completed) continue;
              const winnerId = nextM.winnerId || null;
              const loserId =
                winnerId && nextM.player1Id && nextM.player2Id
                  ? winnerId === nextM.player1Id
                    ? nextM.player2Id
                    : nextM.player1Id
                  : null;
              const scoreline = `${nextM.score1}–${nextM.score2}`;
              const winnerName = nameOf(winnerId, 'Winner');
              const loserName = nameOf(loserId, 'Opponent');
              const isChampMatch = Boolean(winnerId && stamped.championId === winnerId);
              const isSkunkWin = Boolean(
                stamped.rules?.skunkEnabled &&
                  (Number(nextM.score1) === 0 || Number(nextM.score2) === 0) &&
                  Math.max(Number(nextM.score1) || 0, Number(nextM.score2) || 0) >=
                    (Number(stamped.rules?.skunkScore) || 7)
              );
              if (winnerId) {
                postSystemLiveChat(id, {
                  kind: isChampMatch ? 'champion' : 'win',
                  fromName: isChampMatch
                    ? '👑 Champion Crowned!'
                    : isSkunkWin
                      ? '🦨 SKUNK WIN!'
                      : '🏆 Match Result',
                  text: isChampMatch
                    ? `${winnerName} defeated ${loserName} (${scoreline}) to win ${
                        stamped.tournamentName || 'the tournament'
                      }!`
                    : `${winnerName} defeated ${loserName} (${scoreline}) in ${nextM.roundLabel}`,
                });
              }

              if (winnerId) {
                const winDevs = Object.entries(claims)
                  .filter(([, pid]) => pid === winnerId)
                  .map(([devId]) => devId);
                if (winDevs.length > 0) {
                  const isChamp = stamped.championId === winnerId;
                  const nextForWinner = Object.values(stamped.matches || {}).find(
                    (m) =>
                      m &&
                      !m.isBye &&
                      !m.completed &&
                      (m.player1Id === winnerId || m.player2Id === winnerId)
                  );
                  sendSystemAnnouncementToDevices(
                    winDevs,
                    isChamp ? '🏆 Tournament Champion!' : '🏆 Match Won!',
                    isChamp
                      ? `You won ${nextM.label} (${scoreline}) and won ${stamped.tournamentName || 'the tournament'}!`
                      : `You beat ${loserName} (${scoreline})${
                          nextForWinner ? ` and advanced to ${nextForWinner.roundLabel}` : ''
                        }!`,
                    `pp-win-${mid}`
                  );
                }
              }

              if (loserId) {
                const loseDevs = Object.entries(claims)
                  .filter(([, pid]) => pid === loserId)
                  .map(([devId]) => devId);
                if (loseDevs.length > 0) {
                  const stillAlive = Object.values(stamped.matches || {}).some(
                    (m) =>
                      m &&
                      !m.isBye &&
                      !m.completed &&
                      (m.player1Id === loserId || m.player2Id === loserId)
                  );
                  sendSystemAnnouncementToDevices(
                    loseDevs,
                    stillAlive ? '🏓 Moved to Losers Bracket' : '🏓 Tournament Run Complete',
                    stillAlive
                      ? `${winnerName} won ${nextM.label} (${scoreline}) — you're still in the Losers Bracket!`
                      : `${winnerName} won ${nextM.label} (${scoreline}) — great games!`,
                    `pp-loss-${mid}`
                  );
                }
              }
            }
          } catch {
            // Never fail state sync if announcement detection errors
          }
        } else {
          broadcastSSE('LIBRARY_UPDATE', {
            sender: body.sender || null,
            activeTournamentId: store.activeTournamentId,
            tournaments: publicSummaries,
            totalCloudTournaments,
            privateCloudCount,
            hosts: getHostsList(),
          });
        }

        return sendJson(res, 200, {
          ok: true,
          state: stamped,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(reqDeviceId),
          totalCloudTournaments,
          privateCloudCount,
          hosts: getHostsList(),
          hostDevice: store.hostDevice,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 5. List Cloud Tournaments (returns visible list for viewerDeviceId + total & private counts)
    if (pathname === '/__sync/tournaments' && req.method === 'GET') {
      const viewerDeviceId = urlObj.searchParams.get('deviceId') || '';
      const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
      return sendJson(res, 200, {
        activeTournamentId: store.activeTournamentId,
        tournaments: getLibrarySummaries(viewerDeviceId),
        totalCloudTournaments,
        privateCloudCount,
        hosts: getHostsList(),
        hostDevice: store.hostDevice,
        ...getAdminPayloadFor(viewerDeviceId),
      });
    }

    // 6. Select Active Cloud Tournament
    //    - Hosts join their own freely
    //    - Unclaimed ("Sync Host") or Unsecure/Open tournaments allow anyone without a key
    //    - Secure hosted tournaments require the 4-word Tournament ID key for non-hosts!
    if (pathname === '/__sync/select' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }

        const requesterDeviceId = body?.deviceId || null;
        const isRequesterAdmin = isDeviceAdmin(requesterDeviceId);
        const isOwnHost = Boolean(
          entry.hostDeviceId && requesterDeviceId && entry.hostDeviceId === requesterDeviceId
        );
        const isUnclaimed = !entry.hostDeviceId;
        const access = normalizeAccessConfig(entry.access);
        const expectedCode = resolveTournamentJoinCode(entry);
        const providedRaw = body?.joinCode || body?.code || '';
        const maxTypos = store.hubSettings?.allowedKeyTypos ?? DEFAULT_HUB_SETTINGS.allowedKeyTypos;
        const hasValidKey = Boolean(
          providedRaw && matchTournamentJoinKey(providedRaw, expectedCode, { maxTypos }).matched
        );
        const isAlreadyAuthorizedGuest = Boolean(
          requesterDeviceId && store.authorizedGuests?.[id]?.[requesterDeviceId]
        );

        // Enforce key gate ONLY when tournament is hosted AND Secure and caller is not an Admin/Host
        // and does not already hold an active (non-revoked) guest authorization
        if (
          !isRequesterAdmin &&
          !isUnclaimed &&
          access.isSecure &&
          !isOwnHost &&
          !hasValidKey &&
          !isAlreadyAuthorizedGuest
        ) {
          return sendJson(res, 403, {
            error: 'Tournament ID key required to join this secure tournament',
            requiresKey: true,
            hostDeviceName: entry.hostDeviceName || 'Sync Host',
            hostIp: entry.hostIp || null,
          });
        }

        const selected = {
          ...entry,
          joinCode: expectedCode,
          access,
          joinRequests: requesterDeviceId
            ? (entry.joinRequests || []).filter((r) => r && r.deviceId !== requesterDeviceId)
            : entry.joinRequests || [],
        };
        store.tournaments[id] = selected;
        if (!isOwnHost && !isRequesterAdmin && requesterDeviceId) {
          authorizeGuest(id, requesterDeviceId);
        }
        if ((isOwnHost || isRequesterAdmin) && body.activate !== false) {
          store.activeTournamentId = id;
        }
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        return sendJson(res, 200, {
          ok: true,
          role: isRequesterAdmin ? 'admin' : isOwnHost ? 'host' : isUnclaimed ? 'unclaimed' : 'guest',
          state: selected,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(requesterDeviceId),
          totalCloudTournaments,
          privateCloudCount,
          hosts: getHostsList(),
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6b. Join Cloud Tournament by 4-Word Join Key (works for BOTH Public and Private tournaments!)
    if (pathname === '/__sync/join' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const rawCode = body?.code || body?.joinCode || body?.tournamentId || '';
        const matchedKey = findTournamentKeyByCodeOrId(rawCode, { allowFuzzy: true });
        if (!matchedKey || !store.tournaments[matchedKey]) {
          return sendJson(res, 404, {
            error: 'No tournament found matching that 4-word key',
            normalizedCode: normalizeFourWordId(rawCode),
          });
        }
        const entry = store.tournaments[matchedKey];
        const requesterDeviceId = body?.deviceId || null;
        const isOwnHost = Boolean(
          entry.hostDeviceId && requesterDeviceId && entry.hostDeviceId === requesterDeviceId
        );
        const isUnclaimed = !entry.hostDeviceId;
        const selected = {
          ...entry,
          joinCode: resolveTournamentJoinCode(entry),
          access: normalizeAccessConfig(entry.access),
          joinRequests: requesterDeviceId
            ? (entry.joinRequests || []).filter((r) => r && r.deviceId !== requesterDeviceId)
            : entry.joinRequests || [],
        };
        store.tournaments[matchedKey] = selected;
        if (!isOwnHost && requesterDeviceId) {
          authorizeGuest(matchedKey, requesterDeviceId);
        }
        if (isOwnHost && body.activate !== false) {
          store.activeTournamentId = matchedKey;
        }
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        return sendJson(res, 200, {
          ok: true,
          role: isOwnHost ? 'host' : isUnclaimed ? 'unclaimed' : 'guest',
          tournamentId: matchedKey,
          joinCode: selected.joinCode,
          state: selected,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(requesterDeviceId),
          totalCloudTournaments,
          privateCloudCount,
          hosts: getHostsList(),
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6c. Update Tournament Security & Visibility (Host or Admin, or anyone while unclaimed)
    if (pathname === '/__sync/tournament/access' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }
        const reqDeviceId = body?.deviceId || null;
        const actorRole = resolveEffectiveRole(entry, reqDeviceId, '', {
          adminDeviceIds: getAdminDeviceIds(),
        });
        if (!getRolePermissions(actorRole).canManageAccessSettings) {
          return sendJson(res, 403, { error: 'Only a host or admin can change security and visibility settings' });
        }
        const prevAccess = normalizeAccessConfig(entry.access);
        const nextIsPublic = body.isPublic !== undefined ? Boolean(body.isPublic) : prevAccess.isPublic;
        const nextAccess = {
          isPublic: nextIsPublic,
          isSecure: nextIsPublic
            ? body.isSecure !== undefined
              ? Boolean(body.isSecure)
              : prevAccess.isSecure
            : true,
        };
        const nextRules =
          body.requireScorekeeperApproval !== undefined
            ? {
              ...(entry.rules || {}),
              requireScorekeeperApproval: Boolean(body.requireScorekeeperApproval),
            }
            : entry.rules;
        const updated = {
          ...entry,
          access: nextAccess,
          rules: nextRules,
          updatedAt: Date.now(),
        };
        store.tournaments[id] = updated;
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        broadcastStateSyncSSE({
          sender: body.sender || null,
          state: updated,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts: getHostsList(),
        });
        return sendJson(res, 200, {
          ok: true,
          state: updated,
          tournaments: getLibrarySummaries(reqDeviceId),
          totalCloudTournaments,
          privateCloudCount,
          hosts: getHostsList(),
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6d. Claim an Unclaimed ("Sync Host") Tournament as Host — or Claim & Cancel Scheduled Destruction (Previous Hosts Only!)
    if (pathname === '/__sync/tournament/claim' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }
        const reqDeviceId = body?.deviceId || null;
        if (!reqDeviceId) {
          return sendJson(res, 400, { error: 'deviceId is required to claim host control' });
        }
        const hadPendingDestruction = Boolean(entry.destruction);
        const reqIsAdmin = isDeviceAdmin(reqDeviceId);
        if (hadPendingDestruction) {
          if (!reqIsAdmin && !isPreviousTournamentHost(entry, reqDeviceId)) {
            return sendJson(res, 403, {
              error:
                'Only a Hub Admin or previous host of this tournament can claim and cancel a scheduled destruction',
            });
          }
        } else if (!reqIsAdmin && entry.hostDeviceId && entry.hostDeviceId !== reqDeviceId) {
          return sendJson(res, 403, {
            error: `Tournament is already hosted by ${entry.hostDeviceName || 'another device'}`,
          });
        }
        clearDestructionTimer(id);

        const serverInfo = collectLocalServerInfo(getPort(), appMeta);
        const reqIp = getDisplayIpForRequest(req, serverInfo);
        const reqDeviceName = String(body?.deviceName || serverInfo.hostname || 'Tournament Host').trim();
        registerHostDevice({ deviceId: reqDeviceId, deviceName: reqDeviceName, ip: reqIp });

        const prevAccess = normalizeAccessConfig(entry.access);
        const updated = {
          ...entry,
          hostDeviceId: reqDeviceId,
          hostDeviceName: reqDeviceName,
          hostIp: reqIp,
          hostHistory: mergeHostHistory(entry.hostHistory, entry.hostDeviceId, reqDeviceId),
          destruction: null,
          access: {
            ...prevAccess,
            isSecure: true,
          },
          updatedAt: Date.now(),
        };
        store.tournaments[id] = updated;
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        const hosts = getHostsList();
        broadcastStateSyncSSE({
          sender: body.sender || null,
          state: updated,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });
        broadcastSSE('HOST_UPDATE', {
          sender: body.sender || null,
          hosts,
          hostDevice: store.hostDevice,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
        });
        return sendJson(res, 200, {
          ok: true,
          cancelledDestruction: hadPendingDestruction,
          state: updated,
          tournaments: getLibrarySummaries(reqDeviceId),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
          hostDevice: store.hostDevice,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6e. Abandon Host Control (Makes tournament Public, Unsecure, and relinquishes Host to "Sync Host")
    if (pathname === '/__sync/tournament/abandon' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }
        const reqDeviceId = body?.deviceId || null;
        if (entry.hostDeviceId && entry.hostDeviceId !== reqDeviceId && !isDeviceAdmin(reqDeviceId)) {
          return sendJson(res, 403, { error: 'Only the current host or a Hub Admin can abandon this tournament' });
        }
        const updated = {
          ...entry,
          hostHistory: mergeHostHistory(entry.hostHistory, entry.hostDeviceId, reqDeviceId),
          hostDeviceId: null,
          hostDeviceName: 'Sync Host',
          hostIp: null,
          access: {
            isPublic: true,
            isSecure: false,
          },
          updatedAt: Date.now(),
        };
        store.tournaments[id] = updated;
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        const hosts = getHostsList();
        broadcastStateSyncSSE({
          sender: body.sender || null,
          state: updated,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });
        broadcastSSE('LIBRARY_UPDATE', {
          sender: body.sender || null,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });
        return sendJson(res, 200, {
          ok: true,
          state: updated,
          tournaments: getLibrarySummaries(reqDeviceId),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6e-2. Schedule Tournament Destruction (5-Minute Grace Timer; Any Previous Host Can Claim & Cancel!)
    if (pathname === '/__sync/tournament/destroy' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }
        const reqDeviceId = body?.deviceId || null;
        if (!reqDeviceId) {
          return sendJson(res, 400, { error: 'deviceId is required' });
        }
        if (entry.hostDeviceId && entry.hostDeviceId !== reqDeviceId && !isDeviceAdmin(reqDeviceId)) {
          return sendJson(res, 403, { error: 'Only the current host or a Hub Admin can schedule destruction' });
        }
        if (!entry.hostDeviceId && entry.destruction) {
          return sendJson(res, 200, {
            ok: true,
            alreadyScheduled: true,
            state: entry,
            tournaments: getLibrarySummaries(reqDeviceId),
          });
        }
        const rawDelay = Number(body?.delayMs);
        const delayMs =
          Number.isFinite(rawDelay) && rawDelay >= 50 && rawDelay <= 60 * 60 * 1000
            ? Math.floor(rawDelay)
            : DESTROY_GRACE_MS;
        const now = Date.now();
        const serverInfo = collectLocalServerInfo(getPort(), appMeta);
        const reqDeviceName = String(
          body?.deviceName || entry.hostDeviceName || serverInfo.hostname || 'Host'
        ).trim();

        const updated = {
          ...entry,
          hostHistory: mergeHostHistory(entry.hostHistory, entry.hostDeviceId, reqDeviceId),
          hostDeviceId: null,
          hostDeviceName: 'Sync Host',
          hostIp: null,
          destruction: {
            scheduledAt: now,
            destroyAt: now + delayMs,
            initiatedByDeviceId: reqDeviceId,
            initiatedByName: reqDeviceName,
          },
          updatedAt: now,
        };
        store.tournaments[id] = updated;
        scheduleDestructionTimer(updated);
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        const hosts = getHostsList();
        broadcastStateSyncSSE({
          sender: body.sender || null,
          state: updated,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });
        broadcastSSE('LIBRARY_UPDATE', {
          sender: body.sender || null,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });
        return sendJson(res, 200, {
          ok: true,
          destruction: updated.destruction,
          state: updated,
          tournaments: getLibrarySummaries(reqDeviceId),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6f. Rotate / Generate a New 4-Word Join Key Without Disconnecting Clients (Host or Admin)
    if (pathname === '/__sync/tournament/rotate-key' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }
        const reqDeviceId = body?.deviceId || null;
        const actorRole = resolveEffectiveRole(entry, reqDeviceId, '', {
          adminDeviceIds: getAdminDeviceIds(),
        });
        if (!getRolePermissions(actorRole).canManageAccessSettings) {
          return sendJson(res, 403, { error: 'Only a host or admin can generate a new tournament key' });
        }

        const takenCodes = new Set(
          Object.values(store.tournaments)
            .map((t) => resolveTournamentJoinCode(t))
            .filter(Boolean)
        );
        const nextJoinCode = generateFourWordId(takenCodes);

        // Keep `tournamentId` unchanged so all currently connected clients stay online uninterrupted!
        const updated = {
          ...entry,
          joinCode: nextJoinCode,
          updatedAt: Date.now(),
        };
        store.tournaments[id] = updated;
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        const hosts = getHostsList();
        broadcastStateSyncSSE({
          sender: body.sender || null,
          state: updated,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });

        return sendJson(res, 200, {
          ok: true,
          joinCode: nextJoinCode,
          state: updated,
          tournaments: getLibrarySummaries(reqDeviceId),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6g. Assign User Device Role OR Individual Tab Role Override with Strict Down-Promotion Enforcement
    if (pathname === '/__sync/tournament/role' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }
        const actorDeviceId = body?.actorDeviceId || body?.deviceId || '';
        const actorTabId = body?.actorTabId || body?.sender || '';
        const targetDeviceId = body?.targetDeviceId || '';
        const targetTabId = body?.targetTabId || '';
        const rawRole = body?.role;
        const adminIds = getAdminDeviceIds();
        const actorRole = resolveEffectiveRole(entry, actorDeviceId, actorTabId, {
          adminDeviceIds: adminIds,
        });

        // Mode A: Individual Tab Role Override (does NOT modify the device's overall role!)
        if (targetTabId) {
          if (actorTabId && actorTabId === targetTabId) {
            return sendJson(res, 403, { error: 'Cannot override the role of the session you are currently using' });
          }
          // Resolve target tab's deviceId from live SSE clients if not explicitly supplied
          let resolvedTargetDeviceId = targetDeviceId;
          if (!resolvedTargetDeviceId) {
            for (const meta of sseClients.values()) {
              if (meta.tabId === targetTabId) {
                resolvedTargetDeviceId = meta.deviceId || '';
                break;
              }
            }
          }
          const isOwnOtherTab = Boolean(
            actorDeviceId && resolvedTargetDeviceId && actorDeviceId === resolvedTargetDeviceId
          );
          const targetDeviceRole = resolveDeviceRole(entry, resolvedTargetDeviceId, {
            adminDeviceIds: adminIds,
          });
          const isClearOverride = rawRole === null || rawRole === '' || rawRole === 'inherit';
          const nextTabRole = isClearOverride ? null : normalizeRole(rawRole);

          if (!canAssignTabRole(actorRole, targetDeviceRole, nextTabRole, { isOwnOtherTab })) {
            return sendJson(res, 403, {
              error: `Role "${actorRole}" cannot set tab override to "${nextTabRole || 'inherit'}"`,
            });
          }

          const nextTabRoles = { ...(entry.tabRoles || {}) };
          if (isClearOverride) {
            delete nextTabRoles[targetTabId];
          } else {
            nextTabRoles[targetTabId] = nextTabRole;
          }

          const updated = {
            ...entry,
            tabRoles: nextTabRoles,
            updatedAt: Date.now(),
          };
          store.tournaments[id] = updated;
          scheduleDiskSave();

          const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
          const hosts = getHostsList();
          const clientsList = getConnectedClientsList();
          broadcastStateSyncSSE({
            sender: body.sender || null,
            state: updated,
            activeTournamentId: store.activeTournamentId,
            tournaments: getLibrarySummaries(null),
            totalCloudTournaments,
            privateCloudCount,
            hosts,
          });
          broadcastSSE('CLIENTS_UPDATE', {
            connectedClients: sseClients.size,
            clients: clientsList,
          });

          return sendJson(res, 200, {
            ok: true,
            scope: 'tab',
            targetTabId,
            role: nextTabRole || 'inherit',
            state: updated,
            clients: clientsList,
          });
        }

        // Mode B: Overall Device Role Assignment
        const nextRole = normalizeRole(rawRole);
        if (!targetDeviceId) {
          return sendJson(res, 400, { error: 'targetDeviceId or targetTabId is required' });
        }
        const targetCurrentRole = resolveDeviceRole(entry, targetDeviceId, {
          adminDeviceIds: adminIds,
        });
        if (!canAssignRole(actorRole, targetCurrentRole, nextRole)) {
          return sendJson(res, 403, {
            error: `Role "${actorRole}" cannot change "${targetCurrentRole}" to "${nextRole}"`,
          });
        }

        const nextUserRoles = { ...(entry.userRoles || {}) };
        let nextHostDeviceId = entry.hostDeviceId || null;
        let nextHostDeviceName = entry.hostDeviceName || 'Sync Host';
        let nextHostIp = entry.hostIp || null;
        let nextHostHistory = mergeHostHistory(entry.hostHistory, entry.hostDeviceId);

        if (nextRole === 'host') {
          // Hub Admin transfers/assigns Host ownership of this tournament to targetDeviceId
          let targetMeta = null;
          for (const meta of sseClients.values()) {
            if (meta.deviceId === targetDeviceId) {
              targetMeta = meta;
              break;
            }
          }
          nextHostDeviceId = targetDeviceId;
          nextHostDeviceName = targetMeta?.deviceName || body?.targetDeviceName || 'Tournament Host';
          nextHostIp = targetMeta?.ip || null;
          nextHostHistory = mergeHostHistory(nextHostHistory, targetDeviceId);
          delete nextUserRoles[targetDeviceId];
        } else {
          // If an Admin demotes the current Host of this tournament, release host ownership cleanly
          if (entry.hostDeviceId && entry.hostDeviceId === targetDeviceId) {
            nextHostDeviceId = null;
            nextHostDeviceName = 'Sync Host';
            nextHostIp = null;
          }
          if (nextRole === 'spectator') {
            delete nextUserRoles[targetDeviceId];
          } else {
            nextUserRoles[targetDeviceId] = nextRole;
          }
        }
        const nextRequests = (entry.scorekeeperRequests || []).filter(
          (r) => r && r.deviceId !== targetDeviceId
        );
        const demotedSet = new Set(
          Array.isArray(entry.demotedScorekeepers) ? entry.demotedScorekeepers : []
        );
        if (
          nextRole === 'spectator' &&
          (ROLE_LEVEL[targetCurrentRole] ?? 0) >= ROLE_LEVEL.scorekeeper
        ) {
          demotedSet.add(targetDeviceId);
        } else if (nextRole !== 'spectator') {
          demotedSet.delete(targetDeviceId);
        }
        const updated = {
          ...entry,
          hostDeviceId: nextHostDeviceId,
          hostDeviceName: nextHostDeviceName,
          hostIp: nextHostIp,
          hostHistory: nextHostHistory,
          userRoles: nextUserRoles,
          scorekeeperRequests: nextRequests,
          demotedScorekeepers: Array.from(demotedSet),
          updatedAt: Date.now(),
        };
        store.tournaments[id] = updated;
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        const hosts = getHostsList();
        const clientsList = getConnectedClientsList();
        broadcastStateSyncSSE({
          sender: body.sender || null,
          state: updated,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });
        broadcastSSE('CLIENTS_UPDATE', {
          connectedClients: sseClients.size,
          clients: clientsList,
        });

        return sendJson(res, 200, {
          ok: true,
          scope: 'device',
          role: nextRole,
          state: updated,
          clients: clientsList,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6h. Request Scorekeeper Access (Auto-Grants Immediately When Require Approval is OFF!)
    if (pathname === '/__sync/tournament/request-scorekeeper' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }
        const reqDeviceId = body?.deviceId || '';
        if (!reqDeviceId) {
          return sendJson(res, 400, { error: 'deviceId is required' });
        }
        if (!isDeviceAuthorizedForTournament(entry, reqDeviceId, body?.joinCode || '')) {
          return sendJson(res, 403, { error: 'Not authorized for this tournament', accessRevoked: true });
        }

        const currentRole = resolveEffectiveRole(entry, reqDeviceId, '', {
          adminDeviceIds: getAdminDeviceIds(),
        });
        if (currentRole === 'presenter') {
          return sendJson(res, 403, { error: 'Presenters are dedicated to Presentation View' });
        }
        if ((ROLE_LEVEL[currentRole] ?? 0) >= ROLE_LEVEL.scorekeeper) {
          return sendJson(res, 200, { ok: true, approved: true, role: currentRole, state: entry });
        }

        const serverInfo = collectLocalServerInfo(getPort(), appMeta);
        const reqIp = getDisplayIpForRequest(req, serverInfo);
        const reqDeviceName = String(body?.deviceName || 'Spectator Device').trim();
        const requireApproval = entry.rules?.requireScorekeeperApproval !== false;
        const wasManuallyDemoted =
          Array.isArray(entry.demotedScorekeepers) &&
          entry.demotedScorekeepers.includes(reqDeviceId);

        if (!requireApproval && !wasManuallyDemoted) {
          // Open Scorekeeper mode: first-time requests auto-approve immediately!
          const updated = {
            ...entry,
            userRoles: { ...(entry.userRoles || {}), [reqDeviceId]: 'scorekeeper' },
            scorekeeperRequests: (entry.scorekeeperRequests || []).filter(
              (r) => r && r.deviceId !== reqDeviceId
            ),
            updatedAt: Date.now(),
          };
          store.tournaments[id] = updated;
          scheduleDiskSave();
          const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
          const clientsList = getConnectedClientsList();
          broadcastStateSyncSSE({
            sender: body.sender || null,
            state: updated,
            activeTournamentId: store.activeTournamentId,
            tournaments: getLibrarySummaries(null),
            totalCloudTournaments,
            privateCloudCount,
            hosts: getHostsList(),
          });
          broadcastSSE('CLIENTS_UPDATE', {
            connectedClients: sseClients.size,
            clients: clientsList,
          });
          return sendJson(res, 200, {
            ok: true,
            approved: true,
            pending: false,
            role: 'scorekeeper',
            state: updated,
            clients: clientsList,
          });
        }

        // Approval required (either policy is Require Approval, OR user was manually demoted!)
        const existingReqs = Array.isArray(entry.scorekeeperRequests)
          ? entry.scorekeeperRequests.filter((r) => r && r.deviceId !== reqDeviceId)
          : [];
        const nextReqs = [
          {
            deviceId: reqDeviceId,
            deviceName: reqDeviceName,
            ip: reqIp,
            requestedAt: Date.now(),
            previouslyDemoted: wasManuallyDemoted,
            previouslyDenied:
              Array.isArray(entry.deniedDevices) && entry.deniedDevices.includes(reqDeviceId),
            previouslyKicked:
              Array.isArray(entry.kickedDevices) && entry.kickedDevices.includes(reqDeviceId),
          },
          ...existingReqs,
        ];
        const updated = {
          ...entry,
          scorekeeperRequests: nextReqs,
          updatedAt: Date.now(),
        };
        store.tournaments[id] = updated;
        scheduleDiskSave();
        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        broadcastStateSyncSSE({
          sender: body.sender || null,
          state: updated,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts: getHostsList(),
        });
        return sendJson(res, 200, {
          ok: true,
          approved: false,
          pending: true,
          role: 'spectator',
          state: updated,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6i. Approve or Deny Pending Scorekeeper Request (Host, Admin, or Moderator)
    if (pathname === '/__sync/tournament/resolve-request' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }
        const actorDeviceId = body?.actorDeviceId || body?.deviceId || '';
        const targetDeviceId = body?.targetDeviceId || '';
        const approve = Boolean(body?.approve);
        const actorRole = resolveEffectiveRole(entry, actorDeviceId, '', {
          adminDeviceIds: getAdminDeviceIds(),
        });
        if (!getRolePermissions(actorRole).canApproveRequests) {
          return sendJson(res, 403, { error: 'Only admin, host, or moderator can resolve access requests' });
        }
        const nextReqs = (entry.scorekeeperRequests || []).filter(
          (r) => r && r.deviceId !== targetDeviceId
        );
        const nextRoles = { ...(entry.userRoles || {}) };
        let nextDemoted = Array.isArray(entry.demotedScorekeepers)
          ? [...entry.demotedScorekeepers]
          : [];
        const deniedSet = new Set(Array.isArray(entry.deniedDevices) ? entry.deniedDevices : []);
        if (approve && targetDeviceId) {
          const currTargetRole = resolveEffectiveRole(entry, targetDeviceId, '', {
            adminDeviceIds: getAdminDeviceIds(),
          });
          if ((ROLE_LEVEL[currTargetRole] ?? 0) < ROLE_LEVEL.scorekeeper) {
            nextRoles[targetDeviceId] = 'scorekeeper';
          }
          nextDemoted = nextDemoted.filter((did) => did !== targetDeviceId);
        } else if (!approve && targetDeviceId) {
          deniedSet.add(targetDeviceId);
        }
        const updated = {
          ...entry,
          userRoles: nextRoles,
          scorekeeperRequests: nextReqs,
          demotedScorekeepers: nextDemoted,
          deniedDevices: Array.from(deniedSet),
          updatedAt: Date.now(),
        };
        store.tournaments[id] = updated;
        scheduleDiskSave();
        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        const clientsList = getConnectedClientsList();
        broadcastStateSyncSSE({
          sender: body.sender || null,
          state: updated,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts: getHostsList(),
        });
        broadcastSSE('CLIENTS_UPDATE', {
          connectedClients: sseClients.size,
          clients: clientsList,
        });

        // Notify the requesting device immediately over SSE + Web Push so they receive clear Approved / Denied feedback
        if (targetDeviceId) {
          const notifPayload = {
            id: `sk-req-${Date.now()}`,
            kind: 'announcement',
            autoDismissMs: 10000,
            title: approve ? '🎯 Scorekeeper Access Approved!' : 'Scorekeeper Request Declined',
            message: approve
              ? `You can now score matches in ${updated.tournamentName || 'the tournament'}.`
              : `Your Scorekeeper access request for ${updated.tournamentName || 'the tournament'} was declined.`,
            fromName: 'System',
            fromRole: 'system',
            sentAt: Date.now(),
          };
          for (const [clientRes, meta] of sseClients.entries()) {
            if (meta.deviceId !== targetDeviceId) continue;
            try {
              clientRes.write(
                `event: SCOREKEEPER_REQUEST_RESOLVED\ndata: ${JSON.stringify({
                  tournamentId: id,
                  tournamentName: updated.tournamentName || 'Tournament',
                  approved: approve,
                  message: approve
                    ? 'Scorekeeper access approved'
                    : 'Access denied — your Scorekeeper request was declined',
                  at: Date.now(),
                })}\n\n`
              );
              clientRes.write(`event: USER_MESSAGE\ndata: ${JSON.stringify(notifPayload)}\n\n`);
            } catch {
              sseClients.delete(clientRes);
            }
          }
          sendWebPushToDevices([targetDeviceId], {
            id: notifPayload.id,
            tag: `pp-sk-req-${id}`,
            title: notifPayload.title,
            body: notifPayload.message,
            url: '/',
          }).catch(() => {});
        }

        return sendJson(res, 200, {
          ok: true,
          approved: approve,
          state: updated,
          clients: clientsList,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6j. Request Tournament Join Access (Alternative to entering the 4-word key on Secure tournaments!)
    if (pathname === '/__sync/tournament/request-join' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }
        const reqDeviceId = String(body?.deviceId || '').trim();
        if (!reqDeviceId) {
          return sendJson(res, 400, { error: 'deviceId is required' });
        }

        // Already authorized (Open, Unclaimed, Host, Admin, or already approved guest) -> immediate approval!
        if (isDeviceAuthorizedForTournament(entry, reqDeviceId, body?.joinCode || '')) {
          return sendJson(res, 200, {
            ok: true,
            approved: true,
            pending: false,
            state: entry,
            tournaments: getLibrarySummaries(reqDeviceId),
          });
        }

        const serverInfo = collectLocalServerInfo(getPort(), appMeta);
        const reqIp = getDisplayIpForRequest(req, serverInfo);
        const reqDeviceName = String(body?.deviceName || 'New User').trim();
        const existingReqs = Array.isArray(entry.joinRequests)
          ? entry.joinRequests.filter((r) => r && r.deviceId !== reqDeviceId)
          : [];
        const nextReqs = [
          {
            deviceId: reqDeviceId,
            deviceName: reqDeviceName,
            ip: reqIp,
            requestedAt: Date.now(),
            previouslyDemoted:
              Array.isArray(entry.demotedScorekeepers) &&
              entry.demotedScorekeepers.includes(reqDeviceId),
            previouslyDenied:
              Array.isArray(entry.deniedDevices) && entry.deniedDevices.includes(reqDeviceId),
            previouslyKicked:
              Array.isArray(entry.kickedDevices) && entry.kickedDevices.includes(reqDeviceId),
          },
          ...existingReqs,
        ];
        const updated = {
          ...entry,
          joinRequests: nextReqs,
          updatedAt: Date.now(),
        };
        store.tournaments[id] = updated;
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        broadcastStateSyncSSE({
          sender: body.sender || null,
          state: updated,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts: getHostsList(),
        });

        return sendJson(res, 200, {
          ok: true,
          approved: false,
          pending: true,
          tournaments: getLibrarySummaries(reqDeviceId),
          totalCloudTournaments,
          privateCloudCount,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 6k. Approve or Deny Pending Tournament Join Access Request (Admin, Host, or Moderator)
    if (pathname === '/__sync/tournament/resolve-join-request' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = body?.tournamentId;
        const entry = id ? store.tournaments[id] : null;
        if (!id || !entry) {
          return sendJson(res, 404, { error: 'Tournament not found on server' });
        }
        const actorDeviceId = body?.actorDeviceId || body?.deviceId || '';
        const targetDeviceId = String(body?.targetDeviceId || '').trim();
        const approve = Boolean(body?.approve);
        const actorRole = resolveEffectiveRole(entry, actorDeviceId, '', {
          adminDeviceIds: getAdminDeviceIds(),
        });
        if (!getRolePermissions(actorRole).canApproveRequests) {
          return sendJson(res, 403, { error: 'Only admin, host, or moderator can resolve join requests' });
        }

        const nextReqs = (entry.joinRequests || []).filter(
          (r) => r && r.deviceId !== targetDeviceId
        );
        const deniedSet = new Set(Array.isArray(entry.deniedDevices) ? entry.deniedDevices : []);
        if (approve && targetDeviceId) {
          authorizeGuest(id, targetDeviceId);
        } else if (!approve && targetDeviceId) {
          deniedSet.add(targetDeviceId);
        }
        const updated = {
          ...entry,
          joinRequests: nextReqs,
          deniedDevices: Array.from(deniedSet),
          updatedAt: Date.now(),
        };
        store.tournaments[id] = updated;
        scheduleDiskSave();

        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        const hosts = getHostsList();
        const clientsList = getConnectedClientsList();
        broadcastStateSyncSSE({
          sender: body.sender || null,
          state: updated,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
          hosts,
        });
        broadcastSSE('CLIENTS_UPDATE', {
          connectedClients: sseClients.size,
          clients: clientsList,
        });

        // Notify the requesting device immediately over SSE + Web Push so their Hub updates & unlocks in real time
        if (targetDeviceId) {
          const notifPayload = {
            id: `join-req-${Date.now()}`,
            kind: 'announcement',
            autoDismissMs: 10000,
            title: approve ? '🔑 Tournament Access Approved!' : 'Join Request Declined',
            message: approve
              ? `You've been approved to join ${updated.tournamentName || 'the tournament'}!`
              : `Your request to join ${updated.tournamentName || 'the tournament'} was declined.`,
            fromName: 'System',
            fromRole: 'system',
            sentAt: Date.now(),
          };
          for (const [clientRes, meta] of sseClients.entries()) {
            if (meta.deviceId !== targetDeviceId) continue;
            try {
              clientRes.write(
                `event: JOIN_REQUEST_RESOLVED\ndata: ${JSON.stringify({
                  tournamentId: id,
                  tournamentName: updated.tournamentName || 'Tournament',
                  approved: approve,
                  tournaments: getLibrarySummaries(targetDeviceId),
                  totalCloudTournaments,
                  privateCloudCount,
                  at: Date.now(),
                })}\n\n`
              );
              clientRes.write(`event: USER_MESSAGE\ndata: ${JSON.stringify(notifPayload)}\n\n`);
            } catch {
              sseClients.delete(clientRes);
            }
          }
          sendWebPushToDevices([targetDeviceId], {
            id: notifPayload.id,
            tag: `pp-join-req-${id}`,
            title: notifPayload.title,
            body: notifPayload.message,
            url: '/',
          }).catch(() => {});
        }

        return sendJson(res, 200, {
          ok: true,
          approved: approve,
          state: updated,
          clients: clientsList,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 7. Get or Delete a Specific Cloud Tournament (also supports /by-code/:code)
    if (pathname.startsWith('/__sync/tournaments/by-code/') && req.method === 'GET') {
      const code = decodeURIComponent(pathname.slice('/__sync/tournaments/by-code/'.length));
      const matchedKey = findTournamentKeyByCodeOrId(code, { allowFuzzy: true });
      if (!matchedKey || !store.tournaments[matchedKey]) {
        return sendJson(res, 404, { error: 'Tournament not found for that key' });
      }
      return sendJson(res, 200, {
        tournamentId: matchedKey,
        joinCode: resolveTournamentJoinCode(store.tournaments[matchedKey]),
        state: store.tournaments[matchedKey],
      });
    }

    if (pathname.startsWith('/__sync/tournaments/')) {
      const id = decodeURIComponent(pathname.slice('/__sync/tournaments/'.length));
      if (req.method === 'GET') {
        const entry = store.tournaments[id];
        if (!entry) return sendJson(res, 404, { error: 'Tournament not found' });
        const reqDeviceId = urlObj.searchParams.get('deviceId') || '';
        const reqCodeRaw = urlObj.searchParams.get('code') || '';
        const isRequesterAdmin = isDeviceAdmin(reqDeviceId);
        const isOwnHost = Boolean(
          entry.hostDeviceId && reqDeviceId && entry.hostDeviceId === reqDeviceId
        );
        const isUnclaimed = !entry.hostDeviceId;
        const access = normalizeAccessConfig(entry.access);
        const maxTypos = store.hubSettings?.allowedKeyTypos ?? DEFAULT_HUB_SETTINGS.allowedKeyTypos;
        const hasValidKey = Boolean(
          reqCodeRaw &&
            matchTournamentJoinKey(reqCodeRaw, resolveTournamentJoinCode(entry), { maxTypos })
              .matched
        );
        if (!isRequesterAdmin && !isUnclaimed && access.isSecure && !isOwnHost && !hasValidKey) {
          return sendJson(res, 403, {
            error: 'Tournament ID key required to access another host\'s secure tournament',
            requiresKey: true,
          });
        }
        return sendJson(res, 200, { state: entry });
      }
      if (req.method === 'DELETE') {
        const entry = store.tournaments[id];
        if (!entry) return sendJson(res, 404, { error: 'Tournament not found' });
        const reqDeviceId = urlObj.searchParams.get('deviceId') || '';
        if (
          reqDeviceId &&
          entry.hostDeviceId &&
          entry.hostDeviceId !== reqDeviceId &&
          !isDeviceAdmin(reqDeviceId)
        ) {
          return sendJson(res, 403, {
            error: 'Only the tournament host or a Hub Admin can delete this tournament',
          });
        }
        clearDestructionTimer(id);
        delete store.tournaments[id];
        if (store.activeTournamentId === id) {
          const next = Object.values(store.tournaments).sort(
            (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
          )[0];
          store.activeTournamentId = next?.tournamentId || null;
        }
        scheduleDiskSave();
        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        for (const [clientRes, meta] of sseClients.entries()) {
          try {
            clientRes.write(
              `event: LIBRARY_UPDATE\ndata: ${JSON.stringify({
                activeTournamentId: store.activeTournamentId,
                tournaments: getLibrarySummaries(meta.deviceId),
                totalCloudTournaments,
                privateCloudCount,
                hosts: getHostsList(),
              })}\n\n`
            );
          } catch {
            sseClients.delete(clientRes);
          }
        }
        return sendJson(res, 200, {
          ok: true,
          activeTournamentId: store.activeTournamentId,
          tournaments: getLibrarySummaries(reqDeviceId),
          totalCloudTournaments,
          privateCloudCount,
        });
      }
    }

    // 8. Real-Time Synced Grandma Speech (server-clock normalized for zero-skew instant sync on TVs/Fire Sticks)
    if (pathname === '/__sync/grandma' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const speech = body?.activeSpeech;
        if (!speech || !speech.text) {
          return sendJson(res, 400, { error: 'Invalid speech payload' });
        }
        const serverNow = Date.now();
        const rawStart = Number(speech.startedAt ?? speech.timestamp ?? serverNow);
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
        const rebasedSpeech = {
          ...speech,
          startedAt: serverNow,
          expiresAt: serverNow + durationMs,
          nextBanterAt: serverNow + durationMs + nextGapMs,
          durationMs,
          nextGapMs,
          timestamp: serverNow,
        };
        const targetTournamentId = body?.tournamentId || store.activeTournamentId || null;
        const target =
          (targetTournamentId && store.tournaments[targetTournamentId]) || getActiveState();
        if (target) {
          target.grandma = {
            ...(target.grandma || {}),
            activeSpeech: rebasedSpeech,
            nextBanterAt: rebasedSpeech.nextBanterAt,
            ...(rebasedSpeech.isLive ? { liveQuote: rebasedSpeech } : {}),
          };
          scheduleDiskSave();
        }
        broadcastSSE('GRANDMA_SPEECH', {
          sender: body.sender || null,
          tournamentId: target?.tournamentId || targetTournamentId,
          serverTime: serverNow,
          activeSpeech: rebasedSpeech,
        });
        return sendJson(res, 200, { ok: true, serverTime: serverNow });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 9. Instant Cross-Device Debounce Timestamp
    if (pathname === '/__sync/point' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const ts = Number(body?.lastPointAt) || 0;
        if (ts >= 0) {
          store.lastPointAt = ts;
        }
        broadcastSSE('POINT_RECORDED', {
          sender: body.sender || null,
          lastPointAt: store.lastPointAt,
        });
        return sendJson(res, 200, { ok: true, lastPointAt: store.lastPointAt });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 10. Register / Release Host Status (Unlimited Simultaneous Hosts — Any Device Can Host!)
    if (pathname === '/__sync/host-claim' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const serverInfo = collectLocalServerInfo(getPort(), appMeta);
        const reqIp = getDisplayIpForRequest(req, serverInfo);
        const deviceId = body.deviceId || 'unknown';
        const deviceName = body.deviceName || serverInfo.hostname || 'Tournament Host';

        if (body.release) {
          delete store.hosts[deviceId];
          syncPrimaryHostAlias();
        } else {
          registerHostDevice({ deviceId, deviceName, ip: reqIp });
        }

        if (!body.release && body.state && body.state.matches && body.state.players) {
          const stamped = upsertTournament(body.state, {
            deviceId,
            deviceName,
            ip: reqIp,
          });
          const id = stamped.tournamentId;
          store.activeTournamentId = id;
          broadcastSSE('STATE_SYNC', {
            sender: body.sender || null,
            state: stamped,
            activeTournamentId: id,
            tournaments: getLibrarySummaries(),
            hosts: getHostsList(),
          });
        }
        scheduleDiskSave();
        const hosts = getHostsList();
        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        broadcastSSE('HOST_UPDATE', {
          sender: body.sender || null,
          hosts,
          hostDevice: store.hostDevice,
          tournaments: getLibrarySummaries(null),
          totalCloudTournaments,
          privateCloudCount,
        });
        return sendJson(res, 200, {
          ok: true,
          hosts,
          hostDevice: store.hostDevice,
          tournaments: getLibrarySummaries(deviceId),
          totalCloudTournaments,
          privateCloudCount,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 10b. Hub Admin Management (Option C: Local Server Machine Auto-Admin + 4-Word Admin Key)
    if (pathname === '/__sync/admin/claim-local' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const serverInfo = collectLocalServerInfo(getPort(), appMeta);
        if (!isLocalServerRequest(req, serverInfo)) {
          return sendJson(res, 403, {
            error: 'Only the server computer can claim local Hub Admin — use the 4-word Admin Key on remote devices',
          });
        }
        const deviceId = String(body?.deviceId || '').trim();
        if (!deviceId) {
          return sendJson(res, 400, { error: 'deviceId is required' });
        }
        const deviceName = String(body?.deviceName || serverInfo.hostname || 'Server Admin').trim();
        const reqIp = getDisplayIpForRequest(req, serverInfo);
        registerAdminDevice({ deviceId, deviceName, ip: reqIp, source: 'local' });
        scheduleDiskSave();
        broadcastAdminUpdateSSE(body?.sender || null);
        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        return sendJson(res, 200, {
          ok: true,
          ...getAdminPayloadFor(deviceId),
          tournaments: getLibrarySummaries(deviceId),
          totalCloudTournaments,
          privateCloudCount,
          clients: getConnectedClientsList(),
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    if (pathname === '/__sync/admin/unlock' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const deviceId = String(body?.deviceId || '').trim();
        const rawProvided = String(body?.key || body?.adminKey || '').trim();
        const providedKey = normalizeFourWordId(rawProvided);
        const envAdminKey = String(process.env.ADMIN_KEY || '').trim();
        if (!deviceId || !rawProvided) {
          return sendJson(res, 400, { error: 'deviceId and Admin Key are required' });
        }
        const matchesEnvKey = Boolean(envAdminKey && rawProvided === envAdminKey);
        const matchesStoreKey = Boolean(
          providedKey && providedKey === normalizeFourWordId(store.adminKey)
        );
        if (!matchesEnvKey && !matchesStoreKey) {
          return sendJson(res, 403, { error: 'Invalid Hub Admin Key' });
        }
        const serverInfo = collectLocalServerInfo(getPort(), appMeta);
        const reqIp = getDisplayIpForRequest(req, serverInfo);
        const deviceName = String(body?.deviceName || 'Admin Device').trim();
        registerAdminDevice({ deviceId, deviceName, ip: reqIp, source: 'key' });
        scheduleDiskSave();
        broadcastAdminUpdateSSE(body?.sender || null);
        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        return sendJson(res, 200, {
          ok: true,
          ...getAdminPayloadFor(deviceId),
          tournaments: getLibrarySummaries(deviceId),
          totalCloudTournaments,
          privateCloudCount,
          clients: getConnectedClientsList(),
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    if (pathname === '/__sync/admin/grant' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const actorDeviceId = String(body?.actorDeviceId || body?.deviceId || '').trim();
        if (!isDeviceAdmin(actorDeviceId)) {
          return sendJson(res, 403, { error: 'Only a Hub Admin can grant or revoke Admin access' });
        }
        const targetDeviceId = String(body?.targetDeviceId || '').trim();
        if (!targetDeviceId) {
          return sendJson(res, 400, { error: 'targetDeviceId is required' });
        }
        const grant = body?.grant !== false;
        if (grant) {
          let targetMeta = null;
          for (const meta of sseClients.values()) {
            if (meta.deviceId === targetDeviceId) {
              targetMeta = meta;
              break;
            }
          }
          registerAdminDevice({
            deviceId: targetDeviceId,
            deviceName: body?.targetDeviceName || targetMeta?.deviceName || 'Hub Admin',
            ip: targetMeta?.ip || body?.targetIp || '—',
            source: 'grant',
          });
        } else {
          const targetRecord = store.admins?.[targetDeviceId];
          const targetIsOriginalServer = Boolean(
            targetRecord && (targetRecord.isOriginalServerAdmin || targetRecord.source === 'local')
          );
          if (targetIsOriginalServer) {
            return sendJson(res, 403, {
              error: 'Cannot revoke the original server admin',
            });
          }
          const remainingAdmins = Object.keys(store.admins || {}).filter((id) => id !== targetDeviceId);
          if (remainingAdmins.length === 0) {
            return sendJson(res, 400, { error: 'Cannot remove the last remaining Hub Admin' });
          }
          delete store.admins[targetDeviceId];
        }
        scheduleDiskSave();
        broadcastAdminUpdateSSE(body?.sender || null);
        const { totalCloudTournaments, privateCloudCount } = getLibraryStats();
        return sendJson(res, 200, {
          ok: true,
          ...getAdminPayloadFor(actorDeviceId),
          tournaments: getLibrarySummaries(actorDeviceId),
          totalCloudTournaments,
          privateCloudCount,
          clients: getConnectedClientsList(),
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    if (pathname === '/__sync/admin/rotate-key' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const actorDeviceId = String(body?.actorDeviceId || body?.deviceId || '').trim();
        if (!isDeviceAdmin(actorDeviceId)) {
          return sendJson(res, 403, { error: 'Only a Hub Admin can rotate the Hub Admin Key' });
        }
        const prevKey = store.adminKey;
        store.adminKey = generateFourWordId(new Set(prevKey ? [prevKey] : []));
        scheduleDiskSave();
        broadcastAdminUpdateSSE(body?.sender || null);
        return sendJson(res, 200, {
          ok: true,
          ...getAdminPayloadFor(actorDeviceId),
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    if (pathname === '/__sync/admin/settings' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const actorDeviceId = String(body?.actorDeviceId || body?.deviceId || '').trim();
        if (!isDeviceAdmin(actorDeviceId)) {
          return sendJson(res, 403, { error: 'Only a Hub Admin can update Hub settings' });
        }
        store.hubSettings = normalizeHubSettings({
          ...store.hubSettings,
          ...(body?.settings && typeof body.settings === 'object' ? body.settings : body),
        });
        scheduleDiskSave();
        broadcastAdminUpdateSSE(body?.sender || null);
        return sendJson(res, 200, {
          ok: true,
          ...getAdminPayloadFor(actorDeviceId),
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Bad request' });
      }
    }

    // 11. Custom CRT TV Media Sync Across Devices (with HTTP 206 Byte-Range streaming for MP4/WebM)
    if (pathname === '/__sync/media') {
      if (req.method === 'GET') {
        if (urlObj.searchParams.get('meta') === '1') {
          if (!activeMedia) {
            return sendJson(res, 200, { hasMedia: false });
          }
          return sendJson(res, 200, {
            hasMedia: true,
            name: activeMedia.name || 'media',
            type: activeMedia.type || 'application/octet-stream',
            kind: activeMedia.kind || 'image',
            bytes: activeMedia.buffer.length,
            updatedAt: activeMedia.updatedAt || Date.now(),
          });
        }

        if (!activeMedia) {
          setCors(res);
          res.statusCode = 204;
          res.end();
          return;
        }

        const total = activeMedia.buffer.length;
        setCors(res);
        res.setHeader('Content-Type', activeMedia.type || 'application/octet-stream');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-Media-Name', encodeURIComponent(activeMedia.name || 'media'));
        res.setHeader('X-Media-Kind', activeMedia.kind || 'image');
        res.setHeader('X-Media-Updated', String(activeMedia.updatedAt || Date.now()));

        const rangeHeader = String(req.headers.range || '').trim();
        if (rangeHeader && rangeHeader.startsWith('bytes=')) {
          const [rawStart, rawEnd] = rangeHeader.replace(/^bytes=/, '').split(',')[0].split('-');
          let start = rawStart === '' ? NaN : Number.parseInt(rawStart, 10);
          let end = rawEnd === '' ? NaN : Number.parseInt(rawEnd, 10);

          if (Number.isNaN(start) && !Number.isNaN(end)) {
            // Suffix range: bytes=-500
            start = Math.max(0, total - end);
            end = total - 1;
          } else {
            if (Number.isNaN(start) || start < 0) start = 0;
            if (Number.isNaN(end) || end >= total) end = total - 1;
          }

          if (start >= total || start > end) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${total}`);
            res.end();
            return;
          }

          const chunk = activeMedia.buffer.subarray(start, end + 1);
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
          res.setHeader('Content-Length', String(chunk.length));
          res.end(chunk);
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Length', String(total));
        res.end(activeMedia.buffer);
        return;
      }

      if (req.method === 'POST') {
        try {
          const buffer = await readRawBody(req);
          const name = decodeURIComponent(String(req.headers['x-media-name'] || 'tv-media'));
          const type = String(req.headers['x-media-type'] || req.headers['content-type'] || 'application/octet-stream');
          const kind = String(req.headers['x-media-kind'] || (type.startsWith('video/') ? 'video' : 'image'));
          const sender = String(req.headers['x-sync-sender'] || '');
          activeMedia = { buffer, name, type, kind, updatedAt: Date.now() };
          persistActiveMediaToDisk(activeMedia);
          broadcastSSE('MEDIA_UPDATE', {
            sender,
            action: 'set',
            name,
            type,
            kind,
            updatedAt: activeMedia.updatedAt,
          });
          return sendJson(res, 200, {
            ok: true,
            name,
            type,
            kind,
            bytes: buffer.length,
            updatedAt: activeMedia.updatedAt,
          });
        } catch (err) {
          return sendJson(res, 413, { error: err.message || 'Media upload failed' });
        }
      }

      if (req.method === 'DELETE') {
        const sender = String(req.headers['x-sync-sender'] || '');
        activeMedia = null;
        persistActiveMediaToDisk(null);
        broadcastSSE('MEDIA_UPDATE', { sender, action: 'clear', updatedAt: Date.now() });
        return sendJson(res, 200, { ok: true });
      }
    }

    return next();
  };

  lanSyncMiddleware.getAdminKey = () => store.adminKey;

  return lanSyncMiddleware;
}
