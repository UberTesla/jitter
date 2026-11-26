/**
 * Lightweight, zero-dependency Usage Analytics engine.
 * Tracks views, time-on-view, and UI/feature interactions tagged with:
 *   - User Role (admin, host, moderator, presenter, scorekeeper, spectator)
 *   - Tournament Context (entryMode: singles/teams, format: single/double, playerCount, demoMode)
 *   - Device Context (mobile vs desktop, browser, PWA standalone)
 *
 * Batches events to `POST /__sync/analytics` (and flushes via `navigator.sendBeacon` on tab hide)
 * while maintaining a compact localStorage mirror so Render Free restarts never wipe stats.
 */

const LOCAL_USAGE_STORAGE_KEY = 'pingpong-usage-analytics-v1';
const LOCAL_TELEMETRY_ENABLED_KEY = 'pingpong-telemetry-enabled-v1';
const MAX_LOCAL_EVENTS = 2500;
const FLUSH_INTERVAL_MS = 12000;
const MAX_QUEUE_BEFORE_FLUSH = 30;

let contextProvider = () => ({});
let baseUrlProvider = () => '';
let pendingQueue = [];
let pendingLocalQueue = [];
let flushTimer = null;
let localFlushScheduled = false;
let clickListenerAttached = false;
let currentViewTracker = { view: null, startedAt: 0 };
let telemetryEnabled = (() => {
  if (typeof localStorage === 'undefined') return true;
  try {
    const raw = localStorage.getItem(LOCAL_TELEMETRY_ENABLED_KEY);
    return raw === '0' ? false : true;
  } catch {
    return true;
  }
})();

export function isTelemetryEnabled() {
  return telemetryEnabled;
}

export function setTelemetryEnabled(enabled) {
  const next = Boolean(enabled);
  telemetryEnabled = next;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LOCAL_TELEMETRY_ENABLED_KEY, next ? '1' : '0');
    } catch {
      // Ignore
    }
  }
  if (!next) {
    pendingQueue = [];
    pendingLocalQueue = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }
}

function runWhenIdle(fn) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(fn, { timeout: 2000 });
  } else if (typeof setTimeout !== 'undefined') {
    setTimeout(fn, 0);
  } else {
    fn();
  }
}

function scheduleLocalMirrorFlush() {
  if (localFlushScheduled || pendingLocalQueue.length === 0) return;
  localFlushScheduled = true;
  runWhenIdle(() => {
    localFlushScheduled = false;
    if (pendingLocalQueue.length === 0) return;
    const batch = pendingLocalQueue.splice(0, pendingLocalQueue.length);
    appendLocalEvents(batch);
  });
}

function readLocalEvents() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_USAGE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendLocalEvents(events) {
  if (typeof localStorage === 'undefined' || !Array.isArray(events) || events.length === 0) return;
  try {
    const existing = readLocalEvents();
    const merged = existing.concat(events).slice(-MAX_LOCAL_EVENTS);
    localStorage.setItem(LOCAL_USAGE_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Ignore storage quota errors
  }
}

export function clearLocalUsageEvents() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(LOCAL_USAGE_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

export function getLocalUsageEvents() {
  return readLocalEvents();
}

function cleanLabel(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

function buildEvent(type, name, extra = {}) {
  const ctx = typeof contextProvider === 'function' ? contextProvider() || {} : {};
  return {
    ts: Date.now(),
    type: String(type || 'action'),
    name: cleanLabel(name) || 'unknown',
    category: String(extra.category || 'ui'),
    ...(typeof extra.durationMs === 'number' && extra.durationMs > 0
      ? { durationMs: Math.round(extra.durationMs) }
      : {}),
    view: String(extra.view || ctx.view || 'hub'),
    role: String(ctx.role || 'spectator'),
    demoMode: Boolean(ctx.demoMode),
    entryMode: String(ctx.entryMode || 'none'),
    format: String(ctx.format || 'none'),
    playerCount: Number(ctx.playerCount) || 0,
    deviceType: ctx.mobile ? 'mobile' : 'desktop',
    browser: String(ctx.browser || 'Browser'),
    standalone: Boolean(ctx.standalone),
    deviceId: String(ctx.deviceId || ''),
  };
}

export function flushUsageAnalytics({ useBeacon = false } = {}) {
  if (pendingLocalQueue.length > 0) {
    const localBatch = pendingLocalQueue.splice(0, pendingLocalQueue.length);
    appendLocalEvents(localBatch);
  }
  if (!telemetryEnabled || pendingQueue.length === 0) return;
  const batch = pendingQueue.splice(0, pendingQueue.length);
  const baseUrl = typeof baseUrlProvider === 'function' ? baseUrlProvider() : '';
  if (!baseUrl) return;

  const url = `${baseUrl}/__sync/analytics`;
  const payload = JSON.stringify({ events: batch });

  if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
      return;
    } catch {
      // Fall back to fetch
    }
  }

  if (typeof fetch === 'function') {
    const send = () => {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    };
    if (useBeacon) send();
    else runWhenIdle(send);
  }
}

function scheduleFlush() {
  if (!telemetryEnabled) return;
  if (pendingQueue.length >= MAX_QUEUE_BEFORE_FLUSH) {
    runWhenIdle(() => flushUsageAnalytics());
    return;
  }
  if (flushTimer || typeof setTimeout === 'undefined') return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    runWhenIdle(() => flushUsageAnalytics());
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer?.unref === 'function') flushTimer.unref();
}

export function trackUsageEvent(name, { type = 'action', category = 'ui', view, durationMs } = {}) {
  if (typeof window === 'undefined' || !telemetryEnabled) return null;
  const ev = buildEvent(type, name, { category, view, durationMs });
  pendingLocalQueue.push(ev);
  pendingQueue.push(ev);
  scheduleLocalMirrorFlush();
  scheduleFlush();
  return ev;
}

export function trackViewTransition(nextView) {
  if (typeof window === 'undefined' || !nextView) return;
  const now = Date.now();
  if (currentViewTracker.view && currentViewTracker.view !== nextView && currentViewTracker.startedAt > 0) {
    const elapsed = now - currentViewTracker.startedAt;
    if (elapsed >= 1000 && elapsed < 12 * 60 * 60 * 1000) {
      trackUsageEvent(`view:${currentViewTracker.view}`, {
        type: 'view_duration',
        category: 'navigation',
        view: currentViewTracker.view,
        durationMs: elapsed,
      });
    }
  }
  if (currentViewTracker.view !== nextView) {
    currentViewTracker = { view: nextView, startedAt: now };
    trackUsageEvent(`view:${nextView}`, {
      type: 'view',
      category: 'navigation',
      view: nextView,
    });
  }
}

function inferButtonLabel(el) {
  if (!el) return '';
  const explicit = el.getAttribute?.('data-track');
  if (explicit) return cleanLabel(explicit);
  const aria = el.getAttribute?.('aria-label');
  const text = cleanLabel(el.textContent || '');
  // Prefer short visible button text; fall back to aria-label for icon-only buttons
  if (text && text.length >= 2 && text.length <= 42) return text;
  if (aria) return cleanLabel(aria);
  return text || '';
}

export function initUsageAnalytics({ getContext, getBaseUrl } = {}) {
  if (typeof getContext === 'function') contextProvider = getContext;
  if (typeof getBaseUrl === 'function') baseUrlProvider = getBaseUrl;

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (clickListenerAttached) return;
  clickListenerAttached = true;

  document.addEventListener(
    'click',
    (e) => {
      const target = e.target?.closest?.('button, [role="tab"], [role="radio"]');
      if (!target || target.disabled) return;
      const label = inferButtonLabel(target);
      if (!label) return;
      trackUsageEvent(label, { type: 'action', category: 'ui' });
    },
    { capture: true, passive: true }
  );

  const onHide = () => {
    if (currentViewTracker.view && currentViewTracker.startedAt > 0) {
      const elapsed = Date.now() - currentViewTracker.startedAt;
      if (elapsed >= 1000 && elapsed < 12 * 60 * 60 * 1000) {
        trackUsageEvent(`view:${currentViewTracker.view}`, {
          type: 'view_duration',
          category: 'navigation',
          view: currentViewTracker.view,
          durationMs: elapsed,
        });
        currentViewTracker.startedAt = Date.now();
      }
    }
    flushUsageAnalytics({ useBeacon: true });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onHide();
  });
  window.addEventListener('pagehide', onHide);
}

/**
 * Pure aggregation & filtering helper for Usage Stats dashboards and unit tests.
 */
export function summarizeUsageEvents(events = [], filters = {}) {
  const {
    demoFilter = 'real', // 'real' | 'demo' | 'all'
    role = 'all',
    entryMode = 'all',
    format = 'all',
    deviceType = 'all',
    view = 'all',
  } = filters || {};

  const filtered = (Array.isArray(events) ? events : []).filter((ev) => {
    if (!ev || typeof ev !== 'object') return false;
    if (demoFilter === 'real' && ev.demoMode) return false;
    if (demoFilter === 'demo' && !ev.demoMode) return false;
    if (role !== 'all' && ev.role !== role) return false;
    if (entryMode !== 'all' && ev.entryMode !== entryMode) return false;
    if (format !== 'all' && ev.format !== format) return false;
    if (deviceType !== 'all' && ev.deviceType !== deviceType) return false;
    if (view !== 'all' && ev.view !== view) return false;
    return true;
  });

  const uniqueDevices = new Set();
  const viewsMap = new Map();
  const actionsMap = new Map();
  const rolesMap = new Map();
  const tourneyTypesMap = new Map();

  for (const ev of filtered) {
    if (ev.deviceId) uniqueDevices.add(ev.deviceId);
    const r = ev.role || 'spectator';
    rolesMap.set(r, (rolesMap.get(r) || 0) + 1);

    if (ev.entryMode && ev.entryMode !== 'none') {
      const tk = `${ev.entryMode} · ${ev.format || 'single'}`;
      tourneyTypesMap.set(tk, (tourneyTypesMap.get(tk) || 0) + 1);
    }

    if (ev.type === 'view' || ev.type === 'view_duration') {
      const v = ev.view || String(ev.name || '').replace(/^view:/, '') || 'hub';
      if (!viewsMap.has(v)) {
        viewsMap.set(v, { view: v, visits: 0, durationMs: 0, devices: new Set() });
      }
      const row = viewsMap.get(v);
      if (ev.type === 'view') row.visits += 1;
      if (ev.type === 'view_duration') row.durationMs += Number(ev.durationMs) || 0;
      if (ev.deviceId) row.devices.add(ev.deviceId);
    } else {
      const key = `${ev.view || 'hub'}::${ev.name || 'unknown'}`;
      if (!actionsMap.has(key)) {
        actionsMap.set(key, {
          name: ev.name || 'unknown',
          view: ev.view || 'hub',
          category: ev.category || 'ui',
          count: 0,
          devices: new Set(),
        });
      }
      const row = actionsMap.get(key);
      row.count += 1;
      if (ev.deviceId) row.devices.add(ev.deviceId);
    }
  }

  const views = Array.from(viewsMap.values())
    .map((v) => ({
      view: v.view,
      visits: v.visits,
      durationMs: v.durationMs,
      uniqueDevices: v.devices.size,
    }))
    .sort((a, b) => b.visits - a.visits || b.durationMs - a.durationMs);

  const topActions = Array.from(actionsMap.values())
    .map((a) => ({
      name: a.name,
      view: a.view,
      category: a.category,
      count: a.count,
      uniqueDevices: a.devices.size,
    }))
    .sort((a, b) => b.count - a.count);

  const byRole = Array.from(rolesMap.entries())
    .map(([roleName, count]) => ({ role: roleName, count }))
    .sort((a, b) => b.count - a.count);

  const byTournamentType = Array.from(tourneyTypesMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalEvents: filtered.length,
    totalActionEvents: topActions.reduce((sum, a) => sum + a.count, 0),
    uniqueDevices: uniqueDevices.size,
    views,
    topActions,
    byRole,
    byTournamentType,
    filteredEvents: filtered,
  };
}
