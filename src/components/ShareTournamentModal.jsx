import React, { useEffect, useMemo, useRef, useState } from 'react';
import { generateQrMatrix, qrMatrixToSvgPath } from '../engine/qrCode.js';
import { rankLanAddresses, resolveShareOrigin } from '../engine/lanAddress.js';

export { rankLanAddresses, resolveShareOrigin };

/**
 * Tournament Share & Auto-Join QR Code Modal.
 * Opened by clicking the Tournament ID pill in the top title bar (available to all roles).
 */
export default function ShareTournamentModal({
  open,
  onClose,
  tournamentName,
  joinCode,
  access,
  remoteSync,
}) {
  const dialogRef = useRef(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const [fetchedServerInfo, setFetchedServerInfo] = useState(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
    return undefined;
  }, [open]);

  // Fetch live /__server-info when opened if remoteSync.serverInfo isn't populated yet
  useEffect(() => {
    if (!open || remoteSync?.serverInfo?.lanAddresses?.length > 0) return undefined;
    let active = true;
    fetch('/__server-info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && data && typeof data === 'object') setFetchedServerInfo(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open, remoteSync?.serverInfo]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const handleClose = () => {
      dialog.returnValue = '';
      onClose?.();
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
  }, [onClose]);

  const effectiveServerInfo = remoteSync?.serverInfo || fetchedServerInfo;

  const baseOrigin = useMemo(
    () => resolveShareOrigin(effectiveServerInfo, remoteSync?.customServerUrl),
    [effectiveServerInfo, remoteSync?.customServerUrl]
  );

  const autoJoinUrl = useMemo(() => {
    if (!baseOrigin || !joinCode) return baseOrigin || '';
    return `${baseOrigin}/?join=${encodeURIComponent(joinCode)}`;
  }, [baseOrigin, joinCode]);

  const qrData = useMemo(() => {
    if (!open || !autoJoinUrl) return null;
    try {
      const { size, modules } = generateQrMatrix(autoJoinUrl);
      return { size, path: qrMatrixToSvgPath(modules) };
    } catch {
      return null;
    }
  }, [open, autoJoinUrl]);

  const flashCopy = (msg) => {
    setCopyFeedback(msg);
    setTimeout(() => {
      setCopyFeedback((curr) => (curr === msg ? '' : curr));
    }, 2800);
  };

  const handleCopy = async (text, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flashCopy(`✓ Copied ${label}`);
    } catch {
      flashCopy('Copy failed — select manually');
    }
  };

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const handleNativeShare = async () => {
    if (!canNativeShare || !autoJoinUrl) return;
    try {
      await navigator.share({
        title: tournamentName || 'Ping Pong Tournament',
        text: `Join "${tournamentName || 'Ping Pong Tournament'}" — Key: ${joinCode}`,
        url: autoJoinUrl,
      });
    } catch {
      // User cancelled share sheet
    }
  };

  const isPublic = access?.isPublic !== false;
  const isSecure = access?.isSecure !== false;

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog share-qr-dialog"
      closedby="any"
      aria-labelledby="share-qr-title"
    >
      <div className="dialog-surface">
        <div className="dialog-header">
          <div>
            <h2 id="share-qr-title" className="dialog-title">
              📱 Share &amp; Auto-Join Tournament
            </h2>
            <p className="panel-subtitle" style={{ marginTop: '0.2rem' }}>
              {tournamentName || 'Ping Pong Tournament'} ·{' '}
              {isPublic ? '🌐 Public' : '🕶️ Private'} · {isSecure ? '🔒 Key Protected' : '🔓 Open'}
            </p>
          </div>
          <button
            type="button"
            className="dialog-close-btn"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <div className="share-qr-body">
            <div className="share-qr-card">
              {qrData ? (
                <svg
                  className="share-qr-svg"
                  viewBox={`-3 -3 ${qrData.size + 6} ${qrData.size + 6}`}
                  role="img"
                  aria-label={`QR code to auto-join ${tournamentName || 'tournament'}`}
                  shapeRendering="crispEdges"
                >
                  <rect
                    x="-3"
                    y="-3"
                    width={qrData.size + 6}
                    height={qrData.size + 6}
                    fill="#ffffff"
                  />
                  <path d={qrData.path} fill="#0b1120" />
                </svg>
              ) : (
                <div className="share-qr-fallback">QR unavailable</div>
              )}
              <span className="share-qr-caption">
                Scan with any phone or tablet camera to auto-join
              </span>
            </div>

            <div className="share-qr-details">
              <div className="share-qr-field">
                <span className="field-label">4-Word Key</span>
                <div className="share-qr-code-row">
                  <code className="share-qr-code">{joinCode || '—'}</code>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => handleCopy(joinCode, '4-word Key')}
                  >
                    🔑 Copy Key
                  </button>
                </div>
              </div>

              <div className="share-qr-field">
                <span className="field-label">Auto-Join Link</span>
                <div className="share-qr-code-row">
                  <code className="share-qr-url">{autoJoinUrl}</code>
                  <button
                    type="button"
                    className="btn-amber btn-sm"
                    onClick={() => handleCopy(autoJoinUrl, 'Auto-Join Link')}
                  >
                    📋 Copy Link
                  </button>
                </div>
              </div>

              <div className="share-qr-actions">
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => handleCopy(baseOrigin, 'Hub URL')}
                >
                  🌐 Copy Hub URL
                </button>
                {canNativeShare && (
                  <button type="button" className="btn-primary btn-sm" onClick={handleNativeShare}>
                    📤 Share...
                  </button>
                )}
              </div>

              {copyFeedback && (
                <div className="share-qr-feedback" role="status" aria-live="polite">
                  {copyFeedback}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
