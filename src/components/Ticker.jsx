import React, { useEffect, useMemo, useState } from 'react';
import MiniBracket from './MiniBracket.jsx';
import TournamentStatsPanel from './TournamentStatsPanel.jsx';
import { computeTournamentStats } from '../engine/bracketGenerator.js';
import {
  TICKER_ITEM_DEFS,
  normalizeTickerItems,
  resolveTickerMode,
  tournamentStore,
} from '../state/tournamentStore.js';

/**
 * Presentation Ticker (replaces the fixed "live mini bracket").
 * Shows the operator-selected items (bracket, recent results, on deck, stats),
 * optionally auto-rotating through them.
 */
export default function Ticker({
  state,
  showLosers = true,
  bracketTitle = 'LIVE BRACKET OVERVIEW',
}) {
  const items = useMemo(() => normalizeTickerItems(state.ui?.tickerItems), [state.ui?.tickerItems]);
  const mode = resolveTickerMode(state.ui);
  const autoRotate = mode === 'rotate';
  const rotateSec = Math.max(3, Number(state.ui?.tickerRotateSec) || 10);
  const [idx, setIdx] = useState(0);
  const [chatMessages, setChatMessages] = useState(
    () => tournamentStore.getSyncMeta()?.remoteSync?.chatLiveMessages || []
  );

  const includesChat = items.includes('chat');
  useEffect(() => {
    if (!includesChat) return undefined;
    const syncChat = () => {
      const msgs = tournamentStore.getSyncMeta()?.remoteSync?.chatLiveMessages;
      setChatMessages(Array.isArray(msgs) ? msgs : []);
    };
    syncChat();
    const unsub = tournamentStore.subscribe(syncChat);
    if (state?.tournamentId) {
      tournamentStore.fetchTournamentChat(state.tournamentId);
    }
    return () => unsub?.();
  }, [includesChat, state?.tournamentId]);

  useEffect(() => {
    if (!autoRotate || items.length < 2) return undefined;
    const id = setInterval(() => setIdx((n) => n + 1), rotateSec * 1000);
    return () => clearInterval(id);
  }, [autoRotate, items, rotateSec]);

  const stats = useMemo(() => computeTournamentStats(state), [state]);
  const nameOf = (id, fallback) => state.players?.find((p) => p.id === id)?.name || fallback || 'TBD';

  if (items.length === 0) return null;
  const scroll = mode === 'scroll';
  const visible = autoRotate && !scroll ? [items[idx % items.length]] : items;
  const playerMap = new Map((state.players || []).map((p) => [p.id, p]));
  const isTeams = state.entryMode === 'teams';
  const renderItem = (id) => {
    if (id === 'bracket') {
      return (
        <MiniBracket
          key={id}
          matches={state.matches}
          players={state.players}
          format={state.format}
          entryMode={state.entryMode || 'singles'}
          activeMatchId={state.activeMatchId}
          championId={state.championId}
          showLosers={showLosers}
          title={bracketTitle}
          vertical={scroll || autoRotate}
          focusActive={!scroll}
        />
      );
    }
    const def = TICKER_ITEM_DEFS.find((d) => d.id === id);
    let body = null;
    if (id === 'recent') {
      body = stats.recentCompleted.length === 0 ? (
        <span className="ticker-empty">Completed scores will appear here live!</span>
      ) : (
        stats.recentCompleted.map((m) => (
          <div key={m.id} className="ticker-chip">
            <span className="ticker-code">{m.label}</span>
            <span className={m.winnerId === m.player1Id ? 'ticker-winner' : ''}>{nameOf(m.player1Id)}</span>
            <strong className="ticker-score">{m.score1}–{m.score2}</strong>
            <span className={m.winnerId === m.player2Id ? 'ticker-winner' : ''}>{nameOf(m.player2Id)}</span>
          </div>
        ))
      );
    } else if (id === 'upnext') {
      body = stats.upNext.length === 0 ? (
        <span className="ticker-empty">No matches queued.</span>
      ) : (
        stats.upNext.slice(0, 4).map((m) => (
          <div key={m.id} className="ticker-chip">
            <span className="ticker-code">{m.label}</span>
            <span>{nameOf(m.player1Id, m.source1Label)}</span>
            <em>vs</em>
            <span>{nameOf(m.player2Id, m.source2Label)}</span>
          </div>
        ))
      );
    } else if (id === 'stats') {
      const full = !scroll && visible.length === 1;
      body = (
        <TournamentStatsPanel
          stats={stats}
          playerMap={playerMap}
          isTeams={isTeams}
          rules={state.rules}
          variant={full ? 'full' : 'chips'}
          extras={full}
          leaderCount={full ? 5 : 3}
        />
      );
    } else if (id === 'chat') {
      const recentChat = chatMessages.slice(-6);
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', width: '100%' }}>
          {stats.upNext.length > 0 && (
            <div
              className="ticker-chip"
              style={{
                borderColor: 'rgba(56, 189, 248, 0.45)',
                background: 'rgba(56, 189, 248, 0.14)',
              }}
            >
              <span className="ticker-code" style={{ color: '#38bdf8' }}>
                ⏳ ON DECK
              </span>
              <span>
                {stats.upNext
                  .slice(0, 2)
                  .map(
                    (m) =>
                      `${nameOf(m.player1Id, m.source1Label)} vs ${nameOf(
                        m.player2Id,
                        m.source2Label
                      )}`
                  )
                  .join(' · ')}
              </span>
            </div>
          )}
          {recentChat.length === 0 ? (
            <span className="ticker-empty">Live chat comments will appear here!</span>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
              {recentChat.map((m) => (
                <div
                  key={m.id}
                  className="ticker-chip"
                  style={{
                    borderColor:
                      m.kind === 'win' || m.kind === 'champion'
                        ? 'rgba(16, 185, 129, 0.5)'
                        : m.kind === 'announcement'
                        ? 'rgba(245, 158, 11, 0.55)'
                        : undefined,
                  }}
                >
                  <strong className="ticker-winner">{m.fromName}:</strong>
                  <span>{m.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
    return (
      <section key={id} className="broadcast-ticker-card" aria-label={def?.label || id}>
        <div className="ticker-label">{def?.label?.toUpperCase() || id}</div>
        <div className="ticker-items">{body}</div>
      </section>
    );
  };

  if (scroll) {
    const track = visible.map((id) => (
      <React.Fragment key={id}>{renderItem(id)}</React.Fragment>
    ));
    return (
      <div className="ticker-region is-scroll">
        <section className="broadcast-ticker-card ticker-marquee" aria-label="Ticker">
          <div className="ticker-marquee-track" style={{ animationDuration: `${Math.max(60, rotateSec * 12)}s` }}>
            <div className="ticker-marquee-group">{track}</div>
            <div className="ticker-marquee-group" aria-hidden="true">{track}</div>
          </div>
        </section>
      </div>
    );
  }

  return <div className="ticker-region">{visible.map(renderItem)}</div>;
}