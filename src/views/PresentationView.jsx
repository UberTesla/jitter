import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  SLIDE_DEFINITIONS,
  THEME_OPTIONS,
  resolveEffectiveAmbiance,
  normalizeAutoRotateSlides,
  tournamentStore,
} from '../state/tournamentStore.js';
import { computeTournamentStats, formatTeamMembers } from '../engine/bracketGenerator.js';
import { formatMatchTimer, isMatchNearingEnd } from '../engine/scoringEngine.js';
import { renderLiveMessageText } from '../engine/grandmaVariables.js';
import { generateQrMatrix, qrMatrixToSvgPath } from '../engine/qrCode.js';
import { resolveShareOrigin } from '../engine/lanAddress.js';
import Scoreboard from '../components/Scoreboard.jsx';
import BracketView from '../components/BracketView.jsx';
import Ticker from '../components/Ticker.jsx';
import TournamentStatsPanel from '../components/TournamentStatsPanel.jsx';
import AutoFitBox from '../components/AutoFitBox.jsx';
import RetroTVCorner from '../components/RetroTVCorner.jsx';
import TitleAmbianceCanvas from '../components/TitleAmbianceCanvas.jsx';
import ViewNavBar from '../components/ViewNavBar.jsx';
import { useFullscreenMenu } from '../hooks/useFullscreenMenu.js';

const BASE_REF_WIDTH = 1600;
const BASE_REF_HEIGHT = 900;
const BASE_PORTRAIT_WIDTH = 900;
const BASE_PORTRAIT_HEIGHT = 1380;

/**
 * Clean, Distraction-Free Audience Presentation View (/present or Popup Window)
 * Fills 100% of the available host edge-to-edge on ANY screen or aspect ratio
 * (4K TV, 16:9, 16:10, ultrawide, tablet, or portrait phone) with zero scrollbars
 * and zero overflow by matching the virtual broadcast stage to the host dimensions.
 */
export default function PresentationView({
  state,
  rolePerms = null,
  onNavigateMode = null,
  onOpenTournamentChooser = null,
  embedded = false,
  forceSessionIdPill = false,
  liveAnnouncement = null,
}) {
  const showRoleMenu = Boolean(!embedded && (onNavigateMode || onOpenTournamentChooser));
  const tabId = tournamentStore.getTabId();
  const { isFullscreen, isMenuRevealed, toggleFullscreen, barHoverHandlers } = useFullscreenMenu({
    enabled: showRoleMenu,
  });
  const showStageSessionIdPill = Boolean(
    tabId && (!embedded ? isFullscreen || !showRoleMenu : forceSessionIdPill)
  );
  const baseSlide = state.presentation?.activeSlide || 'title';
  const autoRotateOn = Boolean(state.presentation?.autoRotate) && !embedded;
  const rotateList = React.useMemo(
    () => normalizeAutoRotateSlides(state.presentation?.autoRotateSlides),
    [state.presentation?.autoRotateSlides]
  );
  const rotateSec = Math.max(5, Number(state.presentation?.autoRotateSec) || 18);
  const [rotateIdx, setRotateIdx] = useState(0);
  // When operator explicitly selects a slide that is in rotateList, jump rotation to it immediately
  useEffect(() => {
    const idx = rotateList.indexOf(baseSlide);
    if (idx !== -1) setRotateIdx(idx);
  }, [baseSlide, rotateList]);
  useEffect(() => {
    if (!autoRotateOn || rotateList.length < 2) return undefined;
    const id = setInterval(() => setRotateIdx((n) => n + 1), rotateSec * 1000);
    return () => clearInterval(id);
  }, [autoRotateOn, rotateList, rotateSec]);
  const activeMatchForSlide = state.matches?.[state.activeMatchId] || null;
  const hasCompletedAnyMatch = React.useMemo(
    () => Object.values(state.matches || {}).some((m) => m && !m.isBye && m.completed),
    [state.matches]
  );
  const isBetweenMatches = Boolean(
    hasCompletedAnyMatch &&
      (!activeMatchForSlide ||
        activeMatchForSlide.completed ||
        (!activeMatchForSlide.started &&
          (activeMatchForSlide.score1 || 0) === 0 &&
          (activeMatchForSlide.score2 || 0) === 0))
  );
  // Allow operator to manually switch to any slide (like Bracket or Split) even while between matches
  const [manualBetweenOverride, setManualBetweenOverride] = useState(false);
  const prevBaseSlideRef = useRef(baseSlide);
  const prevBetweenRef = useRef(isBetweenMatches);
  useEffect(() => {
    if (isBetweenMatches && !prevBetweenRef.current) {
      // Freshly entered between-matches window -> engage auto-spotlight
      setManualBetweenOverride(false);
    } else if (!isBetweenMatches) {
      setManualBetweenOverride(false);
    } else if (baseSlide !== prevBaseSlideRef.current) {
      // Operator explicitly clicked a slide while between matches -> honor it!
      setManualBetweenOverride(true);
    }
    prevBaseSlideRef.current = baseSlide;
    prevBetweenRef.current = isBetweenMatches;
  }, [baseSlide, isBetweenMatches]);

  const forceSpotlightBetween = Boolean(
    state.presentation?.spotlightBetweenMatches &&
      isBetweenMatches &&
      !manualBetweenOverride &&
      !embedded &&
      baseSlide !== 'title' &&
      baseSlide !== 'bracket'
  );
  const targetSlide = forceSpotlightBetween
    ? 'spotlight'
    : autoRotateOn && rotateList.length > 0
      ? rotateList[rotateIdx % rotateList.length]
      : baseSlide;
  const [renderedSlide, setRenderedSlide] = useState(targetSlide);
  const [stageMetrics, setStageMetrics] = useState({
    width: BASE_REF_WIDTH,
    height: BASE_REF_HEIGHT,
    scale: 1,
    isPortrait: false,
  });
  const slideStageRef = useRef(null);
  const viewportHostRef = useRef(null);

  // Dynamically match host aspect ratio so rendered stage ALWAYS fits 100% with zero scroll/overflow
  useLayoutEffect(() => {
    const updateMetrics = () => {
      const host = viewportHostRef.current;
      const vw = host?.clientWidth || window.innerWidth;
      const vh = host?.clientHeight || window.innerHeight;
      if (!vw || !vh) return;

      const isPortrait = vw / vh < 1.02;
      const refW = isPortrait ? BASE_PORTRAIT_WIDTH : BASE_REF_WIDTH;
      const refH = isPortrait ? BASE_PORTRAIT_HEIGHT : BASE_REF_HEIGHT;
      const scale = Math.max(0.12, Math.min(vw / refW, vh / refH));

      setStageMetrics({
        width: vw / scale,
        height: vh / scale,
        scale,
        isPortrait,
      });
    };

    updateMetrics();
    window.addEventListener('resize', updateMetrics);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && viewportHostRef.current) {
      ro = new ResizeObserver(updateMetrics);
      ro.observe(viewportHostRef.current);
    }
    return () => {
      window.removeEventListener('resize', updateMetrics);
      if (ro) ro.disconnect();
    };
  }, [showRoleMenu, embedded, isFullscreen]);

  // Smoothly transition slides with document.startViewTransition when supported
  useEffect(() => {
    if (targetSlide === renderedSlide) return;

    if (!document.startViewTransition) {
      setRenderedSlide(targetSlide);
      requestAnimationFrame(() => {
        slideStageRef.current?.focus({ preventScroll: true });
      });
      return;
    }

    const transition = document.startViewTransition(() => {
      flushSync(() => {
        setRenderedSlide(targetSlide);
      });
    });

    transition.finished.finally(() => {
      slideStageRef.current?.focus({ preventScroll: true });
    });
  }, [targetSlide, renderedSlide]);

  const playerMap = React.useMemo(() => {
    const map = new Map();
    for (const p of state.players || []) map.set(p.id, p);
    return map;
  }, [state.players]);

  const activeMatch = state.matches?.[state.activeMatchId] || null;
  const champion = state.championId ? playerMap.get(state.championId) : null;
  const stats = React.useMemo(() => computeTournamentStats(state), [state]);
  const showMiniBracket = state.ui?.showMiniBracket !== false;
  const onDeckMode = state.presentation?.onDeckMode || 'nearing_end';
  const showOnDeckBanner =
    stats.upNext.length > 0 &&
    renderedSlide !== 'title' &&
    renderedSlide !== 'split' &&
    (onDeckMode === 'show' ||
      (onDeckMode === 'nearing_end' && isMatchNearingEnd(activeMatch, state.rules)));
  const showCorner = Boolean(state.ui?.showCornerScene);
  const cornerScale = state.ui?.cornerScale ?? 1.0;
  const isTeams = state.entryMode === 'teams';
  const entityLabelUpper = isTeams ? 'TEAMS' : 'PLAYERS';

  const openingMatchups = React.useMemo(() => {
    return Object.values(state.matches || {})
      .filter((m) => !m.isBye && !m.completed && m.player1Id && m.player2Id)
      .sort((a, b) => a.round - b.round || a.matchNumber - b.matchNumber)
      .slice(0, 4);
  }, [state.matches]);

  const getPlayerLabel = (id, fallback) => {
    if (!id) return fallback || 'TBD';
    const p = playerMap.get(id);
    return p ? `#${p.seed} ${p.name}` : fallback || 'TBD';
  };

  // Reserve bottom-right width/height for CRT corner when visible (scaled down on portrait so content stays huge)
  const effectiveCornerScale = stageMetrics.isPortrait
    ? Math.min(cornerScale, 0.72)
    : cornerScale;
  const cornerReserveW =
    showCorner && !stageMetrics.isPortrait
      ? Math.min(Math.round(stageMetrics.width * 0.42), Math.round(620 * effectiveCornerScale) + 28)
      : 0;
  const cornerReserveH = showCorner
    ? Math.min(Math.round(stageMetrics.height * 0.34), Math.round(310 * effectiveCornerScale))
    : 0;

  const activeTheme = state.ui?.theme || 'arena';
  const themeDef = THEME_OPTIONS.find((t) => t.id === activeTheme) || THEME_OPTIONS[0];
  const effectiveAmbiance = resolveEffectiveAmbiance(
    state.presentation?.titleAmbiance || 'auto',
    activeTheme
  );
  const ambianceIntensity = state.presentation?.ambianceIntensity || 'medium';

  // Resolve active presenter titlebar announcement (either live ephemeral or sticky/scheduled banner)
  const [bannerNowMs, setBannerNowMs] = useState(() => tournamentStore.getServerNow());
  const persistedBanner = state.presentation?.activeBanner || null;
  const candidateBanner = React.useMemo(() => {
    const candidates = [liveAnnouncement, persistedBanner].filter(
      (b) => b && b.message && (!b.dismissAt || bannerNowMs < Number(b.dismissAt))
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (Number(b.sentAt) || 0) - (Number(a.sentAt) || 0));
    return candidates[0];
  }, [liveAnnouncement, persistedBanner, bannerNowMs]);

  const bannerNeedsTick = Boolean(
    candidateBanner?.dismissAt ||
      candidateBanner?.countdownTargetAt ||
      candidateBanner?.liveTemplate?.includes('[[CD:')
  );
  useEffect(() => {
    if (!bannerNeedsTick) return undefined;
    setBannerNowMs(tournamentStore.getServerNow());
    const id = setInterval(() => setBannerNowMs(tournamentStore.getServerNow()), 250);
    return () => clearInterval(id);
  }, [candidateBanner?.id, bannerNeedsTick]);

  const activePresenterBanner =
    candidateBanner && (!candidateBanner.dismissAt || bannerNowMs < Number(candidateBanner.dismissAt))
      ? candidateBanner
      : null;

  // Compact Join QR Code in upper-right of Presenter stage
  const [qrServerInfo, setQrServerInfo] = useState(
    () => tournamentStore.getSyncMeta()?.remoteSync?.serverInfo || null
  );
  useEffect(() => {
    if (embedded || qrServerInfo?.lanAddresses?.length > 0) return undefined;
    let active = true;
    fetch('/__server-info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && data && typeof data === 'object') setQrServerInfo(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [embedded, qrServerInfo]);

  const joinQrData = React.useMemo(() => {
    if (embedded || !state.joinCode) return null;
    try {
      const meta = tournamentStore.getSyncMeta()?.remoteSync;
      const origin = resolveShareOrigin(meta?.serverInfo || qrServerInfo, meta?.customServerUrl);
      if (!origin) return null;
      const url = `${origin}/?join=${encodeURIComponent(state.joinCode)}`;
      const { size, modules } = generateQrMatrix(url);
      return { size, path: qrMatrixToSvgPath(modules), url };
    } catch {
      return null;
    }
  }, [embedded, state.joinCode, qrServerInfo]);

  const joinQrNode = joinQrData ? (
    <div className="pres-join-qr-inline" aria-label="Scan QR code to join tournament">
      <span className="pres-join-qr-label">JOIN</span>
      <div className="pres-join-qr-box">
        <svg
          viewBox={`-2 -2 ${joinQrData.size + 4} ${joinQrData.size + 4}`}
          shapeRendering="crispEdges"
          aria-hidden="true"
        >
          <rect
            x="-2"
            y="-2"
            width={joinQrData.size + 4}
            height={joinQrData.size + 4}
            fill="#ffffff"
          />
          <path d={joinQrData.path} fill="#0f172a" />
        </svg>
      </div>
    </div>
  ) : null;

  const onDeckBannerNode = showOnDeckBanner ? (
    <div
      className={`pres-ondeck-banner ${renderedSlide === 'arena'
        ? showMiniBracket
          ? 'is-under-scoreboard'
          : 'is-under-scoreboard is-corner-safe'
        : 'is-stage-bottom is-corner-safe'
        }`}
      role="region"
      aria-label="On Deck Matchups"
    >
      <span className="pres-ondeck-tag">
        <span className="pres-ondeck-dot" aria-hidden="true" />
        ON DECK
      </span>
      <div className="pres-ondeck-items">
        {stats.upNext.slice(0, 2).map((m, idx) => (
          <div key={m.id} className={`pres-ondeck-item ${idx === 0 ? 'is-next' : ''}`}>
            <span className="pod-label">{idx === 0 ? 'NEXT UP' : m.label}</span>
            <strong className="pod-matchup">
              {getPlayerLabel(m.player1Id, m.source1Label)} <em>vs</em>{' '}
              {getPlayerLabel(m.player2Id, m.source2Label)}
            </strong>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  const handleStageClick = (e) => {
    if (embedded) return;
    if (e.target?.closest?.('button, a, input, select, textarea, [role="button"], dialog')) {
      return;
    }
    toggleFullscreen();
  };

  const stageContent = (
    <div
      ref={viewportHostRef}
      className={`presentation-viewport ${embedded || (showRoleMenu && !isFullscreen) ? 'has-role-topbar' : ''
        }`}
      data-theme={activeTheme}
      onClick={handleStageClick}
    >
      <div
        className={`presentation-stage-scaler slide-mode-${renderedSlide} ${stageMetrics.isPortrait ? 'is-portrait-stage' : ''
          }`}
        data-theme={activeTheme}
        style={{
          width: `${stageMetrics.width}px`,
          height: `${stageMetrics.height}px`,
          transform: `scale(${stageMetrics.scale})`,
          '--corner-reserve-w': `${cornerReserveW}px`,
          '--corner-reserve-h': `${cornerReserveH}px`,
        }}
      >
        {/* Configurable Ambiance Layer (Applies to ALL Presentation Slides) */}
        {effectiveAmbiance !== 'none' && (
          <TitleAmbianceCanvas effect={effectiveAmbiance} intensity={ambianceIntensity} />
        )}

        {/* Clean Audience Top Header — replaced by Announcement Banner when active */}
        {activePresenterBanner ? (
          <header className="presentation-header is-announcement-banner" role="status" aria-live="polite">
            <div className="pres-announcement-wrap">
              <span className="pres-announcement-pill">📢 ANNOUNCEMENT</span>
              <span className="pres-announcement-text">
                {renderLiveMessageText(activePresenterBanner, bannerNowMs)}
              </span>
            </div>
            <div className="pres-meta-right">
              {activePresenterBanner.dismissAt ? (
                <span className="pres-announcement-meta">
                  ⏱ UNTIL{' '}
                  {(
                    activePresenterBanner.dismissalLabel ||
                    new Date(activePresenterBanner.dismissAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                      hour12: true,
                    })
                  ).toUpperCase()}
                </span>
              ) : activePresenterBanner.sticky ? (
                <span className="pres-announcement-meta">📌 PINNED</span>
              ) : null}
              {showStageSessionIdPill && (
                <span className="pres-session-id-pill" title={`Current Session ID: ${tabId}`}>
                  {tabId}
                </span>
              )}
              {joinQrNode}
            </div>
          </header>
        ) : (
          <header className="presentation-header">
            <div className="pres-brand">
              <h1 className="pres-title">
                {themeDef.icon} {state.tournamentName}
              </h1>
            </div>

            <div className="pres-meta-right">
              <span className="pres-format-badge">
                {isTeams ? 'DOUBLES · ' : ''}
                {state.format === 'double' ? 'DOUBLE ELIMINATION' : 'SINGLE ELIMINATION'} ·{' '}
                {state.playerCount} {entityLabelUpper} · RACE TO {state.rules.targetPoints}
                {state.rules?.skunkEnabled ? ` · SKUNK ${state.rules.skunkScore ?? 7}–0` : ''}
                {state.rules?.deadMansServe ? " · DEAD MAN'S SERVE" : ''}
                {(state.rules.tableCount ?? 1) > 1 ? ` · ${state.rules.tableCount} TABLES` : ''}
              </span>
              <span className="pres-slide-indicator">
                {SLIDE_DEFINITIONS.find((s) => s.id === renderedSlide)?.label}
              </span>
              {showStageSessionIdPill && (
                <span className="pres-session-id-pill" title={`Current Session ID: ${tabId}`}>
                  {tabId}
                </span>
              )}
              {joinQrNode}
            </div>
          </header>
        )}

        {/* Main Presentation Stage */}
        <main
          ref={slideStageRef}
          tabIndex={-1}
          className="presentation-stage"
          aria-live="polite"
        >
          {/* SLIDE 1: Pre-Tournament Title Screen */}
          {renderedSlide === 'title' && (
            <div className="slide-title-layout">
              <div className="title-hero-block">
                <div className="title-kicker-row">
                  <span className="title-pill-gold">
                    🏓{' '}
                    {isTeams
                      ? 'OFFICIAL DOUBLES / TEAMS CHAMPIONSHIP'
                      : 'OFFICIAL TABLE TENNIS CHAMPIONSHIP'}
                  </span>
                  <span className="title-pill-blue">
                    {state.playerCount} {entityLabelUpper} ·{' '}
                    {state.format === 'double' ? 'DOUBLE ELIMINATION' : 'SINGLE ELIMINATION'}
                  </span>
                </div>

                <h2 className="title-mega-heading">{state.tournamentName}</h2>
                {Boolean(state.presentation?.titleSubtitle?.trim()) && (
                  <p className="title-sub-banner">{state.presentation.titleSubtitle}</p>
                )}

                <div className="title-rules-strip">
                  <div className="title-rule-chip">
                    <span className="tr-label">GAME TO</span>
                    <strong>{state.rules.targetPoints} PTS</strong>
                  </div>
                  <div className="title-rule-chip">
                    <span className="tr-label">SERVE ROTATION</span>
                    <strong>EVERY {state.rules.serveRotation}</strong>
                  </div>
                  <div className="title-rule-chip">
                    <span className="tr-label">WIN CONDITION</span>
                    <strong>WIN BY {state.rules.winBy ?? 2}</strong>
                  </div>
                  {state.rules?.skunkEnabled && (
                    <div className="title-rule-chip">
                      <span className="tr-label">SKUNK RULE</span>
                      <strong>🦨 {state.rules.skunkScore ?? 7}–0 SHUTOUT</strong>
                    </div>
                  )}
                  {state.rules?.deadMansServe && (
                    <div className="title-rule-chip">
                      <span className="tr-label">GAME POINT RULE</span>
                      <strong>DEAD MAN&apos;S SERVE</strong>
                    </div>
                  )}
                  <div className="title-rule-chip">
                    <span className="tr-label">TOTAL MATCHES</span>
                    <strong>{stats.totalMatches}</strong>
                  </div>
                  {(state.rules.tableCount ?? 1) > 1 && (
                    <div className="title-rule-chip">
                      <span className="tr-label">TABLES</span>
                      <strong>{state.rules.tableCount}</strong>
                    </div>
                  )}
                </div>

                {openingMatchups.length > 0 && (
                  <div className="title-opening-block">
                    <div className="title-section-kicker">OPENING MATCHUPS ON DECK</div>
                    <div className="title-matchups-grid">
                      {openingMatchups.map((m, idx) => (
                        <div
                          key={m.id}
                          className={`title-matchup-pill ${idx === 0 ? 'is-first' : ''}`}
                        >
                          <span className="tm-tag">{idx === 0 ? 'FIRST UP' : m.label}</span>
                          <span className="tm-names">
                            {getPlayerLabel(m.player1Id)} <em>vs</em>{' '}
                            {getPlayerLabel(m.player2Id)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <aside className="title-roster-card" aria-label="Tournament Competitors">
                <div className="title-roster-head">
                  <h3>{isTeams ? 'SEEDED TEAMS' : 'SEEDED COMPETITORS'}</h3>
                  <span>
                    {state.players.length} {entityLabelUpper}
                  </span>
                </div>
                <AutoFitBox className="title-roster-fit" align="left">
                  <div
                    className={`title-roster-grid ${state.players.length > 12 ? 'is-dense' : ''
                      }`}
                  >
                    {state.players.map((p) => (
                      <div key={p.id} className="title-roster-item">
                        <span className="tr-seed">#{p.seed}</span>
                        <div className="tr-name-stack">
                          <span className="tr-name">{p.name}</span>
                          {isTeams && (
                            <span className="tr-members">{formatTeamMembers(p, ' & ')}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </AutoFitBox>
              </aside>
            </div>
          )}

          {/* SLIDE 2: Live Match Arena (Hero Scoreboard + On Deck + Live Mini Bracket) */}
          {renderedSlide === 'arena' && (
            <div
              className={`slide-arena-layout ${showMiniBracket ? 'with-mini-bracket' : ''} ${showOnDeckBanner ? 'with-ondeck' : ''
                }`}
            >
              {Boolean(state.presentation?.arenaSubtitle?.trim()) && (
                <p className="slide-optional-subtitle">{state.presentation.arenaSubtitle}</p>
              )}
              <div className="arena-scoreboard-region">
                <Scoreboard
                  match={activeMatch}
                  players={state.players}
                  rules={state.rules}
                  entryMode={state.entryMode || 'singles'}
                  scoreFont={state.ui?.scoreFont || 'barlow'}
                  mode="presentation"
                />
              </div>

              {onDeckBannerNode}

              {showMiniBracket && (
                <div className="arena-minibracket-region">
                  <Ticker state={state} showLosers={false} bracketTitle="TOURNAMENT MINI BRACKET" />

                </div>
              )}
            </div>
          )}

          {/* SLIDE 3: Full Tournament Bracket Overview (Auto-Fits Any Player Count!) */}
          {renderedSlide === 'bracket' && (
            <div className="slide-bracket-layout">
              {Boolean(state.presentation?.bracketSubtitle?.trim()) && (
                <p className="slide-optional-subtitle">{state.presentation.bracketSubtitle}</p>
              )}
              <AutoFitBox
                className="full-bracket-autofit"
                align="center"
                fillWidth={true}
                maxScale={1.15}
              >
                <BracketView
                  matches={state.matches}
                  players={state.players}
                  format={state.format}
                  entryMode={state.entryMode || 'singles'}
                  activeMatchId={state.activeMatchId}
                  championId={state.championId}
                  interactive={false}
                  noScroll={true}
                  bracketFilter={state.presentation?.bracketViewFilter || 'both'}
                  compact={state.playerCount > 8}
                />
              </AutoFitBox>
            </div>
          )}

          {/* SLIDE 4: Split View (Scoreboard + Mini Bracket + Up Next + Ticker) */}
          {renderedSlide === 'split' && (
            <div className="slide-split-wrapper">
              {Boolean(state.presentation?.splitSubtitle?.trim()) && (
                <p className="slide-optional-subtitle">{state.presentation.splitSubtitle}</p>
              )}
              <div className="slide-split-layout">
                <div className="split-primary-col">
                  <Scoreboard
                    match={activeMatch}
                    players={state.players}
                    rules={state.rules}
                    entryMode={state.entryMode || 'singles'}
                    scoreFont={state.ui?.scoreFont || 'barlow'}
                    mode="compact"
                  />

                  {showMiniBracket && (
                    <div className="split-minibracket-wrap">
                      <Ticker state={state} bracketTitle="BRACKET PATH" />
                    </div>
                  )}
                </div>

                <aside className="split-queue-col" aria-label="On Deck Match Queue">
                  <div className="queue-header">
                    <span className="queue-dot" aria-hidden="true" />
                    <h2>ON DECK / NEXT UP</h2>
                  </div>

                  {stats.upNext.length === 0 ? (
                    <div className="queue-empty">
                      <p>All currently ready matches are on the main table.</p>
                    </div>
                  ) : (
                    <div className="queue-list">
                      {stats.upNext.map((m, idx) => (
                        <div key={m.id} className={`queue-card ${idx === 0 ? 'is-next' : ''}`}>
                          <div className="queue-card-top">
                            <span className="queue-round">{m.roundLabel}</span>
                            <span className="queue-tag">{idx === 0 ? 'NEXT TABLE' : m.label}</span>
                          </div>
                          <div className="queue-matchup">
                            <span>{getPlayerLabel(m.player1Id, m.source1Label)}</span>
                            <span className="queue-vs">vs</span>
                            <span>{getPlayerLabel(m.player2Id, m.source2Label)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="queue-progress-footer">
                    <span>Tournament Progress</span>
                    <strong>
                      {stats.completedCount} / {stats.totalMatches} Matches Complete
                    </strong>
                  </div>
                </aside>
              </div>
            </div>
          )}

          {/* SLIDE 5: Spotlight & Live Tournament Stats Screen */}
          {renderedSlide === 'spotlight' && (
            <div className="slide-spotlight-layout">
              <div className="spotlight-podium-col">
                <div
                  className={`spotlight-hero-card ${champion ? 'is-champion' : 'is-intermission'}`}
                >
                  <div className="spotlight-trophy-glow" aria-hidden="true">
                    {champion ? '🏆' : '🏓'}
                  </div>
                  <div className="spotlight-kicker">
                    {champion
                      ? isTeams
                        ? 'OFFICIAL CHAMPIONSHIP TEAM'
                        : 'OFFICIAL TOURNAMENT CHAMPION'
                      : 'SPOTLIGHT · TOURNAMENT BREAK'}
                  </div>
                  <h2 className="spotlight-headline">
                    {champion ? champion.name : state.tournamentName}
                  </h2>
                  {champion && isTeams && (
                    <div className="spotlight-team-members">
                      {formatTeamMembers(champion, ' & ')}
                    </div>
                  )}
                  {champion ? (
                    <p className="spotlight-subcopy">
                      Seed #{champion.seed} conquered the {state.playerCount}-
                      {isTeams ? 'team' : 'player'}{' '}
                      {state.format === 'double' ? 'Double Elimination' : 'Single Elimination'}{' '}
                      championship!
                    </p>
                  ) : (
                    Boolean(state.presentation?.intermissionMessage?.trim()) && (
                      <p className="spotlight-subcopy">
                        {state.presentation.intermissionMessage}
                      </p>
                    )
                  )}

                  {/* Last Completed Match Result */}
                  {stats.recentCompleted.length > 0 && (() => {
                    const lastM = stats.recentCompleted[0];
                    const lp1 = playerMap.get(lastM.player1Id);
                    const lp2 = playerMap.get(lastM.player2Id);
                    const p1Won = lastM.winnerId === lastM.player1Id;
                    return (
                      <div className="spotlight-last-match" aria-label="Last Match Result">
                        <span className="slm-kicker">
                          FINAL · {lastM.roundLabel} ({lastM.label})
                        </span>
                        <div className="slm-scoreline">
                          <span className={`slm-player ${p1Won ? 'is-winner' : ''}`}>
                            {p1Won ? '🏆 ' : ''}
                            {lp1?.name || 'Player 1'}
                          </span>
                          <strong className="slm-score">
                            {lastM.score1} – {lastM.score2}
                          </strong>
                          <span className={`slm-player ${!p1Won ? 'is-winner' : ''}`}>
                            {!p1Won ? '🏆 ' : ''}
                            {lp2?.name || 'Player 2'}
                          </span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Tournament Completion Progress Bar */}
                  <div className="spotlight-progress-wrap">
                    <div className="spotlight-progress-head">
                      <span>TOURNAMENT PROGRESS</span>
                      <strong>
                        {stats.completedCount} / {stats.totalMatches} Matches ({stats.progressPct}%)
                      </strong>
                    </div>
                    <div className="spotlight-progress-track" aria-hidden="true">
                      <div
                        className="spotlight-progress-fill"
                        style={{ width: `${stats.progressPct}%` }}
                      />
                    </div>
                  </div>

                  <div className="spotlight-stats-grid">
                    <div className="stat-box">
                      <span className="stat-val">{stats.totalPointsPlayed}</span>
                      <span className="stat-lbl">Total Points</span>
                    </div>
                    <div className="stat-box">
                      <span className="stat-val">
                        {stats.avgPointsPerMatch > 0 ? stats.avgPointsPerMatch : '—'}
                      </span>
                      <span className="stat-lbl">Avg Pts / Match</span>
                    </div>
                    <div className="stat-box">
                      <span className="stat-val">{stats.closestMarginCount}</span>
                      <span className="stat-lbl">
                        {state.rules.winBy ?? 2}-Pt Nail-Biters
                      </span>
                    </div>
                    <div className="stat-box">
                      <span className="stat-val">
                        {stats.avgMatchDurationMs > 0
                          ? formatMatchTimer(stats.avgMatchDurationMs)
                          : `${stats.deuceMatchesCount}`}
                      </span>
                      <span className="stat-lbl">
                        {stats.avgMatchDurationMs > 0 ? 'Avg Match Time' : 'Deuce Thrillers'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Column: Broadcast Intermission Stats Panel (reserves bottom space for Grandma Corner) */}
              <aside className="spotlight-stats-panel" aria-label="Tournament Statistics">
                <div className="ssp-panel-header">
                  <div className="ssp-panel-title-wrap">
                    <span className="ssp-panel-dot" aria-hidden="true" />
                    <h3>TOURNAMENT STATS &amp; LEADERS</h3>
                  </div>
                  <span className="ssp-panel-badge">
                    {stats.completedCount > 0 ? 'LIVE TELEMETRY' : 'PRE-MATCH'}
                  </span>
                </div>

                <TournamentStatsPanel
                  stats={stats}
                  playerMap={playerMap}
                  isTeams={isTeams}
                  rules={state.rules}
                  variant="full"
                  extras={false}
                />
              </aside>
            </div>
          )}
          {renderedSlide !== 'arena' && onDeckBannerNode}
        </main>

        {/* Bottom-Right Animated 4:3 CRT TV & Grandma Scene (normal corner on ALL slides, including Intermission) */}
        <RetroTVCorner
          grandmaConfig={state.grandma}
          tvMuted={state.ui.tvMuted}
          hasCustomTvMedia={state.ui.hasCustomTvMedia}
          tvMediaSyncKey={`${state.ui.hasCustomTvMedia ? '1' : '0'}:${state.ui.tvMediaLabel || ''}:${state.ui.tvMediaUpdatedAt || 0}`}
          visible={showCorner}
          scale={effectiveCornerScale}
          opacity={state.ui?.cornerOpacity ?? 1.0}
          bubbleScale={state.ui?.bubbleScale ?? 1.0}
          variant="corner"
          inStage={true}
          allowLocalToggle={rolePerms?.role !== 'presenter'}
        />
      </div>
    </div>
  );

  if (!showRoleMenu) {
    return stageContent;
  }

  return (
    <div className="presentation-with-nav-shell" data-theme={activeTheme}>
      <header
        className={`presentation-role-topbar ${isFullscreen ? `is-fullscreen-topbar ${isMenuRevealed ? 'is-revealed' : ''}` : ''
          }`}
        aria-label="Presentation Navigation"
        {...barHoverHandlers}
      >
        <ViewNavBar
          activeMode="present"
          rolePerms={rolePerms}
          pendingRequestsCount={
            (state.scorekeeperRequests?.length || 0) + (state.joinRequests?.length || 0)
          }
          onNavigateMode={onNavigateMode}
          onOpenTournamentChooser={onOpenTournamentChooser}
          isFullscreen={isFullscreen}
        >
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen (hover top edge for menu)'}
          >
            {isFullscreen ? '⤢ Exit Full Screen' : '⛶ Full Screen'}
          </button>
        </ViewNavBar>
      </header>
      {stageContent}
    </div>
  );
}
