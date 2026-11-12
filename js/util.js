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
  // fade in once decoded (the box is already sized, so nothing shifts)
  const ready = () => img.classList.add('is-ready');
  img.addEventListener('load', () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(ready), { once: true });
  return img;
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
