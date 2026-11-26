import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ROLE_LEVEL,
  ROLE_META,
  resolveEffectiveRole,
  tournamentStore,
} from '../state/tournamentStore.js';
import { computeTournamentStats } from '../engine/bracketGenerator.js';
import { renderLiveMessageText } from '../engine/grandmaVariables.js';
import { trackUsageEvent } from '../engine/usageAnalytics.js';

function formatMsgTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function getThreadDisplayTitle(thread, myDeviceId) {
  if (!thread) return 'Chat';
  if (thread.kind === 'group') {
    return thread.name || 'Group Chat';
  }
  const otherId = (thread.memberDeviceIds || []).find((id) => id !== myDeviceId);
  return (otherId && thread.memberNames?.[otherId]) || thread.name || 'Direct Message';
}

/**
 * Floating 2-Way Chat, Group Messaging, Live Game Chat, Alerts Inbox & Claim Player Drawer.
 * - Live Chat tab: Public real-time game commentary for everyone in the tournament.
 * - Messages tab: Full 2-way 1-to-1 DMs & 1-to-many Group Chats with any connected users.
 * - Alerts & Player tab: Locked Player Claim, Desktop Alerts toggle, and Host/System Inbox.
 */
export default function PlayerInboxDrawer({
  state,
  remoteSync,
  notifyCaps,
  onEnableDesktopAlerts,
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('live'); // 'live' | 'messages' | 'alerts'

  // Player Claim state
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [confirmingClaim, setConfirmingClaim] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimFeedback, setClaimFeedback] = useState('');

  // Live Chat state
  const [liveDraft, setLiveDraft] = useState('');
  const [sendingLive, setSendingLive] = useState(false);
  const [chatNameDraft, setChatNameDraft] = useState('');
  const liveEndRef = useRef(null);

  // 2-Way DMs & Group Chats state
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [showNewChatComposer, setShowNewChatComposer] = useState(false);
  const [selectedRecipients, setSelectedRecipients] = useState([]);
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [newChatInitialMsg, setNewChatInitialMsg] = useState('');
  const [threadReplyDraft, setThreadReplyDraft] = useState('');
  const [sendingThread, setSendingThread] = useState(false);
  const [chatError, setChatError] = useState('');
  const threadEndRef = useRef(null);

  const myDeviceId = remoteSync?.deviceId || '';
  const inbox = Array.isArray(remoteSync?.inboxMessages) ? remoteSync.inboxMessages : [];
  const liveMessages = Array.isArray(remoteSync?.chatLiveMessages)
    ? remoteSync.chatLiveMessages
    : [];
  const threads = Array.isArray(remoteSync?.chatThreads) ? remoteSync.chatThreads : [];
  const unreadInbox = inbox.filter((m) => !m.read).length;
  const unreadLive = Number(remoteSync?.unreadLiveChat || 0);
  const unreadThreadMap = remoteSync?.unreadThreadCounts || {};
  const unreadThreadsTotal = Object.values(unreadThreadMap).reduce(
    (sum, n) => sum + (Number(n) || 0),
    0
  );
  const totalUnread = unreadInbox + unreadLive + unreadThreadsTotal;

  const myRole = resolveEffectiveRole(state, myDeviceId, tournamentStore.getTabId(), {
    adminDeviceIds: remoteSync?.admins || [],
  });
  const canModerateChat = (ROLE_LEVEL[myRole] ?? 0) >= ROLE_LEVEL.moderator;

  const [inboxNowMs, setInboxNowMs] = useState(() => tournamentStore.getServerNow());
  const latestAlert = inbox[0] || null;
  const hasLiveInboxCountdown =
    open &&
    (latestAlert?.liveTemplate?.includes('[[CD:') ||
      (activeTab === 'live' && liveMessages.some((m) => m.liveTemplate?.includes('[[CD:'))) ||
      (activeTab === 'alerts' && inbox.some((m) => m.liveTemplate?.includes('[[CD:'))));

  useEffect(() => {
    if (!hasLiveInboxCountdown) return undefined;
    setInboxNowMs(tournamentStore.getServerNow());
    const id = setInterval(() => setInboxNowMs(tournamentStore.getServerNow()), 250);
    return () => clearInterval(id);
  }, [hasLiveInboxCountdown]);

  // Fetch tournament chat history whenever the drawer opens or tournament changes
  useEffect(() => {
    if (state?.tournamentId && remoteSync?.connected) {
      tournamentStore.fetchTournamentChat(state.tournamentId);
    }
  }, [state?.tournamentId, remoteSync?.connected, open]);

  // Auto-mark active tab/thread as read when open
  useEffect(() => {
    if (!open) return;
    if (activeTab === 'alerts') tournamentStore.markInboxRead();
    if (activeTab === 'live') tournamentStore.markLiveChatRead();
    if (activeTab === 'messages' && activeThreadId) {
      tournamentStore.markThreadRead(activeThreadId);
    }
  }, [open, activeTab, activeThreadId, liveMessages.length, threads]);

  // Auto-scroll chat panes to bottom on new messages
  useEffect(() => {
    if (open && activeTab === 'live') {
      liveEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [open, activeTab, liveMessages.length]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) || null,
    [threads, activeThreadId]
  );

  useEffect(() => {
    if (open && activeTab === 'messages' && activeThread) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [open, activeTab, activeThread?.messages?.length, activeThreadId]);

  const claims = state?.playerClaims || {};
  const myClaimedPlayerId = myDeviceId ? claims[myDeviceId] || null : null;
  const players = Array.isArray(state?.players) ? state.players : [];
  const claimedPlayerObj = myClaimedPlayerId
    ? players.find((p) => p.id === myClaimedPlayerId) || null
    : null;
  const hasCustomChatName = Boolean(
    remoteSync?.isDeviceNameCustom && String(remoteSync?.deviceName || '').trim()
  );
  const hasChatIdentity = Boolean(claimedPlayerObj || hasCustomChatName);
  const chatHeaderName =
    claimedPlayerObj?.name || (hasCustomChatName ? remoteSync.deviceName : 'Tournament Chat');

  const upNextMatches = useMemo(() => {
    try {
      return computeTournamentStats(state)?.upNext || [];
    } catch {
      return [];
    }
  }, [state]);

  const getPlayerLabel = (pid, fallback) => {
    if (!pid) return fallback || 'TBD';
    return players.find((p) => p.id === pid)?.name || fallback || 'TBD';
  };

  const handleSaveChatName = (e) => {
    e.preventDefault();
    const cleaned = chatNameDraft.trim();
    if (!cleaned) return;
    tournamentStore.setDeviceName(cleaned);
    setChatNameDraft('');
    trackUsageEvent('chat:set_name', { category: 'chat' });
  };

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

  // Connected other users in this tournament for 1-to-1 & Group Chat recipient picking
  const connectedRecipients = useMemo(() => {
    const allClients = Array.isArray(remoteSync?.clients) ? remoteSync.clients : [];
    const byDev = new Map();
    for (const c of allClients) {
      if (!c || !c.deviceId || c.deviceId === myDeviceId) continue;
      if (state?.tournamentId && c.tournamentId && c.tournamentId !== state.tournamentId) continue;
      if (byDev.has(c.deviceId)) continue;
      const pid = claims[c.deviceId] || null;
      const pName = pid ? players.find((p) => p.id === pid)?.name || null : null;
      const devBrowser =
        c.clientInfo?.deviceBrowser || (c.deviceName && c.deviceName !== 'Device' ? c.deviceName : '');
      byDev.set(c.deviceId, {
        deviceId: c.deviceId,
        label: pName || devBrowser || c.ip || 'Player',
        sub: pName && devBrowser ? devBrowser : c.role || '',
        role: c.role || 'spectator',
      });
    }
    return Array.from(byDev.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [remoteSync?.clients, myDeviceId, state?.tournamentId, claims, players]);

  const handleOpen = () => {
    setOpen(true);
    setClaimFeedback('');
    setConfirmingClaim(false);
    setChatError('');
    trackUsageEvent('chat:open_drawer', { category: 'chat' });
    if (unreadThreadsTotal > 0) {
      setActiveTab('messages');
    } else if (unreadInbox > 0 && unreadLive === 0) {
      setActiveTab('alerts');
    } else {
      setActiveTab('live');
    }
  };

  const handleConfirmClaim = async () => {
    if (!selectedPlayerId || claimBusy) return;
    setClaimBusy(true);
    setClaimFeedback('');
    try {
      const res = await tournamentStore.claimPlayer(selectedPlayerId);
      if (res.ok) {
        trackUsageEvent('chat:claim_player', { category: 'player' });
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

  const handleSendLive = async (e) => {
    e.preventDefault();
    if (!liveDraft.trim() || sendingLive) return;
    setSendingLive(true);
    setChatError('');
    try {
      const res = await tournamentStore.sendLiveChatMessage(liveDraft);
      if (res.ok) {
        trackUsageEvent('chat:send_live', { category: 'chat' });
        setLiveDraft('');
      } else {
        setChatError(res.error || 'Could not post comment');
      }
    } finally {
      setSendingLive(false);
    }
  };

  const toggleRecipient = (devId) => {
    setSelectedRecipients((prev) =>
      prev.includes(devId) ? prev.filter((id) => id !== devId) : [...prev, devId]
    );
  };

  const handleCreateThread = async (e) => {
    e.preventDefault();
    if (selectedRecipients.length === 0 || sendingThread) return;
    setSendingThread(true);
    setChatError('');
    try {
      const res = await tournamentStore.createOrOpenChatThread({
        targetDeviceIds: selectedRecipients,
        groupName: selectedRecipients.length > 1 ? groupNameDraft.trim() : '',
        initialMessage: newChatInitialMsg.trim(),
      });
      if (res.ok && res.thread) {
        trackUsageEvent(
          res.thread.kind === 'group' ? 'chat:create_group' : 'chat:create_dm',
          { category: 'chat' }
        );
        setShowNewChatComposer(false);
        setSelectedRecipients([]);
        setGroupNameDraft('');
        setNewChatInitialMsg('');
        setActiveThreadId(res.thread.id);
      } else {
        setChatError(res.error || 'Could not create chat');
      }
    } finally {
      setSendingThread(false);
    }
  };

  const handleSendThreadReply = async (e) => {
    e.preventDefault();
    if (!activeThreadId || !threadReplyDraft.trim() || sendingThread) return;
    setSendingThread(true);
    setChatError('');
    try {
      const res = await tournamentStore.sendThreadMessage(activeThreadId, threadReplyDraft);
      if (res.ok) {
        trackUsageEvent(
          activeThread?.kind === 'group' ? 'chat:send_group' : 'chat:send_dm',
          { category: 'chat' }
        );
        setThreadReplyDraft('');
      } else {
        setChatError(res.error || 'Could not send message');
      }
    } finally {
      setSendingThread(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`inbox-launcher-pill ${totalUnread > 0 ? 'has-unread' : ''}`}
        onClick={handleOpen}
        aria-label={`Open ${claimedPlayerObj ? `${claimedPlayerObj.name}'s Chat & Inbox` : 'Chat & Inbox'} (${totalUnread} unread)`}
      >
        <span>💬 {claimedPlayerObj ? claimedPlayerObj.name : hasCustomChatName ? remoteSync.deviceName : 'Chat'}</span>
        {totalUnread > 0 && <span className="inbox-unread-badge">{totalUnread}</span>}
      </button>

      {open && (
        <div
          className="inbox-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Tournament Chat, Direct Messages & Alerts"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="inbox-drawer-card" style={{ display: 'flex', flexDirection: 'column', maxHeight: '86vh' }}>
            <div className="inbox-drawer-header">
              <h2>💬 {chatHeaderName}</h2>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setOpen(false)}
                aria-label="Close Chat Drawer"
              >
                ✕
              </button>
            </div>

            {/* 3-Tab Switcher: Live Chat | Direct & Groups | Alerts & Player */}
            <div className="segmented-control compact" style={{ marginBottom: '0.55rem' }}>
              <button
                type="button"
                className={activeTab === 'live' ? 'is-selected' : ''}
                onClick={() => {
                  setActiveTab('live');
                  setChatError('');
                }}
              >
                🗣️ Live Chat{unreadLive > 0 ? ` (${unreadLive})` : ''}
              </button>
              <button
                type="button"
                className={activeTab === 'messages' ? 'is-selected' : ''}
                onClick={() => {
                  setActiveTab('messages');
                  setChatError('');
                }}
              >
                💬 Direct/Group{unreadThreadsTotal > 0 ? ` (${unreadThreadsTotal})` : ''}
              </button>
              <button
                type="button"
                className={activeTab === 'alerts' ? 'is-selected' : ''}
                onClick={() => {
                  setActiveTab('alerts');
                  setChatError('');
                }}
              >
                📬 Alerts{unreadInbox > 0 ? ` (${unreadInbox})` : ''}
              </button>
            </div>

            {/* Mini Last-Alert Banner directly under chat type selection */}
            {latestAlert && (
              <button
                type="button"
                onClick={() => setActiveTab('alerts')}
                title="Click to view all alerts"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  width: '100%',
                  textAlign: 'left',
                  padding: '0.38rem 0.6rem',
                  marginBottom: '0.6rem',
                  borderRadius: '8px',
                  border: '1px solid rgba(245, 158, 11, 0.45)',
                  background: 'rgba(245, 158, 11, 0.14)',
                  color: 'inherit',
                  fontSize: '0.76rem',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  <strong>{latestAlert.title || '📢 Alert from Host'}:</strong>{' '}
                  {renderLiveMessageText(latestAlert, inboxNowMs)}
                </span>
                <span style={{ opacity: 0.72, fontSize: '0.7rem', flexShrink: 0 }}>
                  {formatMsgTime(latestAlert.sentAt)}
                </span>
              </button>
            )}

            {chatError && (
              <p className="inbox-feedback" style={{ margin: '0 0 0.5rem', color: '#f87171' }}>
                {chatError}
              </p>
            )}

            {/* TAB 1: PUBLIC LIVE GAME CHAT */}
            {activeTab === 'live' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: '0.5rem' }}>
                {/* Small On Deck Banner at the top of Live Chat */}
                {upNextMatches.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.45rem',
                      padding: '0.32rem 0.55rem',
                      borderRadius: '7px',
                      background: 'rgba(56, 189, 248, 0.12)',
                      border: '1px solid rgba(56, 189, 248, 0.3)',
                      fontSize: '0.75rem',
                    }}
                  >
                    <span style={{ fontWeight: 800, color: '#38bdf8', flexShrink: 0 }}>
                      ⏳ ON DECK
                    </span>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {upNextMatches
                        .slice(0, 2)
                        .map(
                          (m) =>
                            `${getPlayerLabel(m.player1Id, m.source1Label)} vs ${getPlayerLabel(
                              m.player2Id,
                              m.source2Label
                            )}`
                        )
                        .join('  ·  ')}
                    </span>
                  </div>
                )}

                <div
                  className="scroller"
                  style={{
                    flex: 1,
                    minHeight: '220px',
                    maxHeight: '46vh',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.45rem',
                    padding: '0.25rem 0.15rem',
                  }}
                >
                  {liveMessages.length === 0 ? (
                    <p className="inbox-empty">
                      No public comments yet — drop a comment on the match!
                    </p>
                  ) : (
                    liveMessages.map((m) => {
                      const isMine = m.fromDeviceId === myDeviceId;
                      const isSystemEvent = m.fromDeviceId === 'system' || Boolean(m.kind);
                      const roleMeta = ROLE_META[m.fromRole];
                      const renderedText = m.liveTemplate
                        ? renderLiveMessageText({ ...m, message: m.text }, inboxNowMs)
                        : m.text;
                      const eventBg =
                        m.kind === 'champion' || m.kind === 'win'
                          ? 'rgba(16, 185, 129, 0.16)'
                          : m.kind === 'announcement'
                          ? 'rgba(245, 158, 11, 0.18)'
                          : m.kind === 'event'
                          ? 'rgba(56, 189, 248, 0.14)'
                          : isMine
                          ? 'rgba(245, 158, 11, 0.16)'
                          : 'rgba(15, 23, 42, 0.55)';
                      const eventBorder =
                        m.kind === 'champion' || m.kind === 'win'
                          ? 'rgba(16, 185, 129, 0.45)'
                          : m.kind === 'announcement'
                          ? 'rgba(245, 158, 11, 0.5)'
                          : m.kind === 'event'
                          ? 'rgba(56, 189, 248, 0.4)'
                          : isMine
                          ? 'rgba(245, 158, 11, 0.45)'
                          : 'rgba(148, 163, 184, 0.2)';
                      return (
                        <div
                          key={m.id}
                          className="inbox-msg-card"
                          style={{
                            alignSelf: isSystemEvent ? 'stretch' : isMine ? 'flex-end' : 'flex-start',
                            maxWidth: isSystemEvent ? '100%' : '90%',
                            width: isSystemEvent ? '100%' : 'fit-content',
                            background: eventBg,
                            borderColor: eventBorder,
                          }}
                        >
                          <div className="inbox-msg-top" style={{ gap: '0.5rem' }}>
                            <strong style={{ fontSize: '0.78rem' }}>
                              {!isSystemEvent && roleMeta?.icon ? `${roleMeta.icon} ` : ''}
                              {m.fromName}
                            </strong>
                            <span className="inbox-msg-time">{formatMsgTime(m.sentAt)}</span>
                          </div>
                          <p className="inbox-msg-text" style={{ margin: '0.2rem 0 0', whiteSpace: 'pre-wrap' }}>
                            {renderedText}
                          </p>
                          {(isMine || canModerateChat) && (
                            <button
                              type="button"
                              className="inbox-msg-del"
                              onClick={() => tournamentStore.deleteLiveChatMessage(m.id)}
                              aria-label="Delete comment"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                  <div ref={liveEndRef} />
                </div>

                {!hasChatIdentity ? (
                  <form
                    onSubmit={handleSaveChatName}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.4rem',
                      padding: '0.55rem',
                      borderRadius: '8px',
                      background: 'rgba(15, 23, 42, 0.55)',
                      border: '1px solid rgba(148, 163, 184, 0.25)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.76rem' }}>
                      <strong>Set a display name to chat</strong>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
                        onClick={() => setActiveTab('alerts')}
                      >
                        Or Claim Player →
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: '0.45rem' }}>
                      <input
                        type="text"
                        value={chatNameDraft}
                        onChange={(e) => setChatNameDraft(e.target.value)}
                        placeholder="Your name (e.g. Uncle Dave)"
                        maxLength={40}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="submit"
                        className="btn-amber btn-sm"
                        disabled={!chatNameDraft.trim()}
                      >
                        Save Name
                      </button>
                    </div>
                  </form>
                ) : (
                  <form onSubmit={handleSendLive} style={{ display: 'flex', gap: '0.45rem' }}>
                    <input
                      type="text"
                      value={liveDraft}
                      onChange={(e) => setLiveDraft(e.target.value)}
                      placeholder="Comment on the live match..."
                      maxLength={500}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="submit"
                      className="btn-amber btn-sm"
                      disabled={!liveDraft.trim() || sendingLive}
                    >
                      Send
                    </button>
                  </form>
                )}
              </div>
            )}

            {/* TAB 2: 2-WAY DIRECT & GROUP CHATS */}
            {activeTab === 'messages' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: '0.55rem' }}>
                {!hasChatIdentity ? (
                  <form
                    onSubmit={handleSaveChatName}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                      padding: '0.75rem',
                      borderRadius: '8px',
                      background: 'rgba(15, 23, 42, 0.55)',
                      border: '1px solid rgba(148, 163, 184, 0.25)',
                    }}
                  >
                    <strong>Set a display name before messaging</strong>
                    <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.8 }}>
                      Enter your name so people know who is messaging them — or claim your player in
                      the Alerts tab.
                    </p>
                    <div style={{ display: 'flex', gap: '0.45rem' }}>
                      <input
                        type="text"
                        value={chatNameDraft}
                        onChange={(e) => setChatNameDraft(e.target.value)}
                        placeholder="Your name (e.g. Uncle Dave)"
                        maxLength={40}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="submit"
                        className="btn-primary btn-sm"
                        disabled={!chatNameDraft.trim()}
                      >
                        Save Name
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => setActiveTab('alerts')}
                    >
                      🏓 Claim My Player Instead →
                    </button>
                  </form>
                ) : showNewChatComposer ? (
                  <form
                    onSubmit={handleCreateThread}
                    style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}
                  >
                    <div className="inbox-section-head">
                      <strong>✉️ New Direct or Group Chat</strong>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => {
                          setShowNewChatComposer(false);
                          setSelectedRecipients([]);
                          setGroupNameDraft('');
                          setNewChatInitialMsg('');
                        }}
                      >
                        ← Back
                      </button>
                    </div>

                    {connectedRecipients.length === 0 ? (
                      <p className="inbox-empty">
                        No other connected users in this tournament right now.
                      </p>
                    ) : (
                      <>
                        <div
                          className="scroller"
                          style={{
                            maxHeight: '160px',
                            overflowY: 'auto',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.35rem',
                            padding: '0.4rem',
                            background: 'rgba(15, 23, 42, 0.45)',
                            borderRadius: '8px',
                          }}
                        >
                          {connectedRecipients.map((u) => {
                            const checked = selectedRecipients.includes(u.deviceId);
                            return (
                              <label
                                key={u.deviceId}
                                className="toggle-label"
                                style={{ margin: 0, cursor: 'pointer' }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleRecipient(u.deviceId)}
                                />
                                <span>
                                  <strong>{u.label}</strong>
                                  {u.sub ? ` (${u.sub})` : ''}
                                </span>
                              </label>
                            );
                          })}
                        </div>

                        {selectedRecipients.length > 1 && (
                          <input
                            type="text"
                            value={groupNameDraft}
                            onChange={(e) => setGroupNameDraft(e.target.value)}
                            placeholder="Group Name (optional, e.g. Table 1 Crew)"
                            maxLength={60}
                          />
                        )}

                        <input
                          type="text"
                          value={newChatInitialMsg}
                          onChange={(e) => setNewChatInitialMsg(e.target.value)}
                          placeholder="First message (optional)..."
                          maxLength={500}
                        />

                        <button
                          type="submit"
                          className="btn-primary btn-sm"
                          disabled={selectedRecipients.length === 0 || sendingThread}
                        >
                          {selectedRecipients.length > 1
                            ? `Create Group Chat (${selectedRecipients.length} selected)`
                            : 'Start 1-on-1 Chat'}
                        </button>
                      </>
                    )}
                  </form>
                ) : activeThread ? (
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: '0.5rem' }}>
                    <div className="inbox-section-head">
                      <div>
                        <strong>
                          {activeThread.kind === 'group' ? '👥 ' : '💬 '}
                          {getThreadDisplayTitle(activeThread, myDeviceId)}
                        </strong>
                        {activeThread.kind === 'group' && (
                          <div style={{ fontSize: '0.72rem', opacity: 0.7 }}>
                            {(activeThread.memberDeviceIds || [])
                              .map((id) => activeThread.memberNames?.[id] || 'Player')
                              .join(', ')}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => setActiveThreadId(null)}
                      >
                        ← Chats
                      </button>
                    </div>

                    <div
                      className="scroller"
                      style={{
                        flex: 1,
                        minHeight: '210px',
                        maxHeight: '44vh',
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.45rem',
                        padding: '0.25rem 0.15rem',
                      }}
                    >
                      {(activeThread.messages || []).length === 0 ? (
                        <p className="inbox-empty">Say hello to start the conversation!</p>
                      ) : (
                        (activeThread.messages || []).map((m) => {
                          const isMine = m.fromDeviceId === myDeviceId;
                          return (
                            <div
                              key={m.id}
                              className="inbox-msg-card"
                              style={{
                                alignSelf: isMine ? 'flex-end' : 'flex-start',
                                maxWidth: '88%',
                                width: 'fit-content',
                                background: isMine
                                  ? 'rgba(56, 189, 248, 0.16)'
                                  : 'rgba(15, 23, 42, 0.55)',
                                borderColor: isMine
                                  ? 'rgba(56, 189, 248, 0.45)'
                                  : 'rgba(148, 163, 184, 0.2)',
                              }}
                            >
                              <div className="inbox-msg-top" style={{ gap: '0.5rem' }}>
                                <strong style={{ fontSize: '0.76rem' }}>
                                  {isMine ? 'You' : m.fromName}
                                </strong>
                                <span className="inbox-msg-time">{formatMsgTime(m.sentAt)}</span>
                              </div>
                              <p className="inbox-msg-text" style={{ margin: '0.2rem 0 0', whiteSpace: 'pre-wrap' }}>
                                {m.text}
                              </p>
                            </div>
                          );
                        })
                      )}
                      <div ref={threadEndRef} />
                    </div>

                    <form onSubmit={handleSendThreadReply} style={{ display: 'flex', gap: '0.45rem' }}>
                      <input
                        type="text"
                        value={threadReplyDraft}
                        onChange={(e) => setThreadReplyDraft(e.target.value)}
                        placeholder="Type a reply..."
                        maxLength={500}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="submit"
                        className="btn-primary btn-sm"
                        disabled={!threadReplyDraft.trim() || sendingThread}
                      >
                        Send
                      </button>
                    </form>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                    <div className="inbox-section-head">
                      <strong>💬 Your Conversations ({threads.length})</strong>
                      <button
                        type="button"
                        className="btn-primary btn-sm"
                        onClick={() => {
                          setShowNewChatComposer(true);
                          setChatError('');
                        }}
                      >
                        + New Chat
                      </button>
                    </div>

                    {threads.length === 0 ? (
                      <p className="inbox-empty">
                        No direct or group chats yet. Click <strong>+ New Chat</strong> to message
                        one person or start a group chat!
                      </p>
                    ) : (
                      <div className="inbox-list scroller" style={{ maxHeight: '46vh', overflowY: 'auto' }}>
                        {threads.map((th) => {
                          const last = th.messages?.[th.messages.length - 1] || null;
                          const unread = Number(unreadThreadMap[th.id] || 0);
                          return (
                            <button
                              key={th.id}
                              type="button"
                              className="inbox-msg-card"
                              style={{
                                textAlign: 'left',
                                width: '100%',
                                cursor: 'pointer',
                                borderColor: unread > 0 ? 'rgba(245, 158, 11, 0.55)' : undefined,
                              }}
                              onClick={() => {
                                setActiveThreadId(th.id);
                                tournamentStore.markThreadRead(th.id);
                              }}
                            >
                              <div className="inbox-msg-top">
                                <strong>
                                  {th.kind === 'group' ? '👥 ' : '💬 '}
                                  {getThreadDisplayTitle(th, myDeviceId)}
                                  {unread > 0 ? ` (${unread} new)` : ''}
                                </strong>
                                <span className="inbox-msg-time">
                                  {formatMsgTime(last?.sentAt || th.updatedAt)}
                                </span>
                              </div>
                              <p className="inbox-msg-text" style={{ margin: '0.2rem 0 0', opacity: 0.8 }}>
                                {last ? `${last.fromName}: ${last.text}` : 'No messages yet'}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: ALERTS INBOX & PLAYER CLAIM */}
            {activeTab === 'alerts' && (
              <div className="scroller" style={{ overflowY: 'auto', flex: 1 }}>
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

                {/* System & Host Announcements Inbox */}
                <section className="inbox-section" aria-label="Announcements and Alerts Inbox">
                  <div className="inbox-section-head">
                    <strong>📢 Alerts &amp; Announcements ({inbox.length})</strong>
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
                      No alerts yet. Match alerts and Host announcements will appear here.
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
            )}
          </div>
        </div>
      )}
    </>
  );
}
