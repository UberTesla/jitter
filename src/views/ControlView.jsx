import React, { useEffect, useRef, useState } from 'react';
import { tournamentStore, getTableSlots } from '../state/tournamentStore.js';
import { formatTeamMembers } from '../engine/bracketGenerator.js';
import { hasGrandmaVariables, resolveGrandmaPhrase } from '../engine/grandmaVariables.js';
import {
  saveTvPlaylistItemBlob,
  deleteTvPlaylistItemBlob,
  listCloudTvMediaLibrary,
  fetchYoutubeVideoMeta,
  probeYoutubeMetaInBrowser,
  parseGifDurationSec,
  resolveEmbedStreamUrl,
  YOUTUBE_QUALITY_OPTIONS,
} from '../state/mediaStore.js';
import { trackUsageEvent } from '../engine/usageAnalytics.js';
import { appendAppLog } from '../engine/appLog.js';
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

const TV_URL_HISTORY_KEY = 'jitter-tv-url-history-v1';

function readTvUrlHistory() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(TV_URL_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.url === 'string' && x.url.trim()) : [];
  } catch {
    return [];
  }
}

function writeTvUrlHistory(list) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(TV_URL_HISTORY_KEY, JSON.stringify((list || []).slice(0, 30)));
  } catch {
    // Ignore storage errors
  }
}

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
  const [showCloudLibrary, setShowCloudLibrary] = useState(false);
  const [cloudLibraryItems, setCloudLibraryItems] = useState([]);
  const [cloudLibraryLoading, setCloudLibraryLoading] = useState(false);
  const [cloudLibraryError, setCloudLibraryError] = useState('');
  const [cloudLibraryGcsEnabled, setCloudLibraryGcsEnabled] = useState(false);
  const [tvUrlInput, setTvUrlInput] = useState('');
  const [tvUrlNameInput, setTvUrlNameInput] = useState('');
  const [tvUrlHistory, setTvUrlHistory] = useState(() => readTvUrlHistory());
  const [tvUploadLog, setTvUploadLog] = useState([]);
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
    appendAppLog({
      level: /fail|error|blocked|denied|could not/i.test(String(msg || '')) ? 'warn' : 'info',
      category: 'control',
      message: msg,
    });
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

  const handleSelectLiveMode = () => {
    if (!isStudio) return;
    const hadStaged = hasUnpublished;
    if (hadStaged) {
      tournamentStore.publishStudioToLive();
    }
    tournamentStore.toggleSyncMode();
    showToast(
      hadStaged
        ? '▶ Pushed staged changes & returned to LIVE Mode'
        : 'LIVE Mode ON — changes update the Presentation screen in real time'
    );
  };

  const handleSelectStudioOrPush = () => {
    if (!isStudio) {
      tournamentStore.toggleSyncMode();
      showToast('Studio Mode ON — edit safely in Preview, then click PUSH');
      return;
    }
    tournamentStore.publishStudioToLive();
    showToast('▶ Pushed staged preview live to Presentation View!');
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
    : [
        {
          id: 'builtin-default-tv',
          kind: 'url',
          name: 'Raymond Thanksgiving (Default)',
          url: '/raymond-thanksgiving.mp4',
          muted: true,
          durationSec: 2640,
        },
      ];
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
    const newLogs = [];
    const nowStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
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
      if (saved.storageBackend === 'gcs') {
        gcsCount += 1;
        newLogs.push({
          id: `${Date.now()}-${Math.random()}`,
          time: nowStr,
          ok: true,
          text: `☁ GCS uploaded "${file.name}" → ${saved.gcsObject}`,
        });
      } else if (saved.remoteError) {
        failedCount += 1;
        if (!firstError) firstError = saved.remoteError;
        newLogs.push({
          id: `${Date.now()}-${Math.random()}`,
          time: nowStr,
          ok: false,
          text: `❌ "${file.name}": ${saved.remoteError}`,
        });
      } else {
        newLogs.push({
          id: `${Date.now()}-${Math.random()}`,
          time: nowStr,
          ok: true,
          text: `💾 "${file.name}" saved to ${saved.storageBackend === 'server' ? 'LAN server' : 'local browser'}`,
        });
      }
    }
    if (newLogs.length > 0) {
      setTvUploadLog((prev) => [...newLogs, ...prev].slice(0, 10));
    }
    trackUsageEvent('tv:playlist_add_files', {
      category: 'control',
      count: files.length,
      storage: gcsCount > 0 ? 'gcs' : 'local',
    });
    setMediaRefreshToken((n) => n + 1);
    if (showCloudLibrary) {
      loadCloudLibrary();
    }
    if (failedCount > 0) {
      showToast(`Saved locally only — ${firstError || `${failedCount} failed to sync`}`);
    } else if (gcsCount > 0) {
      showToast(`Uploaded ${gcsCount} item${gcsCount === 1 ? '' : 's'} to Google Cloud Storage`);
    } else {
      showToast(`Added ${files.length} item${files.length === 1 ? '' : 's'} to 4:3 CRT TV playlist`);
    }
  };

  const rememberTvUrl = (entry) => {
    const cleaned = String(entry?.url || '').trim();
    if (!cleaned) return;
    setTvUrlHistory((prev) => {
      const existing = prev.find((x) => x.url === cleaned);
      const merged = {
        url: cleaned,
        name: String(entry.name || existing?.name || cleaned).trim(),
        durationSec: Math.max(1, Math.round(Number(entry.durationSec || existing?.durationSec) || 12)),
        muted: entry.muted !== undefined ? Boolean(entry.muted) : Boolean(existing?.muted),
        quality: entry.quality || existing?.quality || '',
        savedAt: Date.now(),
      };
      const next = [merged, ...prev.filter((x) => x.url !== cleaned)].slice(0, 30);
      writeTvUrlHistory(next);
      return next;
    });
  };

  const handleReaddSavedTvUrl = (saved) => {
    if (!saved?.url) return;
    const embedInfo = resolveEmbedStreamUrl(saved.url);
    const isYoutubeEmbed = embedInfo?.provider === 'youtube';
    tournamentStore.addTvPlaylistItem({
      id: `tvu-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'url',
      name: saved.name || embedInfo?.defaultName || 'Web Media',
      url: saved.url,
      muted: saved.muted !== undefined ? Boolean(saved.muted) : isYoutubeEmbed,
      ...(isYoutubeEmbed ? { quality: saved.quality || 'tiny' } : {}),
      durationSec: Math.max(1, Math.round(Number(saved.durationSec) || 12)),
      updatedAt: Date.now(),
    });
    trackUsageEvent('tv:playlist_readd_url', {
      category: 'control',
      provider: embedInfo?.provider || 'direct',
    });
    showToast(`Re-added "${saved.name || 'URL'}" to CRT TV playlist`);
  };

  const handleForgetSavedTvUrl = (urlToRemove) => {
    setTvUrlHistory((prev) => {
      const next = prev.filter((x) => x.url !== urlToRemove);
      writeTvUrlHistory(next);
      return next;
    });
  };

  const handleAddTvUrl = async (e) => {
    e.preventDefault();
    const cleanedUrl = tvUrlInput.trim();
    if (!cleanedUrl) return;
    const embedInfo = resolveEmbedStreamUrl(cleanedUrl);
    const isYoutubeEmbed = embedInfo?.provider === 'youtube';
    let ytMeta = null;
    if (isYoutubeEmbed) {
      ytMeta = await fetchYoutubeVideoMeta(cleanedUrl);
      if (!ytMeta?.durationSec && embedInfo?.videoId) {
        const browserMeta = await probeYoutubeMetaInBrowser(embedInfo.videoId);
        ytMeta = {
          ...ytMeta,
          durationSec: browserMeta.durationSec || ytMeta?.durationSec || null,
          title: ytMeta?.title || browserMeta.title || null,
        };
      }
    }
    const derivedName =
      tvUrlNameInput.trim() ||
      ytMeta?.title ||
      embedInfo?.defaultName ||
      cleanedUrl.split('/').pop()?.split('?')[0] ||
      'Web Media';
    let detectedSec = ytMeta?.durationSec || (embedInfo ? 60 : null);
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
    const finalDurationSec = detectedSec || 12;
    const newUrlItem = {
      id: `tvu-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'url',
      name: derivedName,
      url: cleanedUrl,
      muted: isYoutubeEmbed,
      ...(isYoutubeEmbed ? { quality: 'tiny', autoDuration: !ytMeta?.durationSec } : {}),
      durationSec: finalDurationSec,
      updatedAt: Date.now(),
    };
    tournamentStore.addTvPlaylistItem(newUrlItem);
    rememberTvUrl(newUrlItem);
    trackUsageEvent('tv:playlist_add_url', {
      category: 'control',
      provider: embedInfo?.provider || 'direct',
    });
    setTvUrlInput('');
    setTvUrlNameInput('');
    setShowAddUrlRow(false);
    const mins = Math.floor(finalDurationSec / 60);
    const secs = finalDurationSec % 60;
    const durLabel = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    showToast(
      embedInfo
        ? `Added ${embedInfo.provider.toUpperCase()} "${derivedName}" (${durLabel}) to CRT TV playlist`
        : detectedSec
        ? `Added "${derivedName}" (${durLabel} GIF loop) to CRT TV playlist`
        : `Added "${derivedName}" to CRT TV playlist`
    );
  };

  const loadCloudLibrary = async () => {
    setCloudLibraryLoading(true);
    setCloudLibraryError('');
    const res = await listCloudTvMediaLibrary();
    setCloudLibraryLoading(false);
    if (!res.ok) {
      setCloudLibraryError(res.error || 'Could not load cloud media library');
      return;
    }
    setCloudLibraryGcsEnabled(Boolean(res.gcsEnabled));
    setCloudLibraryItems(res.items || []);
    if (res.gcsError) {
      setCloudLibraryError(res.gcsError);
    }
  };

  const handleToggleCloudLibrary = () => {
    setShowCloudLibrary((prev) => {
      const next = !prev;
      if (next) {
        loadCloudLibrary();
      }
      return next;
    });
  };

  const handleAddCloudLibraryItem = (item) => {
    if (!item || !item.id) return;
    if (tvPlaylist.some((x) => x.id === item.id || (item.gcsObject && x.gcsObject === item.gcsObject))) {
      showToast(`"${item.name}" is already in the CRT TV playlist`);
      return;
    }
    tournamentStore.addTvPlaylistItem({
      id: item.id,
      kind: item.kind || 'image',
      name: item.name || 'TV Media',
      type: item.type || '',
      gcsObject: item.gcsObject || '',
      durationSec: 12,
      updatedAt: item.updatedAt || Date.now(),
    });
    trackUsageEvent('tv:playlist_add_from_library', { category: 'control' });
    setMediaRefreshToken((n) => n + 1);
    showToast(`Added "${item.name}" from Cloud Library to playlist`);
  };

  const handleDeleteCloudLibraryItem = async (item) => {
    if (!item || !item.id) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Permanently delete "${item.name}" from cloud storage?`)
    ) {
      return;
    }
    await deleteTvPlaylistItemBlob(item.id, {
      senderId: tournamentStore.getTabId(),
      gcsObject: item.gcsObject || '',
    });
    if (tvPlaylist.some((x) => x.id === item.id || (item.gcsObject && x.gcsObject === item.gcsObject))) {
      const matching = tvPlaylist.find(
        (x) => x.id === item.id || (item.gcsObject && x.gcsObject === item.gcsObject)
      );
      if (matching) {
        tournamentStore.removeTvPlaylistItem(matching.id);
      }
    }
    setCloudLibraryItems((prev) =>
      prev.filter((x) => x.id !== item.id && (!item.gcsObject || x.gcsObject !== item.gcsObject))
    );
    trackUsageEvent('tv:library_delete_permanent', { category: 'control' });
    setMediaRefreshToken((n) => n + 1);
    showToast(`Permanently deleted "${item.name}"`);
  };

  const handleRemoveTvPlaylistItem = (item) => {
    // Only remove from the active playlist queue; keep uploaded files in Cloud/Server Library and URLs in history!
    if (item.kind === 'url' && item.url) {
      rememberTvUrl(item);
    }
    tournamentStore.removeTvPlaylistItem(item.id);
    trackUsageEvent('tv:playlist_remove', { category: 'control' });
    setMediaRefreshToken((n) => n + 1);
    if (item.kind === 'video' || item.kind === 'image') {
      showToast(`Removed "${item.name}" from queue (still saved in ☁ Library)`);
    } else if (item.kind === 'url' && item.url) {
      showToast(`Removed "${item.name}" from queue (re-add under 🔗 Add URL)`);
    }
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
      'jitter-presentation-screen',
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
                {state.demoMode && <span className="meta-chip chip-demo">DEMO MODE</span>}

                {/* Unified split-pill: LIVE | STUDIO (default LIVE lit) -> LIVE | PUSH (PUSH lit) */}
                <div className="sync-split-pill" role="group" aria-label="Broadcast Sync Mode">
                  <button
                    type="button"
                    className={`sync-split-half is-live-half ${!isStudio ? 'is-lit' : ''}`}
                    onClick={handleSelectLiveMode}
                    aria-pressed={!isStudio}
                    title={
                      isStudio
                        ? 'Auto-push any staged changes and return to Live Mode'
                        : 'Live Mode active — changes sync immediately to Presentation View'
                    }
                  >
                    <span className="sync-mode-dot" aria-hidden="true" />
                    LIVE
                  </button>
                  <button
                    type="button"
                    className={`sync-split-half is-studio-half ${isStudio ? 'is-lit' : ''} ${
                      isStudio && hasUnpublished ? 'has-changes' : ''
                    }`}
                    onClick={handleSelectStudioOrPush}
                    aria-pressed={isStudio}
                    title={
                      isStudio
                        ? 'Push staged preview changes live to Presentation View'
                        : 'Switch to Studio Mode to stage edits in Preview before pushing live'
                    }
                  >
                    {isStudio ? `▶ PUSH${hasUnpublished ? ' ●' : ''}` : 'STUDIO'}
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
        {/* Multi-Table Switcher Bar (when tableCount > 1) */}
        {(state.rules?.tableCount ?? 1) > 1 && (() => {
          const tableSlots = getTableSlots(state);
          const pMap = new Map((state.players || []).map((p) => [p.id, p]));
          return (
            <div
              className="scroller"
              role="tablist"
              aria-label="Active Tables"
              style={{
                display: 'flex',
                alignItems: 'stretch',
                gap: '0.45rem',
                overflowX: 'auto',
                paddingBottom: '0.2rem',
              }}
            >
              {tableSlots.map((slot) => {
                const m = slot.match;
                const isSelected = Boolean(m && activeMatch && m.id === activeMatch.id);
                const p1Name = m?.player1Id ? pMap.get(m.player1Id)?.name : null;
                const p2Name = m?.player2Id ? pMap.get(m.player2Id)?.name : null;
                return (
                  <button
                    key={slot.tableNumber}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => {
                      cancelPendingRemoval(true);
                      const res = tournamentStore.selectOrQueueTable(slot.tableNumber);
                      if (res.ok && res.queued) {
                        showToast(`Queued next match onto Table ${slot.tableNumber}`);
                      } else if (!res.ok) {
                        showToast(res.reason || `Table ${slot.tableNumber} is open`);
                      }
                    }}
                    style={{
                      flex: tableSlots.length <= 4 ? '1 1 0' : '0 0 auto',
                      minWidth: '170px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: '0.2rem',
                      padding: '0.48rem 0.7rem',
                      borderRadius: '10px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      color: '#f8fafc',
                      background: isSelected
                        ? 'linear-gradient(135deg, rgba(245, 158, 11, 0.24), rgba(15, 23, 42, 0.94))'
                        : 'rgba(15, 23, 42, 0.82)',
                      border: isSelected
                        ? '1.5px solid rgba(251, 191, 36, 0.82)'
                        : slot.isLive
                        ? '1px solid rgba(34, 197, 94, 0.45)'
                        : '1px solid rgba(148, 163, 184, 0.24)',
                    }}
                  >
                    <div
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.4rem',
                        fontSize: '0.72rem',
                        fontWeight: 800,
                        letterSpacing: '0.04em',
                      }}
                    >
                      <span style={{ color: '#fbbf24' }}>TABLE {slot.tableNumber}</span>
                      <span
                        style={{
                          fontSize: '0.64rem',
                          padding: '0.08rem 0.36rem',
                          borderRadius: '999px',
                          background: slot.isLive
                            ? 'rgba(34, 197, 94, 0.22)'
                            : slot.isQueued
                            ? 'rgba(245, 158, 11, 0.2)'
                            : 'rgba(148, 163, 184, 0.16)',
                          color: slot.isLive ? '#4ade80' : slot.isQueued ? '#fde68a' : '#94a3b8',
                        }}
                      >
                        {slot.isLive ? '● LIVE' : slot.isQueued ? 'READY' : 'OPEN'}
                      </span>
                    </div>
                    <div
                      style={{
                        width: '100%',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        color: m ? '#f1f5f9' : '#94a3b8',
                      }}
                    >
                      {m
                        ? `${p1Name || 'TBD'} ${m.score1 ?? 0}–${m.score2 ?? 0} ${p2Name || 'TBD'}`
                        : '+ Click to queue next match'}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })()}

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
                        className={`btn-secondary btn-sm ${showCloudLibrary ? 'is-toggled-on' : ''}`}
                        onClick={handleToggleCloudLibrary}
                        title="Upload, browse, and re-add cloud/server media files"
                      >
                        ☁ Library
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
                      <div style={{ marginBottom: '0.5rem' }}>
                        <form
                          onSubmit={handleAddTvUrl}
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '0.35rem',
                            marginBottom: '0.35rem',
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

                        {(() => {
                          const removedUrls = tvUrlHistory.filter(
                            (h) =>
                              h?.url &&
                              !tvPlaylist.some((p) => p.kind === 'url' && p.url === h.url)
                          );
                          if (removedUrls.length === 0) return null;
                          return (
                            <div
                              style={{
                                padding: '0.4rem 0.5rem',
                                borderRadius: '8px',
                                background: 'rgba(15, 23, 42, 0.7)',
                                border: '1px solid rgba(251, 191, 36, 0.25)',
                              }}
                            >
                              <div
                                style={{
                                  fontSize: '0.72rem',
                                  fontWeight: 700,
                                  color: '#fbbf24',
                                  marginBottom: '0.28rem',
                                }}
                              >
                                🕒 Previously Removed URLs ({removedUrls.length})
                              </div>
                              <div
                                className="scroller"
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '0.22rem',
                                  maxHeight: '125px',
                                  overflowY: 'auto',
                                }}
                              >
                                {removedUrls.map((saved) => {
                                  const isStream = Boolean(resolveEmbedStreamUrl(saved.url));
                                  const totalSec = Math.max(1, Math.round(Number(saved.durationSec) || 12));
                                  const m = Math.floor(totalSec / 60);
                                  const s = totalSec % 60;
                                  const durLabel = m > 0 ? `${m}m ${s}s` : `${s}s`;
                                  return (
                                    <div
                                      key={saved.url}
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.35rem',
                                        padding: '0.2rem 0.38rem',
                                        borderRadius: '6px',
                                        background: 'rgba(30, 41, 59, 0.65)',
                                        border: '1px solid rgba(148, 163, 184, 0.16)',
                                        fontSize: '0.73rem',
                                      }}
                                    >
                                      <span style={{ flexShrink: 0 }}>{isStream ? '📡' : '🔗'}</span>
                                      <span
                                        style={{
                                          flex: 1,
                                          minWidth: 0,
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                          whiteSpace: 'nowrap',
                                        }}
                                        title={saved.url}
                                      >
                                        {saved.name || saved.url}
                                      </span>
                                      <span style={{ fontSize: '0.66rem', opacity: 0.65, flexShrink: 0 }}>
                                        {durLabel}
                                      </span>
                                      <button
                                        type="button"
                                        className="btn-secondary btn-sm"
                                        onClick={() => handleReaddSavedTvUrl(saved)}
                                        style={{ padding: '0.1rem 0.4rem', fontSize: '0.68rem', flexShrink: 0 }}
                                        title="Re-add this URL to the CRT TV playlist"
                                      >
                                        + Add
                                      </button>
                                      <button
                                        type="button"
                                        className="btn-secondary btn-sm"
                                        onClick={() => handleForgetSavedTvUrl(saved.url)}
                                        style={{
                                          padding: '0.1rem 0.34rem',
                                          fontSize: '0.68rem',
                                          flexShrink: 0,
                                          color: '#fca5a5',
                                        }}
                                        title="Remove from saved URL history"
                                      >
                                        🗑
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    {showCloudLibrary && (
                      <div
                        style={{
                          marginBottom: '0.5rem',
                          padding: '0.45rem 0.55rem',
                          borderRadius: '8px',
                          background: 'rgba(15, 23, 42, 0.72)',
                          border: '1px solid rgba(56, 189, 248, 0.32)',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '0.4rem',
                            marginBottom: '0.35rem',
                            fontSize: '0.74rem',
                          }}
                        >
                          <span style={{ fontWeight: 700, color: '#7dd3fc' }}>
                            ☁ {cloudLibraryGcsEnabled ? 'Google Cloud Media Library' : 'Uploaded Media Library'} ({cloudLibraryItems.length})
                          </span>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                            <button
                              type="button"
                              className="btn-primary btn-sm"
                              onClick={() => fileInputRef.current?.click()}
                              style={{ padding: '0.12rem 0.45rem', fontSize: '0.68rem' }}
                              title="Upload videos, images, or GIFs to library and playlist"
                            >
                              ➕ Add Files
                            </button>
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              onClick={loadCloudLibrary}
                              disabled={cloudLibraryLoading}
                              style={{ padding: '0.1rem 0.38rem', fontSize: '0.68rem' }}
                              title="Refresh cloud media library"
                            >
                              {cloudLibraryLoading ? '…' : '↻ Refresh'}
                            </button>
                          </div>
                        </div>

                        {cloudLibraryError && (
                          <div style={{ fontSize: '0.72rem', color: '#fca5a5', marginBottom: '0.3rem' }}>
                            {cloudLibraryError}
                          </div>
                        )}

                        {cloudLibraryLoading && cloudLibraryItems.length === 0 ? (
                          <div style={{ fontSize: '0.74rem', opacity: 0.7 }}>Loading library…</div>
                        ) : cloudLibraryItems.length === 0 ? (
                          <div style={{ fontSize: '0.74rem', opacity: 0.7 }}>
                            No uploaded files in storage yet. Use “➕ Add Files” to upload videos, GIFs, or images.
                          </div>
                        ) : (
                          <div
                            className="scroller"
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.24rem',
                              maxHeight: '145px',
                              overflowY: 'auto',
                            }}
                          >
                            {cloudLibraryItems.map((libItem) => {
                              const alreadyQueued = tvPlaylist.some(
                                (x) =>
                                  x.id === libItem.id ||
                                  (libItem.gcsObject && x.gcsObject === libItem.gcsObject)
                              );
                              const sizeLabel =
                                libItem.size >= 1024 * 1024
                                  ? `${(libItem.size / (1024 * 1024)).toFixed(1)} MB`
                                  : libItem.size > 0
                                  ? `${Math.max(1, Math.round(libItem.size / 1024))} KB`
                                  : '';
                              return (
                                <div
                                  key={libItem.gcsObject || libItem.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.35rem',
                                    padding: '0.22rem 0.4rem',
                                    borderRadius: '6px',
                                    background: 'rgba(30, 41, 59, 0.65)',
                                    border: '1px solid rgba(148, 163, 184, 0.16)',
                                    fontSize: '0.74rem',
                                  }}
                                >
                                  <span style={{ flexShrink: 0 }}>
                                    {libItem.kind === 'video' ? '🎬' : '🖼️'}
                                  </span>
                                  <span
                                    style={{
                                      flex: 1,
                                      minWidth: 0,
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                    }}
                                    title={libItem.gcsObject || libItem.name}
                                  >
                                    {libItem.name}
                                  </span>
                                  {sizeLabel && (
                                    <span style={{ fontSize: '0.66rem', opacity: 0.65, flexShrink: 0 }}>
                                      {sizeLabel}
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    className="btn-secondary btn-sm"
                                    disabled={alreadyQueued}
                                    onClick={() => handleAddCloudLibraryItem(libItem)}
                                    title={alreadyQueued ? 'Already in playlist' : 'Add to CRT TV playlist'}
                                    style={{
                                      padding: '0.1rem 0.4rem',
                                      fontSize: '0.68rem',
                                      flexShrink: 0,
                                    }}
                                  >
                                    {alreadyQueued ? 'In Queue' : '+ Add'}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-secondary btn-sm"
                                    onClick={() => handleDeleteCloudLibraryItem(libItem)}
                                    title="Permanently delete from cloud storage"
                                    style={{
                                      padding: '0.1rem 0.34rem',
                                      fontSize: '0.68rem',
                                      flexShrink: 0,
                                      color: '#fca5a5',
                                    }}
                                  >
                                    🗑
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
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
                        const embedMeta = item.kind === 'url' ? resolveEmbedStreamUrl(item.url) : null;
                        const isEmbedStream = Boolean(embedMeta);
                        const isYoutubeItem = embedMeta?.provider === 'youtube';
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
                        const supportsAudio = isVideo || isEmbedStream;
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
                              (() => {
                                const totalSec = Math.max(1, Math.round(Number(item.durationSec) || 12));
                                const durMins = Math.floor(totalSec / 60);
                                const durSecs = totalSec % 60;
                                return (
                                  <span
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '0.14rem',
                                      fontSize: '0.7rem',
                                      opacity: 0.88,
                                      flexShrink: 0,
                                    }}
                                    title="Display duration (minutes & seconds)"
                                  >
                                    <input
                                      type="number"
                                      min={0}
                                      max={1440}
                                      aria-label="Duration minutes"
                                      value={durMins}
                                      onChange={(e) => {
                                        const nextM = Math.max(0, Math.min(1440, Math.floor(Number(e.target.value) || 0)));
                                        const nextTotal = Math.max(1, nextM * 60 + durSecs);
                                        tournamentStore.updateTvPlaylistItem(item.id, {
                                          durationSec: nextTotal,
                                          autoDuration: false,
                                        });
                                      }}
                                      style={{
                                        width: '36px',
                                        padding: '0.12rem 0.2rem',
                                        borderRadius: '4px',
                                        border: '1px solid rgba(148, 163, 184, 0.3)',
                                        background: 'rgba(15, 23, 42, 0.85)',
                                        color: 'inherit',
                                        fontSize: '0.72rem',
                                        textAlign: 'center',
                                      }}
                                    />
                                    <span>m</span>
                                    <input
                                      type="number"
                                      min={0}
                                      max={59}
                                      aria-label="Duration seconds"
                                      value={durSecs}
                                      onChange={(e) => {
                                        const nextS = Math.max(0, Math.min(59, Math.floor(Number(e.target.value) || 0)));
                                        const nextTotal = Math.max(1, durMins * 60 + nextS);
                                        tournamentStore.updateTvPlaylistItem(item.id, {
                                          durationSec: nextTotal,
                                          autoDuration: false,
                                        });
                                      }}
                                      style={{
                                        width: '32px',
                                        padding: '0.12rem 0.2rem',
                                        borderRadius: '4px',
                                        border: '1px solid rgba(148, 163, 184, 0.3)',
                                        background: 'rgba(15, 23, 42, 0.85)',
                                        color: 'inherit',
                                        fontSize: '0.72rem',
                                        textAlign: 'center',
                                      }}
                                    />
                                    <span>s</span>
                                  </span>
                                );
                              })()
                            )}

                            {supportsAudio && (
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                onClick={() =>
                                  tournamentStore.updateTvPlaylistItem(item.id, {
                                    muted: !item.muted,
                                  })
                                }
                                title={
                                  item.muted
                                    ? 'Always muted (click to follow global TV sound)'
                                    : 'Follows global TV mute (click to always mute this item)'
                                }
                                aria-pressed={Boolean(item.muted)}
                                style={{
                                  padding: '0.12rem 0.34rem',
                                  fontSize: '0.7rem',
                                  flexShrink: 0,
                                  borderColor: item.muted ? 'rgba(245, 158, 11, 0.65)' : undefined,
                                  background: item.muted ? 'rgba(245, 158, 11, 0.2)' : undefined,
                                }}
                              >
                                {item.muted ? '🔇' : '🔊'}
                              </button>
                            )}

                            {isYoutubeItem && (
                              <select
                                aria-label="YouTube resolution"
                                value={item.quality || 'tiny'}
                                onChange={(e) =>
                                  tournamentStore.updateTvPlaylistItem(item.id, {
                                    quality: e.target.value,
                                  })
                                }
                                title="YouTube playback resolution (defaults to lowest available: 144p)"
                                style={{
                                  padding: '0.12rem 0.25rem',
                                  borderRadius: '4px',
                                  border: '1px solid rgba(56, 189, 248, 0.45)',
                                  background: 'rgba(15, 23, 42, 0.92)',
                                  color: '#7dd3fc',
                                  fontSize: '0.68rem',
                                  fontWeight: 700,
                                  flexShrink: 0,
                                  cursor: 'pointer',
                                }}
                              >
                                {YOUTUBE_QUALITY_OPTIONS.map((opt) => (
                                  <option key={opt.id} value={opt.id}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
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

                    {tvUploadLog.length > 0 && (
                      <div
                        style={{
                          marginTop: '0.45rem',
                          padding: '0.4rem 0.55rem',
                          borderRadius: '7px',
                          background: 'rgba(15, 23, 42, 0.72)',
                          border: '1px solid rgba(148, 163, 184, 0.22)',
                          fontSize: '0.72rem',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.22rem',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            opacity: 0.75,
                            fontWeight: 700,
                          }}
                        >
                          <span>Upload Log</span>
                          <button
                            type="button"
                            onClick={() => setTvUploadLog([])}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'inherit',
                              cursor: 'pointer',
                              fontSize: '0.7rem',
                              padding: 0,
                            }}
                          >
                            Clear
                          </button>
                        </div>
                        {tvUploadLog.map((entry) => (
                          <div
                            key={entry.id}
                            style={{
                              color: entry.ok ? '#a7f3d0' : '#fca5a5',
                              wordBreak: 'break-word',
                              lineHeight: 1.3,
                            }}
                          >
                            <span style={{ opacity: 0.6, marginRight: '0.35rem' }}>{entry.time}</span>
                            {entry.text}
                          </div>
                        ))}
                      </div>
                    )}
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
          onYoutubeMetaDetected={({ itemId, durationSec, title }) => {
            const target = tvPlaylist.find((x) => x.id === itemId);
            if (!target) return;
            const patch = {};
            // Auto-fill exact duration from the live YouTube iframe when server-side metadata fell back to 60s
            if (
              durationSec &&
              durationSec !== target.durationSec &&
              (target.autoDuration === true || (target.autoDuration !== false && target.durationSec === 60))
            ) {
              patch.durationSec = durationSec;
              patch.autoDuration = false;
            }
            if (title && /^YouTube \([^)]+\)$/i.test(target.name || '')) {
              patch.name = title;
            }
            if (Object.keys(patch).length > 0) {
              tournamentStore.updateTvPlaylistItem(itemId, patch);
              if (target.kind === 'url' && target.url) {
                rememberTvUrl({ ...target, ...patch });
              }
            }
          }}
        />
      )}
    </div>
  );
}
