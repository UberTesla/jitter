import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_BANTER_QUOTES,
  DEFAULT_CONTEXTUAL_QUOTES,
  DEFAULT_GAME_POINT_QUOTES,
} from '../state/tournamentStore.js';
import {
  GRANDMA_VARIABLES,
  buildGrandmaVariableMap,
  hasGrandmaVariables,
  resolveGrandmaPhrase,
} from '../engine/grandmaVariables.js';
import GrandmaPhraseInput from './GrandmaPhraseInput.jsx';

const CATEGORY_TABS = [
  {
    id: 'banter',
    label: '💬 Banter',
    description: 'Idle living-room chatter that rotates periodically between rallies.',
  },
  {
    id: 'contextual',
    label: '⚡ Contextual (Points)',
    description: 'Randomly triggered when points are scored (not every point — controlled by probability).',
  },
  {
    id: 'gamePoint',
    label: '🔥 Game Point (Always)',
    description: 'Grandma ALWAYS says one of these whenever a match reaches Game Point.',
  },
];

/**
 * Native <dialog> Modal for Grandma's Categorized Phrase Manager & Speech Timing Controls.
 * Split into 3 categories:
 *  - Banter (periodic idle commentary)
 *  - Contextual (random chance on scored points)
 *  - Game Point (always triggers when a match reaches Game Point)
 */
export default function PhraseManagerModal({
  open,
  onClose,
  grandma,
  state,
  onSaveSettings,
  onPlayQuoteNow,
}) {
  const dialogRef = useRef(null);
  const newQuoteInputRef = useRef(null);
  const lastFocusedTargetRef = useRef({ type: 'new', index: -1 });
  const wasOpenRef = useRef(false);
  const [activeTab, setActiveTab] = useState('banter');
  const [showVariables, setShowVariables] = useState(true);
  const [varGroupFilter, setVarGroupFilter] = useState('All');
  const [banterQuotes, setBanterQuotes] = useState(grandma.banterQuotes || DEFAULT_BANTER_QUOTES);
  const [contextualQuotes, setContextualQuotes] = useState(
    grandma.contextualQuotes || DEFAULT_CONTEXTUAL_QUOTES
  );
  const [gamePointQuotes, setGamePointQuotes] = useState(
    grandma.gamePointQuotes || DEFAULT_GAME_POINT_QUOTES
  );
  const [contextualChancePct, setContextualChancePct] = useState(
    grandma.contextualChancePct ?? 25
  );
  const [newQuote, setNewQuote] = useState('');
  const [stayDurationSec, setStayDurationSec] = useState(grandma.stayDurationSec ?? 5.5);
  const [minIntervalSec, setMinIntervalSec] = useState(grandma.minIntervalSec ?? 6);
  const [maxIntervalSec, setMaxIntervalSec] = useState(grandma.maxIntervalSec ?? 13);

  // Only snapshot phrases into drafts when modal transitions closed -> open
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setBanterQuotes([...(grandma.banterQuotes || grandma.quotes || DEFAULT_BANTER_QUOTES)]);
      setContextualQuotes([...(grandma.contextualQuotes || DEFAULT_CONTEXTUAL_QUOTES)]);
      setGamePointQuotes([...(grandma.gamePointQuotes || DEFAULT_GAME_POINT_QUOTES)]);
      setContextualChancePct(grandma.contextualChancePct ?? 25);
      setStayDurationSec(grandma.stayDurationSec ?? 5.5);
      setMinIntervalSec(grandma.minIntervalSec ?? 6);
      setMaxIntervalSec(grandma.maxIntervalSec ?? 13);
      setNewQuote('');
    }
    wasOpenRef.current = open;
  }, [open, grandma]);

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
  }, [onClose]);

  const currentList =
    activeTab === 'banter'
      ? banterQuotes
      : activeTab === 'contextual'
      ? contextualQuotes
      : gamePointQuotes;

  const setCurrentList = (updater) => {
    if (activeTab === 'banter') setBanterQuotes(updater);
    else if (activeTab === 'contextual') setContextualQuotes(updater);
    else setGamePointQuotes(updater);
  };

  const handleAddPhrase = () => {
    const trimmed = newQuote.trim();
    if (!trimmed) return;
    setCurrentList((prev) => [trimmed, ...prev]);
    setNewQuote('');
  };

  const handleEditPhrase = (index, value) => {
    setCurrentList((prev) => prev.map((q, i) => (i === index ? value : q)));
  };

  const handleDeletePhrase = (index) => {
    setCurrentList((prev) => prev.filter((_, i) => i !== index));
  };

  const liveVarMap = useMemo(() => buildGrandmaVariableMap(state), [state]);
  const visibleVariables = useMemo(() => {
    if (varGroupFilter === 'All') return GRANDMA_VARIABLES;
    return GRANDMA_VARIABLES.filter((v) => v.group === varGroupFilter);
  }, [varGroupFilter]);

  const handleInsertVariable = (token) => {
    const target = lastFocusedTargetRef.current;
    if (target?.type === 'row' && target.index >= 0 && target.index < currentList.length) {
      const idx = target.index;
      setCurrentList((prev) =>
        prev.map((q, i) => {
          if (i !== idx) return q;
          const sep = q && !q.endsWith(' ') ? ' ' : '';
          return `${q}${sep}${token}`;
        })
      );
      return;
    }

    const input = newQuoteInputRef.current;
    if (input && typeof input.selectionStart === 'number') {
      const start = input.selectionStart;
      const end = input.selectionEnd ?? start;
      setNewQuote((prev) => {
        const before = prev.slice(0, start);
        const after = prev.slice(end);
        const needLeadSpace = before.length > 0 && !before.endsWith(' ');
        const needTrailSpace = after.length > 0 && !after.startsWith(' ');
        const inserted = `${needLeadSpace ? ' ' : ''}${token}${needTrailSpace ? ' ' : ''}`;
        const nextVal = `${before}${inserted}${after}`;
        requestAnimationFrame(() => {
          input.focus();
          const pos = before.length + inserted.length;
          input.setSelectionRange(pos, pos);
        });
        return nextVal;
      });
    } else {
      setNewQuote((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${token}`);
      newQuoteInputRef.current?.focus();
    }
  };

  const handleSave = (e) => {
    e.preventDefault();
    onSaveSettings({
      banterQuotes,
      contextualQuotes,
      gamePointQuotes,
      contextualChancePct: Number(contextualChancePct),
      stayDurationSec: Number(stayDurationSec),
      minIntervalSec: Number(minIntervalSec),
      maxIntervalSec: Number(maxIntervalSec),
    });
    dialogRef.current?.close();
  };

  const activeTabInfo = CATEGORY_TABS.find((t) => t.id === activeTab);

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog phrase-dialog is-wide"
      closedby="any"
      aria-labelledby="phrase-manager-heading"
    >
      <div className="dialog-surface">
        <header className="dialog-header">
          <h1 id="phrase-manager-heading" className="dialog-title">
            👵 Grandma Phrase Manager &amp; Commentary Rules
          </h1>
          <button
            type="button"
            className="dialog-close-btn"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close phrase manager dialog"
          >
            ✕
          </button>
        </header>

        <form onSubmit={handleSave} className="dialog-body scroller">
          {/* Shared Speech Bubble Timings */}
          <div className="timing-grid">
            <label className="form-field">
              <span>Stay On Screen (sec)</span>
              <input
                type="number"
                min="2"
                max="20"
                step="0.5"
                value={stayDurationSec}
                onChange={(e) => setStayDurationSec(e.target.value)}
              />
            </label>
            <label className="form-field">
              <span>Banter Min Interval (sec)</span>
              <input
                type="number"
                min="1"
                max="60"
                step="1"
                value={minIntervalSec}
                onChange={(e) => setMinIntervalSec(e.target.value)}
              />
            </label>
            <label className="form-field">
              <span>Banter Max Interval (sec)</span>
              <input
                type="number"
                min="1"
                max="120"
                step="1"
                value={maxIntervalSec}
                onChange={(e) => setMaxIntervalSec(e.target.value)}
              />
            </label>
          </div>

          {/* 3-Category Tabs: Banter | Contextual | Game Point */}
          <div className="phrase-category-tabs" role="tablist" aria-label="Phrase Categories">
            {CATEGORY_TABS.map((tab) => {
              const count =
                tab.id === 'banter'
                  ? banterQuotes.length
                  : tab.id === 'contextual'
                  ? contextualQuotes.length
                  : gamePointQuotes.length;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={`phrase-tab-btn ${activeTab === tab.id ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span>{tab.label}</span>
                  <span className="tab-count">{count}</span>
                </button>
              );
            })}
          </div>

          <div className="phrase-tab-banner">
            <p>{activeTabInfo?.description}</p>
            {activeTab === 'contextual' && (
              <label className="contextual-chance-control">
                <span>Trigger Chance on Scored Point:</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={contextualChancePct}
                  onChange={(e) => setContextualChancePct(Number(e.target.value))}
                />
                <strong>{contextualChancePct}%</strong>
              </label>
            )}
            {activeTab === 'gamePoint' && (
              <span className="always-trigger-pill">✓ ALWAYS FIRES ON GAME POINT</span>
            )}
          </div>

          <div className="add-phrase-bar">
            <GrandmaPhraseInput
              inputRef={newQuoteInputRef}
              state={state}
              value={newQuote}
              onFocus={() => {
                lastFocusedTargetRef.current = { type: 'new', index: -1 };
              }}
              onChange={(val) => setNewQuote(val)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddPhrase();
                }
              }}
              autoFocus
              placeholder={`Add a new ${activeTabInfo?.label} quote (type $ for autocomplete)...`}
              aria-label="New Grandma quote"
              aria-describedby="grandma-vars-hint"
            />
            <button type="button" className="btn-primary btn-sm" onClick={handleAddPhrase}>
              + Add Quote
            </button>
          </div>

          {hasGrandmaVariables(newQuote) && (
            <div className="grandma-live-preview" role="status" aria-live="polite">
              <span className="glp-label">Live Preview:</span>
              <span className="glp-text">“{resolveGrandmaPhrase(newQuote, state)}”</span>
            </div>
          )}

          {/* Accessible Contextual Variables Picker */}
          <section className="grandma-vars-box" aria-label="Contextual phrase variables">
            <div className="grandma-vars-head">
              <div>
                <button
                  type="button"
                  className="grandma-vars-toggle"
                  aria-expanded={showVariables}
                  aria-controls="grandma-vars-panel"
                  onClick={() => setShowVariables((v) => !v)}
                >
                  <span aria-hidden="true">{showVariables ? '▾' : '▸'}</span>
                  <span>✨ Contextual Variables ({GRANDMA_VARIABLES.length})</span>
                </button>
                <p id="grandma-vars-hint" className="grandma-vars-hint">
                  Click any variable to insert into your focused quote — resolves live with current
                  match, score, and table context.
                </p>
              </div>
              {showVariables && (
                <div className="segmented-control compact" role="group" aria-label="Filter variable group">
                  {['All', 'Match', 'Score', 'Tournament'].map((grp) => (
                    <button
                      key={grp}
                      type="button"
                      className={varGroupFilter === grp ? 'is-selected' : ''}
                      onClick={() => setVarGroupFilter(grp)}
                    >
                      {grp}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {showVariables && (
              <div
                id="grandma-vars-panel"
                className="grandma-vars-chips scroller"
                role="group"
                aria-label="Insert Grandma phrase variable"
              >
                {visibleVariables.map((v) => {
                  const liveVal = liveVarMap[v.key.toLowerCase()] ?? '';
                  return (
                    <button
                      key={v.key}
                      type="button"
                      className="grandma-var-chip"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleInsertVariable(v.token)}
                      title={`${v.description} — Currently: ${liveVal}`}
                      aria-label={`Insert ${v.token}: ${v.description}. Current value: ${liveVal}`}
                    >
                      <code>{v.token}</code>
                      <span className="gvc-val">{liveVal}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <div className="phrase-list scroller">
            {currentList.map((phrase, idx) => {
              const usesVars = hasGrandmaVariables(phrase);
              return (
                <div key={`${activeTab}-${idx}`} className="phrase-item-wrap">
                  <div className="phrase-item-row">
                    <button
                      type="button"
                      className="btn-icon-play"
                      title={
                        usesVars
                          ? `Play now: "${resolveGrandmaPhrase(phrase, state)}"`
                          : 'Play quote immediately'
                      }
                      aria-label={`Play quote now: ${resolveGrandmaPhrase(phrase, state)}`}
                      onClick={() => onPlayQuoteNow(phrase)}
                    >
                      ▶
                    </button>
                    <GrandmaPhraseInput
                      state={state}
                      value={phrase}
                      onFocus={() => {
                        lastFocusedTargetRef.current = { type: 'row', index: idx };
                      }}
                      onChange={(val) => handleEditPhrase(idx, val)}
                      aria-label={`Edit quote ${idx + 1}`}
                    />
                    <button
                      type="button"
                      className="btn-icon-delete"
                      title="Delete phrase"
                      aria-label={`Delete quote ${idx + 1}`}
                      onClick={() => handleDeletePhrase(idx)}
                      disabled={currentList.length <= 1}
                    >
                      ✕
                    </button>
                  </div>
                  {usesVars && (
                    <div className="phrase-row-preview">
                      → “{resolveGrandmaPhrase(phrase, state)}”
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <footer className="dialog-footer">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              Save All Phrase Categories
            </button>
          </footer>
        </form>
      </div>
    </dialog>
  );
}
