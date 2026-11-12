// Boot: content → info row, folders, strip, routes, footer, walker, waves.
import { esc, isDesktop, cdnAt, isVideo, reducedMotion } from './util.js';
import { DUR, EASE } from './motion.js';
import { createStrip } from './strip.js';
import { initWindows, openWindow, closeWindow, isOpen as winOpen, renderCase, renderKindWords, renderContact } from './windows.js';
import { initLightbox, open as openLightbox, close as closeLightbox, isOpen as lbOpen } from './lightbox.js';
import { themeWave, preloadWaves } from './transition.js';
import { icon } from './icons.js';

const $ = id => document.getElementById(id);
const BASE_TITLE = 'Alex Colombel — Product Designer';
const DEBUG = /[?&]wavedebug\b/.test(location.search);
const MODEL_URL = '/assets/3d/placeholder-walker.glb';
const WALKER_ENABLED = false;

let content = null;
let strip = null;
let walker = null;


/* ── content ─────────────────────────────────────────────────────────────── */
/* Same arrangement as his v1 site: on the live host the freshest content.json is the one in
   the GitHub repo (the CMS commits there and netlify.toml skips the deploy for content-only
   commits), so ask the repo first and fall back to the copy deployed with the page. The repo
   only gets a short head start so a slow answer never delays the page. */
const CONTENT_REPO_URL = 'https://raw.githubusercontent.com/alexclmb/portfolio/main/content.json';
const IS_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.protocol === 'file:';
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(url + ' ' + res.status);
  return res.json();
}
async function loadContent() {
  const deployed = fetchJson('/content.json');
  if (IS_LOCAL) return deployed;
  deployed.catch(() => {});                                   // handled below if it is needed
  try {
    return await Promise.race([
      // only trust the repo copy if it has this site's shape (GitHub's raw host can serve a
      // stale file for a few minutes after a publish; a v1-shaped file must never be used)
      fetchJson(CONTENT_REPO_URL).then(c => {
        if (!Array.isArray(c?.projects) || !Array.isArray(c?.strip) || !c.projects.every(p => 'metricValue' in p)) throw new Error('repo content: old shape');
        return c;
      }),
      new Promise((_, no) => setTimeout(() => no(new Error('repo content: slow')), 700)),
    ]);
  } catch (_) { return deployed; }
}

function fillInfoRow(c) {
  document.querySelectorAll('[data-c]').forEach(el => {
    const k = el.dataset.c;
    const v = { name: c.name, role: c.role, email: c.email, bio: c.bio, availability: c.status?.availability }[k];
    if (v) el.textContent = v;
  });
  if (c.email) $('email').href = `mailto:${c.email}?subject=${encodeURIComponent(c.ctaSubject || 'Project Enquiry')}`;
  if (c.socialCodes) {
    $('socials').innerHTML = c.socialCodes.map(s => {
      const url = s.url || c.socials?.[s.key];
      const ic = { x: 'x', linkedin: 'linkedin', dribbble: 'dribbble' }[s.key] || (/t\.me/.test(url || '') ? 'telegram' : null);
      return url ? `<a class="soc" href="${esc(url)}" aria-label="${esc(s.label)}" target="_blank" rel="noopener"><span class="code">${esc(s.code)}</span>${ic ? icon(ic, 16, 'ico') : ''}</a>` : '';
    }).filter(Boolean).join('');
  }
  if (c.location) $('city').textContent = c.location.city;
  // rating: the value only (content.rating, default 5); no review count anywhere
  const r = c.rating ?? 5;
  const rt = document.querySelector('[data-c="ratingText"]');
  if (rt) rt.textContent = `${r}/5`;
  $('rating')?.setAttribute('aria-label', `Rated ${r} out of 5. Read the reviews`);
}

/* ── folders ─────────────────────────────────────────────────────────────── */
/* A folder is three layers: the back (with its tab), two or three of the
   project's own pictures standing inside it, and the front panel carrying
   the metric sticker. Hover / focus tilts the front open on its bottom edge
   and the pictures rise out of the gap (css: .folder.is-open, :hover). */
const FOLDER_BACK = `<svg class="f-back" viewBox="0 0 56 44" aria-hidden="true"><path d="M2 8A4 4 0 0 1 6 4h13.7c.8 0 1.5.4 2 1l2.6 3.2c.5.6 1.2 1 2 1H50a4 4 0 0 1 4 4V39a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z"/></svg>`;
const FOLDER_FRONT = `<svg viewBox="0 0 56 44" aria-hidden="true"><path d="M1.6 15.2a3.8 3.8 0 0 1 3.8-3.8h45.2a3.8 3.8 0 0 1 3.8 4l-1.3 24A3.8 3.8 0 0 1 49.3 43H6.7a3.8 3.8 0 0 1-3.8-3.6z"/></svg>`;

/* Up to three stills of the project: its strip pictures first, then gallery images. */
function docsFor(c, p) {
  const pi = c.projects.indexOf(p);
  const alias = new Set((c.sameImage || []).flatMap(g => g.slice(1)));
  const id = u => u.split('/').pop().replace(/\.[^.]+$/, '');
  const pool = [
    ...c.strip.filter(s => s.projectIdx === pi).map(s => s.image),
    ...p.blocks.flatMap(b => b.images || [b.image]),
  ];
  const out = [];
  for (const u of pool) {
    if (!u || isVideo(u) || alias.has(id(u)) || out.some(o => id(o) === id(u))) continue;
    out.push(u);
    if (out.length === 3) break;
  }
  return out;
}

/* Stickers: the white sticker (number in blue, unit in grey) is the design. Round 8 tried
   two others; Alex rejected the coloured label tape, so it is gone. The holographic one is
   kept only behind ?sticker=holo, never the default. */
const STICKER = /[?&]sticker=holo\b/.test(location.search) ? 'holo' : '';
if (STICKER) document.documentElement.dataset.sticker = STICKER;

/* which corners of each sticker have lifted (varied so the row does not look stamped) */
const PEEL = ['tr', 'bl', 'br', 'tr bl', 'tl', 'br', 'tr'];

function folderHtml(c, p, tilt, n) {
  const docs = docsFor(c, p).map((u, i) =>
    `<span class="doc" style="--i:${i}"><img data-src="${esc(cdnAt(u, 120))}" alt="" decoding="async" draggable="false"></span>`).join('');
  return `<a class="folder" href="/${esc(p.slug)}" data-route="/${esc(p.slug)}" data-folder="${esc(p.slug)}" style="--n:${n}" aria-label="${esc(`${p.title}, ${p.metric}`)}">
    <span class="folder-icon">${FOLDER_BACK}<span class="docs">${docs}</span><span class="f-front">${FOLDER_FRONT}<span class="sticker" data-peel="${PEEL[n % PEEL.length]}" style="--tilt:${tilt}deg"><b>${esc(p.metricValue || p.metric)}</b>${p.metricUnit ? `<i>${esc(p.metricUnit)}</i>` : ''}</span></span></span>
    <span class="folder-label">${esc(p.title)}</span>
  </a>`;
}

function renderFolders(c) {
  const tilts = [-5, 3, -2, 4, -4, 2, -3];
  const projects = c.folderOrder.map(slug => c.projects.find(p => p.slug === slug)).filter(Boolean);
  $('folders').innerHTML = projects.map((p, i) => folderHtml(c, p, tilts[i % tilts.length], i)).join('');

  // the pictures inside load at a quiet moment, so nothing pops in on first hover
  const fill = () => $('folders').querySelectorAll('img[data-src]').forEach(img => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
  'requestIdleCallback' in window ? requestIdleCallback(fill, { timeout: 2000 }) : setTimeout(fill, 800);

  // hover → the walker wears the project's outfit (none exist yet: null)
  // hover warms the first two pictures of the case, so they are decoded when its window lands
  const warmed = new Set();
  const warm = slug => {
    if (warmed.has(slug)) return;
    warmed.add(slug);
    const p = c.projects.find(q => q.slug === slug);
    (p?.blocks || []).filter(b => b.type !== 'text').slice(0, 2).forEach(b => (b.type === 'duo' ? b.images || [] : [b.image]).forEach(u => {
      if (!u || isVideo(u)) return;
      const im = new Image(); im.crossOrigin = 'anonymous'; im.src = cdnAt(u, b.type === 'duo' ? 900 : 1600);
    }));
  };
  $('folders').addEventListener('pointerover', e => {
    const f = e.target.closest('.folder');
    if (f) warm(f.dataset.folder);
    if (!f || !walker) return;
    const p = c.projects.find(q => q.slug === f.dataset.folder);
    try { walker.setOutfit(p?.outfit ?? null); } catch (_) {}
  });
  $('folders').addEventListener('pointerleave', () => { try { walker?.setOutfit(null); } catch (_) {} });
  // holo stickers: the foil follows the pointer over the folder (two custom properties, no layout)
  if (STICKER === 'holo' && !reducedMotion()) $('folders').addEventListener('pointermove', e => {
    const f = e.target.closest('.folder');
    if (!f || e.pointerType !== 'mouse') return;
    const r = f.getBoundingClientRect();
    f.style.setProperty('--mx', ((e.clientX - r.left) / r.width).toFixed(3));
    f.style.setProperty('--my', ((e.clientY - r.top) / r.height).toFixed(3));
  });
}

/* The folder whose window is open stays open. */
function markOpenFolder(slug) {
  document.querySelectorAll('.folder.is-open').forEach(f => { if (f.dataset.folder !== slug) f.classList.remove('is-open'); });
  if (slug) document.querySelector(`.folder[data-folder="${slug}"]`)?.classList.add('is-open');
}

/* ── routes: /<slug>, /kind-words, /contact (anything else → home) ───────── */
let routeOpts = {};   // per-navigation extras: the picture a case starts at, where it grows from
function routeFor(path) {
  const slug = path.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!slug) return null;
  const p = content.projects.find(q => q.slug === slug);
  if (p) {
    const folder = document.querySelector(`.folder[data-folder="${slug}"]`);
    return { title: p.title, path: '/' + slug, glyph: true, kind: 'case',
      render: renderCase(content, p, { onMedia: openMedia, startAt: routeOpts.startAt }),
      from: routeOpts.from || folder?.querySelector('.folder-icon'), fromRect: routeOpts.fromRect, returnTo: routeOpts.returnTo, fallbackFocus: folder };
  }
  if (slug === 'kind-words') return { title: 'Reviews', path: '/kind-words', kind: 'words', render: renderKindWords(content), from: routeOpts.from || $('rating'), fromRect: routeOpts.fromRect, fresh: routeOpts.fresh };
  if (slug === 'contact') return { title: content.contact?.heading || 'Start a project', sub: content.contact?.sub || "Tell me what you're building.", path: '/contact', kind: 'form', render: renderContact(content), from: routeOpts.from, fromRect: routeOpts.fromRect, fresh: routeOpts.fresh };
  return null;
}

function show(path) {
  const r = routeFor(path);
  if (!r) {
    if (lbOpen()) closeLightbox();
    closeWindow().then(() => markOpenFolder(null));
    setTitle(BASE_TITLE);
    if (location.pathname !== '/') history.replaceState({}, '', '/');   // /about and other old paths
    return false;
  }
  if (lbOpen()) closeLightbox();
  markOpenFolder(r.glyph ? path.replace(/^\/+|\/+$/g, '').toLowerCase() : null);
  openWindow(r);
  setTitle(`${r.title} — ${BASE_TITLE}`);
  return true;
}

function navigate(path, { replace = false, ...opts } = {}) {
  if (path === location.pathname && winOpen()) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  routeOpts = opts;
  show(path);
  routeOpts = {};
}

function requestClose() {
  if (location.pathname !== '/') history.pushState({}, '', '/');
  show('/');
}

/* ── lightbox entry points ───────────────────────────────────────────────── */
/* On-screen rect of a strip tile; a folded tile is the union of its slices. */
function visualRect(tile) {
  if (tile.classList.contains('is-sliced')) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    tile.querySelectorAll('.slice').forEach(s => {
      if (s.style.visibility === 'hidden') return;
      const q = s.getBoundingClientRect();
      l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    });
    if (r > l) return { left: l, top: t, width: r - l, height: b - t };
  }
  const q = tile.getBoundingClientRect();
  return { left: q.left, top: q.top, width: q.width, height: q.height };
}
function openMedia(list, i, from) { openLightbox(list, i, from); }

/* ── tab away: his live site's line, exactly (index.html awayTitle) ─────────── */
const AWAY = '← Still designing over here';
let realTitle = document.title;
function setTitle(t) { realTitle = t; if (!document.hidden) document.title = t; }   // a window opened while away waits for the return
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (document.title !== AWAY) realTitle = document.title; document.title = AWAY; }
  else document.title = realTitle;
});

/* ── footer: local clock (Barcelona runs on the Europe/Madrid zone), theme ─────────────────────────────────────────── */
let clockTimer = 0;
function startClock(tz = 'Europe/Madrid') {
  clearInterval(clockTimer);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const el = $('clock');
  const tick = () => { if (document.documentElement.classList.contains('is-genie')) return;   // nothing repaints during a genie run
    el.textContent = fmt.format(new Date()); el.dateTime = new Date().toISOString(); };
  tick();
  clockTimer = setInterval(tick, 1000);
}

function currentTheme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
function labelTheme(t) {
  $('themeCtl')?.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  labelTheme(t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0a0a0a' : '#ffffff');
  // not remembered: every load starts light (Alex), the switch lasts for this visit
}

async function toggleTheme(origin = $('themeCtl')) {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const r = origin.getBoundingClientRect();
  try { walker?.play('surprised'); walker?.setTheme(next); } catch (_) {}
  // colour-only wave from the control; the page stays visible and the new
  // theme is revealed behind the front (instant under reduced motion)
  const ran = await themeWave({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, () => {
    setTheme(next);
  });
  if (!ran) {
    const root = document.documentElement;
    root.classList.add('theme-fade');
    setTheme(next);
    setTimeout(() => root.classList.remove('theme-fade'), 240);
  }
}

/* ── email: click copies on desktop, mailto on touch ─────────────────────── */
function wireEmail() {
  const a = $('email');
  a.addEventListener('click', async e => {
    if (!isDesktop() || !navigator.clipboard) return;   // phones keep mailto
    e.preventDefault();
    try { await navigator.clipboard.writeText(content?.email || a.textContent.trim()); } catch (_) { location.href = a.href; return; }
    a.classList.add('is-swapped');
    setTimeout(() => a.classList.remove('is-swapped'), 1600);
    try { walker?.play('backflip'); } catch (_) {}
  });
}

/* ── walker (3D figure; optional) ────────────────────────────────────────── */
function loadWalker(now = false) {
  const el = $('walker');
  let done;
  const p = new Promise(r => { done = r; });
  const go = async () => {
    // Walker switched off until Alex's own 3D figure exists (the placeholder is
    // someone else's likeness). Set WALKER_ENABLED = true to bring him back.
    if (!WALKER_ENABLED) { el.hidden = true; done(); return; }
    try {
      const m = await import('./walker.js');
      walker = await m.createWalker(el, { modelUrl: MODEL_URL, theme: currentTheme() });
      // walker:click → he dances by himself (cancelable); we only hold the
      // strip's auto-drift while any gesture plays, as on the reference.
      if (walkerLate) { const f = walkerLate; walkerLate = null; f(); }
      el.addEventListener('walker:gesture', e => {
        const d = e.detail || {};
        if (d.state === 'start') strip?.setHold(true);
        else if (d.state === 'end') strip?.setHold(false);
      });
    } catch (err) {
      walker = null;
      console.info('[walker] unavailable:', err?.message || err);
    }
    done();
  };
  if (now) go();
  else 'requestIdleCallback' in window ? requestIdleCallback(go, { timeout: 600 }) : setTimeout(go, 200);
  return p;
}

/* ── intro: entirely CSS (index.html <head>), from the first paint. Here only:
   any click / key finishes it, the class goes once the morph has landed (so the
   logo ends untransformed in its natural place), and the walker walks in. */
let introWalk = false, walkerLate = null;
function runIntro() {
  const root = document.documentElement;
  if (!root.classList.contains('intro')) return Promise.resolve();
  const SLOW = +getComputedStyle(root).getPropertyValue('--slow') || 1;
  const mine = a => /^(i-|sig-draw)/.test(a.animationName || '');
  const end = () => {
    if (!root.classList.contains('intro')) return;
    root.getAnimations({ subtree: true }).filter(mine).forEach(a => { try { a.finish(); } catch (_) {} });
    root.classList.remove('intro');
    window.__introDone = performance.now();
    if (DEBUG) console.log(`[wavedebug] intro: navigation start → landed ${window.__introDone.toFixed(0)}ms`);
  };
  addEventListener('pointerdown', end, { once: true, capture: true });
  addEventListener('keydown', end, { once: true, capture: true });
  addEventListener('pageshow', e => { if (e.persisted) end(); });
  if (walker) walkIn(SLOW); else walkerLate = () => { if (root.classList.contains('intro')) walkIn(SLOW); };
  // the signature has gone by .78 s; the CSS needs no JS, this only tidies up after it
  return new Promise(r => {
    const a = document.querySelector('.intro-sig')?.getAnimations().find(a => a.animationName === 'i-out');
    (a ? a.finished : Promise.resolve()).catch(() => {}).then(() => { end(); r(); });
    setTimeout(() => { end(); r(); }, 1200 * SLOW);   // hard cap
  });
}

/* The walker walks in from the left to his spot, then the strip takes over. */
function walkIn(SLOW) {
  const el = $('walker');
  if (!walker) return;
  introWalk = true;
  try { walker.setVelocity(180); } catch (_) {}
  const a = el.animate([{ translate: '-38vw 0', opacity: 0 }, { translate: '-30vw 0', opacity: 1, offset: .15 }, { translate: '0 0', opacity: 1 }],
    { duration: 1100 * SLOW, easing: 'cubic-bezier(.3, .6, .4, 1)' });
  a.finished.catch(() => {}).then(() => { introWalk = false; });
}

/* ── boot ────────────────────────────────────────────────────────────────── */
async function boot() {
  wireEmail();
  startClock();
  labelTheme(currentTheme());
  $('themeCtl').addEventListener('click', () => toggleTheme($('themeCtl')));

  try { content = await loadContent(); }
  catch (err) { console.error('[content] failed to load', err); return; }

  fillInfoRow(content);
  startClock(content.location?.tz);
  renderFolders(content);

  strip = createStrip($('strip'), $('stripTrack'), content, {
    // a strip picture opens its project, starting at that picture and growing out of it
    onOpen: (i, tile) => {
      const it = strip.items[i];
      window.__openT = performance.now();
      // the project's window pours out of its FOLDER (always in view at the bottom: the
      // Dock case of the reference), and opens scrolled to the picture that was clicked
      navigate('/' + it.project.slug, { returnTo: tile });   // the cover leads the project: the window starts at its top
    },
    onFrame: v => { if (walker && !introWalk) { try { walker.setVelocity(v); } catch (_) {} } },
  });

  if (DEBUG) window.__strip = strip;   // ?wavedebug: __strip.velocity (px/s)
  const pauseStrip = () => strip.setPaused(winOpen() || lbOpen());
  // while the genie runs, the home underneath stops drawing (strip and walker), so every frame goes to the warp
  const onGenie = on => { strip.freeze(on); try { walker?.setPaused(on); } catch (_) {} };
  initWindows({ requestClose, onOpen: pauseStrip, onClose: pauseStrip, onGenie });
  initLightbox({ navigate, onOpen: pauseStrip, onClose: pauseStrip });

  // internal links anywhere in the document
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-route]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return;
    const to = a.dataset.route || a.getAttribute('href');
    if (!to || !to.startsWith('/')) return;
    e.preventDefault();
    if (to === '/') { requestClose(); return; }
    window.__openT = performance.now();
    // the window pours out of what was clicked: the folder icon, or the link itself
    // a control inside the open window (Start a project in a case): the new window pours out of
    // that button's rect, replacing the old one (the button itself goes with the old content)
    if (a.closest('#win')) { const q = a.getBoundingClientRect(); navigate(to, { fromRect: { left: q.left, top: q.top, width: q.width, height: q.height }, fresh: true }); return; }
    navigate(to, { from: a.querySelector('.folder-icon') || a });
  });
  addEventListener('popstate', () => show(location.pathname));

  // Space → jump (when nothing else wants the key)
  addEventListener('keydown', e => {
    if (e.code !== 'Space' || winOpen() || lbOpen()) return;
    if (e.target.closest?.('input, textarea, button, a, select, [contenteditable]')) return;
    e.preventDefault();
    try { walker?.play('jump'); } catch (_) {}
  });

  const intro = document.documentElement.classList.contains('intro');
  const walkerReady = loadWalker(intro);
  preloadWaves();

  // deep link on load (Netlify _redirects serves index.html for every path);
  // with the intro, the window opens once the signature has landed
  const deepLink = () => { if (location.pathname !== '/' && !show(location.pathname)) history.replaceState({}, '', '/'); };
  if (intro) {
    // only content.json (already parsed here) and the font may hold the hand-off; pictures and the walker arrive on their own
    runIntro().then(deepLink);
  } else deepLink();

  // console easter egg, as on the reference
  window.alex = {
    dance: () => walker?.play('dance'),
    jump: () => walker?.play('jump'),
    backflip: () => walker?.play('backflip'),
  };
  console.log('%cAlex Colombel — product designer. Try alex.dance()', 'font: 500 12px Inter, sans-serif');
}

boot();
