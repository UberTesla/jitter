import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ROLE_LEVEL,
  ROLE_META,
  resolveEffectiveRole,
  getLiveTableMatches,
  tournamentStore,
} from '../state/tournamentStore.js';
import {
  computeTournamentStats,
  formatTeamMembersShort,
  getClaimablePlayers,
  resolveClaimedPlayer,
} from '../engine/bracketGenerator.js';
import { evaluateMatchState } from '../engine/scoringEngine.js';
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
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const saved =
        typeof localStorage !== 'undefined'
          ? localStorage.getItem('pingpong-inbox-last-tab-v1')
          : null;
      return ['live', 'messages', 'ondeck', 'alerts'].includes(saved) ? saved : 'live';
    } catch {
      return 'live';
    }
  }); // 'live' | 'messages' | 'ondeck' | 'alerts'

  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('pingpong-inbox-last-tab-v1', activeTab);
      }
    } catch {
      // Ignore
    }
  }, [activeTab]);

  // Player Claim state
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [confirmingClaim, setConfirmingClaim] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimFeedback, setClaimFeedback] = useState('');

  // Live Chat state
  const [liveDraft, setLiveDraft] = useState('');
  const [sendingLive, setSendingLive] = useState(false);
  const [chatNameDraft, setChatNameDraft] = useState('');
  const [showSetNameForm, setShowSetNameForm] = useState(false);
  const [showInlineClaimPicker, setShowInlineClaimPicker] = useState(false);
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
  const [dismissedBannerIds, setDismissedBannerIds] = useState(() => {
    try {
      const raw =
        typeof sessionStorage !== 'undefined'
          ? sessionStorage.getItem('pingpong-dismissed-banners-v1')
          : null;
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });
  const dismissBanner = (id) => {
    if (!id) return;
    setDismissedBannerIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(
            'pingpong-dismissed-banners-v1',
            JSON.stringify(Array.from(next).slice(-50))
          );
        }
      } catch {
        // Ignore
      }
      return next;
    });
    trackUsageEvent('chat:dismiss_banner', { category: 'chat' });
  };
  const stickyBanner = state?.presentation?.activeBanner || null;
  const activeStickyAnnouncement =
    stickyBanner &&
    (!stickyBanner.dismissAt || Number(stickyBanner.dismissAt) > inboxNowMs)
      ? { ...stickyBanner, kind: 'announcement' }
      : null;
  const latestInboxAnnouncement =
    inbox.find((m) => m.kind === 'announcement') || null;
  const rawLatestAnnouncement = activeStickyAnnouncement || latestInboxAnnouncement || null;
  const latestAnnouncementId = rawLatestAnnouncement
    ? rawLatestAnnouncement.id || `ann-${rawLatestAnnouncement.sentAt || rawLatestAnnouncement.message}`
    : null;
  const latestAnnouncement =
    rawLatestAnnouncement && !dismissedBannerIds.has(latestAnnouncementId)
      ? rawLatestAnnouncement
      : null;
  const rawLatestAlert = inbox.find((m) => m.kind !== 'announcement') || null;
  const latestAlertId = rawLatestAlert
    ? rawLatestAlert.id || `alt-${rawLatestAlert.sentAt || rawLatestAlert.message}`
    : null;
  const latestAlert =
    rawLatestAlert && !dismissedBannerIds.has(latestAlertId) ? rawLatestAlert : null;

  const hasLiveInboxCountdown =
    open &&
    (latestAnnouncement?.liveTemplate?.includes('[[CD:') ||
      latestAlert?.liveTemplate?.includes('[[CD:') ||
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
  const claimablePlayers = useMemo(() => getClaimablePlayers(state), [state]);
  const claimedPlayerObj = useMemo(
    () => (myClaimedPlayerId ? resolveClaimedPlayer(state, myClaimedPlayerId) : null),
    [state, myClaimedPlayerId]
  );
  const claimedEntrantId = claimedPlayerObj?.teamId || null;
  const hasCustomChatName = Boolean(
    remoteSync?.isDeviceNameCustom && String(remoteSync?.deviceName || '').trim()
  );
  const hasChatIdentity = Boolean(claimedPlayerObj || hasCustomChatName);
  const chatHeaderName =
    claimedPlayerObj?.name || (hasCustomChatName ? remoteSync.deviceName : 'Tournament Chat');

  const tourneyStats = useMemo(() => {
    try {
      return computeTournamentStats(state);
    } catch {
      return { upNext: [], recentCompleted: [], completedCount: 0, totalMatches: 0 };
    }
  }, [state]);
  const upNextMatches = tourneyStats?.upNext || [];

  const miniScoreboardMatches = useMemo(() => {
    const liveList = getLiveTableMatches(state);
    if (liveList.length > 0) return liveList;
    const fallbackAm = state?.activeMatchId ? state.matches?.[state.activeMatchId] : null;
    return fallbackAm && !fallbackAm.isBye ? [fallbackAm] : [];
  }, [state]);
  const [miniTableIdx, setMiniTableIdx] = useState(0);
  const [miniTableHeld, setMiniTableHeld] = useState(false);
  const [miniRotateTick, setMiniRotateTick] = useState(0);
  const miniInitClaimRef = useRef(false);

  // Start on the claimed player's live table when the drawer opens
  useEffect(() => {
    if (!open) {
      miniInitClaimRef.current = false;
      return;
    }
    if (miniInitClaimRef.current || !claimedEntrantId || miniScoreboardMatches.length <= 1) return;
    const myIdx = miniScoreboardMatches.findIndex(
      (m) => m.player1Id === claimedEntrantId || m.player2Id === claimedEntrantId
    );
    if (myIdx >= 0) {
      setMiniTableIdx(myIdx);
      miniInitClaimRef.current = true;
    }
  }, [open, claimedEntrantId, miniScoreboardMatches]);

  // Auto-rotate mini scoreboard across live tables every 5s unless held
  useEffect(() => {
    const count = miniScoreboardMatches.length;
    if (count <= 1) {
      setMiniTableIdx(0);
      return undefined;
    }
    setMiniTableIdx((prev) => prev % count);
    if (!open || miniTableHeld) return undefined;
    const timer = setInterval(() => {
      setMiniTableIdx((prev) => (prev + 1) % count);
    }, 5000);
    return () => clearInterval(timer);
  }, [open, miniTableHeld, miniScoreboardMatches.length, miniRotateTick]);

  const myPlayerStatus = useMemo(() => {
    if (!claimedPlayerObj || !state?.matches) return null;
    const pid = claimedEntrantId;
    if (!pid) {
      return {
        tone: 'waiting',
        tabLabel: 'Unassigned',
        headline: '🗓️ NOT ASSIGNED TO A TEAM YET',
        detail: `${claimedPlayerObj.name} is on the roster — ask the Host to assign your team.`,
      };
    }
    const allMatches = Object.values(state.matches || {});
    if (state.championId && state.championId === pid) {
      return {
        tone: 'champion',
        tabLabel: 'Champ!',
        headline: '🏆 TOURNAMENT CHAMPION!',
        detail: `Congrats ${claimedPlayerObj.name} — you won the tournament!`,
      };
    }
    const playingNow = allMatches.find(
      (m) =>
        m &&
        !m.isBye &&
        !m.completed &&
        m.started &&
        (m.player1Id === pid || m.player2Id === pid)
    );
    if (playingNow) {
      const oppId = playingNow.player1Id === pid ? playingNow.player2Id : playingNow.player1Id;
      const oppName = players.find((p) => p.id === oppId)?.name || 'Opponent';
      return {
        tone: 'playing',
        tabLabel: "You're Up",
        headline: '🏓 YOU ARE UP NOW!',
        detail: `${playingNow.roundLabel} (${playingNow.label}) vs ${oppName}${
          playingNow.tableNumber ? ` · Table ${playingNow.tableNumber}` : ''
        }`,
      };
    }
    const activeReady =
      state?.activeMatchId && state.matches?.[state.activeMatchId]
        ? state.matches[state.activeMatchId]
        : null;
    if (
      activeReady &&
      !activeReady.isBye &&
      !activeReady.completed &&
      (activeReady.player1Id === pid || activeReady.player2Id === pid)
    ) {
      const oppId = activeReady.player1Id === pid ? activeReady.player2Id : activeReady.player1Id;
      const oppFallback =
        activeReady.player1Id === pid ? activeReady.source2Label : activeReady.source1Label;
      const oppName =
        (oppId ? players.find((p) => p.id === oppId)?.name : null) || oppFallback || 'TBD';
      return {
        tone: 'playing',
        tabLabel: "You're Up",
        headline: '🏓 YOU ARE UP NOW! (READY)',
        detail: `Head to the table — ${activeReady.roundLabel} (${activeReady.label}) vs ${oppName}${
          activeReady.tableNumber ? ` · Table ${activeReady.tableNumber}` : ''
        }`,
      };
    }
    const queueIdx = upNextMatches.findIndex(
      (m) => m && (m.player1Id === pid || m.player2Id === pid)
    );
    if (queueIdx !== -1) {
      const m = upNextMatches[queueIdx];
      const oppId = m.player1Id === pid ? m.player2Id : m.player1Id;
      const oppFallback = m.player1Id === pid ? m.source2Label : m.source1Label;
      const oppName =
        (oppId ? players.find((p) => p.id === oppId)?.name : null) || oppFallback || 'TBD';
      return {
        tone: 'ondeck',
        tabLabel: queueIdx === 0 ? 'Up Next' : `#${queueIdx + 1} in Queue`,
        headline: queueIdx === 0 ? '⏳ YOU ARE UP NEXT!' : `⏳ YOU ARE #${queueIdx + 1} IN QUEUE`,
        detail: `${m.roundLabel} (${m.label}) vs ${oppName}`,
      };
    }
    const futureMatch = allMatches.find(
      (m) =>
        m &&
        !m.isBye &&
        !m.completed &&
        (m.player1Id === pid || m.player2Id === pid)
    );
    if (futureMatch) {
      return {
        tone: 'waiting',
        tabLabel: 'Waiting',
        headline: '🗓️ WAITING FOR NEXT ROUND',
        detail: `${futureMatch.roundLabel} (${futureMatch.label}) — opponent TBD`,
      };
    }
    return {
      tone: 'done',
      tabLabel: 'Done',
      headline: '✅ TOURNAMENT RUN COMPLETE',
      detail: 'Thanks for playing — cheer on the remaining matches in Live Chat!',
    };
  }, [claimedPlayerObj, claimedEntrantId, state?.matches, state?.activeMatchId, state?.championId, upNextMatches, players]);

  const isTeams = state?.entryMode === 'teams';
  const getPlayerLabel = (pid, fallback) => {
    if (!pid) return fallback || 'TBD';
    return players.find((p) => p.id === pid)?.name || fallback || 'TBD';
  };
  const getTeamMembersLine = (pid) => {
    if (!isTeams || !pid) return '';
    const p = players.find((pl) => pl.id === pid);
    return p ? formatTeamMembersShort(p, ' & ') : '';
  };
  const renderDrawerOnDeckSide = (pid, fallback, align = 'left') => {
    const label = getPlayerLabel(pid, fallback);
    const members = getTeamMembersLine(pid);
    if (!isTeams) return <span>{label}</span>;
    const isRight = align === 'right';
    return (
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: '0 1 auto',
          minWidth: 0,
          lineHeight: 1.2,
          alignItems: isRight ? 'flex-end' : 'flex-start',
          textAlign: isRight ? 'right' : 'left',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '100%',
          }}
        >
          {label}
        </span>
        {members && (
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 500,
              opacity: 0.72,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
            }}
          >
            {members}
          </span>
        )}
      </span>
    );
  };

  const handleSaveChatName = (e) => {
    e.preventDefault();
    const cleaned = chatNameDraft.trim();
    if (!cleaned) return;
    tournamentStore.setDeviceName(cleaned);
    setChatNameDraft('');
    setShowSetNameForm(false);
    trackUsageEvent('chat:set_name', { category: 'chat' });
  };

  const renderIdentityGate = () => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
        padding: '0.5rem 0.6rem',
        borderRadius: '8px',
        background: 'rgba(15, 23, 42, 0.55)',
        border: '1px solid rgba(148, 163, 184, 0.25)',
      }}
    >
      {showInlineClaimPicker ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '0.75rem',
              fontWeight: 700,
            }}
          >
            <span>🏓 Tap your name to claim:</span>
            <button
              type="button"
              className="btn-secondary btn-sm"
              style={{ padding: '0.12rem 0.45rem', fontSize: '0.7rem' }}
              onClick={() => {
                setShowInlineClaimPicker(false);
                setConfirmingClaim(false);
                setSelectedPlayerId('');
              }}
            >
              Cancel
            </button>
          </div>
          {confirmingClaim && selectedPlayerObj ? (
            <div className="inbox-claim-confirm" style={{ margin: 0 }}>
              <p style={{ margin: '0 0 0.35rem', fontSize: '0.76rem' }}>
                Claim <strong>{selectedPlayerObj.name}</strong>
                {selectedPlayerObj.teamName ? ` (${selectedPlayerObj.teamName})` : ''}? Once claimed,
                only a Moderator or Host can change it.
              </p>
              <div className="inline-actions" style={{ flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={claimBusy}
                  onClick={async () => {
                    await handleConfirmClaim();
                    setShowInlineClaimPicker(false);
                  }}
                >
                  {claimBusy ? 'Claiming...' : `✓ Confirm (${selectedPlayerObj.name})`}
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  disabled={claimBusy}
                  onClick={() => {
                    setConfirmingClaim(false);
                    setSelectedPlayerId('');
                  }}
                >
                  Back
                </button>
              </div>
            </div>
          ) : availablePlayers.length === 0 ? (
            <p style={{ margin: 0, fontSize: '0.75rem', opacity: 0.78 }}>
              All players have already been claimed. Use &ldquo;Set Name&rdquo; to chat as a spectator!
            </p>
          ) : (
            <div
              className="scroller"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.3rem',
                maxHeight: '130px',
                overflowY: 'auto',
              }}
            >
              {availablePlayers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="btn-secondary btn-sm"
                  style={{ fontSize: '0.75rem', padding: '0.24rem 0.5rem' }}
                  onClick={() => {
                    setSelectedPlayerId(p.id);
                    setConfirmingClaim(true);
                  }}
                >
                  {p.teamName
                    ? `${p.name} (${p.teamName})`
                    : p.seed
                    ? `#${p.seed} ${p.name}`
                    : p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : !showSetNameForm ? (
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <button
            type="button"
            className="btn-primary btn-sm"
            style={{ flex: 1, minWidth: 0 }}
            onClick={() => {
              setShowSetNameForm(false);
              setShowInlineClaimPicker(true);
            }}
          >
            🏓 Claim Player
          </button>
          <span
            style={{
              fontSize: '0.72rem',
              opacity: 0.65,
              fontWeight: 600,
              flexShrink: 0,
              textTransform: 'lowercase',
            }}
          >
            or
          </span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            style={{ flexShrink: 0 }}
            onClick={() => {
              setShowInlineClaimPicker(false);
              setShowSetNameForm(true);
            }}
          >
            ✏️ Set Name
          </button>
        </div>
      ) : (
        <form
          onSubmit={handleSaveChatName}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.35rem',
            alignItems: 'center',
            width: '100%',
            minWidth: 0,
          }}
        >
          <input
            type="text"
            value={chatNameDraft}
            onChange={(e) => setChatNameDraft(e.target.value)}
            placeholder="Your name (e.g. Uncle Dave)"
            maxLength={40}
            autoFocus
            style={{ flex: '1 1 130px', minWidth: 0 }}
          />
          <div style={{ display: 'inline-flex', gap: '0.3rem', flexShrink: 0 }}>
            <button
              type="submit"
              className="btn-amber btn-sm"
              disabled={!chatNameDraft.trim()}
            >
              Save
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => {
                setShowSetNameForm(false);
                setChatNameDraft('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );

  const claimedByOthers = useMemo(() => {
    const set = new Set();
    for (const [dev, pid] of Object.entries(claims)) {
      if (dev !== myDeviceId && pid) set.add(pid);
    }
    return set;
  }, [claims, myDeviceId]);

  const availablePlayers = useMemo(
    () => claimablePlayers.filter((p) => !claimedByOthers.has(p.id)),
    [claimablePlayers, claimedByOthers]
  );

  const selectedPlayerObj = selectedPlayerId
    ? claimablePlayers.find((p) => p.id === selectedPlayerId) || null
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
      const pName = pid ? resolveClaimedPlayer(state, pid)?.name || null : null;
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
  }, [remoteSync?.clients, myDeviceId, state, claims]);

  const handleOpen = () => {
    setOpen(true);
    setClaimFeedback('');
    setConfirmingClaim(false);
    setChatError('');
    trackUsageEvent('chat:open_drawer', { category: 'chat' });
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
        aria-label={`Open ${claimedPlayerObj ? `${claimedPlayerObj.name}'s Chat & Inbox` : 'Claim Player & Chat'} (${totalUnread} unread)`}
      >
        <span>{claimedPlayerObj ? `💬 ${claimedPlayerObj.name}` : '🏓 Claim Player'}</span>
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
          <div className="inbox-drawer-card">
            <div className="inbox-drawer-header" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <h2
                title={
                  claimedPlayerObj
                    ? `🔒 Claimed Player: ${claimedPlayerObj.name} — Ask a Moderator or Host to change or release your claim.`
                    : hasCustomChatName
                    ? `Display Name: ${remoteSync.deviceName}`
                    : 'Tournament Chat & Inbox'
                }
                style={{
                  margin: 0,
                  fontSize: '0.96rem',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '38%',
                  cursor: claimedPlayerObj ? 'help' : undefined,
                }}
              >
                💬 {chatHeaderName}
              </h2>

              {/* Compact Live Mini Scoreboard next to user's name (auto-rotates every 5s across live tables) */}
              {(() => {
                const count = miniScoreboardMatches.length;
                if (count === 0) return null;
                const activeIdx = miniTableIdx % count;
                const am = miniScoreboardMatches[activeIdx] || miniScoreboardMatches[0];
                if (!am || am.isBye) return null;
                const showTableBadge =
                  count > 1 || (Number(state?.rules?.tableCount) || 1) > 1;
                const p1 = getPlayerLabel(am.player1Id, am.source1Label);
                const p2 = getPlayerLabel(am.player2Id, am.source2Label);
                const isLive = Boolean(am.started && !am.completed);
                const evalM = evaluateMatchState(am, state?.rules);
                const serverSlot = !am.completed ? evalM.activeServer : null;
                const tableNum = am.tableNumber || activeIdx + 1;
                const serveDot = (
                  <span
                    aria-label="Serving"
                    title="Serving"
                    style={{
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background: '#facc15',
                      boxShadow: '0 0 6px rgba(250, 204, 21, 0.85)',
                      flexShrink: 0,
                    }}
                  />
                );
                const miniBtnStyle = (active) => ({
                  appearance: 'none',
                  border: `1px solid ${
                    active ? 'rgba(251, 191, 36, 0.65)' : 'rgba(148, 163, 184, 0.28)'
                  }`,
                  background: active ? 'rgba(245, 158, 11, 0.22)' : 'rgba(30, 41, 59, 0.72)',
                  color: active ? '#fde68a' : '#cbd5e1',
                  borderRadius: '4px',
                  width: '19px',
                  height: '19px',
                  padding: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.64rem',
                  lineHeight: 1,
                  cursor: 'pointer',
                  flexShrink: 0,
                });
                return (
                  <div
                    aria-label={showTableBadge ? `Table ${tableNum} Scoreboard` : 'Live Match Scoreboard'}
                    title={`${showTableBadge ? `Table ${tableNum} (${activeIdx + 1}/${count}) · ` : ''}${am.roundLabel} (${am.label}): ${p1} ${am.score1 ?? 0}–${am.score2 ?? 0} ${p2}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        count > 1
                          ? 'auto 1fr auto 1fr auto'
                          : showTableBadge
                          ? 'auto 1fr auto 1fr'
                          : '1fr auto 1fr',
                      alignItems: 'center',
                      gap: '0.32rem',
                      padding: '0.2rem 0.45rem',
                      borderRadius: '7px',
                      background: 'rgba(15, 23, 42, 0.78)',
                      border: `1px solid ${
                        miniTableHeld && count > 1
                          ? 'rgba(251, 191, 36, 0.55)'
                          : isLive
                          ? 'rgba(52, 211, 153, 0.45)'
                          : 'rgba(148, 163, 184, 0.28)'
                      }`,
                      fontSize: '0.73rem',
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    {showTableBadge && (
                      <span
                        style={{
                          fontSize: '0.62rem',
                          fontWeight: 800,
                          padding: '0.08rem 0.3rem',
                          borderRadius: '4px',
                          background: isLive
                            ? 'rgba(34, 197, 94, 0.2)'
                            : 'rgba(245, 158, 11, 0.18)',
                          color: isLive ? '#86efac' : '#fde68a',
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        T{tableNum}
                      </span>
                    )}

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: '0.26rem',
                        minWidth: 0,
                      }}
                    >
                      {serverSlot === 1 && serveDot}
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: serverSlot === 1 ? 700 : 500,
                        }}
                      >
                        {p1}
                      </span>
                    </div>

                    <strong
                      style={{
                        color: '#fbbf24',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                        fontSize: '0.92rem',
                        fontWeight: 800,
                        letterSpacing: '0.03em',
                        lineHeight: 1,
                        fontVariantNumeric: 'tabular-nums',
                        textAlign: 'center',
                        padding: '0 0.12rem',
                        flexShrink: 0,
                      }}
                    >
                      {am.score1 ?? 0}–{am.score2 ?? 0}
                    </strong>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-start',
                        gap: '0.26rem',
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: serverSlot === 2 ? 700 : 500,
                        }}
                      >
                        {p2}
                      </span>
                      {serverSlot === 2 && serveDot}
                    </div>

                    {count > 1 && (
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.18rem',
                          flexShrink: 0,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setMiniTableHeld((h) => !h)}
                          aria-pressed={miniTableHeld}
                          aria-label={
                            miniTableHeld
                              ? 'Resume 5-second table rotation'
                              : `Hold on Table ${tableNum}`
                          }
                          title={
                            miniTableHeld
                              ? `Held on Table ${tableNum} (click to resume 5s rotation)`
                              : `Hold on Table ${tableNum}`
                          }
                          style={miniBtnStyle(miniTableHeld)}
                        >
                          {miniTableHeld ? '▶' : '⏸'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMiniTableIdx((prev) => (prev + 1) % count);
                            setMiniRotateTick((n) => n + 1);
                          }}
                          aria-label="Next live table"
                          title={`Next live table (${activeIdx + 1}/${count})`}
                          style={miniBtnStyle(false)}
                        >
                          ›
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setOpen(false)}
                aria-label="Close Chat Drawer"
                style={{ flexShrink: 0 }}
              >
                ✕
              </button>
            </div>

            <div className="inbox-drawer-body">
              <div className="inbox-drawer-sidebar scroller">
            {/* 4-Tab Switcher pinned directly under header so banners appearing/hiding never shift tabs */}
            <div
              className="segmented-control compact"
              style={{ marginTop: 0, marginBottom: 0 }}
            >
              <button
                type="button"
                className={activeTab === 'live' ? 'is-selected' : ''}
                onClick={() => {
                  setActiveTab('live');
                  setChatError('');
                }}
              >
                🗣️ Chat{unreadLive > 0 ? ` (${unreadLive})` : ''}
              </button>
              <button
                type="button"
                className={activeTab === 'messages' ? 'is-selected' : ''}
                onClick={() => {
                  setActiveTab('messages');
                  setChatError('');
                }}
              >
                💬 Direct{unreadThreadsTotal > 0 ? ` (${unreadThreadsTotal})` : ''}
              </button>
              <button
                type="button"
                className={activeTab === 'ondeck' ? 'is-selected' : ''}
                onClick={() => {
                  setActiveTab('ondeck');
                  setChatError('');
                  trackUsageEvent('chat:tab_ondeck', { category: 'chat' });
                }}
              >
                ⏳ On Deck
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

            {/* Mini Announcement Banner (below tab bar; hidden on Alerts tab where full list is shown) */}
            {activeTab !== 'alerts' && latestAnnouncement && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  width: '100%',
                  padding: '0.24rem 0.4rem 0.24rem 0.5rem',
                  marginBottom: 0,
                  borderRadius: '7px',
                  border: '1px solid rgba(245, 158, 11, 0.48)',
                  background: 'rgba(245, 158, 11, 0.15)',
                  color: 'inherit',
                  fontSize: '0.75rem',
                }}
              >
                <button
                  type="button"
                  onClick={() => setActiveTab('alerts')}
                  title="Click to view announcements & alerts"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.4rem',
                    flex: 1,
                    minWidth: 0,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: 'inherit',
                    font: 'inherit',
                    textAlign: 'left',
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
                    <strong>{latestAnnouncement.title || '📢 Announcement from Host'}:</strong>{' '}
                    {renderLiveMessageText(latestAnnouncement, inboxNowMs)}
                  </span>
                  <span style={{ opacity: 0.72, fontSize: '0.68rem', flexShrink: 0 }}>
                    {latestAnnouncement.sticky ? '📌 ' : ''}
                    {formatMsgTime(latestAnnouncement.sentAt)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => dismissBanner(latestAnnouncementId)}
                  aria-label="Dismiss announcement banner"
                  title="Dismiss"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    opacity: 0.7,
                    cursor: 'pointer',
                    padding: '0 0.2rem',
                    fontSize: '0.75rem',
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  ✕
                </button>
              </div>
            )}

            {/* Mini Alert Banner directly under Announcement Banner (hidden on Alerts tab) */}
            {activeTab !== 'alerts' && latestAlert && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  width: '100%',
                  padding: '0.24rem 0.4rem 0.24rem 0.5rem',
                  marginBottom: 0,
                  borderRadius: '7px',
                  border: '1px solid rgba(244, 63, 94, 0.45)',
                  background: 'rgba(244, 63, 94, 0.14)',
                  color: 'inherit',
                  fontSize: '0.75rem',
                }}
              >
                <button
                  type="button"
                  onClick={() => setActiveTab('alerts')}
                  title="Click to view your alerts"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.4rem',
                    flex: 1,
                    minWidth: 0,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: 'inherit',
                    font: 'inherit',
                    textAlign: 'left',
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
                    <strong>{latestAlert.title || '🔔 Alert'}:</strong>{' '}
                    {renderLiveMessageText(latestAlert, inboxNowMs)}
                  </span>
                  <span style={{ opacity: 0.72, fontSize: '0.68rem', flexShrink: 0 }}>
                    {formatMsgTime(latestAlert.sentAt)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => dismissBanner(latestAlertId)}
                  aria-label="Dismiss alert banner"
                  title="Dismiss"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    opacity: 0.7,
                    cursor: 'pointer',
                    padding: '0 0.2rem',
                    fontSize: '0.75rem',
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  ✕
                </button>
              </div>
            )}

            {/* Smart On Deck Banner directly under Announcements/Alerts (hidden on On Deck tab) */}
            {activeTab !== 'ondeck' &&
              (upNextMatches.length > 0 || myPlayerStatus?.tone === 'playing') && (
              <button
                type="button"
                onClick={() => setActiveTab('ondeck')}
                title="Click to view full On Deck queue & roster"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  width: '100%',
                  textAlign: 'left',
                  padding: '0.24rem 0.5rem',
                  borderRadius: '7px',
                  flexShrink: 0,
                  background:
                    myPlayerStatus?.tone === 'playing'
                      ? 'rgba(16, 185, 129, 0.16)'
                      : 'rgba(56, 189, 248, 0.12)',
                  border: `1px solid ${
                    myPlayerStatus?.tone === 'playing'
                      ? 'rgba(16, 185, 129, 0.45)'
                      : 'rgba(56, 189, 248, 0.3)'
                  }`,
                  color: 'inherit',
                  fontSize: '0.74rem',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    fontWeight: 800,
                    color: myPlayerStatus?.tone === 'playing' ? '#34d399' : '#38bdf8',
                    flexShrink: 0,
                  }}
                >
                  ⏳ {(myPlayerStatus?.tabLabel || 'On Deck').toUpperCase()}
                </span>
                <span
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0,
                    flex: 1,
                    lineHeight: 1.2,
                  }}
                >
                  {myPlayerStatus?.tone === 'playing' ? (
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {myPlayerStatus.detail}
                    </span>
                  ) : (() => {
                      const nextM = upNextMatches[0];
                      if (isTeams && nextM) {
                        return (
                          <span
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
                              alignItems: 'center',
                              gap: '0.45rem',
                              width: '100%',
                              minWidth: 0,
                              fontWeight: 600,
                            }}
                          >
                            {renderDrawerOnDeckSide(nextM.player1Id, nextM.source1Label, 'left')}
                            <span style={{ opacity: 0.6, fontSize: '0.7rem', textAlign: 'center' }}>
                              vs
                            </span>
                            {renderDrawerOnDeckSide(nextM.player2Id, nextM.source2Label, 'right')}
                          </span>
                        );
                      }
                      return (
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                      );
                    })()}
                </span>
              </button>
            )}
              </div>

              <div className="inbox-drawer-main">
            {chatError && (
              <p className="inbox-feedback" style={{ margin: '0 0 0.35rem', color: '#f87171' }}>
                {chatError}
              </p>
            )}

            {/* TAB 1: PUBLIC LIVE GAME CHAT */}
            {activeTab === 'live' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: '0.28rem' }}>
                <div
                  className="scroller"
                  style={{
                    flex: 1,
                    minHeight: 0,
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
                  renderIdentityGate()
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
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: '0.45rem' }}>
                {!hasChatIdentity ? (
                  renderIdentityGate()
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
                        minHeight: 0,
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
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: '0.55rem' }}>
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
                      <div className="inbox-list scroller" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
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

            {/* TAB 3: FULL ON DECK QUEUE & PLAYER ROSTER */}
            {activeTab === 'ondeck' && (
              <div
                className="scroller"
                style={{
                  overflowY: 'auto',
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.65rem',
                  paddingRight: '0.1rem',
                }}
              >
                {/* Personalized "When You Are Up" Status Card */}
                {myPlayerStatus ? (
                  <div
                    style={{
                      padding: '0.6rem 0.75rem',
                      borderRadius: '9px',
                      border: `1px solid ${
                        myPlayerStatus.tone === 'playing' || myPlayerStatus.tone === 'champion'
                          ? 'rgba(16, 185, 129, 0.55)'
                          : myPlayerStatus.tone === 'ondeck'
                          ? 'rgba(56, 189, 248, 0.55)'
                          : 'rgba(148, 163, 184, 0.3)'
                      }`,
                      background:
                        myPlayerStatus.tone === 'playing' || myPlayerStatus.tone === 'champion'
                          ? 'rgba(16, 185, 129, 0.16)'
                          : myPlayerStatus.tone === 'ondeck'
                          ? 'rgba(56, 189, 248, 0.15)'
                          : 'rgba(15, 23, 42, 0.55)',
                    }}
                  >
                    <div style={{ fontWeight: 800, fontSize: '0.84rem' }}>
                      {myPlayerStatus.headline}
                    </div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.9, marginTop: '0.18rem' }}>
                      {myPlayerStatus.detail}
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.5rem',
                      padding: '0.5rem 0.65rem',
                      borderRadius: '8px',
                      background: 'rgba(15, 23, 42, 0.5)',
                      border: '1px solid rgba(148, 163, 184, 0.25)',
                      fontSize: '0.78rem',
                    }}
                  >
                    <span>Claim your player to see when you&apos;re up next!</span>
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() => setActiveTab('alerts')}
                    >
                      🏓 Claim
                    </button>
                  </div>
                )}

                {/* Full On Deck Queue */}
                <section className="inbox-section" style={{ margin: 0 }} aria-label="Full On Deck Queue">
                  <div className="inbox-section-head">
                    <strong>⏳ Full On Deck Queue ({upNextMatches.length})</strong>
                  </div>
                  {upNextMatches.length === 0 ? (
                    <p className="inbox-empty">No upcoming matches queued right now.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      {upNextMatches.map((m, idx) => {
                        const isMine = Boolean(
                          claimedEntrantId &&
                            (m.player1Id === claimedEntrantId ||
                              m.player2Id === claimedEntrantId)
                        );
                        return (
                          <div
                            key={m.id}
                            className="inbox-msg-card"
                            style={{
                              padding: '0.42rem 0.6rem',
                              borderColor: isMine
                                ? 'rgba(56, 189, 248, 0.65)'
                                : idx === 0
                                ? 'rgba(245, 158, 11, 0.45)'
                                : undefined,
                              background: isMine ? 'rgba(56, 189, 248, 0.14)' : undefined,
                            }}
                          >
                            <div className="inbox-msg-top">
                              <strong style={{ fontSize: '0.74rem' }}>
                                {idx === 0 ? 'NEXT UP' : `#${idx + 1}`} · {m.roundLabel} ({m.label})
                              </strong>
                              {isMine && (
                                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#38bdf8' }}>
                                  ★ YOU
                                </span>
                              )}
                            </div>
                            <div
                              style={
                                isTeams
                                  ? {
                                      display: 'grid',
                                      gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
                                      alignItems: 'center',
                                      gap: '0.45rem',
                                      width: '100%',
                                      minWidth: 0,
                                      fontSize: '0.84rem',
                                      fontWeight: 600,
                                      marginTop: '0.2rem',
                                    }
                                  : {
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '0.45rem',
                                      width: '100%',
                                      minWidth: 0,
                                      fontSize: '0.84rem',
                                      fontWeight: 600,
                                      marginTop: '0.2rem',
                                    }
                              }
                            >
                              {renderDrawerOnDeckSide(m.player1Id, m.source1Label, 'left')}
                              <span style={{ opacity: 0.6, textAlign: 'center' }}>vs</span>
                              {renderDrawerOnDeckSide(m.player2Id, m.source2Label, 'right')}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* Full Player Roster */}
                <section className="inbox-section" style={{ margin: 0 }} aria-label="Full Player Roster">
                  <div className="inbox-section-head">
                    <strong>🏓 Roster ({players.length})</strong>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.28rem' }}>
                    {players.map((p) => {
                      const isChamp = state?.championId === p.id;
                      const allMs = Object.values(state?.matches || {});
                      const isPlaying = allMs.some(
                        (m) =>
                          m &&
                          !m.isBye &&
                          !m.completed &&
                          m.started &&
                          (m.player1Id === p.id || m.player2Id === p.id)
                      );
                      const isQueued = upNextMatches.some(
                        (m) => m.player1Id === p.id || m.player2Id === p.id
                      );
                      const isAlive = allMs.some(
                        (m) =>
                          m &&
                          !m.isBye &&
                          !m.completed &&
                          (m.player1Id === p.id || m.player2Id === p.id)
                      );
                      const statusLabel = isChamp
                        ? '🏆 Champ'
                        : isPlaying
                        ? '🏓 Playing'
                        : isQueued
                        ? '⏳ On Deck'
                        : isAlive
                        ? 'Active'
                        : 'Done';
                      const isMe = claimedEntrantId === p.id;
                      return (
                        <div
                          key={p.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '0.32rem 0.55rem',
                            borderRadius: '6px',
                            background: isMe
                              ? 'rgba(56, 189, 248, 0.14)'
                              : 'rgba(15, 23, 42, 0.42)',
                            border: `1px solid ${
                              isMe ? 'rgba(56, 189, 248, 0.45)' : 'rgba(148, 163, 184, 0.14)'
                            }`,
                            fontSize: '0.8rem',
                          }}
                        >
                          <span>
                            <strong style={{ opacity: 0.65, marginRight: '0.35rem' }}>
                              #{p.seed}
                            </strong>
                            <strong>{p.name}</strong>
                            {isTeams && formatTeamMembersShort(p, ' & ') && (
                              <span style={{ marginLeft: '0.35rem', fontSize: '0.73rem', opacity: 0.72 }}>
                                ({formatTeamMembersShort(p, ' & ')})
                              </span>
                            )}
                            {isMe && (
                              <span style={{ marginLeft: '0.35rem', fontSize: '0.7rem', color: '#38bdf8' }}>
                                (You)
                              </span>
                            )}
                          </span>
                          <span style={{ fontSize: '0.72rem', opacity: 0.8 }}>{statusLabel}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            )}

            {/* TAB 4: ALERTS INBOX & PLAYER CLAIM */}
            {activeTab === 'alerts' && (
              <div className="scroller" style={{ overflowY: 'auto', flex: 1 }}>
                {/* Player Claim Section (only shown until a player is claimed) */}
                {!claimedPlayerObj && (
                  <section className="inbox-section" aria-label="Claim Your Player">
                    <div className="inbox-section-head">
                      <strong>🏓 Claim Your Player</strong>
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

                    {confirmingClaim && selectedPlayerObj ? (
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
                              {p.teamName
                                ? `${p.name} (${p.teamName})`
                                : p.seed
                                ? `#${p.seed} ${p.name}`
                                : p.name}
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
                )}

                {/* System & Host Announcements Inbox */}
                <section className="inbox-section" aria-label="Announcements and Alerts Inbox">
                  <div className="inbox-section-head">
                    <strong>📢 Alerts &amp; Announcements ({inbox.length})</strong>
                    <div className="inline-actions">
                      {claimedPlayerObj &&
                        notifyCaps?.canUseDesktop &&
                        notifyCaps?.permission === 'default' && (
                          <button
                            type="button"
                            className="btn-primary btn-sm"
                            onClick={onEnableDesktopAlerts}
                          >
                            🔔 Enable Alerts
                          </button>
                        )}
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
          </div>
        </div>
      )}
    </>
  );
}
