import React from 'react';
import {
  SLIDE_DEFINITIONS,
  TICKER_ITEM_DEFS,
  normalizeTickerItems,
  resolveTickerMode,
  THEME_OPTIONS,
  resolveEffectiveAmbiance,
} from '../state/tournamentStore.js';
import { evaluateMatchState } from '../engine/scoringEngine.js';
import { computeTournamentStats } from '../engine/bracketGenerator.js';

/**
 * Presentation Broadcast Control Panel
 * Includes:
 *  - Collapsible header
 *  - 5-Slide switcher + auto-rotation controls
 *  - Contextual Slide Banner / Options panel tailored to the currently selected slide
 *  - OBS-style Studio Mode (Staged Preview vs On-Air Program + Push Live / Discard)
 */
export default function SlidePreview({
  state,
  syncMeta,
  collapsed = false,
  onToggleCollapse,
  onSelectSlide,
  onToggleAutoRotate,
  onChangeAutoRotateSec,
  onChangeAutoRotateSlides,
  onUpdatePresentationConfig,
  onToggleMiniBracket,
  onChangeTicker,
  onPublishLive,
  onDiscardStaged,
  onOpenPresentationWindow,
  onSwitchToPresentationMode,
}) {
  const activeSlide = state.presentation?.activeSlide || 'title';
  const autoRotateOn = Boolean(state.presentation?.autoRotate);
  const [optionsSlide, setOptionsSlide] = React.useState(activeSlide);
  // Keep options panel locked during auto-rotate so automatic slide cycling never shifts Control UI
  React.useEffect(() => {
    if (!autoRotateOn) {
      setOptionsSlide(activeSlide);
    }
  }, [activeSlide, autoRotateOn]);
  const isStudio = syncMeta?.syncMode === 'studio';
  const hasUnpublished = Boolean(syncMeta?.hasUnpublishedChanges);
  const programSlide = syncMeta?.programState?.presentation?.activeSlide || activeSlide;

  const match = state.matches?.[state.activeMatchId];
  const playerMap = React.useMemo(() => {
    const map = new Map();
    for (const p of state.players || []) map.set(p.id, p);
    return map;
  }, [state.players]);

  const p1 = match?.player1Id ? playerMap.get(match.player1Id) : null;
  const p2 = match?.player2Id ? playerMap.get(match.player2Id) : null;
  const evalState = evaluateMatchState(match, state.rules);
  const stats = computeTournamentStats(state);
  const champion = state.championId ? playerMap.get(state.championId) : null;

  const activeSlideDef = SLIDE_DEFINITIONS.find((s) => s.id === activeSlide);
  const optionsSlideDef = SLIDE_DEFINITIONS.find((s) => s.id === optionsSlide) || activeSlideDef;
  const programSlideDef = SLIDE_DEFINITIONS.find((s) => s.id === programSlide);

  return (
    <section
      className={`panel-card broadcast-switcher-panel ${collapsed ? 'is-collapsed' : ''} ${
        isStudio ? 'is-studio-mode' : ''
      }`}
      aria-label="Presentation Control"
    >
      <div className="panel-header-row">
        <button
          type="button"
          className="panel-collapse-trigger"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
        >
          <span className="collapse-chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          <div>
            <h2 className="panel-title">📺 Presentation Control</h2>
            <p className="panel-subtitle">
              {isStudio
                ? `Preview: ${activeSlideDef?.label} · Live Screen: ${programSlideDef?.label}`
                : `Showing: ${activeSlideDef?.label}`}
            </p>
          </div>
        </button>

        {onOpenPresentationWindow && (
          <div className="broadcast-launch-actions">
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={onOpenPresentationWindow}
            >
              ↗ Pop Out
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="panel-body-content">
          {/* OBS Studio Mode Transition Bar */}
          {isStudio && (
            <div className="studio-transition-bar">
              <div className="studio-status-copy">
                <span className="studio-pill">🎬 STUDIO MODE</span>
                <span>
                  {hasUnpublished
                    ? `Staged changes ready (Live Screen is showing ${programSlideDef?.label})`
                    : `Preview matches Live Screen (${programSlideDef?.label})`}
                </span>
              </div>
              <div className="studio-bar-actions">
                {hasUnpublished && (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={onDiscardStaged}
                  >
                    ↺ Discard
                  </button>
                )}
                <button
                  type="button"
                  className={`btn-push-live btn-sm ${hasUnpublished ? 'has-changes' : ''}`}
                  onClick={onPublishLive}
                >
                  ▶ Push Live (Transition)
                </button>
              </div>
            </div>
          )}

          {/* Quick Slide Switcher Buttons (5 Slides including Pre-Tournament Title) */}
          <div
            className="slide-buttons-grid is-five"
            role="group"
            aria-label="Presentation Slide Switcher"
          >
            {SLIDE_DEFINITIONS.map((sl) => {
              const isSelected = activeSlide === sl.id;
              const isOnAir = isStudio && programSlide === sl.id;
              return (
                <button
                  key={sl.id}
                  type="button"
                  className={`slide-switch-btn ${isSelected ? 'is-active' : ''} ${
                    isOnAir ? 'is-on-air' : ''
                  }`}
                  onClick={() => {
                    setOptionsSlide(sl.id);
                    onSelectSlide(sl.id);
                  }}
                >
                  <div className="slide-btn-top">
                    <span className="slide-num">SLIDE {sl.number}</span>
                    {isOnAir && <span className="on-air-mini-tag">LIVE</span>}
                  </div>
                  <span className="slide-name">{sl.label}</span>
                </button>
              );
            })}
          </div>

          {/* Contextual Slide Banner & Settings (Pinned to manually selected slide so auto-rotate never shifts UI) */}
          <div className="contextual-slide-box">
            <div className="contextual-slide-head">
              <span className="contextual-slide-kicker">
                SLIDE {optionsSlideDef?.number} OPTIONS · {optionsSlideDef?.label}
              </span>
            </div>

            {optionsSlide === 'title' && (
              <div className="intermission-field">
                <label htmlFor="title-subtitle-input">Welcome Subtitle (Optional)</label>
                <input
                  id="title-subtitle-input"
                  type="text"
                  value={state.presentation?.titleSubtitle ?? ''}
                  onChange={(e) =>
                    onUpdatePresentationConfig({ titleSubtitle: e.target.value })
                  }
                  placeholder="Optional subtitle (leave blank to hide)"
                />
              </div>
            )}

            {optionsSlide === 'arena' && (
              <div className="title-slide-options-stack">
                <div className="contextual-inline-row">
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={state.ui?.showMiniBracket !== false}
                      onChange={(e) => onToggleMiniBracket(e.target.checked)}
                    />
                    <span>Show Ticker below Scoreboard</span>
                  </label>
                  <span className="contextual-hint">
                    Active: {match ? `${match.roundLabel} (${match.label})` : 'None'}
                  </span>
                </div>
              </div>
            )}

            {optionsSlide === 'bracket' && (
              <div className="title-slide-options-stack">
                <div className="intermission-field">
                  <label htmlFor="bracket-subtitle-input">Bracket Slide Subtitle (Optional)</label>
                  <input
                    id="bracket-subtitle-input"
                    type="text"
                    value={state.presentation?.bracketSubtitle ?? ''}
                    onChange={(e) =>
                      onUpdatePresentationConfig({ bracketSubtitle: e.target.value })
                    }
                    placeholder="Optional subtitle (leave blank to hide)"
                  />
                </div>
                <div className="contextual-inline-row">
                  <div className="rule-group">
                    <span className="rule-label">Show Bracket</span>
                    <div
                      className="segmented-control compact"
                      role="group"
                      aria-label="Full bracket display filter"
                    >
                      {[
                        { id: 'both', label: 'Both' },
                        { id: 'winners', label: 'Winners' },
                        { id: 'losers', label: 'Losers' },
                      ].map((opt) => {
                        const currentFilter = state.presentation?.bracketViewFilter || 'both';
                        const isDisabled = opt.id === 'losers' && state.format !== 'double';
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            className={currentFilter === opt.id ? 'is-selected' : ''}
                            disabled={isDisabled}
                            title={
                              isDisabled
                                ? 'Switch to Double Elimination in Setup to view the Losers Bracket'
                                : undefined
                            }
                            onClick={() =>
                              onUpdatePresentationConfig({ bracketViewFilter: opt.id })
                            }
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <span className="contextual-hint">
                    {state.playerCount > 16
                      ? `Large bracket (${state.playerCount} ${
                          state.entryMode === 'teams' ? 'teams' : 'players'
                        }): showing Current Round only (${stats.completedCount}/${
                          stats.totalMatches
                        } done).`
                      : `Auto-fits all ${state.playerCount} ${
                          state.entryMode === 'teams' ? 'teams' : 'players'
                        } (${stats.completedCount}/${stats.totalMatches} done) across full width.`}
                  </span>
                </div>
              </div>
            )}

            {optionsSlide === 'split' && (
              <div className="title-slide-options-stack">
                <div className="intermission-field">
                  <label htmlFor="split-subtitle-input">Split View Subtitle (Optional)</label>
                  <input
                    id="split-subtitle-input"
                    type="text"
                    value={state.presentation?.splitSubtitle ?? ''}
                    onChange={(e) =>
                      onUpdatePresentationConfig({ splitSubtitle: e.target.value })
                    }
                    placeholder="Optional subtitle (leave blank to hide)"
                  />
                </div>
                <div className="contextual-inline-row">
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={state.ui?.showMiniBracket !== false}
                      onChange={(e) => onToggleMiniBracket(e.target.checked)}
                    />
                    <span>Show Ticker in Split View</span>
                  </label>
                  <span className="contextual-hint">
                    {stats.upNext.length} On Deck · {stats.recentCompleted.length} Recent Results
                  </span>
                </div>
              </div>
            )}

            {optionsSlide === 'spotlight' && (
              <div className="intermission-field">
                <label htmlFor="intermission-msg-input">
                  Spotlight Subtitle (Optional — leave blank to hide)
                </label>
                <input
                  id="intermission-msg-input"
                  type="text"
                  value={state.presentation?.intermissionMessage ?? ''}
                  onChange={(e) =>
                    onUpdatePresentationConfig({ intermissionMessage: e.target.value })
                  }
                  placeholder="Optional subtitle (leave blank to hide)"
                />
              </div>
            )}
          </div>

          {/* Ticker Mode + Items (matches On Deck segmented-control layout) */}
          {state.ui?.showMiniBracket !== false && (
            <>
              <div className="autorotate-row">
                <div className="rule-group">
                  <span className="rule-label">Ticker</span>
                  <div
                    className="segmented-control compact"
                    role="group"
                    aria-label="Presentation Ticker mode"
                  >
                    {[
                      { id: 'static', label: 'Static' },
                      { id: 'scroll', label: 'Scroll' },
                      { id: 'rotate', label: 'Rotate' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={resolveTickerMode(state.ui) === opt.id ? 'is-selected' : ''}
                        onClick={() => onChangeTicker?.({ mode: opt.id })}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                {resolveTickerMode(state.ui) !== 'static' ? (
                  <div className="autorotate-seconds">
                    <label htmlFor="ticker-sec-input">
                      {resolveTickerMode(state.ui) === 'scroll' ? 'Pace' : 'Every'}
                    </label>
                    <input
                      id="ticker-sec-input"
                      type="number"
                      min="3"
                      max="120"
                      value={state.ui?.tickerRotateSec ?? 10}
                      onChange={(e) => onChangeTicker?.({ rotateSec: Number(e.target.value) })}
                    />
                    <span>sec</span>
                  </div>
                ) : (
                  <span className="contextual-hint">
                    Showing {normalizeTickerItems(state.ui?.tickerItems).length} item
                    {normalizeTickerItems(state.ui?.tickerItems).length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className="ticker-config" role="group" aria-label="Ticker items">
                {TICKER_ITEM_DEFS.map((it) => {
                  const cur = normalizeTickerItems(state.ui?.tickerItems);
                  return (
                    <label key={it.id} className="toggle-label autorotate-slide-chip">
                      <input
                        type="checkbox"
                        checked={cur.includes(it.id)}
                        onChange={(e) =>
                          onChangeTicker?.({
                            items: e.target.checked
                              ? [...cur, it.id]
                              : cur.filter((x) => x !== it.id),
                          })
                        }
                      />
                      <span>{it.label}</span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
          <div className="autorotate-row">
            <div className="rule-group">
              <span className="rule-label">On Deck</span>
              <div
                className="segmented-control compact"
                role="group"
                aria-label="Presentation On Deck visibility"
              >
                {[
                  { id: 'hide', label: 'Hide' },
                  { id: 'show', label: 'Show' },
                  { id: 'nearing_end', label: 'Near End' },
                ].map((opt) => {
                  const currentMode = state.presentation?.onDeckMode || 'nearing_end';
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={currentMode === opt.id ? 'is-selected' : ''}
                      onClick={() => onUpdatePresentationConfig({ onDeckMode: opt.id })}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <span className="contextual-hint">
              {(state.presentation?.onDeckMode || 'nearing_end') === 'hide'
                ? 'On Deck banner hidden'
                : (state.presentation?.onDeckMode || 'nearing_end') === 'show'
                ? `Always showing (${stats.upNext.length} queued)`
                : `Auto-shows near end of match (${stats.upNext.length} queued)`}
            </span>
          </div>

          <div className="autorotate-row">
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={Boolean(state.presentation?.spotlightBetweenMatches)}
                onChange={(e) =>
                  onUpdatePresentationConfig({ spotlightBetweenMatches: e.target.checked })
                }
              />
              <span>Show Spotlight between matches</span>
            </label>
            <span className="contextual-hint">
              Auto-switches to Spotlight after a match completes until the next match begins
            </span>
          </div>

          <div className="autorotate-row">
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={Boolean(state.presentation?.autoRotate)}
                onChange={(e) => onToggleAutoRotate(e.target.checked)}
              />
              <span>Auto-rotate slides</span>
            </label>
            <div className="autorotate-seconds">
              <label htmlFor="autorotate-sec-input">Every</label>
              <input
                id="autorotate-sec-input"
                type="number"
                min="5"
                max="120"
                value={state.presentation?.autoRotateSec ?? 18}
                onChange={(e) => onChangeAutoRotateSec(Number(e.target.value))}
              />
              <span>sec</span>
            </div>
          </div>

          {state.presentation?.autoRotate && (
            <div className="autorotate-slides" role="group" aria-label="Slides included in auto-rotate">
              <span className="autorotate-slides-label">Rotate through:</span>
              {SLIDE_DEFINITIONS.map((sl) => {
                const selected = (state.presentation?.autoRotateSlides ?? SLIDE_DEFINITIONS.map((d) => d.id)).includes(sl.id);
                return (
                  <label key={sl.id} className="toggle-label autorotate-slide-chip">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) => {
                        const current = state.presentation?.autoRotateSlides ?? SLIDE_DEFINITIONS.map((d) => d.id);
                        const next = e.target.checked
                          ? [...current, sl.id]
                          : current.filter((id) => id !== sl.id);
                        onChangeAutoRotateSlides?.(next);
                      }}
                    />
                    <span>{sl.shortLabel}</span>
                  </label>
                );
              })}
            </div>
          )}

          {/* Live Scaled Screen Preview */}
          <div className="mini-monitor-frame" aria-label="Live preview of active presentation slide">
            <div className="mini-monitor-bar">
              <span
                className={`live-rec-dot ${isStudio ? 'is-studio-dot' : ''}`}
                aria-hidden="true"
              />
              <span>
                {isStudio ? 'STAGED PREVIEW' : 'LIVE SCREEN'} · {activeSlideDef?.label}
              </span>
              <span className="mini-monitor-tag">
                {isStudio ? `LIVE SCREEN: ${programSlideDef?.shortLabel}` : 'AUTO-FIT FULLSCREEN'}
              </span>
            </div>

            <div className={`mini-monitor-screen slide-${activeSlide}`}>
              {activeSlide === 'title' && (
                <div className="mini-title">
                  <div className="mini-badge">
                    {THEME_OPTIONS.find((t) => t.id === (state.ui?.theme || 'arena'))?.icon}{' '}
                    {THEME_OPTIONS.find((t) => t.id === (state.ui?.theme || 'arena'))?.label} ·{' '}
                    Ambiance:{' '}
                    {resolveEffectiveAmbiance(
                      state.presentation?.titleAmbiance || 'auto',
                      state.ui?.theme || 'arena'
                    )}
                  </div>
                  <div className="mini-spotlight-title">{state.tournamentName}</div>
                  {Boolean(state.presentation?.titleSubtitle?.trim()) && (
                    <div className="mini-stat-line">{state.presentation.titleSubtitle}</div>
                  )}
                  {state.rules?.grandmaEnabled !== false && (
                    <div className="mini-corner-chip">Grandma Corner Live</div>
                  )}
                </div>
              )}

              {activeSlide === 'arena' && (
                <div className="mini-arena">
                  <div className="mini-badge">{evalState.status}</div>
                  <div className="mini-score-row">
                    <div className="mini-player">
                      <span className="mini-pname">{p1?.name || 'TBD'}</span>
                      <span className="mini-pnum">{String(match?.score1 || 0).padStart(2, '0')}</span>
                    </div>
                    <span className="mini-vs">:</span>
                    <div className="mini-player">
                      <span className="mini-pname">{p2?.name || 'TBD'}</span>
                      <span className="mini-pnum">{String(match?.score2 || 0).padStart(2, '0')}</span>
                    </div>
                  </div>
                  {state.ui?.showMiniBracket !== false && (
                    <div className="mini-subline">+ Live Mini Bracket visible below scoreboard</div>
                  )}
                  {state.rules?.grandmaEnabled !== false && (
                    <div className="mini-corner-chip">CRT + Grandma Live</div>
                  )}
                </div>
              )}

              {activeSlide === 'bracket' && (
                <div className="mini-bracket">
                  <div className="mini-badge">
                    {state.format === 'double'
                      ? `DOUBLE ELIMINATION · ${
                          (state.presentation?.bracketViewFilter || 'both') === 'winners'
                            ? 'WINNERS'
                            : (state.presentation?.bracketViewFilter || 'both') === 'losers'
                            ? 'LOSERS'
                            : 'BOTH'
                        }`
                      : 'SINGLE ELIMINATION'}{' '}
                    · {state.playerCount} {state.entryMode === 'teams' ? 'TEAMS' : 'PLAYERS'}
                  </div>
                  <div className="mini-bracket-bars">
                    <div className="mini-b-col">
                      <span className="b-done" />
                      <span className="b-live" />
                      <span className="b-tbd" />
                    </div>
                    <div className="mini-b-col">
                      <span className="b-done" />
                      <span className="b-tbd" />
                    </div>
                    <div className="mini-b-col">
                      <span className="b-champ">🏆 {champion ? champion.name : 'TBD'}</span>
                    </div>
                  </div>
                  <div className="mini-stat-line">
                    {stats.completedCount}/{stats.totalMatches} Matches Completed (Auto-Fit)
                  </div>
                </div>
              )}

              {activeSlide === 'split' && (
                <div className="mini-split">
                  <div className="mini-split-left">
                    <span className="mini-badge">LIVE</span>
                    <strong>
                      {p1?.name?.split(' ')[0] || 'P1'} {match?.score1 ?? 0} – {match?.score2 ?? 0}{' '}
                      {p2?.name?.split(' ')[0] || 'P2'}
                    </strong>
                  </div>
                  <div className="mini-split-right">
                    <span className="mini-subhead">UP NEXT ({stats.upNext.length})</span>
                    <span className="mini-subline">Mini Bracket · Recent Ticker Active</span>
                  </div>
                </div>
              )}

              {activeSlide === 'spotlight' && (
                <div className="mini-spotlight">
                  <div className="mini-trophy">🏆</div>
                  <div className="mini-spotlight-title">
                    {champion ? `CHAMPION: ${champion.name}` : 'SPOTLIGHT / WARM-UP'}
                  </div>
                  {(champion || Boolean(state.presentation?.intermissionMessage?.trim())) && (
                    <div className="mini-stat-line">
                      {champion
                        ? `${stats.totalPointsPlayed} Total Points${
                            state.rules?.grandmaEnabled !== false ? ' · Full-Size Grandma CRT' : ''
                          }`
                        : state.presentation.intermissionMessage}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
