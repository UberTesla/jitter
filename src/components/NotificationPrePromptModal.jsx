import React, { useMemo } from 'react';

/**
 * Detects the user's browser & OS so we can render an accurate visual preview
 * of the EXACT native permission popup they are about to see next.
 */
export function detectClientNotificationUI() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const host =
    typeof window !== 'undefined' && window.location?.host
      ? window.location.host
      : 'this tournament';

  const isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (typeof navigator !== 'undefined' &&
      navigator.platform === 'MacIntel' &&
      (navigator.maxTouchPoints || 0) > 1);
  const isAndroid = /Android/i.test(ua);
  const isFirefox = /Firefox|FxiOS/i.test(ua);
  const isEdge = /Edg\//i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|OPR/i.test(ua);

  if (isIOS) {
    return {
      variant: 'ios',
      label: 'iPhone / iPad',
      where: 'Center of your screen',
      title: `"${host}" Would Like to Send You Notifications`,
      body: 'Notifications may include alerts, sounds, and icon badges.',
      denyLabel: "Don't Allow",
      allowLabel: 'Allow',
    };
  }

  if (isSafari) {
    return {
      variant: 'safari-mac',
      label: 'Safari on Mac',
      where: 'Top of your Safari window',
      title: `"${host}" would like to send you notifications.`,
      body: 'Notifications can be configured in Safari Settings.',
      denyLabel: "Don't Allow",
      allowLabel: 'Allow',
    };
  }

  if (isAndroid) {
    return {
      variant: 'android',
      label: isEdge ? 'Edge on Android' : isFirefox ? 'Firefox on Android' : 'Chrome on Android',
      where: 'Center / bottom of your phone screen',
      title: `Allow ${host} to send you notifications?`,
      body: '',
      denyLabel: 'Block',
      allowLabel: 'Allow',
    };
  }

  if (isFirefox) {
    return {
      variant: 'firefox',
      label: 'Firefox',
      where: 'Top-left near the address bar',
      title: `Allow ${host} to send notifications?`,
      body: '',
      denyLabel: 'Block',
      allowLabel: 'Allow',
    };
  }

  return {
    variant: 'chromium',
    label: isEdge ? 'Microsoft Edge' : 'Chrome',
    where: 'Top-left near the address bar',
    title: `${host} wants to`,
    body: '🔔 Show notifications',
    denyLabel: 'Block',
    allowLabel: 'Allow',
  };
}

/**
 * High-conviction Pre-Permission Modal shown BEFORE calling Notification.requestPermission().
 * Explains why live tournament alerts matter and previews the user's exact browser prompt
 * with the "Allow" button highlighted so players don't reflexively tap Block.
 */
export default function NotificationPrePromptModal({ open, onEnable, onDismiss }) {
  const clientUi = useMemo(() => detectClientNotificationUI(), []);

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
        <div className="notify-preprompt-kicker">
          <span className="notify-preprompt-pulse" aria-hidden="true" />
          🚨 DON&apos;T MISS YOUR MATCH
        </div>

        <h2 id="notify-preprompt-title" className="notify-preprompt-title">
          Turn On Live Tournament Alerts
        </h2>

        <p className="notify-preprompt-lead">
          Without alerts enabled, <strong>you won&apos;t know when you&apos;re called to the table</strong>{' '}
          — and you risk holding up the bracket or getting skipped while your phone is in your pocket.
        </p>

        <ul className="notify-preprompt-reasons">
          <li>
            <span aria-hidden="true">🏓</span>
            <span>
              <strong>Instant Table Call:</strong> Pinged the second you&apos;re <strong>On Deck</strong>{' '}
              and when your match starts (with your exact <strong>Table #</strong>).
            </span>
          </li>
          <li>
            <span aria-hidden="true">📱</span>
            <span>
              <strong>Works With Your Screen Locked:</strong> Alerts break through even if you switch apps
              or put your phone away.
            </span>
          </li>
          <li>
            <span aria-hidden="true">🔒</span>
            <span>
              <strong>Zero Spam, Ever:</strong> Strictly live match calls, Host announcements &amp; DMs for
              this tournament.
            </span>
          </li>
        </ul>

        {/* Tailored Preview of THIS Client's Exact Browser/OS Popup */}
        <div className="notify-preview-section">
          <div className="notify-preview-caption">
            NEXT POPUP ({clientUi.label.toUpperCase()} · {clientUi.where.toUpperCase()}) — TAP{' '}
            <strong>&ldquo;{clientUi.allowLabel.toUpperCase()}&rdquo;</strong>:
          </div>

          <div
            className={`notify-native-mock is-${clientUi.variant}`}
            aria-hidden="true"
          >
            <div className="nnm-title">{clientUi.title}</div>
            {clientUi.body && <div className="nnm-body">{clientUi.body}</div>}
            <div className="nnm-actions">
              <span className="nnm-btn is-deny">{clientUi.denyLabel}</span>
              <span className="nnm-btn is-allow">
                {clientUi.allowLabel}
                <span className="nnm-pointer">👈 TAP THIS</span>
              </span>
            </div>
          </div>
        </div>

        <div className="notify-preprompt-actions">
          <button
            type="button"
            className="btn-amber notify-preprompt-cta"
            onClick={() => onEnable?.()}
          >
            🔔 Yes — Turn On Match Alerts Now
          </button>
          <button
            type="button"
            className="notify-preprompt-skip"
            onClick={() => onDismiss?.()}
          >
            Skip for now (I&apos;ll watch the screen myself)
          </button>
        </div>
      </div>
    </div>
  );
}
