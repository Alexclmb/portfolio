// Thin wrapper around js/waves.js (the distortion-wave transition).
// Everything here degrades to "return false" so callers can fall back to a
// plain 200 ms fade when the module or WebGL is missing.
import { reducedMotion } from './util.js';

let wavesP = null;
let running = false;
let active = null;
let activeVT = null;

export const waveDebug = /[?&]wavedebug\b/.test(location.search);
/* `?wavedebug` timing marks for the caller's side of the setup. */
export function stamp() {
  const t0 = performance.now();
  const out = [];
  return {
    mark(label) { out.push([label, performance.now()]); },
    log(title) {
      if (!waveDebug) return;
      let prev = t0;
      console.log(`[wavedebug] ${title} (caller): ` + out.map(([l, t]) => { const s = `${l} +${(t - prev).toFixed(1)}ms`; prev = t; return s; }).join(' · '));
    },
  };
}

function getWaves() {
  if (!wavesP) {
    wavesP = import('./waves.js')
      .then(m => (typeof m.createWaves === 'function'
        ? m.createWaves({
            palette: [41, 98, 255],        // one accent: the band rides in Alex's blue
            dprCap: 1.5,                   // the front is soft anyway; caps texture size
            seeThroughAfterReveal: true,   // live DOM shows as soon as `to` is in place
          })
        : null))
      .catch(err => { console.info('[waves] unavailable, using fades:', err?.message || err); return null; });
  }
  return wavesP;
}

/* Load the module and build its WebGL context + programs at idle, so the
   first click only uploads two textures. */
export function preloadWaves() {
  const go = () => getWaves().then(w => w?.warm?.());
  'requestIdleCallback' in window ? requestIdleCallback(go, { timeout: 2500 }) : setTimeout(go, 1200);
}

/** Plays a wave. `onReveal` runs once `to` is fully on screen, which is the
 *  moment to swap the DOM underneath (the canvas turns see-through after it).
 *  Resolves true when the wave ran; false means the caller should fade. */
export async function wave({ from, to, origin, mode = 'vertical', speed = 1 }, onReveal) {
  if (!from || !to || reducedMotion()) return false;   // reduced motion: callers do a plain fade
  const w = await getWaves();
  if (!w || !w.supported) return false;
  finishWave();                       // a new action ends the previous run
  let p;
  try { p = w.play({ from, to, origin, mode, speed }); }
  catch (err) { console.info('[waves] play failed, falling back:', err?.message || err); return false; }
  track(p);
  try { await (p.revealed || p); }
  catch (err) { console.info('[waves] play failed, falling back:', err?.message || err); return false; }
  onReveal?.();
  return true;
}

function track(p) {
  active = p;
  running = true;
  Promise.resolve(p).catch(() => {}).finally(() => { if (active === p) { active = null; running = false; } });
}

/* Ends a running wave right away (user acted again mid-run). */
export function finishWave() {
  if (activeVT) { try { activeVT.skipTransition(); } catch (_) {} activeVT = null; }
  if (!active) return;
  try { active.finish?.(); } catch (_) {}
  active = null; running = false;
}

export const isWaving = () => running;

/* The theme wave: a colour-only front (no opaque fill, no distortion) on a
   compressed ~1 s timeline. The new theme is revealed behind the front with a
   View Transition whose clip circle follows the front's radius every frame;
   without View Transitions the theme flips as the front crosses mid-screen. */
const THEME_TUNING = {
  anticipation: 0.06, travel: 0.9, linger: -0.2, rimFade: 1.2,
  hairlineLinger: 0.15, hairlineFade: 0.85, particleCount: 0, particleLife: 0.4, strength: 0.8,
};
export async function themeWave(origin, apply) {
  finishWave();
  if (reducedMotion()) { apply(); return true; }
  const w = await getWaves();
  if (!w || !w.supported) return false;
  const opts = overlayOpts(origin);
  const root = document.documentElement;

  if (typeof document.startViewTransition === 'function') {
    // The transition is held open (CSS vt-hold, 4 s cap) and ended by hand the
    // frame the front has crossed the viewport, so it follows the wave's own
    // clock even when a frame runs long.
    const endVT = () => {
      for (const a of root.getAnimations({ subtree: true })) {
        if (a.effect?.pseudoElement?.startsWith('::view-transition')) { try { a.finish(); } catch (_) {} }
      }
    };
    root.style.setProperty('--vt-x', origin.x + 'px');
    root.style.setProperty('--vt-y', origin.y + 'px');
    root.style.setProperty('--vt-r', '0px');
    root.style.setProperty('--vt-hold', '4s');
    root.classList.add('theme-vt');
    let p = null;
    const vt = document.startViewTransition(() => {
      apply();
      p = w.play({
        ...opts,
        onMount: c => { c.style.viewTransitionName = 'theme-wave'; },
        onFrame: f => {
          root.style.setProperty('--vt-r', Math.max(0, f.r).toFixed(1) + 'px');
          if (f.revealed) endVT();
        },
      });
      Promise.resolve(p).then(endVT, endVT);
    });
    activeVT = vt;
    vt.finished.catch(() => {}).finally(() => {
      if (activeVT === vt) activeVT = null;
      root.classList.remove('theme-vt');
    });
    try { await vt.updateCallbackDone; } catch (_) { /* apply() already ran or will be skipped */ }
    if (p) track(p);
    return true;
  }

  let switched = false;
  const flip = () => { if (!switched) { switched = true; apply(); } };
  const mid = Math.hypot(innerWidth / 2 - origin.x, innerHeight / 2 - origin.y);
  const p = w.play({ ...opts, onFrame: f => { if (f.r >= mid) flip(); }, onRevealed: flip });
  track(p);
  return true;
}

/* The theme switch's colour-only overlay wave. One definition for both uses, so the
   window-open splash can never drift from the theme switch. */
function overlayOpts(origin) {
  return { from: 'transparent', to: 'transparent', origin, mode: 'center', overlay: true, tuning: THEME_TUNING };
}

/* Splash on opening a window (round 8, Alex: "match when switching light/dark"): the
   theme switch's wave exactly (same instance, options, ~1 s timeline), only its origin
   is the folder's mouth or the control. It starts with the genie and runs on over the
   landed window (pointer-events none). A new open or a close finishes it. Reduced
   motion: none. Never on close. */
export function splashWave(origin) {
  if (reducedMotion()) return;
  finishWave();
  getWaves().then(w => {
    if (!w || !w.supported) return;
    finishWave();
    try { track(w.play(overlayOpts(origin))); } catch (_) {}
  });
}

/* A viewport-sized canvas: a flat background plus one media element drawn at
   a given rect ('contain' or 'cover'). This is how a DOM state becomes a
   texture the wave can distort, without rasterising the DOM. Capped at 1.5x
   and never read back here (waves.js does the one taint check). */
export function frameCanvas(bg, media, rect, fit = 'cover') {
  const dpr = Math.min(1.5, devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.round(innerWidth * dpr);
  c.height = Math.round(innerHeight * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = bg;
  g.fillRect(0, 0, innerWidth, innerHeight);
  if (media && rect) {
    const sw = media.naturalWidth || media.videoWidth || media.width;
    const sh = media.naturalHeight || media.videoHeight || media.height;
    if (sw && sh) {
      let { left: dx, top: dy, width: dw, height: dh } = rect;
      let sx = 0, sy = 0, sW = sw, sH = sh;
      const rs = sw / sh, rd = dw / dh;
      if (fit === 'cover') {
        if (rs > rd) { sW = sh * rd; sx = (sw - sW) / 2; } else { sH = sw / rd; sy = (sh - sH) / 2; }
      } else {
        if (rs > rd) { const h = dw / rs; dy += (dh - h) / 2; dh = h; } else { const w = dh * rs; dx += (dw - w) / 2; dw = w; }
      }
      try { g.drawImage(media, sx, sy, sW, sH, dx, dy, dw, dh); } catch (_) { /* not decoded yet: background only */ }
    }
  }
  return c;
}

/* Resolved colours of the theme tokens, cached per theme (no style probe per click). */
const colorCache = new Map();
export function cssColor(varName) {
  const key = (document.documentElement.dataset.theme || '') + varName;
  if (colorCache.has(key)) return colorCache.get(key);
  const probe = document.createElement('i');
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${varName})`;
  document.documentElement.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  colorCache.set(key, c);
  return c;
}
