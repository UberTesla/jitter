/**
 * Centralized App Version & Build Stamp helper.
 * Values are injected at build time by Vite (`__APP_BUILD__`) using package.json version,
 * Render's RENDER_GIT_COMMIT (or local `git rev-parse --short HEAD`), and build timestamp.
 */

const rawBuild =
  typeof __APP_BUILD__ !== 'undefined' && __APP_BUILD__
    ? __APP_BUILD__
    : { version: '1.0.0', gitSha: '', builtAt: '' };

export const APP_BUILD = Object.freeze({
  version: String(rawBuild.version || '1.0.0'),
  gitSha: String(rawBuild.gitSha || ''),
  builtAt: String(rawBuild.builtAt || ''),
});

export function formatVersionBadge() {
  const base = `v${APP_BUILD.version}`;
  return APP_BUILD.gitSha ? `${base} · ${APP_BUILD.gitSha}` : base;
}

export function formatBuildTooltip() {
  const parts = [`Jitter v${APP_BUILD.version}`];
  if (APP_BUILD.gitSha) parts.push(`commit ${APP_BUILD.gitSha}`);
  if (APP_BUILD.builtAt) {
    try {
      parts.push(`built ${new Date(APP_BUILD.builtAt).toLocaleString()}`);
    } catch {
      parts.push(`built ${APP_BUILD.builtAt}`);
    }
  }
  return parts.join(' · ');
}
