import React, { useEffect, useMemo, useState } from 'react';
import {
  ROLE_META,
  SLIDE_DEFINITIONS,
  STORAGE_KEY,
  STUDIO_STORAGE_KEY,
  LAST_POINT_STORAGE_KEY,
  SYNC_CHANNEL_NAME,
  getRolePermissions,
  isPreviousTournamentHost,
  resolveEffectiveRole,
  tournamentStore,
} from '../state/tournamentStore.js';
import { loadTvMediaBlob } from '../state/mediaStore.js';
import { evaluateMatchState } from '../engine/scoringEngine.js';
import { computeTournamentStats } from '../engine/bracketGenerator.js';
import ViewNavBar from '../components/ViewNavBar.jsx';
import { rankLanAddresses, resolveShareOrigin } from '../components/ShareTournamentModal.jsx';

const STRESS_TEST_PRESETS = [
  { label: '5P Single (BYEs)', playerCount: 5, format: 'single', entryMode: 'singles' },
  { label: '7P Double (BYEs)', playerCount: 7, format: 'double', entryMode: 'singles' },
  { label: '16 Teams Double', playerCount: 16, format: 'double', entryMode: 'teams' },
  { label: '64P Single', playerCount: 64, format: 'single', entryMode: 'singles' },
  { label: '128P Single', playerCount: 128, format: 'single', entryMode: 'singles' },
  { label: '256P Single', playerCount: 256, format: 'single', entryMode: 'singles' },
  { label: '256P Double', playerCount: 256, format: 'double', entryMode: 'singles' },
];

function formatCountdown(destroyAt, nowMs) {
  const remainingSec = Math.max(0, Math.ceil((Number(destroyAt || 0) - nowMs) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Dedicated System, Host Control & Diagnostics View (/system)
 * Restricted to Host & Admin (or all devices while unclaimed).
 * - Tournament Access, Security, Visibility, 4-word Key Rotation, Scorekeeper Approval & Host Control
 * - Server Network, LAN Share URLs & Technical Environment Diagnostics
 * - Demo Mode, Auto Team Names, Stress Presets, Simulator & Live State Inspector
 */
export default function SystemView({
  state,
  syncMeta,
  rolePerms = null,
  wakeLockStatus = null,
  onNavigateMode,
  onOpenTournamentChooser,
}) {
  const [showRawJson, setShowRawJson] = useState(false);
  const [logMsg, setLogMsg] = useState('');
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [serverInfo, setServerInfo] = useState(() =>
    typeof __BUILD_SERVER_INFO__ !== 'undefined' ? __BUILD_SERVER_INFO__ : null
  );
  const [mediaMeta, setMediaMeta] = useState(null);
  const [viewport, setViewport] = useState(() =>
    typeof window !== 'undefined'
      ? {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        online: navigator.onLine,
      }
      : { w: 0, h: 0, dpr: 1, online: true }
  );

  const destruction = state.destruction || null;
  useEffect(() => {
    if (!destruction?.destroyAt) return undefined;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [destruction?.destroyAt]);

  // Fetch live server IP/port/runtime details from Vite middleware (fallback to build snapshot)
  useEffect(() => {
    let active = true;
    fetch('/__server-info', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data && typeof data === 'object') {
          setServerInfo(data);
        }
      })
      .catch(() => {
        // Static hosting without dev middleware keeps build-time fallback
      });

    loadTvMediaBlob().then((record) => {
      if (!active) return;
      if (record && record.blob) {
        setMediaMeta({
          name: record.name || 'Custom Media',
          type: record.type || record.blob.type || 'unknown',
          kind: record.kind || 'media',
          bytes: record.blob.size || 0,
        });
      } else {
        setMediaMeta(null);
      }
    });

    const onEnvChange = () => {
      setViewport({
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        online: navigator.onLine,
      });
    };
    window.addEventListener('resize', onEnvChange);
    window.addEventListener('online', onEnvChange);
    window.addEventListener('offline', onEnvChange);
    return () => {
      active = false;
      window.removeEventListener('resize', onEnvChange);
      window.removeEventListener('online', onEnvChange);
      window.removeEventListener('offline', onEnvChange);
    };
  }, [state.ui?.hasCustomTvMedia, state.ui?.tvMediaLabel]);

  const activeMatch = state.matches?.[state.activeMatchId] || null;
  const evalState = evaluateMatchState(activeMatch, state.rules);
  const stats = useMemo(() => computeTournamentStats(state), [state]);
  const isStudio = syncMeta?.syncMode === 'studio';
  const remoteSync = syncMeta?.remoteSync || {};
  const myDeviceId = remoteSync.deviceId || '';
  const adminIds = remoteSync.admins || [];
  const isThisDeviceAdmin = Boolean(remoteSync.isThisDeviceAdmin);
  const currentTabId = tournamentStore.getTabId();
  const myRole = resolveEffectiveRole(state, myDeviceId, currentTabId, { adminDeviceIds: adminIds });
  const myRoleMeta = ROLE_META[myRole] || ROLE_META.spectator;
  const perms = rolePerms || getRolePermissions(myRole);

  const isHostedByMe = Boolean(state.hostDeviceId && state.hostDeviceId === myDeviceId);
  const canControlHostLifecycle = isHostedByMe || isThisDeviceAdmin;
  const isSyncHostUnclaimed = !state.hostDeviceId && !destruction;
  const canCancelDestruction = Boolean(
    destruction && (isThisDeviceAdmin || isPreviousTournamentHost(state, myDeviceId))
  );
  const isSecure = state.access?.isSecure !== false;
  const isPublic = state.access?.isPublic !== false;
  const requireScorekeeperApproval = state.rules?.requireScorekeeperApproval !== false;

  const pendingRequestsCount =
    (Array.isArray(state.scorekeeperRequests) ? state.scorekeeperRequests.length : 0) +
    (Array.isArray(state.joinRequests) ? state.joinRequests.length : 0);

  const storageBreakdown = useMemo(() => {
    try {
      const liveRaw = localStorage.getItem(STORAGE_KEY) || '';
      const studioRaw = localStorage.getItem(STUDIO_STORAGE_KEY) || '';
      const lastPointRaw = localStorage.getItem(LAST_POINT_STORAGE_KEY) || '';
      const liveBytes = new Blob([liveRaw]).size;
      const studioBytes = new Blob([studioRaw]).size;
      return {
        liveBytes,
        studioBytes,
        totalBytes: liveBytes + studioBytes,
        lastPointAt: Number(lastPointRaw) || 0,
      };
    } catch {
      return { liveBytes: 0, studioBytes: 0, totalBytes: 0, lastPointAt: 0 };
    }
  }, [state.updatedAt, syncMeta?.hasUnpublishedChanges]);
  const storageBytes = storageBreakdown.totalBytes;

  const browserCapabilities = useMemo(() => {
    if (typeof window === 'undefined') return [];
    return [
      { label: 'BroadcastChannel', supported: typeof BroadcastChannel !== 'undefined' },
      { label: 'IndexedDB', supported: typeof indexedDB !== 'undefined' },
      { label: 'ImageDecoder (GIF)', supported: 'ImageDecoder' in window },
      { label: 'View Transitions', supported: typeof document.startViewTransition === 'function' },
      { label: 'Dialog closedby', supported: 'closedBy' in HTMLDialogElement.prototype },
      { label: 'Clipboard API', supported: Boolean(navigator.clipboard?.writeText) },
      { label: 'Screen Wake Lock', supported: Boolean(navigator.wakeLock?.request) },
    ];
  }, []);

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const currentHref = typeof window !== 'undefined' ? window.location.href : '';
  const currentProtocol = typeof window !== 'undefined' ? window.location.protocol : 'http:';
  const effectivePort =
    (typeof window !== 'undefined' && window.location.port) ||
    (serverInfo?.port ? String(serverInfo.port) : '');
  const rankedLanAddresses = rankLanAddresses(serverInfo?.lanAddresses);
  const primaryLanIp = rankedLanAddresses[0]?.address || '';
  const shareBaseOrigin = resolveShareOrigin(serverInfo, remoteSync?.customServerUrl);

  const shareRoutes = [
    { label: 'Control View', url: `${shareBaseOrigin}/control` },
    { label: 'Scorekeeper (Phone/Tablet)', url: `${shareBaseOrigin}/score` },
    { label: 'Presentation (TV/Projector)', url: `${shareBaseOrigin}/present` },
    { label: 'Spectator View', url: `${shareBaseOrigin}/spectator` },
    { label: 'Users & Roles', url: `${shareBaseOrigin}/users` },
    { label: 'System View', url: `${shareBaseOrigin}/system` },
  ];

  const notify = (msg) => {
    setLogMsg(`[${new Date().toLocaleTimeString()}] ${msg}`);
  };

  const handleCopyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`Copied ${label}: ${text}`);
    } catch {
      notify(`Copy failed — select manually: ${text}`);
    }
  };

  const handleCopyKey = async () => {
    if (!state.joinCode) return;
    try {
      await navigator.clipboard.writeText(state.joinCode);
      notify(`Copied 4-word Key: ${state.joinCode}`);
    } catch {
      notify(`4-word Key: ${state.joinCode}`);
    }
  };

  const deuceScore = Math.max(0, (state.rules.targetPoints || 11) - 1);
  const winByMargin = Math.max(1, Number(state.rules.winBy ?? 2) || 2);
  const gpLoserScore = Math.max(0, state.rules.targetPoints - winByMargin);
  const deuceWinHigh = deuceScore + winByMargin + 1;
  const deuceWinLow = deuceScore + 1;

  const applyPreset = (preset) => {
    const start = performance.now();
    tournamentStore.applyFullSetup({
      playerCount: preset.playerCount,
      format: preset.format,
      entryMode: preset.entryMode,
      demoMode: state.demoMode,
      autoTeamNames: preset.entryMode === 'teams' ? state.autoTeamNames : false,
      rebuildBracket: true,
    });
    const elapsed = (performance.now() - start).toFixed(2);
    notify(`Generated ${preset.label} in ${elapsed}ms`);
  };

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(state, null, 2));
      notify('Copied full live state JSON to clipboard');
    } catch {
      notify('Clipboard unavailable — open raw JSON below to copy');
      setShowRawJson(true);
    }
  };

  const handleExportJSON = () => {
    const json = tournamentStore.exportBackupJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ping-pong-tournament-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    notify('Tournament JSON backup exported');
  };

  return (
    <div className="debug-shell">
      <header className="control-topbar">
        <ViewNavBar
          activeMode="system"
          rolePerms={perms}
          pendingRequestsCount={pendingRequestsCount}
          onNavigateMode={onNavigateMode}
          onOpenTournamentChooser={onOpenTournamentChooser}
        >
          <button type="button" className="btn-secondary btn-sm" onClick={handleExportJSON}>
            ⬇ Export JSON
          </button>
        </ViewNavBar>

        <div className="brand-block is-header-right">
          <div className="brand-emblem" aria-hidden="true">
            ⚙️
          </div>
          <div>
            <h1 className="brand-title">SYSTEM &amp; HOST CONTROL</h1>
            <div className="brand-meta">
              <span className="meta-chip">{state.tournamentName}</span>
              <span className="meta-chip">
                {myRoleMeta.icon} {myRoleMeta.label}
              </span>
              <span className="meta-chip">
                Storage: {(storageBytes / 1024).toFixed(1)} KB
              </span>
              <span className="meta-chip chip-sync">● Real-Time Sync</span>
            </div>
          </div>
        </div>
      </header>

      {logMsg && (
        <div className="debug-log-banner" role="status" aria-live="polite">
          {logMsg}
        </div>
      )}

      <main className="debug-main">
        {/* 1. Tournament Access, Security, Visibility & Host Ownership */}
        <section
          className="panel-card debug-tech-panel"
          aria-label="Tournament Access and Host Control"
        >
          <div className="panel-header-row">
            <div>
              <h2 className="panel-title">🛡️ Tournament Access, Security &amp; Host Control</h2>
              <p className="panel-subtitle">
                Manage tournament visibility, 4-word join key security, scorekeeper approval, and
                host ownership for <strong>{state.tournamentName}</strong>
              </p>
            </div>
            <div className="inline-actions">
              <span className="meta-chip">
                Host:{' '}
                <strong>
                  {isSyncHostUnclaimed
                    ? 'Sync Host (Unclaimed)'
                    : `${state.hostDeviceName || 'Host'}${isHostedByMe ? ' (This Device)' : ''}`}
                </strong>
                {state.hostIp ? ` · ${state.hostIp}` : ''}
              </span>
              {state.joinCode && (
                <>
                  <button
                    type="button"
                    className="meta-chip meta-chip-key"
                    onClick={handleCopyKey}
                    title="Click to copy current 4-word Key"
                  >
                    🔑 {state.joinCode}
                  </button>
                  {perms.canManageAccessSettings && (
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={async () => {
                        const res = await tournamentStore.rotateTournamentJoinKey();
                        if (res.ok) {
                          notify(
                            `Generated new 4-word key "${res.joinCode}" — connected clients remain online!`
                          );
                        } else {
                          notify(res.error || 'Could not generate a new key');
                        }
                      }}
                      title="Generate a fresh 4-word join key without disconnecting active clients"
                    >
                      🔄 New Key
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="debug-tech-grid">
            <div className="debug-tech-col">
              <div className="debug-group-label" style={{ marginTop: 0 }}>
                Visibility, Security &amp; Scorekeeper Policy
              </div>

              <div className="users-access-stack" style={{ marginTop: '0.45rem' }}>
                <div className="form-field">
                  <span className="field-label">Cloud Hub Visibility</span>
                  <div className="segmented-control">
                    <button
                      type="button"
                      disabled={!perms.canManageAccessSettings}
                      className={isPublic ? 'is-selected' : ''}
                      onClick={async () => {
                        const res = await tournamentStore.updateTournamentAccess({ isPublic: true });
                        if (res.ok) notify('Tournament set to PUBLIC (shown in Cloud list)');
                        else notify(res.error || 'Could not update visibility');
                      }}
                    >
                      🌐 Public
                    </button>
                    <button
                      type="button"
                      disabled={!perms.canManageAccessSettings}
                      className={!isPublic ? 'is-selected' : ''}
                      onClick={async () => {
                        const res = await tournamentStore.updateTournamentAccess({
                          isPublic: false,
                          isSecure: true,
                        });
                        if (res.ok) notify('Tournament set to PRIVATE & SECURE (joinable by 4-word key)');
                        else notify(res.error || 'Could not update visibility');
                      }}
                    >
                      🕶️ Private
                    </button>
                  </div>
                </div>

                <div className="form-field">
                  <span className="field-label">Security (Key Requirement)</span>
                  <div className="segmented-control">
                    <button
                      type="button"
                      disabled={!perms.canManageAccessSettings}
                      className={isSecure || !isPublic ? 'is-selected' : ''}
                      onClick={async () => {
                        const res = await tournamentStore.updateTournamentAccess({ isSecure: true });
                        if (res.ok) notify('Tournament set to SECURE (4-word key required)');
                        else notify(res.error || 'Could not update security');
                      }}
                    >
                      🔒 Secure
                    </button>
                    <button
                      type="button"
                      disabled={!perms.canManageAccessSettings || !isPublic}
                      className={!isSecure && isPublic ? 'is-selected' : ''}
                      title={
                        !isPublic
                          ? 'Private tournaments always require the 4-word key'
                          : undefined
                      }
                      onClick={async () => {
                        const res = await tournamentStore.updateTournamentAccess({
                          isSecure: false,
                        });
                        if (res.ok) notify('Tournament set to OPEN / UNSECURE');
                        else notify(res.error || 'Could not update security');
                      }}
                    >
                      🔓 Unsecure
                    </button>
                  </div>
                </div>
              </div>

              <div className="form-field" style={{ marginTop: '0.65rem' }}>
                <span className="field-label">Scorekeeper Approval</span>
                <div className="segmented-control">
                  <button
                    type="button"
                    disabled={!perms.canManageAccessSettings}
                    className={requireScorekeeperApproval ? 'is-selected' : ''}
                    onClick={async () => {
                      const res = await tournamentStore.updateTournamentAccess({
                        requireScorekeeperApproval: true,
                      });
                      if (res.ok) notify('Scorekeeper approval REQUIRED — guests must request access');
                      else notify(res.error || 'Could not update approval setting');
                    }}
                  >
                    ✋ Require Approval
                  </button>
                  <button
                    type="button"
                    disabled={!perms.canManageAccessSettings}
                    className={!requireScorekeeperApproval ? 'is-selected' : ''}
                    onClick={async () => {
                      const res = await tournamentStore.updateTournamentAccess({
                        requireScorekeeperApproval: false,
                      });
                      if (res.ok) notify('Open Scorekeeper ON — any guest can become scorekeeper immediately');
                      else notify(res.error || 'Could not update approval setting');
                    }}
                  >
                    🎯 Open (Anyone Can Score)
                  </button>
                </div>
              </div>
            </div>

            <div className="debug-tech-col">
              <div className="debug-group-label" style={{ marginTop: 0 }}>
                Host Ownership &amp; Tournament Lifecycle
              </div>
              <p className="panel-subtitle" style={{ marginBottom: '0.65rem' }}>
                One device owns host control of this tournament at a time. Abandoning releases it to{' '}
                <strong>Sync Host</strong> (Public &amp; Open) so another device can claim it.
                Destroying starts a 5-minute countdown that only a previous host can cancel.
              </p>

              {destruction && (
                <div className="users-destroy-alert" role="alert">
                  <div className="uda-head">
                    <strong>
                      💣 Destruction Scheduled — {formatCountdown(destruction.destroyAt, nowMs)} remaining
                    </strong>
                    <span>
                      Initiated by {destruction.initiatedByName || 'Host'}. Any previous host of
                      this tournament may claim host control within 5 minutes to cancel destruction.
                    </span>
                  </div>
                  {canCancelDestruction ? (
                    <button
                      type="button"
                      className="btn-amber btn-sm"
                      onClick={async () => {
                        const res = await tournamentStore.claimTournamentHost();
                        if (res.ok) {
                          notify(
                            `Claimed host control & cancelled destruction of "${state.tournamentName}"!`
                          );
                        } else {
                          notify(res.error || 'Could not cancel destruction');
                        }
                      }}
                    >
                      🛡️ Claim &amp; Cancel Destruction ({formatCountdown(destruction.destroyAt, nowMs)})
                    </button>
                  ) : (
                    <span className="uda-locked">
                      Only a previous host of this tournament can claim and cancel destruction.
                    </span>
                  )}
                </div>
              )}

              <div className="inline-actions">
                {isSyncHostUnclaimed && (
                  <button
                    type="button"
                    className="btn-amber btn-sm"
                    onClick={async () => {
                      const res = await tournamentStore.claimTournamentHost();
                      if (res.ok) {
                        notify(
                          `Claimed host control for "${state.tournamentName}" — security automatically set to Secure`
                        );
                      } else {
                        notify(res.error || 'Could not claim host control');
                      }
                    }}
                  >
                    👑 Claim Host Control
                  </button>
                )}

                {canControlHostLifecycle && !destruction && (
                  <>
                    <button
                      type="button"
                      className={`btn-danger-outline btn-sm ${confirmAbandon ? 'is-confirming' : ''}`}
                      onClick={async () => {
                        if (!confirmAbandon) {
                          setConfirmAbandon(true);
                          setConfirmDestroy(false);
                          return;
                        }
                        setConfirmAbandon(false);
                        const res = await tournamentStore.abandonTournamentHost();
                        if (res.ok) {
                          notify(
                            'Abandoned host control — tournament is now Public, Unsecure, and hosted by Sync Host'
                          );
                        } else {
                          notify(res.error || 'Could not abandon tournament');
                        }
                      }}
                      onBlur={() => setConfirmAbandon(false)}
                    >
                      {confirmAbandon
                        ? 'Confirm Abandon? (Public · Unsecure · Sync Host)'
                        : '🏳️ Abandon Host Control'}
                    </button>

                    <button
                      type="button"
                      className={`btn-danger-outline btn-sm ${confirmDestroy ? 'is-confirming' : ''}`}
                      onClick={async () => {
                        if (!confirmDestroy) {
                          setConfirmDestroy(true);
                          setConfirmAbandon(false);
                          return;
                        }
                        setConfirmDestroy(false);
                        const res = await tournamentStore.scheduleTournamentDestruction();
                        if (res.ok) {
                          notify(
                            '💣 Destruction timer started (5:00) — any previous host can claim to cancel!'
                          );
                        } else {
                          notify(res.error || 'Could not schedule destruction');
                        }
                      }}
                      onBlur={() => setConfirmDestroy(false)}
                    >
                      {confirmDestroy
                        ? 'Confirm Destroy? (5-Min Countdown)'
                        : '💥 Destroy Tournament'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* 2. Telemetry Summary Cards */}
        <section className="debug-telemetry-grid" aria-label="Live Engine Telemetry">
          <div className="debug-stat-card">
            <span className="ds-label">ENTRANTS / MODE</span>
            <strong className="ds-val">
              {state.playerCount} {state.entryMode === 'teams' ? 'Teams' : 'Players'}
            </strong>
            <span className="ds-sub">
              {state.format === 'double' ? 'Double Elim' : 'Single Elim'} · Demo:{' '}
              {state.demoMode ? 'ON' : 'OFF'}
            </span>
          </div>

          <div className="debug-stat-card">
            <span className="ds-label">MATCH SLOTS</span>
            <strong className="ds-val">
              {stats.completedCount} / {stats.totalMatches}
            </strong>
            <span className="ds-sub">
              {stats.byeCount} auto-BYE slots ({stats.totalSlotsIncludingByes} total)
            </span>
          </div>

          <div className="debug-stat-card">
            <span className="ds-label">ACTIVE MATCH</span>
            <strong className="ds-val">{state.activeMatchId || 'None'}</strong>
            <span className="ds-sub">
              {evalState.status} · Score {activeMatch?.score1 ?? 0}–{activeMatch?.score2 ?? 0} ·
              Server #{evalState.activeServer}
            </span>
          </div>

          <div className="debug-stat-card">
            <span className="ds-label">SYNC &amp; DEBOUNCE</span>
            <strong className="ds-val">
              {isStudio ? 'STUDIO' : 'LIVE'} · {state.rules?.scoreDebounceSec ?? 1}s
            </strong>
            <span className="ds-sub">
              Filtered taps: {state.debouncedClicks || 0} · Slide: {state.presentation?.activeSlide}
            </span>
          </div>
        </section>

        {/* 3. Server IP / URL & Technical Environment Details */}
        <section className="panel-card debug-tech-panel" aria-label="Server Network and Technical Details">
          <div className="panel-header-row">
            <div>
              <h2 className="panel-title">🌐 Server Network, URLs &amp; Technical Details</h2>
              <p className="panel-subtitle">
                Live host IP addresses, LAN share URLs for phones/TVs, storage footprint, and browser runtime capabilities
              </p>
            </div>
            {primaryLanIp && (
              <span className="meta-chip chip-sync">
                LAN IP: {primaryLanIp}
                {effectivePort ? `:${effectivePort}` : ''}
              </span>
            )}
          </div>

          <div className="debug-tech-grid">
            {/* Left Column: Server IP, Origin & Shareable Route URLs */}
            <div className="debug-tech-col">
              <div className="debug-group-label" style={{ marginTop: 0 }}>
                Server &amp; Network Identity
              </div>
              <dl className="debug-kv-list">
                <div className="debug-kv-row">
                  <dt>Current URL</dt>
                  <dd className="debug-mono-val">{currentHref || '—'}</dd>
                </div>
                <div className="debug-kv-row">
                  <dt>Origin / Host</dt>
                  <dd className="debug-mono-val">
                    {currentOrigin || '—'} ({typeof window !== 'undefined' ? window.location.hostname : '—'}
                    {effectivePort ? `:${effectivePort}` : ''})
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>Server Hostname</dt>
                  <dd className="debug-mono-val">
                    {serverInfo?.hostname || '—'} · {serverInfo?.platform || 'Browser'}
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>Runtime / Build</dt>
                  <dd className="debug-mono-val">
                    v{serverInfo?.appVersion || '1.0.0'} · {import.meta.env.MODE} · Node{' '}
                    {serverInfo?.nodeVersion || '—'}
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>LAN IPv4 Addresses</dt>
                  <dd className="debug-ip-list">
                    {rankedLanAddresses.length > 0 ? (
                      rankedLanAddresses.map((entry) => (
                        <button
                          key={`${entry.interfaceName}-${entry.address}`}
                          type="button"
                          className="debug-ip-chip"
                          onClick={() =>
                            handleCopyText(
                              `${currentProtocol}//${entry.address}${effectivePort ? `:${effectivePort}` : ''}`,
                              `${entry.interfaceName} URL`
                            )
                          }
                          title="Click to copy LAN base URL"
                        >
                          <strong>{entry.address}</strong>
                          <span>{entry.interfaceName}</span>
                        </button>
                      ))
                    ) : (
                      <span className="debug-muted">None detected (localhost only)</span>
                    )}
                  </dd>
                </div>
              </dl>

              <div className="debug-group-label">Quick LAN / Device URLs</div>
              <div className="debug-url-list">
                {shareRoutes.map((route) => (
                  <div key={route.label} className="debug-url-row">
                    <div className="debug-url-meta">
                      <span className="debug-url-lbl">{route.label}</span>
                      <code className="debug-url-code">{route.url}</code>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => handleCopyText(route.url, route.label)}
                    >
                      📋 Copy
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Right Column: Client Display, Storage, Engine & Capabilities */}
            <div className="debug-tech-col">
              <div className="debug-group-label" style={{ marginTop: 0 }}>
                Client Runtime, Storage &amp; Sync
              </div>
              <dl className="debug-kv-list">
                <div className="debug-kv-row">
                  <dt>Viewport / Screen</dt>
                  <dd className="debug-mono-val">
                    {viewport.w}×{viewport.h} (Screen{' '}
                    {typeof window !== 'undefined'
                      ? `${window.screen.width}×${window.screen.height}`
                      : '—'}
                    ) · DPR {Number(viewport.dpr).toFixed(2)}x
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>Device / Network</dt>
                  <dd className="debug-mono-val">
                    {viewport.online ? 'Online' : 'Offline'} ·{' '}
                    {typeof navigator !== 'undefined' && navigator.hardwareConcurrency
                      ? `${navigator.hardwareConcurrency} CPU threads`
                      : 'CPU N/A'}{' '}
                    ·{' '}
                    {typeof window !== 'undefined' &&
                      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
                      ? 'Reduced Motion ON'
                      : 'Full Motion'}
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>LocalStorage Usage</dt>
                  <dd className="debug-mono-val">
                    Live {(storageBreakdown.liveBytes / 1024).toFixed(2)} KB · Studio{' '}
                    {(storageBreakdown.studioBytes / 1024).toFixed(2)} KB · Schema v
                    {state.version || 5}
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>IndexedDB TV Media</dt>
                  <dd className="debug-mono-val">
                    {mediaMeta
                      ? `${mediaMeta.name} (${mediaMeta.type}, ${(mediaMeta.bytes / 1024).toFixed(1)} KB)`
                      : 'Default Built-in Sitcom Loop (0 KB)'}
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>Sync Channel &amp; Session</dt>
                  <dd className="debug-mono-val">
                    {SYNC_CHANNEL_NAME} · {tournamentStore.getTabId()}
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>Screen Keep-Alive</dt>
                  <dd className="debug-mono-val">
                    {wakeLockStatus?.mode === 'wake-lock'
                      ? 'Active (Native Wake Lock)'
                      : wakeLockStatus?.mode === 'video-fallback'
                        ? 'Active (LAN Video Keep-Alive)'
                        : wakeLockStatus?.mode === 'armed'
                          ? 'Armed (activates on tap/click)'
                          : 'Standby'}
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>Last State / Point</dt>
                  <dd className="debug-mono-val">
                    State {state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : '—'} ·
                    Point{' '}
                    {storageBreakdown.lastPointAt
                      ? new Date(storageBreakdown.lastPointAt).toLocaleTimeString()
                      : 'None'}
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>Grandma Engine</dt>
                  <dd className="debug-mono-val">
                    {state.grandma?.activeSpeech
                      ? `${state.grandma.activeSpeech.category} (#${state.grandma.activeSpeech.id})`
                      : 'Idle'}{' '}
                    · Next banter{' '}
                    {state.grandma?.nextBanterAt
                      ? new Date(state.grandma.nextBanterAt).toLocaleTimeString()
                      : '—'}
                  </dd>
                </div>
                <div className="debug-kv-row">
                  <dt>User Agent</dt>
                  <dd className="debug-mono-val debug-ua-val">
                    {typeof navigator !== 'undefined' ? navigator.userAgent : '—'}
                  </dd>
                </div>
              </dl>

              <div className="debug-group-label">Browser API Capabilities</div>
              <div className="debug-cap-badges">
                {browserCapabilities.map((cap) => (
                  <span
                    key={cap.label}
                    className={`cap-pill ${cap.supported ? 'is-supported' : 'is-unsupported'}`}
                  >
                    {cap.supported ? '✓' : '✕'} {cap.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div className="debug-panels-grid">
          {/* Panel 1: Demo Mode, Auto Team Names & Stress Presets */}
          <section className="panel-card">
            <h2 className="panel-title">🧪 Demo Mode &amp; Bracket Stress Presets</h2>
            <p className="panel-subtitle">
              Control name generation policies and benchmark brackets up to 256 entrants
            </p>

            <div className="debug-toggles-box">
              <label className="debug-switch-row">
                <div>
                  <strong>Demo Mode (Auto-Generate Player Names)</strong>
                  <span>
                    When OFF, new rosters stay neutral (Player 1, Player 2...) with no fabricated names.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(state.demoMode)}
                  onChange={(e) => {
                    tournamentStore.setDemoMode(e.target.checked);
                    notify(`Demo Mode turned ${e.target.checked ? 'ON' : 'OFF'}`);
                  }}
                />
              </label>

              <label className="debug-switch-row">
                <div>
                  <strong>Auto-Generate Team Names</strong>
                  <span>
                    When ON in Teams mode, assigns themed names (Spin Doctors, Net Ninjas...).
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(state.autoTeamNames)}
                  onChange={(e) => {
                    tournamentStore.setAutoTeamNames(e.target.checked);
                    notify(`Auto Team Names turned ${e.target.checked ? 'ON' : 'OFF'}`);
                  }}
                />
              </label>
            </div>

            <div className="debug-btn-wrap">
              {STRESS_TEST_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => applyPreset(preset)}
                >
                  ⚡ {preset.label}
                </button>
              ))}
            </div>
          </section>

          {/* Panel 2: Scoring Edge-Case & Tournament Simulator */}
          <section className="panel-card">
            <h2 className="panel-title">⚡ Match &amp; Tournament Simulator</h2>
            <p className="panel-subtitle">
              Jump directly to edge states or fast-forward brackets to test progression &amp; podiums
            </p>

            <div className="debug-group-label">Active Match Edge States</div>
            <div className="debug-btn-wrap">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  tournamentStore.setActiveMatchScoreDirect(deuceScore, deuceScore);
                  notify(`Set active match to DEUCE (${deuceScore}-${deuceScore})`);
                }}
              >
                🟣 Set Deuce ({deuceScore}–{deuceScore})
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  tournamentStore.setActiveMatchScoreDirect(deuceScore, gpLoserScore);
                  notify(`Set Game Point (${deuceScore}-${gpLoserScore})`);
                }}
              >
                🟡 Set Game Point ({deuceScore}–{gpLoserScore})
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  tournamentStore.setActiveMatchScoreDirect(deuceWinHigh, deuceWinLow);
                  notify(`Set Deuce Win (${deuceWinHigh}-${deuceWinLow})`);
                }}
              >
                🟢 Set Deuce Win ({deuceWinHigh}–{deuceWinLow})
              </button>
            </div>

            <div className="debug-group-label">Automated Bracket Progression</div>
            <div className="debug-btn-wrap">
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => {
                  tournamentStore.simulateNextMatch();
                  notify('Simulated & completed active match');
                }}
              >
                ▶ Sim 1 Match
              </button>
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => {
                  const t0 = performance.now();
                  tournamentStore.simulateCurrentRound();
                  notify(`Simulated all ready matches in ${(performance.now() - t0).toFixed(1)}ms`);
                }}
              >
                ⏩ Sim Ready Wave
              </button>
              <button
                type="button"
                className="btn-amber btn-sm"
                onClick={() => {
                  const t0 = performance.now();
                  tournamentStore.simulateTournamentToEnd();
                  notify(`Simulated full tournament to Champion in ${(performance.now() - t0).toFixed(1)}ms`);
                }}
              >
                🏆 Sim Entire Tournament
              </button>
            </div>

            <div className="debug-group-label">Reset Controls</div>
            <div className="debug-btn-wrap">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  tournamentStore.resetTournament();
                  notify('Reset all match scores (kept roster)');
                }}
              >
                ↺ Reset Scores
              </button>
              <button
                type="button"
                className="btn-danger-outline btn-sm"
                onClick={() => {
                  tournamentStore.factoryReset();
                  notify('Cleared localStorage and restored factory defaults');
                }}
              >
                💣 Factory Reset Storage
              </button>
            </div>
          </section>

          {/* Panel 3: Slide & Grandma Canvas Diagnostics */}
          <section className="panel-card">
            <h2 className="panel-title">📺 Presentation &amp; Grandma Canvas Tools</h2>
            <p className="panel-subtitle">
              Test cross-tab slide transitions, speech bubble clamping, and corner scaling
            </p>

            <div className="debug-group-label">Trigger Presentation Slide</div>
            <div className="debug-btn-wrap">
              {SLIDE_DEFINITIONS.map((sl) => (
                <button
                  key={sl.id}
                  type="button"
                  className={`btn-secondary btn-sm ${state.presentation?.activeSlide === sl.id ? 'is-toggled-on' : ''
                    }`}
                  onClick={() => {
                    tournamentStore.setActiveSlide(sl.id);
                    notify(`Switched Presentation to Slide ${sl.number}: ${sl.label}`);
                  }}
                >
                  {sl.shortLabel}
                </button>
              ))}
            </div>

            <div className="debug-group-label">Grandma Bubble &amp; Corner Tests</div>
            <div className="debug-btn-wrap">
              <button
                type="button"
                className="btn-amber btn-sm"
                onClick={() => {
                  const longQuote =
                    'Oh my stars, what an extraordinary backhand topspin rally across the entire table — this speech bubble should wrap neatly and stay strictly inside the 620x340 canvas bounds!';
                  tournamentStore.triggerLiveQuote(longQuote);
                  notify('Fired long wrapping stress-test Grandma quote');
                }}
              >
                💬 Test Long Quote Clamping
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  tournamentStore.toggleCornerScene();
                  notify('Toggled Grandma Corner visibility');
                }}
              >
                👵 Toggle Grandma
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  tournamentStore.setCornerAppearance({ cornerScale: 0.75, cornerOpacity: 0.8 });
                  notify('Set CRT Corner to 75% size / 80% opacity');
                }}
              >
                📐 Test 75% / 80% Corner
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  tournamentStore.setCornerAppearance({ cornerScale: 1.0, cornerOpacity: 1.0 });
                  notify('Restored CRT Corner to 100% / 100%');
                }}
              >
                ↺ Restore 100% Corner
              </button>
            </div>
          </section>

          {/* Panel 4: Live Scoring Engine & Raw State Inspector */}
          <section className="panel-card">
            <div className="panel-header-row">
              <div>
                <h2 className="panel-title">🔍 Live Engine &amp; State Inspector</h2>
                <p className="panel-subtitle">Real-time derived scoring state &amp; raw persisted JSON</p>
              </div>
              <div className="inline-actions">
                <button type="button" className="btn-secondary btn-sm" onClick={handleCopyJson}>
                  📋 Copy JSON
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setShowRawJson((v) => !v)}
                >
                  {showRawJson ? 'Hide Full JSON' : 'Inspect Full JSON'}
                </button>
              </div>
            </div>

            <pre className="debug-json-pre scroller">
              {JSON.stringify(
                {
                  activeMatchId: state.activeMatchId,
                  evaluation: evalState,
                  rules: state.rules,
                  flags: {
                    entryMode: state.entryMode,
                    demoMode: state.demoMode,
                    autoTeamNames: state.autoTeamNames,
                    showCornerScene: state.ui?.showCornerScene,
                    cornerScale: state.ui?.cornerScale,
                    cornerOpacity: state.ui?.cornerOpacity,
                  },
                },
                null,
                2
              )}
            </pre>

            {showRawJson && (
              <pre className="debug-json-pre is-tall scroller">
                {JSON.stringify(state, null, 2)}
              </pre>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
