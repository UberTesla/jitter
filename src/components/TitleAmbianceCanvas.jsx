import React, { useEffect, useRef } from 'react';

const INTENSITY_MULTIPLIER = {
  low: 0.5,
  medium: 1.0,
  high: 1.65,
};

const LEAF_PALETTE = ['#ea580c', '#d97706', '#f59e0b', '#b91c1c', '#9a3412', '#fbbf24'];
const PETAL_PALETTE = ['#fbcfe8', '#f9a8d4', '#f472b6', '#fdf2f8', '#fecdd3'];
const CONFETTI_PALETTE = ['#fbbf24', '#38bdf8', '#34d399', '#fb7185', '#c084fc', '#f8fafc'];

function createParticle(effect, w, h, randomY = true) {
  const x = Math.random() * w;
  const y = randomY ? Math.random() * h : effect === 'embers' ? h + 16 : -24;

  switch (effect) {
    case 'leaves':
      return {
        x,
        y,
        size: 10 + Math.random() * 14,
        vy: 36 + Math.random() * 48,
        vx: -18 + Math.random() * 44,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 2.2,
        swayPhase: Math.random() * Math.PI * 2,
        swayFreq: 1.1 + Math.random() * 1.4,
        swayAmp: 26 + Math.random() * 42,
        flipPhase: Math.random() * Math.PI * 2,
        color: LEAF_PALETTE[Math.floor(Math.random() * LEAF_PALETTE.length)],
        alpha: 0.58 + Math.random() * 0.36,
      };
    case 'snow':
      return {
        x,
        y,
        size: 2 + Math.random() * 5.2,
        vy: 28 + Math.random() * 55,
        vx: -12 + Math.random() * 24,
        swayPhase: Math.random() * Math.PI * 2,
        swayFreq: 0.9 + Math.random() * 1.2,
        swayAmp: 12 + Math.random() * 24,
        crystalline: Math.random() < 0.24,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.9,
        alpha: 0.38 + Math.random() * 0.54,
      };
    case 'rain':
      return {
        x,
        y,
        length: 18 + Math.random() * 28,
        vy: 560 + Math.random() * 380,
        vx: -95 - Math.random() * 45,
        width: 1 + Math.random() * 1.2,
        alpha: 0.16 + Math.random() * 0.28,
      };
    case 'embers':
      return {
        x,
        y,
        size: 1.8 + Math.random() * 4.0,
        vy: -(40 + Math.random() * 75),
        vx: (Math.random() - 0.5) * 26,
        swayPhase: Math.random() * Math.PI * 2,
        swayFreq: 1.6 + Math.random() * 2.0,
        swayAmp: 16 + Math.random() * 32,
        flickerPhase: Math.random() * Math.PI * 2,
        hue: 16 + Math.random() * 32,
        alpha: 0.45 + Math.random() * 0.5,
      };
    case 'fireflies':
      return {
        x,
        y,
        size: 2.5 + Math.random() * 4.5,
        vx: (Math.random() - 0.5) * 24,
        vy: (Math.random() - 0.5) * 18,
        pulsePhase: Math.random() * Math.PI * 2,
        pulseSpeed: 1.2 + Math.random() * 2.2,
        warm: Math.random() < 0.72,
      };
    case 'petals':
      return {
        x,
        y,
        size: 6 + Math.random() * 9,
        vy: 30 + Math.random() * 42,
        vx: 22 + Math.random() * 36,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 2.4,
        swayPhase: Math.random() * Math.PI * 2,
        swayFreq: 1.3 + Math.random() * 1.3,
        swayAmp: 22 + Math.random() * 34,
        color: PETAL_PALETTE[Math.floor(Math.random() * PETAL_PALETTE.length)],
        alpha: 0.55 + Math.random() * 0.38,
      };
    case 'confetti':
      return {
        x,
        y,
        w: 6 + Math.random() * 8,
        h: 4 + Math.random() * 5,
        vy: 58 + Math.random() * 85,
        vx: (Math.random() - 0.5) * 35,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 5.2,
        tiltPhase: Math.random() * Math.PI * 2,
        tiltSpeed: 3 + Math.random() * 4,
        color: CONFETTI_PALETTE[Math.floor(Math.random() * CONFETTI_PALETTE.length)],
        alpha: 0.7 + Math.random() * 0.28,
      };
    default:
      return null;
  }
}

function getBaseCount(effect) {
  switch (effect) {
    case 'leaves':
      return 34;
    case 'snow':
      return 78;
    case 'rain':
      return 115;
    case 'embers':
      return 52;
    case 'fireflies':
      return 42;
    case 'petals':
      return 48;
    case 'confetti':
      return 64;
    default:
      return 0;
  }
}

function drawLeaf(ctx, p, t) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);
  const flip = 0.35 + 0.65 * Math.abs(Math.cos(t * 1.8 + p.flipPhase));
  ctx.scale(1, flip);
  ctx.globalAlpha = p.alpha;
  ctx.fillStyle = p.color;

  const s = p.size;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.bezierCurveTo(s * 0.9, -s * 0.5, s * 0.85, s * 0.45, 0, s * 0.85);
  ctx.bezierCurveTo(-s * 0.85, s * 0.45, -s * 0.9, -s * 0.5, 0, -s);
  ctx.closePath();
  ctx.fill();

  // Central leaf vein & stem
  ctx.strokeStyle = 'rgba(40, 14, 4, 0.42)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.72);
  ctx.lineTo(0, s * 1.12);
  ctx.stroke();
  ctx.restore();
}

function drawSnowflake(ctx, p) {
  ctx.save();
  ctx.globalAlpha = p.alpha;
  if (p.crystalline && p.size >= 4) {
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.strokeStyle = '#e0f2fe';
    ctx.lineWidth = 1.15;
    const r = p.size * 1.35;
    for (let i = 0; i < 3; i++) {
      ctx.rotate(Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.lineTo(r, 0);
      ctx.stroke();
    }
  } else {
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 1.5);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    grad.addColorStop(1, 'rgba(224, 242, 254, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPetal(ctx, p, t) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);
  ctx.scale(1, 0.45 + 0.55 * Math.abs(Math.sin(t * 2 + p.swayPhase)));
  ctx.globalAlpha = p.alpha;
  ctx.fillStyle = p.color;
  const s = p.size;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.quadraticCurveTo(s * 0.9, -s * 0.2, 0, s);
  ctx.quadraticCurveTo(-s * 0.9, -s * 0.2, 0, -s);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * 60fps Configurable Title Screen Ambiance Canvas
 * Renders falling leaves, snow, rain, hearth embers, fireflies, cherry blossoms, or confetti.
 */
export default function TitleAmbianceCanvas({ effect = 'none', intensity = 'medium' }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!effect || effect === 'none') return undefined;
    if (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return undefined;
    }

    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let width = 1600;
    let height = 900;
    const mult = INTENSITY_MULTIPLIER[intensity] || 1.0;
    const targetCount = Math.max(8, Math.round(getBaseCount(effect) * mult));
    let particles = [];

    const resize = () => {
      const parent = canvas.parentElement;
      const w = parent ? parent.clientWidth : 1600;
      const h = parent ? parent.clientHeight : 900;
      if (!w || !h) return;
      width = w;
      height = h;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    particles = Array.from({ length: targetCount }, () =>
      createParticle(effect, width, height, true)
    ).filter(Boolean);

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (ro && canvas.parentElement) ro.observe(canvas.parentElement);

    let rafId = null;
    let lastNow = performance.now();
    const startNow = lastNow;

    const tick = (now) => {
      const dt = Math.min(0.06, (now - lastNow) / 1000);
      lastNow = now;
      const t = (now - startNow) / 1000;

      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        if (effect === 'leaves') {
          p.y += p.vy * dt;
          p.x += (p.vx + Math.sin(t * p.swayFreq + p.swayPhase) * p.swayAmp) * dt;
          p.angle += p.spin * dt;
          if (p.y > height + 30 || p.x < -40 || p.x > width + 40) {
            particles[i] = createParticle('leaves', width, height, false);
          }
          drawLeaf(ctx, p, t);
        } else if (effect === 'snow') {
          p.y += p.vy * dt;
          p.x += (p.vx + Math.sin(t * p.swayFreq + p.swayPhase) * p.swayAmp) * dt;
          p.angle += p.spin * dt;
          if (p.y > height + 20) {
            particles[i] = createParticle('snow', width, height, false);
          } else if (p.x < -15) p.x = width + 15;
          else if (p.x > width + 15) p.x = -15;
          drawSnowflake(ctx, p);
        } else if (effect === 'rain') {
          p.y += p.vy * dt;
          p.x += p.vx * dt;
          if (p.y > height + 30 || p.x < -40) {
            particles[i] = createParticle('rain', width, height, false);
            particles[i].x = Math.random() * (width + 220);
          }
          ctx.save();
          ctx.strokeStyle = `rgba(186, 230, 253, ${p.alpha.toFixed(3)})`;
          ctx.lineWidth = p.width;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.032, p.y - p.length);
          ctx.stroke();
          ctx.restore();
        } else if (effect === 'embers') {
          p.y += p.vy * dt;
          p.x += (p.vx + Math.sin(t * p.swayFreq + p.swayPhase) * p.swayAmp) * dt;
          const heightFade = Math.max(0, Math.min(1, p.y / (height * 0.85)));
          const flicker = 0.65 + 0.35 * Math.sin(t * 7 + p.flickerPhase);
          const a = p.alpha * heightFade * flicker;
          if (p.y < -20) {
            particles[i] = createParticle('embers', width, height, false);
          }
          ctx.save();
          const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3.2);
          grad.addColorStop(0, `hsla(${p.hue}, 100%, 72%, ${a.toFixed(3)})`);
          grad.addColorStop(0.5, `hsla(${p.hue - 8}, 95%, 52%, ${(a * 0.45).toFixed(3)})`);
          grad.addColorStop(1, 'rgba(255, 100, 0, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else if (effect === 'fireflies') {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.x < -20) p.x = width + 20;
          if (p.x > width + 20) p.x = -20;
          if (p.y < -20) p.y = height + 20;
          if (p.y > height + 20) p.y = -20;
          const glow = 0.2 + 0.8 * (0.5 + 0.5 * Math.sin(t * p.pulseSpeed + p.pulsePhase));
          ctx.save();
          const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3.6);
          if (p.warm) {
            grad.addColorStop(0, `rgba(254, 240, 138, ${(glow * 0.9).toFixed(3)})`);
            grad.addColorStop(0.45, `rgba(245, 158, 11, ${(glow * 0.35).toFixed(3)})`);
          } else {
            grad.addColorStop(0, `rgba(186, 230, 253, ${(glow * 0.85).toFixed(3)})`);
            grad.addColorStop(0.45, `rgba(56, 189, 248, ${(glow * 0.32).toFixed(3)})`);
          }
          grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 3.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else if (effect === 'petals') {
          p.y += p.vy * dt;
          p.x += (p.vx + Math.sin(t * p.swayFreq + p.swayPhase) * p.swayAmp) * dt;
          p.angle += p.spin * dt;
          if (p.y > height + 24 || p.x > width + 30) {
            particles[i] = createParticle('petals', width, height, false);
            if (Math.random() < 0.35) {
              particles[i].x = -15;
              particles[i].y = Math.random() * height * 0.65;
            }
          }
          drawPetal(ctx, p, t);
        } else if (effect === 'confetti') {
          p.y += p.vy * dt;
          p.x += (p.vx + Math.sin(t * 2 + p.tiltPhase) * 20) * dt;
          p.angle += p.spin * dt;
          if (p.y > height + 24) {
            particles[i] = createParticle('confetti', width, height, false);
          }
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle);
          ctx.scale(1, Math.cos(t * p.tiltSpeed + p.tiltPhase));
          ctx.globalAlpha = p.alpha;
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.w * 0.5, -p.h * 0.5, p.w, p.h);
          ctx.restore();
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (ro) ro.disconnect();
    };
  }, [effect, intensity]);

  if (!effect || effect === 'none') return null;

  return <canvas ref={canvasRef} className="title-ambiance-canvas" aria-hidden="true" />;
}
