/**
 * Tournament & Hub Role-Based Access Control (RBAC) Hierarchy & Helpers.
 * Shared cleanly between the Node LAN Sync Hub server and Browser UI.
 *
 * Hierarchy (highest to lowest):
 *   admin (5) > host (4) > moderator (3) > presenter (2) > scorekeeper (1) > spectator (0)
 *
 * Scope:
 *   - admin (5):       Hub-wide / Server-level role (manages the Hub, all tournaments including
 *                      private ones, Hub defaults, connected devices, and can assign/override Hosts).
 *   - host (4):        Per-tournament owner (created or claimed the tournament; full tournament control).
 *   - moderator (3):   Per-tournament operator (Control, Users, Scorekeeper, Spectator).
 *   - presenter (2):   Dedicated TV/Projector display (Hub, Presentation, Full Screen ONLY).
 *   - scorekeeper (1): Per-tournament scorer (Hub, Scorekeeper, Spectator).
 *   - spectator (0):   Read-only viewer (Hub, Spectator).
 *
 * Down-promotion rule:
 *   An actor (Moderator+) can ONLY modify users strictly below their own rank,
 *   and can ONLY assign roles strictly below their own rank.
 *
 * Per-Tab Override rule:
 *   Individual browser tabs can hold a role override in `state.tabRoles[tabId]`
 *   without affecting the device's overall role (`store.admins` / `state.hostDeviceId` / `state.userRoles[deviceId]`).
 */

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  HOST: 'host',
  MODERATOR: 'moderator',
  PRESENTER: 'presenter',
  SCOREKEEPER: 'scorekeeper',
  SPECTATOR: 'spectator',
});

export const ROLE_ORDER = ['admin', 'host', 'moderator', 'presenter', 'scorekeeper', 'spectator'];

export const ROLE_LEVEL = Object.freeze({
  admin: 5,
  host: 4,
  moderator: 3,
  presenter: 2,
  scorekeeper: 1,
  spectator: 0,
});

export const ROLE_META = Object.freeze({
  admin: { id: 'admin', label: 'Admin', icon: '🛡️' },
  host: { id: 'host', label: 'Host', icon: '👑' },
  moderator: { id: 'moderator', label: 'Moderator', icon: '🔧' },
  presenter: { id: 'presenter', label: 'Presenter', icon: '📺' },
  scorekeeper: { id: 'scorekeeper', label: 'Scorekeeper', icon: '🎯' },
  spectator: { id: 'spectator', label: 'Spectator', icon: '👁️' },
});

export function normalizeRole(raw) {
  const key = String(raw || '').trim().toLowerCase();
  // Backward compatibility: map legacy 'guest' role cleanly to 'spectator'
  if (key === 'guest') return 'spectator';
  return Object.prototype.hasOwnProperty.call(ROLE_LEVEL, key) ? key : 'spectator';
}

export function isHubAdminDevice(deviceId = '', adminDeviceIds = null) {
  if (!deviceId || !adminDeviceIds) return false;
  if (adminDeviceIds instanceof Set) return adminDeviceIds.has(deviceId);
  if (Array.isArray(adminDeviceIds)) {
    return adminDeviceIds.some((item) =>
      typeof item === 'string' ? item === deviceId : item?.deviceId === deviceId
    );
  }
  if (typeof adminDeviceIds === 'object') {
    return Boolean(adminDeviceIds[deviceId]);
  }
  return false;
}

export function isPreviousTournamentHost(stateObj, deviceId = '') {
  if (!stateObj || typeof stateObj !== 'object' || !deviceId) return false;
  if (stateObj.hostDeviceId && stateObj.hostDeviceId === deviceId) return true;
  return Array.isArray(stateObj.hostHistory) && stateObj.hostHistory.includes(deviceId);
}

/**
 * Resolves a device's overall role inside a tournament (ignoring any per-tab overrides).
 * Hub Admins always resolve to 'admin' across all tournaments.
 */
export function resolveDeviceRole(stateObj, deviceId = '', { adminDeviceIds = null } = {}) {
  if (deviceId && isHubAdminDevice(deviceId, adminDeviceIds)) {
    return 'admin';
  }
  if (!stateObj || typeof stateObj !== 'object') return 'host';
  const hostId = stateObj.hostDeviceId || null;
  if (!hostId) {
    if (stateObj.destruction) {
      if (isPreviousTournamentHost(stateObj, deviceId)) return 'host';
      const rawAssigned = deviceId ? stateObj.userRoles?.[deviceId] : null;
      if (rawAssigned) {
        const norm = normalizeRole(rawAssigned);
        if (norm !== 'host' && norm !== 'admin') return norm;
      }
      return 'spectator';
    }
    return 'host'; // Unclaimed / local / abandoned -> open to run/claim as Host
  }
  if (!deviceId) return 'spectator';
  if (hostId === deviceId) return 'host';
  const rawAssigned = stateObj.userRoles?.[deviceId];
  if (rawAssigned) {
    const norm = normalizeRole(rawAssigned);
    if (norm !== 'host' && norm !== 'admin') return norm;
  }
  return 'spectator';
}

/**
 * Resolves a tab's effective role inside a tournament.
 * - If `tabId` has an explicit per-tab override in `stateObj.tabRoles[tabId]`, that role takes precedence
 *   for that specific tab without changing the device's overall role.
 * - Otherwise falls back to the device's overall role (`resolveDeviceRole`).
 */
export function resolveEffectiveRole(
  stateObj,
  deviceId = '',
  tabId = '',
  { adminDeviceIds = null } = {}
) {
  if (tabId && stateObj && typeof stateObj === 'object' && stateObj.tabRoles && typeof stateObj.tabRoles === 'object') {
    const rawTabRole = stateObj.tabRoles[tabId];
    if (rawTabRole) {
      const normTab = normalizeRole(rawTabRole);
      if (normTab !== 'admin' && normTab !== 'host') return normTab;
    }
  }
  return resolveDeviceRole(stateObj, deviceId, { adminDeviceIds });
}

/**
 * Returns the list of roles an actor is permitted to assign (strictly below actor's rank).
 *  - admin     -> ['host', 'moderator', 'presenter', 'scorekeeper', 'spectator']
 *  - host      -> ['moderator', 'presenter', 'scorekeeper', 'spectator']
 *  - moderator -> ['presenter', 'scorekeeper', 'spectator']
 *  - others    -> []
 */
export function getAssignableRoles(actorRole) {
  const level = ROLE_LEVEL[normalizeRole(actorRole)] ?? 0;
  if (level < ROLE_LEVEL.moderator) return [];
  return ROLE_ORDER.filter((r) => ROLE_LEVEL[r] < level);
}

/**
 * Returns true if `actorRole` is allowed to change a device's overall role from `targetCurrentRole` to `nextRole`.
 */
export function canAssignRole(actorRole, targetCurrentRole, nextRole) {
  const actorLvl = ROLE_LEVEL[normalizeRole(actorRole)] ?? 0;
  const targetLvl = ROLE_LEVEL[normalizeRole(targetCurrentRole)] ?? 0;
  const nextLvl = ROLE_LEVEL[normalizeRole(nextRole)] ?? 0;
  if (actorLvl < ROLE_LEVEL.moderator) return false;
  if (targetLvl >= actorLvl) return false;
  if (nextLvl >= actorLvl) return false;
  return true;
}

/**
 * Returns true if `actorRole` is allowed to set or clear a per-tab role override.
 * - Clearing an override (`nextRole === null` or `'inherit'`) is allowed if the actor can manage that tab.
 * - An actor may override another tab on their OWN device (`isOwnOtherTab: true`) to any role strictly
 *   below their own rank (e.g. a Host or Admin turning their 2nd tab into a Presenter or Scorekeeper),
 *   without altering their device's overall role.
 * - Tab overrides only support per-tab operational roles (moderator, presenter, scorekeeper, spectator).
 */
export function canAssignTabRole(
  actorRole,
  targetDeviceRole,
  nextRole,
  { isOwnOtherTab = false } = {}
) {
  const actorLvl = ROLE_LEVEL[normalizeRole(actorRole)] ?? 0;
  const targetDevLvl = ROLE_LEVEL[normalizeRole(targetDeviceRole)] ?? 0;
  if (actorLvl < ROLE_LEVEL.moderator) return false;
  if (!isOwnOtherTab && targetDevLvl >= actorLvl) return false;
  if (nextRole === null || nextRole === '' || nextRole === 'inherit') return true;
  const normNext = normalizeRole(nextRole);
  if (normNext === 'admin' || normNext === 'host') return false;
  const nextLvl = ROLE_LEVEL[normNext] ?? 0;
  return nextLvl < actorLvl;
}

/**
 * Returns true if `actorRole` can disconnect a client with `targetRole`.
 */
export function canDisconnectRole(actorRole, targetRole) {
  const actorLvl = ROLE_LEVEL[normalizeRole(actorRole)] ?? 0;
  const targetLvl = ROLE_LEVEL[normalizeRole(targetRole)] ?? 0;
  return actorLvl >= ROLE_LEVEL.moderator && actorLvl > targetLvl;
}

/**
 * Computes UI & action permissions for an effective role:
 * - Everybody (except presenter) can access Hub and Spectator
 * - Scorekeeper and up (except presenter) can access Scorekeeper
 * - Moderator and up can access Users and Control
 * - Host and up can access System, Presentation, and Tournament Access/Security settings
 * - Admin ONLY has access to the Hub Admin Panel and Hub-wide controls
 * - Presenter ONLY has access to Hub + Presentation (+ Full Screen)
 */
export function getRolePermissions(role) {
  const norm = normalizeRole(role);
  const lvl = ROLE_LEVEL[norm] ?? 0;
  const isPresenter = norm === 'presenter';
  return {
    role: norm,
    level: lvl,
    canAccessHub: true,
    canAccessAdmin: norm === 'admin',
    canAccessSpectator: !isPresenter,
    canScore: !isPresenter && lvl >= ROLE_LEVEL.scorekeeper,
    canAccessUsers: lvl >= ROLE_LEVEL.moderator,
    canAccessControl: lvl >= ROLE_LEVEL.moderator,
    canAccessSystem: lvl >= ROLE_LEVEL.host,
    canAccessPresent: true,
    canSelectLocalSlides: !isPresenter,
    canManageAccessSettings: lvl >= ROLE_LEVEL.host,
    canApproveRequests: lvl >= ROLE_LEVEL.moderator,
    canAbandonHost: lvl >= ROLE_LEVEL.host,
  };
}
