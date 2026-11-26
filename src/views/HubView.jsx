import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  THEME_OPTIONS,
  deduplicateTournamentLists,
  tournamentStore,
} from '../state/tournamentStore.js';
import { normalizeFourWordId } from '../engine/tournamentId.js';
import { clampPlayerCount, MIN_PLAYERS, MAX_PLAYERS } from '../engine/bracketGenerator.js';
import { resolveShareOrigin } from '../components/ShareTournamentModal.jsx';
import { formatBuildTooltip, formatVersionBadge } from '../engine/appVersion.js';

function formatRelativeTime(ts) {
  if (!ts) return 'Just now';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDestroyCountdown(destroyAt, nowMs) {
  const remainingSec = Math.max(0, Math.ceil((Number(destroyAt || 0) - nowMs) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Tournament Hub (First-Visit Landing Page)
 * Built for effortless 2-second comprehension on phones, tablets, TVs, and laptops:
 *  - Primary focus: Join by 4-word key or tap a Live Tournament.
 *  - Secondary actions (+ New Tournament modal, ⚙ Network & Device Settings drawer,
 *    collapsible Local Tournaments, and per-card ⋯ details drawer) stay out of the
 *    way until needed.
 */
export default function HubView({
  activeTournamentId,
  remoteSync,
  onEnterTournament,
  onOpenAdminPanel,
}) {
  const [localTournaments, setLocalTournaments] = useState(() => tournamentStore.listTournaments());
  const [confirmDeleteKey, setConfirmDeleteKey] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [accessDeniedNotice, setAccessDeniedNotice] = useState(null);
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);
  const [showLocalSection, setShowLocalSection] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [openCardMenuId, setOpenCardMenuId] = useState(null);

  const [serverUrlDraft, setServerUrlDraft] = useState(remoteSync?.customServerUrl || '');
  const [deviceNameDraft, setDeviceNameDraft] = useState(remoteSync?.deviceName || '');
  const [adminKeyInput, setAdminKeyInput] = useState('');
  const [joinKeyInput, setJoinKeyInput] = useState('');
  const [guestPromptTargetId, setGuestPromptTargetId] = useState(null);
  const [guestPromptKey, setGuestPromptKey] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  const hubSettings = remoteSync?.hubSettings || {
    hubTitle: 'JITTER',
    allowPublicCreation: true,
    defaultIsPublic: true,
    defaultIsSecure: true,
    defaultRequireScorekeeperApproval: true,
  };
  const isThisDeviceAdmin = Boolean(remoteSync?.isThisDeviceAdmin);
  const isLocalServerMachine = Boolean(remoteSync?.serverInfo?.isLocalClient);
  const canCreateCloud = isThisDeviceAdmin || hubSettings.allowPublicCreation !== false;

  // New Tournament Modal form state
  const [newName, setNewName] = useState('');
  const [newEntryMode, setNewEntryMode] = useState('singles');
  const [newFormat, setNewFormat] = useState('single');
  const [newRoster, setNewRoster] = useState([]);
  const [newPlayerDraft, setNewPlayerDraft] = useState('');
  const newPlayerInputRef = useRef(null);
  const [hostNewOnCloud, setHostNewOnCloud] = useState(true);
  const [newIsPublic, setNewIsPublic] = useState(true);
  const [newIsSecure, setNewIsSecure] = useState(true);

  const createDialogRef = useRef(null);

  useEffect(() => {
    if (showCreateModal) {
      setHostNewOnCloud(canCreateCloud);
      setNewIsPublic(hubSettings.defaultIsPublic !== false);
      setNewIsSecure(
        hubSettings.defaultIsPublic !== false ? hubSettings.defaultIsSecure !== false : true
      );
    }
  }, [showCreateModal, canCreateCloud, hubSettings.defaultIsPublic, hubSettings.defaultIsSecure]);

  useEffect(() => {
    tournamentStore.syncWithRemoteServer();
    setLocalTournaments(tournamentStore.listTournaments());
  }, []);

  useEffect(() => {
    if (remoteSync?.deviceName) setDeviceNameDraft(remoteSync.deviceName);
  }, [remoteSync?.deviceName]);

  useEffect(() => {
    if (remoteSync?.kickedNotice?.reason) {
      setStatusMsg(
        remoteSync.kickedNotice.kind === 'destroyed'
          ? remoteSync.kickedNotice.reason
          : `⏏ ${remoteSync.kickedNotice.reason}`
      );
      tournamentStore.clearKickedNotice();
    }
  }, [remoteSync?.kickedNotice?.id]);

  // Real-time feedback when a Host/Admin/Moderator approves or denies this device's join request
  useEffect(() => {
    const notice = remoteSync?.joinResolutionNotice;
    if (!notice) return;
    tournamentStore.clearJoinResolutionNotice();
    if (notice.approved && notice.tournamentId) {
      setAccessDeniedNotice(null);
      setGuestPromptTargetId(null);
      setGuestPromptKey('');
      flashStatus(`✅ Approved to join "${notice.tournamentName}" — entering now!`);
      tournamentStore.selectCloudTournament(notice.tournamentId).then((res) => {
        if (res?.ok && res.state) {
          onEnterTournament?.(res.state.tournamentId);
        }
      });
    } else if (!notice.approved) {
      setAccessDeniedNotice({
        tournamentId: notice.tournamentId || null,
        tournamentName: notice.tournamentName || 'this tournament',
      });
    }
  }, [remoteSync?.joinResolutionNotice?.id]);

  // Sync native <dialog> for "+ New Tournament"
  useEffect(() => {
    const dialog = createDialogRef.current;
    if (!dialog) return undefined;
    if (showCreateModal && !dialog.open) {
      dialog.showModal();
    } else if (!showCreateModal && dialog.open) {
      dialog.close();
    }
    return undefined;
  }, [showCreateModal]);

  useEffect(() => {
    const dialog = createDialogRef.current;
    if (!dialog) return undefined;
    const handleClose = () => {
      dialog.returnValue = '';
      setShowCreateModal(false);
    };
    dialog.addEventListener('close', handleClose);
    let removeFallback = () => {};
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const isOutside = (e) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      let downOut = false;
      const onDown = (e) => {
        downOut = isOutside(e);
      };
      const onUp = (e) => {
        if (downOut && isOutside(e)) dialog.close();
        downOut = false;
      };
      dialog.addEventListener('pointerdown', onDown);
      dialog.addEventListener('pointerup', onUp);
      removeFallback = () => {
        dialog.removeEventListener('pointerdown', onDown);
        dialog.removeEventListener('pointerup', onUp);
      };
    }
    return () => {
      dialog.removeEventListener('close', handleClose);
      removeFallback();
    };
  }, []);

  const cloudTournaments = remoteSync?.cloudTournaments || [];
  const hasPendingDestructions = cloudTournaments.some((t) => Boolean(t?.destruction?.destroyAt));
  useEffect(() => {
    if (!hasPendingDestructions) return undefined;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasPendingDestructions]);

  const totalCloudTournaments = Math.max(
    Number(remoteSync?.totalCloudTournaments) || 0,
    cloudTournaments.length
  );
  const privateCloudCount = Math.max(0, Number(remoteSync?.privateCloudCount) || 0);
  const { localOnly: localOnlyTournaments, backedUpCloudIds, backedUpCloudCodes } = useMemo(
    () => deduplicateTournamentLists(cloudTournaments, localTournaments),
    [cloudTournaments, localTournaments]
  );

  const isConnected = Boolean(remoteSync?.connected);
  const myDeviceId = remoteSync?.deviceId || '';
  const unlockedGuestKeys = remoteSync?.unlockedGuestKeys || {};
  const cloudActiveId = remoteSync?.cloudActiveTournamentId || null;

  const primaryLanUrl = useMemo(
    () => resolveShareOrigin(remoteSync?.serverInfo, remoteSync?.customServerUrl),
    [remoteSync?.serverInfo, remoteSync?.customServerUrl]
  );

  const flashStatus = (msg) => {
    setStatusMsg(msg);
    setTimeout(() => {
      setStatusMsg((curr) => (curr === msg ? '' : curr));
    }, 3400);
  };

  const handleOpenCloud = async (t, providedKey = '') => {
    const res = await tournamentStore.selectCloudTournament(t.id, { joinCode: providedKey });
    if (res?.ok && res.state) {
      setGuestPromptTargetId(null);
      setGuestPromptKey('');
      setOpenCardMenuId(null);
      onEnterTournament?.(res.state.tournamentId);
    } else if (res?.requiresKey) {
      setGuestPromptTargetId(t.id);
      if (providedKey) {
        flashStatus('Incorrect 4-word key — ask the host for the exact key.');
      } else {
        flashStatus(`Enter the 4-word key from ${t.hostDeviceName || 'the host'} to join.`);
      }
    } else {
      flashStatus(res?.error || 'Could not join tournament — check connection.');
    }
  };

  const handleJoinByKey = async (e) => {
    e.preventDefault();
    const cleaned = normalizeFourWordId(joinKeyInput);
    if (!cleaned) return;
    const res = await tournamentStore.joinTournamentByCode(cleaned);
    if (res.found && res.state) {
      setJoinKeyInput('');
      onEnterTournament?.(res.state.tournamentId);
    } else {
      flashStatus(`No tournament found for key "${cleaned}"`);
    }
  };

  const handleCopyText = async (text, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flashStatus(`Copied ${label}: ${text}`);
    } catch {
      flashStatus(`${label}: ${text}`);
    }
  };

  const handleCopyCloudToLocal = async (t) => {
    const copied = await tournamentStore.copyCloudTournamentToLocal(t.id);
    setOpenCardMenuId(null);
    if (copied) {
      setLocalTournaments(tournamentStore.listTournaments());
      flashStatus(`Saved offline copy of "${copied.tournamentName}"`);
    } else {
      flashStatus('Unlock this tournament first before saving an offline copy.');
    }
  };

  const handleDeleteCloud = async (id) => {
    const key = `cloud:${id}`;
    if (confirmDeleteKey !== key) {
      setConfirmDeleteKey(key);
      return;
    }
    const ok = await tournamentStore.deleteCloudTournament(id);
    setConfirmDeleteKey(null);
    setOpenCardMenuId(null);
    setLocalTournaments(tournamentStore.listTournaments());
    if (ok) flashStatus('Deleted tournament');
  };

  const handleOpenLocal = (id) => {
    const loaded = tournamentStore.selectTournament(id);
    if (loaded) onEnterTournament?.(loaded.tournamentId);
  };

  const handlePublishLocalToCloud = async (id) => {
    const res = await tournamentStore.publishLocalTournamentToCloud(id, { activate: true });
    if (res) {
      setLocalTournaments(tournamentStore.listTournaments());
      flashStatus('Moved tournament live to Network!');
    } else {
      flashStatus('Could not publish — server unreachable.');
    }
  };

  const handleDeleteLocal = (id) => {
    const key = `local:${id}`;
    if (confirmDeleteKey !== key) {
      setConfirmDeleteKey(key);
      return;
    }
    tournamentStore.deleteTournament(id);
    setConfirmDeleteKey(null);
    setLocalTournaments(tournamentStore.listTournaments());
    flashStatus('Deleted local tournament');
  };

  const handleAddCreatePlayer = () => {
    if (newRoster.length >= MAX_PLAYERS) return;
    const typed = newPlayerDraft.trim();
    const name = typed || `Player ${newRoster.length + 1}`;
    setNewRoster((prev) => [
      ...prev,
      { id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name },
    ]);
    setNewPlayerDraft('');
    requestAnimationFrame(() => newPlayerInputRef.current?.focus());
  };

  const handleEditCreatePlayer = (idx, value) => {
    setNewRoster((prev) => prev.map((p, i) => (i === idx ? { ...p, name: value } : p)));
  };

  const handleRemoveCreatePlayer = (idx) => {
    setNewRoster((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCreate = (e) => {
    e.preventDefault();
    const isTeams = newEntryMode === 'teams';
    const minNeeded = isTeams ? 4 : MIN_PLAYERS;
    const targetCount = Math.max(minNeeded, newRoster.length);
    const cleanedRoster = Array.from({ length: targetCount }, (_, idx) => {
      const p = newRoster[idx];
      return {
        id: p?.id || `r${idx + 1}`,
        name: p?.name?.trim() || `Player ${idx + 1}`,
      };
    });
    const humans = cleanedRoster.length;
    const entrants = isTeams ? Math.max(2, Math.ceil(humans / 2)) : humans;
    const initialPlayers = isTeams
      ? Array.from({ length: entrants }, (_, i) => {
          const pA = cleanedRoster[i * 2] || null;
          const pB = cleanedRoster[i * 2 + 1] || null;
          return {
            id: `p${i + 1}`,
            seed: i + 1,
            name: `Team ${i + 1}`,
            memberIds: [pA?.id || '', pB?.id || ''],
            members: [pA?.name || '', pB?.name || ''],
          };
        })
      : cleanedRoster.map((p, idx) => ({
          id: `p${idx + 1}`,
          seed: idx + 1,
          name: p.name,
        }));

    const created = tournamentStore.createNewTournament(
      {
        tournamentName: newName.trim() || 'GRAND RETRO PING PONG CHAMPIONSHIP',
        entryMode: newEntryMode,
        format: newFormat,
        playerCount: entrants,
        totalPlayers: humans,
        roster: cleanedRoster,
        players: initialPlayers,
        rules: {
          requireScorekeeperApproval: hubSettings.defaultRequireScorekeeperApproval !== false,
        },
      },
      {
        hostOnCloud: hostNewOnCloud && isConnected && canCreateCloud,
        isSecure: newIsPublic ? newIsSecure : true,
        isPublic: newIsPublic,
      }
    );
    setLocalTournaments(tournamentStore.listTournaments());
    setShowCreateModal(false);
    setNewName('');
    setNewRoster([]);
    setNewPlayerDraft('');
    onEnterTournament?.(created.tournamentId);
  };

  const handleSaveServerUrl = async (e) => {
    e.preventDefault();
    tournamentStore.setDeviceName(deviceNameDraft);
    const res = await tournamentStore.setSyncServerUrl(serverUrlDraft);
    if (res) {
      flashStatus(`Connected to ${serverUrlDraft.trim() || window.location.origin}`);
    } else {
      flashStatus('Could not reach that server URL.');
    }
  };

  const handleUnlockAdmin = async (e) => {
    e.preventDefault();
    const cleaned = adminKeyInput.trim();
    if (!cleaned) return;
    const res = await tournamentStore.unlockHubAdminWithKey(cleaned);
    if (res.ok) {
      setAdminKeyInput('');
      setShowSettingsDrawer(false);
      flashStatus('🛡️ Hub Admin unlocked on this device!');
    } else {
      flashStatus(res.error || 'Invalid Hub Admin Key');
    }
  };

  const importFileInputRef = useRef(null);

  const handleImportJsonFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const res = await tournamentStore.importBackupJSON(text, {
        hostOnCloud: isConnected,
        assignAsHost: true,
      });
      if (!res.ok) {
        flashStatus(res.error || 'Failed to import tournament JSON');
        return;
      }
      setLocalTournaments(tournamentStore.listTournaments());
      setShowSettingsDrawer(false);
      const label =
        res.count > 1
          ? `Imported ${res.count} tournaments (opened "${res.tournament.tournamentName}")`
          : `Imported "${res.tournament.tournamentName}"`;
      flashStatus(`✅ ${label}`);
      onEnterTournament?.(res.tournament.tournamentId);
    } catch {
      flashStatus('Could not read the selected JSON file.');
    }
  };

  const handleClaimLocalAdmin = async () => {
    const res = await tournamentStore.claimLocalHubAdmin();
    if (res.ok) {
      setShowSettingsDrawer(false);
      flashStatus('🛡️ Hub Admin enabled on this server computer!');
    } else {
      flashStatus(res.error || 'Could not enable local Hub Admin');
    }
  };

  const autoShowLocal = !isConnected || (cloudTournaments.length === 0 && localOnlyTournaments.length > 0);
  const localExpanded = showLocalSection || autoShowLocal;

  return (
    <div className="simple-hub-shell">
      <div className="simple-hub-container">
        {/* 1. Minimal Single-Row Top Bar */}
        <header className="simple-hub-header">
          <div className="simple-hub-brand">
            <span className="simple-hub-logo" aria-hidden="true">
              🏓
            </span>
            <div>
              <h1 className="simple-hub-title">{hubSettings.hubTitle || 'JITTER'}</h1>
              <div className="simple-hub-subrow">
                <span className={`simple-dot ${isConnected ? 'is-online' : 'is-offline'}`} />
                <span>{isConnected ? 'Connected' : 'Offline Mode'}</span>
                {isThisDeviceAdmin && <span className="simple-admin-dot">· 🛡️ Hub Admin</span>}
              </div>
            </div>
          </div>

          <div className="simple-hub-actions">
            <span
              className="nav-tab-id-pill"
              title={`Current Session ID: ${tournamentStore.getTabId()}`}
            >
              {tournamentStore.getTabId()}
            </span>
            {isThisDeviceAdmin && onOpenAdminPanel && (
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => onOpenAdminPanel()}
                title="Open Hub Admin Panel"
              >
                🛡️ Admin Panel
              </button>
            )}
            <button
              type="button"
              className={`btn-secondary btn-sm ${showSettingsDrawer ? 'is-toggled-on' : ''}`}
              onClick={() => setShowSettingsDrawer((v) => !v)}
              aria-expanded={showSettingsDrawer}
              title="Device name, LAN share URL, sync server & Hub Admin access"
            >
              ⚙ Settings
            </button>
            <button
              type="button"
              className="btn-amber btn-sm simple-new-btn"
              onClick={() => setShowCreateModal(true)}
            >
              + New Tournament
            </button>
          </div>
        </header>

        {/* Collapsible Device & Network Settings Drawer (Closed by Default) */}
        {showSettingsDrawer && (
          <section className="panel-card simple-settings-drawer" aria-label="Network and Device Settings">
            <div className="ssd-top-row">
              <div className="ssd-url-box">
                <span className="ssd-label">Share URL on Wi-Fi</span>
                <div className="ssd-url-line">
                  <code>{primaryLanUrl}</code>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => handleCopyText(primaryLanUrl, 'Join URL')}
                  >
                    Copy
                  </button>
                </div>
              </div>
            </div>

            <form onSubmit={handleSaveServerUrl} className="lsb-config-form">
              <div className="form-field">
                <label htmlFor="simple-device-name">Device Name</label>
                <input
                  id="simple-device-name"
                  type="text"
                  value={deviceNameDraft}
                  onChange={(e) => setDeviceNameDraft(e.target.value)}
                  placeholder="e.g. Living Room TV, Dave's Phone"
                />
              </div>
              <div className="form-field">
                <label htmlFor="simple-server-url">Sync Server URL (optional)</label>
                <input
                  id="simple-server-url"
                  type="url"
                  value={serverUrlDraft}
                  onChange={(e) => setServerUrlDraft(e.target.value)}
                  placeholder={typeof window !== 'undefined' ? window.location.origin : ''}
                />
              </div>
              <div className="lsb-config-btns">
                <button type="submit" className="btn-primary btn-sm">
                  Save
                </button>
              </div>
            </form>

            {/* Hub Admin Access Block (Option C: Local Server 1-Click + 4-Word Admin Key) */}
            {isConnected && (
              <div className="ssd-admin-block">
                <span className="ssd-label">🛡️ Hub Admin Access</span>
                {isThisDeviceAdmin ? (
                  <div className="ssd-admin-row">
                    <span className="ssd-admin-active">
                      This device is an authorized Hub Admin.
                    </span>
                    {onOpenAdminPanel && (
                      <button
                        type="button"
                        className="btn-primary btn-sm"
                        onClick={() => {
                          setShowSettingsDrawer(false);
                          onOpenAdminPanel();
                        }}
                      >
                        Open Admin Panel →
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="ssd-admin-unlock-wrap">
                    {isLocalServerMachine && (
                      <button
                        type="button"
                        className="btn-amber btn-sm"
                        onClick={handleClaimLocalAdmin}
                      >
                        🛡️ Enable Admin (This Server)
                      </button>
                    )}
                    <form onSubmit={handleUnlockAdmin} className="ssd-admin-key-form">
                      <input
                        type="text"
                        value={adminKeyInput}
                        onChange={(e) => setAdminKeyInput(e.target.value)}
                        placeholder="Enter Hub Admin Key or passphrase..."
                        aria-label="Hub Admin Key or passphrase"
                        autoComplete="off"
                        spellCheck="false"
                      />
                      <button
                        type="submit"
                        className="btn-secondary btn-sm"
                        disabled={!adminKeyInput.trim()}
                      >
                        Unlock Admin
                      </button>
                    </form>
                  </div>
                )}
              </div>
            )}

            {/* Import Tournament JSON Backup */}
            <div className="ssd-admin-block">
              <span className="ssd-label">📦 Tournament Backup</span>
              <div className="ssd-admin-row">
                <span className="ssd-admin-active">
                  Upload a tournament JSON backup or sync data file.
                </span>
                <input
                  ref={importFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={handleImportJsonFile}
                />
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => importFileInputRef.current?.click()}
                  title="Upload a tournament JSON backup or .pingpong-sync-data.json file"
                >
                  ⬆ Import JSON
                </button>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                fontSize: '0.72rem',
                opacity: 0.65,
                marginTop: '0.25rem',
              }}
              title={formatBuildTooltip()}
            >
              <span>Jitter {formatVersionBadge()}</span>
            </div>
          </section>
        )}

        {accessDeniedNotice && (
          <div className="hub-access-denied-banner" role="alert">
            <div className="had-text">
              <strong>🚫 Access Denied</strong>
              <span>
                Your request to join <strong>{accessDeniedNotice.tournamentName}</strong> was denied.
                You can enter the 4-word key if you have it, or ask the host.
              </span>
            </div>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => setAccessDeniedNotice(null)}
              aria-label="Dismiss access denied notice"
            >
              ✕ Dismiss
            </button>
          </div>
        )}

        {statusMsg && (
          <div className="launcher-status-banner" role="status" aria-live="polite">
            {statusMsg}
          </div>
        )}

        {/* 2. Prominent, Friendly Join-by-Key Bar */}
        <form onSubmit={handleJoinByKey} className="simple-key-hero" aria-label="Join by 4-Word Key">
          <span className="simple-key-icon" aria-hidden="true">
            🔑
          </span>
          <input
            type="text"
            value={joinKeyInput}
            onChange={(e) => setJoinKeyInput(e.target.value)}
            placeholder="Have a 4-word key? Type it here (spaces, dashes, or run-on OK)..."
            aria-label="Enter 4-word tournament key"
            autoComplete="off"
            spellCheck="false"
          />
          <button
            type="submit"
            className="btn-amber"
            disabled={!normalizeFourWordId(joinKeyInput)}
          >
            Join
          </button>
        </form>

        {/* 3. Clean Single-Column Live Tournaments List */}
        <section className="simple-section" aria-label="Live Tournaments">
          <div className="simple-section-head">
            <div className="simple-section-title-group">
              <h2>Live Tournaments</h2>
              {isConnected && (
                <span className="simple-count-chip">
                  {totalCloudTournaments} available
                  {privateCloudCount > 0 ? ` · ${privateCloudCount} private` : ''}
                </span>
              )}
            </div>
            {isConnected && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={async () => {
                  await tournamentStore.syncWithRemoteServer();
                  flashStatus('Refreshed tournaments');
                }}
              >
                ↻ Refresh
              </button>
            )}
          </div>

          {!isConnected ? (
            <div className="simple-empty-card">
              <p>Not connected to a network server right now.</p>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setShowSettingsDrawer(true)}
              >
                Open Server Settings
              </button>
            </div>
          ) : cloudTournaments.length === 0 ? (
            <div className="simple-empty-card">
              <p>
                {privateCloudCount > 0
                  ? `${privateCloudCount} private tournament${
                      privateCloudCount === 1 ? ' is' : 's are'
                    } running — enter the 4-word key above to join.`
                  : 'No live tournaments yet. Ready to start the first match?'}
              </p>
              <button
                type="button"
                className="btn-amber"
                onClick={() => setShowCreateModal(true)}
              >
                + Start a Tournament
              </button>
            </div>
          ) : (
            <div className="simple-card-list">
              {cloudTournaments.map((t) => {
                const themeDef = THEME_OPTIONS.find((x) => x.id === t.theme) || THEME_OPTIONS[0];
                const joinKey = t.joinCode || t.id;
                const isOwnHosted = Boolean(t.hostDeviceId && t.hostDeviceId === myDeviceId);
                const hasNoAssignedHost = !t.hostDeviceId;
                const isSecure = t.isSecure !== false;
                const isPublic = t.isPublic !== false;
                const isUnlockedGuest =
                  t.isAuthorized === true ||
                  (Boolean(unlockedGuestKeys[t.id]) && t.isAuthorized !== false);
                const canEnterDirectly =
                  isThisDeviceAdmin || isOwnHosted || hasNoAssignedHost || !isSecure || isUnlockedGuest;
                const isJoinRequestPending = Boolean(t.joinRequestPending);
                const isPromptingKey = guestPromptTargetId === t.id;
                const isMenuOpen = openCardMenuId === `cloud:${t.id}`;
                const deleteKey = `cloud:${t.id}`;
                const isLiveActive = t.id === cloudActiveId;
                const pct =
                  t.totalMatches > 0
                    ? Math.round((t.completedMatches / t.totalMatches) * 100)
                    : 0;
                const hasOfflineBackup =
                  backedUpCloudIds.has(t.id) ||
                  backedUpCloudCodes.has(normalizeFourWordId(joinKey));
                const canCancelDestroy = Boolean(
                  t.destruction?.destroyAt &&
                    (isThisDeviceAdmin ||
                      t.canCancelDestruction ||
                      (Array.isArray(t.hostHistory) && t.hostHistory.includes(myDeviceId)))
                );

                return (
                  <div
                    key={`cloud-${t.id}`}
                    className={`simple-t-card ${t.id === activeTournamentId ? 'is-active' : ''}`}
                  >
                    <div className="stc-main">
                      <div className="stc-info">
                        <span className="stc-icon" aria-hidden="true">
                          {themeDef.icon}
                        </span>
                        <div className="stc-text">
                          <div className="stc-title-row">
                            <h3 className="stc-name">{t.tournamentName}</h3>
                            {!isPublic && <span className="stc-tag">Private</span>}
                            {isSecure && !canEnterDirectly && (
                              <span className="stc-tag" title="4-word key or host approval required">
                                {isJoinRequestPending ? '⏳ Requested' : '🔒'}
                              </span>
                            )}
                            {isOwnHosted && <span className="stc-tag is-host">Host</span>}
                            {t.destruction?.destroyAt && (
                              <span className="stc-tag is-danger">
                                💣 {formatDestroyCountdown(t.destruction.destroyAt, nowMs)}
                              </span>
                            )}
                          </div>
                          <div className="stc-meta">
                            <span>{t.hostDeviceName || 'Sync Host'}</span>
                            <span>·</span>
                            <span>{t.totalPlayers} players</span>
                            <span>·</span>
                            <span>
                              {t.championName
                                ? `🏆 ${t.championName}`
                                : `${t.completedMatches}/${t.totalMatches} matches`}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="stc-actions">
                        {canCancelDestroy && (
                          <button
                            type="button"
                            className="btn-primary btn-sm"
                            onClick={async () => {
                              const res = await tournamentStore.claimTournamentHost(t.id);
                              if (res.ok) {
                                flashStatus(`Cancelled destruction of "${t.tournamentName}"!`);
                              } else {
                                flashStatus(res.error || 'Could not cancel destruction');
                              }
                            }}
                          >
                            🛡️ Cancel Destroy
                          </button>
                        )}

                        {canEnterDirectly ? (
                          <button
                            type="button"
                            className="btn-amber"
                            onClick={() => handleOpenCloud(t)}
                          >
                            {isOwnHosted ? 'Open' : 'Join'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn-amber"
                            onClick={() => {
                              setGuestPromptTargetId(isPromptingKey ? null : t.id);
                              setGuestPromptKey('');
                            }}
                          >
                            🔑 Join
                          </button>
                        )}

                        <button
                          type="button"
                          className={`btn-secondary btn-sm stc-more-btn ${isMenuOpen ? 'is-toggled-on' : ''}`}
                          onClick={() =>
                            setOpenCardMenuId(isMenuOpen ? null : `cloud:${t.id}`)
                          }
                          aria-expanded={isMenuOpen}
                          aria-label={`Show details and options for ${t.tournamentName}`}
                          title="Show full tournament details & options"
                        >
                          ⋯
                        </button>
                      </div>
                    </div>

                    {/* Inline Join Prompt: Enter 4-Word Key OR Request Access from Host */}
                    {isPromptingKey && (
                      <div className="stc-join-prompt">
                        <form
                          className="stc-inline-key"
                          onSubmit={(e) => {
                            e.preventDefault();
                            handleOpenCloud(t, guestPromptKey);
                          }}
                        >
                          <input
                            type="text"
                            value={guestPromptKey}
                            onChange={(e) => setGuestPromptKey(e.target.value)}
                            placeholder="Enter 4-word key (run-on OK)..."
                            aria-label={`4-word key for ${t.tournamentName}`}
                            autoFocus
                            autoComplete="off"
                            spellCheck="false"
                          />
                          <button
                            type="submit"
                            className="btn-amber btn-sm"
                            disabled={!normalizeFourWordId(guestPromptKey)}
                          >
                            Unlock
                          </button>
                          <button
                            type="button"
                            className="btn-secondary btn-sm"
                            onClick={() => {
                              setGuestPromptTargetId(null);
                              setGuestPromptKey('');
                            }}
                          >
                            Cancel
                          </button>
                        </form>

                        <div className="stc-request-access-row">
                          {isJoinRequestPending ? (
                            <span className="stc-request-pending">
                              ⏳ Access requested — waiting for {t.hostDeviceName || 'the host'} to
                              approve (you&apos;ll join automatically once approved)
                            </span>
                          ) : (
                            <>
                              <span
                                className={
                                  accessDeniedNotice?.tournamentId === t.id
                                    ? 'stc-request-denied'
                                    : 'stc-request-or'
                                }
                              >
                                {accessDeniedNotice?.tournamentId === t.id
                                  ? '🚫 Access denied by host'
                                  : "Don't have the key?"}
                              </span>
                              <button
                                type="button"
                                className="btn-primary btn-sm"
                                onClick={async () => {
                                  if (accessDeniedNotice?.tournamentId === t.id) {
                                    setAccessDeniedNotice(null);
                                  }
                                  const res = await tournamentStore.requestTournamentJoinAccess(t.id);
                                  if (res.ok && res.approved) {
                                    handleOpenCloud(t);
                                  } else if (res.ok && res.pending) {
                                    flashStatus(
                                      `✋ Join request sent to ${t.hostDeviceName || 'the host'} for "${t.tournamentName}"!`
                                    );
                                  } else {
                                    flashStatus(res.error || 'Could not send join request');
                                  }
                                }}
                              >
                                ✋ Request Access
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Expanded Details & Options Drawer (Revealed on ⋯ Click) */}
                    {isMenuOpen && (
                      <div className="stc-details-drawer">
                        <div className="stc-details-badges">
                          <span className="stc-pill is-cloud">☁️ CLOUD</span>
                          <span className="stc-pill">
                            {isPublic ? '🌐 PUBLIC' : '🕶️ PRIVATE'}
                          </span>
                          <span className="stc-pill">
                            {isSecure ? '🔒 SECURE' : '🔓 OPEN'}
                          </span>
                          {isOwnHosted ? (
                            <span className="stc-pill is-host">👑 YOUR HOST</span>
                          ) : hasNoAssignedHost ? (
                            <span className="stc-pill is-host">👑 UNCLAIMED</span>
                          ) : isSecure ? (
                            <span className="stc-pill">
                              {isUnlockedGuest ? '✓ UNLOCKED' : '🔒 KEY REQUIRED'}
                            </span>
                          ) : null}
                          {isLiveActive && <span className="stc-pill is-live">● ACTIVE</span>}
                          {hasOfflineBackup && (
                            <span className="stc-pill is-live">✓ OFFLINE COPY</span>
                          )}
                        </div>

                        <div className="stc-details-meta-grid">
                          <div>
                            <span className="stc-dlabel">Host</span>
                            <div className="stc-dval">
                              <strong>{t.hostDeviceName || 'Sync Host'}</strong>
                              {t.hostIp && <code className="stc-ip-code">{t.hostIp}</code>}
                            </div>
                          </div>
                          <div>
                            <span className="stc-dlabel">Format</span>
                            <div className="stc-dval">
                              {t.entryMode === 'teams' ? 'Teams (2v2)' : 'Singles (1v1)'} ·{' '}
                              {t.format === 'double' ? 'Double Elim' : 'Single Elim'} ·{' '}
                              {t.totalPlayers} Players
                              {t.entryMode === 'teams' ? ` (${t.playerCount} Teams)` : ''}
                            </div>
                          </div>
                          <div>
                            <span className="stc-dlabel">Updated</span>
                            <div className="stc-dval">{formatRelativeTime(t.updatedAt)}</div>
                          </div>
                        </div>

                        <div className="stc-details-key-row">
                          {canEnterDirectly ? (
                            <button
                              type="button"
                              className="stc-key-chip"
                              onClick={() => handleCopyText(joinKey, '4-word key')}
                              title="Click to copy 4-word Key"
                            >
                              🔑 <code>{joinKey}</code>
                            </button>
                          ) : (
                            <span className="stc-locked-hint">
                              🔒 Ask {t.hostDeviceName || 'the host'} for the 4-word Key to join
                            </span>
                          )}
                        </div>

                        <div className="stc-progress-block">
                          <div className="stc-progress-bar" aria-hidden="true">
                            <div className="stc-progress-fill" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="stc-progress-lbl">
                            {t.championName
                              ? `🏆 Champion: ${t.championName}`
                              : `${t.completedMatches} / ${t.totalMatches} Matches Complete (${pct}%)`}
                          </span>
                        </div>

                        <div className="stc-more-bar">
                          {canEnterDirectly && (
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              onClick={() => handleCopyCloudToLocal(t)}
                            >
                              💾 Save Local Copy
                            </button>
                          )}
                          {(isThisDeviceAdmin || isOwnHosted || hasNoAssignedHost) && (
                            <button
                              type="button"
                              className={`btn-danger-outline btn-sm ${
                                confirmDeleteKey === deleteKey ? 'is-confirming' : ''
                              }`}
                              onClick={() => handleDeleteCloud(t.id)}
                              onBlur={() => {
                                if (confirmDeleteKey === deleteKey) setConfirmDeleteKey(null);
                              }}
                            >
                              {confirmDeleteKey === deleteKey ? 'Confirm Delete?' : '🗑 Delete'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 4. Compact Collapsible Local Tournaments Footer (Out of the way unless offline or expanded) */}
        {localOnlyTournaments.length > 0 && (
          <section className="simple-section simple-local-section" aria-label="Local Tournaments">
            <button
              type="button"
              className="simple-collapse-row"
              onClick={() => setShowLocalSection((v) => !v)}
              aria-expanded={localExpanded}
            >
              <span>
                {localExpanded ? '▾' : '▸'} 💻 Saved on This Device ({localOnlyTournaments.length})
              </span>
              <span className="simple-collapse-hint">Offline backups &amp; local brackets</span>
            </button>

            {localExpanded && (
              <div className="simple-card-list" style={{ marginTop: '0.65rem' }}>
                {localOnlyTournaments.map((t) => {
                  const themeDef = THEME_OPTIONS.find((x) => x.id === t.theme) || THEME_OPTIONS[0];
                  const deleteKey = `local:${t.id}`;
                  const joinKey = t.joinCode || t.id;
                  const isLocalMenuOpen = openCardMenuId === `local:${t.id}`;
                  const pct =
                    t.totalMatches > 0
                      ? Math.round((t.completedMatches / t.totalMatches) * 100)
                      : 0;
                  return (
                    <div key={`local-${t.id}`} className="simple-t-card is-local">
                      <div className="stc-main">
                        <div className="stc-info">
                          <span className="stc-icon" aria-hidden="true">
                            {themeDef.icon}
                          </span>
                          <div className="stc-text">
                            <div className="stc-title-row">
                              <h3 className="stc-name">{t.tournamentName}</h3>
                              <span className="stc-tag">Local</span>
                            </div>
                            <div className="stc-meta">
                              <span>{t.totalPlayers} players</span>
                              <span>·</span>
                              <span>
                                {t.championName
                                  ? `🏆 ${t.championName}`
                                  : `${t.completedMatches}/${t.totalMatches} matches`}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="stc-actions">
                          {isConnected && (
                            <button
                              type="button"
                              className="btn-amber btn-sm"
                              onClick={() => handlePublishLocal(t.id)}
                              title="Upload this local tournament to the live server so phones & TVs can join"
                            >
                              ☁ Publish
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn-primary btn-sm"
                            onClick={() => handleOpenLocal(t.id)}
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            className={`btn-secondary btn-sm stc-more-btn ${isLocalMenuOpen ? 'is-toggled-on' : ''}`}
                            onClick={() =>
                              setOpenCardMenuId(isLocalMenuOpen ? null : `local:${t.id}`)
                            }
                            aria-expanded={isLocalMenuOpen}
                            aria-label={`Show details and options for ${t.tournamentName}`}
                            title="Show full tournament details & options"
                          >
                            ⋯
                          </button>
                        </div>
                      </div>

                      {isLocalMenuOpen && (
                        <div className="stc-details-drawer">
                          <div className="stc-details-badges">
                            <span className="stc-pill">💻 LOCAL ONLY</span>
                          </div>

                          <div className="stc-details-meta-grid">
                            <div>
                              <span className="stc-dlabel">Format</span>
                              <div className="stc-dval">
                                {t.entryMode === 'teams' ? 'Teams (2v2)' : 'Singles (1v1)'} ·{' '}
                                {t.format === 'double' ? 'Double Elim' : 'Single Elim'} ·{' '}
                                {t.totalPlayers} Players
                                {t.entryMode === 'teams' ? ` (${t.playerCount} Teams)` : ''}
                              </div>
                            </div>
                            <div>
                              <span className="stc-dlabel">Updated</span>
                              <div className="stc-dval">{formatRelativeTime(t.updatedAt)}</div>
                            </div>
                          </div>

                          <div className="stc-details-key-row">
                            <button
                              type="button"
                              className="stc-key-chip"
                              onClick={() => handleCopyText(joinKey, '4-word key')}
                              title="Click to copy 4-word join key"
                            >
                              🔑 <code>{joinKey}</code>
                            </button>
                          </div>

                          <div className="stc-progress-block">
                            <div className="stc-progress-bar" aria-hidden="true">
                              <div className="stc-progress-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="stc-progress-lbl">
                              {t.championName
                                ? `🏆 Champion: ${t.championName}`
                                : `${t.completedMatches} / ${t.totalMatches} Matches Complete (${pct}%)`}
                            </span>
                          </div>

                          <div className="stc-more-bar">
                            {isConnected && (
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                onClick={() => handlePublishLocalToCloud(t.id)}
                              >
                                ☁️ Push to Cloud
                              </button>
                            )}
                            <button
                              type="button"
                              className={`btn-danger-outline btn-sm ${
                                confirmDeleteKey === deleteKey ? 'is-confirming' : ''
                              }`}
                              onClick={() => handleDeleteLocal(t.id)}
                              onBlur={() => {
                                if (confirmDeleteKey === deleteKey) setConfirmDeleteKey(null);
                              }}
                            >
                              {confirmDeleteKey === deleteKey ? 'Confirm Delete?' : '🗑 Delete'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>

      {/* Focused "+ New Tournament" Modal */}
      <dialog
        ref={createDialogRef}
        className="app-dialog simple-create-dialog"
        closedby="any"
        aria-labelledby="simple-create-title"
      >
        <div className="dialog-surface">
          <div className="dialog-header">
            <div>
              <h2 id="simple-create-title" className="dialog-title">
                🏓 Start New Tournament
              </h2>
              <p className="panel-subtitle" style={{ marginTop: '0.2rem' }}>
                Quick setup — you can customize players &amp; rules inside
              </p>
            </div>
            <button
              type="button"
              className="dialog-close-btn"
              onClick={() => createDialogRef.current?.close()}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="dialog-body">
            <form onSubmit={handleCreate} className="simple-create-form">
          <div className="form-field">
            <label htmlFor="simple-new-name">Tournament Name</label>
            <input
              id="simple-new-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Friday Night Ping Pong"
              autoFocus
            />
          </div>

          <div className="simple-form-row">
            <div className="form-field">
              <span className="field-label">Mode</span>
              <div className="segmented-control">
                <button
                  type="button"
                  className={newEntryMode === 'singles' ? 'is-selected' : ''}
                  onClick={() => setNewEntryMode('singles')}
                >
                  Singles
                </button>
                <button
                  type="button"
                  className={newEntryMode === 'teams' ? 'is-selected' : ''}
                  onClick={() => setNewEntryMode('teams')}
                >
                  Teams
                </button>
              </div>
            </div>

            <div className="form-field">
              <span className="field-label">Format</span>
              <div className="segmented-control">
                <button
                  type="button"
                  className={newFormat === 'single' ? 'is-selected' : ''}
                  onClick={() => setNewFormat('single')}
                >
                  Single Elim
                </button>
                <button
                  type="button"
                  className={newFormat === 'double' ? 'is-selected' : ''}
                  onClick={() => setNewFormat('double')}
                >
                  Double Elim
                </button>
              </div>
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="simple-new-player">
              Players ({newRoster.length} added
              {newEntryMode === 'teams' && newRoster.length >= 2
                ? ` · ${Math.max(2, Math.ceil(newRoster.length / 2))} teams`
                : ''}
              )
            </label>
            <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
              <input
                ref={newPlayerInputRef}
                id="simple-new-player"
                type="text"
                value={newPlayerDraft}
                onChange={(e) => setNewPlayerDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddCreatePlayer();
                  }
                }}
                placeholder={`Player ${newRoster.length + 1}`}
                disabled={newRoster.length >= MAX_PLAYERS}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={handleAddCreatePlayer}
                disabled={newRoster.length >= MAX_PLAYERS}
              >
                + Add
              </button>
            </div>
            {newRoster.length === 0 && (
              <p className="panel-subtitle" style={{ margin: '0.35rem 0 0' }}>
                Optional — you can add or edit players anytime after creating the tournament.
              </p>
            )}
            {newRoster.length > 0 && (
              <div
                className="scroller"
                style={{
                  maxHeight: '190px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.35rem',
                  marginTop: '0.5rem',
                }}
              >
                {newRoster.map((p, idx) => (
                  <div key={p.id} className="player-input-row">
                    <span className="seed-tag">#{idx + 1}</span>
                    <input
                      type="text"
                      value={p.name}
                      onChange={(e) => handleEditCreatePlayer(idx, e.target.value)}
                      placeholder={`Player ${idx + 1}`}
                      aria-label={`Player ${idx + 1} name`}
                    />
                    <button
                      type="button"
                      className="btn-danger-outline btn-sm"
                      onClick={() => handleRemoveCreatePlayer(idx)}
                      aria-label={`Remove ${p.name || `Player ${idx + 1}`}`}
                      title="Remove player"
                      style={{ padding: '0.25rem 0.45rem', flexShrink: 0 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {isConnected && canCreateCloud && (
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={hostNewOnCloud}
                onChange={(e) => setHostNewOnCloud(e.target.checked)}
              />
              <span>☁️ Share live on network so others can join</span>
            </label>
          )}
          {isConnected && !canCreateCloud && (
            <p className="panel-subtitle" style={{ margin: 0 }}>
              🛡️ Only Hub Admins can publish new live network tournaments — this tournament will be
              saved locally on your device.
            </p>
          )}

          {hostNewOnCloud && isConnected && canCreateCloud && (
            <div className="launcher-access-box">
              <div className="form-field">
                <span className="field-label">Visibility</span>
                <div className="segmented-control">
                  <button
                    type="button"
                    className={newIsPublic ? 'is-selected' : ''}
                    onClick={() => setNewIsPublic(true)}
                  >
                    🌐 Public
                  </button>
                  <button
                    type="button"
                    className={!newIsPublic ? 'is-selected' : ''}
                    onClick={() => {
                      setNewIsPublic(false);
                      setNewIsSecure(true);
                    }}
                  >
                    🕶️ Private
                  </button>
                </div>
              </div>

              <div className="form-field">
                <span className="field-label">Security</span>
                <div className="segmented-control">
                  <button
                    type="button"
                    className={newIsSecure || !newIsPublic ? 'is-selected' : ''}
                    onClick={() => setNewIsSecure(true)}
                  >
                    🔒 Require Key
                  </button>
                  <button
                    type="button"
                    disabled={!newIsPublic}
                    className={!newIsSecure && newIsPublic ? 'is-selected' : ''}
                    title={!newIsPublic ? 'Private tournaments always require the 4-word key' : undefined}
                    onClick={() => setNewIsSecure(false)}
                  >
                    🔓 Open
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="simple-create-footer">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => createDialogRef.current?.close()}
            >
              Cancel
            </button>
              <button type="submit" className="btn-amber">
                Create Tournament
              </button>
            </div>
          </form>
          </div>
        </div>
      </dialog>
    </div>
  );
}
