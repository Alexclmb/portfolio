// The window that hosts the case studies, the reviews and Start a project.
// Its design is Alex's own case-study modal (alexcolombel.com .detail-panel);
// on a desktop it can be moved by its title row and resized from any edge,
// never past the viewport. On a phone it is his bottom drawer.
// It opens out of what was clicked (folder icon, strip picture, link) and
// closes back into it with the Dock's genie (js/genie.js).
import { esc, isDesktop, mediaEl, ratioOf, watchVideo, reducedMotion } from './util.js';
import { wireProofs, closeProof, proofSrc } from './proof.js';
import { createGenie } from './genie.js';
import { splashWave, finishWave } from './transition.js';
import { icon } from './icons.js';
import { DUR, EASE } from './motion.js';

const $ = id => document.getElementById(id);
const layer = $('winLayer'), win = $('win'), body = $('winBody'), head = $('winBar');
const titleEl = $('winTitle'), scrim = $('winScrim'), content = $('winContent');
const DEV = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const DEBUG = /[?&]wavedebug\b/.test(location.search);   // read at load: routes drop the query

/* The copies the genie warps are made lighter than the live window: no blur
   layers (a backdrop-filter per strip is the costliest thing on a real GPU),
   media outside the visible part of the scroll removed (their boxes keep their
   size), videos replaced by their poster. Same look on screen, a fraction of the raster. */
function lighten(tpl, el) {
  tpl.querySelectorAll('.dh-veil').forEach(n => n.remove());
  const head = tpl.querySelector('.win-head');
  if (head) head.style.background = getComputedStyle(el).backgroundColor;
  const view = el.querySelector('.win-body')?.getBoundingClientRect();
  const src = [...el.querySelectorAll('.db-media')], copies = [...tpl.querySelectorAll('.db-media')];
  src.forEach((m, i) => {
    const r = m.getBoundingClientRect(), c = copies[i];
    if (!c) return;
    if (!view || r.bottom < view.top || r.top > view.bottom) { c.replaceChildren(); return; }
    c.querySelectorAll('video').forEach(v => {
      const img = document.createElement('img');
      img.src = v.poster || ''; img.className = 'is-ready';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
      v.replaceWith(img);
    });
  });
  tpl.querySelectorAll('video').forEach(v => v.remove());
  // the copies show the pictures that are already decoded (before, every copy kept them at
  // opacity 0: no load handler on a clone, so they popped in on the landing frame)
  const live = [...el.querySelectorAll('img')], copies2 = [...tpl.querySelectorAll('img')];
  copies2.forEach(i => {
    const s = live.find(l => l.src === i.src);
    if (s && s.complete && s.naturalWidth) { i.classList.add('is-ready'); i.style.transition = 'none'; }
    else i.removeAttribute('src');   // not decoded yet: no copy loads or decodes it mid-run (a 20-40 ms frame on a cold open)
  });
}
/* ?genie=<ms> dial (open); close scales with it. Round 8: 400 / 340 (the Dock's 500 felt long to Alex) */
const GENIE_MS = +((location.search.match(/[?&]genie=(\d+)/) || [])[1] || 400);
const CLOSE_MS = Math.round(GENIE_MS * .85);
// zIndex 2: the copies sit between a folder's back (1) and its front flap (3) inside the window layer
const genie = createGenie({ pointScale: 1, prepare: lighten, debug: DEBUG, shadow: false, openMs: GENIE_MS, closeMs: CLOSE_MS, zIndex: 2 });
window.__genie = genie;   // dev: slow motion with __genie.speed = .1

let hooks = {};
let geom = null;              // {x, y, w} on desktop; the height always hugs the content
let hUser = Infinity;         // a height the visitor chose (n/s resize, zoom); never more than the content
let zoomed = null;
let returnFocus = null, returnFallback = null;
let source = null;            // what the window grew out of: re-measured at close (the strip moves)
let sourceRect = null;        // its rect at open (the close target when the control no longer exists)
let run = null;               // the genie run in flight
let sheetAnim = null;
let state = 'closed';
let moved = false;           // the visitor dragged or resized: stop re-centring         // closed | opening | open | closing

const EDGE_M = 10;            // a window never gets closer than this to the viewport edge
const OPEN_M = 40;            // his .detail-overlay padding: 40 px above and below
const MIN_W = 360, MIN_H = 200;
/* his panel is 720; here the project window is larger (≈760 at 1024 wide → 904 at 1440 → 960 from 1600), his paddings and text measure kept */
/* Alex asked for the project window back at his panel's own size (720): smaller, and lighter for the genie */
const WIDTH = { case: 720, words: 720, form: 560 };

const vw = () => document.documentElement.clientWidth, vh = () => innerHeight;

/* The content's own height: header plus content box (layout boxes, so a
   transform mid-animation does not distort it). */
const naturalHeight = () => content.offsetTop + content.offsetHeight;
const maxH = () => Math.min(hUser, vh() - 2 * EDGE_M);
/* The folder row along the bottom is the window's Dock: a window that has not
   been resized by hand stops above it, so the folder it pours into stays in view. */
function floor() {
  let top = vh() - OPEN_M;
  if (isDesktop()) document.querySelectorAll('#folders .folder-icon').forEach(f => { const r = f.getBoundingClientRect(); if (r.height) top = Math.min(top, r.top - 24); });
  return top;
}
/* Round 8: an untouched window ends above the folder row (the Dock), never
   over it. Before, the bottom 90 px of a project window overlapped the row, were
   clipped away during the pour and appeared all at once on the landing frame. */
function bottomEdge() {
  const f = floor();
  return f - OPEN_M >= 420 ? f : vh() - OPEN_M;
}
const room = () => bottomEdge() - OPEN_M;
function heightNow() {
  const cap = hUser === Infinity && !zoomed ? room() : maxH();
  return Math.min(naturalHeight(), cap, vh() - 2 * EDGE_M);
}

function clampGeom(g, h) {
  g.w = Math.max(Math.min(MIN_W, vw() - 2 * EDGE_M), Math.min(g.w, vw() - 2 * EDGE_M));
  g.x = Math.max(EDGE_M, Math.min(g.x, vw() - g.w - EDGE_M));
  g.y = Math.max(EDGE_M, Math.min(g.y, vh() - h - EDGE_M));
  return g;
}
function applyGeom() {
  if (!isDesktop() || !geom) { win.removeAttribute('style'); return; }
  win.style.width = geom.w + 'px';
  const h = Math.round(heightNow());
  clampGeom(geom, h);
  win.style.width = geom.w + 'px';
  win.style.left = geom.x + 'px';
  win.style.top = geom.y + 'px';
  win.style.height = h + 'px';
}

/* Centred in the viewport (true centre); a window taller than the room pins to the 40 px margins. */
function recentre() {
  if (!geom) return;
  geom.w = Math.min(geom.w, vw() - 2 * OPEN_M);
  const h = Math.min(naturalHeight(), room());
  geom.x = (vw() - geom.w) / 2;
  geom.y = OPEN_M + Math.max(0, (room() - h) / 2);
}
/* First placement: centred like his overlay. */
function placeFor(kind, src) {
  const w = Math.min(WIDTH[kind] || 720, vw() - 2 * OPEN_M);
  geom = { x: (vw() - w) / 2, y: OPEN_M, w };
  win.style.width = w + 'px';
  const h = Math.min(naturalHeight(), room());
  geom.y = OPEN_M + Math.max(0, (room() - h) / 2);
  // centred like his overlay; the folder it pours from may lie under it (covered by the scrim once landed)
}

export function initWindows(h) {
  hooks = h;
  const close = () => hooks.requestClose?.();
  $('winClose').addEventListener('click', close);
  $('winCloseBead').addEventListener('click', close);
  $('winMin').addEventListener('click', close);   // minimise = the same genie, back into its source
  $('winZoom').addEventListener('click', () => toggleZoom());
  head.addEventListener('dblclick', e => { if (!e.target.closest('button, a') && document.documentElement.dataset.chrome === 'beads') toggleZoom(); });
  const activity = () => win.classList.toggle('is-inactive', !document.hasFocus());
  addEventListener('focus', activity); addEventListener('blur', activity);
  scrim.addEventListener('click', close);
  addEventListener('keydown', e => {
    if (layer.hidden || state === 'closing') return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') trapFocus(e);
  });
  // the live window is usable on the landing frame: any input during the open lands it at once
  ['pointerdown', 'wheel'].forEach(t => layer.addEventListener(t, () => { if (state === 'opening') run?.finish?.(); }, { capture: true, passive: true }));
  addEventListener('keydown', e => { if (state === 'opening' && e.key !== 'Escape') run?.finish?.(); }, { capture: true });

  const refit = () => {
    if (!geom || layer.hidden) return;
    if (zoomed) { geom = { x: 24, y: 24, w: vw() - 48 }; hUser = vh() - 48; }
    else if (!moved) recentre();
    applyGeom();
    invariants('resize');
  };
  addEventListener('resize', refit);
  addEventListener('orientationchange', refit);
  new ResizeObserver(() => { if (!layer.hidden && state === 'open') { if (!moved && isDesktop()) recentre(); applyGeom(); } }).observe(content);

  // move by the title row
  head.addEventListener('pointerdown', e => {
    if (!isDesktop() || e.button !== 0 || e.target.closest('button, a') || state !== 'open') return;
    const sx = e.clientX - geom.x, sy = e.clientY - geom.y;
    win.classList.add('is-dragging'); moved = true;
    head.setPointerCapture(e.pointerId);
    let give = { x: 0, y: 0 };
    const move = ev => {
      const want = { x: ev.clientX - sx, y: ev.clientY - sy };
      geom.x = want.x; geom.y = want.y; applyGeom();
      give = { x: band(want.x - geom.x), y: band(want.y - geom.y) };
      win.style.translate = give.x || give.y ? `${give.x}px ${give.y}px` : '';
    };
    const up = () => {
      win.classList.remove('is-dragging');
      if (give.x || give.y) {
        win.style.translate = '';
        if (!reducedMotion()) win.animate([{ translate: `${give.x}px ${give.y}px` }, { translate: '0px 0px' }], { duration: DUR.pop, easing: EASE.spring });
        give = { x: 0, y: 0 };
      }
      head.removeEventListener('pointermove', move);
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => head.removeEventListener(t, up));
    };
    head.addEventListener('pointermove', move);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => head.addEventListener(t, up));
  });

  // resize from the 8 handles: no edge leaves the viewport, the opposite edge stays put
  win.querySelectorAll('.rz').forEach(hd => hd.addEventListener('pointerdown', e => {
    if (!isDesktop() || e.button !== 0 || state !== 'open') return;
    e.preventDefault();
    moved = true;
    const dir = hd.dataset.rz, s = { ...geom, h: win.offsetHeight, px: e.clientX, py: e.clientY };
    hd.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = ev.clientX - s.px, dy = ev.clientY - s.py;
      if (dir.includes('e')) geom.w = Math.max(MIN_W, Math.min(s.w + dx, vw() - EDGE_M - s.x));
      if (dir.includes('w')) { geom.w = Math.max(MIN_W, Math.min(s.w - dx, s.x + s.w - EDGE_M)); geom.x = s.x + s.w - geom.w; }
      if (dir.includes('s')) hUser = Math.max(MIN_H, Math.min(s.h + dy, vh() - EDGE_M - s.y));
      if (dir.includes('n')) { hUser = Math.max(MIN_H, Math.min(s.h - dy, s.y + s.h - EDGE_M)); geom.y = s.y + s.h - Math.min(hUser, naturalHeight()); }
      applyGeom();
    };
    const up = () => {
      hd.removeEventListener('pointermove', move);
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => hd.removeEventListener(t, up));
      invariants('resize-handle');
    };
    hd.addEventListener('pointermove', move);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => hd.addEventListener(t, up));
  }));
}
const band = over => Math.sign(over) * Math.min(12, Math.abs(over) * .18);

function trapFocus(e) {
  const f = [...win.querySelectorAll('a[href], button:not([disabled]), input:not([type="hidden"]):not([name="botcheck"]), textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetParent && !el.closest('[hidden]') && getComputedStyle(el).visibility !== 'hidden');
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (!win.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export const isOpen = () => !layer.hidden && state !== 'closing';

/* Rect of what opened the window; a folded strip tile is the union of its slices. */
function measure(elm) {
  if (!elm?.getBoundingClientRect || !elm.isConnected) return null;
  const tile = elm.closest?.('.tile');
  if (tile?.classList.contains('is-sliced')) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    tile.querySelectorAll('.slice').forEach(sl => {
      if (sl.style.visibility === 'hidden') return;
      const q = sl.getBoundingClientRect();
      l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    });
    if (r > l) return { left: l, top: t, width: r - l, height: b - t, x: l, y: t };
  }
  const q = elm.getBoundingClientRect();
  return { left: q.left, top: q.top, width: q.width, height: q.height, x: q.left, y: q.top };
}

/* Dev invariants: the window fits the viewport and its content; nothing transforms a real folder. */
function invariants(when) {
  if (!DEV) return;
  const bad = [];
  if (!layer.hidden && isDesktop() && state === 'open') {
    const r = win.getBoundingClientRect();
    if (r.left < EDGE_M - .5 || r.top < EDGE_M - .5 || r.right > vw() - EDGE_M + .5 || r.bottom > vh() - EDGE_M + .5) bad.push(`window off-screen ${[r.left, r.top, r.right, r.bottom].map(Math.round)}`);
    if (r.height > naturalHeight() + 2) bad.push(`window taller than its content (${Math.round(r.height)} > ${naturalHeight()})`);
  }
  document.querySelectorAll('.folder-icon').forEach(f => {
    const r = f.getBoundingClientRect();
    if (r.width > 120 || r.height > 120) bad.push(`folder ${f.closest('.folder')?.dataset.folder} drawn at ${Math.round(r.width)}×${Math.round(r.height)}`);
    if (f.style.transform || f.getAnimations().length) bad.push('a folder icon is being transformed');
  });
  if (bad.length) console.error(`[invariant:${when}] ` + bad.join(' · '));
  window.__invariants = (window.__invariants || 0) + bad.length;
}

/* Green bead: fill the viewport (24 px margin) and back. */
function toggleZoom() {
  if (!isDesktop() || layer.hidden || state !== 'open' || $('winZoom').disabled) return;
  const before = win.getBoundingClientRect();
  if (zoomed) { geom = zoomed.g; hUser = zoomed.h; zoomed = null; }
  else { zoomed = { g: { ...geom }, h: hUser }; geom = { x: 24, y: 24, w: vw() - 48 }; hUser = vh() - 48; }
  applyGeom();
  $('winZoom').setAttribute('aria-pressed', String(!!zoomed));
  if (reducedMotion()) return;
  const after = win.getBoundingClientRect();
  win.animate([
    { transformOrigin: '0 0', transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})` },
    { transformOrigin: '0 0', transform: 'none' }], { duration: DUR.base, easing: EASE.out });
}

/** Opens the window, or swaps its content when it is already open. */
export function openWindow({ title, sub = '', render, kind = 'case', from = null, fromRect = null, returnTo = null, fallbackFocus = null, fresh = false }) {
  if (state === 'closing') { run?.finish?.(); finishClose(); }   // a close still running: land it, then open fresh
  // a control inside the open window (Start a project in a case): the old window
  // goes at once and the new one pours out of that control, over the scrim already there
  const reopen = fresh && !layer.hidden && isDesktop() && !!fromRect;
  if (reopen) { if (state === 'opening') run?.finish?.(); state = 'open'; }
  const wasOpen = !layer.hidden && !reopen;
  if (!wasOpen && !reopen) { returnFocus = returnTo || document.activeElement; returnFallback = fallbackFocus; }
  titleEl.textContent = title;
  $('winSub').textContent = sub; $('winSub').hidden = !sub;
  win.dataset.kind = kind;
  closeProof();
  content.textContent = '';
  render(content);
  body.scrollTop = 0;
  const startEl = content.querySelector('[data-start]');
  $('winZoom').disabled = kind === 'form';
  if (!wasOpen) {
    hUser = Infinity; zoomed = null; moved = false; $('winZoom').setAttribute('aria-pressed', 'false');
    layer.hidden = false;
    win.style.visibility = '';
    source = from || returnTo || null;   // the genie's target: the folder icon (or the link that was clicked)
    const src = fromRect ? { ...fromRect, x: fromRect.left, y: fromRect.top } : measure(source);
    sourceRect = src;                    // fallback target for the close when the control is gone
    state = 'opening';
    // the final rect is decided here, before the first genie frame: fixed width,
    // height from the content (media boxes are reserved from content.json ratios)
    if (isDesktop()) placeFor(kind, src); else geom = null;
    applyGeom();
    // every window starts at the top. The reset above ran while the layer was still
    // display:none, where scrollTop cannot be set, so the last window's scroll offset
    // survived into this one: do it again now that the layer is laid out.
    body.scrollTop = 0;
    if (startEl) scrollToStart(startEl);
    hooks.onOpen?.();
    win.classList.toggle('is-inactive', !document.hasFocus());
    animateOpen(src, reopen);
  } else {
    if (isDesktop() && geom) { geom.w = Math.min(WIDTH[kind] || 720, vw() - 2 * OPEN_M); recentre(); applyGeom(); }
    if (startEl) scrollToStart(startEl);
  }
  (document.documentElement.dataset.chrome === 'beads' ? $('winCloseBead') : $('winClose')).focus({ preventScroll: true });
  if (DEBUG && window.__openT) {
    const t0 = window.__openT; window.__openT = 0;
    requestAnimationFrame(() => console.log(`[wavedebug] window open: click→first window frame ${(performance.now() - t0).toFixed(1)}ms`));
  }
}

/* The clicked picture sits right under the title row. */
function scrollToStart(el) {
  let y = 0, n = el;
  while (n && n !== body) { y += n.offsetTop; n = n.offsetParent; }
  body.scrollTop = Math.max(0, y - head.offsetHeight - 4);
}

/* The folder row runs along the bottom: that is the Dock, so the window pours
   straight down into it (springboard's edge 'bottom'). The top-row controls
   (Start a project, the stars) sit above the window: it pours up into them
   ('top'). Anything else uses the reference's 'auto' rule. */
function edgeFor(src, w) {
  if (src && src.top >= w.top + w.height - 1) return 'bottom';
  if (src && src.top + src.height <= w.top + 1) return 'top';
  return 'auto';
}

/* During a genie run: no backdrop blur anywhere (costly on a real GPU), no
   video decodes, and the home stops drawing. The folder row stays where it is
   (under the scrim): only the clicked folder is lifted, as the rig below. */
let heldVideos = [];
function genieOn(on) {
  document.documentElement.classList.toggle('is-genie', on);
  // no video decodes while the genie runs; the ones it paused resume after (not inside a closed window)
  if (on) { heldVideos = [...document.querySelectorAll('video')].filter(v => !v.paused); heldVideos.forEach(v => v.pause()); }
  else { heldVideos.forEach(v => { if (v.isConnected && !(layer.contains(v) && (state === 'closing' || layer.hidden))) v.play().catch(() => {}); }); heldVideos = []; }
  hooks.onGenie?.(on);
}

const fromFolder = () => !!source?.closest?.('.folder');

/* ── the folder as two layers, for the pour (round 8) ─────────────────────
   For the length of a run the clicked folder is drawn twice inside the window
   layer, at its exact spot: its BACK (body, tab, the pictures) under the genie
   copies (z 1) and its FRONT flap (with the sticker) over them (z 3); the copies
   are z 2. The real folder is hidden meanwhile (visibility only: its layout and
   transform are never touched). The window's neck ends in the MOUTH, the gap
   between back and flap, across the folder's inner width, so the end of the
   neck is seen inside the folder, in front of the back and behind the flap.
   The flap opens with the pour (no wait), a touch wider than on hover. */
const FLAP_OPEN = -48, FLAP_REST = -40;   // degrees; -40 is .folder.is-open
const easeOut = t => 1 - (1 - t) * (1 - t) * (1 - t);
const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
let rig = null;
function folderRig(icon) {
  const r = icon.getBoundingClientRect();
  const tf = getComputedStyle(icon.querySelector('.f-front')).transform;
  const m = new DOMMatrix(tf === 'none' ? undefined : tf);
  const a0 = Math.atan2(m.m23, m.m22) * 180 / Math.PI;    // where the real flap is now (hovered: about -40)
  const risen = a0 < -5;
  const make = (z, part) => {
    const wrap = document.createElement('span');
    wrap.className = 'folder genie-folder' + (part === 'front' || risen ? ' is-open' : '');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;min-width:0;display:block;margin:0;z-index:${z};pointer-events:none`;
    const ic = icon.cloneNode(true);
    ic.style.margin = '0'; ic.style.display = 'block';   // a flex item in the row; a plain block here
    if (part === 'back') ic.querySelector('.f-front').style.visibility = 'hidden';
    else { ic.querySelector('.f-back').style.visibility = 'hidden'; ic.querySelector('.docs').style.visibility = 'hidden'; }
    wrap.append(ic);
    layer.append(wrap);
    return wrap;
  };
  // the real folder, hidden under its copy, takes its open pose at once (no spring of its
  // own), so the cross-fade at the end of the open matches the copy exactly
  const real = icon.querySelectorAll('.f-front, .doc');
  real.forEach(n => { n.style.transition = 'none'; });
  const back = make(1, 'back'), front = make(3, 'front');
  if (!risen) requestAnimationFrame(() => back.classList.add('is-open'));   // the pictures rise as on hover
  const flap = front.querySelector('.f-front');
  flap.style.transition = 'none';
  const set = (angle, op) => {
    flap.style.transform = `rotateX(${angle.toFixed(2)}deg)`;
    const o = op >= 1 ? '' : op.toFixed(3);
    back.style.opacity = o; front.style.opacity = o;
    icon.style.visibility = op >= 1 ? 'hidden' : '';
  };
  set(a0, 1);
  const self = {
    // the mouth: inside the body's width, just under the opened flap's top edge
    mouth: { left: r.left + 9, top: r.top + 26, width: r.width - 18, height: 10, x: r.left + 9, y: r.top + 26 },
    floor: r.top + 40,           // nothing of the window is drawn below this line (it is behind the flap)
    // t: 0 → 1 through the open. The flap swings open over the first 20 % (with the pour,
    // no wait), stays open while the window leaves, eases to the resting -40 at the end;
    // the copy of the folder then cross-fades into the real one (open, under the scrim)
    open(t) {
      const a = t < .2 ? a0 + (FLAP_OPEN - a0) * easeOut(t / .2) : t < .6 ? FLAP_OPEN : t < .85 ? FLAP_OPEN + (FLAP_REST - FLAP_OPEN) * easeInOut((t - .6) / .25) : FLAP_REST;
      set(a, t < .85 ? 1 : 1 - (t - .85) / .15);
    },
    // c: 0 → 1 through the close. The lifted copy fades in over the real folder and the
    // flap opens wider over the first 20 %; it stays open while the window pours in
    close(c) {
      set(c < .2 ? FLAP_REST + (FLAP_OPEN - FLAP_REST) * easeOut(c / .2) : FLAP_OPEN, Math.min(1, c / .2));
    },
    // after the close: the flap shuts with a small settle, then the real folder takes over
    settle() {
      if (reducedMotion()) { self.dispose(true); return Promise.resolve(); }
      set(FLAP_OPEN, 1);
      for (const w of [back, front]) { w.style.zIndex = 'var(--z-dock)'; document.body.append(w); }   // the window layer is hidden by now
      back.classList.remove('is-open');   // the pictures drop back in (their own 180 ms)
      const a = flap.animate([
        { transform: `rotateX(${FLAP_OPEN}deg)` },
        { transform: 'rotateX(4deg)', offset: .7, easing: 'ease-out' },
        { transform: 'rotateX(0deg)' }], { duration: 220, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' });
      return a.finished.catch(() => {}).then(() => self.dispose(true));
    },
    dispose(closed) {
      if (closed) {   // the real folder shuts without its own transition (it was hidden while the copy shut)
        const f = icon.closest('.folder');
        f?.querySelectorAll('.f-front, .doc').forEach(n => { n.style.transition = 'none'; });
        f?.classList.remove('is-open');
        void icon.offsetWidth;
        f?.querySelectorAll('.f-front, .doc').forEach(n => { n.style.transition = ''; });
      }
      void icon.offsetWidth;
      real.forEach(n => { n.style.transition = ''; });
      icon.style.visibility = '';
      back.remove(); front.remove();
      if (rig === self) rig = null;
    },
  };
  return self;
}

/* The colour splash: the theme switch's own wave (transition.js), from the control or
   the folder's mouth, started with the pour. Never on close. */
const SPLASH = !/[?&]splash=0\b/.test(location.search);   // test dial: ?splash=0 for frame stats without it
function splashFrom(r) { if (SPLASH) splashWave({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); }

/* Once a window has landed the folder row fades out (his backdrop, matched in tokens,
   still let it read through); it comes back as the close starts. */
function opened() { if (state === 'opening') { state = 'open'; applyGeom(); document.documentElement.classList.add('win-rest'); invariants('open'); } }

/* The window's final rect was fixed before the run; the live element replaces
   the copies on the landing frame. The shadow comes back over 150 ms (css
   .win transition); nothing moves. `?wavedebug` checks both. */
function landed(target) {
  win.classList.remove('is-bare');
  if (!DEBUG) return;
  const r0 = win.getBoundingClientRect();
  const d = Math.max(Math.abs(r0.left - target.x), Math.abs(r0.top - target.y), Math.abs(r0.width - target.width), Math.abs(r0.height - target.height));
  let moved1 = 0;
  const t0 = performance.now();
  const f = () => {
    if (layer.hidden || state !== 'open') return;
    const r = win.getBoundingClientRect();
    moved1 = Math.max(moved1, Math.abs(r.left - r0.left), Math.abs(r.top - r0.top), Math.abs(r.width - r0.width), Math.abs(r.height - r0.height));
    if (performance.now() - t0 < 1000) requestAnimationFrame(f);
    else console.log(`[wavedebug] landing: live rect vs genie target Δ ${d.toFixed(2)} px · window rect change in the 1 s after landing ${moved1.toFixed(2)} px (${[r0.left, r0.top, r0.width, r0.height].map(v => +v.toFixed(2)).join(', ')})`);
  };
  requestAnimationFrame(f);
}

function animateOpen(src, reopen = false) {
  scrim.getAnimations().forEach(a => a.cancel());
  const rm = reducedMotion();
  if (!isDesktop()) {   // his drawer: slides up from the bottom edge
    if (rm) { opened(); return; }
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: 'ease' });
    sheetAnim = win.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.32, .72, 0, 1)' });
    sheetAnim.finished.then(opened, () => {});
    return;
  }
  const pour = src && src.width;
  if (!rm && !reopen) scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: pour ? GENIE_MS : 280, easing: pour ? 'linear' : 'ease' });   // full on the landing frame
  if (pour) {
    const r = win.getBoundingClientRect();
    const target = { x: r.left, y: r.top, width: r.width, height: r.height };
    if (rig) rig.dispose(false);
    const icon = fromFolder() && !rm ? source.closest('.folder').querySelector('.folder-icon') : null;
    if (icon) rig = folderRig(icon);
    const from = rig ? rig.mouth : src;
    const mine = rig;
    genie.config.onFrame = mine ? ({ p }) => mine.open(1 - p) : null;
    win.classList.add('is-bare');
    genieOn(true);
    run = genie.open({ el: win, from, to: target, edge: edgeFor(from, r), floorY: mine ? mine.floor : undefined });
    if (DEV) window.__winRun = run;
    if (!rm) splashFrom(from);
    run.then(res => {
      if (res.interrupted) return;   // reversed into a close: the close keeps the rig
      mine?.dispose(false);
      genieOn(false); landed(target); opened();
    });
  } else if (!rm) {   // a deep link has no source: his own modal entrance (.detail-panel)
    win.animate([{ opacity: 0, transform: 'scale(.96) translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 350, easing: 'cubic-bezier(.22, .61, .36, 1)' })
      .finished.then(opened, () => {});
  } else opened();
}

function finishClose() {
  if (layer.hidden) return;
  state = 'closed';
  document.documentElement.classList.remove('win-rest');
  layer.hidden = true;
  win.style.visibility = '';
  win.classList.remove('is-bare');
  scrim.getAnimations().forEach(a => a.cancel());
  content.textContent = '';
  run = null;
  hooks.onClose?.();
  const r = returnFocus?.getBoundingClientRect?.();
  const visible = r && r.width && r.right > 0 && r.left < innerWidth;
  (visible ? returnFocus : returnFallback || returnFocus)?.focus?.({ preventScroll: true });
  invariants('close');
}

export function closeWindow() {
  if (layer.hidden || state === 'closing') return Promise.resolve();
  closeProof();
  content.querySelectorAll('video').forEach(v => v.pause());
  const wasOpening = state === 'opening';
  state = 'closing';
  finishWave();                                             // no splash runs on into a close
  document.documentElement.classList.remove('win-rest');    // the folder row comes back as the close starts
  const rm = reducedMotion();
  const fadeScrim = ms => { if (!rm) scrim.animate([{ opacity: getComputedStyle(scrim).opacity }, { opacity: 0 }], { duration: ms, easing: 'ease-in', fill: 'forwards' }); };
  if (!isDesktop()) {
    if (rm) { finishClose(); return Promise.resolve(); }
    sheetAnim?.cancel();
    fadeScrim(240);
    const a = win.animate([{ transform: 'none' }, { transform: 'translateY(100%)' }], { duration: 300, easing: 'cubic-bezier(.32, .72, 0, 1)', fill: 'forwards' });
    return a.finished.then(() => { finishClose(); a.cancel(); }, () => {});
  }
  const to = measure(source) || sourceRect;   // a control that no longer exists (inside the old window): where it was
  const onScreen = to && to.width > 0 && to.left + to.width > 0 && to.left < vw() && to.top + to.height > 0 && to.top < vh();
  if (onScreen) {
    const icon = fromFolder() && !rm ? source.closest('.folder').querySelector('.folder-icon') : null;
    if (icon && !rig) rig = folderRig(icon);
    const mine = icon ? rig : null;
    const target = mine ? mine.mouth : to;
    genie.config.onFrame = mine ? ({ p }) => mine.close(p) : null;
    win.classList.add('is-bare');
    genieOn(true);
    fadeScrim(Math.round(CLOSE_MS * .6));   // the target is clear before the neck reaches it
    run = genie.close({ el: win, to: target, edge: edgeFor(target, win.getBoundingClientRect()), floorY: mine ? mine.floor : undefined });   // the same mesh played backwards; from mid-open it reverses where it is
    if (DEV) window.__winRun = run;
    return run.then(res => {
      if (res.interrupted) return;
      if (state === 'closing') { genieOn(false); finishClose(); }
      return mine?.settle();
    });
  }
  if (wasOpening) run?.finish?.();
  if (rm) { finishClose(); return Promise.resolve(); }
  fadeScrim(180);
  const a = win.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
  return a.finished.then(() => { finishClose(); a.cancel(); }, () => {});
}


/* ── renderers ──────────────────────────────────────────────────────────── */
const aid = u => String(u || '').split('/').pop().replace(/\.[^.]+$/, '');

function ctaButton(label) {
  return `<a class="btn btn-primary" href="/contact" data-route="/contact"><span class="btn-label"><span>${esc(label)}</span>${icon('chevronRight', 15)}</span><span class="btn-icon">${icon('mailSend', 16)}</span></a>`;
}

/* Case study: his modal body. Overview label, the two paragraphs, the blocks
   in author order, then Share / Start a project / Live website pinned below. */
export function renderCase(content, p, { onMedia, startAt = null }) {
  return el => {
    el.innerHTML = `
      <p class="desc-label">Overview</p>
      ${p.desc1 ? `<p class="desc-text">${esc(p.desc1)}</p>` : ''}
      ${p.desc2 ? `<p class="desc-text">${esc(p.desc2)}</p>` : ''}
      <div class="blocks"></div>
      <div class="cta-wrap">
        <button class="btn btn-ghost" type="button" data-share><span class="btn-label"><span class="share-text">Share</span><span class="swap-icon">${icon('chevronRight', 15, 's1')}${icon('check', 15, 's2')}</span></span><span class="btn-icon">${icon('links', 16)}</span></button>
        ${ctaButton(content.ctaPrimaryLabel || 'Start a project')}
        ${p.website ? `<a class="btn btn-line" href="${esc(p.website)}" target="_blank" rel="noopener">Live website${icon('external', 15)}</a>` : ''}
      </div>`;
    const blocksEl = el.querySelector('.blocks');
    const flat = [];   // every picture in order, for the lightbox
    const inGallery = startAt && p.blocks.some(b => (b.images || [b.image]).some(u => aid(u) === aid(startAt)));
    const blocks = startAt && !inGallery ? [{ type: 'image', image: startAt, caption: '' }, ...p.blocks] : p.blocks;
    const media = (u, b, duo) => {
      const k = flat.length;
      const item = { url: u, ratio: ratioOf(content, u), title: p.title, caption: esc(b.caption || '') };
      flat.push(item);
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'db-media';
      if (!duo) box.style.aspectRatio = String(ratioOf(content, u));
      box.setAttribute('aria-label', `${p.title}${b.caption ? ', ' + b.caption : ''}. View full size`);
      // the first pictures are in view when the window lands: fetched at once, not lazily
      const m = mediaEl(u, { width: duo ? 900 : 1600, alt: b.caption || p.title, lazy: k > 1, priority: k < 2 ? 'high' : null });
      box.appendChild(m);
      watchVideo(m);
      item.thumb = () => m;
      if (startAt && aid(u) === aid(startAt)) box.dataset.start = '';
      box.addEventListener('click', () => onMedia(flat, k, { el: m }));
      return box;
    };
    blocks.forEach(b => {
      if (b.type === 'text') {
        const paras = String(b.body || '').split(/\n\s*\n/).filter(Boolean);
        if (!b.heading && !paras.length) return;
        const d = document.createElement('div');
        d.className = 'db-text';
        d.innerHTML = (b.heading ? `<p class="db-text-h">${esc(b.heading)}</p>` : '') + paras.map(t => `<p>${esc(t).replace(/\n/g, '<br>')}</p>`).join('');
        blocksEl.appendChild(d);
        return;
      }
      const urls = (b.type === 'duo' ? (b.images || []) : [b.image]).filter(Boolean);
      if (!urls.length) return;
      const fig = document.createElement('figure');
      fig.className = 'db-figure';
      if (b.type === 'duo') {
        const duo = document.createElement('div');
        duo.className = 'db-duo';
        urls.forEach(u => duo.appendChild(media(u, b, true)));
        fig.appendChild(duo);
      } else fig.appendChild(media(urls[0], b, false));
      if (b.caption) { const c = document.createElement('figcaption'); c.className = 'db-caption'; c.textContent = b.caption; fig.appendChild(c); }
      blocksEl.appendChild(fig);
    });
    // Share: copies the case's link and confirms in place (his .detail-share)
    const sb = el.querySelector('[data-share]');
    let t = 0;
    sb.addEventListener('click', async () => {
      const url = `${location.origin}/${p.slug}`;
      let ok = false;
      try { await navigator.clipboard.writeText(url); ok = true; } catch (_) {}
      sb.querySelector('.share-text').textContent = ok ? 'Link copied' : url.replace(/^https?:\/\//, '');
      sb.classList.add('is-done');
      clearTimeout(t);
      t = setTimeout(() => { sb.querySelector('.share-text').textContent = 'Share'; sb.classList.remove('is-done'); }, 2200);
    });
  };
}

/* Reviews: his testimonial presentation, at reading size. */
export function renderKindWords(content) {
  return el => {
    const t = content.testimonials || [];
    // no rating line in here (round 8): the home's stars are the entry point
    el.innerHTML = `
      <section class="words">
        <div class="words-list">
        ${t.map(q => `
          <article class="quote">
            <blockquote class="tm-quote">“${esc(String(q.quote).replace(/\s*\n\s*/g, ' ').replace(/^["“\s]+|["”\s]+$/g, '').trim())}”</blockquote>
            <div class="tm-by">
              <span class="tm-who"><span class="tm-name">${esc(q.name)}</span>${q.handle ? `<span class="tm-handle">${esc(q.handle)}</span>` : ''}</span>
              ${q.proof ? `<button class="proof" type="button" data-src="${esc(proofSrc(q.proof))}" data-ratio="${ratioOf(content, q.proof, 4).toFixed(4)}" data-name="${esc(q.name)}">${icon('verified', 12)}original message</button>` : ''}
            </div>
          </article>`).join('')}
        </div>
      </section>`;
    wireProofs(el, body);
  };
}

/* Start a project: his contact form (fields, copy and chips), posting to Web3Forms. */
const CONTACT_ENDPOINT = 'https://api.web3forms.com/submit';

export function renderContact(content) {
  return el => {
    const c = content.contact || {};
    const err = msg => `<span class="cf-err">${icon('warning', 12)}<span>${msg}</span></span>`;
    el.innerHTML = `
      <div id="cfBody">
        <form class="contact" id="cfForm" novalidate>
          <div class="cf-row">
            <div class="cf-field" data-for="name"><label for="cfName">Your name</label><input class="input" id="cfName" name="name" autocomplete="name" placeholder="Alex Colombel">${err('Please add your name')}</div>
            <div class="cf-field" data-for="email"><label for="cfEmail">Email</label><input class="input" id="cfEmail" name="email" type="email" autocomplete="email" placeholder="you@company.com">${err('Please add a valid email')}</div>
          </div>
          <div class="cf-field" data-for="company"><label for="cfCompany">Company <span class="opt">— optional</span></label><input class="input" id="cfCompany" name="company" autocomplete="organization" placeholder="Where you work"></div>
          <div class="cf-field" data-for="budget"><fieldset><legend class="cf-legend">Budget range</legend>
            <div class="cf-budget">${(c.budgets || []).map(b => `<label class="chip"><input type="radio" name="budget" value="${esc(b)}"><span>${esc(b)}</span></label>`).join('')}</div>
          </fieldset></div>
          <div class="cf-field" data-for="message"><label for="cfMsg">What are you looking to build?</label><textarea class="input" id="cfMsg" name="message" rows="4" placeholder="A sentence or two is plenty — what it is, roughly when, and what success looks like."></textarea>${err('Please add a few words')}</div>
          <input type="checkbox" name="botcheck" tabindex="-1" autocomplete="off" hidden>
          <div class="cf-actions">
            <button class="btn btn-primary btn-lg" type="submit" id="cfSubmit"><span class="btn-label">Send enquiry</span><span class="btn-icon">${icon('sendPlane', 16)}</span></button>
            <span class="cf-note"><span>or</span><a href="${esc(content.telegramUrl)}" target="_blank" rel="noopener">message me directly</a></span>
          </div>
          <p class="cf-fail" aria-live="polite"></p>
        </form>
      </div>
      <div class="cf-done" id="cfDone" hidden>
        <div class="cf-done-mark">${icon('check', 22)}</div>
        <h3>Message sent</h3>
        <p>Thanks, I'll get back to you within a day.</p>
      </div>`;
    const form = el.querySelector('#cfForm');
    const mark = (k, bad) => form.querySelector(`.cf-field[data-for="${k}"]`).classList.toggle('is-bad', bad);
    form.querySelectorAll('.input').forEach(i => i.addEventListener('input', () => i.closest('.cf-field').classList.remove('is-bad')));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (form.dataset.busy) return;
      const fd = new FormData(form);
      const payload = {
        name: String(fd.get('name') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        company: String(fd.get('company') || '').trim(),
        budget: String(fd.get('budget') || ''),
        message: String(fd.get('message') || '').trim(),
      };
      const badName = !payload.name, badEmail = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email), badMsg = payload.message.length < 4;
      mark('name', badName); mark('email', badEmail); mark('message', badMsg);
      if (badName || badEmail || badMsg) { form.querySelector('.is-bad .input')?.focus(); return; }
      if (fd.get('botcheck')) return;
      if (!c.accessKey) {
        location.href = `mailto:${content.email}?subject=${encodeURIComponent(content.ctaSubject || 'Project Enquiry')}&body=${encodeURIComponent(payload.message)}`;
        return;
      }
      const b = form.querySelector('#cfSubmit'), label = b.querySelector('.btn-label');
      form.dataset.busy = '1'; b.disabled = true; label.textContent = 'Sending…';
      try {
        const res = await fetch(CONTACT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ access_key: c.accessKey, subject: `${content.ctaSubject || 'Project Enquiry'} — ${payload.name}`, from_name: payload.name, replyto: payload.email, ...payload }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) throw new Error(data.message || 'failed');
        el.querySelector('#cfBody').hidden = true;
        el.querySelector('#cfDone').hidden = false;
      } catch (_) {
        b.disabled = false; label.textContent = 'Send enquiry'; delete form.dataset.busy;
        form.querySelector('.cf-fail').textContent = 'Could not send. Try again, or email me directly.';
      }
    });
  };
}
