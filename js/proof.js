// The "original message" proof as a drawn speech bubble anchored to its link.
// Hover (with intent) or focus shows it, click/tap pins it; no modal, no route.
// The bubble lives in the top layer (body), positioned from the link's rect,
// so the window's scroll container never clips it.
import { cdnAt, reducedMotion, holdMedia } from './util.js';
import { DUR, EASE } from './motion.js';

const OPEN_DELAY = 100, GRACE = 160;
let bubble, img, current = null, pinned = false, openT = 0, closeT = 0, anim = null;

function ensure() {
  if (bubble) return;
  bubble = document.createElement('div');
  bubble.className = 'proof-bubble';
  bubble.id = 'proofBubble';
  bubble.hidden = true;
  bubble.innerHTML = '<img alt="" decoding="async" draggable="false"><span class="tail" aria-hidden="true"></span>';
  img = bubble.querySelector('img');
  document.body.appendChild(bubble);
  bubble.addEventListener('pointerenter', () => clearTimeout(closeT));
  bubble.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !pinned) closeSoon(); });
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && current) { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
  }, true);
  document.addEventListener('pointerdown', e => {
    if (!current || bubble.contains(e.target) || e.target.closest?.('.proof')) return;
    close(true);
  }, true);
  addEventListener('resize', () => current && place());
}

function place() {
  const r = current.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) { close(true); return; }
  const w = +bubble.dataset.w, h = +bubble.dataset.h;
  const above = r.top - h - 14 > 8;
  const cx = r.left + r.width / 2;
  const left = Math.min(Math.max(12, cx - w / 2), innerWidth - w - 12);
  const top = above ? r.top - h - 12 : r.bottom + 12;
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
  bubble.classList.toggle('is-below', !above);
  bubble.style.setProperty('--tail-x', Math.min(Math.max(14, cx - left), w - 14) + 'px');
}

function show(btn, { now = false } = {}) {
  clearTimeout(openT); clearTimeout(closeT);
  const go = () => {
    const wasOpen = !!current && !bubble.hidden;
    const prev = wasOpen ? bubble.getBoundingClientRect() : null;
    if (current && current !== btn) current.setAttribute('aria-expanded', 'false');
    current = btn;
    btn.setAttribute('aria-expanded', 'true');
    const ratio = +btn.dataset.ratio || 4;
    const w = Math.min(360, innerWidth - 24), h = Math.round(w / ratio) + 12;   // 6px paper all round
    bubble.dataset.w = w; bubble.dataset.h = h;
    bubble.style.width = w + 'px'; bubble.style.height = h + 'px';
    img.alt = `Original message from ${btn.dataset.name}`;
    img.src = btn.dataset.src;
    img.classList.remove('media-ph');
    if (!img.complete) holdMedia(img);   // not preloaded yet: the placeholder with his mark until it decodes
    bubble.hidden = false;
    place();
    if (reducedMotion()) return;
    anim?.cancel();
    if (wasOpen && prev) {
      // moving to the next link: glide there instead of closing and reopening
      const now = bubble.getBoundingClientRect();
      anim = bubble.animate([{ transform: `translate(${prev.left - now.left}px, ${prev.top - now.top}px)` }, { transform: 'none' }],
        { duration: DUR.base, easing: EASE.out });
    } else {
      // grows out of its link: origin at the tail tip, a little turn, a soft spring
      const below = bubble.classList.contains('is-below');
      anim = bubble.animate([
        { opacity: 0, transform: `scale(.6) rotate(${below ? 4 : -4}deg)` },
        { opacity: 1, offset: .35 },
        { opacity: 1, transform: 'none' }], { duration: DUR.pop, easing: EASE.spring });
    }
    img.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { duration: DUR.base, delay: wasOpen ? 0 : 120, easing: EASE.out, fill: 'backwards' });
  };
  if (now || current) go(); else openT = setTimeout(go, OPEN_DELAY);
}

function close(force) {
  clearTimeout(openT); clearTimeout(closeT);
  if (!current) return;
  if (pinned && !force) return;
  current.setAttribute('aria-expanded', 'false');
  current = null; pinned = false;
  if (reducedMotion()) { bubble.hidden = true; return; }
  anim?.cancel();
  anim = bubble.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.85)' }], { duration: DUR.fast, easing: EASE.in });
  anim.finished.then(() => { if (!current) bubble.hidden = true; }, () => {});
}
function closeSoon() { clearTimeout(closeT); closeT = setTimeout(() => close(false), GRACE); }

/** Wire every .proof button inside `root` (the Kind words window body). */
export function wireProofs(root, scroller) {
  ensure();
  root.querySelectorAll('.proof').forEach(b => {
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-controls', 'proofBubble');
    b.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') show(b); });
    b.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !pinned) { clearTimeout(openT); closeSoon(); } });
    b.addEventListener('focus', () => show(b, { now: true }));
    b.addEventListener('blur', () => { if (!pinned) closeSoon(); });
    b.addEventListener('click', () => {
      if (current === b && pinned) { close(true); return; }
      show(b, { now: true });
      pinned = true;
    });
  });
  scroller?.addEventListener('scroll', () => current && place(), { passive: true });
  // preload the proofs at a quiet moment so the bubble never waits
  const pre = () => root.querySelectorAll('.proof').forEach(b => { new Image().src = b.dataset.src; });
  'requestIdleCallback' in window ? requestIdleCallback(pre, { timeout: 1500 }) : setTimeout(pre, 300);
}

export function closeProof() { close(true); }
export const proofSrc = (u, w = 720) => cdnAt(u, w);
