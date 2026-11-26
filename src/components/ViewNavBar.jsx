import React, { useEffect, useRef, useState } from 'react';
import { tournamentStore } from '../state/tournamentStore.js';
import ShareTournamentModal from './ShareTournamentModal.jsx';

/**
 * Uniform top-left navigation menu bar rendered in the exact same position
 * across EVERY view (Admin, System, Users, Control, Presentation, Scorekeeper, Spectator).
 *
 * Options follow the user's role — never the current view:
 *   1. Standalone Hub button
 *   2. Role-filtered view pill bar in strict order:
 *      Admin | System | Users | Control | Presentation | Scorekeeper | Spectator
 *      (omitted for Presenter since Presenter only uses Presentation + Hub + Full Screen)
 *   3. Optional view-specific contextual buttons passed via `children`
 *   4. Clickable 4-word Tournament ID pill (opens Auto-Join QR Code & Share modal; hidden in Full Screen with menu)
 *   5. Current Tab ID badge (shown everywhere unless in Full Screen)
 */
export default function ViewNavBar({
  activeMode,
  rolePerms,
  pendingRequestsCount = 0,
  showViewGroupOverride = true,
  onNavigateMode,
  onOpenTournamentChooser,
  isFullscreen = false,
  children = null,
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const navRootRef = useRef(null);
  const [liveSnapshot, setLiveSnapshot] = useState(() => ({
    state: tournamentStore.getState(),
    meta: tournamentStore.getSyncMeta(),
  }));

  useEffect(() => {
    return tournamentStore.subscribe((nextState, nextMeta) => {
      setLiveSnapshot({
        state: nextState,
        meta: nextMeta || tournamentStore.getSyncMeta(),
      });
    });
  }, []);

  // Close mobile menu drawer on view switch, Escape key, or outside click
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [activeMode]);

  useEffect(() => {
    if (!mobileMenuOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setMobileMenuOpen(false);
    };
    const onPointerDown = (e) => {
      if (navRootRef.current && !navRootRef.current.contains(e.target)) {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [mobileMenuOpen]);

  const perms = rolePerms || {
    role: 'host',
    canAccessHub: true,
    canAccessAdmin: false,
    canAccessSystem: true,
    canAccessUsers: true,
    canAccessControl: true,
    canAccessPresent: true,
    canScore: true,
    canAccessSpectator: true,
  };

  const programState = liveSnapshot.meta?.programState || liveSnapshot.state;
  const pendingJoinCount = Array.isArray(programState?.joinRequests)
    ? programState.joinRequests.length
    : 0;
  const pendingScorekeeperCount = Array.isArray(programState?.scorekeeperRequests)
    ? programState.scorekeeperRequests.length
    : 0;
  const totalPendingRequests = Math.max(
    Number(pendingRequestsCount) || 0,
    pendingJoinCount + pendingScorekeeperCount
  );

  const requestSummaryParts = [];
  if (pendingJoinCount > 0) {
    requestSummaryParts.push(`${pendingJoinCount} Join Request${pendingJoinCount === 1 ? '' : 's'}`);
  }
  if (pendingScorekeeperCount > 0) {
    requestSummaryParts.push(
      `${pendingScorekeeperCount} Scorekeeper Request${pendingScorekeeperCount === 1 ? '' : 's'}`
    );
  }
  const requestTooltip =
    requestSummaryParts.length > 0
      ? `${requestSummaryParts.join(' · ')} — Click to review in Users`
      : `${totalPendingRequests} Pending Request${totalPendingRequests === 1 ? '' : 's'} — Click to review in Users`;

  const navItems = [
    { id: 'admin', label: 'Admin', allowed: Boolean(perms.canAccessAdmin) },
    { id: 'system', label: 'Host', allowed: Boolean(perms.canAccessSystem) },
    {
      id: 'users',
      label: 'Users',
      badge: totalPendingRequests > 0 ? totalPendingRequests : 0,
      allowed: Boolean(perms.canAccessUsers),
    },
    { id: 'control', label: 'Control', allowed: Boolean(perms.canAccessControl) },
    { id: 'present', label: 'Presentation', allowed: Boolean(perms.canAccessPresent) },
    { id: 'scorekeeper', label: 'Scorekeeper', allowed: Boolean(perms.canScore) },
    { id: 'spectator', label: 'Spectator', allowed: Boolean(perms.canAccessSpectator) },
  ].filter((item) => item.allowed);

  const showViewGroup = showViewGroupOverride && navItems.length > 0 && perms.role !== 'presenter';
  const showRequestsAlertPill =
    showViewGroupOverride &&
    totalPendingRequests > 0 &&
    Boolean(perms.canApproveRequests ?? perms.canAccessUsers) &&
    activeMode !== 'users';
  const tabId = tournamentStore.getTabId();
  const joinCode =
    showViewGroupOverride && programState?.joinCode ? String(programState.joinCode) : '';

  const activeNavLabel =
    navItems.find((item) => item.id === activeMode)?.label ||
    (activeMode ? activeMode.charAt(0).toUpperCase() + activeMode.slice(1) : 'Menu');

  const handleNavigate = (id) => {
    setMobileMenuOpen(false);
    if (id !== activeMode) onNavigateMode?.(id);
  };

  return (
    <>
      <div className={`uniform-view-nav ${mobileMenuOpen ? 'is-mobile-open' : ''}`} ref={navRootRef}>
        {/* Compact Mobile Top Bar (<= 768px): never cuts off any menu items */}
        <div className="nav-mobile-bar">
          <button
            type="button"
            className={`btn-secondary btn-sm nav-mobile-trigger ${mobileMenuOpen ? 'is-open' : ''}`}
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-expanded={mobileMenuOpen}
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          >
            <span aria-hidden="true">{mobileMenuOpen ? '✕' : '☰'}</span>
            <span>{activeNavLabel}</span>
            {showRequestsAlertPill && (
              <span className="nav-req-badge" aria-label={`${totalPendingRequests} pending requests`}>
                {totalPendingRequests}
              </span>
            )}
          </button>

          {joinCode && (
            <button
              type="button"
              className="nav-tournament-key-btn nav-mobile-key-btn"
              onClick={() => {
                setMobileMenuOpen(false);
                setShareOpen(true);
              }}
              title="Click to show QR Code & share options to auto-join with this Key"
            >
              <span aria-hidden="true">🔑</span>
              <span>{joinCode}</span>
            </button>
          )}

          {tabId && (
            <span
              className="nav-tab-id-pill nav-mobile-id-pill"
              title={`Current Session ID: ${tabId}`}
            >
              {tabId}
            </span>
          )}
        </div>

        {/* Full Navigation & Contextual Controls (inline on desktop >768px, full scrollable drawer on mobile <=768px) */}
        <div className={`nav-items-tray ${mobileMenuOpen ? 'is-open' : ''}`}>
          {onOpenTournamentChooser && perms.canAccessHub !== false && (
            <button
              type="button"
              className="btn-secondary btn-sm nav-hub-btn"
              onClick={() => {
                setMobileMenuOpen(false);
                onOpenTournamentChooser();
              }}
              title="Return to Tournament Hub"
            >
              📂 Hub
            </button>
          )}

          {showViewGroup && (
            <div className="view-mode-toggle" role="group" aria-label="View Mode">
              {navItems.map((item) => {
                const isCurrent = activeMode === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`${isCurrent ? 'is-active' : ''} ${
                      item.badge > 0 ? 'has-req-badge' : ''
                    }`}
                    aria-current={isCurrent ? 'page' : undefined}
                    onClick={() => handleNavigate(item.id)}
                  >
                    <span>{item.label}</span>
                    {item.badge > 0 && (
                      <span className="nav-req-badge" aria-label={`${item.badge} pending requests`}>
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {showRequestsAlertPill && (
            <button
              type="button"
              className="nav-requests-alert-btn"
              onClick={() => handleNavigate('users')}
              title={requestTooltip}
            >
              <span aria-hidden="true">🔔</span>
              <span>
                {totalPendingRequests} Request{totalPendingRequests === 1 ? '' : 's'}
              </span>
            </button>
          )}

          {children && (
            <div
              className="nav-contextual-actions"
              onClick={(e) => {
                // Keep drawer open when toggling checkboxes/selects; close after clicking action buttons
                if (e.target.closest('button')) setMobileMenuOpen(false);
              }}
            >
              {children}
            </div>
          )}

          {joinCode && (
            <button
              type="button"
              className="nav-tournament-key-btn nav-desktop-key-btn"
              onClick={() => setShareOpen(true)}
              title="Click to show QR Code & share options to auto-join with this Key"
            >
              <span aria-hidden="true">🔑</span>
              <span>{joinCode}</span>
            </button>
          )}

          {tabId && (
            <span
              className="nav-tab-id-pill nav-desktop-id-pill"
              title={`Current Session ID: ${tabId}`}
            >
              {tabId}
            </span>
          )}
        </div>
      </div>

      {joinCode && (
        <ShareTournamentModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          tournamentName={programState?.tournamentName}
          joinCode={joinCode}
          access={programState?.access}
          remoteSync={liveSnapshot.meta?.remoteSync}
        />
      )}
    </>
  );
}
