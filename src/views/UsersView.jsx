import React, { useEffect, useMemo, useState } from 'react';
import {
  ROLE_META,
  canAssignRole,
  canAssignTabRole,
  canDisconnectRole,
  getAssignableRoles,
  getRolePermissions,
  resolveDeviceRole,
  resolveEffectiveRole,
  tournamentStore,
} from '../state/tournamentStore.js';
import ViewNavBar from '../components/ViewNavBar.jsx';
import GrandmaPhraseInput from '../components/GrandmaPhraseInput.jsx';
import {
  hasGrandmaVariables,
  renderLiveMessageText,
  resolveMessageTemplate,
} from '../engine/grandmaVariables.js';
import { getClaimablePlayers, resolveClaimedPlayer } from '../engine/bracketGenerator.js';

function formatRelativeAgo(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 10) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

/**
 * Dedicated Users, Roles & Requests View (/users)
 * Accessible to Host, Admin, and Moderator (or all devices while unclaimed).
 * - Pending Scorekeeper Access Requests with Approve / Deny
 * - Live Connected Users & Per-Tab Role Overrides for THIS tournament
 * - Offline / Assigned Roles management
 * (Tournament Access, Security, Visibility & Host Control live in System View.)
 */
export default function UsersView({
  state,
  syncMeta,
  onNavigateMode,
  onOpenTournamentChooser,
}) {
  const [statusMsg, setStatusMsg] = useState('');
  const [expandedDevices, setExpandedDevices] = useState({});
  const [expandedDetails, setExpandedDetails] = useState({});
  const [messageTarget, setMessageTarget] = useState(null);
  const [messageDraft, setMessageDraft] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [announcementDraft, setAnnouncementDraft] = useState('');
  const [announcementSticky, setAnnouncementSticky] = useState(false);
  const [dismissOnCountdown, setDismissOnCountdown] = useState(true);
  const [sendingAnnouncement, setSendingAnnouncement] = useState(false);
  const [tickNowMs, setTickNowMs] = useState(() => tournamentStore.getServerNow());

  const activeBannerHasCountdown = Boolean(
    state.presentation?.activeBanner?.countdownTargetAt ||
      state.presentation?.activeBanner?.liveTemplate?.includes('[[CD:')
  );
  useEffect(() => {
    if (!activeBannerHasCountdown) return undefined;
    setTickNowMs(tournamentStore.getServerNow());
    const id = setInterval(() => setTickNowMs(tournamentStore.getServerNow()), 250);
    return () => clearInterval(id);
  }, [activeBannerHasCountdown]);

  const remoteSync = syncMeta?.remoteSync || {};
  const myDeviceId = remoteSync.deviceId || '';
  const adminIds = remoteSync.admins || [];
  const currentTabId = tournamentStore.getTabId();

  const myRole = resolveEffectiveRole(state, myDeviceId, currentTabId, { adminDeviceIds: adminIds });
  const myRoleMeta = ROLE_META[myRole] || ROLE_META.spectator;
  const perms = getRolePermissions(myRole);
  const assignableRoles = useMemo(() => getAssignableRoles(myRole), [myRole]);
  const tabAssignableRoles = useMemo(
    () => assignableRoles.filter((r) => r !== 'host' && r !== 'admin'),
    [assignableRoles]
  );

  const requireScorekeeperApproval = state.rules?.requireScorekeeperApproval !== false;

  const pendingRequests = Array.isArray(state.scorekeeperRequests)
    ? state.scorekeeperRequests
    : [];
  const pendingJoinRequests = Array.isArray(state.joinRequests) ? state.joinRequests : [];
  const totalPendingRequests = pendingRequests.length + pendingJoinRequests.length;

  // Connected clients scoped strictly to THIS tournament
  const tournamentClients = useMemo(() => {
    const all = Array.isArray(remoteSync.clients) ? remoteSync.clients : [];
    return all.filter(
      (c) => Boolean(c && state.tournamentId && c.tournamentId === state.tournamentId)
    );
  }, [remoteSync.clients, state.tournamentId]);

  // Group connected tabs by user/device so multi-tab users appear cleanly under one expandable row
  const groupedDevices = useMemo(() => {
    const byDevice = new Map();
    for (const c of tournamentClients) {
      const key = c.deviceId || c.tabId;
      if (!byDevice.has(key)) {
        byDevice.set(key, {
          deviceId: c.deviceId || key,
          deviceName: c.deviceName || 'Device',
          ip: c.ip || '—',
          clientInfo: c.clientInfo || null,
          tabs: [],
          earliestConnectedAt: c.connectedAt || 0,
        });
      }
      const grp = byDevice.get(key);
      if (c.deviceName && grp.deviceName === 'Device') grp.deviceName = c.deviceName;
      if (c.ip && grp.ip === '—') grp.ip = c.ip;
      if (c.clientInfo && typeof c.clientInfo === 'object') {
        const prevKeys = grp.clientInfo ? Object.keys(grp.clientInfo).length : 0;
        const nextKeys = Object.keys(c.clientInfo).length;
        if (nextKeys >= prevKeys) {
          grp.clientInfo = { ...(grp.clientInfo || {}), ...c.clientInfo };
        }
      }
      if (c.connectedAt && (!grp.earliestConnectedAt || c.connectedAt < grp.earliestConnectedAt)) {
        grp.earliestConnectedAt = c.connectedAt;
      }
      grp.tabs.push(c);
    }
    return Array.from(byDevice.values()).map((grp) => ({
      ...grp,
      tabs: grp.tabs.sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0)),
    }));
  }, [tournamentClients]);

  const toggleDeviceExpanded = (deviceId) => {
    setExpandedDevices((prev) => ({ ...prev, [deviceId]: !prev[deviceId] }));
  };

  const toggleDeviceDetails = (deviceId) => {
    setExpandedDetails((prev) => ({ ...prev, [deviceId]: !prev[deviceId] }));
  };

  // Also show any offline/assigned role entries not currently in SSE list so Host/Admin can still demote them
  const offlineAssignedUsers = useMemo(() => {
    const connectedDeviceIds = new Set(tournamentClients.map((c) => c.deviceId));
    return Object.entries(state.userRoles || {})
      .filter(([devId]) => devId && !connectedDeviceIds.has(devId))
      .map(([deviceId, role]) => ({ deviceId, role }));
  }, [state.userRoles, tournamentClients]);

  const notify = (msg) => {
    setStatusMsg(`[${new Date().toLocaleTimeString()}] ${msg}`);
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

  return (
    <div className="debug-shell">
      <header className="control-topbar">
        <ViewNavBar
          activeMode="users"
          rolePerms={perms}
          pendingRequestsCount={totalPendingRequests}
          onNavigateMode={onNavigateMode}
          onOpenTournamentChooser={onOpenTournamentChooser}
        />

        <div className="brand-block is-header-right">
          <div className="brand-emblem" aria-hidden="true">
            👥
          </div>
          <div>
            <h1 className="brand-title">USERS &amp; ROLES</h1>
            <div className="brand-meta">
              <span className="meta-chip">{state.tournamentName}</span>
              <span className="meta-chip">
                Your Role: {myRoleMeta.icon} {myRoleMeta.label}
              </span>
              {state.joinCode && (
                <button
                  type="button"
                  className="meta-chip meta-chip-key"
                  onClick={handleCopyKey}
                  title="Click to copy current 4-word Key"
                >
                  🔑 {state.joinCode}
                </button>
              )}
              {totalPendingRequests > 0 && (
                <span className="meta-chip chip-demo">
                  🔔 {totalPendingRequests} Pending Request
                  {totalPendingRequests === 1 ? '' : 's'}
                </span>
              )}
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
        {/* Broadcast Announcement (Moderator & above) */}
        <section className="panel-card debug-tech-panel" aria-label="Broadcast Announcement">
          <div className="panel-header-row">
            <div>
              <h2 className="panel-title">📢 Make an Announcement</h2>
              <p className="panel-subtitle">
                Broadcasts to everyone &amp; replaces the Presenter titlebar. Type <code>$</code>{' '}
                for variables (e.g. <code>$time</code>, <code>$upNext</code>,{' '}
                <code>$countdown 10m</code>, <code>$countdown 1:00pm</code>).
              </p>
            </div>
            {state.presentation?.activeBanner && (
              <button
                type="button"
                className="btn-danger-outline btn-sm"
                onClick={async () => {
                  const res = await tournamentStore.sendUserMessage({ clearBanner: true });
                  notify(res.ok ? 'Cleared pinned Presenter banner' : res.error || 'Could not clear banner');
                }}
              >
                ✕ Unsticky / Clear Banner
              </button>
            )}
          </div>
          {state.presentation?.activeBanner && (
            <p className="panel-subtitle" style={{ marginTop: '0.4rem', color: '#fde68a' }}>
              📌 Active Presenter Banner: “
              {renderLiveMessageText(state.presentation.activeBanner, tickNowMs)}”
              {state.presentation.activeBanner.dismissalLabel
                ? ` (auto-dismisses at ${state.presentation.activeBanner.dismissalLabel})`
                : ' (pinned)'}
            </p>
          )}
          <form
            className="inline-actions"
            style={{ marginTop: '0.65rem', width: '100%', flexWrap: 'wrap' }}
            onSubmit={async (e) => {
              e.preventDefault();
              const text = announcementDraft.trim();
              if (!text || sendingAnnouncement) return;
              setSendingAnnouncement(true);
              let res;
              try {
                res = await tournamentStore.sendUserMessage({
                  broadcast: true,
                  kind: 'announcement',
                  sticky: announcementSticky,
                  dismissOnCountdown,
                  message: text,
                });
              } finally {
                setSendingAnnouncement(false);
              }
              if (res.ok) {
                notify(
                  `Broadcast announcement sent (${res.deliveredCount} destination${
                    res.deliveredCount === 1 ? '' : 's'
                  })`
                );
                setAnnouncementDraft('');
              } else {
                notify(res.error || 'Could not send announcement');
              }
            }}
          >
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <GrandmaPhraseInput
                value={announcementDraft}
                onChange={setAnnouncementDraft}
                placeholder="Type an announcement (type $ for variables like $time or $countdown 10m)..."
                aria-label="Broadcast announcement text"
              />
            </div>
            <label className="toggle-label" title="Keep pinned on Presenter titlebar until unstickied">
              <input
                type="checkbox"
                checked={announcementSticky}
                onChange={(e) => setAnnouncementSticky(e.target.checked)}
              />
              <span>📌 Sticky</span>
            </label>
            {Boolean(resolveMessageTemplate(announcementDraft, state).countdownTargetAt) && (
              <label className="toggle-label" title="Auto-dismiss when the $countdown finishes">
                <input
                  type="checkbox"
                  checked={dismissOnCountdown}
                  onChange={(e) => setDismissOnCountdown(e.target.checked)}
                />
                <span>⏱ Dismiss on countdown</span>
              </label>
            )}
            <button
              type="submit"
              className="btn-amber btn-sm"
              disabled={!announcementDraft.trim() || sendingAnnouncement}
            >
              {sendingAnnouncement ? 'Sending...' : '📢 Broadcast'}
            </button>
          </form>
          {hasGrandmaVariables(announcementDraft) && (() => {
            const preview = resolveMessageTemplate(announcementDraft, state);
            return (
              <div className="grandma-live-preview is-compact" role="status" aria-live="polite" style={{ marginTop: '0.45rem' }}>
                <span className="glp-text">
                  Preview: “{preview.text}”
                  {preview.countdownTargetAt && dismissOnCountdown
                    ? ` · ⏱ Auto-dismisses at ${preview.countdownLabel}`
                    : ''}
                </span>
              </div>
            );
          })()}
        </section>

        {messageTarget && (
          <div
            className="inbox-drawer-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={`Send Message to ${messageTarget.label}`}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setMessageTarget(null);
                setMessageDraft('');
              }
            }}
          >
            <div className="inbox-drawer-card">
              <div className="inbox-drawer-header">
                <h2>💬 Message {messageTarget.label}</h2>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    setMessageTarget(null);
                    setMessageDraft('');
                  }}
                  aria-label="Close message dialog"
                >
                  ✕
                </button>
              </div>
              <p className="panel-subtitle" style={{ margin: 0 }}>
                Sends an instant notification (type <code>$</code> for variables like{' '}
                <code>$time</code> or <code>$upNext</code>).
              </p>
              <form
                style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  const text = messageDraft.trim();
                  if (!text || sendingMessage) return;
                  setSendingMessage(true);
                  let res;
                  try {
                    res = await tournamentStore.sendUserMessage({
                      targetDeviceId: messageTarget.deviceId,
                      message: text,
                    });
                  } finally {
                    setSendingMessage(false);
                  }
                  if (res.ok) {
                    notify(
                      res.deliveredCount > 0
                        ? `Sent message to ${messageTarget.label} (${res.deliveredCount} session${res.deliveredCount === 1 ? '' : 's'})`
                        : `No active sessions found for ${messageTarget.label}`
                    );
                    setMessageTarget(null);
                    setMessageDraft('');
                  } else {
                    notify(res.error || 'Could not send message');
                  }
                }}
              >
                <GrandmaPhraseInput
                  value={messageDraft}
                  onChange={setMessageDraft}
                  placeholder={`Type a message for ${messageTarget.label}...`}
                  aria-label="Direct user message text"
                />
                {hasGrandmaVariables(messageDraft) && (() => {
                  const preview = resolveMessageTemplate(messageDraft, state);
                  return (
                    <div className="grandma-live-preview is-compact" role="status" aria-live="polite">
                      <span className="glp-text">Preview: “{preview.text}”</span>
                    </div>
                  );
                })()}
                <div className="inline-actions" style={{ justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setMessageTarget(null);
                      setMessageDraft('');
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn-primary btn-sm"
                    disabled={!messageDraft.trim() || sendingMessage}
                  >
                    {sendingMessage ? 'Sending...' : '📨 Send Notification'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
        {/* 1. Unified Pending Access Requests (Tournament Join + Scorekeeper) */}
        <section className="panel-card debug-tech-panel" aria-label="Access Requests">
          <div className="panel-header-row">
            <div>
              <h2 className="panel-title">🔔 Access Requests ({totalPendingRequests})</h2>
              <p className="panel-subtitle">
                Users requesting permission to join or score matches in{' '}
                <strong>{state.tournamentName}</strong>
              </p>
            </div>
          </div>

          {totalPendingRequests === 0 ? (
            <p className="panel-subtitle">
              No pending access requests right now.
              {!requireScorekeeperApproval
                ? ' (Open Scorekeeper is ON — new scorekeeper requests auto-approve unless previously demoted.)'
                : ''}
            </p>
          ) : (
            <div className="users-requests-list">
              {pendingJoinRequests.map((req) => (
                <div key={`join-${req.deviceId}`} className="users-request-card">
                  <div className="urc-info">
                    <span className="debug-client-tag">🔑 Join Access</span>
                    <strong>🙋 {req.deviceName || 'New User'}</strong>
                    {req.ip && <code className="debug-mono-val">{req.ip}</code>}
                    {req.previouslyDemoted && (
                      <span className="debug-client-tag is-demoted">Previously Demoted</span>
                    )}
                    {req.previouslyDenied && (
                      <span className="debug-client-tag is-denied">Previously Denied</span>
                    )}
                    {req.previouslyKicked && (
                      <span className="debug-client-tag is-kicked">Previously Kicked</span>
                    )}
                    <span className="urc-time">Requested {formatRelativeAgo(req.requestedAt)}</span>
                  </div>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={async () => {
                        const res = await tournamentStore.resolveTournamentJoinRequest(
                          req.deviceId,
                          true
                        );
                        if (res.ok) {
                          notify(`Approved ${req.deviceName || 'New User'} to join the tournament`);
                        } else {
                          notify(res.error || 'Could not approve join request');
                        }
                      }}
                    >
                      ✓ Approve Join
                    </button>
                    <button
                      type="button"
                      className="btn-danger-outline btn-sm"
                      onClick={async () => {
                        const res = await tournamentStore.resolveTournamentJoinRequest(
                          req.deviceId,
                          false
                        );
                        if (res.ok) {
                          notify(`Denied join request from ${req.deviceName || 'New User'}`);
                        } else {
                          notify(res.error || 'Could not deny join request');
                        }
                      }}
                    >
                      ✕ Deny
                    </button>
                  </div>
                </div>
              ))}

              {pendingRequests.map((req) => (
                <div key={`sk-${req.deviceId}`} className="users-request-card">
                  <div className="urc-info">
                    <span className="debug-client-tag">🎯 Scorekeeper</span>
                    <strong>👁️ {req.deviceName || 'Spectator Device'}</strong>
                    {req.ip && <code className="debug-mono-val">{req.ip}</code>}
                    {req.previouslyDemoted && (
                      <span className="debug-client-tag is-demoted">Previously Demoted</span>
                    )}
                    {req.previouslyDenied && (
                      <span className="debug-client-tag is-denied">Previously Denied</span>
                    )}
                    {req.previouslyKicked && (
                      <span className="debug-client-tag is-kicked">Previously Kicked</span>
                    )}
                    <span className="urc-time">Requested {formatRelativeAgo(req.requestedAt)}</span>
                  </div>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={async () => {
                        const res = await tournamentStore.resolveScorekeeperRequest(
                          req.deviceId,
                          true
                        );
                        if (res.ok) {
                          notify(`Approved ${req.deviceName || 'Spectator'} as 🎯 Scorekeeper`);
                        } else {
                          notify(res.error || 'Could not approve request');
                        }
                      }}
                    >
                      ✓ Approve Scorekeeper
                    </button>
                    <button
                      type="button"
                      className="btn-danger-outline btn-sm"
                      onClick={async () => {
                        const res = await tournamentStore.resolveScorekeeperRequest(
                          req.deviceId,
                          false
                        );
                        if (res.ok) {
                          notify(`Denied scorekeeper request from ${req.deviceName || 'Spectator'}`);
                        } else {
                          notify(res.error || 'Could not deny request');
                        }
                      }}
                    >
                      ✕ Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 3. Connected Users & Per-Tab Role Assignment (Scoped Strictly to THIS Tournament) */}
        <section className="panel-card debug-tech-panel" aria-label="Connected Users and Roles">
          <div className="panel-header-row">
            <div>
              <h2 className="panel-title">
                📡 Connected Users &amp; Roles ({groupedDevices.length} user
                {groupedDevices.length === 1 ? '' : 's'} · {tournamentClients.length} session
                {tournamentClients.length === 1 ? '' : 's'})
              </h2>
              <p className="panel-subtitle">
                <strong>Hierarchy:</strong> 🛡️ Admin &gt; 👑 Host &gt; 🔧 Moderator &gt; 📺
                Presenter &gt; 🎯 Scorekeeper &gt; 👁️ Spectator — click a multi-session user to
                expand and adjust individual session roles without changing their overall device
                role.
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={async () => {
                await tournamentStore.syncWithRemoteServer();
                notify('Refreshed connected users & roles');
              }}
            >
              ↻ Refresh
            </button>
          </div>

          {groupedDevices.length === 0 ? (
            <p className="panel-subtitle">No users currently connected to this tournament.</p>
          ) : (
            <div className="debug-clients-table-wrap scroller">
              <table className="debug-clients-table">
                <thead>
                  <tr>
                    <th scope="col">User / Device</th>
                    <th scope="col">Sessions</th>
                    <th scope="col">IP Address</th>
                    <th scope="col">View</th>
                    <th scope="col">Role</th>
                    <th scope="col">Claimed Player</th>
                    <th scope="col">Connected</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedDevices.map((group) => {
                    const isThisDev = group.deviceId === myDeviceId;
                    const tabCount = group.tabs.length;
                    const hasMultipleTabs = tabCount > 1;
                    const isExpanded = hasMultipleTabs && Boolean(expandedDevices[group.deviceId]);
                    const deviceRole = resolveDeviceRole(state, group.deviceId, {
                      adminDeviceIds: adminIds,
                    });
                    const deviceMeta = ROLE_META[deviceRole] || ROLE_META.spectator;
                    const overriddenTabsCount = group.tabs.filter(
                      (tab) => Boolean(state.tabRoles?.[tab.tabId])
                    ).length;
                    const uniqueViews = Array.from(
                      new Set(group.tabs.map((tab) => tab.viewMode || 'control'))
                    );

                    const canManageDeviceRole =
                      !isThisDev &&
                      assignableRoles.length > 0 &&
                      canAssignRole(myRole, deviceRole, assignableRoles[0]);
                    const canKickDevice =
                      !isThisDev && canDisconnectRole(myRole, deviceRole);

                    const wasDemoted =
                      Array.isArray(state.demotedScorekeepers) &&
                      state.demotedScorekeepers.includes(group.deviceId);
                    const wasDenied =
                      Array.isArray(state.deniedDevices) &&
                      state.deniedDevices.includes(group.deviceId);
                    const wasKicked =
                      Array.isArray(state.kickedDevices) &&
                      state.kickedDevices.includes(group.deviceId);
                    const claimedPid = state.playerClaims?.[group.deviceId] || null;
                    const claimedObj = claimedPid ? resolveClaimedPlayer(state, claimedPid) : null;
                    const claimedName = claimedObj?.name || null;
                    const deviceBrowser =
                      group.clientInfo?.deviceBrowser ||
                      (group.deviceName && group.deviceName !== 'Device' ? group.deviceName : '');
                    const displayName = claimedName || deviceBrowser || group.ip || 'Device';
                    const secondaryLabel = claimedName
                      ? deviceBrowser || (group.ip && group.ip !== '—' ? group.ip : '')
                      : group.deviceName &&
                        group.deviceName !== 'Device' &&
                        group.deviceName !== deviceBrowser
                      ? group.deviceName
                      : '';
                    const isDetailsOpen = Boolean(expandedDetails[group.deviceId]);

                    return (
                      <React.Fragment key={group.deviceId}>
                        <tr className={isThisDev ? 'is-self-row' : ''}>
                          <td>
                            <strong>{displayName}</strong>
                            {secondaryLabel && secondaryLabel !== displayName && (
                              <span className="debug-mono-val" style={{ marginLeft: '0.4rem' }}>
                                ({secondaryLabel})
                              </span>
                            )}
                            {isThisDev && (
                              <span className="debug-client-tag is-self">This Device</span>
                            )}
                            {!isThisDev && wasDemoted && (
                              <span className="debug-client-tag is-demoted">Previously Demoted</span>
                            )}
                            {!isThisDev && wasDenied && (
                              <span className="debug-client-tag is-denied">Previously Denied</span>
                            )}
                            {!isThisDev && wasKicked && (
                              <span className="debug-client-tag is-kicked">Previously Kicked</span>
                            )}
                          </td>
                          <td>
                            {hasMultipleTabs ? (
                              <div className="users-role-cell">
                                <button
                                  type="button"
                                  className={`users-tab-toggle-btn ${isExpanded ? 'is-open' : ''}`}
                                  onClick={() => toggleDeviceExpanded(group.deviceId)}
                                  aria-expanded={isExpanded}
                                  title="Click to expand and manage individual sessions for this user"
                                >
                                  <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                                  <span>{tabCount} sessions</span>
                                </button>
                                {overriddenTabsCount > 0 && (
                                  <span
                                    className="users-override-pill"
                                    title={`${overriddenTabsCount} session(s) have a custom role override`}
                                  >
                                    ⚡ {overriddenTabsCount} custom
                                  </span>
                                )}
                              </div>
                            ) : (
                              <code className="users-tab-count-pill">
                                {group.tabs[0]?.tabId || '1 session'}
                              </code>
                            )}
                          </td>
                          <td>
                            <code className="debug-mono-val">{group.ip}</code>
                          </td>
                          <td>
                            <span className="debug-client-view">
                              {uniqueViews.join(', ')}
                            </span>
                          </td>
                          <td>
                            {canManageDeviceRole ? (
                              <select
                                className="users-role-select"
                                value={deviceRole}
                                aria-label={`Change overall device role for ${group.deviceName}`}
                                onChange={async (e) => {
                                  const nextR = e.target.value;
                                  const res = await tournamentStore.assignUserRole(
                                    group.deviceId,
                                    nextR
                                  );
                                  if (res.ok) {
                                    notify(
                                      `Updated ${group.deviceName} to ${
                                        ROLE_META[nextR]?.label || nextR
                                      }`
                                    );
                                  } else {
                                    notify(res.error || 'Could not update device role');
                                  }
                                }}
                              >
                                {assignableRoles.map((r) => (
                                  <option key={r} value={r}>
                                    {ROLE_META[r].icon} {ROLE_META[r].label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className={`debug-client-role is-${deviceRole}`}>
                                {deviceMeta.icon} {deviceMeta.label}
                              </span>
                            )}
                          </td>
                          <td>
                            <select
                              className="users-role-select"
                              value={state.playerClaims?.[group.deviceId] || ''}
                              aria-label={`Claimed player for ${group.deviceName}`}
                              onChange={async (e) => {
                                const nextPid = e.target.value || null;
                                const res = await tournamentStore.managePlayerClaim(
                                  group.deviceId,
                                  nextPid
                                );
                                if (res.ok) {
                                  const pName = nextPid
                                    ? resolveClaimedPlayer(state, nextPid)?.name || 'player'
                                    : null;
                                  notify(
                                    pName
                                      ? `Assigned ${pName} to ${group.deviceName}`
                                      : `Released player claim for ${group.deviceName}`
                                  );
                                } else {
                                  notify(res.error || 'Could not update player claim');
                                }
                              }}
                            >
                              <option value="">— Spectating —</option>
                              {getClaimablePlayers(state).map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.teamName
                                    ? `${p.name} (${p.teamName})`
                                    : p.seed
                                    ? `#${p.seed} ${p.name}`
                                    : p.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>{formatRelativeAgo(group.earliestConnectedAt)}</td>
                          <td>
                            <div className="inline-actions">
                              <button
                                type="button"
                                className={`btn-secondary btn-sm ${isDetailsOpen ? 'is-toggled-on' : ''}`}
                                onClick={() => toggleDeviceDetails(group.deviceId)}
                                aria-expanded={isDetailsOpen}
                                title="View client browser and device environment details"
                              >
                                {isDetailsOpen ? '▾ Details' : 'ℹ Details'}
                              </button>
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                onClick={() => {
                                  setMessageTarget({
                                    deviceId: group.deviceId,
                                    label: displayName || group.ip,
                                  });
                                  setMessageDraft('');
                                }}
                              >
                                💬 Message
                              </button>
                              {canKickDevice && (
                                <button
                                  type="button"
                                  className="btn-danger-outline btn-sm"
                                  onClick={async () => {
                                    const res = await tournamentStore.disconnectClient({
                                      targetDeviceId: group.deviceId,
                                      reason: `Kicked by ${myRoleMeta.label} (${
                                        remoteSync.deviceName || myRoleMeta.label
                                      })`,
                                    });
                                    if (res.ok) {
                                      notify(
                                        `Kicked ${group.deviceName} (${group.ip})`
                                      );
                                    } else {
                                      notify(res.error || 'Could not kick user');
                                    }
                                  }}
                                >
                                  ⏏ Kick
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>

                        {isDetailsOpen && (() => {
                          const ci = group.clientInfo || {};
                          const detailItems = [
                            ['Device', ci.device || group.deviceName || '—'],
                            ['Browser', ci.browser || '—'],
                            ['OS / Platform', ci.platform || '—'],
                            ci.model ? ['Hardware Model', ci.model] : null,
                            ci.architecture ? ['Architecture', ci.architecture] : null,
                            ['Form Factor', ci.mobile ? 'Mobile' : 'Desktop / TV'],
                            ci.screen
                              ? ['Screen', `${ci.screen}${ci.dpr ? ` @ ${ci.dpr}x` : ''}`]
                              : null,
                            ci.viewport ? ['Viewport', ci.viewport] : null,
                            ci.touchPoints !== undefined
                              ? ['Touch Points', String(ci.touchPoints)]
                              : null,
                            ci.timezone ? ['Timezone', ci.timezone] : null,
                            ci.language
                              ? ['Language', ci.languages || ci.language]
                              : null,
                            ci.connection
                              ? [
                                  'Network',
                                  `${ci.connection}${
                                    ci.downlinkMbps != null ? ` (${ci.downlinkMbps} Mbps)` : ''
                                  }${ci.saveData ? ' · Save-Data' : ''}`,
                                ]
                              : null,
                            ci.cores || ci.memoryGb
                              ? [
                                  'Hardware',
                                  [
                                    ci.cores ? `${ci.cores} cores` : null,
                                    ci.memoryGb ? `${ci.memoryGb} GB RAM` : null,
                                  ]
                                    .filter(Boolean)
                                    .join(' · '),
                                ]
                              : null,
                            [
                              'Display Mode',
                              ci.standalone ? 'PWA (Standalone)' : 'Browser Tab',
                            ],
                            ci.colorScheme ? ['Color Scheme', ci.colorScheme] : null,
                            ci.hostname ? ['LAN Hostname', ci.hostname] : null,
                            ['Device Name', group.deviceName || '—'],
                            ['Device ID', group.deviceId || '—'],
                            ['IP Address', group.ip || '—'],
                          ].filter(Boolean);
                          return (
                            <tr className="users-tab-subrow users-details-subrow">
                              <td colSpan={8}>
                                <div
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))',
                                    gap: '0.45rem 0.9rem',
                                    padding: '0.5rem 0.65rem',
                                    background: 'rgba(15, 23, 42, 0.45)',
                                    borderRadius: '8px',
                                    fontSize: '0.78rem',
                                  }}
                                >
                                  {detailItems.map(([label, val]) => (
                                    <div key={label}>
                                      <div
                                        style={{
                                          fontSize: '0.66rem',
                                          textTransform: 'uppercase',
                                          letterSpacing: '0.05em',
                                          opacity: 0.65,
                                        }}
                                      >
                                        {label}
                                      </div>
                                      <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>
                                        {val}
                                      </div>
                                    </div>
                                  ))}
                                  {ci.userAgent && (
                                    <div style={{ gridColumn: '1 / -1', marginTop: '0.15rem' }}>
                                      <div
                                        style={{
                                          fontSize: '0.66rem',
                                          textTransform: 'uppercase',
                                          letterSpacing: '0.05em',
                                          opacity: 0.65,
                                        }}
                                      >
                                        User-Agent
                                      </div>
                                      <code
                                        className="debug-mono-val"
                                        style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}
                                      >
                                        {ci.userAgent}
                                      </code>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })()}

                        {isExpanded &&
                          group.tabs.map((tab, idx) => {
                            const isThisTab = tab.tabId === currentTabId;
                            const isOwnOtherTab = isThisDev && !isThisTab;
                            const tabOverride = state.tabRoles?.[tab.tabId] || null;
                            const effectiveTabRole = resolveEffectiveRole(
                              state,
                              tab.deviceId,
                              tab.tabId,
                              { adminDeviceIds: adminIds }
                            );
                            const effectiveTabMeta =
                              ROLE_META[effectiveTabRole] || ROLE_META.spectator;
                            const canManageTabRole =
                              !isThisTab &&
                              tabAssignableRoles.length > 0 &&
                              canAssignTabRole(myRole, deviceRole, tabAssignableRoles[0], {
                                isOwnOtherTab,
                              });
                            const canKickTab =
                              !isThisTab &&
                              !isThisDev &&
                              canDisconnectRole(myRole, effectiveTabRole);

                            return (
                              <tr
                                key={tab.tabId}
                                className={`users-tab-subrow ${isThisTab ? 'is-self-row' : ''}`}
                              >
                                <td>
                                  <div className="users-tab-indent">
                                    <span className="users-tab-branch" aria-hidden="true">
                                      ↳
                                    </span>
                                    <span>Session {idx + 1}</span>
                                    {isThisTab && (
                                      <span className="debug-client-tag is-self">This Session</span>
                                    )}
                                  </div>
                                </td>
                                <td>
                                  <code className="debug-mono-val">{tab.tabId}</code>
                                </td>
                                <td>
                                  <code className="debug-mono-val">{tab.ip || group.ip}</code>
                                </td>
                                <td>
                                  <span className="debug-client-view">
                                    {tab.viewMode || 'control'}
                                  </span>
                                </td>
                                <td>
                                  {canManageTabRole ? (
                                    <select
                                      className={`users-role-select ${
                                        tabOverride ? 'is-overridden' : ''
                                      }`}
                                      value={tabOverride || 'inherit'}
                                      aria-label={`Change role for Session ${idx + 1} (${tab.tabId}) on ${group.deviceName}`}
                                      onChange={async (e) => {
                                        const nextVal = e.target.value;
                                        const res = await tournamentStore.assignTabRole(
                                          tab.tabId,
                                          nextVal === 'inherit' ? null : nextVal,
                                          tab.deviceId
                                        );
                                        if (res.ok) {
                                          notify(
                                            nextVal === 'inherit'
                                              ? `${tab.tabId} on ${group.deviceName} now inherits ${deviceMeta.label}`
                                              : `Set ${tab.tabId} on ${group.deviceName} to ${
                                                  ROLE_META[nextVal]?.label || nextVal
                                                } (device stays ${deviceMeta.label})`
                                          );
                                        } else {
                                          notify(res.error || 'Could not update session role');
                                        }
                                      }}
                                    >
                                      <option value="inherit">
                                        ↩ Inherit ({deviceMeta.icon} {deviceMeta.label})
                                      </option>
                                      {tabAssignableRoles.map((r) => (
                                        <option key={r} value={r}>
                                          {ROLE_META[r].icon} {ROLE_META[r].label} (Session Only)
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span className={`debug-client-role is-${effectiveTabRole}`}>
                                      {effectiveTabMeta.icon} {effectiveTabMeta.label}
                                      {tabOverride ? ' (Session)' : ''}
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <span className="debug-mono-val">—</span>
                                </td>
                                <td>{formatRelativeAgo(tab.connectedAt)}</td>
                                <td>
                                  {canKickTab ? (
                                    <button
                                      type="button"
                                      className="btn-danger-outline btn-sm"
                                      onClick={async () => {
                                        const res = await tournamentStore.disconnectClient({
                                          targetTabId: tab.tabId,
                                          targetDeviceId: tab.deviceId,
                                          reason: `Kicked by ${myRoleMeta.label} (${
                                            remoteSync.deviceName || myRoleMeta.label
                                          })`,
                                        });
                                        if (res.ok) {
                                          notify(
                                            `Kicked session ${tab.tabId} on ${group.deviceName}`
                                          );
                                        } else {
                                          notify(res.error || 'Could not kick session');
                                        }
                                      }}
                                    >
                                      ⏏ Kick Session
                                    </button>
                                  ) : (
                                    <span className="debug-mono-val">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {offlineAssignedUsers.length > 0 && (
            <div style={{ marginTop: '0.85rem' }}>
              <div className="debug-group-label" style={{ marginTop: 0 }}>
                Assigned Roles (Currently Offline)
              </div>
              <div className="users-requests-list">
                {offlineAssignedUsers.map(({ deviceId, role }) => {
                  const canEdit = canAssignRole(myRole, role, 'spectator');
                  return (
                    <div key={deviceId} className="users-request-card">
                      <div className="urc-info">
                        <code className="debug-mono-val">{deviceId}</code>
                        <span className={`debug-client-role is-${role}`}>
                          {ROLE_META[role]?.icon} {ROLE_META[role]?.label || role}
                        </span>
                      </div>
                      {canEdit && (
                        <select
                          className="users-role-select"
                          value={role}
                          aria-label={`Change offline role for ${deviceId}`}
                          onChange={async (e) => {
                            const res = await tournamentStore.assignUserRole(
                              deviceId,
                              e.target.value
                            );
                            if (res.ok) notify(`Updated role for ${deviceId}`);
                            else notify(res.error || 'Could not update role');
                          }}
                        >
                          {assignableRoles.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_META[r].icon} {ROLE_META[r].label}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
