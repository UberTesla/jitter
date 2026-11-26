/**
 * Lightweight General App Activity & Diagnostics Log
 * Ring-buffered (200 entries) and mirrored to sessionStorage so logs persist across
 * view switches (Control -> Host -> Admin -> Hub) without bloating memory or slowing UI.
 */

const LOG_STORAGE_KEY = 'jitter-app-log-v1';
const MAX_LOGS = 200;

let logEntries = [];
let initialized = false;
const listeners = new Set();

function loadStoredLogs() {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(LOG_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_LOGS) : [];
  } catch {
    return [];
  }
}

function persistLogs() {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logEntries.slice(0, MAX_LOGS)));
  } catch {
    // Ignore storage quota errors
  }
}

function ensureInit() {
  if (initialized) return;
  initialized = true;
  logEntries = loadStoredLogs();

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('error', (ev) => {
      const msg = ev?.message || 'Unhandled runtime error';
      appendAppLog({
        level: 'error',
        category: 'runtime',
        message: msg,
        detail: ev?.filename ? `${ev.filename}:${ev.lineno || 0}` : '',
      });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev?.reason;
      const msg =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
          ? reason
          : 'Unhandled promise rejection';
      appendAppLog({
        level: 'error',
        category: 'runtime',
        message: msg,
      });
    });
  }
}

function emit() {
  const snapshot = logEntries;
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {
      // Ignore subscriber errors
    }
  }
}

export function appendAppLog({ level = 'info', category = 'app', message = '', detail = '' } = {}) {
  ensureInit();
  const cleanMsg = String(message || '').trim();
  if (!cleanMsg) return null;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    level: ['info', 'success', 'warn', 'error'].includes(level) ? level : 'info',
    category: String(category || 'app').trim().toLowerCase() || 'app',
    message: cleanMsg,
    detail: String(detail || '').trim(),
  };
  logEntries = [entry, ...logEntries].slice(0, MAX_LOGS);
  persistLogs();
  emit();
  return entry;
}

export function getAppLogs() {
  ensureInit();
  return logEntries;
}

export function clearAppLogs() {
  ensureInit();
  logEntries = [];
  persistLogs();
  emit();
}

export function subscribeAppLogs(fn) {
  ensureInit();
  listeners.add(fn);
  return () => listeners.delete(fn);
}
