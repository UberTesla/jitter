/**
 * Animated Retro 4:3 CRT Television & Grandma Living Room Scene (HTML5 Canvas)
 *
 * Coordinate System: Fixed 620 x 340 logical pixels scaled by window.devicePixelRatio.
 * Layout:
 *   - Grandma in Armchair: x = 124..284 (zero overlap with TV stand or mug)
 *   - Mid-Century Walnut TV Stand: x = 298..602
 *   - Steaming Coffee Mug: x = 314..348 resting on stand left surface
 *   - 4:3 Retro CRT Television: x = 362..588 sitting on stand right surface
 *   - Default 1990s Sitcom Broadcast: Seamless 6.0-second mathematical loop
 */

export const LOGICAL_WIDTH = 620;
export const LOGICAL_HEIGHT = 340;
const SITCOM_LOOP_SEC = 6.0;

/**
 * Helper to draw a rounded rectangle path.
 */
function roundRectPath(ctx, x, y, w, h, r) {
  const radius = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r;
  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + w - radius.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius.tr);
  ctx.lineTo(x + w, y + h - radius.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius.br, y + h);
  ctx.lineTo(x + radius.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
}

/**
 * Draws an image or video cover-fitted (center-cropped) inside a destination rectangle.
 */
function drawMediaCover(ctx, media, dx, dy, dw, dh) {
  const mw = media.videoWidth || media.naturalWidth || media.width || 0;
  const mh = media.videoHeight || media.naturalHeight || media.height || 0;
  if (!mw || !mh) return false;

  const targetRatio = dw / dh;
  const sourceRatio = mw / mh;

  let sx = 0;
  let sy = 0;
  let sw = mw;
  let sh = mh;

  if (sourceRatio > targetRatio) {
    // Wider than 4:3 -> crop left/right equally
    sw = mh * targetRatio;
    sx = (mw - sw) * 0.5;
  } else {
    // Taller than 4:3 -> crop top/bottom equally
    sh = mw / targetRatio;
    sy = (mh - sh) * 0.5;
  }

  ctx.drawImage(media, sx, sy, sw, sh, dx, dy, dw, dh);
  return true;
}

/**
 * Word-wraps text to fit within maxWidth on the current canvas font.
 */
function wrapTextLines(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let current = words[0];

  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

export class RetroTVScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rafId = null;
    this.startTime = performance.now();
    this.lastFrameTime = this.startTime;
    this.running = false;

    // External media elements (real visible DOM underlay behind CRT glass cutout)
    this.mediaMode = 'sitcom'; // 'sitcom' | 'video' | 'image'
    this.domMediaActive = false;
    this.videoEl = null;
    this.imgEl = null;
    this.animatedFrames = null; // [{ bitmap: ImageBitmap, endMs: number }]
    this.animatedTotalMs = 0;

    // Engine-driven synchronized Grandma speech state (zero per-view random timers)
    this.stayDurationSec = options.stayDurationSec ?? 5.5;
    this.bubbleScale = options.bubbleScale ?? 1.0;
    this.activeSpeech = options.activeSpeech || null;
    this.collapsedToMug = Boolean(options.collapsedToMug);
    this.isLocallyOverridden = Boolean(options.isLocallyOverridden);

    this.isLowPowerDevice =
      typeof navigator !== 'undefined' &&
      (/silk|aft|firetv|android|smart-tv|smarttv|tizen|webos/i.test(navigator.userAgent || '') ||
        (Number(navigator.hardwareConcurrency) > 0 && Number(navigator.hardwareConcurrency) <= 4));
    this.minFrameIntervalMs = this.isLowPowerDevice ? 33 : 0; // 30fps cap on Fire Stick / TVs to keep UI & SSE instant
    this.lastRenderAt = 0;

    this.resize();
  }

  resize() {
    if (!this.canvas) return;
    const maxDpr = this.isLowPowerDevice ? 1.5 : 2;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const targetW = Math.round(LOGICAL_WIDTH * dpr);
    const targetH = Math.round(LOGICAL_HEIGHT * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  setConfig({ stayDurationSec, bubbleScale, activeSpeech, collapsedToMug, isLocallyOverridden }) {
    if (typeof stayDurationSec === 'number') {
      this.stayDurationSec = Math.max(2, stayDurationSec);
    }
    if (typeof bubbleScale === 'number') {
      this.bubbleScale = Math.max(0.75, Math.min(1.5, bubbleScale));
    }
    if (activeSpeech !== undefined) {
      this.activeSpeech = activeSpeech || null;
    }
    if (collapsedToMug !== undefined) {
      this.collapsedToMug = Boolean(collapsedToMug);
    }
    if (isLocallyOverridden !== undefined) {
      this.isLocallyOverridden = Boolean(isLocallyOverridden);
    }
  }

  clearAnimatedFrames() {
    if (Array.isArray(this.animatedFrames)) {
      for (const frame of this.animatedFrames) {
        try {
          frame.bitmap?.close?.();
        } catch {
          // Ignore already closed bitmap
        }
      }
    }
    this.animatedFrames = null;
    this.animatedTotalMs = 0;
  }

  setAnimatedFrames(frames, totalMs) {
    this.clearAnimatedFrames();
    if (Array.isArray(frames) && frames.length > 1 && totalMs > 0) {
      this.animatedFrames = frames;
      this.animatedTotalMs = totalMs;
    }
  }

  setDomMediaActive(active) {
    this.domMediaActive = Boolean(active);
  }

  setMedia({ mode, videoEl, imgEl }) {
    this.mediaMode = mode || 'sitcom';
    this.videoEl = videoEl || null;
    this.imgEl = imgEl || null;
    if (this.mediaMode !== 'image') {
      this.clearAnimatedFrames();
    }
  }

  getActiveBubbleSnapshot(now = Date.now()) {
    const speech = this.activeSpeech;
    if (!speech || !speech.text) return null;
    const rawStarted = Number(speech.startedAt ?? speech.timestamp ?? 0);
    const expiresAt = Number(speech.expiresAt ?? 0);
    if (!rawStarted || !expiresAt || now >= expiresAt) {
      return null;
    }
    // Never delay showing a speech bubble if the receiver's clock is behind the sender's clock
    const effectiveStart = Math.min(rawStarted, now);
    const totalVisibleSec = Math.max(
      0.5,
      (Number(speech.durationMs) || expiresAt - rawStarted) / 1000
    );
    return {
      text: String(speech.text),
      isLive: Boolean(speech.isLive),
      elapsedSec: Math.max(0, (now - effectiveStart) / 1000),
      totalVisibleSec,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this.lastRenderAt = 0;
    const tick = (now) => {
      if (!this.running) return;
      if (this.minFrameIntervalMs > 0 && now - this.lastRenderAt < this.minFrameIntervalMs) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }
      this.lastRenderAt = now;
      this.lastFrameTime = now;
      const t = (now - this.startTime) / 1000;

      this.resize();
      this.render(t);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.clearAnimatedFrames();
  }

  render(t) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

    if (this.collapsedToMug) {
      // Collapsed mode: show only the steaming coffee cup in the bottom right at its exact 1:1 size + speech bubbles!
      ctx.save();
      ctx.translate(568 - 320, 296 - 204);
      this.drawCoffeeMug(ctx, t);
      ctx.restore();

      const activeBubble = this.getActiveBubbleSnapshot();
      if (activeBubble) {
        this.drawSpeechBubble(ctx, activeBubble, { anchorX: 579, anchorTopY: 274, alignRight: true });
      }
      return;
    }

    // Seamless 6.0-second loop phase for sitcom & synchronized living-room motion
    const phase = ((t % SITCOM_LOOP_SEC) / SITCOM_LOOP_SEC) * Math.PI * 2;

    // 1. Mid-Century Walnut TV Stand (x=298..602)
    this.drawTVStand(ctx);

    // 2. Steaming Ceramic Coffee Mug on left side of stand surface (x=314..348)
    this.drawCoffeeMug(ctx, t);

    // 3. 4:3 Retro CRT Television on stand (x=362..588)
    this.drawRetroCRT(ctx, t, phase);

    // 4. Grandma in Armchair (x=124..284, zero overlap with TV stand x=298)
    this.drawGrandmaInArmchair(ctx, t);

    // 5. Engine-Synced Speech Bubble (strictly clamped within 620 x 340)
    const activeBubble = this.getActiveBubbleSnapshot();
    if (activeBubble) {
      this.drawSpeechBubble(ctx, activeBubble);
    }
  }

  // =========================================================================
  // 1. MID-CENTURY WALNUT TV STAND (x = 298..602)
  // =========================================================================
  drawTVStand(ctx) {
    // Soft floor shadow
    ctx.save();
    const shadowGrad = ctx.createRadialGradient(450, 330, 20, 450, 330, 165);
    shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.52)');
    shadowGrad.addColorStop(0.7, 'rgba(0, 0, 0, 0.24)');
    shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadowGrad;
    ctx.beginPath();
    ctx.ellipse(450, 330, 162, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    // Rear tapered legs (darker depth)
    ctx.fillStyle = '#3b2112';
    ctx.beginPath();
    ctx.moveTo(334, 306);
    ctx.lineTo(343, 306);
    ctx.lineTo(338, 326);
    ctx.lineTo(331, 326);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(557, 306);
    ctx.lineTo(566, 306);
    ctx.lineTo(569, 326);
    ctx.lineTo(562, 326);
    ctx.closePath();
    ctx.fill();

    // Front tapered mid-century legs with brass ferrules
    const drawFrontLeg = (topX, bottomX) => {
      const legGrad = ctx.createLinearGradient(topX, 304, bottomX, 332);
      legGrad.addColorStop(0, '#683b20');
      legGrad.addColorStop(0.78, '#4d2a16');
      legGrad.addColorStop(1, '#3d2010');
      ctx.fillStyle = legGrad;
      ctx.beginPath();
      ctx.moveTo(topX - 6, 306);
      ctx.lineTo(topX + 6, 306);
      ctx.lineTo(bottomX + 3.5, 332);
      ctx.lineTo(bottomX - 3.5, 332);
      ctx.closePath();
      ctx.fill();

      // Brass foot cap
      ctx.fillStyle = '#d4a84f';
      ctx.beginPath();
      ctx.moveTo(bottomX - 4, 325);
      ctx.lineTo(bottomX + 4, 325);
      ctx.lineTo(bottomX + 3.5, 332);
      ctx.lineTo(bottomX - 3.5, 332);
      ctx.closePath();
      ctx.fill();
    };

    drawFrontLeg(320, 310);
    drawFrontLeg(580, 590);

    // Main Walnut Cabinet Box (x=298..602 -> width=304)
    const bodyGrad = ctx.createLinearGradient(298, 238, 298, 310);
    bodyGrad.addColorStop(0, '#7c4828');
    bodyGrad.addColorStop(0.5, '#64381e');
    bodyGrad.addColorStop(1, '#4b2814');
    roundRectPath(ctx, 300, 238, 300, 70, 4);
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.strokeStyle = '#33190b';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Subtle horizontal walnut wood grain lines
    ctx.save();
    roundRectPath(ctx, 300, 238, 300, 70, 4);
    ctx.clip();
    ctx.strokeStyle = 'rgba(42, 18, 6, 0.25)';
    ctx.lineWidth = 1;
    for (let gy = 244; gy < 306; gy += 6) {
      ctx.beginPath();
      ctx.moveTo(300, gy);
      ctx.bezierCurveTo(390, gy + ((gy % 12) - 6) * 0.25, 510, gy - 1.5, 600, gy + 1);
      ctx.stroke();
    }
    ctx.restore();

    // Beveled Walnut Top Slab (x=298..602)
    const topGrad = ctx.createLinearGradient(298, 229, 298, 241);
    topGrad.addColorStop(0, '#9d623c');
    topGrad.addColorStop(0.35, '#864f2c');
    topGrad.addColorStop(1, '#583018');
    roundRectPath(ctx, 298, 229, 304, 12, { tl: 4, tr: 4, br: 2, bl: 2 });
    ctx.fillStyle = topGrad;
    ctx.fill();
    ctx.strokeStyle = '#3b1e0e';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Specular highlight along top bevel edge
    ctx.strokeStyle = 'rgba(255, 220, 180, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(302, 231);
    ctx.lineTo(598, 231);
    ctx.stroke();

    // Left & Right Cabinet Doors + Center Open Media Shelf
    // Left door (x=310..404)
    this.drawCabinetDoor(ctx, 310, 247, 94, 53, 392);
    // Center VCR / tape shelf (x=412..488)
    roundRectPath(ctx, 412, 247, 76, 53, 2);
    ctx.fillStyle = '#25140c';
    ctx.fill();
    ctx.strokeStyle = '#3f2212';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Shelf divider + retro VHS deck inside center cubby
    ctx.fillStyle = '#6b3d21';
    ctx.fillRect(413, 274, 74, 4);
    // Retro VCR box
    roundRectPath(ctx, 418, 255, 64, 17, 2);
    ctx.fillStyle = '#1b1d24';
    ctx.fill();
    ctx.fillStyle = '#2f3440';
    ctx.fillRect(423, 260, 28, 5); // tape slot
    ctx.fillStyle = '#34d399';
    ctx.font = 'bold 7px monospace';
    ctx.fillText('12:00', 456, 266); // blinking classic VCR clock look

    // Stacked VHS tapes on lower shelf
    ctx.fillStyle = '#92400e';
    ctx.fillRect(420, 287, 26, 10);
    ctx.fillStyle = '#1e3a8a';
    ctx.fillRect(449, 284, 30, 13);
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(453, 288, 16, 4);

    // Right door (x=496..590)
    this.drawCabinetDoor(ctx, 496, 247, 94, 53, 508);

    ctx.restore();
  }

  drawCabinetDoor(ctx, x, y, w, h, knobX) {
    roundRectPath(ctx, x, y, w, h, 2.5);
    const doorGrad = ctx.createLinearGradient(x, y, x, y + h);
    doorGrad.addColorStop(0, '#724224');
    doorGrad.addColorStop(1, '#583119');
    ctx.fillStyle = doorGrad;
    ctx.fill();
    ctx.strokeStyle = '#3b1e0e';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Inner recessed bevel frame
    roundRectPath(ctx, x + 5, y + 5, w - 10, h - 10, 1.5);
    ctx.strokeStyle = 'rgba(255, 210, 165, 0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Brass knob with highlight & drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(knobX + 1, y + h * 0.5 + 1.5, 4.2, 0, Math.PI * 2);
    ctx.fill();

    const knobGrad = ctx.createRadialGradient(
      knobX - 1.2,
      y + h * 0.5 - 1.2,
      0.6,
      knobX,
      y + h * 0.5,
      4.2
    );
    knobGrad.addColorStop(0, '#fef08a');
    knobGrad.addColorStop(0.55, '#d4a33b');
    knobGrad.addColorStop(1, '#855c14');
    ctx.fillStyle = knobGrad;
    ctx.beginPath();
    ctx.arc(knobX, y + h * 0.5, 4.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // =========================================================================
  // 2. STEAMING CERAMIC COFFEE MUG (x = 314..348 on TV stand surface)
  // =========================================================================
  drawCoffeeMug(ctx, t) {
    ctx.save();
    const mx = 320;
    const my = 204;
    const mw = 23;
    const mh = 26;

    // Contact shadow on walnut tabletop
    ctx.fillStyle = 'rgba(18, 8, 2, 0.42)';
    ctx.beginPath();
    ctx.ellipse(mx + mw * 0.52, my + mh + 0.5, 14, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Mug handle (left side so it faces Grandma cleanly)
    ctx.strokeStyle = '#e7dcc8';
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.arc(mx + 1, my + 13, 6.5, Math.PI * 0.55, Math.PI * 1.45);
    ctx.stroke();
    ctx.strokeStyle = '#b9a88d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(mx + 1, my + 13, 8.2, Math.PI * 0.58, Math.PI * 1.42);
    ctx.stroke();

    // Ceramic mug body
    const mugGrad = ctx.createLinearGradient(mx, my, mx + mw, my);
    mugGrad.addColorStop(0, '#cfc2aa');
    mugGrad.addColorStop(0.32, '#f6efe2');
    mugGrad.addColorStop(0.75, '#e5d9c3');
    mugGrad.addColorStop(1, '#b8a68b');
    roundRectPath(ctx, mx, my, mw, mh, { tl: 2, tr: 2, br: 5, bl: 5 });
    ctx.fillStyle = mugGrad;
    ctx.fill();
    ctx.strokeStyle = '#8b7960';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Warm retro stripe around mug
    ctx.fillStyle = '#c2410c';
    ctx.fillRect(mx + 1, my + 11, mw - 2, 3.5);
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(mx + 1, my + 15.5, mw - 2, 2);

    // Top rim & hot coffee ellipse
    ctx.fillStyle = '#f8f2e7';
    ctx.beginPath();
    ctx.ellipse(mx + mw / 2, my + 1.5, mw / 2, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#a39177';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    ctx.fillStyle = '#3b1f10';
    ctx.beginPath();
    ctx.ellipse(mx + mw / 2, my + 1.8, mw / 2 - 2.2, 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Crisp red outline around mug silhouette when local expanded/collapsed state differs from global
    if (this.isLocallyOverridden) {
      ctx.save();
      ctx.strokeStyle = '#ef4444';
      ctx.shadowColor = 'rgba(239, 68, 68, 0.9)';
      ctx.shadowBlur = 5;
      ctx.lineWidth = 2.0;

      // Outer handle arc
      ctx.beginPath();
      ctx.arc(mx + 1, my + 13, 8.6, Math.PI * 0.56, Math.PI * 1.44);
      ctx.stroke();

      // Mug body outline
      roundRectPath(ctx, mx - 0.8, my - 0.6, mw + 1.6, mh + 1.4, { tl: 3, tr: 3, br: 6, bl: 6 });
      ctx.stroke();

      // Top rim highlight ring
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(mx + mw / 2, my + 1.5, mw / 2 + 0.8, 3.8, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 3 Smooth, sine-wave rising steam wisps (seamless continuous loop)
    const steamPeriod = 3.2;
    for (let i = 0; i < 3; i++) {
      const progress = ((t / steamPeriod) + i / 3) % 1; // 0..1 continuous loop
      const alpha = Math.sin(progress * Math.PI) * 0.55;
      const baseX = mx + 7 + i * 5;
      const rise = progress * 34;
      const startY = my - 2 - rise * 0.25;
      const endY = my - 18 - rise;

      ctx.save();
      ctx.strokeStyle = `rgba(255, 250, 240, ${alpha.toFixed(3)})`;
      ctx.lineWidth = 2.1 - progress * 0.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const steps = 10;
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const py = startY + (endY - startY) * u;
        const wave = Math.sin(u * Math.PI * 2.2 - t * 3.1 + i * 2.1) * (2.6 + u * 2.5);
        const px = baseX + wave;
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  // =========================================================================
  // 3. 4:3 RETRO CRT TELEVISION (x = 362..588, y = 58..231)
  // =========================================================================
  drawRetroCRT(ctx, t, phase) {
    ctx.save();

    // --- Rabbit-Ear Antennas ---
    const antBaseX = 475;
    const antBaseY = 60;
    // Left ear
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(antBaseX - 6, antBaseY - 4);
    ctx.lineTo(antBaseX - 44, 14);
    ctx.stroke();
    // Right ear
    ctx.beginPath();
    ctx.moveTo(antBaseX + 6, antBaseY - 4);
    ctx.lineTo(antBaseX + 52, 18);
    ctx.stroke();

    // Antenna tips
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.arc(antBaseX - 44, 14, 2.8, 0, Math.PI * 2);
    ctx.arc(antBaseX + 52, 18, 2.8, 0, Math.PI * 2);
    ctx.fill();

    // Antenna swivel base dome
    roundRectPath(ctx, antBaseX - 18, antBaseY - 10, 36, 12, { tl: 8, tr: 8, br: 2, bl: 2 });
    ctx.fillStyle = '#27272a';
    ctx.fill();
    ctx.strokeStyle = '#52525b';
    ctx.lineWidth = 1;
    ctx.stroke();

    // TV contact shadow on stand
    ctx.fillStyle = 'rgba(15, 7, 2, 0.45)';
    ctx.fillRect(366, 227, 218, 5);

    // --- Outer Woodgrain CRT Cabinet ---
    const cabX = 362;
    const cabY = 58;
    const cabW = 226;
    const cabH = 172;

    const cabGrad = ctx.createLinearGradient(cabX, cabY, cabX, cabY + cabH);
    cabGrad.addColorStop(0, '#6e3f23');
    cabGrad.addColorStop(0.15, '#59321b');
    cabGrad.addColorStop(0.85, '#462614');
    cabGrad.addColorStop(1, '#311a0d');

    roundRectPath(ctx, cabX, cabY, cabW, cabH, 9);
    ctx.fillStyle = cabGrad;
    ctx.fill();
    ctx.strokeStyle = '#241208';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Top cabinet edge sheen
    ctx.strokeStyle = 'rgba(255, 224, 185, 0.28)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cabX + 10, cabY + 2);
    ctx.lineTo(cabX + cabW - 10, cabY + 2);
    ctx.stroke();

    // --- Inner Dark Charcoal Front Faceplate ---
    roundRectPath(ctx, cabX + 8, cabY + 8, cabW - 16, cabH - 16, 6);
    const faceGrad = ctx.createLinearGradient(cabX + 8, cabY + 8, cabX + 8, cabY + cabH - 8);
    faceGrad.addColorStop(0, '#27292e');
    faceGrad.addColorStop(1, '#15171b');
    ctx.fillStyle = faceGrad;
    ctx.fill();
    ctx.strokeStyle = '#474c57';
    ctx.lineWidth = 1;
    ctx.stroke();

    // --- 4:3 CRT Screen Bezel & Tube (exact 4:3 ratio: 160 x 120) ---
    const sx = 378;
    const sy = 84;
    const sw = 160;
    const sh = 120; // 160 / 120 === 4 / 3

    // Recessed molded bezel around CRT tube
    roundRectPath(ctx, sx - 5, sy - 5, sw + 10, sh + 10, 14);
    ctx.fillStyle = '#0d0f13';
    ctx.fill();
    ctx.strokeStyle = '#3c404a';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Subtle warm glow cast onto bezel from screen
    ctx.save();
    const glowPulse = 0.12 + 0.04 * Math.sin(phase * 2);
    ctx.shadowColor = `rgba(186, 220, 255, ${glowPulse})`;
    ctx.shadowBlur = 12;
    roundRectPath(ctx, sx, sy, sw, sh, 11);
    ctx.fillStyle = '#090d14';
    ctx.fill();
    ctx.restore();

    // --- Clip to Curved 4:3 CRT Screen ---
    ctx.save();
    roundRectPath(ctx, sx, sy, sw, sh, 11);
    ctx.clip();

    let drewCustomMedia = false;
    if (this.domMediaActive) {
      // Cut out a transparent 4:3 CRT glass window so the real DOM <video> / <img> underlay
      // plays natively (with HTTP 206 streaming + native GIF animation on every browser/LAN),
      // while CRT scanlines, glass glare, bezel, and Grandma's speech bubble stay on top!
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000000';
      ctx.fillRect(sx, sy, sw, sh);
      ctx.restore();
      drewCustomMedia = true;
    } else if (
      this.mediaMode === 'video' &&
      this.videoEl &&
      this.videoEl.readyState >= 2 &&
      this.videoEl.videoWidth > 0
    ) {
      drewCustomMedia = drawMediaCover(ctx, this.videoEl, sx, sy, sw, sh);
    } else if (
      this.mediaMode === 'image' &&
      this.animatedFrames &&
      this.animatedFrames.length > 1 &&
      this.animatedTotalMs > 0
    ) {
      const cycleMs = (t * 1000) % this.animatedTotalMs;
      let chosen = this.animatedFrames[0];
      for (let i = 0; i < this.animatedFrames.length; i++) {
        if (cycleMs < this.animatedFrames[i].endMs) {
          chosen = this.animatedFrames[i];
          break;
        }
      }
      if (chosen?.bitmap) {
        drewCustomMedia = drawMediaCover(ctx, chosen.bitmap, sx, sy, sw, sh);
      }
    } else if (
      this.mediaMode === 'image' &&
      this.imgEl &&
      this.imgEl.complete &&
      this.imgEl.naturalWidth > 0
    ) {
      drewCustomMedia = drawMediaCover(ctx, this.imgEl, sx, sy, sw, sh);
    }

    if (!drewCustomMedia) {
      this.drawSitcomBroadcast(ctx, sx, sy, sw, sh, phase);
    }

    // --- CRT Scanlines, Rolling Sync Bar, Glass Vignette & Glare ---
    // Fine horizontal CRT scanlines
    ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
    for (let y = sy; y < sy + sh; y += 3) {
      ctx.fillRect(sx, y, sw, 1.1);
    }

    // Rolling soft CRT refresh bar
    const rollY = sy + ((t * 28) % (sh + 24)) - 12;
    const rollGrad = ctx.createLinearGradient(sx, rollY - 10, sx, rollY + 10);
    rollGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
    rollGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.075)');
    rollGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = rollGrad;
    ctx.fillRect(sx, rollY - 10, sw, 20);

    // Curved glass inner vignette
    const vigGrad = ctx.createRadialGradient(
      sx + sw * 0.5,
      sy + sh * 0.48,
      sw * 0.25,
      sx + sw * 0.5,
      sy + sh * 0.5,
      sw * 0.68
    );
    vigGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vigGrad.addColorStop(0.75, 'rgba(0, 0, 0, 0.16)');
    vigGrad.addColorStop(1, 'rgba(0, 0, 0, 0.56)');
    ctx.fillStyle = vigGrad;
    ctx.fillRect(sx, sy, sw, sh);

    // Diagonal glass glare reflection
    ctx.fillStyle = 'rgba(255, 255, 255, 0.11)';
    ctx.beginPath();
    ctx.moveTo(sx + 6, sy + 4);
    ctx.lineTo(sx + 56, sy + 4);
    ctx.lineTo(sx + 20, sy + 72);
    ctx.lineTo(sx + 4, sy + 52);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.beginPath();
    ctx.moveTo(sx + 66, sy + 4);
    ctx.lineTo(sx + 80, sy + 4);
    ctx.lineTo(sx + 38, sy + 86);
    ctx.lineTo(sx + 28, sy + 80);
    ctx.closePath();
    ctx.fill();

    ctx.restore(); // End CRT clip

    // Subtle metallic brand badge below screen
    ctx.fillStyle = '#a1a1aa';
    ctx.fillRect(444, 211, 28, 3.5);

    // --- Right Control Panel (Dials, Power LED, Speaker Grille) ---
    const panelX = 546;
    roundRectPath(ctx, panelX, 76, 30, 140, 3);
    ctx.fillStyle = '#1d1f25';
    ctx.fill();
    ctx.strokeStyle = '#343842';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // VHF & UHF Rotary Channel Dials
    this.drawTVDial(ctx, panelX + 15, 96, 9.5, -0.5);
    this.drawTVDial(ctx, panelX + 15, 122, 9.5, 0.9);

    // Tiny volume / tint knobs
    this.drawTVDial(ctx, panelX + 10, 144, 4.2, 0.3);
    this.drawTVDial(ctx, panelX + 21, 144, 4.2, -1.1);

    // Warm power indicator LED
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(panelX + 15, 158, 2.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(34, 197, 94, 0.35)';
    ctx.beginPath();
    ctx.arc(panelX + 15, 158, 5, 0, Math.PI * 2);
    ctx.fill();

    // Speaker Grille Slats
    ctx.fillStyle = '#090a0d';
    for (let gy = 168; gy <= 207; gy += 5) {
      roundRectPath(ctx, panelX + 5, gy, 20, 2.4, 1);
      ctx.fill();
    }

    ctx.restore();
  }

  drawTVDial(ctx, cx, cy, r, angle) {
    // Knurled dark rim
    ctx.fillStyle = '#0e0f12';
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1.2, 0, Math.PI * 2);
    ctx.fill();

    // Silver metallic dial face
    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 1, cx, cy, r);
    grad.addColorStop(0, '#e4e4e7');
    grad.addColorStop(0.65, '#71717a');
    grad.addColorStop(1, '#3f3f46');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Center grip bar
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = '#18181b';
    ctx.fillRect(-r * 0.72, -1.5, r * 1.44, 3);
    ctx.fillStyle = '#f4f4f5';
    ctx.fillRect(r * 0.22, -0.7, r * 0.42, 1.4);
    ctx.restore();
  }

  // =========================================================================
  // DEFAULT 1990s SITCOM BROADCAST (Seamless 6.0-Second Mathematical Loop)
  // Inspired by Everybody Loves Raymond: staircase with white spindles,
  // taupe sofa, gesturing husband in blue button-down, reacting wife,
  // and grumpy dad in armchair.
  // =========================================================================
  drawSitcomBroadcast(ctx, sx, sy, sw, sh, phase) {
    ctx.save();
    ctx.translate(sx, sy);

    // Warm 1990s sitcom living room wall
    const wallGrad = ctx.createLinearGradient(0, 0, 0, sh);
    wallGrad.addColorStop(0, '#c8b493');
    wallGrad.addColorStop(0.68, '#b99f79');
    wallGrad.addColorStop(0.69, '#7a5838'); // Hardwood floor & rug horizon
    wallGrad.addColorStop(1, '#5d4026');
    ctx.fillStyle = wallGrad;
    ctx.fillRect(0, 0, sw, sh);

    // Living room baseboard & chair rail molding
    ctx.fillStyle = '#ebe1d1';
    ctx.fillRect(0, 79, sw, 3);
    ctx.fillStyle = '#d9ccb7';
    ctx.fillRect(0, 50, sw, 2);

    // --- Background Staircase with White Spindles (Left-Center climbing up) ---
    ctx.save();
    // Stairway cutout shadow
    ctx.fillStyle = '#8b7458';
    ctx.beginPath();
    ctx.moveTo(0, 2);
    ctx.lineTo(84, 2);
    ctx.lineTo(84, 78);
    ctx.lineTo(0, 78);
    ctx.closePath();
    ctx.fill();

    // Diagonal stair stringer & treads
    ctx.fillStyle = '#d8cbb8';
    ctx.beginPath();
    ctx.moveTo(0, 12);
    ctx.lineTo(78, 76);
    ctx.lineTo(78, 82);
    ctx.lineTo(0, 32);
    ctx.closePath();
    ctx.fill();

    // Individual stair steps behind spindles
    ctx.fillStyle = '#6c4d32';
    for (let step = 0; step < 6; step++) {
      const stX = 4 + step * 11;
      const stY = 14 + step * 10;
      ctx.fillRect(stX, stY, 13, 3.5);
    }

    // White spindles (balusters) along staircase
    ctx.strokeStyle = '#f5f0e6';
    ctx.lineWidth = 2.1;
    for (let sp = 0; sp < 10; sp++) {
      const spX = 6 + sp * 7.4;
      const topY = -2 + sp * 6.0;
      const botY = 18 + sp * 6.0;
      ctx.beginPath();
      ctx.moveTo(spX, topY);
      ctx.lineTo(spX, botY);
      ctx.stroke();
    }

    // Dark oak diagonal handrail
    ctx.strokeStyle = '#4e2f19';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(78, 59);
    ctx.stroke();

    // Newel post at bottom of stairs
    ctx.fillStyle = '#5c381f';
    ctx.fillRect(74, 54, 6, 26);
    ctx.fillStyle = '#f5f0e6';
    ctx.fillRect(75, 62, 4, 17);
    ctx.restore();

    // Warm table lamp & framed artwork on right wall
    ctx.fillStyle = '#6e4c2e';
    ctx.fillRect(102, 14, 24, 18);
    ctx.fillStyle = '#9db49d';
    ctx.fillRect(105, 17, 18, 12);
    // Warm lamp glow
    const lampGlow = ctx.createRadialGradient(144, 42, 2, 144, 42, 26);
    lampGlow.addColorStop(0, 'rgba(255, 232, 170, 0.65)');
    lampGlow.addColorStop(1, 'rgba(255, 210, 120, 0)');
    ctx.fillStyle = lampGlow;
    ctx.fillRect(118, 16, 42, 46);
    // Lamp shade
    ctx.fillStyle = '#f3dfa8';
    ctx.beginPath();
    ctx.moveTo(138, 36);
    ctx.lineTo(150, 36);
    ctx.lineTo(153, 47);
    ctx.lineTo(135, 47);
    ctx.closePath();
    ctx.fill();

    // Living room area rug
    ctx.fillStyle = '#8b4e3c';
    ctx.beginPath();
    ctx.ellipse(80, 109, 68, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#c9a66b';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // --- Taupe Sofa (Center-Left) ---
    // Sofa backrest
    roundRectPath(ctx, 12, 58, 86, 32, 7);
    ctx.fillStyle = '#9c8b78';
    ctx.fill();
    ctx.strokeStyle = '#6d5e4e';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Cushion seams
    ctx.beginPath();
    ctx.moveTo(41, 61);
    ctx.lineTo(41, 86);
    ctx.moveTo(69, 61);
    ctx.lineTo(69, 86);
    ctx.stroke();
    // Sofa seat & armrests
    roundRectPath(ctx, 10, 81, 90, 18, 5);
    ctx.fillStyle = '#8a7a68';
    ctx.fill();
    roundRectPath(ctx, 6, 70, 12, 27, 5);
    ctx.fillStyle = '#a89784';
    ctx.fill();
    roundRectPath(ctx, 92, 70, 12, 27, 5);
    ctx.fillStyle = '#a89784';
    ctx.fill();

    // --- Character 1: Reacting Wife on Sofa (Left Cushion) ---
    // Reacts on second half of 6s cycle with head shake + exasperated hand raise
    const wifeBob = Math.sin(phase) * 1.4;
    const wifeHeadTilt = Math.sin(phase * 2 - 0.6) * 0.14;
    const wifeArmRaise = Math.max(0, Math.sin(phase - Math.PI * 0.5)) * 10;

    ctx.save();
    ctx.translate(33, 76 + wifeBob * 0.4);
    // Seated burgundy/plum cardigan torso
    roundRectPath(ctx, -11, -8, 22, 23, 6);
    ctx.fillStyle = '#7c2d48';
    ctx.fill();
    // Jeans / legs
    ctx.fillStyle = '#334155';
    ctx.fillRect(-9, 13, 18, 12);
    // Reacting raised right arm / hand
    ctx.strokeStyle = '#7c2d48';
    ctx.lineWidth = 4.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(8, -2);
    ctx.lineTo(15, 2 - wifeArmRaise * 0.7);
    ctx.stroke();
    ctx.fillStyle = '#f2c6a0';
    ctx.beginPath();
    ctx.arc(16, 2 - wifeArmRaise * 0.7, 2.7, 0, Math.PI * 2);
    ctx.fill();

    // Wife head & auburn shoulder-length hair
    ctx.save();
    ctx.translate(0, -14);
    ctx.rotate(wifeHeadTilt);
    // Hair back
    ctx.fillStyle = '#7b3f20';
    roundRectPath(ctx, -9.5, -8, 19, 17, 7);
    ctx.fill();
    // Face
    ctx.fillStyle = '#f2c6a0';
    ctx.beginPath();
    ctx.arc(1, -1, 6.8, 0, Math.PI * 2);
    ctx.fill();
    // Hair bangs
    ctx.fillStyle = '#8d4a26';
    ctx.beginPath();
    ctx.arc(0, -5, 7.2, Math.PI, Math.PI * 2);
    ctx.fill();
    // Eyes looking right at husband
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(1, -2.5, 1.6, 1.6);
    ctx.fillRect(4.2, -2.5, 1.6, 1.6);
    // Exasperated talking mouth
    const wifeTalk = Math.abs(Math.sin(phase * 4)) * (wifeArmRaise > 2 ? 2.2 : 0.4);
    ctx.fillStyle = '#9f3a38';
    ctx.fillRect(2, 1.8, 3.2, 1 + wifeTalk);
    ctx.restore();
    ctx.restore();

    // --- Character 2: Gesturing Husband in Blue Button-Down Shirt (Center) ---
    // Stands & leans expressively near sofa, arms gesturing in smooth 6s harmonic
    const husbSway = Math.sin(phase) * 3.5;
    const husbBob = Math.abs(Math.sin(phase * 2)) * 2.2;
    const leftGesture = Math.sin(phase * 2) * 11;
    const rightGesture = Math.cos(phase * 2 + 0.5) * 10;

    ctx.save();
    ctx.translate(72 + husbSway, 73 - husbBob);
    // Khaki trousers
    ctx.fillStyle = '#a89270';
    ctx.fillRect(-8, 14, 7, 22);
    ctx.fillRect(1, 14, 7, 22);
    // Blue button-down shirt torso
    roundRectPath(ctx, -11, -12, 22, 28, 5);
    ctx.fillStyle = '#3b6ea5';
    ctx.fill();
    // Shirt collar & center button placket
    ctx.strokeStyle = '#6ba3db';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(0, 15);
    ctx.stroke();
    ctx.fillStyle = '#dbeafe';
    ctx.beginPath();
    ctx.moveTo(-4, -12);
    ctx.lineTo(0, -7);
    ctx.lineTo(4, -12);
    ctx.fill();

    // Animated gesturing arms
    ctx.strokeStyle = '#3b6ea5';
    ctx.lineWidth = 4.5;
    ctx.lineCap = 'round';
    // Left arm gesturing toward wife
    ctx.beginPath();
    ctx.moveTo(-10, -5);
    ctx.lineTo(-18, -2 - leftGesture * 0.55);
    ctx.stroke();
    // Right arm gesturing toward grumpy dad
    ctx.beginPath();
    ctx.moveTo(10, -5);
    ctx.lineTo(19, -3 + rightGesture * 0.55);
    ctx.stroke();
    // Hands
    ctx.fillStyle = '#efc09b';
    ctx.beginPath();
    ctx.arc(-19, -2 - leftGesture * 0.55, 2.8, 0, Math.PI * 2);
    ctx.arc(20, -3 + rightGesture * 0.55, 2.8, 0, Math.PI * 2);
    ctx.fill();

    // Husband head (tall, dark hair, animated talking mouth)
    ctx.save();
    ctx.translate(0, -20);
    ctx.rotate(Math.sin(phase * 2) * 0.09);
    ctx.fillStyle = '#efc09b';
    ctx.beginPath();
    ctx.ellipse(0, 0, 6.8, 8.2, 0, 0, Math.PI * 2);
    ctx.fill();
    // Short dark sitcom hair
    ctx.fillStyle = '#271e1a';
    ctx.beginPath();
    ctx.arc(0, -3.5, 7.2, Math.PI * 0.95, Math.PI * 2.05);
    ctx.fill();
    // Eyes & eyebrows
    ctx.fillStyle = '#18181b';
    ctx.fillRect(-3.5, -1.5, 1.7, 1.7);
    ctx.fillRect(1.5, -1.5, 1.7, 1.7);
    // Expressive talking mouth (driven by 6s harmonic)
    const talkOpen = 0.8 + Math.max(0, Math.sin(phase * 6)) * 2.4;
    ctx.fillStyle = '#7f1d1d';
    ctx.beginPath();
    ctx.ellipse(-0.5, 3.8, 2.6, talkOpen * 0.65, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // --- Character 3: Grumpy Dad in Armchair (Right Foreground) ---
    const dadGrumble = Math.sin(phase * 2 + 1.2) * 1.4;
    const dadArmWave = Math.sin(phase * 3) * 4.5;

    ctx.save();
    ctx.translate(131, 80);
    // Dad's brown recliner armchair backrest
    roundRectPath(ctx, -14, -22, 30, 44, 7);
    ctx.fillStyle = '#6c4932';
    ctx.fill();
    ctx.strokeStyle = '#472e1e';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Dad's torso (plaid/olive grumpy grandpa shirt)
    roundRectPath(ctx, -10, -8 + dadGrumble * 0.3, 21, 24, 5);
    ctx.fillStyle = '#5c6b4e';
    ctx.fill();
    ctx.strokeStyle = '#3f4a35';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(11, 0);
    ctx.moveTo(0, -8);
    ctx.lineTo(0, 16);
    ctx.stroke();

    // Dad's head (balding crown, white side hair, furrowed brow)
    ctx.save();
    ctx.translate(0, -15 + dadGrumble * 0.4);
    ctx.fillStyle = '#ecc09d';
    ctx.beginPath();
    ctx.arc(0, 0, 7.2, 0, Math.PI * 2);
    ctx.fill();
    // White side hair tufts
    ctx.fillStyle = '#d4d4d8';
    ctx.beginPath();
    ctx.arc(-6.5, -1, 2.4, 0, Math.PI * 2);
    ctx.arc(6.5, -1, 2.4, 0, Math.PI * 2);
    ctx.fill();
    // Furrowed grumpy brows
    ctx.strokeStyle = '#52525b';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-5, -3);
    ctx.lineTo(-1, -1.5);
    ctx.moveTo(3, -3);
    ctx.lineTo(0, -1.5);
    ctx.stroke();
    // Grumpy frown / mutter
    ctx.fillStyle = '#7c2d12';
    ctx.fillRect(-3.5, 2.8, 4.5, 1.3 + Math.max(0, Math.sin(phase * 4 + 2)) * 1.1);
    ctx.restore();

    // Armchair front armrest & waving newspaper/hand
    roundRectPath(ctx, -17, 4, 10, 22, 4);
    ctx.fillStyle = '#7d563c';
    ctx.fill();
    // Waving hand/remote
    ctx.strokeStyle = '#5c6b4e';
    ctx.lineWidth = 3.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-7, 1);
    ctx.lineTo(-17, -1 + dadArmWave * 0.6);
    ctx.stroke();
    ctx.fillStyle = '#f8fafc'; // folded newspaper/remote
    ctx.fillRect(-22, -4 + dadArmWave * 0.6, 7, 5);
    ctx.restore();

    // Subtle 90s sitcom warm studio lighting tint + tiny "CH 04" OSD
    ctx.fillStyle = 'rgba(255, 238, 195, 0.06)';
    ctx.fillRect(0, 0, sw, sh);

    ctx.fillStyle = 'rgba(74, 222, 128, 0.72)';
    ctx.font = 'bold 9px monospace';
    ctx.fillText('CH 04', 8, 14);

    ctx.restore();
  }

  // =========================================================================
  // 4. GRANDMA IN ARMCHAIR (x = 124..284, STRICT REAR 3/4 LAYERING)
  // Zero overlap with TV stand (x = 298..602).
  // Neck, knit cardigan collar, and head drawn BEHIND foreground chair back;
  // ONLY back/side silver-gray hair, rear bun + hairpin, and glasses temple/rim
  // stick up above the chair backrest — NO eyes, nose, or mouth visible.
  // =========================================================================
  drawGrandmaInArmchair(ctx, t) {
    ctx.save();
    // Shift cozy wingback chair closer to TV stand while keeping coffee mug (x=314..348) 100% visible
    ctx.translate(34, 0);

    // Subtle gentle breathing / watching TV sway
    const headBob = Math.sin(t * 1.45) * 1.4;
    const headNod = Math.sin(t * 0.9) * 0.025;
    const speakPulse =
      this.bubbleState === 'showing' ? Math.sin(t * 9.5) * 0.8 : 0;

    // --- Grounded Recliner Base Shadow ---
    const shadowGrad = ctx.createRadialGradient(200, 330, 16, 200, 330, 88);
    shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.58)');
    shadowGrad.addColorStop(0.75, 'rgba(0, 0, 0, 0.22)');
    shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadowGrad;
    ctx.beginPath();
    ctx.ellipse(200, 330, 86, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- Low Sturdy Recliner Base Feet ---
    ctx.fillStyle = '#24140c';
    roundRectPath(ctx, 134, 316, 20, 12, 4);
    ctx.fill();
    roundRectPath(ctx, 248, 316, 20, 12, 4);
    ctx.fill();
    ctx.fillStyle = '#180d07';
    ctx.fillRect(148, 312, 108, 10);

    // =====================================================================
    // LAYER A (BEHIND CHAIR BACKREST): Grandma's Neck, Knit Cardigan Collar,
    // Silver-Gray Hair (Rear 3/4), Rear Bun + Hairpin, and Glasses Temple Edge
    // =====================================================================
    ctx.save();
    ctx.translate(212, 165 + headBob + speakPulse * 0.45);
    ctx.rotate(headNod);

    // Soft knit cardigan collar & tucked shoulders (these sit BEHIND the backrest!)
    const cardiGrad = ctx.createLinearGradient(-34, 8, 34, 48);
    cardiGrad.addColorStop(0, '#9d87b5');
    cardiGrad.addColorStop(0.5, '#836c9c');
    cardiGrad.addColorStop(1, '#614d78');
    ctx.fillStyle = cardiGrad;
    ctx.beginPath();
    ctx.ellipse(2, 34, 40, 26, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    // Cozy ribbed knit collar detail
    ctx.strokeStyle = '#c4b5d6';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(2, 18, 17, Math.PI * 1.12, Math.PI * 1.88);
    ctx.stroke();

    // Rear neck silhouette (soft skin tone tucked into collar)
    ctx.fillStyle = '#e8c4a8';
    roundRectPath(ctx, -11, 2, 22, 18, 6);
    ctx.fill();

    // Subtle ear edge on right-side rear three-quarter profile (no face features!)
    ctx.fillStyle = '#e0b797';
    ctx.beginPath();
    ctx.ellipse(21, -13, 3.8, 5.5, 0.15, -Math.PI * 0.5, Math.PI * 0.5);
    ctx.fill();

    // Glasses temple arm & tiny outer rim edge peeking on the right side (watching TV)
    // Drawn cleanly on right edge of head profile — NO eyes, nose, or mouth!
    ctx.save();
    ctx.strokeStyle = '#d4a84f'; // warm gold wire rim
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    // Temple arm resting over ear edge toward front-right
    ctx.beginPath();
    ctx.moveTo(19.5, -16);
    ctx.lineTo(29.5, -17.2);
    ctx.stroke();
    // Slight outer glass rim curve peeking past right cheek silhouette
    ctx.strokeStyle = '#e5be67';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(30.5, -15.5, 3.2, 6.2, 0.1, -Math.PI * 0.45, Math.PI * 0.45);
    ctx.stroke();
    // Subtle lens glint
    ctx.fillStyle = 'rgba(219, 234, 254, 0.38)';
    ctx.beginPath();
    ctx.ellipse(30.2, -15.5, 2.2, 4.8, 0.1, -Math.PI * 0.45, Math.PI * 0.45);
    ctx.fill();
    ctx.restore();

    // Main silver-gray hair volume (rear three-quarter view facing right toward TV)
    const hairGrad = ctx.createRadialGradient(-4, -26, 6, 2, -16, 34);
    hairGrad.addColorStop(0, '#f1f5f9');
    hairGrad.addColorStop(0.45, '#cbd5e1');
    hairGrad.addColorStop(0.82, '#94a3b8');
    hairGrad.addColorStop(1, '#64748b');
    ctx.fillStyle = hairGrad;
    ctx.beginPath();
    ctx.ellipse(2, -17, 25, 24, 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Soft sculpted hair waves swept back toward the bun
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.65)';
    ctx.lineWidth = 1.5;
    for (let w = 0; w < 4; w++) {
      ctx.beginPath();
      ctx.moveTo(19, -29 + w * 6.5);
      ctx.quadraticCurveTo(2, -33 + w * 6.5, -19, -22 + w * 5.2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.35)';
    ctx.lineWidth = 1.1;
    for (let w = 0; w < 3; w++) {
      ctx.beginPath();
      ctx.moveTo(16, -25 + w * 7);
      ctx.quadraticCurveTo(0, -28 + w * 7, -18, -18 + w * 5.5);
      ctx.stroke();
    }

    // Rear Hair Bun (positioned on back-left of her head)
    const bunGrad = ctx.createRadialGradient(-24, -22, 2, -22, -19, 13);
    bunGrad.addColorStop(0, '#e2e8f0');
    bunGrad.addColorStop(0.55, '#b6c2d1');
    bunGrad.addColorStop(1, '#64748b');
    ctx.fillStyle = bunGrad;
    ctx.beginPath();
    ctx.ellipse(-22, -19, 11.5, 10, -0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Bun swirl highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(-22, -19, 6, Math.PI * 0.2, Math.PI * 1.4);
    ctx.stroke();

    // Tortoiseshell / Gold Hairpin tucked diagonally through the rear bun
    ctx.save();
    ctx.translate(-22, -19);
    ctx.rotate(-0.62);
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(13, 0);
    ctx.stroke();
    // Gold beaded hairpin ornament on outer end
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(-14.5, 0, 3.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();

    ctx.restore(); // End Grandma behind-chair layer

    // =====================================================================
    // LAYER B (FOREGROUND): Plush Brown Leather Recliner (Rear 3/4 View)
    // Rich chestnut/espresso leather, puffed headrest + lumbar, rolled arms,
    // subtle leather sheen, and classic side recliner handle.
    // =====================================================================

    // 1. Far-right plush leather side & armrest (angled toward TV, clears coffee mug)
    const rightArmGrad = ctx.createLinearGradient(236, 184, 278, 316);
    rightArmGrad.addColorStop(0, '#7c2433');
    rightArmGrad.addColorStop(0.5, '#591723');
    rightArmGrad.addColorStop(1, '#360c14');
    ctx.beginPath();
    ctx.moveTo(238, 178);
    ctx.bezierCurveTo(266, 184, 272, 206, 268, 224);
    ctx.bezierCurveTo(280, 232, 282, 256, 276, 280);
    ctx.lineTo(272, 310);
    ctx.quadraticCurveTo(270, 320, 254, 320);
    ctx.lineTo(234, 320);
    ctx.closePath();
    ctx.fillStyle = rightArmGrad;
    ctx.fill();
    ctx.strokeStyle = '#26080e';
    ctx.lineWidth = 1.7;
    ctx.stroke();

    // Soft leather specular highlight on right arm curve
    ctx.strokeStyle = 'rgba(255, 200, 210, 0.22)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(265, 234);
    ctx.quadraticCurveTo(275, 244, 273, 264);
    ctx.stroke();

    // 2. Main Plush Leather Recliner Backrest (rich burgundy / oxblood leather)
    const backGrad = ctx.createLinearGradient(130, 162, 256, 320);
    backGrad.addColorStop(0, '#9e3244');
    backGrad.addColorStop(0.32, '#7d2232');
    backGrad.addColorStop(0.72, '#5a1622');
    backGrad.addColorStop(1, '#3a0c15');

    ctx.beginPath();
    ctx.moveTo(154, 165);
    ctx.bezierCurveTo(182, 154, 218, 155, 242, 167); // Puffy pillow-top headrest
    ctx.bezierCurveTo(260, 176, 262, 198, 257, 226); // Upper pillow bolster
    ctx.bezierCurveTo(261, 252, 258, 286, 254, 310); // Lower lumbar bolster
    ctx.quadraticCurveTo(252, 320, 238, 320);
    ctx.lineTo(150, 320);
    ctx.quadraticCurveTo(136, 320, 134, 308);
    ctx.bezierCurveTo(130, 282, 129, 248, 133, 222);
    ctx.bezierCurveTo(130, 194, 138, 172, 154, 165);
    ctx.closePath();
    ctx.fillStyle = backGrad;
    ctx.fill();
    ctx.strokeStyle = '#26080e';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Soft leather sheen across top headrest pillow
    const sheenGrad = ctx.createLinearGradient(150, 158, 150, 196);
    sheenGrad.addColorStop(0, 'rgba(255, 218, 226, 0.28)');
    sheenGrad.addColorStop(0.6, 'rgba(255, 218, 226, 0.06)');
    sheenGrad.addColorStop(1, 'rgba(255, 218, 226, 0)');
    ctx.fillStyle = sheenGrad;
    ctx.beginPath();
    ctx.moveTo(158, 168);
    ctx.bezierCurveTo(184, 159, 216, 160, 238, 170);
    ctx.quadraticCurveTo(246, 182, 242, 194);
    ctx.quadraticCurveTo(196, 186, 148, 194);
    ctx.quadraticCurveTo(145, 180, 158, 168);
    ctx.closePath();
    ctx.fill();

    // Classic horizontal recliner split-back seam (separates headrest pillow & lumbar)
    ctx.strokeStyle = 'rgba(32, 6, 12, 0.58)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(136, 226);
    ctx.quadraticCurveTo(196, 236, 254, 226);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 200, 210, 0.18)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(138, 229);
    ctx.quadraticCurveTo(196, 239, 252, 229);
    ctx.stroke();

    // Tailored double-stitched leather seam along outer back contour
    ctx.strokeStyle = 'rgba(248, 196, 206, 0.26)';
    ctx.lineWidth = 1.3;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(144, 308);
    ctx.lineTo(142, 226);
    ctx.bezierCurveTo(140, 196, 146, 179, 160, 173);
    ctx.bezierCurveTo(184, 164, 214, 165, 236, 175);
    ctx.bezierCurveTo(248, 182, 251, 198, 248, 224);
    ctx.lineTo(245, 308);
    ctx.stroke();
    ctx.setLineDash([]);

    // 3. Plush Overstuffed Left Leather Armrest
    const leftArmGrad = ctx.createLinearGradient(120, 226, 162, 318);
    leftArmGrad.addColorStop(0, '#962e40');
    leftArmGrad.addColorStop(0.45, '#701d2c');
    leftArmGrad.addColorStop(1, '#420e18');
    ctx.beginPath();
    ctx.moveTo(140, 228);
    ctx.bezierCurveTo(120, 232, 118, 256, 124, 282);
    ctx.lineTo(128, 310);
    ctx.quadraticCurveTo(130, 320, 144, 320);
    ctx.lineTo(156, 320);
    ctx.quadraticCurveTo(162, 294, 158, 254);
    ctx.quadraticCurveTo(156, 230, 140, 228);
    ctx.closePath();
    ctx.fillStyle = leftArmGrad;
    ctx.fill();
    ctx.strokeStyle = '#26080e';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Soft highlight along puffed top of left armrest
    ctx.strokeStyle = 'rgba(255, 218, 226, 0.25)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(138, 234);
    ctx.quadraticCurveTo(126, 242, 126, 260);
    ctx.stroke();

    // Brushed Chrome Recliner Pull Handle on left side
    ctx.save();
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(126, 288);
    ctx.lineTo(116, 274);
    ctx.stroke();
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(126, 288);
    ctx.lineTo(116, 274);
    ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.ellipse(115, 272, 4.2, 2.8, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  // =========================================================================
  // 5. COMIC-STYLE SPEECH BUBBLE (Engine-Synced Typewriter, Strict 620x340 Clamping)
  // =========================================================================
  drawSpeechBubble(ctx, bubble, anchorOpts = {}) {
    ctx.save();

    const bubbleText = bubble.text;
    const bubbleElapsed = bubble.elapsedSec;
    const totalVisible = bubble.totalVisibleSec;

    // Typewriter progress derived directly from shared engine timestamp
    const charsVisible = Math.max(1, Math.floor(bubbleElapsed * 36));
    const displayText = bubbleText.slice(0, charsVisible);

    // Subtle pop-in & fade-out alpha
    const fadeIn = Math.min(1, bubbleElapsed / 0.18);
    const fadeOut = Math.min(1, Math.max(0, (totalVisible - bubbleElapsed) / 0.35));
    const alpha = Math.min(fadeIn, fadeOut);
    if (alpha <= 0.01) {
      ctx.restore();
      return;
    }

    ctx.globalAlpha = alpha;
    // Contextual / game-commentary bubbles are ALWAYS 2x base size regardless of bubbleScale setting.
    // Idle banter bubbles respect the user's Chat Bubble Size slider (bubbleScale).
    const isGameComment = Boolean(bubble.isLive);
    const margin = 10;
    const userScale = Math.max(0.75, Math.min(1.5, Number(this.bubbleScale) || 1.0));
    const effectiveScale = isGameComment ? userScale * 1.15 : userScale;

    let fontSize = Math.round(20 * effectiveScale);
    let padX = Math.round(18 * effectiveScale);
    let padY = Math.round(14 * effectiveScale);
    let lineH = Math.round(26 * effectiveScale);
    let iconSize = Math.round(fontSize * 1.65);
    let iconGap = Math.max(8, Math.round(fontSize * 0.52));
    let iconSlotW = iconSize + iconGap;
    const maxBubbleW = isGameComment
      ? LOGICAL_WIDTH - margin * 2
      : Math.min(LOGICAL_WIDTH - margin * 2, Math.round(420 * effectiveScale));
    let maxTextW = Math.max(120, maxBubbleW - padX * 2 - iconSlotW);
    let fontStr = `700 ${fontSize}px "Inter", system-ui, -apple-system, sans-serif`;
    ctx.font = fontStr;

    let fullLines = wrapTextLines(ctx, bubbleText, maxTextW);
    // Safety clamp only if an extraordinarily long string exceeds canvas height at 2x
    while (Math.max(fullLines.length * lineH, iconSize) + padY * 2 > LOGICAL_HEIGHT - 44 && fontSize > 14) {
      fontSize -= 2;
      lineH = Math.round(fontSize * 1.28);
      padX = Math.max(12, Math.round(fontSize * 0.85));
      padY = Math.max(10, Math.round(fontSize * 0.68));
      iconSize = Math.round(fontSize * 1.65);
      iconGap = Math.max(8, Math.round(fontSize * 0.52));
      iconSlotW = iconSize + iconGap;
      maxTextW = Math.max(120, maxBubbleW - padX * 2 - iconSlotW);
      fontStr = `700 ${fontSize}px "Inter", system-ui, -apple-system, sans-serif`;
      ctx.font = fontStr;
      fullLines = wrapTextLines(ctx, bubbleText, maxTextW);
    }

    const visibleLines = wrapTextLines(ctx, displayText, maxTextW);

    let measuredMaxW = 0;
    for (const line of fullLines) {
      measuredMaxW = Math.max(measuredMaxW, ctx.measureText(line).width);
    }

    const minW = Math.round(160 * effectiveScale);
    const contentH = Math.max(fullLines.length * lineH, iconSize);
    const bw = Math.max(minW, Math.min(maxBubbleW, Math.ceil(measuredMaxW + padX * 2 + iconSlotW)));
    const bh = Math.min(LOGICAL_HEIGHT - margin * 2, Math.ceil(contentH + padY * 2));

    // Anchor target above Grandma's head (or above the collapsed steaming coffee mug in bottom-right)
    const headAnchorX = anchorOpts.anchorX ?? 239;
    const headTopY = anchorOpts.anchorTopY ?? 116;

    // Ideal centered (or right-aligned for collapsed mug) position, strictly clamped inside [10, 610] x [10, 330]
    let bx = anchorOpts.alignRight ? LOGICAL_WIDTH - margin - bw : headAnchorX - bw * 0.52;
    let by = headTopY - bh - 18;

    const maxRight = LOGICAL_WIDTH - margin;
    if (bx + bw > maxRight) bx = maxRight - bw;
    if (bx < margin) bx = margin;
    if (by < margin) by = margin;
    if (by + bh > LOGICAL_HEIGHT - margin) by = LOGICAL_HEIGHT - margin - bh;

    // Compute tail attachment point clamped along bubble bottom edge
    const tailTipX = Math.max(bx + 18, Math.min(bx + bw - 18, headAnchorX - 4));
    const tailTipY = Math.min(LOGICAL_HEIGHT - 12, Math.max(by + bh + 10, headTopY - 2));
    const tailBaseLeft = Math.max(bx + 14, Math.min(bx + bw - 34, tailTipX - 10));
    const tailBaseRight = tailBaseLeft + 17;

    // Comic drop shadow
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.42)';
    roundRectPath(ctx, bx + 3, by + 4, bw, bh, 15);
    ctx.fill();
    ctx.restore();

    // Main comic bubble body + pointer tail (keeps gold styling for live/game commentary, no caption)
    ctx.fillStyle = isGameComment ? '#fffbeb' : '#faf8f2';
    ctx.strokeStyle = isGameComment ? '#d97706' : '#1e293b';
    ctx.lineWidth = isGameComment ? 2.8 : 2.4;

    roundRectPath(ctx, bx, by, bw, bh, 15);
    ctx.fill();
    ctx.stroke();

    // Pointer tail triangle seamlessly merged with bubble interior
    ctx.beginPath();
    ctx.moveTo(tailBaseLeft, by + bh - 1);
    ctx.quadraticCurveTo(tailBaseLeft + 2, tailTipY - 4, tailTipX, tailTipY);
    ctx.quadraticCurveTo(tailBaseRight - 1, tailTipY - 6, tailBaseRight, by + bh - 1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Cover inner border seam at tail join
    ctx.fillStyle = isGameComment ? '#fffbeb' : '#faf8f2';
    ctx.fillRect(tailBaseLeft + 1.5, by + bh - 4, tailBaseRight - tailBaseLeft - 3, 5);

    // Grandma avatar badge on the left inside the speech bubble
    ctx.save();
    const iconCx = bx + padX + iconSize * 0.5;
    const iconCy = by + bh * 0.5;
    const iconR = iconSize * 0.5;
    ctx.fillStyle = isGameComment ? '#fef3c7' : '#ede7d9';
    ctx.strokeStyle = isGameComment ? '#d97706' : '#94a3b8';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(iconCx, iconCy, iconR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.font = `${Math.round(iconSize * 0.66)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('👵', iconCx, iconCy + 1);
    ctx.restore();

    // Typewriter lines (vertically centered alongside the Grandma badge)
    const textBlockH = fullLines.length * lineH;
    const textOffsetY = Math.max(0, (contentH - textBlockH) * 0.5);
    const textStartX = bx + padX + iconSlotW;
    const textStartY = by + padY + textOffsetY + Math.round(fontSize * 0.88);
    ctx.font = fontStr;
    ctx.fillStyle = '#0f172a';
    for (let i = 0; i < visibleLines.length; i++) {
      ctx.fillText(visibleLines[i], textStartX, textStartY + i * lineH);
    }

    ctx.restore();
  }
}
