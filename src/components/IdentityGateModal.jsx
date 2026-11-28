import React, { useMemo, useState } from 'react';
import { getClaimablePlayers, resolveClaimedPlayer } from '../engine/bracketGenerator.js';
import { tournamentStore } from '../state/tournamentStore.js';

/**
 * Returns true if this device has already identified itself either by claiming a
 * tournament player or by setting a custom display name.
 */
export function hasUserIdentity(state, remoteSync = null) {
  const rs = remoteSync || tournamentStore.getSyncMeta()?.remoteSync || {};
  const devId = String(rs.deviceId || '').trim();
  const hasClaim = Boolean(devId && state?.playerClaims?.[devId]);
  const hasCustomName = Boolean(rs.isDeviceNameCustom && String(rs.deviceName || '').trim());
  return hasClaim || hasCustomName;
}

/**
 * Compact modal prompting an unidentified user to either claim a player from the
 * tournament roster or enter their name before sending a Host request (e.g. Scorekeeper or Join).
 */
export default function IdentityGateModal({
  open,
  state = null,
  actionLabel = 'Send Request',
  allowClaim = true,
  onIdentified,
  onCancel,
}) {
  const [nameInput, setNameInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const claimablePlayers = useMemo(() => {
    if (!allowClaim || !state) return [];
    const claims = state.playerClaims || {};
    const claimedSet = new Set(Object.values(claims).filter(Boolean));
    return getClaimablePlayers(state).filter((p) => !claimedSet.has(p.id));
  }, [allowClaim, state]);

  if (!open) return null;

  const handleClaimAndContinue = async (player) => {
    if (busy) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const res = await tournamentStore.claimPlayer(player.id);
      if (!res?.ok) {
        setErrorMsg(res?.error || 'Could not claim that player');
        setBusy(false);
        return;
      }
      const resolved = resolveClaimedPlayer(state, player.id);
      const displayName = resolved?.name || player.name || '';
      if (displayName && !tournamentStore.getSyncMeta()?.remoteSync?.isDeviceNameCustom) {
        tournamentStore.setDeviceName(displayName);
      }
      setBusy(false);
      onIdentified?.({ method: 'claim', name: displayName, playerId: player.id });
    } catch {
      setErrorMsg('Could not claim player right now');
      setBusy(false);
    }
  };

  const handleNameSubmit = (e) => {
    e.preventDefault();
    if (busy) return;
    const cleaned = nameInput.trim();
    if (!cleaned) {
      setErrorMsg('Please enter your name first');
      return;
    }
    setErrorMsg('');
    tournamentStore.setDeviceName(cleaned);
    onIdentified?.({ method: 'name', name: cleaned });
  };

  return (
    <div
      className="notify-preprompt-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="identity-gate-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel?.();
      }}
    >
      <div className="notify-preprompt-card" style={{ width: 'min(420px, 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
          <h2 id="identity-gate-title" className="notify-preprompt-title" style={{ fontSize: '1.12rem' }}>
            👤 Identify Yourself First
          </h2>
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={busy}
            onClick={() => onCancel?.()}
            aria-label="Cancel"
          >
            ✕
          </button>
        </div>

        <p className="notify-preprompt-lead" style={{ fontSize: '0.84rem' }}>
          So the Host knows who&apos;s asking,{' '}
          {claimablePlayers.length > 0 ? 'claim your player below or ' : ''}enter your name before sending your request.
        </p>

        {errorMsg && (
          <div
            role="alert"
            style={{
              padding: '0.45rem 0.65rem',
              borderRadius: '8px',
              background: 'rgba(239, 68, 68, 0.16)',
              border: '1px solid rgba(248, 113, 113, 0.55)',
              color: '#fecaca',
              fontSize: '0.8rem',
            }}
          >
            {errorMsg}
          </div>
        )}

        {claimablePlayers.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.05em', color: '#93c5fd', textTransform: 'uppercase' }}>
              🏓 Claim Your Player
            </div>
            <div
              className="scroller"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.35rem',
                maxHeight: '145px',
                overflowY: 'auto',
                padding: '0.45rem',
                borderRadius: '10px',
                background: 'rgba(15, 23, 42, 0.72)',
                border: '1px solid rgba(148, 163, 184, 0.22)',
              }}
            >
              {claimablePlayers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => handleClaimAndContinue(p)}
                  style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}
                >
                  {p.displayName || p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={handleNameSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <label
            htmlFor="identity-gate-name-input"
            style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.05em', color: '#93c5fd', textTransform: 'uppercase' }}
          >
            {claimablePlayers.length > 0 ? 'Or Enter Your Name (Not Playing)' : 'Your Name'}
          </label>
          <div style={{ display: 'flex', gap: '0.45rem' }}>
            <input
              id="identity-gate-name-input"
              type="text"
              className="panel-input"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="e.g. Dave, Sarah..."
              maxLength={32}
              autoFocus={claimablePlayers.length === 0}
              style={{ flex: 1, fontSize: '0.88rem', padding: '0.48rem 0.68rem' }}
            />
            <button type="submit" className="btn-amber btn-sm" disabled={busy || !nameInput.trim()}>
              {actionLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
