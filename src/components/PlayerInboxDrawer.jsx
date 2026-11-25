import React, { useEffect, useMemo, useState } from 'react';
import { tournamentStore } from '../state/tournamentStore.js';
import { renderLiveMessageText } from '../engine/grandmaVariables.js';

function formatMsgTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Floating Inbox & Claim Player Drawer.
 * - Shows a compact top-right/bottom-left pill with unread message badge & claimed player status.
 * - Inbox tab stores all received messages with read/delete/clear controls.
 * - Player Claim section lets a user claim one player (with confirmation); once claimed,
 *   it is locked and only a Moderator/Host/Admin can modify or release it from the Users menu.
 */
export default function PlayerInboxDrawer({
  state,
  remoteSync,
  notifyCaps,
  onEnableDesktopAlerts,
}) {
  const [open, setOpen] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [confirmingClaim, setConfirmingClaim] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimFeedback, setClaimFeedback] = useState('');

  const myDeviceId = remoteSync?.deviceId || '';
  const inbox = Array.isArray(remoteSync?.inboxMessages) ? remoteSync.inboxMessages : [];
  const unreadCount = inbox.filter((m) => !m.read).length;
  const [inboxNowMs, setInboxNowMs] = useState(() => tournamentStore.getServerNow());
  const hasLiveInboxCountdown = open && inbox.some((m) => m.liveTemplate?.includes('[[CD:'));

  useEffect(() => {
    if (!hasLiveInboxCountdown) return undefined;
    setInboxNowMs(tournamentStore.getServerNow());
    const id = setInterval(() => setInboxNowMs(tournamentStore.getServerNow()), 250);
    return () => clearInterval(id);
  }, [hasLiveInboxCountdown]);

  const claims = state?.playerClaims || {};
  const myClaimedPlayerId = myDeviceId ? claims[myDeviceId] || null : null;
  const players = Array.isArray(state?.players) ? state.players : [];
  const claimedPlayerObj = myClaimedPlayerId
    ? players.find((p) => p.id === myClaimedPlayerId) || null
    : null;

  const claimedByOthers = useMemo(() => {
    const set = new Set();
    for (const [dev, pid] of Object.entries(claims)) {
      if (dev !== myDeviceId && pid) set.add(pid);
    }
    return set;
  }, [claims, myDeviceId]);

  const availablePlayers = useMemo(
    () => players.filter((p) => !claimedByOthers.has(p.id)),
    [players, claimedByOthers]
  );

  const selectedPlayerObj = selectedPlayerId
    ? players.find((p) => p.id === selectedPlayerId) || null
    : null;

  const handleOpen = () => {
    setOpen(true);
    setClaimFeedback('');
    setConfirmingClaim(false);
    tournamentStore.markInboxRead();
  };

  const handleConfirmClaim = async () => {
    if (!selectedPlayerId || claimBusy) return;
    setClaimBusy(true);
    setClaimFeedback('');
    try {
      const res = await tournamentStore.claimPlayer(selectedPlayerId);
      if (res.ok) {
        setConfirmingClaim(false);
        setSelectedPlayerId('');
        setClaimFeedback(`Claimed ${selectedPlayerObj?.name || 'player'}!`);
      } else {
        setClaimFeedback(res.error || 'Could not claim player');
        setConfirmingClaim(false);
      }
    } finally {
      setClaimBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`inbox-launcher-pill ${unreadCount > 0 ? 'has-unread' : ''}`}
        onClick={handleOpen}
        aria-label={`Open ${claimedPlayerObj ? `${claimedPlayerObj.name}'s Inbox` : 'Inbox and Player Claim'} (${unreadCount} unread)`}
      >
        <span>📬 {claimedPlayerObj ? claimedPlayerObj.name : 'Inbox'}</span>
        {unreadCount > 0 && <span className="inbox-unread-badge">{unreadCount}</span>}
      </button>

      {open && (
        <div
          className="inbox-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={claimedPlayerObj ? `${claimedPlayerObj.name}'s Inbox` : 'Inbox and Player Claim'}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="inbox-drawer-card">
            <div className="inbox-drawer-header">
              <h2>📬 {claimedPlayerObj ? `${claimedPlayerObj.name}'s Inbox` : 'Inbox & Player Claim'}</h2>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setOpen(false)}
                aria-label="Close Inbox"
              >
                ✕
              </button>
            </div>

            {/* Player Claim Section */}
            <section className="inbox-section" aria-label="Claim Your Player">
              <div className="inbox-section-head">
                <strong>🏓 Your Player</strong>
                {notifyCaps?.canUseDesktop && notifyCaps?.permission === 'default' && (
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    onClick={onEnableDesktopAlerts}
                  >
                    🔔 Enable Alerts
                  </button>
                )}
              </div>

              {claimedPlayerObj ? (
                <div className="inbox-claimed-locked">
                  <strong>🔒 Claimed: {claimedPlayerObj.name}</strong>
                  <p>
                    Your player claim is locked. Ask a Moderator or Host to change or release it
                    from the Users panel.
                  </p>
                </div>
              ) : confirmingClaim && selectedPlayerObj ? (
                <div className="inbox-claim-confirm">
                  <p>
                    Are you sure you want to claim <strong>{selectedPlayerObj.name}</strong>? Once
                    claimed, you cannot change it — only a Moderator or Host can modify or release
                    your claim.
                  </p>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      disabled={claimBusy}
                      onClick={handleConfirmClaim}
                    >
                      {claimBusy ? 'Claiming...' : `✓ Confirm Claim (${selectedPlayerObj.name})`}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={claimBusy}
                      onClick={() => setConfirmingClaim(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="inbox-claim-row">
                  <select
                    className="panel-select"
                    value={selectedPlayerId}
                    onChange={(e) => setSelectedPlayerId(e.target.value)}
                    aria-label="Select your player to claim"
                  >
                    <option value="">Select your player...</option>
                    {availablePlayers.map((p) => (
                      <option key={p.id} value={p.id}>
                        #{p.seed} {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    disabled={!selectedPlayerId}
                    onClick={() => setConfirmingClaim(true)}
                  >
                    Claim Player
                  </button>
                </div>
              )}

              {claimFeedback && <p className="inbox-feedback">{claimFeedback}</p>}
            </section>

            {/* Message Inbox Section */}
            <section className="inbox-section" aria-label="Message Inbox">
              <div className="inbox-section-head">
                <strong>💬 Messages ({inbox.length})</strong>
                {inbox.length > 0 && (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => tournamentStore.clearInbox()}
                  >
                    Clear All
                  </button>
                )}
              </div>

              {inbox.length === 0 ? (
                <p className="inbox-empty">
                  No messages yet. Messages from Hosts or Moderators will be saved here.
                </p>
              ) : (
                <div className="inbox-list">
                  {inbox.map((m) => (
                    <div key={m.id} className="inbox-msg-card">
                      <div className="inbox-msg-top">
                        <strong>{m.title || `Message from ${m.fromName || 'Host'}`}</strong>
                        <span className="inbox-msg-time">{formatMsgTime(m.sentAt)}</span>
                      </div>
                      <p className="inbox-msg-text">{renderLiveMessageText(m, inboxNowMs)}</p>
                      <button
                        type="button"
                        className="inbox-msg-del"
                        onClick={() => tournamentStore.deleteInboxMessage(m.id)}
                        aria-label="Delete message"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}
