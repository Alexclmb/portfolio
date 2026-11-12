// genie.js: the macOS Dock "Genie" for live DOM windows. No dependencies.
//
// A window opens out of, and closes back into, the thing the visitor clicked
// (a folder icon, a picture tile). The funnel shape and the bend/slide timing
// are the Dock's own (macOS 27, ported by Raphael Salaja from the Dock binary
// to TypeScript, MIT; see LICENSES/springboard-genie-MIT.txt). This file is a
// plain-JS rewrite of his mesh.ts + quadMatrix, with its own driver.
//
// How it draws (primary, "slices"): the window is cloned once into a static
// template; each quad of the Dock's 2-column mesh gets one copy of that
// template inside an overflow:hidden strip, projected onto the quad with a
// matrix3d (Heckbert square-to-quad). The Dock's mesh needs only ~5-16 quads,
// so that is 5-16 DOM copies, built lazily. Per frame: transforms, sizes and
// opacity only. At the end the real (live) element is shown in the same frame
// and every copy is removed.
//
// Fallback ("clip"): no copies. The live element itself is scaled into the
// funnel's bounding box and clip-path: polygon() cuts the funnel silhouette.
// Same outline, content scaled rather than warped. Zero setup cost; used for
// very large DOMs or when asked.
//
// Progress convention (the Dock's): p = 0 is the open window, p = 1 is the
// window inside the source. open() plays 1 -> 0, close() plays 0 -> 1, both
// at a constant rate (the Dock's progress is linear; the curves inside are
// half-cosines), and either can take over from the other mid-run.

/* ── tuning ─────────────────────────────────────────────────────────────── */
export const GENIE_DEFAULTS = {
  openMs: 500,            // full 1 -> 0 run: the Dock's 0.5 s (springboard GENIE_DURATION)
  closeMs: 500,           // full 0 -> 1 run: same duration both ways, as the Dock
  technique: 'auto',      // 'slices' | 'clip' | 'auto' (slices unless the DOM is huge)
  maxNodes: 3000,         // 'auto' switches to 'clip' above this many elements
  tolerance: 0.6,         // Dock: max chord error (points) before a side is split again. Lower = more slices
  minSlice: 8,            // Dock: no slice shorter than this (points)
  maxSlices: 48,          // hard cap on quads drawn per frame
  tension: 1,             // neck curve: 1 = the Dock's half-cosine; >1 tighter neck, <1 softer
  bendWeight: 1,          // phase split: >1 the sides take longer to bend before the slide (1 = Dock)
  pointScale: 1,          // CSS px per Dock point (springboard default 1; 'auto' = viewport width / 1440)
  fadeFrom: 1,            // the copies fade out from this progress to 1 (1 = never: the Dock never fades)
  seam: 0.75,             // overlap between neighbouring slices, in screen px (hides hairline seams)
  handoff: 0.015,         // below this progress the copies cross-fade over the live window (0.04 before round 8: the copies were still ~15 px off the rest pose there)
  tail: 1.35,             // round 8: progress = linear^tail, so the last frames before the window lands (and the first of a close) move by a pixel or two, not 15-60 px (1 = the Dock's linear)
  reducedMs: 150,         // prefers-reduced-motion: a plain fade
  plainMs: 220,           // source off-screen / missing: a plain scale + fade
  zIndex: '',             // z-index of the copy layer ('' = stack right above el, same context)
  reducedMotion: 'user',  // 'user' follows prefers-reduced-motion; 'always' | 'never'
  speed: 1,               // playback rate (0.1 = slow motion); can be changed live on the instance
  onFrame: null,          // (info) => void, every drawn frame: { p, ms, quads, technique }
  edge: 'auto',           // the Dock's side: 'bottom' | 'top' | 'left' | 'right' | 'auto' (springboard controller default 'bottom')
};

/* ── the Dock's mesh (ported from @web-kits/springboard mesh.ts, MIT) ───── */
const f = Math.fround;
const PI = Math.PI;
const CAPACITY = 1200;
const MAX_CALLS = 64;
const halfCos = c => c * -0.5 + 0.5;

function makeCurve(tension) {
  if (tension === 1) return halfCos;
  return c => {
    const e = halfCos(c);
    return e < 0.5 ? 0.5 * Math.pow(2 * e, tension) : 1 - 0.5 * Math.pow(2 - 2 * e, tension);
  };
}

function subdivide(buf, offset, a, b, start, left, right, span, ctr, cfg) {
  const ease = cfg.curve;
  const atB = ease(Math.cos(((b - start) * PI) / span));
  if (++ctr.calls > MAX_CALLS) return 0;
  const rightB = f(right * atB), leftB = f(left * atB);
  let written = 0, from = a, at = offset;
  for (;;) {
    const length = Math.abs(b - from);
    if (length < cfg.minSlice) return written;
    const mid = (b + from) * 0.5;
    const atFrom = Math.cos(((from - start) * PI) / span);
    const atMid = ease(Math.cos(((mid - start) * PI) / span));
    const leftMid = f(left * atMid), rightMid = f(right * atMid);
    if (length < 128) {
      const eased = ease(atFrom);
      if (Math.abs(f(leftB + f(left * eased)) * 0.5 - leftMid) < cfg.tolerance &&
          Math.abs(f(rightB + f(right * eased)) * 0.5 - rightMid) < cfg.tolerance) return written;
    }
    const count = subdivide(buf, at, from, mid, start, left, right, span, ctr, cfg);
    const index = count + at;
    if (index > CAPACITY - 1) return written;
    buf[index] = mid; buf[index + 1] = leftMid; buf[index + 2] = rightMid;
    if (index > CAPACITY - 4) return written;
    at = index + 3;
    written += count + 3;
    ctr.calls += 1;
    from = mid;
    if (ctr.calls >= MAX_CALLS + 1) return written;
  }
}

function axis(w, i, edge) {
  const { x: ax, y: ay, width: aw, height: ah } = w;
  const { x: bx, y: by, width: bw, height: bh } = i;
  if (edge === 'bottom') {
    const gap = by - (ay + ah), overlap = gap > 0 ? 0 : gap;
    return { far: ay, length: ah, near: by, iconFar: by + bh, left: bx - ax, right: bx + bw - (ax + aw), overlap, travel: overlap >= 0 ? by - ay : ah };
  }
  if (edge === 'top') {
    const near = by + bh, far = ay + ah, gap = near - ay, overlap = gap < 0 ? 0 : gap;
    return { far, length: -ah, near, iconFar: by, left: bx - ax, right: bx + bw - (ax + aw), overlap, travel: overlap <= 0 ? near - far : -ah };
  }
  if (edge === 'right') {
    const gap = bx - (ax + aw), overlap = gap > 0 ? 0 : gap;
    return { far: ax, length: aw, near: bx, iconFar: bx + bw, left: by - ay, right: by + bh - (ay + ah), overlap, travel: overlap >= 0 ? bx - ax : aw };
  }
  const near = bx + bw, far = ax + aw, gap = near - ax, overlap = gap < 0 ? 0 : gap;
  return { far, length: -aw, near, iconFar: bx, left: by - ay, right: by + bh - (ay + ah), overlap, travel: overlap <= 0 ? near - far : -aw };
}

// Two phases, each a half-cosine: the sides bend, then the window slides down
// the funnel. Scheduled so the bend completes as the leading edge reaches the
// source (the acos solves the slide's cosine for that moment).
function timing(p, a, cfg) {
  const sides = (Math.abs(a.left) + Math.abs(a.right)) * 0.125;
  const squeeze = Math.abs(a.overlap + a.overlap);
  const bend = Math.abs(squeeze > sides ? squeeze : sides) * 0.5 + 1;
  const bendLength = Math.trunc(Math.log(bend)) * 50 * cfg.bendWeight;   // springboard timing(), unclamped
  const distance = Math.abs(a.travel) || 1;
  const slideLength = Math.trunc(Math.log(distance * 0.5 + 1)) * 50 || 1;
  const gap = Math.abs(a.travel - a.length);
  const ratio = Math.min(1, gap / distance);
  const reach = slideLength * (Math.acos(ratio * -2 + 1) / PI);
  const narrow = bendLength > reach ? bendLength : reach;
  const lead = bendLength > reach ? bendLength - reach : 0;
  const along = (slideLength + lead) * p;
  const narrowed = Math.min(Math.max(along, 0), narrow) / (narrow || 1);
  const slidden = Math.min(Math.max(along - lead, 0), slideLength) / slideLength;
  return { bent: halfCos(Math.cos(narrowed * PI)), poured: halfCos(Math.cos(slidden * PI)), gap };
}

// Returns screen-space outline rows: Float32Array of [pos, nearOffset, farOffset] triples,
// built into a {columns, rows, points} mesh (4 floats per vertex: local x, local y, screen x, screen y).
function genieMesh(progress, w, i, edge, cfg) {
  const a = axis(w, i, edge);
  const { bent, poured, gap } = timing(f(progress), a, cfg);
  const ease = cfg.curve;
  const left = a.left * bent, right = a.right * bent;
  const moved = a.travel * poured;
  const span = Math.trunc(a.travel + 0.5) || 1;
  const start = a.far + a.overlap * bent;
  const top = start + moved;
  const bottom = a.length + top;
  const toward = edge === 'bottom' || edge === 'right';
  const clamped = toward ? (bottom <= a.near ? bottom : a.near) : (bottom >= a.near ? bottom : a.near);
  const neck = poured <= 0 ? bottom : clamped;
  const buf = cfg.buf;
  const first = ease(Math.cos(((top - start) * PI) / span));
  buf[0] = top; buf[1] = left * first; buf[2] = right * first;
  const count = subdivide(buf, 3, top, neck, start, left, right, span, { calls: 0 }, cfg);
  const atNeck = ease(Math.cos(((neck - start) * PI) / span));
  buf[count + 3] = neck; buf[count + 4] = left * atNeck; buf[count + 5] = right * atNeck;
  let floats = count + 6;
  if (Math.abs(moved) > gap) {
    let tail = bottom;
    if (toward) { if (tail > a.iconFar) tail = a.iconFar; } else if (tail < a.iconFar) tail = a.iconFar;
    buf[floats] = tail; buf[floats + 1] = left; buf[floats + 2] = right;
    floats += 3;
  }
  return build(buf, Math.trunc(floats / 3), w, edge);
}

function build(buf, count, w, edge) {
  const { x: ax, y: ay, width: aw, height: ah } = w;
  const vertical = edge === 'bottom' || edge === 'top';
  const reversed = edge === 'top' || edge === 'left';
  const points = new Float32Array(count * 8);
  const origin = buf[(reversed ? count - 1 : 0) * 3];
  const extent = vertical ? ah : aw;
  const scale = f(extent / (buf[(reversed ? 0 : count - 1) * 3] - origin));
  const across = vertical ? aw : ah;
  const base = vertical ? ax : ay;
  for (let n = 0; n < count; n++) {
    const k = reversed ? count - 1 - n : n;
    const pos = buf[k * 3];
    const local = f((pos - origin) * scale);
    const near = f(base + buf[k * 3 + 1]);
    const far = f(base + across + buf[k * 3 + 2]);
    if (vertical) points.set([0, local, near, pos, across, local, far, pos], n * 8);
    else { points.set([local, 0, pos, near], n * 4); points.set([local, across, pos, far], (count + n) * 4); }
  }
  return vertical ? { columns: 2, rows: count, points } : { columns: count, rows: 2, points };
}

// matrix3d taking (0,0,w,h) onto quad [tlx,tly, trx,try, brx,bry, blx,bly]
function quadMatrix(q, w, h) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, k = 0;
  if (Math.abs(dx3) > 1e-6 || Math.abs(dy3) > 1e-6) {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-9) return null;
    g = (dx3 * dy2 - dx2 * dy3) / det;
    k = (dx1 * dy3 - dx3 * dy1) / det;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + k * x3, d = y1 - y0 + g * y1, e = y3 - y0 + k * y3;
  const v = [a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, x0, y0, 0, 1];
  for (let n = 0; n < 16; n++) if (!Number.isFinite(v[n])) return null;
  return `matrix3d(${v.map(x => +x.toFixed(7)).join(',')})`;
}

// The quads of a mesh, in order from the window's far edge to the source:
// { tl, tr, br, bl } vertex offsets, and u/v of the source sub-rect.
function* quads(mesh) {
  const { columns, rows, points } = mesh;
  const at = (c, r) => (r * columns + c) * 4;
  const across = columns === 2;
  const count = across ? rows - 1 : columns - 1;
  for (let n = 0; n < count; n++) {
    yield across
      ? [at(0, n), at(1, n), at(1, n + 1), at(0, n + 1), true]
      : [at(n, 0), at(n + 1, 0), at(n + 1, 1), at(n, 1), false];
  }
}

// Outline polygon of the mesh (screen space), clockwise.
function outline(mesh) {
  const { columns, rows, points } = mesh;
  const at = (c, r) => (r * columns + c) * 4;
  const out = [];
  if (columns === 2) {
    for (let r = 0; r < rows; r++) out.push(points[at(0, r) + 2], points[at(0, r) + 3]);
    for (let r = rows - 1; r >= 0; r--) out.push(points[at(1, r) + 2], points[at(1, r) + 3]);
  } else {
    for (let c = 0; c < columns; c++) out.push(points[at(c, 0) + 2], points[at(c, 0) + 3]);
    for (let c = columns - 1; c >= 0; c--) out.push(points[at(c, 1) + 2], points[at(c, 1) + 3]);
  }
  return out;
}

/* ── geometry helpers ───────────────────────────────────────────────────── */
const rectOf = r => r && ({ x: r.x ?? r.left, y: r.y ?? r.top, width: r.width, height: r.height });
const divide = (r, s) => ({ x: r.x / s, y: r.y / s, width: r.width / s, height: r.height / s });

// When the source sits under the window (a strip tile behind it), the Dock's
// own answer is to slide the window off the source first (its "overlap" push)
// and then pour. Pick the side where that push sends the least of the window
// off-screen, then the smallest push.
// springboard controller pickEdge('auto'): the side the source is on, seen
// from the window's centre. (The caller keeps the source out from under the
// window, as the Dock always is, so no overlap push is needed.)
function pickEdge(w, i) {
  const dx = i.x + i.width / 2 - (w.x + w.width / 2);
  const dy = i.y + i.height / 2 - (w.y + w.height / 2);
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? 'bottom' : 'top';
  return dx >= 0 ? 'right' : 'left';
}

function onScreen(r) {
  if (!r || !(r.width > 0) || !(r.height > 0)) return false;
  const vw = innerWidth, vh = innerHeight;
  const ix = Math.min(r.x + r.width, vw) - Math.max(r.x, 0);
  const iy = Math.min(r.y + r.height, vh) - Math.max(r.y, 0);
  return ix >= Math.min(8, r.width / 2) && iy >= Math.min(8, r.height / 2);
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── renderer: slices (DOM copies projected per quad) ───────────────────── */
// One host per window, kept in the DOM (empty, 0x0) between runs. It is a
// layout boundary (size + layout containment), so adding and tearing down the
// copies inside it never relayouts the window or the page around it.
const hosts = new WeakMap();
function hostFor(el, cfg) {
  let host = hosts.get(el);
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.dataset.genieHost = '';
    const hs = host.style;
    hs.position = 'fixed'; hs.left = '0'; hs.top = '0'; hs.width = '0'; hs.height = '0';
    hs.overflow = 'visible'; hs.pointerEvents = 'none'; hs.margin = '0'; hs.padding = '0';
    hs.contain = 'size layout style';
    hosts.set(el, host);
  }
  host.style.zIndex = cfg.zIndex === '' ? '' : String(cfg.zIndex);
  if (host.previousSibling !== el) el.after(host);
  return host;
}


/* ── the window's shadow, drawn once under the slices (springboard shadow.ts, MIT) ──
   Clipping the box-shadow into every strip would seam it, so it is redrawn as
   an SVG path following the warped outline, with a hole cut where the window
   is (a box-shadow only paints outside the border box). */
const SVGNS = 'http://www.w3.org/2000/svg';
const ARC_STEPS = 6;
const clamp01 = v => Math.min(1, Math.max(0, v));
function parseShadows(value) {
  if (!value || value === 'none') return [];
  const out = [];
  for (const part of value.split(/,(?![^(]*\))/)) {
    if (part.includes('inset')) continue;
    const color = part.match(/[a-z-]+\([^)]*\)|#[\da-f]+/i)?.[0] ?? '#000';
    const lengths = part.replace(color, '').match(/-?[\d.]+(?=px)/g) ?? [];
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths.map(Number);
    if (blur === 0 && spread <= 0) continue;
    out.push({ x, y, blur, spread, color });
  }
  return out;
}
function warpedOutline(mesh, width, height, [tl, tr, br, bl]) {
  const { columns, points } = mesh;
  const across = columns === 2;
  const at = (c, r) => (r * columns + c) * 4;
  const count = across ? mesh.rows : columns;
  const key = i => (across ? points[at(0, i) + 1] : points[at(i, 0)]);
  const out = [];
  const map = (u, v) => {
    const along = across ? v : u;
    let i = 0;
    while (i < count - 2 && key(i + 1) < along) i++;
    const span = key(i + 1) - key(i);
    const t = span > 0 ? clamp01((along - key(i)) / span) : 0;
    const sv = clamp01(across ? u / width : v / height);
    const a = across ? at(0, i) : at(i, 0), b = across ? at(1, i) : at(i, 1);
    const c = across ? at(0, i + 1) : at(i + 1, 0), e = across ? at(1, i + 1) : at(i + 1, 1);
    for (const ax of [2, 3]) {
      const near = points[a + ax] + (points[b + ax] - points[a + ax]) * sv;
      const far = points[c + ax] + (points[e + ax] - points[c + ax]) * sv;
      out.push(near + (far - near) * t);
    }
  };
  const arc = (cx, cy, r, from) => { for (let n = 0; n <= ARC_STEPS; n++) { const g = from + (n / ARC_STEPS) * (PI / 2); map(cx + Math.cos(g) * r, cy + Math.sin(g) * r); } };
  const edge = (from, to, fixed, alongU) => {
    if (alongU === across) return;
    const step = from < to ? 1 : -1;
    const keys = Array.from({ length: count }, (_, i) => key(i));
    if (step < 0) keys.reverse();
    for (const k of keys) if ((k - from) * step > 0 && (to - k) * step > 0) alongU ? map(k, fixed) : map(fixed, k);
  };
  arc(tl, tl, tl, PI); edge(tl, width - tr, 0, true);
  arc(width - tr, tr, tr, -PI / 2); edge(tr, height - br, width, false);
  arc(width - br, height - br, br, 0); edge(width - br, bl, height, true);
  arc(bl, height - bl, bl, PI / 2); edge(height - bl, tl, 0, false);
  return out;
}
function polyArea(o) { let s = 0; for (let i = 0; i < o.length; i += 2) { const j = (i + 2) % o.length; s += o[i] * o[j + 1] - o[j] * o[i + 1]; } return Math.abs(s) / 2; }
function createShadow(parent, el, width, height) {
  const st = getComputedStyle(el);
  const shadows = parseShadows(st.boxShadow);
  const radii = [st.borderTopLeftRadius, st.borderTopRightRadius, st.borderBottomRightRadius, st.borderBottomLeftRadius]
    .map(r => Math.min(parseFloat(r) || 0, width / 2, height / 2));
  const group = document.createElement('div');
  Object.assign(group.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', overflow: 'visible', pointerEvents: 'none' });
  if (shadows.length) parent.append(group);
  const paths = shadows.slice().reverse().map(sh => {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    Object.assign(svg.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', overflow: 'visible', pointerEvents: 'none' });
    const path = document.createElementNS(SVGNS, 'path');
    if (sh.blur === 0) { path.setAttribute('fill', 'none'); path.setAttribute('stroke', sh.color); } else path.setAttribute('fill', sh.color);
    svg.append(path); group.append(svg);
    return { svg, path, sh };
  });
  return {
    draw(mesh, visible) {
      if (!paths.length) return;
      group.style.visibility = visible ? '' : 'hidden';
      if (!visible) return;
      const o = warpedOutline(mesh, width, height, radii);
      const k = Math.min(1, Math.sqrt(polyArea(o) / (width * height)));
      let d = '';
      for (let i = 0; i < o.length; i += 2) d += `${i ? 'L' : 'M'}${o[i].toFixed(2)} ${o[i + 1].toFixed(2)}`;
      d += 'Z';
      group.style.clipPath = `path(evenodd, "M-99999 -99999H99999V99999H-99999Z${d}")`;
      for (const { svg, path, sh } of paths) {
        path.setAttribute('d', d);
        svg.style.translate = `${sh.x * k}px ${sh.y * k}px`;
        if (sh.blur === 0) path.setAttribute('stroke-width', `${sh.spread * 2 * k}`);
        else svg.style.filter = `blur(${(sh.blur / 2) * k}px)`;
      }
    },
    dispose() { group.remove(); },
  };
}

function createSlices(el, w, cfg) {
  const layer = document.createElement('div');
  layer.dataset.genie = '';
  const ls = layer.style;
  ls.position = 'absolute'; ls.left = '0'; ls.top = '0'; ls.width = '0'; ls.height = '0';
  ls.overflow = 'visible'; ls.pointerEvents = 'none';
  const host = hostFor(el, cfg);
  const shadow = cfg.shadow === false ? { draw() {}, dispose() {} } : createShadow(host, el, w.width, w.height);   // under the slices (off: a blurred full-screen path re-rasters every frame)
  host.append(layer);
  if (Number.isFinite(cfg.floorY)) ls.clipPath = `polygon(-100000px -100000px, 100000px -100000px, 100000px ${cfg.floorY}px, -100000px ${cfg.floorY}px)`;   // nothing drawn below the target's top

  // Template: one static copy of the window. Scroll offsets and video/canvas
  // frames are not carried by cloneNode, so note them now.
  const srcAll = el.getElementsByTagName('*');
  const scrolls = [];
  if (el.scrollTop || el.scrollLeft) scrolls.push([-1, el.scrollTop, el.scrollLeft]);
  for (let n = 0; n < srcAll.length; n++) {
    const s = srcAll[n];
    if (s.scrollTop || s.scrollLeft) scrolls.push([n, s.scrollTop, s.scrollLeft]);
  }
  const tpl = el.cloneNode(true);
  const tplAll = tpl.getElementsByTagName('*');
  const scrollRefs = scrolls.map(([n, t, l]) => [n < 0 ? tpl : tplAll[n], t, l]);
  // caller's chance to lighten the copy (drop blur layers, off-screen media, videos) before N copies are made
  try { cfg.prepare?.(tpl, el); } catch (_) {}
  // frames to paint per copy: [templateElement, sourceVideoOrCanvas]
  const frames = [];
  const vids = [...el.querySelectorAll('video, canvas')];
  const tvids = [...tpl.querySelectorAll('video, canvas')];
  if (tvids.length === vids.length) tvids.forEach((tv, n) => {
    const sv = vids[n];
    const isVideo = sv.tagName === 'VIDEO';
    const ok = isVideo ? sv.readyState >= 2 && sv.videoWidth : sv.width && sv.height;
    if (!ok) {   // a still poster is the best a copy can do; never let a copy load or play
      if (isVideo) { tv.removeAttribute('src'); tv.removeAttribute('autoplay'); tv.preload = 'none'; tv.querySelectorAll('source').forEach(s => s.remove()); }
      return;
    }
    const c = document.createElement('canvas');
    c.className = tv.className;
    c.width = isVideo ? sv.videoWidth : sv.width;
    c.height = isVideo ? sv.videoHeight : sv.height;
    const cs = getComputedStyle(sv);
    c.style.cssText = tv.style.cssText;
    c.style.width = cs.width; c.style.height = cs.height;
    c.style.objectFit = cs.objectFit; c.style.objectPosition = cs.objectPosition;
    c.style.display = cs.display === 'inline' ? 'inline-block' : cs.display;
    tv.replaceWith(c);
    frames.push([c, sv]);
  });
  for (const node of [tpl, ...tpl.querySelectorAll('[id]')]) node.removeAttribute('id');
  tpl.setAttribute('aria-hidden', 'true');
  tpl.inert = true;
  const imp = (k, v) => tpl.style.setProperty(k, v, 'important');
  imp('position', 'absolute'); imp('inset', 'auto'); imp('left', '0'); imp('top', '0');
  imp('margin', '0'); imp('box-sizing', 'border-box');
  imp('width', w.width + 'px'); imp('height', w.height + 'px');
  imp('transform', 'none'); imp('translate', 'none'); imp('scale', 'none'); imp('rotate', 'none');
  imp('transition', 'none'); imp('animation', 'none'); imp('opacity', '1');
  imp('visibility', 'visible'); imp('pointer-events', 'none'); imp('clip-path', 'none');
  const tplFrames = frames.map(([c]) => [...tpl.querySelectorAll('canvas')].indexOf(c));
  const tplScrolls = scrollRefs.map(([node, t, l]) => [node === tpl ? -1 : [...tpl.getElementsByTagName('*')].indexOf(node), t, l]);

  const pool = [];
  let fresh = [];
  const slice = n => {
    let item = pool[n];
    if (item) return item;
    const strip = document.createElement('div');
    const s = strip.style;
    s.position = 'absolute'; s.left = '0'; s.top = '0'; s.overflow = 'hidden';
    s.transformOrigin = '0 0'; s.pointerEvents = 'none'; s.backfaceVisibility = 'hidden';
    s.contain = 'strict'; s.willChange = 'transform';
    const copy = tpl.cloneNode(true);
    // the copy is its own layer, rastered once: the per-frame offset below (the adaptive
    // mesh moves each strip's source band every frame) and the strip's box are then
    // compositor-only changes, never a repaint of the copy
    copy.style.setProperty('will-change', 'transform', 'important');
    strip.append(copy);
    layer.append(strip);
    item = { strip, copy, shown: true };
    pool[n] = item;
    fresh.push(item);
    return item;
  };
  const paintFresh = () => {
    if (!fresh.length) return;
    for (const { copy } of fresh) {
      if (tplFrames.length) {
        const cs = copy.querySelectorAll('canvas');
        tplFrames.forEach((ix, n) => { try { cs[ix]?.getContext('2d').drawImage(frames[n][1], 0, 0); } catch (_) {} });
      }
      if (tplScrolls.length) {
        const all = copy.getElementsByTagName('*');
        for (const [ix, t, l] of tplScrolls) { const node = ix < 0 ? copy : all[ix]; if (node) { node.scrollTop = t; node.scrollLeft = l; } }
      }
    }
    fresh = [];
  };

  return {
    layer,
    draw(mesh, p) {
      const pts = mesh.points;
      let used = 0;
      for (const [tl, tr, br, bl, across] of quads(mesh)) {
        if (used >= cfg.maxSlices) break;
        const u0 = pts[tl], v0 = pts[tl + 1], w0 = pts[br] - u0, h0 = pts[br + 1] - v0;
        if (w0 < 0.01 || h0 < 0.01) continue;
        const q = [pts[tl + 2], pts[tl + 3], pts[tr + 2], pts[tr + 3], pts[br + 2], pts[br + 3], pts[bl + 2], pts[bl + 3]];
        const m = quadMatrix(q, w0, h0);
        if (!m) continue;
        // overlap neighbours by half a screen pixel so seams never show
        const local = across ? h0 : w0;
        const travelled = across ? Math.hypot(q[6] - q[0], q[7] - q[1]) : Math.hypot(q[2] - q[0], q[3] - q[1]);
        const pad = Math.min(local / 2, (cfg.seam * local) / Math.max(travelled, 0.5));
        const px = across ? 0 : pad, py = across ? pad : 0;
        const item = slice(used++);
        const s = item.strip.style;
        if (!item.shown) { s.opacity = ''; item.shown = true; }
        // size and offset change only when they move by a pixel (a size change re-rasters the copy)
        // sizes snap up to 32 px steps (neighbours overlap a little), so a strip's box rarely changes during a run
        const W = Math.ceil((w0 + px * 2) / 32) * 32, H = Math.ceil((h0 + py * 2) / 32) * 32;
        if (item.W !== W) { s.width = W + 'px'; item.W = W; }
        if (item.H !== H) { s.height = H + 'px'; item.H = H; }
        s.transform = `${m} translate(${-px}px,${-py}px)`;
        const tx = (px - u0).toFixed(1), ty = (py - v0).toFixed(1);
        if (item.tx !== tx || item.ty !== ty) { item.copy.style.translate = `${tx}px ${ty}px`; item.tx = tx; item.ty = ty; }
      }
      for (let n = used; n < pool.length; n++) if (pool[n].shown) { pool[n].strip.style.opacity = '0'; pool[n].shown = false; }   // opacity, not display: the layer and its raster stay
      paintFresh();
      shadow.draw(mesh, p >= cfg.handoff);   // the window keeps its own shadow until the hand-off
      ls.opacity = String(opacityAt(p, cfg));
      return used;
    },
    get count() { return pool.length; },
    dispose() {
      // Hide now (paint only), remove when the main thread is idle: tearing
      // down N copies costs a layout, which should not land on the frame the
      // live window appears in.
      ls.opacity = '0';
      shadow.dispose();
      pool.length = 0;
      const gone = () => layer.remove();
      if (typeof requestIdleCallback === 'function') requestIdleCallback(gone, { timeout: 500 });
      else setTimeout(gone, 120);
    },
  };
}

function opacityAt(p, cfg) {
  const hand = p < cfg.handoff ? p / cfg.handoff : 1;           // cross-fade with the live window
  if (cfg.fadeFrom >= 1) return hand;
  const t = Math.min(Math.max((p - cfg.fadeFrom) / (1 - cfg.fadeFrom), 0), 1);
  return hand * (1 - t * t * (3 - 2 * t));
}

/* ── renderer: clip (live element, scaled into the funnel box + polygon) ── */
function createClip(el, w, cfg) {
  const saved = ['transform', 'transform-origin', 'clip-path', 'opacity', 'will-change', 'translate', 'scale']
    .map(k => [k, el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]);
  const s = el.style;
  s.setProperty('transform-origin', '0 0', 'important');
  s.setProperty('translate', 'none', 'important');
  s.setProperty('scale', 'none', 'important');
  return {
    layer: null,
    draw(mesh, p) {
      const o = outline(mesh);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let n = 0; n < o.length; n += 2) {
        if (o[n] < x0) x0 = o[n]; if (o[n] > x1) x1 = o[n];
        if (o[n + 1] < y0) y0 = o[n + 1]; if (o[n + 1] > y1) y1 = o[n + 1];
      }
      const sx = Math.max((x1 - x0) / w.width, 1e-4), sy = Math.max((y1 - y0) / w.height, 1e-4);
      s.setProperty('transform', `translate(${x0 - w.x}px,${y0 - w.y}px) scale(${sx},${sy})`, 'important');
      let poly = '';
      for (let n = 0; n < o.length; n += 2) poly += `${n ? ',' : ''}${((o[n] - x0) / sx).toFixed(2)}px ${((o[n + 1] - y0) / sy).toFixed(2)}px`;
      s.setProperty('clip-path', p < cfg.handoff ? 'none' : `polygon(${poly})`, 'important');
      s.setProperty('opacity', String(cfg.fadeFrom >= 1 ? 1 : opacityAt(Math.max(p, cfg.handoff), cfg)), 'important');
      return o.length / 4 - 1;
    },
    get count() { return 0; },
    dispose() { for (const [k, v, pr] of saved) v ? s.setProperty(k, v, pr) : s.removeProperty(k); },
  };
}

// Hides the live element without a layout: opacity 0 and no hits. Restores
// whatever inline values were there before.
const veiled = new WeakMap();
function veil(el, on) {
  const s = el.style;
  if (on && !veiled.has(el)) {
    veiled.set(el, ['opacity', 'pointer-events'].map(k => [k, s.getPropertyValue(k), s.getPropertyPriority(k)]));
    s.setProperty('opacity', '0', 'important');
    s.setProperty('pointer-events', 'none', 'important');
  } else if (!on && veiled.has(el)) {
    for (const [k, v, pr] of veiled.get(el)) v ? s.setProperty(k, v, pr) : s.removeProperty(k);
    veiled.delete(el);
  }
}

/* ── the instance ───────────────────────────────────────────────────────── */
export function createGenie(options = {}) {
  const cfg = { ...GENIE_DEFAULTS, ...options };
  const runs = new WeakMap();   // el -> state

  const supported = typeof document !== 'undefined' && typeof CSS !== 'undefined' &&
    CSS.supports('transform', 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)');

  function config() {
    const c = { ...cfg };
    c.curve = makeCurve(cfg.tension);
    c.buf = new Float32Array(CAPACITY);
    c.scale = cfg.pointScale === 'auto' ? Math.min(1.5, Math.max(0.3, innerWidth / 1440)) : +cfg.pointScale || 1;
    return c;
  }

  function handleFor(promise, st) {
    promise.finish = () => { if (st.active) st.finishNow(); return promise; };
    promise.seek = p => { if (st.active) st.seek(p); return promise; };
    Object.defineProperty(promise, 'progress', { get: () => st.p });
    promise.technique = st.technique;
    return promise;
  }

  // simple WAAPI paths (reduced motion / off-screen source)
  function simple(el, goal, kind) {
    const prev = runs.get(el);
    let p = prev ? prev.p : goal === 0 ? 1 : 0;
    if (prev) prev.abort();
    const st = { p, active: true, technique: kind };
    runs.set(el, st);
    el.style.visibility = '';
    const ms = (kind === 'reduced' ? cfg.reducedMs : cfg.plainMs) * Math.max(Math.abs(goal - p), 0.15);
    const shrink = kind === 'plain' ? 0.96 : 1;
    const frameAt = q => ({ opacity: 1 - q, transform: shrink === 1 ? 'none' : `scale(${1 - (1 - shrink) * q})` });
    const anim = el.animate([frameAt(p), frameAt(goal)], { duration: ms / (instance.speed || 1), easing: goal ? 'cubic-bezier(.4,0,1,1)' : 'cubic-bezier(0,0,.2,1)', fill: 'forwards' });
    let resolve;
    const promise = new Promise(r => (resolve = r));
    const end = interrupted => {
      if (!st.active) return;
      st.active = false;
      st.p = interrupted ? st.p : goal;
      try { anim.commitStyles?.(); } catch (_) {}
      anim.cancel();
      el.style.removeProperty('opacity'); el.style.removeProperty('transform');
      if (!interrupted && goal === 1) el.style.visibility = 'hidden';
      if (runs.get(el) === st && !interrupted) runs.delete(el);
      resolve({ interrupted, technique: kind });
    };
    st.abort = () => { const t = anim.currentTime / anim.effect.getTiming().duration; st.p = p + (goal - p) * Math.min(1, t || 0); end(true); };
    st.finishNow = () => end(false);
    st.seek = q => { anim.pause(); anim.currentTime = Math.abs((q - p) / ((goal - p) || 1)) * anim.effect.getTiming().duration; st.p = q; };
    anim.finished.then(() => end(false), () => {});
    return handleFor(promise, st);
  }

  function start(el, source, to, goal, edgeOpt = cfg.edge) {
    if (!el) throw new Error('genie: el is required');
    const icon = rectOf(source);
    const rm = instance.reducedMotion;
    if (rm === 'always' || (rm !== 'never' && reducedMotion())) return simple(el, goal, 'reduced');
    if (!supported || !onScreen(icon)) return simple(el, goal, 'plain');

    const prev = runs.get(el);
    const c = config();
    let w = rectOf(to) || (prev && prev.w) || rectOf(el.getBoundingClientRect());
    let p = prev ? prev.p : goal === 0 ? 1 : 0;
    // reuse the renderer when the geometry is unchanged, so a reversal is seamless
    let renderer = null, technique;
    const same = prev && prev.renderer && prev.w && Math.abs(prev.w.x - w.x) < 1 && Math.abs(prev.w.y - w.y) < 1 &&
      Math.abs(prev.w.width - w.width) < 1 && Math.abs(prev.w.height - w.height) < 1;
    if (prev) {
      if (same) { renderer = prev.renderer; technique = prev.technique; prev.detach(); }
      else prev.abort();
    }
    const tBuild = performance.now();
    if (!renderer) {
      technique = cfg.technique === 'auto'
        ? (el.getElementsByTagName('*').length > cfg.maxNodes ? 'clip' : 'slices')
        : cfg.technique;
      renderer = technique === 'clip' ? createClip(el, w, c) : createSlices(el, w, c);
    }
    const buildMs = performance.now() - tBuild;
    const gaps = []; let lastT = 0, maxQuads = 0;
    const pts = { w: divide(w, c.scale), i: divide(icon, c.scale) };
    // the Dock's side: given (e.g. 'bottom' for a folder row along the bottom), or picked like springboard's 'auto'
    const edge = edgeOpt && edgeOpt !== 'auto' ? edgeOpt : pickEdge(w, icon);
    const st = { p, w, renderer, technique, active: true, edge, paused: false };
    runs.set(el, st);
    const total = goal === 0 ? cfg.openMs : cfg.closeMs;
    let resolve;
    const promise = new Promise(r => (resolve = r));
    let raf = 0, last = 0;

    const draw = q => {
      const t0 = performance.now();
      const inFlight = Math.min(Math.max(q, 1e-4), 1 - 1e-4);
      const mesh = genieMesh(inFlight, pts.w, pts.i, edge, c);
      if (c.scale !== 1) for (let n = 0; n < mesh.points.length; n++) mesh.points[n] *= c.scale;
      const quadsDrawn = renderer.draw(mesh, q);
      if (cfg.debug) { const n = performance.now(); if (lastT) gaps.push(n - lastT); lastT = n; maxQuads = Math.max(maxQuads, quadsDrawn); }
      // live element: visible only under the cross-fade (and never for 'clip', where it IS the drawing)
      // (opacity + pointer-events, not visibility: toggling visibility on a big
      // subtree costs a layout, measured ~8 ms on the frame the window lands)
      el.style.visibility = '';
      if (technique === 'slices') veil(el, q >= c.handoff);
      cfg.onFrame?.({ p: q, ms: performance.now() - t0, quads: quadsDrawn, technique, edge, copies: renderer.count });
    };

    const end = interrupted => {
      if (!st.active) return;
      st.active = false;
      cancelAnimationFrame(raf);
      if (!interrupted) {
        st.p = goal;
        renderer.dispose();
        if (goal === 1) el.style.visibility = 'hidden';
        veil(el, false);
        if (runs.get(el) === st) runs.delete(el);
      }
      if (cfg.debug && gaps.length) {
        const g = gaps.slice().sort((a, b) => a - b), at = q => g[Math.min(g.length - 1, Math.floor(g.length * q))];
        console.log(`[wavedebug] genie ${goal ? 'close' : 'open'}${interrupted ? ' (interrupted)' : ''}: wall ${(performance.now() - t0).toFixed(0)} ms (set ${total} ms) · clone ${buildMs.toFixed(1)} ms · strips ≤${maxQuads} · ${g.length + 1} frames · gap median ${at(.5).toFixed(1)} / p95 ${at(.95).toFixed(1)} / max ${g[g.length - 1].toFixed(1)} ms · >12 ms ${g.filter(x => x > 12).length} · >20 ms ${g.filter(x => x > 20).length}`);
      }
      resolve({ interrupted, technique });
    };
    st.detach = () => { cancelAnimationFrame(raf); st.active = false; resolve({ interrupted: true, technique }); };
    st.abort = () => { cancelAnimationFrame(raf); renderer.dispose(); veil(el, false); st.active = false; resolve({ interrupted: true, technique }); };
    st.finishNow = () => end(false);
    st.seek = q => { st.paused = true; cancelAnimationFrame(raf); st.p = Math.min(Math.max(q, 0), 1); draw(st.p); };

    // wall clock: progress comes from the time since the run started, so slow
    // frames are dropped and the run still ends on time (the Dock's linear 0.5 s)
    // the clock runs on a linear variable; the mesh gets lin^tail (same ends, softer landing)
    const k = cfg.tail > 0 ? cfg.tail : 1;
    const p0 = Math.pow(st.p, 1 / k), sign = goal > st.p ? 1 : -1;
    let t0 = 0;
    const tick = now => {
      if (!st.active || st.paused) return;
      now = performance.now();
      const lin = sign > 0 ? Math.min(goal, p0 + ((now - t0) * (instance.speed || 1)) / total) : Math.max(goal, p0 - ((now - t0) * (instance.speed || 1)) / total);
      st.p = Math.pow(lin, k);
      if (st.p === goal) { end(false); return; }
      draw(st.p);
      raf = requestAnimationFrame(tick);
    };

    if (st.p === goal) { draw(goal); end(false); return handleFor(promise, st); }
    // first frame now, synchronously: the copies replace the element before the next paint
    last = t0 = performance.now();
    draw(st.p);
    raf = requestAnimationFrame(tick);
    return handleFor(promise, st);
  }

  const instance = {
    supported,
    speed: cfg.speed,                  // live: change mid-run for slow motion
    reducedMotion: cfg.reducedMotion,  // 'user' | 'always' | 'never'
    config: cfg,                       // live: technique, openMs, closeMs, tolerance... read at each run
    open({ el, from, to, edge, floorY } = {}) { cfg.floorY = floorY; return start(el, from, to, 0, edge); },
    close({ el, to, edge, floorY } = {}) { cfg.floorY = floorY; return start(el, to, null, 1, edge); },
    /** Where el is: 0 open, 1 inside its source, or null when idle. */
    progressOf(el) { return runs.get(el)?.p ?? null; },
  };
  return instance;
}

/** Test hook: the mesh this module draws at progress p (screen px), for comparisons with the reference. */
export function meshAt(p, w, i, edge = 'bottom', options = {}) {
  const c = { ...GENIE_DEFAULTS, ...options };
  c.curve = makeCurve(c.tension); c.buf = new Float32Array(CAPACITY);
  return genieMesh(Math.min(Math.max(p, 1e-4), 1 - 1e-4), w, i, edge, c);
}
