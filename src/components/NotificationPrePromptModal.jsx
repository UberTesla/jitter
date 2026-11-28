import React from 'react';

/**
 * Clean, persuasive Pre-Permission Modal shown BEFORE calling Notification.requestPermission().
 */
export default function NotificationPrePromptModal({ open, onEnable, onDismiss }) {
  if (!open) return null;

  return (
    <div
      className="notify-preprompt-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="notify-preprompt-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss?.();
      }}
    >
      <div className="notify-preprompt-card">
        <h2 id="notify-preprompt-title" className="notify-preprompt-title">
          YOU&apos;RE in control
        </h2>

        <ul className="notify-preprompt-list">
          <li>
            <span className="npl-icon" aria-hidden="true">🏓</span>
            <span>
              <strong>UP NEXT</strong> — Know instantly when it&apos;s your turn.
            </span>
          </li>
          <li>
            <span className="npl-icon" aria-hidden="true">📢</span>
            <span>
              <strong>GET NOTIFIED</strong> — Announcements, updates, messages.
            </span>
          </li>
          <li>
            <span className="npl-icon" aria-hidden="true">🔇</span>
            <span>
              <strong>67?</strong> — No nonsense, no spam, EVER.
            </span>
          </li>
        </ul>

        <div className="notify-preprompt-actions">
          <button
            type="button"
            className="btn-amber notify-preprompt-cta"
            onClick={() => onEnable?.()}
          >
            🔔 Turn On Alerts
          </button>
          <button
            type="button"
            className="notify-preprompt-skip"
            onClick={() => onDismiss?.()}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
