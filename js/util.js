// Small shared helpers: Cloudinary sizing, media markup, flags.

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isDesktop = () => innerWidth > 768 && matchMedia('(pointer: fine)').matches;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const isVideo = u => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u || '');

/* Cloudinary serves any size off one stored URL: f_auto picks the format,
   c_limit never upscales. Anything that is not Cloudinary passes through. */
export function cdnAt(u, w) {
  if (typeof u !== 'string') return u;
  const marker = u.includes('/video/upload/') ? '/video/upload/' : '/image/upload/';
  const i = u.indexOf(marker);
  if (i === -1) return u;
  const cut = i + marker.length;
  // videos: ask for mp4 explicitly so .mov sources play in every browser
  const tx = marker === '/video/upload/' ? `f_mp4,vc_h264,q_auto,c_limit,w_${w}/` : `f_auto,q_auto,c_limit,w_${w}/`;
  let out = u.slice(0, cut) + tx + u.slice(cut);
  if (marker === '/video/upload/') out = out.replace(/\.(mov|webm|m4v)$/i, '.mp4');
  return out;
}

/* First frame as a poster, so a video box is never blank. */
export function cdnPoster(u, w) {
  const marker = '/video/upload/';
  const i = typeof u === 'string' ? u.indexOf(marker) : -1;
  if (i === -1) return '';
  const cut = i + marker.length;
  return u.slice(0, cut) + `so_0,f_auto,q_auto,c_limit,w_${w}/` + u.slice(cut).replace(/\.[^./]+$/, '.jpg');
}

export function ratioOf(content, url, fallback = 4 / 3) {
  const v = content.dims?.[url];
  if (!v) return fallback;
  const [w, h] = String(v).split('x').map(Number);
  return w && h ? w / h : fallback;
}

/* <img> or a muted looping <video>. crossorigin is set so the element can be
   drawn into the wave transition's canvas (Cloudinary sends ACAO: *). */
export function mediaEl(url, { width = 900, lazy = true, alt = '', cors = true, priority = null } = {}) {
  if (isVideo(url)) {
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true;
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    v.preload = 'none';
    if (cors) v.crossOrigin = 'anonymous';
    v.poster = cdnPoster(url, width);
    v.dataset.src = cdnAt(url, width);
    v.setAttribute('aria-label', alt);
    return v;
  }
  const img = new Image();
  if (cors) img.crossOrigin = 'anonymous';
  if (priority) img.fetchPriority = priority;
  img.decoding = 'async';
  if (lazy) img.loading = 'lazy';
  img.alt = alt;
  img.src = cdnAt(url, width);
  img.draggable = false;
  img.addEventListener('error', () => img.setAttribute('data-failed', ''), { once: true });
  // `is-ready` (the fade-in) is added by holdMedia() below, once decoded
  return img;
}

/* ── Media placeholder (skeleton) ───────────────────────────────────────────
   One look for every media box that is not ready yet: his surface colour, his
   signature as a quiet mark in the middle, a slow low-contrast shimmer. CSS:
   `.media-ph` in css/base.css. holdMedia(box, media, ratio) puts it on `box`
   and takes it off once the picture is decoded or the video has a frame (or
   its poster is decoded): the media fades in over it (`is-ready`), the shimmer
   is removed at once, the mark once the fade is over. On failure the shimmer
   stops and the mark stays (`is-failed`). With box === media (the lightbox,
   the proof bubble: a bare <img>/<video>) it is a static mark, no shimmer.
   While a genie runs (html.is-genie) the hand-off waits for the landing, so a
   window lands showing exactly what its genie copies showed. */
const posterOk = new Set();               // poster URLs already decoded (the genie copies may show them)
export const posterReady = u => !!u && posterOk.has(u);
const root = document.documentElement;
let held = [];
const flush = () => { if (root.classList.contains('is-genie')) return; const q = held; held = []; q.forEach(f => f()); };
new MutationObserver(flush).observe(root, { attributes: true, attributeFilter: ['class'] });
const calm = f => (root.classList.contains('is-genie') ? held.push(f) : f());
// the shimmer pauses while the tab is hidden
document.addEventListener('visibilitychange', () => root.classList.toggle('is-away', document.hidden));

/* The sweep runs only on boxes near the viewport (.is-near), so a long case study
   never animates a dozen boxes at once. Coming near also re-checks the media: if it
   is already rendering, the placeholder clears whatever events were missed. */
const nearIO = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) {
    e.target.classList.toggle('is-near', e.isIntersecting);
    if (e.isIntersecting) e.target._phCheck?.();
  }
}, { rootMargin: '200px' }) : null;
const rendering = m => (m.tagName === 'VIDEO' ? m.readyState >= 2 : !!(m.getAttribute('src') && m.complete && m.naturalWidth));

export function holdMedia(box, m = box, ratio = 0) {
  const self = box === m;
  let settled = false;
  box.classList.add('media-ph');
  if (!self) {
    box.classList.add('is-loading');
    box._phCheck = () => { if (rendering(m)) settle(true); };
    nearIO ? nearIO.observe(box) : box.classList.add('is-near');
  }
  if (ratio) box.style.setProperty('--ph-k', Math.min(1, 1 / ratio).toFixed(3));
  const settle = ok => {
    if (settled) return;
    settled = true;
    if (!self) { nearIO?.unobserve(box); box._phCheck = null; }
    calm(() => {
      box.classList.remove('is-loading', 'is-near');
      if (!ok) { box.classList.add('is-failed'); return; }
      m.classList.add('is-ready');
      // the mark goes once the media covers it (a transparent PNG must not show it through)
      if (self || reducedMotion()) box.classList.remove('media-ph');
      else setTimeout(() => box.classList.remove('media-ph'), 240);
    });
  };
  if (m.tagName === 'VIDEO') {
    if (m.readyState >= 2) { settle(true); return; }
    m.addEventListener('loadeddata', () => settle(true), { once: true });
    const pu = m.getAttribute('poster');
    if (pu) {
      if (posterOk.has(pu)) settle(true);
      else {
        // the poster as an image of its own: once decoded it is in the memory cache, so the
        // genie copies can show it with no wait (js/windows.js lighten)
        const p = new Image();
        p.decoding = 'async';
        p.src = pu;
        p.decode().then(() => { posterOk.add(pu); settle(true); }, () => { m.addEventListener('error', () => settle(false), { once: true }); });
      }
    } else m.addEventListener('error', () => settle(false), { once: true });
    return;
  }
  // image: decoded = shown. No src yet (the strip's deferred tiles) means: wait for one
  const decoded = () => (m.decode ? m.decode() : Promise.resolve()).then(() => settle(true), () => settle(!!m.naturalWidth));
  // already complete when held (memory cache, a warm reopen): shown at once, with no fade, as before
  if (m.getAttribute('src') && m.complete) { settle(!!m.naturalWidth); return; }
  m.addEventListener('load', decoded, { once: true });
  m.addEventListener('error', () => settle(false), { once: true });
}

/* Videos only load and play while they are on screen. */
const vio = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) {
    const v = e.target;
    if (e.isIntersecting) {
      if (!v.src && v.dataset.src) v.src = v.dataset.src;
      if (!reducedMotion()) v.play().catch(() => {});
    } else if (!v.paused) v.pause();
  }
}, { rootMargin: '200px' }) : null;
export function watchVideo(v) { if (v.tagName === 'VIDEO') vio ? vio.observe(v) : (v.src = v.dataset.src); }
export function unwatchVideo(v) { if (vio && v.tagName === 'VIDEO') vio.unobserve(v); }
