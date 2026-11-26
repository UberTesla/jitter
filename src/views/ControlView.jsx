import React, { useEffect, useRef, useState } from 'react';
import { tournamentStore } from '../state/tournamentStore.js';
import { formatTeamMembers } from '../engine/bracketGenerator.js';
import { hasGrandmaVariables, resolveGrandmaPhrase } from '../engine/grandmaVariables.js';
import {
  saveTvPlaylistItemBlob,
  deleteTvPlaylistItemBlob,
  parseGifDurationSec,
  resolveEmbedStreamUrl,
} from '../state/mediaStore.js';
import { trackUsageEvent } from '../engine/usageAnalytics.js';
import Scoreboard from '../components/Scoreboard.jsx';
import BracketView from '../components/BracketView.jsx';
import RetroTVCorner from '../components/RetroTVCorner.jsx';
import PlayerSetupModal from '../components/PlayerSetupModal.jsx';
import PhraseManagerModal from '../components/PhraseManagerModal.jsx';
import SlidePreview from '../components/SlidePreview.jsx';
import DebounceOverrideDialog from '../components/DebounceOverrideDialog.jsx';
import MatchSwitchConfirmDialog from '../components/MatchSwitchConfirmDialog.jsx';
import EditCompletedMatchDialog from '../components/EditCompletedMatchDialog.jsx';
import GrandmaPhraseInput from '../components/GrandmaPhraseInput.jsx';
import ViewNavBar from '../components/ViewNavBar.jsx';
import { usePendingPointRemoval } from '../components/PointRemovalTooltip.jsx';

const QUICK_CUE_QUOTES = [
  'Nice serve!',
  'What a rally!',
  'Deuce! Hold onto your hat!',
  'Match point — don\'t blink!',
  'Unbelievable spin on that shot!',
  'Frank would\'ve flipped the table!',
];

export default function ControlView({
  state,
  syncMeta,
  rolePerms,
  onNavigateMode,
  onOpenTournamentChooser,
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [phrasesOpen, setPhrasesOpen] = useState(false);
  const [editCompletedOpen, setEditCompletedOpen] = useState(false);
  const [debounceRequest, setDebounceRequest] = useState(null);
  const [switchConfirmRequest, setSwitchConfirmRequest] = useState(null);
  const [liveQuoteInput, setLiveQuoteInput] = useState('');
  const [mediaRefreshToken, setMediaRefreshToken] = useState(0);
  const [showAddUrlRow, setShowAddUrlRow] = useState(false);
  const [tvUrlInput, setTvUrlInput] = useState('');
  const [tvUrlNameInput, setTvUrlNameInput] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  const fileInputRef = useRef(null);
  const toastTimerRef = useRef(null);

  const activeMatch = state.matches?.[state.activeMatchId] || null;
  const grandmaEnabled = state.rules?.grandmaEnabled !== false;
  const cornerScale = state.ui?.cornerScale ?? 1.0;
  const cornerOpacity = state.ui?.cornerOpacity ?? 1.0;
  const bubbleScale = state.ui?.bubbleScale ?? 1.0;
  const collapsed = state.ui?.collapsedPanels || {};
  const isTeams = state.entryMode === 'teams';
  const entityNoun = isTeams ? 'Teams' : 'Players';
  const isStudio = syncMeta?.syncMode === 'studio';
  const hasUnpublished = Boolean(syncMeta?.hasUnpublishedChanges);

  const showToast = (msg) => {
    setToastMessage(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(''), 2800);
  };

  const resolveSlotName = (slot) => {
    const id = slot === 1 ? activeMatch?.player1Id : activeMatch?.player2Id;
    const found = (state.players || []).find((p) => p.id === id);
    return found?.name || (isTeams ? `Team ${slot}` : `Player ${slot}`);
  };

  const { pendingRemoval, requestRemovePoint, cancelPendingRemoval } = usePendingPointRemoval({
    matchId: activeMatch?.id,
    score1: activeMatch?.score1 || 0,
    score2: activeMatch?.score2 || 0,
    onCommit: (slot, count, playerName) => {
      for (let i = 0; i < count; i += 1) {
        tournamentStore.subtractPoint(slot);
      }
      showToast(`Removed ${count} ${count === 1 ? 'point' : 'points'} from ${playerName}`);
    },
    onCancel: (entry) => {
      showToast(`Cancelled removing point from ${entry.playerName}`);
    },
  });

  const handleScorePoint = (slot) => {
    cancelPendingRemoval(true);
    const res = tournamentStore.addPoint(slot, { requireStarted: true });
    if (res && res.requiresStart) {
      showToast('Click ▶ Begin Match before scoring points');
      return;
    }
    if (res && !res.accepted && res.remainingMs > 0) {
      setDebounceRequest({
        id: Date.now(),
        slot,
        playerName: resolveSlotName(slot),
        remainingSec: res.remainingSec,
      });
    }
  };

  const handleConfirmDebounceOverride = (slot) => {
    setDebounceRequest(null);
    tournamentStore.addPoint(slot, { bypassDebounce: true, requireStarted: true });
    showToast(`+1 point added for ${resolveSlotName(slot)} (debounce override)`);
  };

  const buildMatchSummary = (m) => {
    const p1 = (state.players || []).find((p) => p.id === m?.player1Id) || null;
    const p2 = (state.players || []).find((p) => p.id === m?.player2Id) || null;
    return {
      label: m?.label || 'Match',
      side1Name: p1?.name || m?.source1Label || (isTeams ? 'Awaiting Team' : 'Awaiting Player'),
      side1Members: isTeams && p1 ? formatTeamMembers(p1, ' & ') : '',
      side2Name: p2?.name || m?.source2Label || (isTeams ? 'Awaiting Team' : 'Awaiting Player'),
      side2Members: isTeams && p2 ? formatTeamMembers(p2, ' & ') : '',
      score1: m?.score1 || 0,
      score2: m?.score2 || 0,
      completed: Boolean(m?.completed),
    };
  };

  const handleRequestSelectMatch = (matchId) => {
    if (!matchId || matchId === state.activeMatchId) return;
    const targetMatch = state.matches?.[matchId];
    if (!targetMatch || targetMatch.isBye) return;

    const currentInSession = Boolean(
      activeMatch &&
      !activeMatch.completed &&
      ((activeMatch.score1 || 0) > 0 || (activeMatch.score2 || 0) > 0)
    );

    if (currentInSession) {
      setSwitchConfirmRequest({
        targetMatchId: matchId,
        current: buildMatchSummary(activeMatch),
        target: buildMatchSummary(targetMatch),
      });
      return;
    }

    tournamentStore.selectMatch(matchId);
    const isUnstarted =
      !targetMatch.started &&
      !targetMatch.completed &&
      (targetMatch.score1 || 0) === 0 &&
      (targetMatch.score2 || 0) === 0;
    showToast(
      isUnstarted
        ? `Previewing ${targetMatch.label} locally — press ▶ Begin Match to sync live`
        : `Loaded match ${targetMatch.label} onto scoreboard`
    );
  };

  const handleConfirmSwitchMatch = (matchId) => {
    setSwitchConfirmRequest(null);
    tournamentStore.selectMatch(matchId, { allowDuringGame: true });
    showToast(`Switched to match ${state.matches[matchId]?.label}`);
  };

  // Global keyboard shortcuts: 1 (Side 1 +1), 2 (Side 2 +1)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (setupOpen || phrasesOpen || switchConfirmRequest || editCompletedOpen) return;
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '1') {
        e.preventDefault();
        handleScorePoint(1);
      } else if (e.key === '2') {
        e.preventDefault();
        handleScorePoint(2);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setupOpen, phrasesOpen, switchConfirmRequest, editCompletedOpen, activeMatch, state.players]);

  const handleToggleSyncMode = () => {
    const next = tournamentStore.toggleSyncMode();
    if (next === 'studio') {
      showToast('Studio Mode ON — edit safely in Preview, then click Push Live');
    } else {
      showToast('LIVE Mode ON — changes update the Presentation screen in real time');
    }
  };

  const handlePushLive = () => {
    tournamentStore.publishStudioToLive();
    showToast('▶ Pushed staged preview live to Presentation View!');
  };

  const handleTriggerLiveQuote = (e) => {
    e.preventDefault();
    const cleaned = liveQuoteInput.trim();
    if (!cleaned) return;
    const resolved = resolveGrandmaPhrase(cleaned, state);
    tournamentStore.triggerLiveQuote(cleaned);
    setLiveQuoteInput('');
    showToast(`Grandma live cue sent: "${resolved}"`);
  };

  const handleQuickCue = (quote) => {
    const resolved = resolveGrandmaPhrase(quote, state);
    tournamentStore.triggerLiveQuote(quote);
    showToast(`Grandma live cue: "${resolved}"`);
  };

  const tvPlaylist = Array.isArray(state.ui?.tvPlaylist) && state.ui.tvPlaylist.length > 0
    ? state.ui.tvPlaylist
    : [{ id: 'builtin-sitcom', kind: 'sitcom', name: 'Retro Sitcom (Built-in)', durationSec: 20 }];
  const tvPlaylistIndex = Math.min(
    Math.max(0, Number(state.ui?.tvPlaylistIndex) || 0),
    tvPlaylist.length - 1
  );
  const tvPlaylistMode = state.ui?.tvPlaylistMode || 'loop';
  const tvPlaylistPaused = Boolean(state.ui?.tvPlaylistPaused);

  const handleAddTvFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    e.target.value = '';

    showToast(`Adding ${files.length} file${files.length === 1 ? '' : 's'} to TV playlist...`);
    let failedCount = 0;
    let firstError = '';
    let gcsCount = 0;
    for (const file of files) {
      const saved = await saveTvPlaylistItemBlob(file, { senderId: tournamentStore.getTabId() });
      tournamentStore.addTvPlaylistItem({
        id: saved.id,
        kind: saved.kind,
        name: saved.name,
        type: saved.type,
        gcsObject: saved.gcsObject || '',
        durationSec: saved.detectedDurationSec || (saved.kind === 'video' ? 15 : 12),
        updatedAt: saved.updatedAt,
      });
      if (saved.storageBackend === 'gcs') gcsCount += 1;
      if (saved.remoteError) {
        failedCount += 1;
        if (!firstError) firstError = saved.remoteError;
      }
    }
    trackUsageEvent('tv:playlist_add_files', {
      category: 'control',
      count: files.length,
      storage: gcsCount > 0 ? 'gcs' : 'local',
    });
    setMediaRefreshToken((n) => n + 1);
    if (failedCount > 0) {
      showToast(`Saved locally only — ${firstError || `${failedCount} failed to sync`}`);
    } else if (gcsCount > 0) {
      showToast(`Uploaded ${gcsCount} item${gcsCount === 1 ? '' : 's'} to Google Cloud Storage`);
    } else {
      showToast(`Added ${files.length} item${files.length === 1 ? '' : 's'} to 4:3 CRT TV playlist`);
    }
  };

  const handleAddTvUrl = async (e) => {
    e.preventDefault();
    const cleanedUrl = tvUrlInput.trim();
    if (!cleanedUrl) return;
    const embedInfo = resolveEmbedStreamUrl(cleanedUrl);
    const derivedName =
      tvUrlNameInput.trim() ||
      embedInfo?.defaultName ||
      cleanedUrl.split('/').pop()?.split('?')[0] ||
      'Web Media';
    let detectedSec = embedInfo ? 60 : null;
    if (!embedInfo && /\.gif(\?|$)/i.test(cleanedUrl)) {
      try {
        const res = await fetch(cleanedUrl);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          detectedSec = parseGifDurationSec(buf);
        }
      } catch {
        // CORS or network error — fall back to 12s
      }
    }
    tournamentStore.addTvPlaylistItem({
      id: `tvu-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'url',
      name: derivedName,
      url: cleanedUrl,
      durationSec: detectedSec || 12,
      updatedAt: Date.now(),
    });
    trackUsageEvent('tv:playlist_add_url', {
      category: 'control',
      provider: embedInfo?.provider || 'direct',
    });
    setTvUrlInput('');
    setTvUrlNameInput('');
    setShowAddUrlRow(false);
    showToast(
      embedInfo
        ? `Added ${embedInfo.provider.toUpperCase()} stream "${derivedName}" to CRT TV playlist`
        : detectedSec
        ? `Added "${derivedName}" (${detectedSec}s GIF loop) to CRT TV playlist`
        : `Added "${derivedName}" to CRT TV playlist`
    );
  };

  const handleRemoveTvPlaylistItem = async (item) => {
    if (item.kind === 'video' || item.kind === 'image') {
      await deleteTvPlaylistItemBlob(item.id, {
        senderId: tournamentStore.getTabId(),
        gcsObject: item.gcsObject || '',
      });
    }
    tournamentStore.removeTvPlaylistItem(item.id);
    trackUsageEvent('tv:playlist_remove', { category: 'control' });
    setMediaRefreshToken((n) => n + 1);
  };

  const handleAddBuiltInSitcom = () => {
    tournamentStore.addTvPlaylistItem({
      id: `sitcom-${Date.now()}`,
      kind: 'sitcom',
      name: 'Retro Sitcom (Built-in)',
      durationSec: 20,
      updatedAt: Date.now(),
    });
    trackUsageEvent('tv:playlist_add_sitcom', { category: 'control' });
    showToast('Added Built-in Retro Sitcom to TV playlist');
  };

  const handleOpenPresentationWindow = () => {
    const presentUrl = `${window.location.origin}/present`;
    const popup = window.open(
      presentUrl,
      'pingpong-presentation-screen',
      'width=1440,height=810,menubar=no,toolbar=no,location=no,status=no'
    );
    if (!popup) {
      showToast('Popup blocked — opening Presentation View in this tab');
      onNavigateMode('present');
    } else {
      popup.focus();
      showToast('Presentation window opened & synced live');
    }
  };

  return (
    <div className="control-shell">
      {/* Uniform Top Navigation Bar (Hub + Role Views + Contextual Control Buttons on Top-Left) */}
      <header className="control-topbar">
        <ViewNavBar
          activeMode="control"
          rolePerms={rolePerms}
          pendingRequestsCount={
            (state.scorekeeperRequests?.length || 0) + (state.joinRequests?.length || 0)
          }
          onNavigateMode={onNavigateMode}
          onOpenTournamentChooser={onOpenTournamentChooser}
        />

        <div className="topbar-subrow">
          <div className="brand-block is-header-right">
            <div className="brand-emblem" aria-hidden="true">
              🏓
            </div>
            <div>
              <h1 className="brand-title">
                {state.tournamentName}
                {Boolean(state.tournamentSubtitle?.trim()) && (
                  <>
                    <span style={{ opacity: 0.55, margin: '0 0.45rem' }} aria-hidden="true">
                      ·
                    </span>
                    <span style={{ color: '#a7f3d0', fontWeight: 700, fontSize: '0.86em' }}>
                      {state.tournamentSubtitle}
                    </span>
                  </>
                )}
              </h1>
              <div className="brand-meta">
                <span className="meta-chip">
                  {isTeams ? 'Teams · Doubles' : 'Singles · 1v1'}
                </span>
                <span className="meta-chip">
                  {state.format === 'double' ? 'Double Elim' : 'Single Elim'} · {state.playerCount}{' '}
                  {entityNoun}
                </span>
                <span className="meta-chip">
                  To {state.rules.targetPoints} · Win by {state.rules.winBy ?? 2} · Serve{' '}
                  {state.rules.serveRotation} · {state.rules.tableCount ?? 1}{' '}
                  {(state.rules.tableCount ?? 1) === 1 ? 'Table' : 'Tables'}
                </span>
                {state.joinCode && (
                  <button
                    type="button"
                    className="meta-chip meta-chip-key"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(state.joinCode);
                        showToast(`Copied 4-word join key: ${state.joinCode}`);
                      } catch {
                        showToast(`4-word join key: ${state.joinCode}`);
                      }
                    }}
                    title="Click to copy this tournament's 4-word join key"
                    aria-label={`Copy 4-word join key ${state.joinCode}`}
                  >
                    🔑 {state.joinCode}
                  </button>
                )}
                {state.demoMode && <span className="meta-chip chip-demo">DEMO MODE</span>}

                {/* Fixed-width OBS Sync Cluster so toggling Live <-> Studio never shifts or wraps UI */}
                <div className="sync-control-cluster">
                  <button
                    type="button"
                    className={`sync-mode-btn ${isStudio ? 'is-studio' : 'is-live'}`}
                    onClick={handleToggleSyncMode}
                    title={
                      isStudio
                        ? 'Studio Mode: edits stay in preview until pushed live. Click to return to Live Mode.'
                        : 'Live Mode: edits sync immediately to Presentation View. Click to switch to OBS Studio Mode.'
                    }
                  >
                    <span className="sync-mode-dot" aria-hidden="true" />
                    {isStudio ? 'STUDIO MODE' : 'LIVE SYNC'}
                  </button>

                  <button
                    type="button"
                    className={`btn-push-live-chip ${hasUnpublished ? 'has-changes' : ''} ${isStudio ? '' : 'is-slot-hidden'
                      }`}
                    onClick={handlePushLive}
                    disabled={!isStudio}
                    tabIndex={isStudio ? 0 : -1}
                    aria-hidden={!isStudio}
                  >
                    ▶ Push Live{hasUnpublished ? ' ●' : ''}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="topbar-submenu-actions" role="toolbar" aria-label="Control Actions">
            <button type="button" className="btn-primary btn-sm" onClick={() => setSetupOpen(true)}>
              ⚙ Setup &amp; Rules
            </button>

            {grandmaEnabled && (
              <button
                type="button"
                className={`btn-secondary btn-sm ${state.ui.showCornerScene ? 'is-toggled-on' : ''}`}
                onClick={() => tournamentStore.toggleCornerScene()}
                aria-pressed={state.ui.showCornerScene}
              >
                👵 {state.ui.showCornerScene ? 'Hide Grandma' : 'Show Grandma'}
              </button>
            )}
          </div>
        </div>
      </header>

      {toastMessage && (
        <div className="operator-toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      )}

      {/* Main Operator Dashboard */}
      <main className="control-main">
        {/* Live Match Scoreboard */}
        <Scoreboard
          match={activeMatch}
          players={state.players}
          rules={state.rules}
          entryMode={state.entryMode || 'singles'}
          scoreFont={state.ui?.scoreFont || 'barlow'}
          mode="control"
          onAddPoint={handleScorePoint}
          onSubtractPoint={(slot) => requestRemovePoint(slot, resolveSlotName(slot))}
          pendingPointRemoval={pendingRemoval}
          onCancelPointRemoval={() => cancelPendingRemoval()}
          onSwitchFirstServer={() => tournamentStore.switchFirstServer()}
          onStartMatch={() => {
            cancelPendingRemoval(true);
            tournamentStore.startMatch();
            if (activeMatch) showToast(`Match ${activeMatch.label} started!`);
          }}
          onCancelMatchStart={() => {
            cancelPendingRemoval(true);
            tournamentStore.cancelMatchStart();
            if (activeMatch) showToast(`Cancelled start for ${activeMatch.label} — back to Ready`);
          }}
          onChangeMatchTable={(tableNum) => {
            if (!activeMatch) return;
            tournamentStore.setMatchTable(activeMatch.id, tableNum);
            showToast(`Assigned ${activeMatch.label} to Table ${tableNum}`);
          }}
          onCompleteMatch={() => {
            cancelPendingRemoval(true);
            const prevMatch = activeMatch;
            tournamentStore.completeActiveMatch();
            if (prevMatch) {
              showToast(`Match ${prevMatch.label} completed — next match ready!`);
            }
          }}
          onEditCompletedMatch={() => setEditCompletedOpen(true)}
          onReopenMatch={(matchId) => {
            const res = tournamentStore.reopenMatch(matchId);
            if (res.reopened) {
              showToast(`Match ${state.matches[matchId]?.label || ''} reopened for play`);
            }
          }}
        />

        {/* Middle Row: Collapsible Broadcast Deck (with contextual slide banner) + Grandma & CRT Panels */}
        <div
          className="operator-deck-grid"
          style={!grandmaEnabled ? { gridTemplateColumns: '1fr' } : undefined}
        >
          <SlidePreview
            state={state}
            syncMeta={syncMeta}
            collapsed={Boolean(collapsed.presentation)}
            onToggleCollapse={() => tournamentStore.togglePanelCollapsed('presentation')}
            onSelectSlide={(id) => tournamentStore.setActiveSlide(id)}
            onToggleAutoRotate={(enabled) =>
              tournamentStore.setPresentationConfig({ autoRotate: enabled })
            }
            onChangeAutoRotateSlides={(slides) =>
              tournamentStore.setPresentationConfig({ autoRotateSlides: slides })
            }
            onChangeAutoRotateSec={(sec) =>
              tournamentStore.setPresentationConfig({ autoRotateSec: sec })
            }
            onUpdatePresentationConfig={(partial) =>
              tournamentStore.setPresentationConfig(partial)
            }
            onToggleMiniBracket={(show) => tournamentStore.setShowMiniBracket(show)}
            onChangeTicker={(partial) => tournamentStore.setTickerConfig(partial)}
            onPublishLive={handlePushLive}
            onDiscardStaged={() => {
              tournamentStore.discardStudioChanges();
              showToast('Discarded staged studio edits');
            }}
            onOpenPresentationWindow={
              !rolePerms || rolePerms.canAccessPresent ? handleOpenPresentationWindow : null
            }
          />

          {grandmaEnabled && (
            <div className="operator-side-stack">
              {/* Unified Collapsible Grandma Corner Panel with Subsections */}
              <section
                className={`panel-card grandma-corner-panel ${collapsed.grandma ? 'is-collapsed' : ''}`}
                aria-label="Grandma Corner"
              >
              <div className="panel-header-row">
                <button
                  type="button"
                  className="panel-collapse-trigger"
                  onClick={() => tournamentStore.togglePanelCollapsed('grandma')}
                  aria-expanded={!collapsed.grandma}
                >
                  <span className="collapse-chevron" aria-hidden="true">
                    {collapsed.grandma ? '▸' : '▾'}
                  </span>
                  <div>
                    <h2 className="panel-title">👵 Grandma Corner</h2>
                    <p className="panel-subtitle">
                      {state.ui.showCornerScene ? 'Expanded' : 'Coffee Cup Mode'} ·{' '}
                      {state.grandma?.contextualChancePct ?? 25}% commentary ·{' '}
                      {Math.round(cornerScale * 100)}% size · {state.ui.tvMediaLabel}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setPhrasesOpen(true)}
                >
                  ⚙ Phrases
                </button>
              </div>

              {!collapsed.grandma && (
                <div className="panel-body-content grandma-corner-sections">
                  {/* Subsection 1: Live Commentary & Quick Cues */}
                  <div className="grandma-subsection">
                    <div className="grandma-subhead">
                      <span className="grandma-sub-title">💬 Live Commentary &amp; Quick Cues</span>
                      <span className="grandma-sub-meta">
                        Banter · Contextual ({state.grandma?.contextualChancePct ?? 25}%) · Game Point
                      </span>
                    </div>

                    <form onSubmit={handleTriggerLiveQuote} className="live-quote-form">
                      <GrandmaPhraseInput
                        state={state}
                        value={liveQuoteInput}
                        onChange={(val) => setLiveQuoteInput(val)}
                        placeholder='Type instant line — type $ for autocomplete ($player1, $scoringPlayer...)'
                        aria-label="Instant Grandma quote"
                      />
                      <button type="submit" className="btn-amber">
                        💬 Say Now
                      </button>
                    </form>
                    {hasGrandmaVariables(liveQuoteInput) && (
                      <div className="grandma-live-preview is-compact" role="status" aria-live="polite">
                        <span className="glp-label">Preview:</span>
                        <span className="glp-text">“{resolveGrandmaPhrase(liveQuoteInput, state)}”</span>
                      </div>
                    )}

                    <div className="quick-cue-chips">
                      {QUICK_CUE_QUOTES.map((q) => (
                        <button
                          key={q}
                          type="button"
                          className="cue-chip"
                          onClick={() => handleQuickCue(q)}
                        >
                          ▶ {q}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Subsection 2: Corner Display & Sizing */}
                  <div className="grandma-subsection">
                    <div className="grandma-subhead">
                      <span className="grandma-sub-title">📐 Corner Display &amp; Sizing</span>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className={`btn-secondary btn-sm ${state.ui.showCornerScene ? 'is-toggled-on' : ''
                            }`}
                          onClick={() => tournamentStore.toggleCornerScene()}
                          aria-pressed={state.ui.showCornerScene}
                          title="Toggle full Grandma scene vs steaming coffee cup globally"
                        >
                          {state.ui.showCornerScene ? '☕ Collapse to Mug' : '👵 Expand Grandma'}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() =>
                            tournamentStore.setCornerAppearance({
                              cornerScale: 1.0,
                              cornerOpacity: 1.0,
                              bubbleScale: 1.0,
                            })
                          }
                        >
                          Reset
                        </button>
                      </div>
                    </div>

                    <div className="corner-sliders-grid is-three" style={{ marginBottom: 0 }}>
                      <label className="slider-field">
                        <div className="slider-head">
                          <span>Corner Size</span>
                          <strong>{Math.round(cornerScale * 100)}%</strong>
                        </div>
                        <input
                          type="range"
                          min="0.4"
                          max="1.5"
                          step="0.05"
                          value={cornerScale}
                          onChange={(e) =>
                            tournamentStore.setCornerAppearance({
                              cornerScale: Number(e.target.value),
                            })
                          }
                        />
                      </label>

                      <label className="slider-field">
                        <div className="slider-head">
                          <span>Corner Opacity</span>
                          <strong>{Math.round(cornerOpacity * 100)}%</strong>
                        </div>
                        <input
                          type="range"
                          min="0.15"
                          max="1.0"
                          step="0.05"
                          value={cornerOpacity}
                          onChange={(e) =>
                            tournamentStore.setCornerAppearance({
                              cornerOpacity: Number(e.target.value),
                            })
                          }
                        />
                      </label>

                      <label className="slider-field">
                        <div className="slider-head">
                          <span>Chat Bubble Size</span>
                          <strong>{Math.round(bubbleScale * 100)}%</strong>
                        </div>
                        <input
                          type="range"
                          min="0.75"
                          max="1.5"
                          step="0.05"
                          value={bubbleScale}
                          onChange={(e) =>
                            tournamentStore.setCornerAppearance({
                              bubbleScale: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    </div>
                  </div>

                  {/* Subsection 3: 4:3 CRT TV Media Playlist & Audio */}
                  <div className="grandma-subsection">
                    <div className="grandma-subhead">
                      <span className="grandma-sub-title">📺 4:3 CRT TV Playlist &amp; Audio</span>
                      <span className="grandma-sub-meta">
                        {tvPlaylist.length} item{tvPlaylist.length === 1 ? '' : 's'} ·{' '}
                        {tvPlaylistMode === 'shuffle'
                          ? 'Shuffle'
                          : tvPlaylistMode === 'single'
                          ? 'Hold'
                          : 'Loop'}
                      </span>
                    </div>

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="video/*,image/*"
                      multiple
                      onChange={handleAddTvFiles}
                      className="sr-only"
                      aria-label="Add videos, images, or GIFs to CRT TV playlist"
                    />

                    <div className="crt-controls-row" style={{ marginBottom: '0.45rem' }}>
                      <button
                        type="button"
                        className="btn-primary btn-sm"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        ➕ Add Files
                      </button>
                      <button
                        type="button"
                        className={`btn-secondary btn-sm ${showAddUrlRow ? 'is-toggled-on' : ''}`}
                        onClick={() => setShowAddUrlRow((v) => !v)}
                      >
                        🔗 Add URL
                      </button>
                      {!tvPlaylist.some((x) => x.kind === 'sitcom') && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={handleAddBuiltInSitcom}
                        >
                          📺 + Sitcom
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => tournamentStore.setTvMuted(!state.ui.tvMuted)}
                      >
                        {state.ui.tvMuted ? '🔇 Muted' : '🔊 Audio On'}
                      </button>
                    </div>

                    {showAddUrlRow && (
                      <form
                        onSubmit={handleAddTvUrl}
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '0.35rem',
                          marginBottom: '0.5rem',
                        }}
                      >
                        <input
                          type="url"
                          className="panel-input"
                          value={tvUrlInput}
                          onChange={(e) => setTvUrlInput(e.target.value)}
                          placeholder="YouTube, Twitch, Vimeo, or direct GIF/image/MP4 URL..."
                          style={{ flex: '2 1 180px', fontSize: '0.78rem', padding: '0.3rem 0.5rem' }}
                          required
                        />
                        <input
                          type="text"
                          className="panel-input"
                          value={tvUrlNameInput}
                          onChange={(e) => setTvUrlNameInput(e.target.value)}
                          placeholder="Label (optional)"
                          style={{ flex: '1 1 100px', fontSize: '0.78rem', padding: '0.3rem 0.5rem' }}
                        />
                        <button type="submit" className="btn-amber btn-sm">
                          Add
                        </button>
                      </form>
                    )}

                    {/* Playback Controls Row */}
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.35rem',
                        marginBottom: '0.45rem',
                      }}
                    >
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          disabled={tvPlaylist.length <= 1}
                          onClick={() =>
                            tournamentStore.setTvPlaylistPlayback({ index: tvPlaylistIndex - 1 })
                          }
                          title="Previous playlist item"
                        >
                          ⏮
                        </button>
                        <button
                          type="button"
                          className={`btn-secondary btn-sm ${tvPlaylistPaused ? 'is-toggled-on' : ''}`}
                          disabled={tvPlaylist.length <= 1}
                          onClick={() =>
                            tournamentStore.setTvPlaylistPlayback({ paused: !tvPlaylistPaused })
                          }
                          title={tvPlaylistPaused ? 'Resume auto-advance' : 'Hold on current item'}
                        >
                          {tvPlaylistPaused ? '▶ Resume' : '⏸ Hold'}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          disabled={tvPlaylist.length <= 1}
                          onClick={() =>
                            tournamentStore.setTvPlaylistPlayback({ index: tvPlaylistIndex + 1 })
                          }
                          title="Next playlist item"
                        >
                          ⏭
                        </button>
                      </div>

                      <div className="segmented-control compact">
                        {[
                          { id: 'loop', label: '🔁 Loop' },
                          { id: 'shuffle', label: '🔀 Shuffle' },
                          { id: 'single', label: '🔂 Single' },
                        ].map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            className={tvPlaylistMode === m.id ? 'is-selected' : ''}
                            onClick={() => tournamentStore.setTvPlaylistPlayback({ mode: m.id })}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Playlist Queue */}
                    <div
                      className="scroller"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.28rem',
                        maxHeight: '175px',
                        overflowY: 'auto',
                      }}
                    >
                      {tvPlaylist.map((item, idx) => {
                        const isActive = idx === tvPlaylistIndex;
                        const isEmbedStream =
                          item.kind === 'url' && Boolean(resolveEmbedStreamUrl(item.url));
                        const icon =
                          item.kind === 'sitcom'
                            ? '📺'
                            : isEmbedStream
                            ? '📡'
                            : item.kind === 'video'
                            ? '🎬'
                            : item.kind === 'url'
                            ? '🔗'
                            : '🖼️';
                        const isVideo =
                          item.kind === 'video' ||
                          (item.kind === 'url' && /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(item.url || ''));
                        return (
                          <div
                            key={item.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.35rem',
                              padding: '0.28rem 0.45rem',
                              borderRadius: '7px',
                              background: isActive
                                ? 'rgba(245, 158, 11, 0.16)'
                                : 'rgba(15, 23, 42, 0.5)',
                              border: `1px solid ${
                                isActive ? 'rgba(251, 191, 36, 0.55)' : 'rgba(148, 163, 184, 0.18)'
                              }`,
                              fontSize: '0.78rem',
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => tournamentStore.setTvPlaylistPlayback({ index: idx })}
                              title="Play this item now"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.35rem',
                                flex: 1,
                                minWidth: 0,
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                color: 'inherit',
                                textAlign: 'left',
                                cursor: 'pointer',
                                fontWeight: isActive ? 700 : 500,
                              }}
                            >
                              <span style={{ flexShrink: 0 }}>{isActive ? '▶' : icon}</span>
                              <span
                                style={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {item.name}
                              </span>
                              {item.gcsObject && (
                                <span
                                  style={{
                                    fontSize: '0.64rem',
                                    color: '#7dd3fc',
                                    opacity: 0.9,
                                    flexShrink: 0,
                                  }}
                                  title={`Stored in Google Cloud Storage: ${item.gcsObject}`}
                                >
                                  ☁ GCS
                                </span>
                              )}
                            </button>

                            {isVideo ? (
                              <span
                                style={{
                                  fontSize: '0.68rem',
                                  opacity: 0.65,
                                  padding: '0 0.25rem',
                                  flexShrink: 0,
                                }}
                                title="Advances automatically when video finishes"
                              >
                                Auto
                              </span>
                            ) : (
                              <label
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.15rem',
                                  fontSize: '0.7rem',
                                  opacity: 0.85,
                                  flexShrink: 0,
                                }}
                                title="Display duration in seconds"
                              >
                                <input
                                  type="number"
                                  min={1}
                                  max={3600}
                                  value={item.durationSec ?? 12}
                                  onChange={(e) =>
                                    tournamentStore.updateTvPlaylistItem(item.id, {
                                      durationSec: e.target.value,
                                    })
                                  }
                                  style={{
                                    width: '42px',
                                    padding: '0.12rem 0.25rem',
                                    borderRadius: '4px',
                                    border: '1px solid rgba(148, 163, 184, 0.3)',
                                    background: 'rgba(15, 23, 42, 0.85)',
                                    color: 'inherit',
                                    fontSize: '0.72rem',
                                    textAlign: 'center',
                                  }}
                                />
                                <span>s</span>
                              </label>
                            )}

                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              disabled={idx === 0}
                              onClick={() => tournamentStore.moveTvPlaylistItem(item.id, -1)}
                              title="Move up"
                              style={{ padding: '0.12rem 0.32rem', fontSize: '0.68rem' }}
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              disabled={idx === tvPlaylist.length - 1}
                              onClick={() => tournamentStore.moveTvPlaylistItem(item.id, 1)}
                              title="Move down"
                              style={{ padding: '0.12rem 0.32rem', fontSize: '0.68rem' }}
                            >
                              ▼
                            </button>
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              onClick={() => handleRemoveTvPlaylistItem(item)}
                              title="Remove from playlist"
                              style={{ padding: '0.12rem 0.35rem', fontSize: '0.7rem' }}
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>
          )}
        </div>

        {/* Collapsible Interactive Tournament Bracket */}
        <section
          className={`panel-card bracket-panel ${collapsed.bracket ? 'is-collapsed' : ''}`}
          aria-label="Interactive Tournament Bracket"
        >
          <div className="panel-header-row">
            <button
              type="button"
              className="panel-collapse-trigger"
              onClick={() => tournamentStore.togglePanelCollapsed('bracket')}
              aria-expanded={!collapsed.bracket}
            >
              <span className="collapse-chevron" aria-hidden="true">
                {collapsed.bracket ? '▸' : '▾'}
              </span>
              <div>
                <h2 className="panel-title">🏆 Interactive Tournament Bracket</h2>
                <p className="panel-subtitle">
                  Click any playable match card to load it onto the live scoreboard
                </p>
              </div>
            </button>

            {!collapsed.bracket && (
              <div className="bracket-legend">
                <span className="legend-pill is-active">Active Match</span>
                <span className="legend-pill is-completed">Completed</span>
                <span className="legend-pill is-ready">Ready</span>
                <span className="legend-pill is-bye">BYE</span>
              </div>
            )}
          </div>

          {!collapsed.bracket && (
            <div className="panel-body-content">
              <BracketView
                matches={state.matches}
                players={state.players}
                format={state.format}
                entryMode={state.entryMode || 'singles'}
                activeMatchId={state.activeMatchId}
                championId={state.championId}
                interactive={true}
                onSelectMatch={handleRequestSelectMatch}
              />
            </div>
          )}
        </section>
      </main>

      {/* Unified Setup, Rules, Debounce, Typography & Roster Modal */}
      <PlayerSetupModal
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        state={state}
        onApplySetup={(setupPayload) => {
          const prevCount = state.playerCount;
          tournamentStore.applyFullSetup(setupPayload);
          showToast(
            setupPayload.rebuildBracket
              ? `Rebuilt ${setupPayload.playerCount}-${setupPayload.entryMode === 'teams' ? 'team' : 'player'
              } ${setupPayload.format} elimination bracket`
              : setupPayload.playerCount > prevCount
                ? `Added new ${setupPayload.entryMode === 'teams' ? 'team(s)' : 'player(s)'} mid-tournament — existing scores preserved!`
                : 'Tournament setup & rules saved'
          );
        }}
        onShufflePartners={() => {
          tournamentStore.shuffleTeamPartners();
          showToast('Team partners shuffled!');
        }}
        onRandomizeSeeds={() => {
          tournamentStore.randomizeSeeds();
          showToast('Seeds randomized & bracket regenerated');
        }}
        onResetTournament={() => {
          tournamentStore.resetTournament();
          showToast('Tournament scores reset');
        }}
      />

      {grandmaEnabled && (
        <PhraseManagerModal
          open={phrasesOpen}
          onClose={() => setPhrasesOpen(false)}
          grandma={state.grandma}
          state={state}
          onSaveSettings={(settings) => {
            tournamentStore.updateGrandmaSettings(settings);
            showToast('Grandma phrase categories & timings saved');
          }}
          onPlayQuoteNow={(phrase) => {
            const resolved = resolveGrandmaPhrase(phrase, state);
            tournamentStore.triggerLiveQuote(phrase);
            showToast(`Playing quote: "${resolved}"`);
          }}
        />
      )}

      <EditCompletedMatchDialog
        open={editCompletedOpen && Boolean(activeMatch?.completed)}
        match={activeMatch}
        matches={state.matches}
        players={state.players}
        rules={state.rules}
        entryMode={state.entryMode || 'singles'}
        onClose={() => setEditCompletedOpen(false)}
        onSaveScore={(matchId, s1, s2) => {
          const res = tournamentStore.editCompletedMatch(matchId, s1, s2);
          if (res.edited) {
            showToast(
              res.winnerChanged
                ? `Updated ${state.matches[matchId]?.label} (${s1}–${s2}) & updated downstream bracket`
                : `Updated ${state.matches[matchId]?.label} final score to ${s1}–${s2}`
            );
          } else if (res.reason) {
            showToast(res.reason);
          }
        }}
        onReopenMatch={(matchId) => {
          const res = tournamentStore.reopenMatch(matchId);
          if (res.reopened) {
            showToast(`Reopened ${state.matches[matchId]?.label} for live play`);
          }
        }}
      />

      <MatchSwitchConfirmDialog
        request={switchConfirmRequest}
        onConfirm={handleConfirmSwitchMatch}
        onCancel={() => setSwitchConfirmRequest(null)}
      />

      <DebounceOverrideDialog
        request={debounceRequest}
        onConfirm={handleConfirmDebounceOverride}
        onCancel={() => setDebounceRequest(null)}
      />

      {/* Signature Bottom-Right Animated 4:3 CRT TV & Grandma Corner Scene */}
      {grandmaEnabled && (
        <RetroTVCorner
          grandmaConfig={state.grandma}
          tvMuted={state.ui.tvMuted}
          hasCustomTvMedia={state.ui.hasCustomTvMedia}
          tvMediaSyncKey={`${state.ui.hasCustomTvMedia ? '1' : '0'}:${state.ui.tvMediaLabel || ''}:${state.ui.tvMediaUpdatedAt || 0}`}
          tvPlaylist={tvPlaylist}
          tvPlaylistIndex={tvPlaylistIndex}
          tvPlaylistMode={tvPlaylistMode}
          tvPlaylistPaused={tvPlaylistPaused}
          visible={state.ui.showCornerScene}
          scale={cornerScale}
          opacity={cornerOpacity}
          bubbleScale={bubbleScale}
          variant="corner"
          mediaRefreshToken={mediaRefreshToken}
        />
      )}
    </div>
  );
}
