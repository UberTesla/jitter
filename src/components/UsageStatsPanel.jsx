import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clearLocalUsageEvents,
  flushUsageAnalytics,
  getLocalUsageEvents,
  isTelemetryEnabled,
  setTelemetryEnabled,
  summarizeUsageEvents,
} from '../engine/usageAnalytics.js';
import { tournamentStore } from '../state/tournamentStore.js';

function formatDurationShort(ms) {
  const sec = Math.round((Number(ms) || 0) / 1000);
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  if (mins < 60) return `${mins}m ${rem}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function mergeEvents(serverEvents = [], localEvents = []) {
  const seen = new Set();
  const merged = [];
  for (const ev of [...serverEvents, ...localEvents]) {
    if (!ev || typeof ev !== 'object') continue;
    const key = `${ev.ts}|${ev.deviceId}|${ev.type}|${ev.name}|${ev.view}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ev);
  }
  return merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

export default function UsageStatsPanel({ onNotify }) {
  const [events, setEvents] = useState(() => getLocalUsageEvents());
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [telemetryOn, setTelemetryOn] = useState(() => isTelemetryEnabled());
  const [demoFilter, setDemoFilter] = useState('real'); // 'real' | 'all' | 'demo'

  const handleToggleTelemetry = async (nextVal) => {
    setTelemetryOn(nextVal);
    setTelemetryEnabled(nextVal);
    const meta = tournamentStore.getSyncMeta?.();
    if (meta?.remoteSync?.isThisDeviceAdmin && meta?.remoteSync?.connected) {
      await tournamentStore.updateHubSettings({ telemetryEnabled: nextVal });
      onNotify?.(`Usage telemetry turned ${nextVal ? 'ON' : 'OFF'} across all devices`);
    } else {
      onNotify?.(`Usage telemetry turned ${nextVal ? 'ON' : 'OFF'} on this device`);
    }
  };
  const [roleFilter, setRoleFilter] = useState('all');
  const [entryModeFilter, setEntryModeFilter] = useState('all');
  const [formatFilter, setFormatFilter] = useState('all');
  const [deviceTypeFilter, setDeviceTypeFilter] = useState('all');
  const [viewFilter, setViewFilter] = useState('all');

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    flushUsageAnalytics();
    const local = getLocalUsageEvents();
    const baseUrl = tournamentStore.getSyncBaseUrl?.() || '';
    if (!baseUrl) {
      setEvents(local);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/__sync/analytics`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const serverList = Array.isArray(data.events) ? data.events : [];
        setEvents(mergeEvents(serverList, local));
      } else {
        setEvents(local);
      }
    } catch {
      setEvents(local);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const summary = useMemo(
    () =>
      summarizeUsageEvents(events, {
        demoFilter,
        role: roleFilter,
        entryMode: entryModeFilter,
        format: formatFilter,
        deviceType: deviceTypeFilter,
        view: viewFilter,
      }),
    [events, demoFilter, roleFilter, entryModeFilter, formatFilter, deviceTypeFilter, viewFilter]
  );

  const handleExport = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      filters: {
        demoFilter,
        role: roleFilter,
        entryMode: entryModeFilter,
        format: formatFilter,
        deviceType: deviceTypeFilter,
        view: viewFilter,
      },
      summary: {
        totalEvents: summary.totalEvents,
        totalActionEvents: summary.totalActionEvents,
        uniqueDevices: summary.uniqueDevices,
        views: summary.views,
        topActions: summary.topActions,
        byRole: summary.byRole,
        byTournamentType: summary.byTournamentType,
      },
      rawEvents: summary.filteredEvents,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jitter-usage-stats-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onNotify?.('Exported usage stats JSON');
  };

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    clearLocalUsageEvents();
    const baseUrl = tournamentStore.getSyncBaseUrl?.() || '';
    if (baseUrl) {
      try {
        await fetch(`${baseUrl}/__sync/analytics`, { method: 'DELETE' });
      } catch {
        // Ignore
      }
    }
    setEvents([]);
    onNotify?.('Cleared usage stats');
  };

  const maxActionCount = summary.topActions[0]?.count || 1;

  return (
    <section className="panel-card debug-tech-panel" aria-label="App Usage Analytics">
      <div className="panel-header-row">
        <div>
          <h2 className="panel-title">📊 App Usage Stats &amp; Feature Telemetry</h2>
          <p className="panel-subtitle">
            Tracks views, time spent, and clicked controls across devices — filter by Demo Mode,
            role, tournament format, or device type to guide future UI improvements.
          </p>
        </div>
        <div className="inline-actions">
          <label className="toggle-label" style={{ margin: 0, marginRight: '0.35rem' }}>
            <input
              type="checkbox"
              checked={telemetryOn}
              onChange={(e) => handleToggleTelemetry(e.target.checked)}
            />
            <span>{telemetryOn ? 'Telemetry ON' : 'Telemetry OFF'}</span>
          </label>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={loadAnalytics}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={handleExport}>
            ⬇ Export Stats JSON
          </button>
          <button
            type="button"
            className={`btn-danger-outline btn-sm ${confirmClear ? 'is-confirming' : ''}`}
            onClick={handleClear}
            onBlur={() => setConfirmClear(false)}
          >
            {confirmClear ? 'Confirm Clear?' : '🗑 Clear'}
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          alignItems: 'center',
          marginBottom: '0.75rem',
        }}
      >
        <div className="segmented-control compact">
          {[
            ['real', 'Real Only'],
            ['all', 'All'],
            ['demo', 'Demo Only'],
          ].map(([val, lbl]) => (
            <button
              key={val}
              type="button"
              className={demoFilter === val ? 'is-selected' : ''}
              onClick={() => setDemoFilter(val)}
            >
              {lbl}
            </button>
          ))}
        </div>

        <select
          className="users-role-select"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          aria-label="Filter usage stats by role"
        >
          <option value="all">All Roles</option>
          <option value="admin">🛡️ Admin</option>
          <option value="host">👑 Host</option>
          <option value="moderator">🔧 Moderator</option>
          <option value="presenter">📺 Presenter</option>
          <option value="scorekeeper">🎯 Scorekeeper</option>
          <option value="spectator">👁️ Spectator</option>
        </select>

        <select
          className="users-role-select"
          value={entryModeFilter}
          onChange={(e) => setEntryModeFilter(e.target.value)}
          aria-label="Filter usage stats by competition mode"
        >
          <option value="all">Singles &amp; Teams</option>
          <option value="singles">Singles (1v1)</option>
          <option value="teams">Teams (2v2)</option>
        </select>

        <select
          className="users-role-select"
          value={formatFilter}
          onChange={(e) => setFormatFilter(e.target.value)}
          aria-label="Filter usage stats by bracket format"
        >
          <option value="all">Single &amp; Double Elim</option>
          <option value="single">Single Elim</option>
          <option value="double">Double Elim</option>
        </select>

        <select
          className="users-role-select"
          value={deviceTypeFilter}
          onChange={(e) => setDeviceTypeFilter(e.target.value)}
          aria-label="Filter usage stats by device type"
        >
          <option value="all">All Devices</option>
          <option value="mobile">📱 Mobile</option>
          <option value="desktop">💻 Desktop / TV</option>
        </select>

        <select
          className="users-role-select"
          value={viewFilter}
          onChange={(e) => setViewFilter(e.target.value)}
          aria-label="Filter usage stats by view"
        >
          <option value="all">All Views</option>
          <option value="hub">Hub</option>
          <option value="control">Control</option>
          <option value="scorekeeper">Scorekeeper</option>
          <option value="present">Presentation</option>
          <option value="spectator">Spectator</option>
          <option value="users">Users</option>
          <option value="host">Host</option>
          <option value="admin">Admin</option>
        </select>
      </div>

      {/* Summary KPI Row */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '0.85rem',
        }}
      >
        <span className="meta-chip">Events: {summary.totalEvents}</span>
        <span className="meta-chip">Clicks/Actions: {summary.totalActionEvents}</span>
        <span className="meta-chip">Unique Devices: {summary.uniqueDevices}</span>
        {summary.views[0] && (
          <span className="meta-chip">
            Top View: {summary.views[0].view} ({summary.views[0].visits})
          </span>
        )}
        {summary.topActions[0] && (
          <span className="meta-chip">
            Top Control: {summary.topActions[0].name} ({summary.topActions[0].count})
          </span>
        )}
      </div>

      {summary.totalEvents === 0 ? (
        <p className="panel-subtitle">
          No usage events match these filters yet. Interact with the app (or switch from{' '}
          <strong>Real Only</strong> to <strong>All</strong> if you are testing in Demo Mode).
        </p>
      ) : (
        <div className="debug-tech-grid">
          {/* Left: Ranked Views */}
          <div className="debug-tech-col">
            <div className="debug-group-label" style={{ marginTop: 0 }}>
              Views Ranked by Visits &amp; Time Spent
            </div>
            <div className="debug-clients-table-wrap scroller" style={{ maxHeight: '260px' }}>
              <table className="debug-clients-table">
                <thead>
                  <tr>
                    <th scope="col">View</th>
                    <th scope="col">Visits</th>
                    <th scope="col">Time</th>
                    <th scope="col">Devices</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.views.map((v) => (
                    <tr key={v.view}>
                      <td>
                        <strong>{v.view}</strong>
                      </td>
                      <td>{v.visits}</td>
                      <td>{formatDurationShort(v.durationMs)}</td>
                      <td>{v.uniqueDevices}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {summary.byRole.length > 0 && (
              <>
                <div className="debug-group-label">Events by Role</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {summary.byRole.map((r) => (
                    <span key={r.role} className="meta-chip">
                      {r.role}: {r.count}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Right: Ranked Controls & Actions */}
          <div className="debug-tech-col">
            <div className="debug-group-label" style={{ marginTop: 0 }}>
              Most Used Controls &amp; Actions (Top 25)
            </div>
            <div className="debug-clients-table-wrap scroller" style={{ maxHeight: '320px' }}>
              <table className="debug-clients-table">
                <thead>
                  <tr>
                    <th scope="col">Control / Action</th>
                    <th scope="col">View</th>
                    <th scope="col">Clicks</th>
                    <th scope="col">Devices</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.topActions.slice(0, 25).map((a) => {
                    const pct = Math.max(4, Math.round((a.count / maxActionCount) * 100));
                    return (
                      <tr key={`${a.view}-${a.name}`}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{a.name}</div>
                          <div
                            style={{
                              height: '4px',
                              marginTop: '3px',
                              borderRadius: '2px',
                              background: 'rgba(148,163,184,0.18)',
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${pct}%`,
                                height: '100%',
                                background: 'var(--accent-amber, #f59e0b)',
                              }}
                            />
                          </div>
                        </td>
                        <td>
                          <span className="debug-client-view">{a.view}</span>
                        </td>
                        <td>
                          <strong>{a.count}</strong>
                        </td>
                        <td>{a.uniqueDevices}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
