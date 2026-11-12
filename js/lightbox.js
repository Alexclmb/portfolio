// Lightbox. Opening is a shared-element zoom: the picture grows out of the
// tile it came from on the same frame as the click, using the tile's already
// loaded file, and the full-size file is swapped in once it has decoded (same
// box, so no flash and no shift). Close zooms back into the tile when it is
// still on screen. Transform + opacity only; every animation is interruptible.
import { cdnAt, cdnPoster, isVideo, reducedMotion, holdMedia } from './util.js';
import { DUR, EASE as M } from './motion.js';

const $ = id => document.getElementById(id);
const lb = $('lb'), back = $('lbBack'), stage = $('lbStage'), ui = $('lbUi'), cap = $('lbCap');

const EASE = M.out;
const OPEN_MS = DUR.base + 20, CLOSE_MS = DUR.base - 20, STEP_MS = 170;   // zooms: base ±20; steps sit between fast and base
const debug = /[?&]wavedebug\b/.test(location.search);

let list = [], idx = 0, media = null, source = null, returnFocus = null;
let anims = [];
let hooks = {};

export function initLightbox(h) {
  hooks = h;
  $('lbClose').addEventListener('click', close);
  $('lbPrev').addEventListener('click', () => step(-1));
  $('lbNext').addEventListener('click', () => step(1));
  stage.addEventListener('click', e => { if (e.target === stage) close(); });
  cap.addEventListener('click', e => {
    const a = e.target.closest('a[data-to]');
    if (!a) return;
    e.preventDefault();
    const to = a.dataset.to;
    close();
    hooks.navigate?.(to);
  });
  addEventListener('keydown', e => {
    if (lb.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); step(-1); }
    else if (e.key === 'Tab') trapFocus(e);
  }, true);
  let sx = null;
  lb.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') sx = e.clientX; });
  lb.addEventListener('pointerup', e => {
    if (sx == null) return;
    const d = e.clientX - sx; sx = null;
    if (Math.abs(d) > 50) step(d < 0 ? 1 : -1);
  });
  addEventListener('resize', () => { if (!lb.hidden && media) size(media, list[idx]); });
}

export const isOpen = () => !lb.hidden;

function trapFocus(e) {
  const f = [...lb.querySelectorAll('button, a[href]')].filter(el => !el.hidden && el.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* Where an item of aspect `ratio` sits (mirrors .lb-stage padding). */
function targetRect(ratio) {
  const mobile = innerWidth <= 768;
  const p = mobile ? { t: 52, r: 12, b: 76, l: 12 } : { t: 56, r: 88, b: 64, l: 88 };
  const bw = innerWidth - p.l - p.r, bh = innerHeight - p.t - p.b;
  let w = bw, h = w / ratio;
  if (h > bh) { h = bh; w = h * ratio; }
  return { left: p.l + (bw - w) / 2, top: p.t + (bh - h) / 2, width: w, height: h };
}
function size(el, it) {
  const r = targetRect(it.ratio || 4 / 3);
  el.style.width = Math.round(r.width) + 'px';
  el.style.height = Math.round(r.height) + 'px';
}

/* transform that makes an element whose box is `box` appear at `r` */
const tf = (box, r) => `translate(${r.left - box.left}px, ${r.top - box.top}px) scale(${r.width / box.width}, ${r.height / box.height})`;
/* The visual rect of a strip picture: for a folded (sliced) tile, the union of its slices. */
function rectOf(el) {
  const tile = el?.closest?.('.tile');
  if (tile?.classList.contains('is-sliced')) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    tile.querySelectorAll('.slice').forEach(s => {
      if (s.style.visibility === 'hidden') return;
      const q = s.getBoundingClientRect();
      l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    });
    if (r > l) return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
  }
  return el?.getBoundingClientRect?.();
}
const onScreen = r => r && r.width > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;

function stop() {
  for (const a of anims) { try { a.cancel(); } catch (_) {} }
  anims = [];
}
function play(el, frames, opts) {
  const a = el.animate(frames, { fill: 'both', ...opts });
  anims.push(a);
  return a;
}

/* The lightbox element for an item. `ph` is a loaded element to show while
   the full file decodes (the tile's own <img>, or a video poster). */
function makeMedia(it, ph) {
  let el;
  if (isVideo(it.url)) {
    el = document.createElement('video');
    el.muted = true; el.loop = true; el.playsInline = true; el.autoplay = !reducedMotion();
    el.setAttribute('muted', ''); el.setAttribute('playsinline', '');
    el.crossOrigin = 'anonymous';
    el.poster = (ph && ph.poster) || cdnPoster(it.url, 1200);
    el.preload = 'auto';
    el.src = cdnAt(it.url, 1600);
  } else {
    el = new Image();
    el.alt = it.title || '';
    el.decoding = 'sync';
    el.src = ph && ph.currentSrc ? ph.currentSrc : cdnAt(it.url, 1200);
    const full = new Image();
    full.src = cdnAt(it.url, 2200);
    full.decode().then(() => { if (el.isConnected) el.src = full.src; }).catch(() => {});
  }
  el.draggable = false;
  if (!(ph && (ph.naturalWidth || ph.readyState >= 2))) holdMedia(el);   // nothing decoded to show yet: the placeholder with his mark (static)
  size(el, it);
  return el;
}

function caption(it) {
  cap.innerHTML = it.route
    ? `<a href="${it.route}" data-to="${it.route}">${it.caption} →</a>`
    : it.caption || '';
  const one = list.length < 2;
  $('lbPrev').hidden = one; $('lbNext').hidden = one;
}

function lift(el, on) { el?.parentElement?.classList.toggle('is-lifted', on); }

/**
 * @param items [{url, ratio, title, caption(html), route, thumb()}]
 * @param i     start index
 * @param from  { el: the clicked media element } (optional)
 */
export function open(items, i, from = {}) {
  const t0 = performance.now();
  stop();
  if (source) lift(source, false);
  list = items; idx = i;
  const it = list[idx];
  returnFocus = lb.hidden ? document.activeElement : returnFocus;
  source = from.el || null;
  stage.textContent = '';
  media = makeMedia(it, source);
  stage.appendChild(media);
  caption(it);
  lb.hidden = false;
  hooks.onOpen?.();
  const box = media.getBoundingClientRect();
  const fromRect = rectOf(source);
  const rm = reducedMotion();
  if (!rm && onScreen(fromRect)) {
    lift(source, true);
    play(media, [{ transform: tf(box, fromRect) }, { transform: 'none' }], { duration: OPEN_MS, easing: EASE });
  } else if (!rm) {
    play(media, [{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE });
  }
  if (!rm) {
    play(back, [{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: EASE });
    play(ui, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 90, easing: 'ease-out' });
  }
  if (debug) {
    const ref = anims[0];
    requestAnimationFrame(() => {
      const first = performance.now();
      const fin = ref ? ref.finished : Promise.resolve();
      fin.catch(() => {}).then(() => console.log(`[wavedebug] lightbox open: click→first frame ${(first - t0).toFixed(1)}ms · total ${(performance.now() - t0).toFixed(1)}ms (zoom ${OPEN_MS}ms)`));
    });
  }
  $('lbClose').focus({ preventScroll: true });
}

function step(d) {
  if (list.length < 2 || lb.hidden) return;
  stop();
  idx = (idx + d + list.length) % list.length;
  const it = list[idx];
  const old = media;
  const thumb = it.thumb?.();
  media = makeMedia(it, thumb && (thumb.complete || thumb.readyState >= 2) ? thumb : null);
  stage.appendChild(media);
  caption(it);
  if (source) { lift(source, false); source = null; }   // the stepped-to picture has its own tile
  source = thumb || null;
  if (reducedMotion()) { old?.remove(); return; }
  const dx = d > 0 ? 16 : -16;
  play(media, [{ opacity: 0, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'none' }], { duration: STEP_MS, easing: EASE });
  if (old) {
    old.style.pointerEvents = 'none';
    const a = old.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dx}px)` }], { duration: STEP_MS - 40, easing: 'ease-out', fill: 'forwards' });
    a.finished.catch(() => {}).then(() => old.remove());
  }
}

export function close() {
  if (lb.hidden) return;
  const it = list[idx];
  // read where the picture is right now (mid-animation included), then retarget
  const cur = media?.getBoundingClientRect();
  stop();
  stage.querySelectorAll('video').forEach(v => v.pause());
  [...stage.children].forEach(c => { if (c !== media) c.remove(); });
  const tile = source || it?.thumb?.();
  const toRect = rectOf(tile);
  const done = () => {
    lb.hidden = true;
    stage.textContent = '';
    lift(source, false); lift(tile, false);
    media = null; source = null;
    hooks.onClose?.();
  };
  returnFocus?.focus?.({ preventScroll: true });
  if (reducedMotion() || !media) { done(); return; }
  const layout = media.getBoundingClientRect();   // animations cancelled: this is the untransformed box
  let a;
  if (onScreen(toRect) && cur) {
    lift(tile, true);
    a = play(media, [{ transform: tf(layout, cur) }, { transform: tf(layout, toRect) }], { duration: CLOSE_MS, easing: EASE });
  } else {
    a = play(media, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' });
  }
  play(back, [{ opacity: getComputedStyle(back).opacity }, { opacity: 0 }], { duration: CLOSE_MS, easing: EASE });
  play(ui, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-out' });
  a.finished.then(done, () => {});   // cancelled = a newer open took over
}
