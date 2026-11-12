// The media strip: an endless loop bent into a shallow drum (each tile sits on
// a cylinder: arc position, then rotateY + translateZ). It moves with wheel,
// touch and arrow keys, drifts at 70 px/s with no input, for as long as
// the page shows. Over a tile the cursor becomes a small label that trails the pointer.
// Transforms only; no layout per frame.
import { mediaEl, ratioOf, watchVideo, reducedMotion, esc, holdMedia } from './util.js';
import { DUR, EASE } from './motion.js';
const DUR_BASE = DUR.base, EASE_OUT = EASE.out;

const DRIFT = 70;          // px/s with no input
const KEY_STEP = 160;
const GAP = 10;

/* Cloudinary asset id: the last path segment without transformations or extension. */
export const assetId = u => String(u || '').split('/').pop().replace(/\.[^.]+$/, '');

/* Dev check: the same picture never twice, never two neighbours that are the
   same image (or a known look-alike from content.sameImage), never two
   neighbours from the same project, including across the loop seam. */
function checkStrip(content) {
  const alias = new Map();
  (content.sameImage || []).forEach(group => group.forEach(id => alias.set(id, group[0])));
  const key = u => alias.get(assetId(u)) || assetId(u);
  const list = content.strip, n = list.length, seen = new Map(), problems = [];
  list.forEach((s, i) => {
    const k = key(s.image);
    if (seen.has(k)) problems.push(`#${i} repeats #${seen.get(k)} (${assetId(s.image)})`);
    seen.set(k, i);
    const next = list[(i + 1) % n];
    if (n > 1 && key(next.image) === k) problems.push(`#${i} and #${(i + 1) % n} are the same picture`);
    if (n > 1 && next.projectIdx === s.projectIdx) problems.push(`#${i} and #${(i + 1) % n} are both ${content.projects[s.projectIdx]?.slug}`);
  });
  if (problems.length) console.warn('[strip] content.json strip needs attention:\n  ' + problems.join('\n  '));
}

export function createStrip(root, track, content, { onOpen, onFrame } = {}) {
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) checkStrip(content);
  const items = content.strip.map((s, i) => {
    const p = content.projects[s.projectIdx];
    return { ...s, i, project: p, ratio: ratioOf(content, s.image) };
  });

  const param = (k, d) => { const m = location.search.match(new RegExp('[?&]' + k + '=([\\d.]+)')); return m ? +m[1] : d; };
  /* Geometry. Default: a 3D carousel fold. The middle of the strip is flat;
     past the zone boundary the surface wraps AWAY from you around a cylinder,
     (?fold=in, default: toward you, as from inside the cylinder; ?fold=out: away). A tile that crosses into the zone is drawn as
     vertical slices of its own image, each on the cylinder, so the picture
     itself folds (the flat part stays flat). Tiles wholly in the flat middle
     stay one untouched element. Videos fold the same way, through canvas slices
     that draw the playing video's frame (videoSlices below).
       ?edge=0..1    fold strength: angle at the screen edge = edge × 75° (default 1)
       ?persp=px     perspective (default 1200)
       ?edgeblur=px  blur at the very screen edge (default 1, 0 = off)
       ?curve=deg    alternative: the whole strip as a convex drum */
  /* round 8 (Alex: "make the 3D effect a bit more circle"): a tighter ring. The turn is
     solved at the VISIBLE screen edge (after perspective), not at the unprojected one, which
     had pushed the 60° point off screen (about 45° was ever seen); 75° there now, a flat
     centre of 38 %, a lower perspective and 20 slices per tile, so tile edges read as arcs. */
  const EDGE = param('edge', 1);     // 0..1 of EDGE_MAX_DEG at the screen edge
  const EDGE_MAX_DEG = 75;
  const EDGE_FLAT = .38;        // share of the width that stays flat in the middle
  const EDGE_RAMP = .35;        // share of the curved zone over which curvature eases in (no kink)
  const SLICES = 20;
  const PERSP = param('persp', 1200);   // px; also set on the strip element below
  const EDGE_BLUR = param('edgeblur', 0);   // off by default
  const CHROMA = param('chroma', 0);   // lens fringe at the folded edges: 0 off (default), 1 ≈ 7 px at the very edge
  // ?fold=in (default): standing inside the cylinder, the edges come toward you
  // and grow, the centre is furthest. ?fold=out: the outside of a drum, edges recede.
  const FOLD_IN = !/[?&]fold=out\b/.test(location.search);
  const CURVE = param('curve', 0);
  const LERP = .07, LERP_TOUCH = .35;   // per 60 Hz frame, dt-corrected below
  let edge = 0;

  let tiles = [];          // { el, w, o (offset along the loop), i }
  let loopW = 0;           // length of the rendered loop (one or more copies of the set)
  let W = 0, H = 0, R = Infinity, maxA = Math.PI / 2;
  let target = 0, x = 0, lastX = 0, velocity = 0;
  let dir = 1;
  let paused = false, touching = false, hold = false;
  let prevT = 0;

  let F = Infinity, Rc = Infinity, foldA = 0;   // flat half-width, fold radius, angle at the screen edge
  function geometry() {
    W = root.clientWidth; H = root.clientHeight;
    const phone = innerWidth <= 768;
    const deg = reducedMotion() ? 0 : (phone ? Math.min(CURVE, 12) : CURVE);
    const th = deg * Math.PI / 180;
    R = th > 0 ? (W / 2) / Math.sin(th) : Infinity;
    maxA = th > 0 ? Math.min(th * 1.6, 1.5) : Infinity;   // cull a little past the screen edge
    // the fold is off for reduced motion, on phones, and when the drum is chosen
    edge = (th > 0 || phone || reducedMotion()) ? 0 : EDGE;
    foldA = edge * EDGE_MAX_DEG * Math.PI / 180;
    F = W / 2 * EDGE_FLAT;
    root.style.perspective = PERSP + 'px';
    buildFoldTable();
    document.documentElement.style.setProperty('--edge-blur', (edge ? EDGE_BLUR : 0) + 'px');
    document.documentElement.classList.toggle('has-edgeblur', !!(edge && EDGE_BLUR));
  }

  /* The curve past the flat middle: curvature eases in over a ramp (so flat
     meets curved without a kink), then holds a constant radius. Positions are
     integrated once per resize into a table; the radius is solved so the
     surface has turned through foldA by the time it reaches the screen edge. */
  let table = null;                 // per px of arc beyond F: [x, z, angle]
  const STEP = 2;
  function integrate(R, L, upto) {
    const out = []; let x = 0, z = 0, th = 0;
    for (let e = 0; e <= upto; e += STEP) {
      out.push([x, z, th]);
      const k = e < L ? (e / L) / R : 1 / R;      // curvature
      th += k * STEP;
      x += Math.cos(th) * STEP; z += Math.sin(th) * STEP;
    }
    return out;
  }
  function buildFoldTable() {
    if (!foldA) { table = null; return; }
    const span = W / 2 - F, upto = W * 1.6;
    let lo = 20, hi = 20000, R = 400;
    // the point that projects onto the screen edge (FOLD_IN: z toward the viewer enlarges)
    const atEdge = tb => tb.find(([x, z]) => (F + x) * PERSP / (PERSP - (FOLD_IN ? z : -z)) >= W / 2) || tb[tb.length - 1];
    for (let it = 0; it < 28; it++) {             // angle at the visible screen edge = foldA
      R = (lo + hi) / 2;
      const L = EDGE_RAMP * span;
      const tb = integrate(R, L, upto);
      if (atEdge(tb)[2] > foldA) lo = R; else hi = R;
    }
    Rc = R;
    table = integrate(R, EDGE_RAMP * span, upto);
    if (debug) { const e = atEdge(table); console.log(`[wavedebug] strip fold: ${(foldA * 57.3).toFixed(0)}° at the screen edge · radius ${R.toFixed(0)} px · flat centre ${(EDGE_FLAT * 100).toFixed(0)} % · ${SLICES} slices/tile · perspective ${PERSP} px · edge tiles grow ${((PERSP / (PERSP - e[1]) - 1) * 100).toFixed(1)} %`); }
  }
  /* Where arc distance d (from the strip centre) lands: [x, z, rotateY]. */
  function fold(d) {
    const a = Math.abs(d);
    if (a <= F || !table) return [d, 0, 0];
    const e = a - F, i = Math.min(table.length - 1, Math.floor(e / STEP)), f = Math.min(1, (e - i * STEP) / STEP);
    const p = table[i], q = table[Math.min(table.length - 1, i + 1)];
    const x = p[0] + (q[0] - p[0]) * f, z = p[1] + (q[1] - p[1]) * f, th = p[2] + (q[2] - p[2]) * f;
    const sg = Math.sign(d);
    return FOLD_IN ? [sg * (F + x), z, -sg * th] : [sg * (F + x), -z, sg * th];
  }

  /* While a tile's media is not ready (.tile.media-ph) its slices also carry his mark,
     each slice offset so the mark sits whole in the middle of the folded tile
     (css/home.css .tile.media-ph .slice). Size as the flat placeholder: 20 % of the
     tile's shorter side, 28-72 px. */
  function markSlice(t, sl, k, sw) {
    const mw = Math.max(28, Math.min(72, .2 * Math.min(t.w, H)));
    sl.style.setProperty('--mw', mw.toFixed(1) + 'px');
    sl.style.setProperty('--mx', (t.w / 2 - mw / 2 - k * sw).toFixed(2) + 'px');
  }

  /* Slices for an image tile: same decoded file as a background, offset per slice. */
  function ensureSlices(t) {
    if (t.slices) return t.slices;
    const vid = t.el.querySelector('video');
    if (vid) return videoSlices(t, vid);
    const img = t.el.querySelector('img');
    if (!img || !(img.currentSrc || img.src)) return null;
    const wrap = document.createElement('span');
    wrap.className = 'slices';
    const sw = t.w / SLICES;
    const url = `url("${img.currentSrc || img.src}")`;
    t.slices = [];
    for (let k = 0; k < SLICES; k++) {
      const sl = document.createElement('span');
      sl.className = 'slice';
      sl.style.width = (sw + .8).toFixed(2) + 'px';   // a hair of overlap hides seams along the arc
      if (k === 0) sl.classList.add('first');
      if (k === SLICES - 1) sl.classList.add('last');
      sl.style.setProperty('--si', url);
      sl.style.setProperty('--ss', `${t.w}px 100%`);
      sl.style.setProperty('--sp', `${(-k * sw).toFixed(2)}px 0`);
      markSlice(t, sl, k, sw);
      wrap.appendChild(sl);
      t.slices.push(sl);
    }
    t.el.appendChild(wrap);
    return t.slices;
  }

  /* Slices for a video tile: the same 20 bands on the same arc, but each band is a
     small canvas that draws its strip of the playing video's current frame (object-fit:
     cover crop reproduced in the source rect). The one <video> keeps playing at
     opacity 0 underneath while the tile is sliced; it shows again once the tile is
     wholly flat. Canvases are made once per tile and reused; nothing is allocated per
     frame. Before the first video frame the poster is drawn (else the surface colour). */
  const VDPR = Math.min(1.5, devicePixelRatio || 1);
  function videoSlices(t, v) {
    const wrap = document.createElement('span');
    wrap.className = 'slices';
    const sw = t.w / SLICES, cw = sw + .8;   // same width and overlap as the image slices
    const bw = Math.max(1, Math.ceil(cw * VDPR)), bh = Math.max(1, Math.ceil(H * VDPR));
    t.slices = [];
    for (let k = 0; k < SLICES; k++) {
      const c = document.createElement('canvas');
      c.className = 'slice';
      c.width = bw; c.height = bh;
      c.style.width = cw.toFixed(2) + 'px';
      if (k === 0) c.classList.add('first');
      if (k === SLICES - 1) c.classList.add('last');
      markSlice(t, c, k, sw);   // shows until the poster or a frame is drawn over it
      c._ctx = c.getContext('2d');
      wrap.appendChild(c);
      t.slices.push(c);
    }
    t.el.appendChild(wrap);
    t.vid = v; t.vDirty = true; t.vSrc = 0;
    if (v.poster) {
      const p = new Image();
      p.crossOrigin = 'anonymous';
      p.onload = () => { t.vDirty = true; };
      p.src = v.poster;
      t.poster = p;
    }
    if (typeof v.requestVideoFrameCallback === 'function') {
      t.rvfc = () => { t.vDirty = true; if (t.sliced) v.requestVideoFrameCallback(t.rvfc); else t.rvfcOn = false; };
    }
    return t.slices;
  }
  function drawVideoSlices(t) {
    const v = t.vid, p = t.poster;
    let src = null, iw = 0, ih = 0;
    if (v.readyState >= 2 && v.videoWidth) { src = v; iw = v.videoWidth; ih = v.videoHeight; }
    else if (p && p.complete && p.naturalWidth) { src = p; iw = p.naturalWidth; ih = p.naturalHeight; }
    if (!src) return;   // nothing decoded yet: the slices show the surface colour, like an unloaded tile
    t.vDirty = false;
    const sc = Math.max(t.w / iw, H / ih);
    const ox = (t.w - iw * sc) / 2, oy = (H - ih * sc) / 2;
    const sw = t.w / SLICES, cw = sw + .8;
    const sy = -oy / sc, sh = H / sc, sWid = cw / sc;
    for (let k = 0; k < SLICES; k++) {
      const c = t.slices[k];   // hidden (turned-away) bands too: they can come back while the source is still
      c._ctx.drawImage(src, (k * sw - ox) / sc, sy, sWid, sh, 0, 0, c.width, c.height);
    }
  }

  function build() {
    geometry();
    if (!H) return;
    const setW = items.reduce((a, it) => a + Math.round(H * it.ratio) + GAP, 0);
    const span = Number.isFinite(R) ? 2 * R * maxA : W;   // arc that can be on screen
    const copies = Math.max(1, Math.ceil((span + 1200) / setW));
    if (track.dataset.key === `${H}x${copies}`) return;
    track.dataset.key = `${H}x${copies}`;
    track.textContent = '';
    tiles = [];
    let o = 0;
    for (let c = 0; c < copies; c++) {
      for (const it of items) {
        const w = Math.round(H * it.ratio);
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'tile';
        el.style.width = w + 'px';
        el.dataset.i = it.i;
        el.setAttribute('aria-label', `${it.project.title}, ${it.project.metric}. Open picture`);
        if (c > 0) { el.tabIndex = -1; el.setAttribute('aria-hidden', 'true'); }
        // displayed size × DPR (capped); no-CORS like the slices' CSS background, so one request per picture
        const dpr = Math.min(2, devicePixelRatio || 1);
        const setW0 = items.reduce((a2, it2) => a2 + Math.round(H * it2.ratio) + GAP, 0) * copies;
        let s0 = (o + w / 2) % setW0; if (s0 > setW0 / 2) s0 -= setW0;
        const near = Math.abs(s0) < W * .75;   // the tiles around the centre at load
        const m = mediaEl(it.image, { width: Math.min(1600, Math.max(400, Math.round(w * dpr / 100) * 100)), alt: it.project.title, lazy: !near, cors: false, priority: near ? 'high' : 'low' });
        // pictures away from the centre wait for a quiet moment (layout puts every tile at x = 0,
        // so native lazy loading cannot tell them apart)
        if (!near && m.tagName === 'IMG') { m.dataset.later = m.src; m.removeAttribute('src'); later.push(m); }
        // videos are drawn into the fold's canvas slices: CORS keeps those canvases clean (Cloudinary sends ACAO *)
        if (m.tagName === 'VIDEO') m.crossOrigin = 'anonymous';
        el.appendChild(m);
        holdMedia(el, m, it.ratio);   // skeleton with his mark until the cover is ready
        watchVideo(m);
        track.appendChild(el);
        tiles.push({ el, w, o: o + w / 2, i: it.i, shown: true });
        o += w + GAP;
      }
    }
    loopW = o;
    place();
    const fill = () => later.splice(0).forEach(img => { img.src = img.dataset.later; });
    addEventListener('load', () => ('requestIdleCallback' in window ? requestIdleCallback(fill, { timeout: 1500 }) : setTimeout(fill, 300)), { once: true });
    if (document.readyState === 'complete') ('requestIdleCallback' in window ? requestIdleCallback(fill, { timeout: 1500 }) : setTimeout(fill, 300));
  }
  const later = [];

  /* Per frame: one transform per flat tile; for a tile in a fold zone, one
     transform per slice. Transforms only, no layout. */
  function place() {
    if (!loopW) return;
    const half = loopW / 2;
    for (const t of tiles) {
      let s = ((t.o - x) % loopW + loopW) % loopW;   // 0..loopW from the centre
      if (s > half) s -= loopW;                      // -half..half
      t.s = s;
      let tx, tz = 0, ry = 0, vis;
      const inFold = foldA > 0 && Math.abs(s) + t.w / 2 > F;
      if (Number.isFinite(R)) {
        const a = s / R;
        vis = Math.abs(a) < maxA;
        tx = R * Math.sin(a); tz = R * (Math.cos(a) - 1); ry = a * 57.29578;
      } else if (inFold) {
        // still on screen while the near edge has not turned past ~80°
        const near = Math.abs(s) - t.w / 2;
        vis = near <= F || Math.abs(fold(Math.sign(s) * near)[2]) < 1.4;
        if (vis) {
          const sl = ensureSlices(t);
          if (sl) {
            if (!t.sliced) {
              t.el.classList.add('is-sliced'); t.el.classList.toggle('has-ca', CHROMA > 0); t.el.style.transform = 'none'; t.sliced = true;
              if (t.vid) { t.vDirty = true; if (t.rvfc && !t.rvfcOn) { t.rvfcOn = true; t.vid.requestVideoFrameCallback(t.rvfc); } }
            }
            const side = s > 0 ? 'side-r' : 'side-l';
            if (t.side !== side) { t.el.classList.remove('side-r', 'side-l'); t.el.classList.add(side); t.side = side; }
            if (CHROMA) {   // fringe width follows how far round the edge has turned
              const outer = fold(s + Math.sign(s) * t.w / 2)[2];
              const ca = (CHROMA * 7 * Math.min(1, Math.abs(outer) / foldA)).toFixed(2);
              if (ca !== t.ca) { t.el.style.setProperty('--ca', ca + 'px'); t.ca = ca; }
            }
            const sw = t.w / SLICES;
            for (let k = 0; k < SLICES; k++) {
              const [fx, fz, fa] = fold(s - t.w / 2 + (k + .5) * sw);
              const hide = Math.abs(fa) > 1.45;
              if (hide !== !!sl[k]._h) { sl[k].style.visibility = hide ? 'hidden' : ''; sl[k]._h = hide; }
              if (!hide) sl[k].style.transform = `translate3d(${(W / 2 + fx - (sw + .8) / 2).toFixed(2)}px,0,${fz.toFixed(2)}px) rotateY(${(fa * 57.29578).toFixed(3)}deg)`;
            }
            // video: redraw the bands when the video has a new frame (every frame without rVFC)
            if (t.vid && (t.vDirty || (!t.rvfc && !t.vid.paused))) drawVideoSlices(t);
            if (vis !== t.shown) { t.el.style.visibility = ''; t.shown = true; }
            continue;
          }
          // image not decoded yet: rigid fold at the tile's centre
          [tx, tz, ry] = fold(s); ry *= 57.29578;
        }
      } else {
        tx = s; vis = Math.abs(s) < W / 2 + t.w;
      }
      const wasSliced = t.sliced;
      if (t.sliced) { t.el.classList.remove('is-sliced', 'has-ca', 'side-l', 'side-r'); t.el.style.removeProperty('--ca'); t.ca = null; t.side = null; t.sliced = false; }
      if (vis !== t.shown) { t.el.style.visibility = vis ? '' : 'hidden'; t.shown = vis; }
      // a culled tile that was sliced still had transform: none (on screen at x 0), which kept its video playing
      if (!vis) { if (wasSliced) t.el.style.transform = 'translate3d(-200vw,0,0)'; continue; }
      t.el.style.transform = `translate3d(${(W / 2 + tx - t.w / 2).toFixed(2)}px,0,${tz.toFixed(2)}px) rotateY(${ry.toFixed(3)}deg)`;
    }
  }

  const poke = d => {
    if (paused) return;
    target += d;
    if (Math.abs(d) > .5) dir = Math.sign(d);
  };

  // wheel: vertical and horizontal both move the strip
  addEventListener('wheel', e => {
    if (paused) return;
    if (e.target.closest?.('.win-layer, .lb')) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerWidth : 1;
    poke((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * k);
  }, { passive: false });

  // drag (mouse + touch) with momentum; on touch, vertical swipes count too
  let down = null, moved = 0, lastMoveT = 0, flick = 0, wasDrag = false;
  root.addEventListener('pointerdown', e => {
    if (paused || e.button > 0) return;
    down = { x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
    moved = 0; flick = 0; touching = true;
    lastMoveT = performance.now();
    root.setPointerCapture?.(e.pointerId);
  });
  root.addEventListener('pointermove', e => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    down.x = e.clientX; down.y = e.clientY;
    const d = down.touch && Math.abs(dy) > Math.abs(dx) ? -dy * 1.4 : -dx;
    moved += Math.abs(dx) + Math.abs(dy);
    if (moved > 6) root.classList.add('is-dragging');
    const now = performance.now();
    flick = flick * .6 + (d / Math.max(1, now - lastMoveT)) * .4;   // px per ms, smoothed
    lastMoveT = now;
    poke(d);
  });
  const up = () => {
    if (!down) return;
    touching = false;
    root.classList.remove('is-dragging');
    if (performance.now() - lastMoveT < 80) poke(flick * 260);   // momentum
    wasDrag = moved > 6;
    down = null;
  };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  // Open on click, not pointerup: the walker stops the click (capture phase)
  // when the figure itself was hit, so a click on him never opens a tile.
  root.addEventListener('click', e => {
    if (paused) return;
    if (e.detail !== 0 && wasDrag) { wasDrag = false; return; }
    // a click in a gap opens the project the label is showing
    const tile = e.detail === 0 ? e.target.closest('.tile')
      : (document.elementFromPoint(e.clientX, e.clientY)?.closest('.tile') || (L.on ? L.el : null) || nearestTile(e.clientX));
    if (!tile || !root.contains(tile)) return;
    hideLabel(true);
    onOpen?.(+tile.dataset.i, tile);
  });

  // Keyboard focus on a tile: bring it to the middle of the drum.
  root.addEventListener('focusin', e => {
    root.scrollLeft = 0;
    const t = tiles.find(t => t.el === e.target);
    if (t && t.s != null && Math.abs(t.s) > W / 3) poke(t.s);
  });
  root.addEventListener('scroll', () => { root.scrollLeft = 0; });

  addEventListener('keydown', e => {
    if (paused || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'ArrowRight') { poke(KEY_STEP); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { poke(-KEY_STEP); e.preventDefault(); }
  });

  /* ── the trailing label (mouse only) ─────────────────────────────────
     The hover belongs to the STRIP: while the mouse is anywhere in the band
     (tiles, gaps, folded slices) the cursor is hidden and the pill stays up.
     Its text follows the tile under the pointer, with a 2-frame hysteresis;
     in a gap it keeps the last project. Over the walker it fades out. */
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const label = document.createElement('div');
  label.className = 'strip-label';
  label.setAttribute('aria-hidden', 'true');
  label.innerHTML = '<span><em></em></span>';
  document.body.appendChild(label);
  const pill = label.firstElementChild, labelText = pill.firstElementChild;
  const L = { x: 0, y: 0, s: .8, on: false, i: -1, el: null, cand: null, candN: 0 };
  let mouse = null, inBand = false;
  root.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') inBand = true; });
  root.addEventListener('pointerleave', () => { inBand = false; });
  addEventListener('pointermove', e => { mouse = e.pointerType === 'mouse' ? { x: e.clientX, y: e.clientY } : null; }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { mouse = null; inBand = false; });
  addEventListener('blur', () => { mouse = null; inBand = false; });

  function setText(i) {
    const p = items[i].project;
    const html = `${esc(p.title)}<span class="sep">·</span><span class="metric">${esc(p.metricValue || p.metric)}${p.metricUnit ? ' ' + esc(p.metricUnit) : ''}</span>`;
    if (!L.on || reducedMotion() || L.i < 0) { labelText.innerHTML = html; L.i = i; return; }
    // same pill: the text cross-slides, the pill eases to its new width
    const w0 = pill.getBoundingClientRect().width;
    labelText.innerHTML = html; L.i = i;
    const w1 = pill.getBoundingClientRect().width;
    pill.animate([{ width: w0 + 'px' }, { width: w1 + 'px' }], { duration: DUR_BASE, easing: EASE_OUT });
    labelText.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: DUR_BASE, easing: EASE_OUT });
  }
  function hideLabel(now) {
    if (!L.on) return;
    L.on = false; label.classList.remove('on'); root.classList.remove('label-on');
    if (now) { L.s = .8; label.style.transition = 'none'; label.style.opacity = '0'; requestAnimationFrame(() => { label.style.transition = ''; label.style.opacity = ''; }); }
  }
  function nearestTile(x) {
    let best = null, d = Infinity;
    for (const t of tiles) {
      if (!t.shown) continue;
      const r = t.el.classList.contains('is-sliced') ? null : t.el.getBoundingClientRect();
      const cx = r ? r.left + r.width / 2 : W / 2 + (t.s || 0) + root.getBoundingClientRect().left;
      const dd = Math.abs(cx - x);
      if (dd < d) { d = dd; best = t.el; }
    }
    return best;
  }
  function updateLabel(k) {
    const overWalker = document.body.style.cursor === 'pointer';
    const active = inBand && mouse && fine.matches && !paused && !down && !overWalker;
    if (active) {
      const hit = document.elementFromPoint(mouse.x, mouse.y)?.closest?.('.tile');
      const tile = hit && root.contains(hit) ? hit : null;
      if (tile && tile !== L.el) {
        // hysteresis: a different tile must be under the pointer for 2 frames
        if (L.cand === tile) L.candN++; else { L.cand = tile; L.candN = 1; }
        if (L.candN >= 2 || !L.el) { L.el = tile; L.cand = null; if (+tile.dataset.i !== L.i) setText(+tile.dataset.i); }
      } else if (!tile && !L.el) {
        L.el = nearestTile(mouse.x);
        if (L.el && +L.el.dataset.i !== L.i) setText(+L.el.dataset.i);
      }
      if (!L.on && L.el) {
        L.x = mouse.x; L.y = mouse.y;   // appear where the cursor is, never fly in
        L.on = true; label.classList.add('on'); root.classList.add('label-on');
      }
    } else {
      hideLabel(false);
      if (!inBand) { L.el = null; L.cand = null; }
    }
    if (!L.on && L.s <= .801) return;
    const rm = reducedMotion();
    const f = rm ? 1 : 1 - Math.pow(1 - .15, k);
    if (mouse) { L.x += (mouse.x - L.x) * f; L.y += (mouse.y - L.y) * f; }
    L.s += ((L.on ? 1 : .8) - L.s) * (rm ? 1 : 1 - Math.pow(1 - .2, k));
    label.style.transform = `translate3d(${(L.x + 14).toFixed(1)}px,${(L.y + 18).toFixed(1)}px,0) scale(${L.s.toFixed(3)})`;
  }

  let frozen = false;   // the page holds the strip (a window genie is running): no rAF work at all
  function frame(t) {
    if (frozen) { prevT = 0; return; }
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (t - (prevT || t)) / 1000);
    prevT = t;
    const k = dt * 60;                       // frames at 60 Hz this tick
    if (!loopW) return;
    const now = performance.now();
    const rm = reducedMotion();
    // round 8: no rest after idle (Alex: it stopped under a still pointer); it drifts while the page shows
    if (!paused && !hold && !touching && !rm) target += DRIFT * dt * dir;
    x = rm ? target : x + (target - x) * (1 - Math.pow(1 - (touching ? LERP_TOUCH : LERP), k));
    velocity = dt > 0 ? (x - lastX) / dt : 0;
    lastX = x;
    if (Math.abs(velocity) < .5 && paused) velocity = 0;
    const p0 = debug ? performance.now() : 0;
    place();
    updateLabel(k);
    onFrame?.(velocity);
    if (debug) {
      stats.js += performance.now() - p0; stats.n++;
      stats.dts.push(t - (stats.last || t)); stats.last = t;   // raw frame interval, not the clamped dt
      if (now - stats.t0 > 3000) {
        const d = stats.dts.sort((a, b) => a - b);
        const nSliced = tiles.filter(t => t.sliced).length;
        console.log(`[wavedebug] strip (fold ${edge}, curve ${CURVE}, ${nSliced} sliced tiles): ${stats.n} frames · place+label js ${(stats.js / stats.n).toFixed(2)} ms/frame · frame median ${d[d.length >> 1].toFixed(1)} ms · p95 ${d[Math.floor(d.length * .95)].toFixed(1)} ms`);
        stats.js = 0; stats.n = 0; stats.gap = 0; stats.dts = []; stats.t0 = now;
      }
    }
  }
  const debug = /[?&]wavedebug\b/.test(location.search);
  const stats = { js: 0, gap: 0, n: 0, dts: [], t0: performance.now() };

  build();
  let rT;
  new ResizeObserver(() => { clearTimeout(rT); rT = setTimeout(() => { track.dataset.key = ''; build(); }, 120); }).observe(root);
  requestAnimationFrame(frame);

  return {
    items,
    get velocity() { return velocity; },
    setHold(v) { hold = !!v; },
    setPaused(v) { paused = v; if (v) { hideLabel(true); inBand = false; L.el = null; } },
    nudge: poke,
    freeze(v) { if (frozen === !!v) return; frozen = !!v; if (!frozen) requestAnimationFrame(frame); },
    // ?wavedebug harness: where each tile sits (s = centre offset from the strip centre, px)
    get debugTiles() { return tiles.map(t => ({ i: t.i, s: t.s, w: t.w, video: !!t.el.querySelector('video'), sliced: !!t.sliced, shown: t.shown })); },
    get geom() { return { W, F, x, target }; },
  };
}
