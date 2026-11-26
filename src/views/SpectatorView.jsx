import React, { useEffect, useMemo, useState } from 'react';
import { ROLE_META, SLIDE_DEFINITIONS, tournamentStore } from '../state/tournamentStore.js';
import PresentationView from './PresentationView.jsx';
import ViewNavBar from '../components/ViewNavBar.jsx';
import { useFullscreenMenu } from '../hooks/useFullscreenMenu.js';

/**
 * Dedicated Guest Spectator Mode (/spectator)
 * - Guests enter here upon joining a tournament and have access ONLY to Spectator Mode.
 * - Lets spectators locally switch between all presentation slides while offering
 *   a "Sync Presentation" toggle (enabled by default) to follow the live presentation.
 * - Provides a one-click button to Request Scorekeeper access (or Become Scorekeeper
 *   immediately when Require Approval is OFF).
 * - Wraps PresentationView cleanly without altering PresentationView itself.
 */
export default function SpectatorView({
  state,
  effectiveRole = 'spectator',
  rolePerms = null,
  myDeviceId = '',
  onNavigateMode,
  onOpenTournamentChooser,
}) {
  const liveSlide = state.presentation?.activeSlide || 'title';
  const [syncPresentation, setSyncPresentation] = useState(true);
  const [localSlide, setLocalSlide] = useState(liveSlide);
  const [feedback, setFeedback] = useState('');
  const [accessDeniedMsg, setAccessDeniedMsg] = useState('');
  const { isFullscreen, isMenuRevealed, toggleFullscreen, barHoverHandlers } = useFullscreenMenu();

  const canScoreRole = rolePerms ? Boolean(rolePerms.canScore) : effectiveRole !== 'spectator' && effectiveRole !== 'presenter';
  const roleMeta = ROLE_META[effectiveRole] || ROLE_META.spectator;
  const requireScorekeeperApproval = state.rules?.requireScorekeeperApproval !== false;
  const pendingRequestsCount =
    (state.scorekeeperRequests?.length || 0) + (state.joinRequests?.length || 0);
  const hasPendingRequest = Boolean(
    myDeviceId &&
    (state.scorekeeperRequests || []).some((r) => r && r.deviceId === myDeviceId)
  );

  // Listen for real-time Scorekeeper request approval / denial notices
  useEffect(() => {
    const checkNotice = (meta) => {
      const notice = meta?.remoteSync?.scorekeeperResolutionNotice;
      if (!notice) return;
      tournamentStore.clearScorekeeperResolutionNotice();
      if (!notice.approved) {
        setAccessDeniedMsg(
          notice.message || 'Access Denied — your request for Scorekeeper access was denied.'
        );
      } else {
        setAccessDeniedMsg('');
      }
    };
    checkNotice(tournamentStore.getSyncMeta());
    return tournamentStore.subscribe((_s, nextMeta) => checkNotice(nextMeta));
  }, []);

  // Keep localSlide synced when Sync Presentation is enabled
  useEffect(() => {
    if (syncPresentation) {
      setLocalSlide(liveSlide);
    }
  }, [syncPresentation, liveSlide]);

  const flashFeedback = (msg) => {
    setFeedback(msg);
    setTimeout(() => {
      setFeedback((curr) => (curr === msg ? '' : curr));
    }, 3000);
  };

  const activeLocalSlide = syncPresentation ? liveSlide : localSlide;

  // Build local-only presentation state copy (never mutates or broadcasts slide changes!)
  const spectatorState = useMemo(() => {
    if ((state.presentation?.activeSlide || 'title') === activeLocalSlide) {
      return state;
    }
    return {
      ...state,
      presentation: {
        ...(state.presentation || {}),
        activeSlide: activeLocalSlide,
      },
    };
  }, [state, activeLocalSlide]);

  const handleSelectSlide = (slideId) => {
    setLocalSlide(slideId);
    if (syncPresentation) {
      setSyncPresentation(false);
    }
  };

  const handleToggleSync = () => {
    setSyncPresentation((prev) => {
      const next = !prev;
      if (next) {
        setLocalSlide(liveSlide);
      }
      return next;
    });
  };

  const handleRequestScorekeeper = async () => {
    setAccessDeniedMsg('');
    const res = await tournamentStore.requestScorekeeperAccess();
    if (res.ok && res.approved) {
      flashFeedback('You are now a Scorekeeper! Opening Scorekeeper view...');
      onNavigateMode?.('scorekeeper');
    } else if (res.ok && res.pending) {
      flashFeedback('Scorekeeper request sent — waiting for Host, Admin, or Moderator approval');
    } else {
      flashFeedback(res.error || 'Could not request Scorekeeper access');
    }
  };

  return (
    <div className="spectator-shell" data-theme={state.ui?.theme || 'arena'}>
      <header
        className={`spectator-topbar ${
          isFullscreen ? `is-fullscreen-topbar ${isMenuRevealed ? 'is-revealed' : ''}` : ''
        }`}
        aria-label="Spectator Controls"
        {...barHoverHandlers}
      >
        <ViewNavBar
          activeMode="spectator"
          rolePerms={rolePerms}
          pendingRequestsCount={pendingRequestsCount}
          onNavigateMode={onNavigateMode}
          onOpenTournamentChooser={onOpenTournamentChooser}
          isFullscreen={isFullscreen}
        />

        <div className="spectator-submenu" role="toolbar" aria-label="Spectator Slide Controls">
          <div className="spectator-submenu-left">
            <div className="spectator-slide-pills" role="group" aria-label="Local Slides">
              {SLIDE_DEFINITIONS.map((slide) => (
                <button
                  key={slide.id}
                  type="button"
                  className={`spectator-slide-btn ${
                    activeLocalSlide === slide.id ? 'is-active' : ''
                  }`}
                  onClick={() => handleSelectSlide(slide.id)}
                  aria-pressed={activeLocalSlide === slide.id}
                >
                  {slide.shortLabel}
                </button>
              ))}
            </div>

            <label
              className={`spectator-sync-toggle ${syncPresentation ? 'is-synced' : ''}`}
              title="When enabled, automatically follows the live presentation slide"
            >
              <input
                type="checkbox"
                checked={syncPresentation}
                onChange={handleToggleSync}
              />
              <span>{syncPresentation ? '🔗 Sync Presentation' : '🔓 Sync Presentation'}</span>
            </label>

            {!canScoreRole &&
              (hasPendingRequest ? (
                <button
                  type="button"
                  className="btn-secondary btn-sm spectator-pending-btn"
                  disabled
                >
                  ⏳ Scorekeeper Requested
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-amber btn-sm"
                  onClick={handleRequestScorekeeper}
                >
                  🙋 Request Scorekeeper
                </button>
              ))}

            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen (hover top edge for menu)'}
            >
              {isFullscreen ? '⤢ Exit Full Screen' : '⛶ Full Screen'}
            </button>
          </div>

          <div className="spectator-right">
            <span className="spectator-role-pill">
              {effectiveRole === 'spectator'
                ? '👁️ SPECTATOR'
                : `${roleMeta.icon} ${roleMeta.label.toUpperCase()}`}
            </span>
          </div>
        </div>
      </header>

      {accessDeniedMsg && (
        <div className="spectator-denied-banner" role="alert">
          <span>
            <strong>🚫 Access Denied:</strong> {accessDeniedMsg.replace(/^Access denied\s*[—:-]?\s*/i, '')}
          </span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => setAccessDeniedMsg('')}
            aria-label="Dismiss access denied alert"
          >
            ✕
          </button>
        </div>
      )}

      {feedback && (
        <div className="spectator-toast" role="status" aria-live="polite">
          {feedback}
        </div>
      )}

      <div className="spectator-stage-host">
        <PresentationView
          state={spectatorState}
          embedded={true}
          forceSessionIdPill={isFullscreen}
        />
      </div>
    </div>
  );
}
