import React, { useEffect, useRef, useState } from 'react';
import { evaluateMatchState } from '../engine/scoringEngine.js';
import { formatTeamMembers, hasDownstreamMatchProgress } from '../engine/bracketGenerator.js';

/**
 * Control View modal for editing a completed match's final score or reopening it
 * for live play (with clear warnings when downstream bracket matches will be reset).
 */
export default function EditCompletedMatchDialog({
  open,
  match,
  matches,
  players,
  rules,
  entryMode = 'singles',
  onClose,
  onSaveScore,
  onReopenMatch,
}) {
  const dialogRef = useRef(null);
  const wasOpenRef = useRef(false);
  const [score1, setScore1] = useState(0);
  const [score2, setScore2] = useState(0);

  useEffect(() => {
    if (open && !wasOpenRef.current && match) {
      setScore1(match.score1 || 0);
      setScore2(match.score2 || 0);
    }
    wasOpenRef.current = open;
  }, [open, match]);

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
      let pressedOutside = false;
      const onPointerDown = (e) => {
        pressedOutside = isOutside(e);
      };
      const onPointerUp = (e) => {
        if (pressedOutside && isOutside(e)) dialog.close();
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
  }, [onClose]);

  const isTeams = entryMode === 'teams';
  const p1 = match?.player1Id ? (players || []).find((p) => p.id === match.player1Id) : null;
  const p2 = match?.player2Id ? (players || []).find((p) => p.id === match.player2Id) : null;
  const p1Members = isTeams && p1 ? formatTeamMembers(p1, ' & ') : '';
  const p2Members = isTeams && p2 ? formatTeamMembers(p2, ' & ') : '';

  const s1 = Math.max(0, Math.floor(Number(score1) || 0));
  const s2 = Math.max(0, Math.floor(Number(score2) || 0));
  const evalCandidate = match
    ? evaluateMatchState({ ...match, score1: s1, score2: s2, completed: false }, rules)
    : { canComplete: false, winnerSlot: null };
  const candidateWinnerId =
    evalCandidate.winnerSlot === 1
      ? match?.player1Id
      : evalCandidate.winnerSlot === 2
      ? match?.player2Id
      : null;
  const winnerWillChange = Boolean(
    match && evalCandidate.canComplete && candidateWinnerId && candidateWinnerId !== match.winnerId
  );
  const downstreamAffected = match ? hasDownstreamMatchProgress(matches, match.id) : false;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!match || !evalCandidate.canComplete) return;
    onSaveScore?.(match.id, s1, s2);
    dialogRef.current?.close();
  };

  const handleReopen = () => {
    if (!match) return;
    onReopenMatch?.(match.id);
    dialogRef.current?.close();
  };

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog edit-completed-dialog"
      closedby="any"
      aria-labelledby="edit-completed-title"
    >
      {match && (
        <div className="dialog-surface">
          <header className="dialog-header">
            <h2 id="edit-completed-title" className="dialog-title">
              ✏️ Edit or Reopen {match.label}
            </h2>
            <button
              type="button"
              className="dialog-close-btn"
              onClick={() => dialogRef.current?.close()}
              aria-label="Close edit completed match modal"
            >
              ✕
            </button>
          </header>

          <form onSubmit={handleSubmit} className="dialog-body">
            <div className="ec-score-grid">
              <div className="ec-side-card">
                <span className="ec-side-label">{p1 ? `#${p1.seed} ${p1.name}` : 'Side 1'}</span>
                {p1Members && <span className="ec-side-members">{p1Members}</span>}
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={score1}
                  onChange={(e) => setScore1(e.target.value)}
                  className="ec-score-input"
                  aria-label={`${p1?.name || 'Side 1'} final score`}
                />
              </div>

              <span className="ec-vs">–</span>

              <div className="ec-side-card">
                <span className="ec-side-label">{p2 ? `#${p2.seed} ${p2.name}` : 'Side 2'}</span>
                {p2Members && <span className="ec-side-members">{p2Members}</span>}
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={score2}
                  onChange={(e) => setScore2(e.target.value)}
                  className="ec-score-input"
                  aria-label={`${p2?.name || 'Side 2'} final score`}
                />
              </div>
            </div>

            {!evalCandidate.canComplete ? (
              <p className="ec-validation-err">
                Final score must reach at least {rules.targetPoints} points and win by{' '}
                {rules.winBy ?? 2}.
              </p>
            ) : winnerWillChange ? (
              <p className="ec-warning-box">
                ⚠️ Changing the winner will automatically clear and re-seed downstream bracket
                matches{downstreamAffected ? ' (including already-started later rounds)' : ''}.
              </p>
            ) : (
              <p className="setup-info">
                Winner unchanged — saving will update the recorded score without affecting later
                rounds.
              </p>
            )}

            <div className="ec-reopen-strip">
              <div>
                <strong>Need to resume live play instead?</strong>
                <p>
                  Reopening returns this match to active play on the scoreboard
                  {downstreamAffected
                    ? ' and clears downstream rounds that depended on this result.'
                    : ' and clears its downstream bracket slot until completed again.'}
                </p>
              </div>
              <button
                type="button"
                className="btn-danger-outline btn-sm"
                onClick={handleReopen}
              >
                🔓 Reopen Match
              </button>
            </div>

            <footer className="dialog-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => dialogRef.current?.close()}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={!evalCandidate.canComplete}
              >
                Save Final Score
              </button>
            </footer>
          </form>
        </div>
      )}
    </dialog>
  );
}
