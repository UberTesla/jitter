export const SWIPE_MIN_DISTANCE_PX = 48;
export const SWIPE_MAX_DURATION_MS = 1200;
export const SWIPE_AXIS_RATIO = 1.25;

/**
 * Determine whether a pointer/touch drag represents an intentional horizontal swipe.
 * Swiping left (deltaX < 0) advances to the next slide; swiping right (deltaX > 0)
 * returns to the previous slide.
 *
 * @param {number} deltaX
 * @param {number} deltaY
 * @param {number} [durationMs=0]
 * @param {{ minDistancePx?: number, maxDurationMs?: number, axisRatio?: number }} [options]
 * @returns {'next' | 'prev' | null}
 */
export function detectHorizontalSwipe(deltaX, deltaY, durationMs = 0, options = {}) {
  const minDistancePx = options.minDistancePx ?? SWIPE_MIN_DISTANCE_PX;
  const maxDurationMs = options.maxDurationMs ?? SWIPE_MAX_DURATION_MS;
  const axisRatio = options.axisRatio ?? SWIPE_AXIS_RATIO;

  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null;
  if (Number.isFinite(durationMs) && durationMs > maxDurationMs) return null;

  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (absX < minDistancePx) return null;
  if (absX < absY * axisRatio) return null;

  return deltaX < 0 ? 'next' : 'prev';
}

/**
 * Return the next or previous slide id from an ordered slide definition list,
 * wrapping around at both ends.
 *
 * @param {string} currentSlideId
 * @param {'next' | 'prev'} direction
 * @param {Array<{ id: string }>} slides
 * @returns {string | null}
 */
export function getAdjacentSlideId(currentSlideId, direction, slides) {
  if (!Array.isArray(slides) || slides.length === 0) return null;
  if (direction !== 'next' && direction !== 'prev') return null;

  const currentIdx = slides.findIndex((s) => s?.id === currentSlideId);
  const safeIdx = currentIdx >= 0 ? currentIdx : 0;
  const step = direction === 'next' ? 1 : -1;
  const nextIdx = (safeIdx + step + slides.length) % slides.length;
  return slides[nextIdx]?.id ?? null;
}

/**
 * Resolve the target slide id for a completed swipe gesture in Presentation View.
 * Returns null when local swipe navigation is disabled (e.g. Sync Live is checked).
 *
 * @param {{
 *   enabled: boolean,
 *   currentSlideId: string,
 *   deltaX: number,
 *   deltaY: number,
 *   durationMs?: number,
 *   slides: Array<{ id: string }>,
 * }} params
 * @returns {string | null}
 */
export function resolveSwipeSlide({
  enabled,
  currentSlideId,
  deltaX,
  deltaY,
  durationMs = 0,
  slides,
}) {
  if (!enabled) return null;
  const direction = detectHorizontalSwipe(deltaX, deltaY, durationMs);
  if (!direction) return null;
  return getAdjacentSlideId(currentSlideId, direction, slides);
}
