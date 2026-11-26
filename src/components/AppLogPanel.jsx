import React, { useEffect, useMemo, useState } from 'react';
import { clearAppLogs, getAppLogs, subscribeAppLogs } from '../engine/appLog.js';

const LEVEL_COLORS = {
  error: { bg: 'rgba(239, 68, 68, 0.14)', border: 'rgba(239, 68, 68, 0.42)', text: '#fca5a5', tag: 'ERROR' },
  warn: { bg: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.42)', text: '#fde68a', tag: 'WARN' },
  success: { bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.35)', text: '#a7f3d0', tag: 'OK' },
  info: { bg: 'rgba(15, 23, 42, 0.55)', border: 'rgba(148, 163, 184, 0.2)', text: '#cbd5e1', tag: 'INFO' },
};

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function AppLogPanel({ onNotify = null }) {
  const [logs, setLogs] = useState(() => getAppLogs());
  const [filter, setFilter] = useState('all'); // 'all' | 'error' | 'warn' | 'info'

  useEffect(() => {
    setLogs(getAppLogs());
    return subscribeAppLogs((next) => setLogs([...next]));
  }, []);

  const counts = useMemo(() => {
    let errors = 0;
    let warns = 0;
    for (const l of logs) {
      if (l.level === 'error') errors += 1;
      else if (l.level === 'warn') warns += 1;
    }
    return { total: logs.length, errors, warns };
  }, [logs]);

  const visibleLogs = useMemo(() => {
    if (filter === 'all') return logs;
    if (filter === 'error') return logs.filter((l) => l.level === 'error');
    if (filter === 'warn') return logs.filter((l) => l.level === 'warn' || l.level === 'error');
    return logs.filter((l) => l.level === 'info' || l.level === 'success');
  }, [logs, filter]);

  const handleCopy = async () => {
    const text = visibleLogs
      .map(
        (l) =>
          `[${new Date(l.ts).toISOString()}] [${l.level.toUpperCase()}] [${l.category}] ${l.message}${
            l.detail ? ` — ${l.detail}` : ''
          }`
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text || '(no log entries)');
      onNotify?.(`Copied ${visibleLogs.length} log entr${visibleLogs.length === 1 ? 'y' : 'ies'}`);
    } catch {
      onNotify?.('Could not copy log to clipboard');
    }
  };

  return (
    <section className="panel-card debug-tech-panel" aria-label="Activity and Diagnostics Log">
      <div className="panel-header-row">
        <div>
          <h2 className="panel-title">📜 Activity &amp; Diagnostics Log</h2>
          <p className="panel-subtitle">
            Persistent session log of uploads (GCS/LAN), sync events, operator toasts, and runtime
            errors ({counts.total} entries{counts.errors > 0 ? ` · ${counts.errors} errors` : ''})
          </p>
        </div>
        <div className="inline-actions" style={{ flexWrap: 'wrap' }}>
          <div className="segmented-control compact">
            <button
              type="button"
              className={filter === 'all' ? 'is-selected' : ''}
              onClick={() => setFilter('all')}
            >
              All ({counts.total})
            </button>
            <button
              type="button"
              className={filter === 'error' ? 'is-selected' : ''}
              onClick={() => setFilter('error')}
            >
              Errors ({counts.errors})
            </button>
            <button
              type="button"
              className={filter === 'warn' ? 'is-selected' : ''}
              onClick={() => setFilter('warn')}
            >
              Warn+ ({counts.errors + counts.warns})
            </button>
          </div>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={handleCopy}
            disabled={visibleLogs.length === 0}
          >
            📋 Copy
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => {
              clearAppLogs();
              onNotify?.('Cleared activity log');
            }}
            disabled={logs.length === 0}
          >
            🗑 Clear
          </button>
        </div>
      </div>

      {visibleLogs.length === 0 ? (
        <p className="panel-subtitle" style={{ margin: '0.5rem 0 0' }}>
          No matching log entries recorded in this session yet.
        </p>
      ) : (
        <div
          className="scroller"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.32rem',
            maxHeight: '280px',
            overflowY: 'auto',
            marginTop: '0.5rem',
            paddingRight: '0.2rem',
          }}
        >
          {visibleLogs.map((l) => {
            const styleDef = LEVEL_COLORS[l.level] || LEVEL_COLORS.info;
            return (
              <div
                key={l.id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '0.5rem',
                  padding: '0.36rem 0.6rem',
                  borderRadius: '7px',
                  background: styleDef.bg,
                  border: `1px solid ${styleDef.border}`,
                  fontSize: '0.78rem',
                  lineHeight: 1.35,
                  wordBreak: 'break-word',
                }}
              >
                <span
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: '0.7rem',
                    opacity: 0.7,
                    flexShrink: 0,
                  }}
                >
                  {formatTime(l.ts)}
                </span>
                <span
                  style={{
                    fontSize: '0.66rem',
                    fontWeight: 800,
                    padding: '0.06rem 0.36rem',
                    borderRadius: '4px',
                    background: 'rgba(15, 23, 42, 0.75)',
                    color: styleDef.text,
                    flexShrink: 0,
                  }}
                >
                  {styleDef.tag}
                </span>
                <span
                  style={{
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    opacity: 0.72,
                    flexShrink: 0,
                  }}
                >
                  {l.category}
                </span>
                <span style={{ color: styleDef.text, flex: 1, minWidth: 0 }}>
                  {l.message}
                  {l.detail && (
                    <span style={{ display: 'block', opacity: 0.8, fontSize: '0.72rem', marginTop: '0.12rem' }}>
                      {l.detail}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
