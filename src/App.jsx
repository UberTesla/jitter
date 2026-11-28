import React, { useEffect, useRef, useState } from 'react';
import {
  tournamentStore,
  SLIDE_DEFINITIONS,
  STORAGE_KEY,
  DISCONNECTED_STORAGE_KEY,
  SESSION_PICKED_STORAGE_KEY,
  resolveEffectiveRole,
  getRolePermissions,
} from './state/tournamentStore.js';
import ControlView from './views/ControlView.jsx';
import PresentationView from './views/PresentationView.jsx';
import SpectatorView from './views/SpectatorView.jsx';
import ScorekeeperView from './views/ScorekeeperView.jsx';
import SystemView from './views/SystemView.jsx';
import UsersView from './views/UsersView.jsx';
import AdminView from './views/AdminView.jsx';
import HubView from './views/HubView.jsx';
import StudioScoreCountdown from './components/StudioScoreCountdown.jsx';
import PlayerInboxDrawer from './components/PlayerInboxDrawer.jsx';
import NotificationPrePromptModal from './components/NotificationPrePromptModal.jsx';
import { useWakeLock } from './hooks/useWakeLock.js';
import {
  dispatchNotification,
  getNotificationCapabilities,
  registerNotificationServiceWorker,
  requestDesktopPermission,
  subscribeToWebPush,
} from './engine/notificationService.js';
import { renderLiveMessageText } from './engine/grandmaVariables.js';
import {
  initUsageAnalytics,
  setTelemetryEnabled,
  trackViewTransition,
} from './engine/usageAnalytics.js';

const SESSION_PICKED_KEY = SESSION_PICKED_STORAGE_KEY;

function shouldShowHubOnLoad() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('join')) return false;
  if (params.get('popout') === '1' || Boolean(window.opener)) return false;
  try {
    // If this device was disconnected by a host, ALWAYS land on the Tournament Hub even on reload!
    if (localStorage.getItem(DISCONNECTED_STORAGE_KEY)) return true;
    const picked = sessionStorage.getItem(SESSION_PICKED_KEY);
    if (picked === '__hub__') return true;
    if (picked) {
      // Only stay inside the tournament if an authorized snapshot actually exists in storage
      return !localStorage.getItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage restrictions
  }
  const navEntries =
    typeof performance !== 'undefined' && performance.getEntriesByType
      ? performance.getEntriesByType('navigation')
      : [];
  const navType = navEntries[0]?.type;
  if (navType === 'reload') {
    // Only stay in the active view on reload if an authorized tournament snapshot is actually saved
    try {
      return !localStorage.getItem(STORAGE_KEY);
    } catch {
      return true;
    }
  }
  // Direct navigation (typed URL / bookmark / new tab) has no document.referrer
  return !document.referrer;
}

function resolveInitialMode() {
  if (typeof window === 'undefined') return 'control';
  const path = window.location.pathname.toLowerCase();
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get('view');
  if (path.startsWith('/present') || viewParam === 'present') {
    return 'present';
  }
  if (path.startsWith('/spectator') || viewParam === 'spectator') {
    return 'spectator';
  }
  if (
    path.startsWith('/score') ||
    viewParam === 'score' ||
    viewParam === 'scorekeeper'
  ) {
    return 'scorekeeper';
  }
  if (path.startsWith('/admin') || viewParam === 'admin') {
    return 'admin';
  }
  if (path.startsWith('/users') || viewParam === 'users') {
    return 'users';
  }
  if (
    path.startsWith('/host') ||
    path.startsWith('/system') ||
    path.startsWith('/debug') ||
    viewParam === 'host' ||
    viewParam === 'system' ||
    viewParam === 'debug'
  ) {
    return 'system';
  }
  return 'control';
}

export default function App() {
  const [state, setState] = useState(() => tournamentStore.getState());
  const [syncMeta, setSyncMeta] = useState(() => tournamentStore.getSyncMeta());
  const [viewMode, setViewMode] = useState(resolveInitialMode);
  const [showHub, setShowHub] = useState(shouldShowHubOnLoad);
  const [adminStandalone, setAdminStandalone] = useState(false);
  const [notifyCaps, setNotifyCaps] = useState(() => getNotificationCapabilities());
  const [alertPromptDismissed, setAlertPromptDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('pp_notify_prompt_dismissed') === '1';
    } catch {
      return false;
    }
  });

  const handleEnableDesktopAlerts = async () => {
    const result = await requestDesktopPermission();
    const updated = getNotificationCapabilities();
    setNotifyCaps(updated);
    if (result === 'granted') {
      try {
        sessionStorage.setItem('pp_notify_prompt_dismissed', '1');
      } catch {
        // Ignore storage errors
      }
      setAlertPromptDismissed(true);
      subscribeToWebPush(tournamentStore.getSyncBaseUrl(), syncMeta.remoteSync?.deviceId);
      dispatchNotification(
        {
          id: `enabled-${Date.now()}`,
          type: 'enabled',
          tag: `pp-enabled-${Date.now()}`,
          title: '🔔 Desktop Alerts Enabled',
          body: 'You will receive browser notifications for messages and match alerts.',
        },
        { desktopEnabled: true, soundEnabled: true }
      );
    }
  };

  const handleDismissAlertPrompt = () => {
    setAlertPromptDismissed(true);
    try {
      sessionStorage.setItem('pp_notify_prompt_dismissed', '1');
    } catch {
      // Ignore storage errors
    }
  };

  // Subscribe to real-time tournament store updates + OBS Studio/Live sync metadata
  useEffect(() => {
    registerNotificationServiceWorker();
    return tournamentStore.subscribe((nextState, nextMeta) => {
      setState(nextState);
      if (nextMeta) setSyncMeta(nextMeta);
    });
  }, []);

  // Keep Web Push subscription synced whenever permission is already granted
  useEffect(() => {
    const devId = syncMeta.remoteSync?.deviceId;
    if (!devId) return;
    if (notifyCaps.canUseDesktop && notifyCaps.permission === 'granted') {
      subscribeToWebPush(tournamentStore.getSyncBaseUrl(), devId);
    }
  }, [syncMeta.remoteSync?.deviceId, notifyCaps.canUseDesktop, notifyCaps.permission]);

  // Support QR Code / Share Link auto-join (`?join=<4-word-key>`) on initial page load
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const params = new URLSearchParams(window.location.search);
    const joinKey = params.get('join');
    if (!joinKey) return undefined;

    let cancelled = false;
    (async () => {
      await tournamentStore.syncWithRemoteServer();
      const res = await tournamentStore.joinTournamentByCode(joinKey);
      if (cancelled) return;
      if (res?.found && res.state) {
        try {
          sessionStorage.setItem(SESSION_PICKED_KEY, res.state.tournamentId || 'active');
        } catch {
          // Ignore
        }
        const nextMeta = tournamentStore.getSyncMeta();
        const nextLive = nextMeta.programState || tournamentStore.getState();
        const nextPerms = getRolePermissions(
          resolveEffectiveRole(
            nextLive,
            nextMeta.remoteSync?.deviceId || '',
            tournamentStore.getTabId(),
            { adminDeviceIds: nextMeta.remoteSync?.admins || [] }
          )
        );
        const initialRequested = resolveInitialMode();
        const allowedMode = clampModeForPermissions(initialRequested, nextPerms);
        setViewMode(allowedMode);
        const targetPath = pathForMode(allowedMode);
        const resolvedCode = res.state.joinCode || joinKey;
        const preserveUrl = `${targetPath}?join=${encodeURIComponent(resolvedCode)}`;
        if (`${window.location.pathname}${window.location.search}` !== preserveUrl) {
          window.history.replaceState({}, '', preserveUrl);
        }
        setShowHub(false);
      } else {
        // Strip invalid ?join=... only when auto-join failed
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('join');
        window.history.replaceState({}, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
        setShowHub(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Ensure Studio Mode ONLY affects Control View, never Scorekeeper/Presentation/System
  useEffect(() => {
    tournamentStore.setActiveViewMode(viewMode);
  }, [viewMode]);

  // Report whether this tab is currently inside a tournament vs browsing the Hub
  useEffect(() => {
    tournamentStore.setHubPresence(showHub);
  }, [showHub]);

  // Dynamic browser tab title: "Jitter" in the Hub, or the active tournament's name inside a tournament
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (showHub) {
      document.title = 'Jitter';
    } else {
      const tName = String(state?.tournamentName || '').trim();
      document.title = tName || 'Jitter';
    }
  }, [showHub, state?.tournamentName]);

  // Embedded Usage Analytics: auto-capture views, time-on-view, and button interactions
  const analyticsContextRef = useRef({});
  const analyticsViewName = showHub
    ? 'hub'
    : viewMode === 'system'
    ? 'host'
    : viewMode || 'control';
  const liveStateForRole = syncMeta?.programState || state;
  const effectiveRoleForAnalytics = resolveEffectiveRole(
    liveStateForRole,
    syncMeta?.remoteSync?.deviceId || '',
    tournamentStore.getTabId(),
    { adminDeviceIds: syncMeta?.remoteSync?.admins || [] }
  );
  analyticsContextRef.current = {
    view: analyticsViewName,
    role: effectiveRoleForAnalytics,
    demoMode: Boolean(liveStateForRole?.demoMode),
    entryMode: showHub ? 'none' : liveStateForRole?.entryMode || 'singles',
    format: showHub ? 'none' : liveStateForRole?.format || 'single',
    playerCount: showHub ? 0 : Number(liveStateForRole?.totalPlayers || liveStateForRole?.playerCount || 0),
    mobile: Boolean(tournamentStore.clientEnv?.mobile),
    browser: tournamentStore.clientEnv?.browserName || 'Browser',
    standalone: Boolean(tournamentStore.clientEnv?.standalone),
    deviceId: syncMeta?.remoteSync?.deviceId || '',
  };

  useEffect(() => {
    initUsageAnalytics({
      getContext: () => analyticsContextRef.current,
      getBaseUrl: () => tournamentStore.getSyncBaseUrl?.() || '',
    });
  }, []);

  const hubTelemetryFlag = syncMeta?.remoteSync?.hubSettings?.telemetryEnabled;
  useEffect(() => {
    if (hubTelemetryFlag !== undefined) {
      setTelemetryEnabled(hubTelemetryFlag !== false);
    }
  }, [hubTelemetryFlag]);

  useEffect(() => {
    trackViewTransition(analyticsViewName);
  }, [analyticsViewName]);

  // Apply active seasonal/holiday theme to document root & body
  useEffect(() => {
    const activeTheme =
      viewMode === 'control'
        ? state.ui?.theme || 'arena'
        : syncMeta.programState?.ui?.theme || state.ui?.theme || 'arena';
    document.documentElement.setAttribute('data-theme', activeTheme);
    document.body.setAttribute('data-theme', activeTheme);
  }, [state.ui?.theme, syncMeta.programState?.ui?.theme, viewMode]);

  // If this client was disconnected by a host, return cleanly to the Tournament Hub
  useEffect(() => {
    if (syncMeta.remoteSync?.kickedNotice) {
      setShowHub(true);
    }
  }, [syncMeta.remoteSync?.kickedNotice?.id]);

  // Keep browser back/forward navigation synced with /control, /score, /present, /system, /users
  useEffect(() => {
    const onPopState = () => setViewMode(resolveInitialMode());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Note: Presentation auto-rotation is driven deterministically from the synced server clock
  // inside PresentationView & SlidePreview (so multiple open tabs never double-rotate or spam STATE_SYNC).

  const liveState = syncMeta.programState || state;
  const myTabId = tournamentStore.getTabId();
  const adminDeviceIds = syncMeta.remoteSync?.admins || [];
  const effectiveRole = resolveEffectiveRole(
    liveState,
    syncMeta.remoteSync?.deviceId || '',
    myTabId,
    { adminDeviceIds }
  );
  const rolePerms = getRolePermissions(effectiveRole);
  const prevRoleRef = useRef(effectiveRole);

  // Screen & network keep-alive to prevent displays from sleeping — always active inside
  // tournaments and strictly prioritized for Presenter roles & Presentation/Scoreboard views.
  const keepAliveEnabled = !showHub || effectiveRole === 'presenter';
  const wakeLockStatus = useWakeLock({
    enabled: keepAliveEnabled,
    heartbeatIntervalMs: 25000,
    onHeartbeat: () => {
      tournamentStore.pushClientStatusToRemote();
    },
  });

  // Automatically transition role-driven views:
  // - Any user assigned Presenter -> snap directly to Presentation (/present)
  // - Spectator promoted to Scorekeeper -> open Scorekeeper
  useEffect(() => {
    const prevRole = prevRoleRef.current;
    prevRoleRef.current = effectiveRole;
    if (showHub) return;
    if (effectiveRole === 'presenter') {
      if (viewMode !== 'present') {
        setViewMode('present');
        if (window.location.pathname !== '/present') {
          window.history.pushState({}, '', '/present');
        }
      }
      return;
    }
    if (prevRole === 'spectator' && effectiveRole !== 'spectator' && viewMode === 'spectator') {
      const nextMode = rolePerms.canScore ? 'scorekeeper' : 'spectator';
      setViewMode(nextMode);
      const nextPath = nextMode === 'scorekeeper' ? '/score' : '/spectator';
      if (window.location.pathname !== nextPath) {
        window.history.pushState({}, '', nextPath);
      }
    }
  }, [effectiveRole, rolePerms.canScore, viewMode, showHub]);

  const clampModeForPermissions = (requestedMode, perms) => {
    // Presenter ONLY has access to Presentation View
    if (perms.role === 'presenter' || (!perms.canAccessSpectator && perms.canAccessPresent)) {
      return 'present';
    }
    // Spectator has access to Spectator Mode and Presentation View
    if (!perms.canScore) {
      if (requestedMode === 'present' && perms.canAccessPresent) return 'present';
      return 'spectator';
    }

    if (requestedMode === 'spectator') return perms.canAccessSpectator ? 'spectator' : 'present';
    if (requestedMode === 'present') {
      return perms.canAccessPresent
        ? 'present'
        : perms.canAccessControl
        ? 'control'
        : 'scorekeeper';
    }
    if (requestedMode === 'scorekeeper') return 'scorekeeper';
    if (requestedMode === 'admin') {
      return perms.canAccessAdmin
        ? 'admin'
        : perms.canAccessSystem
        ? 'system'
        : perms.canAccessControl
        ? 'control'
        : 'scorekeeper';
    }
    if (requestedMode === 'users') return perms.canAccessUsers ? 'users' : 'scorekeeper';
    if (requestedMode === 'system' || requestedMode === 'debug') {
      return perms.canAccessSystem
        ? 'system'
        : perms.canAccessControl
        ? 'control'
        : 'scorekeeper';
    }
    return perms.canAccessControl ? 'control' : 'scorekeeper';
  };

  const pathForMode = (mode) =>
    mode === 'present'
      ? '/present'
      : mode === 'spectator'
      ? '/spectator'
      : mode === 'scorekeeper'
      ? '/score'
      : mode === 'admin'
      ? '/admin'
      : mode === 'users'
      ? '/users'
      : mode === 'system'
      ? '/host'
      : '/control';

  const navigateMode = (nextMode) => {
    const normalized = clampModeForPermissions(nextMode, rolePerms);
    if (normalized !== 'admin') setAdminStandalone(false);
    setViewMode(normalized);
    const targetPath = pathForMode(normalized);
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
  };

  const handleEnterTournament = (tournamentId) => {
    try {
      sessionStorage.setItem(SESSION_PICKED_KEY, tournamentId || 'active');
    } catch {
      // Ignore sessionStorage errors
    }
    setAdminStandalone(false);
    const nextMeta = tournamentStore.getSyncMeta();
    const nextLive = nextMeta.programState || tournamentStore.getState();
    const nextPerms = getRolePermissions(
      resolveEffectiveRole(
        nextLive,
        nextMeta.remoteSync?.deviceId || '',
        tournamentStore.getTabId(),
        { adminDeviceIds: nextMeta.remoteSync?.admins || [] }
      )
    );
    const desiredMode = viewMode === 'admin' ? 'control' : viewMode;
    const allowedMode = clampModeForPermissions(desiredMode, nextPerms);
    if (allowedMode !== viewMode) {
      setViewMode(allowedMode);
      const targetPath = pathForMode(allowedMode);
      if (window.location.pathname !== targetPath) {
        window.history.pushState({}, '', targetPath);
      }
    }
    setShowHub(false);
  };

  const handleOpenHub = () => {
    if (!rolePerms.canAccessHub) return;
    try {
      sessionStorage.setItem(SESSION_PICKED_KEY, '__hub__');
    } catch {
      // Ignore sessionStorage errors
    }
    setAdminStandalone(false);
    setShowHub(true);
  };

  const handleOpenAdminFromHub = () => {
    if (!syncMeta.remoteSync?.isThisDeviceAdmin) return;
    setAdminStandalone(true);
    setViewMode('admin');
    if (window.location.pathname !== '/admin') {
      window.history.pushState({}, '', '/admin');
    }
    setShowHub(false);
  };

  // Scorekeeper displays liveState, plus any local unstarted match preview chosen in THIS window
  // (which will not propagate to other Scorekeepers, Control, or Presentation until Begin Match is clicked).
  const scorekeeperState = syncMeta.localPreviewMatchId
    ? {
        ...liveState,
        activeMatchId: syncMeta.localPreviewMatchId,
        matches: {
          ...liveState.matches,
          ...(state.matches?.[syncMeta.localPreviewMatchId]
            ? { [syncMeta.localPreviewMatchId]: state.matches[syncMeta.localPreviewMatchId] }
            : {}),
        },
      }
    : liveState;

  // Enforce role-based access (guests are strictly confined to Spectator Mode)
  const effectiveViewMode = clampModeForPermissions(viewMode, rolePerms);

  const myDeviceId = syncMeta.remoteSync?.deviceId || '';
  const hasClaimedPlayer = Boolean(myDeviceId && liveState?.playerClaims?.[myDeviceId]);

  const showJoinAlertPrompt =
    !showHub &&
    effectiveViewMode !== 'present' &&
    hasClaimedPlayer &&
    !alertPromptDismissed &&
    notifyCaps.canUseDesktop &&
    notifyCaps.permission === 'default';

  const activeUserMsg = syncMeta.remoteSync?.lastUserMessage || null;
  const [toastNowMs, setToastNowMs] = useState(() => tournamentStore.getServerNow());
  const toastNeedsTick = Boolean(
    activeUserMsg?.countdownTargetAt || activeUserMsg?.liveTemplate?.includes('[[CD:')
  );
  useEffect(() => {
    if (!toastNeedsTick) return undefined;
    setToastNowMs(tournamentStore.getServerNow());
    const id = setInterval(() => setToastNowMs(tournamentStore.getServerNow()), 250);
    return () => clearInterval(id);
  }, [activeUserMsg?.id, toastNeedsTick]);
  const isAnnouncementToast = Boolean(
    activeUserMsg &&
      (activeUserMsg.kind === 'announcement' ||
        effectiveRole === 'presenter' ||
        effectiveViewMode === 'present')
  );

  // Auto-dismiss announcements (10s default, or at scheduled dismissAt; sticky banners stay until unstickied)
  useEffect(() => {
    if (!activeUserMsg || !isAnnouncementToast) return undefined;
    if (activeUserMsg.dismissAt) {
      const remaining = Number(activeUserMsg.dismissAt) - tournamentStore.getServerNow();
      if (remaining <= 0) {
        tournamentStore.clearUserMessage();
        return undefined;
      }
      const timer = setTimeout(() => {
        tournamentStore.clearUserMessage();
      }, Math.min(remaining, 2147483647));
      return () => clearTimeout(timer);
    }
    if (activeUserMsg.sticky) return undefined;
    const ms = Number(activeUserMsg.autoDismissMs) > 0 ? Number(activeUserMsg.autoDismissMs) : 10000;
    const timer = setTimeout(() => {
      tournamentStore.clearUserMessage();
    }, ms);
    return () => clearTimeout(timer);
  }, [activeUserMsg?.id, isAnnouncementToast, activeUserMsg?.autoDismissMs, activeUserMsg?.sticky, activeUserMsg?.dismissAt]);

  const userMessageToast = (
    <>
      {!showHub && effectiveViewMode !== 'present' && (
        <PlayerInboxDrawer
          state={liveState}
          remoteSync={syncMeta.remoteSync}
          notifyCaps={notifyCaps}
          onEnableDesktopAlerts={handleEnableDesktopAlerts}
        />
      )}
      {activeUserMsg && effectiveViewMode !== 'present' && (
        <div
          className={`user-message-toast ${isAnnouncementToast ? 'is-announcement' : ''}`}
          role="alert"
          aria-live="assertive"
        >
          <div className="user-message-toast-body">
            <strong>
              {activeUserMsg.title || (isAnnouncementToast ? '📢 Announcement' : '💬 Message')}
            </strong>
            <p>{renderLiveMessageText(activeUserMsg, toastNowMs)}</p>
            {notifyCaps.canUseDesktop && notifyCaps.permission === 'default' && (
              <button
                type="button"
                className="btn-primary btn-sm"
                style={{ alignSelf: 'flex-start', marginTop: '0.35rem' }}
                onClick={handleEnableDesktopAlerts}
              >
                🔔 Enable Desktop Alerts
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => tournamentStore.clearUserMessage()}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      )}
      <NotificationPrePromptModal
        open={Boolean(showJoinAlertPrompt && !syncMeta.remoteSync?.lastUserMessage)}
        onEnable={handleEnableDesktopAlerts}
        onDismiss={handleDismissAlertPrompt}
      />
    </>
  );

  if (showHub) {
    return (
      <>
        <HubView
          targetViewMode={viewMode}
          activeTournamentId={liveState.tournamentId}
          remoteSync={syncMeta.remoteSync}
          onEnterTournament={handleEnterTournament}
          onOpenAdminPanel={handleOpenAdminFromHub}
        />
        {userMessageToast}
      </>
    );
  }

  if (effectiveViewMode === 'present') {
    // Presentation View always displays the published live screen state (locked until pushed live in Studio Mode)
    return (
      <>
        <PresentationView
          state={liveState}
          rolePerms={rolePerms}
          onNavigateMode={navigateMode}
          onOpenTournamentChooser={handleOpenHub}
          liveAnnouncement={activeUserMsg}
        />
        {userMessageToast}
      </>
    );
  }

  if (effectiveViewMode === 'spectator') {
    return (
      <>
        <SpectatorView
          state={liveState}
          effectiveRole={effectiveRole}
          rolePerms={rolePerms}
          myDeviceId={syncMeta.remoteSync?.deviceId || ''}
          onNavigateMode={navigateMode}
          onOpenTournamentChooser={handleOpenHub}
        />
        {userMessageToast}
      </>
    );
  }

  return (
    <>
      {effectiveViewMode === 'scorekeeper' ? (
        <ScorekeeperView
          state={scorekeeperState}
          effectiveRole={effectiveRole}
          rolePerms={rolePerms}
          myDeviceId={syncMeta.remoteSync?.deviceId || ''}
          onNavigateMode={navigateMode}
          onOpenTournamentChooser={handleOpenHub}
        />
      ) : effectiveViewMode === 'admin' ? (
        <AdminView
          state={liveState}
          syncMeta={syncMeta}
          rolePerms={rolePerms}
          hasActiveTournament={!adminStandalone && tournamentStore.hasActiveTournament}
          onNavigateMode={navigateMode}
          onOpenTournamentChooser={handleOpenHub}
          onEnterTournament={handleEnterTournament}
        />
      ) : effectiveViewMode === 'users' ? (
        <UsersView
          state={liveState}
          syncMeta={syncMeta}
          onNavigateMode={navigateMode}
          onOpenTournamentChooser={handleOpenHub}
        />
      ) : effectiveViewMode === 'system' ? (
        <SystemView
          state={liveState}
          syncMeta={syncMeta}
          rolePerms={rolePerms}
          wakeLockStatus={wakeLockStatus}
          onNavigateMode={navigateMode}
          onOpenTournamentChooser={handleOpenHub}
        />
      ) : (
        <ControlView
          state={state}
          syncMeta={syncMeta}
          rolePerms={rolePerms}
          onNavigateMode={navigateMode}
          onOpenTournamentChooser={handleOpenHub}
        />
      )}
      {effectiveViewMode === 'control' && (
        <StudioScoreCountdown pendingScorePush={syncMeta.pendingScorePush} />
      )}
      {userMessageToast}
    </>
  );
}
