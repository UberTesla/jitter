import React, { useEffect, useMemo, useState } from 'react';
import {
  ROLE_META,
  isHubAdminDevice,
  tournamentStore,
} from '../state/tournamentStore.js';
import ViewNavBar from '../components/ViewNavBar.jsx';

function formatRelativeAgo(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 10) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function formatCountdown(destroyAt, nowMs) {
  const remainingSec = Math.max(0, Math.ceil((Number(destroyAt || 0) - nowMs) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Dedicated Hub Admin Panel (/admin)
 * Accessible ONLY to Hub Admins (rank 5, strictly above Tournament Host).
 * Manages the Hub as a whole:
 *  - Hub settings & new-tournament defaults (title, public creation policy, visibility/security/approval defaults)
 *  - 4-word Hub Admin Key management & rotation + Hub Admin device roster (grant/revoke)
 *  - All Cloud Tournaments (including Private & Secure) with Open, Release Host, Cancel Destroy & Delete
 *  - All Connected Devices across the Hub with Grant/Revoke Admin & Global Disconnect
 */
export default function AdminView({
  state,
  syncMeta,
  rolePerms,
  hasActiveTournament = false,
  onNavigateMode,
  onOpenTournamentChooser,
  onEnterTournament,
}) {
  const remoteSync = syncMeta?.remoteSync || {};
  const myDeviceId = remoteSync.deviceId || '';
  const admins = Array.isArray(remoteSync.admins) ? remoteSync.admins : [];
  const hubSettings = remoteSync.hubSettings || {
    hubTitle: 'PING PONG HUB',
    allowPublicCreation: true,
    defaultIsPublic: true,
    defaultIsSecure: true,
    defaultRequireScorekeeperApproval: true,
    allowedKeyTypos: 2,
  };
  const allowedKeyTypos =
    hubSettings.allowedKeyTypos !== undefined ? Number(hubSettings.allowedKeyTypos) : 2;
  const cloudTournaments = Array.isArray(remoteSync.cloudTournaments)
    ? remoteSync.cloudTournaments
    : [];
  const allClients = Array.isArray(remoteSync.clients) ? remoteSync.clients : [];

  const [statusMsg, setStatusMsg] = useState('');
  const [hubTitleDraft, setHubTitleDraft] = useState(hubSettings.hubTitle || 'PING PONG HUB');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setHubTitleDraft(hubSettings.hubTitle || 'PING PONG HUB');
  }, [hubSettings.hubTitle]);

  useEffect(() => {
    tournamentStore.syncWithRemoteServer();
  }, []);

  const hasPendingDestructions = cloudTournaments.some((t) => Boolean(t?.destruction?.destroyAt));
  useEffect(() => {
    if (!hasPendingDestructions) return undefined;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasPendingDestructions]);

  const groupedDevices = useMemo(() => {
    const byDevice = new Map();
    for (const c of allClients) {
      const key = c.deviceId || c.tabId;
      if (!byDevice.has(key)) {
        byDevice.set(key, {
          deviceId: c.deviceId || key,
          deviceName: c.deviceName || 'Device',
          ip: c.ip || '—',
          tabs: [],
          earliestConnectedAt: c.connectedAt || 0,
        });
      }
      const grp = byDevice.get(key);
      if (c.deviceName && grp.deviceName === 'Device') grp.deviceName = c.deviceName;
      if (c.ip && grp.ip === '—') grp.ip = c.ip;
      if (c.connectedAt && (!grp.earliestConnectedAt || c.connectedAt < grp.earliestConnectedAt)) {
        grp.earliestConnectedAt = c.connectedAt;
      }
      grp.tabs.push(c);
    }
    return Array.from(byDevice.values());
  }, [allClients]);

  const privateCount = cloudTournaments.filter((t) => t.isPublic === false).length;
  const destroyingCount = cloudTournaments.filter((t) => Boolean(t?.destruction?.destroyAt)).length;
  const pendingRequestsCount =
    (Array.isArray(state?.scorekeeperRequests) ? state.scorekeeperRequests.length : 0) +
    (Array.isArray(state?.joinRequests) ? state.joinRequests.length : 0);

  const notify = (msg) => {
    setStatusMsg(`[${new Date().toLocaleTimeString()}] ${msg}`);
  };

  const handleCopyText = async (text, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      notify(`Copied ${label}: ${text}`);
    } catch {
      notify(`${label}: ${text}`);
    }
  };

  const handleSaveHubTitle = async (e) => {
    e.preventDefault();
    const res = await tournamentStore.updateHubSettings({
      hubTitle: hubTitleDraft.trim() || 'PING PONG HUB',
    });
    if (res.ok) notify(`Updated Hub title to "${res.hubSettings?.hubTitle}"`);
    else notify(res.error || 'Could not update Hub title');
  };

  const handleOpenTournament = async (t) => {
    const res = await tournamentStore.selectCloudTournament(t.id);
    if (res?.ok && res.state) {
      onEnterTournament?.(res.state.tournamentId);
    } else {
      notify(res?.error || 'Could not open tournament');
    }
  };

  return (
    <div className="debug-shell">
      <header className="control-topbar">
        <ViewNavBar
          activeMode="admin"
          rolePerms={rolePerms}
          pendingRequestsCount={pendingRequestsCount}
          showViewGroupOverride={hasActiveTournament}
          onNavigateMode={onNavigateMode}
          onOpenTournamentChooser={onOpenTournamentChooser}
        />

        <div className="brand-block is-header-right">
          <div className="brand-emblem" aria-hidden="true">
            🛡️
          </div>
          <div>
            <h1 className="brand-title">HUB ADMIN PANEL</h1>
            <div className="brand-meta">
              <span className="meta-chip">{hubSettings.hubTitle || 'PING PONG HUB'}</span>
              <span className="meta-chip">
                {ROLE_META.admin.icon} Hub Admin
              </span>
              <span className="meta-chip chip-sync">
                ● {remoteSync.connected ? 'Hub Online' : 'Offline'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {statusMsg && (
        <div className="debug-log-banner" role="status" aria-live="polite">
          {statusMsg}
        </div>
      )}

      <main className="debug-main">
        {/* 1. Hub Overview Telemetry */}
        <section className="debug-telemetry-grid" aria-label="Hub Overview">
          <div className="debug-stat-card">
            <span className="ds-label">CLOUD TOURNAMENTS</span>
            <strong className="ds-val">{cloudTournaments.length}</strong>
            <span className="ds-sub">
              {cloudTournaments.length - privateCount} public · {privateCount} private
              {destroyingCount > 0 ? ` · ${destroyingCount} destroying` : ''}
            </span>
          </div>

          <div className="debug-stat-card">
            <span className="ds-label">CONNECTED DEVICES</span>
            <strong className="ds-val">
              {groupedDevices.length} device{groupedDevices.length === 1 ? '' : 's'}
            </strong>
            <span className="ds-sub">
              {allClients.length} active session{allClients.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="debug-stat-card">
            <span className="ds-label">HUB ADMINS</span>
            <strong className="ds-val">{admins.length}</strong>
            <span className="ds-sub">
              Rank: 🛡️ Admin &gt; 👑 Host &gt; 🔧 Mod
            </span>
          </div>

          <div className="debug-stat-card">
            <span className="ds-label">CREATION POLICY</span>
            <strong className="ds-val">
              {hubSettings.allowPublicCreation ? 'Open' : 'Admins Only'}
            </strong>
            <span className="ds-sub">
              Defaults: {hubSettings.defaultIsPublic ? 'Public' : 'Private'} ·{' '}
              {hubSettings.defaultIsSecure ? 'Secure' : 'Open'} · Typos: {allowedKeyTypos}
            </span>
          </div>
        </section>

        {/* 2. Hub Settings & Defaults + Hub Admin Key Management */}
        <section className="panel-card debug-tech-panel" aria-label="Hub Settings and Admin Access">
          <div className="panel-header-row">
            <div>
              <h2 className="panel-title">⚙️ Hub Policy, Defaults &amp; Admin Key</h2>
              <p className="panel-subtitle">
                Configure Hub-wide branding, who can create live network tournaments, default
                security policies, and remote Admin access
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={async () => {
                await tournamentStore.syncWithRemoteServer();
                notify('Refreshed Hub state');
              }}
            >
              ↻ Refresh Hub
            </button>
          </div>

          <div className="debug-tech-grid">
            {/* Left Column: Hub Settings & New Tournament Defaults */}
            <div className="debug-tech-col">
              <div className="debug-group-label" style={{ marginTop: 0 }}>
                Hub Branding &amp; Creation Policy
              </div>

              <form onSubmit={handleSaveHubTitle} className="admin-inline-form">
                <div className="form-field" style={{ flex: 1 }}>
                  <label htmlFor="admin-hub-title">Hub Title</label>
                  <input
                    id="admin-hub-title"
                    type="text"
                    value={hubTitleDraft}
                    onChange={(e) => setHubTitleDraft(e.target.value)}
                    placeholder="PING PONG HUB"
                  />
                </div>
                <button type="submit" className="btn-primary btn-sm">
                  Save Title
                </button>
              </form>

              <div className="form-field" style={{ marginTop: '0.55rem' }}>
                <span className="field-label">Who Can Create Live Cloud Tournaments</span>
                <div className="segmented-control">
                  <button
                    type="button"
                    className={hubSettings.allowPublicCreation ? 'is-selected' : ''}
                    onClick={async () => {
                      const res = await tournamentStore.updateHubSettings({
                        allowPublicCreation: true,
                      });
                      if (res.ok) notify('Anyone on the network can now create live Cloud tournaments');
                      else notify(res.error || 'Could not update policy');
                    }}
                  >
                    🌐 Anyone on Network
                  </button>
                  <button
                    type="button"
                    className={!hubSettings.allowPublicCreation ? 'is-selected' : ''}
                    onClick={async () => {
                      const res = await tournamentStore.updateHubSettings({
                        allowPublicCreation: false,
                      });
                      if (res.ok) notify('Only Hub Admins can create new live Cloud tournaments');
                      else notify(res.error || 'Could not update policy');
                    }}
                  >
                    🛡️ Hub Admins Only
                  </button>
                </div>
              </div>

              <div className="form-field" style={{ marginTop: '0.55rem' }}>
                <span className="field-label">Join Key Typos Allowed (Run-On Keys Always OK)</span>
                <div className="segmented-control">
                  {[0, 1, 2, 3, 4, 5].map((count) => (
                    <button
                      key={count}
                      type="button"
                      className={allowedKeyTypos === count ? 'is-selected' : ''}
                      onClick={async () => {
                        const res = await tournamentStore.updateHubSettings({
                          allowedKeyTypos: count,
                        });
                        if (res.ok) {
                          notify(
                            count === 0
                              ? 'Tournament join keys now require exact spelling (run-on still allowed)'
                              : `Tournament join keys now forgive up to ${count} typo${
                                  count === 1 ? '' : 's'
                                } (plus run-on keys)`
                          );
                        } else {
                          notify(res.error || 'Could not update typo tolerance');
                        }
                      }}
                    >
                      {count === 0 ? '0 (Exact)' : String(count)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="debug-group-label">New Tournament Defaults</div>
              <div className="users-access-stack">
                <div className="form-field">
                  <span className="field-label">Default Visibility</span>
                  <div className="segmented-control">
                    <button
                      type="button"
                      className={hubSettings.defaultIsPublic ? 'is-selected' : ''}
                      onClick={async () => {
                        const res = await tournamentStore.updateHubSettings({
                          defaultIsPublic: true,
                        });
                        if (res.ok) notify('Default visibility set to Public');
                      }}
                    >
                      🌐 Public
                    </button>
                    <button
                      type="button"
                      className={!hubSettings.defaultIsPublic ? 'is-selected' : ''}
                      onClick={async () => {
                        const res = await tournamentStore.updateHubSettings({
                          defaultIsPublic: false,
                          defaultIsSecure: true,
                        });
                        if (res.ok) notify('Default visibility set to Private (Secure)');
                      }}
                    >
                      🕶️ Private
                    </button>
                  </div>
                </div>

                <div className="form-field">
                  <span className="field-label">Default Security</span>
                  <div className="segmented-control">
                    <button
                      type="button"
                      className={hubSettings.defaultIsSecure || !hubSettings.defaultIsPublic ? 'is-selected' : ''}
                      onClick={async () => {
                        const res = await tournamentStore.updateHubSettings({
                          defaultIsSecure: true,
                        });
                        if (res.ok) notify('Default security set to Require Key');
                      }}
                    >
                      🔒 Require Key
                    </button>
                    <button
                      type="button"
                      disabled={!hubSettings.defaultIsPublic}
                      className={!hubSettings.defaultIsSecure && hubSettings.defaultIsPublic ? 'is-selected' : ''}
                      onClick={async () => {
                        const res = await tournamentStore.updateHubSettings({
                          defaultIsSecure: false,
                        });
                        if (res.ok) notify('Default security set to Open');
                      }}
                    >
                      🔓 Open
                    </button>
                  </div>
                </div>

                <div className="form-field">
                  <span className="field-label">Default Scorekeeper Policy</span>
                  <div className="segmented-control">
                    <button
                      type="button"
                      className={hubSettings.defaultRequireScorekeeperApproval ? 'is-selected' : ''}
                      onClick={async () => {
                        const res = await tournamentStore.updateHubSettings({
                          defaultRequireScorekeeperApproval: true,
                        });
                        if (res.ok) notify('Default scorekeeper policy set to Require Approval');
                      }}
                    >
                      ✋ Require Approval
                    </button>
                    <button
                      type="button"
                      className={!hubSettings.defaultRequireScorekeeperApproval ? 'is-selected' : ''}
                      onClick={async () => {
                        const res = await tournamentStore.updateHubSettings({
                          defaultRequireScorekeeperApproval: false,
                        });
                        if (res.ok) notify('Default scorekeeper policy set to Open');
                      }}
                    >
                      🎯 Open
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Hub Admin Key & Active Hub Admins */}
            <div className="debug-tech-col">
              <div className="debug-group-label" style={{ marginTop: 0 }}>
                4-Word Hub Admin Key (Remote Device Unlock)
              </div>
              <p className="panel-subtitle" style={{ marginBottom: '0.5rem' }}>
                Enter this key in Hub → ⚙ Settings on any phone, tablet, or laptop to grant it Hub
                Admin access. Rotating the key does not revoke existing Admins.
              </p>

              <div className="inline-actions" style={{ marginBottom: '0.85rem' }}>
                {remoteSync.adminKey ? (
                  <button
                    type="button"
                    className="meta-chip meta-chip-key"
                    onClick={() => handleCopyText(remoteSync.adminKey, 'Hub Admin Key')}
                    title="Click to copy 4-word Hub Admin Key"
                  >
                    🔑 {remoteSync.adminKey}
                  </button>
                ) : (
                  <span className="meta-chip">Key unavailable</span>
                )}
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={async () => {
                    const res = await tournamentStore.rotateHubAdminKey();
                    if (res.ok) notify(`Rotated Hub Admin Key to "${res.adminKey}"`);
                    else notify(res.error || 'Could not rotate Admin Key');
                  }}
                >
                  🔄 Rotate Admin Key
                </button>
              </div>

              <div className="debug-group-label">Authorized Hub Admins ({admins.length})</div>
              <div className="users-requests-list">
                {admins.map((adm) => {
                  const isMe = adm.deviceId === myDeviceId;
                  const isOriginalServer =
                    Boolean(adm.isOriginalServerAdmin) || adm.source === 'local';
                  const sourceLabel =
                    isOriginalServer
                      ? 'Original Server'
                      : adm.source === 'key'
                        ? 'Admin Key'
                        : 'Granted';
                  return (
                    <div key={adm.deviceId} className="users-request-card">
                      <div className="urc-info">
                        <strong>
                          🛡️ {adm.deviceName || 'Hub Admin'}
                          {isMe ? ' (This Device)' : ''}
                        </strong>
                        {adm.ip && <code className="debug-mono-val">{adm.ip}</code>}
                        <span className="debug-client-tag">{sourceLabel}</span>
                      </div>
                      {isOriginalServer ? (
                        <span className="debug-mono-val">Protected</span>
                      ) : admins.length > 1 ? (
                        <button
                          type="button"
                          className="btn-danger-outline btn-sm"
                          onClick={async () => {
                            const res = await tournamentStore.setDeviceHubAdmin(
                              adm.deviceId,
                              false
                            );
                            if (res.ok) notify(`Revoked Hub Admin from ${adm.deviceName || adm.deviceId}`);
                            else notify(res.error || 'Could not revoke Admin');
                          }}
                        >
                          Revoke
                        </button>
                      ) : (
                        <span className="debug-mono-val">Primary</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* 3. All Hub Tournaments Manager (Public & Private) */}
        <section className="panel-card debug-tech-panel" aria-label="All Hub Tournaments">
          <div className="panel-header-row">
            <div>
              <h2 className="panel-title">
                🏆 All Hub Tournaments ({cloudTournaments.length})
              </h2>
              <p className="panel-subtitle">
                Full visibility into every Public &amp; Private tournament on the Hub — open without
                a key, release Host control, cancel destruction, or delete
              </p>
            </div>
          </div>

          {cloudTournaments.length === 0 ? (
            <p className="panel-subtitle">No live Cloud tournaments on this Hub yet.</p>
          ) : (
            <div className="debug-clients-table-wrap scroller">
              <table className="debug-clients-table">
                <thead>
                  <tr>
                    <th scope="col">Tournament</th>
                    <th scope="col">Access</th>
                    <th scope="col">Host</th>
                    <th scope="col">4-Word Key</th>
                    <th scope="col">Progress</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {cloudTournaments.map((t) => {
                    const joinKey = t.joinCode || t.id;
                    const isDestroying = Boolean(t.destruction?.destroyAt);
                    const isConfirmingDel = confirmDeleteId === t.id;
                    return (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.tournamentName}</strong>
                          {isDestroying && (
                            <span className="stc-tag is-danger" style={{ marginLeft: '0.45rem' }}>
                              💣 {formatCountdown(t.destruction.destroyAt, nowMs)}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="debug-client-view">
                            {t.isPublic === false ? '🕶️ Private' : '🌐 Public'} ·{' '}
                            {t.isSecure === false ? '🔓 Open' : '🔒 Secure'}
                          </span>
                        </td>
                        <td>
                          <strong>{t.hostDeviceName || 'Sync Host'}</strong>
                          {t.hostIp && (
                            <code className="debug-mono-val" style={{ marginLeft: '0.35rem' }}>
                              {t.hostIp}
                            </code>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="stc-key-chip"
                            onClick={() => handleCopyText(joinKey, '4-word key')}
                            title="Click to copy 4-word key"
                          >
                            🔑 <code>{joinKey}</code>
                          </button>
                        </td>
                        <td>
                          {t.championName
                            ? `🏆 ${t.championName}`
                            : `${t.completedMatches}/${t.totalMatches} matches`}
                        </td>
                        <td>
                          <div className="inline-actions">
                            <button
                              type="button"
                              className="btn-amber btn-sm"
                              onClick={() => handleOpenTournament(t)}
                            >
                              Open
                            </button>
                            {isDestroying && (
                              <button
                                type="button"
                                className="btn-primary btn-sm"
                                onClick={async () => {
                                  const res = await tournamentStore.claimTournamentHost(t.id);
                                  if (res.ok) notify(`Cancelled destruction of "${t.tournamentName}"`);
                                  else notify(res.error || 'Could not cancel destruction');
                                }}
                              >
                                🛡️ Cancel Destroy
                              </button>
                            )}
                            {t.hostDeviceId && !isDestroying && (
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                onClick={async () => {
                                  const res = await tournamentStore.abandonTournamentHost(t.id);
                                  if (res.ok) notify(`Released Host on "${t.tournamentName}" → Sync Host`);
                                  else notify(res.error || 'Could not release Host');
                                }}
                              >
                                🏳️ Release Host
                              </button>
                            )}
                            <button
                              type="button"
                              className={`btn-danger-outline btn-sm ${isConfirmingDel ? 'is-confirming' : ''}`}
                              onClick={async () => {
                                if (!isConfirmingDel) {
                                  setConfirmDeleteId(t.id);
                                  return;
                                }
                                setConfirmDeleteId(null);
                                const ok = await tournamentStore.deleteCloudTournament(t.id);
                                if (ok) notify(`Deleted "${t.tournamentName}"`);
                                else notify('Could not delete tournament');
                              }}
                              onBlur={() => {
                                if (isConfirmingDel) setConfirmDeleteId(null);
                              }}
                            >
                              {isConfirmingDel ? 'Confirm?' : '🗑 Delete'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 4. All Connected Devices Across the Hub */}
        <section className="panel-card debug-tech-panel" aria-label="All Connected Hub Devices">
          <div className="panel-header-row">
            <div>
              <h2 className="panel-title">
                📡 Connected Hub Devices ({groupedDevices.length} device
                {groupedDevices.length === 1 ? '' : 's'} · {allClients.length} session
                {allClients.length === 1 ? '' : 's'})
              </h2>
              <p className="panel-subtitle">
                Every device currently connected to this Hub — promote/revoke Hub Admin or kick
                globally
              </p>
            </div>
          </div>

          {groupedDevices.length === 0 ? (
            <p className="panel-subtitle">No devices connected right now.</p>
          ) : (
            <div className="debug-clients-table-wrap scroller">
              <table className="debug-clients-table">
                <thead>
                  <tr>
                    <th scope="col">Device</th>
                    <th scope="col">Sessions</th>
                    <th scope="col">IP Address</th>
                    <th scope="col">Current Location</th>
                    <th scope="col">Hub Status</th>
                    <th scope="col">Connected</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedDevices.map((grp) => {
                    const isMe = grp.deviceId === myDeviceId;
                    const devAdminRec = admins.find((a) => a && a.deviceId === grp.deviceId) || null;
                    const devIsAdmin = Boolean(devAdminRec) || isHubAdminDevice(grp.deviceId, admins);
                    const devIsOriginalServer = Boolean(
                      devAdminRec && (devAdminRec.isOriginalServerAdmin || devAdminRec.source === 'local')
                    );
                    const locations = Array.from(
                      new Set(
                        grp.tabs.map((tab) =>
                          tab.tournamentName
                            ? `${tab.tournamentName} (${tab.viewMode || 'control'})`
                            : `Hub (${tab.viewMode || 'hub'})`
                        )
                      )
                    );
                    return (
                      <tr key={grp.deviceId} className={isMe ? 'is-self-row' : ''}>
                        <td>
                          <strong>{grp.deviceName}</strong>
                          {isMe && <span className="debug-client-tag is-self">This Device</span>}
                        </td>
                        <td>
                          {grp.tabs.length === 1 ? (
                            <code className="users-tab-count-pill">
                              {grp.tabs[0]?.tabId || '1 session'}
                            </code>
                          ) : (
                            <span className="users-tab-count-pill">
                              {grp.tabs.length} sessions
                            </span>
                          )}
                        </td>
                        <td>
                          <code className="debug-mono-val">{grp.ip}</code>
                        </td>
                        <td>
                          <span className="debug-client-view">{locations.join(', ')}</span>
                        </td>
                        <td>
                          <span className={`debug-client-role ${devIsAdmin ? 'is-admin' : 'is-spectator'}`}>
                            {devIsAdmin ? '🛡️ Hub Admin' : '👤 Standard'}
                          </span>
                        </td>
                        <td>{formatRelativeAgo(grp.earliestConnectedAt)}</td>
                        <td>
                          <div className="inline-actions">
                            {!devIsAdmin ? (
                              <button
                                type="button"
                                className="btn-primary btn-sm"
                                onClick={async () => {
                                  const res = await tournamentStore.setDeviceHubAdmin(
                                    grp.deviceId,
                                    true,
                                    { deviceName: grp.deviceName, ip: grp.ip }
                                  );
                                  if (res.ok) notify(`Granted Hub Admin to ${grp.deviceName}`);
                                  else notify(res.error || 'Could not grant Admin');
                                }}
                              >
                                🛡️ Make Admin
                              </button>
                            ) : !isMe && !devIsOriginalServer && admins.length > 1 ? (
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                onClick={async () => {
                                  const res = await tournamentStore.setDeviceHubAdmin(
                                    grp.deviceId,
                                    false
                                  );
                                  if (res.ok) notify(`Revoked Hub Admin from ${grp.deviceName}`);
                                  else notify(res.error || 'Could not revoke Admin');
                                }}
                              >
                                Revoke Admin
                              </button>
                            ) : null}

                            {!isMe && !devIsAdmin && (
                              <button
                                type="button"
                                className="btn-danger-outline btn-sm"
                                onClick={async () => {
                                  const res = await tournamentStore.disconnectClient({
                                    targetDeviceId: grp.deviceId,
                                    tournamentId: null,
                                    reason: `Kicked by Hub Admin (${remoteSync.deviceName || 'Admin'})`,
                                  });
                                  if (res.ok) notify(`Kicked ${grp.deviceName}`);
                                  else notify(res.error || 'Could not kick device');
                                }}
                              >
                                ⏏ Kick
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
