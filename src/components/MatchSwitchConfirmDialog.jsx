import React, { useEffect, useRef } from 'react';

/**
 * Confirmation modal shown when switching away from an in-progress match
 * (score above 0-0 and not yet completed).
 */
export default function MatchSwitchConfirmDialog({ request, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const isOpen = Boolean(request);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
    return undefined;
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const handleClose = () => {
      dialog.returnValue = '';
      onCancelRef.current?.();
    };
    dialog.addEventListener('close', handleClose);

    let removeFallback = () => {};
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const isOutside = (e) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      let pressedOutside = false;
      const onPointerDown = (e) => {
        pressedOutside = isOutside(e);
      };
      const onPointerUp = (e) => {
        if (pressedOutside && isOutside(e)) {
          dialog.close();
        }
        pressedOutside = false;
      };
      dialog.addEventListener('pointerdown', onPointerDown);
      dialog.addEventListener('pointerup', onPointerUp);
      removeFallback = () => {
        dialog.removeEventListener('pointerdown', onPointerDown);
        dialog.removeEventListener('pointerup', onPointerUp);
      };
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      removeFallback();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog match-switch-dialog"
      closedby="any"
      aria-labelledby="match-switch-title"
    >
      {request && (
        <div className="dialog-surface">
          <header className="dialog-header">
            <h2 id="match-switch-title" className="dialog-title">
              ⚠️ Game Already in Session
            </h2>
            <button
              type="button"
              className="dialog-close-btn"
              onClick={() => dialogRef.current?.close()}
              aria-label="Cancel match switch"
            >
              ✕
            </button>
          </header>

          <div className="dialog-body">
            <p className="ms-intro">
              A game is currently in progress. Are you sure you want to switch to another match?
              The current score will be preserved so you can return to it later.
            </p>

            <div className="ms-compare-stack">
              <div className="ms-match-box is-current">
                <div className="ms-box-kicker">
                  <span>CURRENTLY IN SESSION · {request.current.label}</span>
                  <strong className="ms-score-pill">
                    {String(request.current.score1).padStart(2, '0')} –{' '}
                    {String(request.current.score2).padStart(2, '0')}
                  </strong>
                </div>
                <div className="ms-matchup-row">
                  <div className="ms-side">
                    <strong>{request.current.side1Name}</strong>
                    {request.current.side1Members && (
                      <span className="ms-members">{request.current.side1Members}</span>
                    )}
                  </div>
                  <span className="ms-vs">vs</span>
                  <div className="ms-side">
                    <strong>{request.current.side2Name}</strong>
                    {request.current.side2Members && (
                      <span className="ms-members">{request.current.side2Members}</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="ms-match-box is-target">
                <div className="ms-box-kicker">
                  <span>SWITCH TO · {request.target.label}</span>
                  {request.target.completed && (
                    <strong className="ms-score-pill is-final">
                      FINAL {request.target.score1}–{request.target.score2}
                    </strong>
                  )}
                </div>
                <div className="ms-matchup-row">
                  <div className="ms-side">
                    <strong>{request.target.side1Name}</strong>
                    {request.target.side1Members && (
                      <span className="ms-members">{request.target.side1Members}</span>
                    )}
                  </div>
                  <span className="ms-vs">vs</span>
                  <div className="ms-side">
                    <strong>{request.target.side2Name}</strong>
                    {request.target.side2Members && (
                      <span className="ms-members">{request.target.side2Members}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <footer className="dialog-footer">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => dialogRef.current?.close()}
            >
              Keep Current Game
            </button>
            <button
              type="button"
              className="btn-amber"
              onClick={() => onConfirm?.(request.targetMatchId)}
              autoFocus
            >
              ⇄ Switch Game
            </button>
          </footer>
        </div>
      )}
    </dialog>
  );
}
