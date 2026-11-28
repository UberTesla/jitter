import React, { useMemo } from 'react';

/**
 * Detects the user's browser, OS, and prefers-color-scheme (dark/light)
 * to preview their native notification prompt accurately.
 */
export function detectClientNotificationUI() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const host =
    typeof window !== 'undefined' && window.location?.host
      ? window.location.host
      : 'this site';
  const isDark = Boolean(
    typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
  );

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
      isDark,
      where: 'center of screen',
      title: `"${host}" Would Like to Send You Notifications`,
      body: '',
      denyLabel: "Don't Allow",
      allowLabel: 'Allow',
    };
  }

  if (isSafari) {
    return {
      variant: 'safari-mac',
      isDark,
      where: 'top of Safari',
      title: `"${host}" would like to send you notifications.`,
      body: '',
      denyLabel: "Don't Allow",
      allowLabel: 'Allow',
    };
  }

  if (isAndroid) {
    return {
      variant: 'android',
      isDark,
      where: 'bottom of screen',
      title: `Allow ${host} to send you notifications?`,
      body: '',
      denyLabel: 'Block',
      allowLabel: 'Allow',
    };
  }

  if (isFirefox) {
    return {
      variant: 'firefox',
      isDark,
      where: 'top-left by address bar',
      title: `Allow ${host} to send notifications?`,
      body: '',
      denyLabel: 'Block',
      allowLabel: 'Allow',
    };
  }

  return {
    variant: isEdge ? 'edge' : 'chrome',
    isDark,
    where: 'top-left by address bar',
    title: `${host} wants to`,
    body: '🔔 Show notifications',
    denyLabel: 'Block',
    allowLabel: 'Allow',
  };
}

/**
 * Compact, high-conviction Pre-Permission Modal shown BEFORE Notification.requestPermission().
 * Adapts the native prompt preview to the user's browser, OS, and dark/light mode.
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
          🚨 DON&apos;T GET SKIPPED
        </div>

        <h2 id="notify-preprompt-title" className="notify-preprompt-title">
          Turn On Match Alerts
        </h2>

        <p className="notify-preprompt-lead">
          We&apos;ll ping your device when you&apos;re <strong>On Deck</strong> and when your{' '}
          <strong>Table</strong> is up — even with your screen locked. Zero spam.
        </p>

        <div className="notify-preview-section">
          <div className="notify-preview-caption">
            Next popup ({clientUi.where}) → tap <strong>{clientUi.allowLabel}</strong>:
          </div>

          <div
            className={`notify-native-mock is-${clientUi.variant} ${
              clientUi.isDark ? 'is-dark' : 'is-light'
            }`}
            aria-hidden="true"
          >
            <div className="nnm-title">{clientUi.title}</div>
            {clientUi.body && <div className="nnm-body">{clientUi.body}</div>}
            <div className="nnm-actions">
              <span className="nnm-btn is-allow">{clientUi.allowLabel}</span>
              <span className="nnm-btn is-deny">{clientUi.denyLabel}</span>
            </div>
          </div>
        </div>

        <div className="notify-preprompt-actions">
          <button
            type="button"
            className="btn-amber notify-preprompt-cta"
            onClick={() => onEnable?.()}
          >
            🔔 Turn On Match Alerts
          </button>
          <button
            type="button"
            className="notify-preprompt-skip"
            onClick={() => onDismiss?.()}
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
