/*!
 * Distortion waves — plain-JS WebGL2 port of the web preview's renderer.
 *
 * Original work: "Distortion waves" (libraries.dev/waves),
 * https://github.com/Jakubantalik/Libraries.dev
 *   sites/home/src/distortion-waves/model.ts     (timeline, particles, rim lumps)
 *   sites/home/src/distortion-waves/renderer.ts  (WebGL2 shaders + blur copies)
 *
 * MIT License
 *
 * Copyright (c) 2026 Jakub Antalik
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Full text: LICENSES/distortion-waves-MIT.txt
 *
 * ---------------------------------------------------------------------------
 * Port notes (changes from upstream, all marked "PORT:" below)
 * - Two screens: upstream shows one morphing screen on both sides of the front;
 *   here the old side samples `from` and the revealed side samples `to`.
 * - Units: every upstream length is in iOS points on a 391x831 pt phone. The
 *   model and shaders run unchanged in a virtual "pt" space where
 *   1 pt = `scale` CSS px. Auto scale = sqrt(area / phone area), clamped to
 *   [1, 1.35]; 1280x800 -> 1.35. The hairline is kept at 1.5 CSS px, and the
 *   rim's corner radius is a CSS-px option (default 0: a viewport is square).
 * - Without an `anchor`, the source is a virtual capsule (120x44 pt vertical,
 *   64x64 pt center) centred on the click; with one, its box is the source,
 *   so the front leaves the button's capsule and leans toward the click.
 * - Vertical mode clicked in the top half of the rect mirrors the sparks' and
 *   the tilt's direction so they travel into the screen (the field itself is
 *   symmetric). Upstream always fires from a bottom button.
 * - `seeThroughAfterReveal` (off by default): once `to` is fully revealed the
 *   canvas keeps only the colour (band, rim, hairline, sparks) over a
 *   transparent background, so the live DOM swapped in at onRevealed shows.
 * - `overlay: true` (per play): colour only for the whole run. No from/to
 *   fill and no distortion; the page underneath stays visible throughout.
 *   `onFrame({x, y, r})` reports the front (viewport px) each frame so the
 *   caller can reveal its own DOM behind it.
 * - `speed` (per play, default 1) scales the whole timeline.
 * - Performance (alexcolombel.com): one WebGL2 context, canvas and set of
 *   programs is created once (warm() at idle, KHR_parallel_shader_compile when
 *   available) and reused by every play(); compile status is only read when a
 *   link fails. `?wavedebug` in the page URL logs per-stage setup timings.
 *
 * Usage
 *   import { createWaves } from './js/waves.js';
 *   const waves = createWaves();
 *   const run = waves.play({ from: imgA, to: imgB, origin: { x, y }, mode: 'vertical',
 *                            anchor: button, onRevealed: () => swapDom() });
 *   run.revealed.then(...)   // same moment as onRevealed
 *   await run;               // the rim has cleared, canvas removed
 *
 * Images: give cross-origin <img>/<video> crossorigin="anonymous" (Cloudinary
 * sends CORS headers). A source that would taint WebGL falls back to a
 * crossfade instead of throwing.
 */

/* ── Model (model.ts, line for line) ─────────────────────────────────── */

const PHONE_W = 391.43;
const PHONE_H = 831.43;

export const PALETTES = {
  colorful: {
    colors: [[255, 201, 21], [126, 196, 255], [180, 40, 230], [235, 100, 160], [255, 176, 122], [154, 160, 255], [127, 217, 238]],
    ahead: [255, 122, 182],
    behind: [90, 190, 255],
  },
  green: {
    colors: [[53, 186, 0], [140, 235, 90], [0, 196, 110], [190, 250, 130], [40, 160, 60], [110, 225, 160], [90, 210, 40]],
    ahead: [196, 255, 120],
    behind: [0, 150, 70],
  },
  ocean: {
    colors: [[40, 120, 255], [90, 200, 255], [20, 80, 200], [120, 230, 240], [60, 150, 255], [150, 180, 255], [0, 180, 220]],
    ahead: [150, 230, 255],
    behind: [30, 70, 220],
  },
  sunset: {
    colors: [[255, 140, 60], [255, 90, 120], [255, 200, 80], [240, 70, 90], [255, 170, 120], [220, 90, 200], [255, 120, 80]],
    ahead: [255, 220, 120],
    behind: [200, 60, 160],
  },
  mono: {
    colors: [[240, 240, 245], [200, 205, 215], [255, 255, 255], [170, 175, 190], [225, 228, 235], [190, 195, 205], [245, 245, 250]],
    ahead: [255, 255, 255],
    behind: [160, 165, 180],
  },
};

const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** One colour, lighter ahead of the front and deeper behind it. */
export function singlePalette(c) {
  return {
    colors: [c, mixRgb(c, [255, 255, 255], 0.25), c, mixRgb(c, [0, 0, 0], 0.15)],
    ahead: mixRgb(c, [255, 255, 255], 0.45),
    behind: mixRgb(c, [0, 0, 0], 0.3),
  };
}

/** The tuned upstream defaults for a type (DistortionWaveStyle(type:)). */
export function defaultStyle(type) {
  const base = {
    type,
    anticipation: 0.5, travel: 2.28, launchGap: 0, linger: -0.35, rimFade: 3.03, returnSpeed: 1.45,
    pull: 24, inhale: 56, gatherGlow: 0.33, gatherDots: 1,
    amplitude: 34, lensWidth: 150, aberration: 0.78, swell: 22,
    blur: 18, blurAhead: 90, blurBehind: 240,
    lead: 130, tail: 300, strength: 0.92,
    rimWidth: 14, rimUnevenness: 1, rimStrength: 0.82, rimSoftness: 343, cornerRadius: 62, rimPulse: 0.6,
    hairlineWidth: 1.5, hairlineOpacity: 0.9, hairlineWhite: 0.95, hairlineLinger: 0.47, hairlineFade: 3,
    orientation: 0.91,
    particleCount: 64, particleSize: 1.8, particleReach: 150, particleFlight: 30, particleGap: 24, particleLife: 2.19, particleSpread: 1,
    palette: PALETTES.colorful,
  };
  if (type !== 'center') return base;
  return {
    ...base,
    anticipation: 0.25, travel: 3.43, rimFade: 2.51, hairlineLinger: 0.96, strength: 0.6, rimStrength: 0.6,
    aberration: 0, gatherGlow: 0, gatherDots: 0, particleCount: 89, particleLife: 3.93, particleSpread: 0.64,
    palette: PALETTES.green, cornerRadius: 48, pull: 14.4, inhale: 33.6, amplitude: 20.4, lensWidth: 90,
    swell: 13.2, blur: 10.8, blurAhead: 54, blurBehind: 144, lead: 78, tail: 180, rimSoftness: 205.8,
    particleReach: 90, particleFlight: 18, particleGap: 11,
  };
}

/** Seconds for the whole of it: the swell settled, edges cleared, last dot faded. */
export function duration(s) {
  return s.anticipation + Math.max(s.travel * 0.6, s.linger + s.rimFade, s.linger + s.hairlineLinger + s.hairlineFade, s.particleLife);
}

/** CSS cubic-bezier(), solved by halving as the Swift easing does. */
function bezierEase(x1, y1, x2, y2) {
  const b = (s, a, c) => {
    const r = 1 - s;
    return 3 * r * r * s * a + 3 * r * s * s * c + s * s * s;
  };
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const s = (lo + hi) / 2;
      if (b(s, x1, x2) < x) lo = s;
      else hi = s;
    }
    return b((lo + hi) / 2, y1, y2);
  };
}

const EASING = bezierEase(0.22, 1, 0.36, 1);
const RIM_EASING = bezierEase(0.42, 0, 0.58, 1);
const smooth = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

const COVER_ZONE = 60;
const ARC_SQUASH = 1.4;
const RELEASE = 0.22;
const GATHERED_GLOW = 0.5;
const OVERSHOOT = 100;
const MAX_TILT = 0.45;
const SETTLE_START = 0.2;
const SETTLE_END = 0.55;

/** Where the wave is at `progress` (0–1 of its duration). WaveFront.init.
    PORT: `flip` mirrors the tilt for a vertical wave launched downward. */
function waveFront(progress, source, width, height, style, focus, flip) {
  const dur = duration(style);
  const t = Math.min(Math.max(progress, 0), 1) * dur;
  const sinceLaunch = t - style.anticipation;
  const gathered = smooth(0, Math.max(style.anticipation, 0.001), t);
  const x = Math.min(Math.max(sinceLaunch / style.travel, 0), 1);
  const moved = EASING(x);

  const ring = style.type === 'center';
  const sideways = style.type === 'horizontal';
  const fullSquash = ring ? 1 : ARC_SQUASH;
  const midX = source.x + source.w / 2;
  const midY = source.y + source.h / 2;
  const startRadius = Math.min(source.w, source.h) / 2;
  const length = sideways ? source.h : source.w;
  const startSpine = ring ? 0 : Math.max(0, length / 2 - startRadius);
  const turned = sideways ? Math.PI / 2 : 0;
  const ax = Math.cos(turned);
  const ay = Math.sin(turned);

  let lean = 0;
  if (!ring && focus) {
    const off = sideways ? focus.y - midY : focus.x - midX;
    lean = Math.min(Math.max(off / Math.max(length / 2, 1), -1), 1);
  }
  const fullShift = ((lean * length) / 2) * style.orientation;
  const fullLean = lean * style.orientation * MAX_TILT * (flip ? -1 : 1);
  const fullTilt = turned + fullLean;
  const opening = smooth(0, 0.45, moved);

  const cs = Math.cos(fullTilt);
  const sn = Math.sin(fullTilt);
  let reach = 0;
  for (const [cx, cy] of [[0, 0], [width, 0], [0, height], [width, height]]) {
    const dx = cx - midX - fullShift * ax;
    const dy = cy - midY - fullShift * ay;
    reach = Math.max(reach, Math.hypot((cs * dx + sn * dy) * fullSquash, -sn * dx + cs * dy));
  }
  const crossed = reach + (style.swell + COVER_ZONE) * fullSquash;
  const settling = 1 - smooth(SETTLE_START, SETTLE_END, x);
  const launchRadius = startRadius + Math.max(style.launchGap, 0);
  const radius = sinceLaunch < 0 ? launchRadius + style.inhale * (1 - gathered) : launchRadius + (crossed + OVERSHOOT - launchRadius) * moved;
  const gatheredGlow = Math.min(GATHERED_GLOW * Math.max(style.gatherGlow, 0), 1);
  const clearStart = startRadius - style.rimSoftness;
  const clearEnd = reach + (style.rimSoftness + style.swell) * fullSquash;
  return {
    ox: midX + fullShift * opening * ax,
    oy: midY + fullShift * opening * ay,
    tilt: turned + fullLean * opening,
    spine: startSpine * (1 - opening),
    radius,
    moved,
    squash: 1 + (fullSquash - 1) * smooth(0, 0.5, moved),
    time: t,
    energy: smooth(0, 0.05, x) * settling,
    swell: style.swell * smooth(0, 0.3, moved),
    width,
    height,
    gravity: style.pull * gathered * (1 - smooth(0, RELEASE, sinceLaunch)),
    glow: sinceLaunch < 0 ? gatheredGlow * gathered : (gatheredGlow + (1 - gatheredGlow) * smooth(0, 0.07, x)) * settling,
    clearRadius: clearStart + (clearEnd - clearStart) * RIM_EASING((sinceLaunch - style.linger) / Math.max(style.rimFade, 0.01)),
    hairClearRadius:
      clearStart + (clearEnd - clearStart) * RIM_EASING((sinceLaunch - style.linger - style.hairlineLinger) / Math.max(style.hairlineFade, 0.01)),
    rim: style.rimStrength * smooth(0, 0.1, x) * (1 - smooth(0.9, 1, t / dur)),
    sparkle: smooth(0, Math.max(style.anticipation, 0.001) * 0.35, t),
    flying: Math.max(sinceLaunch, 0),
    launched: sinceLaunch > 0,
    hasCleared: radius > crossed,
    ring,
    sideways,
    flip: !!flip,
    hold: ring ? startRadius : 0,
  };
}

/** The lumps on the edges (WaveRim.lumps): centre, length, depth of each. */
const LUMPS = 7;
const LUMP_BUFFER = new Float32Array(LUMPS * 3);
function rimLumps(time, width, height, cornerRadius, pulse) {
  const ex = Math.max(width / 2 - cornerRadius, 0);
  const ey = Math.max(height / 2 - cornerRadius, 0);
  const perimeter = 4 * (ex + ey + 0.5 * Math.PI * cornerRadius);
  const hash = (i, a, b) => {
    const v = Math.sin(i * a + b) * 43758.5453;
    return v - Math.floor(v);
  };
  const out = LUMP_BUFFER;
  for (let i = 0; i < LUMPS; i++) {
    const a = hash(i, 12.9898, 1.3);
    const b = hash(i, 78.233, 4.1);
    const c = hash(i, 39.425, 2.7);
    const centre = (perimeter * (i + 0.35 * a)) / LUMPS + time * (-22 + 44 * b) * (1 + 2 * pulse);
    const len = (perimeter / LUMPS) * (0.2 + 0.25 * c);
    const breath = (0.25 + 0.3 * pulse) * Math.sin(time * (1.1 + 1.2 * a) * (1 + pulse) + i * 2.4);
    out[i * 3] = centre;
    out[i * 3 + 1] = len;
    out[i * 3 + 2] = (0.2 + 2.6 * b) * (1 + breath);
  }
  return out;
}

/* Particles (WaveParticle) */
const FAN = 0.22;
const BOW = 0.3;
const pHash = (i, n, salt) => {
  const v = Math.sin(i * 12.9898 + n * 78.233 + salt * 37.719) * 43758.5453;
  return v - Math.floor(v);
};

function makeParticles(style) {
  const out = [];
  for (let k = 0; k < Math.round(style.particleCount); k++) {
    const i = k + 1;
    const scatter = (step) => (i * step) % 1;
    const small = scatter(0.5497004779);
    out.push({
      index: i,
      column: (scatter(0.7548776662) * 2 - 1) * 0.92,
      heading: scatter(0.7548776662) * 2 * Math.PI,
      pace: 0.35 + 0.72 * Math.sqrt(scatter(0.8191725134)),
      drift: 15 + 50 * scatter(0.6710436067),
      sway: 3 + 11 * scatter(0.4142135624),
      swayRate: 2.5 + 3.5 * scatter(0.7320508076),
      twinkleRate: 8 + 12 * scatter(0.2360679775),
      phase: scatter(0.6180339887) * 2 * Math.PI,
      life: style.particleLife * (0.4 + 0.6 * scatter(0.6457513111)),
      size: style.particleSize * (0.55 + 0.45 * small * small),
      brightness: 0.3 + 0.7 * scatter(0.6055512755),
      hop: 0.16 + 0.14 * scatter(0.1231056256),
      hopOffset: scatter(0.472135955),
    });
  }
  return out;
}

/** A particle's place and opacity. PORT: mirrored about the source when flipped. */
function particleAt(p, front, source, style) {
  const twinkle = 0.5 + 0.5 * Math.sin(front.time * p.twinkleRate + p.phase);
  const glint = p.brightness * (0.7 + 0.3 * twinkle);
  const spread = Math.min(Math.max(style.particleSpread, 0), 1);
  const midX = source.x + source.w / 2;
  const midY = source.y + source.h / 2;
  const fy = front.flip && !front.sideways && !front.ring ? -1 : 1;
  if (!front.launched) {
    const hops = front.time / p.hop + p.hopOffset;
    const count = Math.floor(hops);
    const along = hops - count;
    const hopping = smooth(0, 0.25, along) * (1 - smooth(0.55, 1, along));
    const ending = 1 - smooth(style.anticipation * 0.75, style.anticipation, front.time);
    const a = front.sparkle * hopping * ending * glint * style.gatherDots;
    if (front.ring) {
      const angle = pHash(p.index, count, 1) * 2 * Math.PI;
      const nearest = Math.min(source.w, source.h) / 2 + style.particleGap + style.particleFlight;
      const away = nearest + Math.max(style.particleReach - nearest, 0) * pHash(p.index, count, 2);
      const d = away - style.particleFlight * along * along;
      return { x: midX + Math.cos(angle) * d, y: midY + Math.sin(angle) * d, a };
    }
    const half = (front.sideways ? source.h : source.w) / 2;
    const face = (front.sideways ? source.w : source.h) / 2;
    const on = (al, out) => (front.sideways ? { x: midX + out, y: midY + al } : { x: midX + al, y: midY - out * fy });
    const x = (pHash(p.index, count, 1) * 2 - 1) * (half + 24);
    const nearest = style.particleGap + style.particleFlight;
    const away = nearest + Math.max(style.particleReach - nearest, 0) * pHash(p.index, count, 2);
    const start = on(x, face + away);
    const corner = Math.min(source.w, source.h) / 2;
    const target = on(Math.min(Math.max(x, -half + corner), half - corner), face);
    const dx = target.x - start.x;
    const dy = target.y - start.y;
    const len = Math.max(Math.hypot(dx, dy), 1);
    const travelled = style.particleFlight * along * along;
    return { x: start.x + (dx / len) * travelled, y: start.y + (dy / len) * travelled, a };
  }
  const burning = 1 - smooth(p.life * 0.55, p.life, front.flying);
  const a = burning * glint;
  const swaying = p.sway * Math.sin(p.swayRate * front.flying + p.phase) * Math.min(front.flying / 0.25, 1);
  if (front.ring) {
    const edge = Math.min(source.w, source.h) / 2;
    const d = edge + ((front.radius - edge) * p.pace + p.drift * front.flying) * spread;
    const dx = Math.cos(p.heading);
    const dy = Math.sin(p.heading);
    return { x: front.ox + dx * d - dy * swaying, y: front.oy + dy * d + dx * swaying, a };
  }
  const start = Math.min(source.w, source.h) / 2;
  const widening = 1 + FAN * front.moved * p.pace * spread;
  const xx = ((p.column * (front.sideways ? source.h : source.w)) / 2) * widening + swaying;
  const h = (start + (front.radius - start) * p.pace * spread) * (1 - BOW * p.column * p.column) + p.drift * front.flying * spread;
  const tilt = front.tilt * fy; // un-mirror, compute as upstream, mirror back
  const cs = Math.cos(tilt);
  const sn = Math.sin(tilt);
  return { x: front.ox + cs * xx + sn * h, y: front.oy + (sn * xx - cs * h) * fy, a };
}

function oklab(c) {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = [lin(c[0]), lin(c[1]), lin(c[2])];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/* ── Shaders (renderer.ts, verbatim except where marked PORT) ─────────── */

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;
uniform float uSigma;
out vec4 outColor;
void main() {
  float r = ceil(uSigma * 3.0);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (float i = -48.0; i <= 48.0; i += 1.0) {
    if (abs(i) > r) continue;
    float w = exp(-0.5 * i * i / (uSigma * uSigma));
    acc += texture(uTex, vUv + uStep * i) * w;
    wsum += w;
  }
  outColor = acc / wsum;
}`;

const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uLod;
out vec4 outColor;
void main() { outColor = textureLod(uTex, vUv, uLod); }`;

const MAIN_FRAG = `#version 300 es
precision highp float;
uniform vec2 uSize;
uniform vec2 uPx;
uniform float uF[19];
uniform sampler2D uC0;
uniform sampler2D uC1;
uniform sampler2D uC2;
uniform sampler2D uR0;
uniform sampler2D uR1;
uniform sampler2D uR2;
uniform int uContent;
uniform int uRevealed;
uniform int uLens;
uniform int uLive;
uniform int uSee;
uniform float uAmplitude;
uniform float uLensWidth;
uniform float uAberration;
uniform float uBlur;
uniform float uBlurAhead;
uniform float uBlurBehind;
uniform float uNear;
uniform vec3 uPal[9];
uniform int uPalCount;
uniform vec3 uAhead;
uniform vec3 uBehind;
uniform float uLead;
uniform float uTail;
uniform float uStrength;
uniform float uRimWidth;
uniform float uRimSoftness;
uniform float uCorner;
uniform float uUneven;
uniform float uPulse;
uniform float uHairW;
uniform float uHairO;
uniform float uHairWhite;
uniform vec3 uLumps[${LUMPS}];
out vec4 outColor;

const float coverZone = ${COVER_ZONE.toFixed(1)};
const float PI = 3.14159265;

struct Field { float d; vec2 n; vec2 q; vec2 raw; float g; };

float heldAt(vec2 p) {
  if (uF[16] <= 0.0) return 1.0;
  return smoothstep(uF[16] * 0.9, uF[16] * 1.8, length(p - vec2(uF[0], uF[1])));
}

Field fieldAt(vec2 p) {
  vec2 raw = p - vec2(uF[0], uF[1]);
  float cs = cos(uF[14]), sn = sin(uF[14]);
  vec2 q = vec2(cs * raw.x + sn * raw.y, -sn * raw.x + cs * raw.y);
  float spine = uF[2], radius = uF[3], squash = uF[4], time = uF[5], swell = uF[7];
  float mx = q.x * squash;
  vec2 v = vec2(max(abs(mx) - spine, 0.0), q.y);
  float l = max(length(v), 1e-3);
  vec2 grad = vec2(v.x * sign(q.x) * squash, v.y) / l;
  float g = max(length(grad), 1e-3);
  float bend;
  if (uF[15] > 0.5) {
    float a = atan(q.y, q.x);
    bend = 0.62 * sin(2.0 * a + time * 1.1) + 0.38 * sin(3.0 * a - time * 1.5 + 1.7);
  } else {
    float s = mx * 0.0058;
    bend = 0.62 * sin(s + time * 1.1) + 0.38 * sin(s * 2.1 - time * 1.5 + 1.7);
  }
  vec2 n = grad / g;
  Field o;
  o.d = (l - radius) / g + swell * bend;
  o.n = vec2(cs * n.x - sn * n.y, sn * n.x + cs * n.y);
  o.q = q;
  o.raw = raw;
  o.g = g;
  return o;
}

vec3 side(sampler2D a, sampler2D b, sampler2D c, vec2 s, float tn, float tf) {
  vec2 uv = clamp(s, vec2(0.5), uSize - 0.5) / uSize;
  vec3 col = texture(a, uv).rgb;
  if (tn > 0.0) col = mix(col, texture(b, uv).rgb, tn);
  if (tf > 0.0) col = mix(col, texture(c, uv).rgb, tf);
  return col;
}

const vec3 spectrum[5] = vec3[5](
  vec3(0.571, 0.0, 0.0), vec3(0.343, 0.206, 0.0), vec3(0.086, 0.588, 0.086), vec3(0.0, 0.206, 0.343), vec3(0.0, 0.0, 0.571)
);

vec3 lensed(int which, vec2 s, vec2 split, float tn, float tf) {
  if (dot(split, split) < 0.0625) {
    return which == 0 ? side(uC0, uC1, uC2, s, tn, tf) : side(uR0, uR1, uR2, s, tn, tf);
  }
  vec3 o = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float along = float(i) / 4.0 * 2.0 - 1.0;
    vec3 c = which == 0 ? side(uC0, uC1, uC2, s + split * along, tn, tf) : side(uR0, uR1, uR2, s + split * along, tn, tf);
    o += c * spectrum[i];
  }
  return o;
}

float continuousRectSDF(vec2 p, vec2 halfSize, float radius) {
  float a = min(radius * 1.528665, min(halfSize.x, halfSize.y));
  vec2 q = abs(p) - (halfSize - a);
  if (q.x <= 0.0 || q.y <= 0.0) return max(abs(p.x) - halfSize.x, abs(p.y) - halfSize.y);
  const float n = 3.26;
  vec2 u = q / a;
  float norm = pow(pow(u.x, n) + pow(u.y, n), 1.0 / n);
  vec2 gg = pow(u / max(norm, 1e-4), vec2(n - 1.0));
  return (norm - 1.0) * a / max(length(gg), 1e-3);
}

vec2 perimeterAt(vec2 p, vec2 halfSize, float r) {
  float ex = max(halfSize.x - r, 0.0);
  float ey = max(halfSize.y - r, 0.0);
  float arc = 0.5 * PI * r;
  float P = 4.0 * (ex + ey + arc);
  float ax = abs(p.x), ay = abs(p.y);
  if (ax > ex && ay > ey) {
    vec2 v = p - vec2(sign(p.x) * ex, sign(p.y) * ey);
    float a, base;
    if (p.x >= 0.0 && p.y < 0.0) { a = atan(v.x, -v.y); base = ex; }
    else if (p.x >= 0.0) { a = atan(v.y, v.x); base = ex + arc + 2.0 * ey; }
    else if (p.y >= 0.0) { a = atan(-v.x, v.y); base = 3.0 * ex + 2.0 * arc + 2.0 * ey; }
    else { a = atan(-v.y, -v.x); base = 3.0 * ex + 3.0 * arc + 4.0 * ey; }
    return vec2(base + r * clamp(a, 0.0, 0.5 * PI), P);
  }
  bool sideHit = ax > ex ? true : (ay > ey ? false : (halfSize.x - ax) < (halfSize.y - ay));
  if (sideHit) return vec2(p.x >= 0.0 ? ex + arc + (p.y + ey) : 3.0 * ex + 3.0 * arc + 2.0 * ey + (ey - p.y), P);
  return vec2(p.y < 0.0 ? (p.x >= 0.0 ? p.x : P + p.x) : ex + 2.0 * arc + 2.0 * ey + (ex - p.x), P);
}

float rimThickness(float s, float P) {
  float t = 0.08;
  for (int i = 0; i < ${LUMPS}; i++) {
    float ds = s - uLumps[i].x;
    ds -= P * floor(ds / P + 0.5);
    float k = ds / uLumps[i].y;
    t += uLumps[i].z * exp(-k * k);
  }
  return t / 1.0498;
}

float dither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))) - 0.5; }

vec3 paletteAt(float u) {
  float x = fract(u) * float(uPalCount);
  int i = min(int(x), uPalCount - 1);
  int j = i + 1 == uPalCount ? 0 : i + 1;
  float m = fract(x);
  m = m * m * (3.0 - 2.0 * m);
  return mix(uPal[i], uPal[j], m);
}

vec3 oklabToSRGB(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  vec3 lin = clamp(vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ), 0.0, 1.0);
  return mix(12.92 * lin, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), lin));
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uPx.y - gl_FragCoord.y) * (uSize.x / uPx.x);

  if (uLive == 0) {
    if (uSee == 2) { outColor = vec4(0.0); return; }
    outColor = vec4(uRevealed == 1 ? texture(uR0, p / uSize).rgb : texture(uC0, p / uSize).rgb, 1.0);
    return;
  }

  // PORT: see-through once the new screen is fully revealed (colour only).
  bool see = uSee == 2 || (uSee == 1 && uContent == 0);

  Field w = fieldAt(p);
  float energy = uF[6], gravity = uF[10];
  float held = heldAt(p);

  vec2 s = p;
  vec2 split = vec2(0.0);
  if (uLens == 1) {
    float u = w.d / (uLensWidth * (w.d > 0.0 ? 0.85 : 1.5));
    float lift = exp(-u * u);
    float r = max(length(w.raw), 1.0);
    vec2 swollen = w.n * energy * uAmplitude * lift * held;
    vec2 inward = w.raw / r;
    s = p - swollen + inward * gravity * exp(-r / 900.0) * held;
    split = (swollen - inward * gravity * exp(-r / 240.0) * held) * uAberration;
  }
  float bu = w.d / (w.d > 0.0 ? uBlurAhead : uBlurBehind);
  float radius = energy * uBlur * exp(-bu * bu) * held;
  float tn = clamp(radius / max(uNear, 1e-3), 0.0, 1.0);
  tn = tn * tn * (3.0 - 2.0 * tn);
  float tf = clamp((radius - uNear) / max(uBlur - uNear, 1e-3), 0.0, 1.0);
  tf = tf * tf * (3.0 - 2.0 * tf);

  vec3 col = vec3(0.0);
  float cover = 1.0;
  if (uContent == 1 && uF[17] > 0.5) cover = smoothstep(-coverZone, coverZone, w.d);
  if (uContent == 0) cover = 0.0;
  bool showRevealed = uRevealed == 1 && w.d <= coverZone + 6.0 && cover < 1.0;
  if (showRevealed && !see) col = lensed(1, s, split, tn, tf);
  if (cover > 0.0) col = mix(col, lensed(0, s, split, tn, tf), cover);

  float d = w.d, time = uF[5], glow = uF[11], rim = uF[13];
  vec2 c = p - uSize * 0.5;
  float inset = max(-continuousRectSDF(c, uSize * 0.5, uCorner), 0.0);
  bool nearEdge = rim > 0.0 && inset < max(uRimWidth * 2.2 * (1.0 + 1.9 * uUneven), uHairW * 0.5 + 0.75);
  if (glow <= 0.0 && !nearEdge) {
    outColor = see ? vec4(0.0) : vec4(col + dither(gl_FragCoord.xy) / 255.0, 1.0);
    return;
  }
  bool ring = uF[15] > 0.5;
  float turn = atan(w.q.y, w.q.x);
  float along = w.q.x * 0.0068;
  float lobes = ring
    ? 0.5 + 0.5 * sin(2.0 * turn + time * 1.4) * cos(turn - time * 0.7 + 1.2)
    : 0.5 + 0.5 * sin(along * 1.3 + time * 1.4) * cos(along * 0.6 - time * 0.7 + 1.2);
  float bandA = 0.0;
  if (glow > 0.0 && d < uLead) {
    if (d >= 0.0) {
      float k = 1.0 - d / uLead;
      bandA = k * k * k * (k * (k * 6.0 - 15.0) + 10.0);
    } else {
      bandA = pow(1.0 - clamp(-d / (uTail * mix(0.6, 1.3, lobes)), 0.0, 1.0), 2.3);
    }
    bandA *= glow * uStrength * mix(0.6, 1.0, exp(-inset / 140.0)) * held;
  }
  float aroundA = atan(c.y / uSize.y, c.x / uSize.x);
  float rimA = 0.0;
  float hairA = 0.0;
  float shimmer = 0.5;
  if (nearEdge) {
    vec2 edge = perimeterAt(c, uSize * 0.5, uCorner);
    float thickness = 1.0;
    if (uUneven > 0.0) thickness = max(1.0 + (rimThickness(edge.x, edge.y) - 1.0) * uUneven, 0.04);
    float hk = inset / (uRimWidth * thickness);
    float hug = exp(-hk * hk);
    float reached = 1.0 - smoothstep(-uLead * 0.7, uLead * 0.5, d);
    float kept = smoothstep(-uRimSoftness, uRimSoftness, d + (uF[3] - uF[12]) / w.g);
    shimmer = 0.5 + 0.5 * sin(time * 3.4 - edge.x / edge.y * 4.0 * PI);
    rimA = hug * reached * kept * rim * mix(1.0, 0.7 + 0.3 * shimmer, uPulse);
    if (uHairW > 0.0) {
      float line = 1.0 - smoothstep(uHairW * 0.5, uHairW * 0.5 + 0.75, inset);
      float hairKept = smoothstep(-uRimSoftness, uRimSoftness, d + (uF[3] - uF[18]) / w.g);
      hairA = line * reached * hairKept * rim * uHairO
        * mix(0.5, 1.0, smoothstep(0.1, 1.5, thickness))
        * mix(1.0, 0.55 + 0.45 * shimmer, uPulse);
    }
  }
  float a = 1.0 - (1.0 - bandA) * (1.0 - rimA);
  float total = 1.0 - (1.0 - a) * (1.0 - hairA);
  if (total <= 0.0005) {
    outColor = see ? vec4(0.0) : vec4(col + dither(gl_FragCoord.xy) / 255.0, 1.0);
    return;
  }
  float flow = 0.62 + (ring ? turn / (2.0 * PI) : along * 0.2) + time * 0.13 + d * 0.0015 + (ring ? 0.0 : 0.05 * sin(w.q.y * 0.009 + time));
  vec3 lab = paletteAt(flow);
  lab = mix(lab, uAhead, 0.5 * exp(-pow((d - 30.0) / 50.0, 2.0)));
  lab = mix(lab, uBehind, 0.5 * exp(-pow((d + 84.0) / 72.0, 2.0)));
  lab.yz *= 1.22;
  lab = mix(lab, vec3(0.99, 0.0, 0.0), 0.7 * exp(-pow((d + 8.0) / 26.0, 2.0)));
  vec3 rimLab = paletteAt(aroundA / (2.0 * PI) + time * (0.12 + 0.25 * uPulse) + inset * 0.0012);
  rimLab.yz *= 1.1;
  lab = mix(lab, rimLab, rimA / (rimA + bandA + 1e-4));
  vec3 rgb = oklabToSRGB(lab);
  if (hairA > 0.0) {
    vec3 hair = mix(oklabToSRGB(rimLab), vec3(1.0), uHairWhite * (0.5 + 0.5 * shimmer));
    rgb = (rgb * a * (1.0 - hairA) + hair * hairA) / total;
  }
  float noise = dither(gl_FragCoord.xy) * 2.0 / 255.0;
  if (see) {
    float A = clamp(total + noise, 0.0, 1.0);
    outColor = vec4(clamp(rgb + noise, 0.0, 1.0) * A, A);
    return;
  }
  outColor = vec4(mix(col, clamp(rgb + noise, 0.0, 1.0), clamp(total + noise, 0.0, 1.0)), 1.0);
}`;

const DOT_VERT = `#version 300 es
in vec3 aDot;
uniform vec2 uSize;
uniform float uPoint;
out float vA;
void main() {
  vec2 clip = vec2(aDot.x / uSize.x * 2.0 - 1.0, 1.0 - aDot.y / uSize.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = uPoint;
  vA = aDot.z;
}`;

const DOT_FRAG = `#version 300 es
precision highp float;
in float vA;
uniform float uScale;
uniform float uPoint;
out vec4 outColor;
void main() {
  float a = fract(vA);
  float size = floor(vA) / 10.0;
  float r = length(gl_PointCoord - 0.5) * uPoint;
  float edge = size * uScale * 0.5;
  float cov = clamp(edge - r + 0.5, 0.0, 1.0);
  outColor = vec4(vec3(1.0) * a * cov, a * cov);
}`;

/** Near copy's blur radius, pt, as the SwiftUI stage's. */
const NEAR = 7;

class ShaderError extends Error {}

/* ── Renderer (WaveRenderer, two screens, owns and frees one context) ─── */

class Renderer {
  constructor(canvas, alpha) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha, preserveDrawingBuffer: false, depth: false, stencil: false });
    if (!gl) throw new ShaderError('WebGL2 unavailable');
    this.gl = gl;
    this.pendingShaders = [];
    this.main = this.program(VERT, MAIN_FRAG);
    this.blur = this.program(VERT, BLUR_FRAG);
    this.copy = this.program(VERT, COPY_FRAG);
    this.dot = this.program(DOT_VERT, DOT_FRAG);
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.dots = gl.createBuffer();
    this.dotsSize = 0;
    this.scratches = new Map();
    this.screens = [null, null];
    this.field = new Float32Array(19);
    this.pal = new Float32Array(27);
    this.palKey = null;
    this.ahead = new Float32Array(3);
    this.behind = new Float32Array(3);
    this.sizePt = { w: 1, h: 1 };
  }

  compile(type, src) {
    // PORT: no COMPILE_STATUS query here; it would block until the driver is
    // done. Status is read once, in check(), and only logged on failure.
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }

  program(vs, fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    const a = this.compile(gl.VERTEX_SHADER, vs);
    const b = this.compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, a);
    gl.attachShader(p, b);
    gl.bindAttribLocation(p, 0, vs.includes('aDot') ? 'aDot' : 'aPos');
    gl.linkProgram(p);
    this.pendingShaders.push([p, a, b, vs, fs]);
    const cache = new Map();
    const loc = (name) => {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(p, name));
      return cache.get(name);
    };
    return { p, loc };
  }

  /** True once the driver has finished compiling (never blocks). */
  ready() {
    if (!this.pendingShaders.length) return true;
    if (!this.parallel) return false;
    const gl = this.gl;
    return this.pendingShaders.every(([p]) => gl.getProgramParameter(p, this.parallel.COMPLETION_STATUS_KHR));
  }

  /** Reads link status once (blocks only if compiling is still going on). */
  check() {
    const gl = this.gl;
    for (const [p, a, b] of this.pendingShaders) {
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.isContextLost() ? 'context lost'
          : [gl.getShaderInfoLog(a), gl.getShaderInfoLog(b), gl.getProgramInfoLog(p)].filter(Boolean).join(' | ');
        throw new ShaderError('link: ' + (log || 'failed'));
      }
      gl.deleteShader(a);
      gl.deleteShader(b);
    }
    this.pendingShaders = [];
  }

  texture(w, h, source, mip) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (source) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    return tex;
  }

  target(w, h) {
    const gl = this.gl;
    const tex = this.texture(w, h, null, false);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  drop(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  scratch(w, h) {
    const key = `${w}x${h}`;
    let t = this.scratches.get(key);
    if (!t) {
      t = this.target(w, h);
      this.scratches.set(key, t);
    }
    return t;
  }

  quadDraw(prog) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  blurred(sharp, w, h, sigmaPt, into) {
    const gl = this.gl;
    const sigmaPx = sigmaPt * (w / this.sizePt.w);
    const f = Math.max(1, Math.round(sigmaPx / 5));
    const dw = Math.max(1, Math.round(w / f));
    const dh = Math.max(1, Math.round(h / f));
    let small = into;
    if (!small || small.w !== dw || small.h !== dh) {
      this.drop(small);
      small = this.target(dw, dh);
    }
    const tmp = this.scratch(dw, dh);
    gl.viewport(0, 0, dw, dh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, small.fb);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sharp);
    gl.useProgram(this.copy.p);
    gl.uniform1i(this.copy.loc('uTex'), 0);
    gl.uniform1f(this.copy.loc('uLod'), Math.log2(f));
    this.quadDraw(this.copy);
    const sigma = sigmaPx / f;
    gl.useProgram(this.blur.p);
    gl.uniform1i(this.blur.loc('uTex'), 0);
    gl.uniform1f(this.blur.loc('uSigma'), Math.max(sigma, 0.01));
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fb);
    gl.bindTexture(gl.TEXTURE_2D, small.tex);
    gl.uniform2f(this.blur.loc('uStep'), 1 / dw, 0);
    this.quadDraw(this.blur);
    gl.bindFramebuffer(gl.FRAMEBUFFER, small.fb);
    gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
    gl.uniform2f(this.blur.loc('uStep'), 0, 1 / dh);
    this.quadDraw(this.blur);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return small;
  }

  /** Screen `i` (0 = from, 1 = to) from a 2D canvas, with its blurred copies. */
  setScreen(i, c, widthPt, heightPt, blurPt) {
    const gl = this.gl;
    this.sizePt = { w: widthPt, h: heightPt };
    let s = this.screens[i];
    if (s && (s.w !== c.width || s.h !== c.height)) {
      this.dropScreen(s);
      s = null;
    }
    if (!s) {
      s = { sharp: this.texture(c.width, c.height, c, true), near: null, far: null, w: c.width, h: c.height };
    } else {
      gl.bindTexture(gl.TEXTURE_2D, s.sharp);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    s.near = this.blurred(s.sharp, s.w, s.h, NEAR, s.near);
    s.far = this.blurred(s.sharp, s.w, s.h, Math.max(blurPt, NEAR), s.far);
    this.screens[i] = s;
  }

  dropScreen(s) {
    if (!s) return;
    this.gl.deleteTexture(s.sharp);
    this.drop(s.near);
    this.drop(s.far);
  }

  /** One frame. `front` null draws a screen at rest (`revealed` picks which). */
  render(front, style, lumps, dots, revealedAtRest, seeThrough) {
    const gl = this.gl;
    const [content, revealed] = this.screens;
    if (!content || !revealed) return;
    const pw = this.canvas.width;
    const ph = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, pw, ph);
    gl.disable(gl.BLEND);
    const m = this.main;
    gl.useProgram(m.p);
    const tex = [
      ['uC0', content.sharp], ['uC1', content.near.tex], ['uC2', content.far.tex],
      ['uR0', revealed.sharp], ['uR1', revealed.near.tex], ['uR2', revealed.far.tex],
    ];
    tex.forEach(([name, t], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(m.loc(name), i);
    });
    gl.uniform2f(m.loc('uSize'), this.sizePt.w, this.sizePt.h);
    gl.uniform2f(m.loc('uPx'), pw, ph);
    gl.uniform1i(m.loc('uLive'), front ? 1 : 0);
    gl.uniform1i(m.loc('uSee'), seeThrough === 2 ? 2 : seeThrough ? 1 : 0);
    if (!front) {
      gl.uniform1i(m.loc('uRevealed'), revealedAtRest ? 1 : 0);
      this.quadDraw(m);
      return;
    }
    const f = this.field;
    f[0] = front.ox; f[1] = front.oy; f[2] = front.spine; f[3] = front.radius; f[4] = front.squash;
    f[5] = front.time; f[6] = front.energy; f[7] = front.swell; f[8] = front.width; f[9] = front.height;
    f[10] = front.gravity; f[11] = front.glow; f[12] = front.clearRadius; f[13] = front.rim; f[14] = front.tilt;
    f[15] = front.ring ? 1 : 0; f[16] = front.hold; f[17] = front.launched ? 1 : 0; f[18] = front.hairClearRadius;
    gl.uniform1fv(m.loc('uF'), f);
    const acting = front.energy > 0;
    gl.uniform1i(m.loc('uContent'), front.hasCleared ? 0 : 1);
    gl.uniform1i(m.loc('uRevealed'), front.launched ? 1 : 0);
    gl.uniform1i(m.loc('uLens'), acting || front.gravity > 0 ? 1 : 0);
    gl.uniform1f(m.loc('uAmplitude'), style.amplitude);
    gl.uniform1f(m.loc('uLensWidth'), style.lensWidth);
    gl.uniform1f(m.loc('uAberration'), style.aberration);
    gl.uniform1f(m.loc('uBlur'), acting ? Math.max(style.blur, NEAR) : 0);
    gl.uniform1f(m.loc('uBlurAhead'), style.blurAhead);
    gl.uniform1f(m.loc('uBlurBehind'), style.blurBehind);
    gl.uniform1f(m.loc('uNear'), NEAR);
    const colors = style.palette.colors.slice(0, 9);
    if (this.palKey !== style.palette) {
      this.palKey = style.palette;
      colors.forEach((c, i) => this.pal.set(oklab(c), i * 3));
      this.ahead.set(oklab(style.palette.ahead));
      this.behind.set(oklab(style.palette.behind));
    }
    gl.uniform3fv(m.loc('uPal'), this.pal);
    gl.uniform1i(m.loc('uPalCount'), Math.max(colors.length, 1));
    gl.uniform3fv(m.loc('uAhead'), this.ahead);
    gl.uniform3fv(m.loc('uBehind'), this.behind);
    gl.uniform1f(m.loc('uLead'), style.lead);
    gl.uniform1f(m.loc('uTail'), style.tail);
    gl.uniform1f(m.loc('uStrength'), style.strength);
    gl.uniform1f(m.loc('uRimWidth'), style.rimWidth);
    gl.uniform1f(m.loc('uRimSoftness'), style.rimSoftness);
    gl.uniform1f(m.loc('uCorner'), style.cornerRadius);
    gl.uniform1f(m.loc('uUneven'), style.rimUnevenness);
    gl.uniform1f(m.loc('uPulse'), style.rimPulse);
    gl.uniform1f(m.loc('uHairW'), style.hairlineWidth);
    gl.uniform1f(m.loc('uHairO'), style.hairlineOpacity);
    gl.uniform1f(m.loc('uHairWhite'), style.hairlineWhite);
    gl.uniform3fv(m.loc('uLumps'), lumps);
    this.quadDraw(m);

    if (dots && dots.count > 0) {
      const d = this.dot;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(d.p);
      gl.uniform2f(d.loc('uSize'), this.sizePt.w, this.sizePt.h);
      const scale = pw / this.sizePt.w;
      gl.uniform1f(d.loc('uScale'), scale);
      gl.uniform1f(d.loc('uPoint'), Math.ceil((style.particleSize + 1) * scale) + 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dots);
      if (this.dotsSize < dots.data.length) {
        gl.bufferData(gl.ARRAY_BUFFER, dots.data.byteLength, gl.DYNAMIC_DRAW);
        this.dotsSize = dots.data.length;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, dots.data, 0, dots.count * 3);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, dots.count);
      gl.disable(gl.BLEND);
    }
  }

  /** Frees everything, then drops the context itself so nothing is left. */
  dispose() {
    const gl = this.gl;
    if (!gl.isContextLost()) {
      this.screens.forEach((s) => this.dropScreen(s));
      for (const t of this.scratches.values()) this.drop(t);
      for (const p of [this.main, this.blur, this.copy, this.dot]) if (p) gl.deleteProgram(p.p);
      gl.deleteBuffer(this.quad);
      gl.deleteBuffer(this.dots);
    }
    this.screens = [null, null];
    this.scratches.clear();
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose && !gl.isContextLost()) lose.loseContext();
  }
}

/* ── Sources: drawn "cover" into a 2D canvas the size of the backing store ─ */

class TaintError extends Error {}

function sourceSize(src) {
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight];
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) return [src.naturalWidth, src.naturalHeight];
  return [src.width, src.height];
}

/** Draws `src` (element, bitmap or CSS colour) into `c`. Throws TaintError if
    the canvas can no longer be read back (and so could not be uploaded). */
function paint(c, src) {
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  ctx.clearRect(0, 0, w, h);
  if (src == null || typeof src === 'string') {
    ctx.fillStyle = src || '#000';
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const [sw, sh] = sourceSize(src);
  if (sw > 0 && sh > 0) {
    const k = Math.max(w / sw, h / sh);
    const dw = sw * k;
    const dh = sh * k;
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  try {
    ctx.getImageData(0, 0, 1, 1);
  } catch (e) {
    throw new TaintError('cross-origin source taints the canvas (set crossorigin="anonymous")');
  }
}

const isLiveVideo = (src) => typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement && !src.paused && !src.ended;

function readRect(rect) {
  if (rect) return { x: rect.x ?? rect.left ?? 0, y: rect.y ?? rect.top ?? 0, w: rect.width, h: rect.height };
  return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    return false;
  }
}

/* ── Public API ─────────────────────────────────────────────────────── */

const STYLE_KEYS = Object.keys(defaultStyle('vertical')).filter((k) => k !== 'type' && k !== 'palette');

function resolvePalette(p) {
  if (!p) return null;
  if (typeof p === 'string') return PALETTES[p] || null;
  if (Array.isArray(p)) return singlePalette(p);
  return p;
}

/**
 * createWaves(options?)
 *   scale        pt -> CSS px (default 'auto': sqrt(area/phone area) clamped 1..1.35)
 *   dprCap       2
 *   zIndex       2147483000
 *   cornerRadius rim corner radius in CSS px (default 0; set it for rounded rects)
 *   palette      'colorful' | 'green' | 'ocean' | 'sunset' | 'mono' | [r,g,b] | {colors,ahead,behind}
 *   vertical / center   per-mode overrides of any upstream style key
 *   <any style key>     override for both modes (lengths in upstream pt)
 *   onRevealed   called when `to` is fully on screen (before the rim clears)
 *   reducedMotion 'auto' | true | false
 *   seeThroughAfterReveal  false
 *   play() also takes: overlay, speed, onFrame, onMount (see port notes)
 *   onError      (err) => void  (shader logs, taint, context loss)
 */
export function createWaves(options = {}) {
  const opts = { scale: 'auto', dprCap: 2, zIndex: 2147483000, cornerRadius: 0, reducedMotion: 'auto', seeThroughAfterReveal: false, ...options };
  let supported = false;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    supported = !!gl;
    const lose = gl && gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  } catch (e) {
    supported = false;
  }
  let current = null;
  let destroyed = false;
  const api = { supported, lastError: null };
  const debug = typeof location !== 'undefined' && /[?&]wavedebug\b/.test(location.search);
  const marks = [];
  const mark = (label) => { if (debug) marks.push([label, performance.now()]); };
  const flushMarks = (title) => {
    if (!debug || !marks.length) return;
    const t0 = marks[0][1];
    console.log(`[wavedebug] ${title}: ` + marks.map(([l, t], i) => `${l} +${(t - (i ? marks[i - 1][1] : t0)).toFixed(1)}ms`).join(' · ') + ` · total ${(marks[marks.length - 1][1] - t0).toFixed(1)}ms`);
    marks.length = 0;
  };

  /* PORT: one context, canvas and program set for every play (was: a new
     context and four freshly compiled programs per play, which blocked the
     main thread for ~1 s on the first frame). */
  let shared = null;
  function sharedStage() {
    if (shared && !shared.r.gl.isContextLost()) return shared;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const r = new Renderer(canvas, true);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); shared = null; });
    shared = { canvas, r, checked: false };
    return shared;
  }
  /** Creates the context and starts compiling at a quiet moment, then (at the
      next quiet moment, once the driver says it is done) draws one tiny
      off-screen frame so the shaders are fully prepared before the first click. */
  function warm() {
    if (!supported || destroyed) return;
    let sh;
    try { sh = sharedStage(); } catch (e) { report(e); return; }
    if (sh.warmed) return;
    const idle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 300));
    let tries = 0;
    const prime = () => {
      if (destroyed || current || sh !== shared || sh.warmed) return;
      if (!sh.r.ready() && tries++ < 20) { idle(prime); return; }
      const t0 = performance.now();
      try {
        // full-viewport backing store (what a real play allocates), tiny screens
        const g = prepare({ mode: 'vertical' });
        const tiny = () => { const c = document.createElement('canvas'); c.width = c.height = 8; return { c, tainted: false, live: false, src: null }; };
        sh.canvas.width = g.pw;
        sh.canvas.height = g.ph;
        const stage = glStage(g, [tiny(), tiny()], sh);
        stage.draw(0.3);
        sh.r.gl.finish();
        sh.warmed = true;
        if (debug) console.log(`[wavedebug] warm draw ${(performance.now() - t0).toFixed(1)}ms`);
      } catch (e) { report(e); }
    };
    idle(prime);
  }

  const report = (err) => {
    api.lastError = err;
    console.error('[waves]', err && err.message ? err.message : err);
    if (opts.onError) try { opts.onError(err); } catch (e) { /* ignore */ }
  };

  function styleFor(mode, extra) {
    const s = defaultStyle(mode);
    for (const src of [opts, opts[mode] || {}, extra || {}]) {
      for (const k of STYLE_KEYS) if (typeof src[k] === 'number') s[k] = src[k];
      const pal = resolvePalette(src.palette);
      if (pal) s.palette = pal;
    }
    return s;
  }

  /** Everything both play() and scrub() need: geometry, style, the mounted canvas. */
  function prepare(o) {
    const mode = o.mode === 'center' || o.mode === 'horizontal' ? o.mode : 'vertical';
    const rect = readRect(o.rect);
    const k = opts.scale === 'auto' || opts.scale == null
      ? clamp(Math.sqrt((rect.w * rect.h) / (PHONE_W * PHONE_H)), 1, 1.35)
      : opts.scale;
    const style = styleFor(mode, o.tuning);
    // PORT: lengths that should stay in CSS px.
    if (!(o.tuning && typeof o.tuning.hairlineWidth === 'number') && typeof opts.hairlineWidth !== 'number') style.hairlineWidth = 1.5 / k;
    const cornerPx = o.cornerRadius ?? (opts[mode] && opts[mode].cornerRadiusPx) ?? opts.cornerRadius;
    style.cornerRadius = cornerPx / k;
    const W = rect.w / k;
    const H = rect.h / k;
    const ox = o.origin ? clamp(o.origin.x - rect.x, 0, rect.w) / k : W / 2;
    const oy = o.origin ? clamp(o.origin.y - rect.y, 0, rect.h) / k : H / 2;
    const focus = { x: ox, y: oy };
    let source;
    const anchor = o.anchor || null;
    if (anchor && anchor.getBoundingClientRect) {
      const b = anchor.getBoundingClientRect();
      source = { x: (b.left - rect.x) / k, y: (b.top - rect.y) / k, w: Math.max(b.width / k, 8), h: Math.max(b.height / k, 8) };
    } else {
      const [sw, sh] = mode === 'center' ? [64, 64] : mode === 'horizontal' ? [24, 120] : [120, 44];
      source = { x: ox - sw / 2, y: oy - sh / 2, w: sw, h: sh };
    }
    const flip = mode === 'vertical' && source.y + source.h / 2 < H / 2;
    const dpr = Math.min(window.devicePixelRatio || 1, opts.dprCap);
    const pw = Math.max(1, Math.round(rect.w * dpr));
    const ph = Math.max(1, Math.round(rect.h * dpr));
    const total = duration(style);
    // When `to` is fully on screen: the first progress at which the front has crossed.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (waveFront(mid, source, W, H, style, focus, flip).hasCleared) hi = mid;
      else lo = mid;
    }
    const speed = o.speed > 0 ? o.speed : 1;
    return { mode, rect, k, style, W, H, focus, source, flip, dpr, pw, ph, total, revealedAt: hi, anchor, speed, overlay: !!o.overlay };
  }

  function mountBox(g, tag, reuse) {
    const el = reuse || document.createElement(tag);
    const st = el.style;
    st.position = 'fixed';
    st.left = g.rect.x + 'px';
    st.top = g.rect.y + 'px';
    st.width = g.rect.w + 'px';
    st.height = g.rect.h + 'px';
    st.pointerEvents = 'none';
    st.zIndex = String(opts.zIndex);
    st.display = 'block';
    st.margin = '0';
    st.border = '0';
    st.padding = '0';
    if (opts.cornerRadius) {
      st.borderRadius = opts.cornerRadius + 'px';
      st.overflow = 'hidden';
    }
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function rasterise(g, from, to) {
    const make = (src) => {
      const c = document.createElement('canvas');
      // overlay: nothing is sampled, so a 2x2 placeholder is enough
      c.width = g.overlay ? 2 : g.pw;
      c.height = g.overlay ? 2 : g.ph;
      if (g.overlay) return { c, tainted: false, live: false, src: null };
      // PORT: a canvas already at the backing-store size is used as is (no
      // second raster pass, no read-back); taint then shows up at upload.
      if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement && src.width === g.pw && src.height === g.ph) {
        c.width = c.height = 0;
        return { c: src, tainted: false, live: false, src };
      }
      let tainted = false;
      try {
        paint(c, src);
      } catch (e) {
        if (!(e instanceof TaintError)) throw e;
        tainted = true;
      }
      return { c, tainted, live: isLiveVideo(src), src };
    };
    return [make(from), make(to)];
  }

  /** Builds a GL stage for geometry `g` on the shared context (throws ShaderError on failure). */
  function glStage(g, shots, sh) {
    const r = sh.r;
    if (!sh.checked) { r.check(); sh.checked = true; }
    mark('programs');
    try {
      shots.forEach((s, i) => r.setScreen(i, s.c, g.W, g.H, g.style.blur));
    } catch (e) {
      if (e && e.name === 'SecurityError') throw new TaintError('cross-origin source taints the canvas (set crossorigin="anonymous")');
      throw e;
    }
    mark('upload+blur');
    const particles = makeParticles(g.style);
    const buf = { data: new Float32Array(Math.max(particles.length, 1) * 3), count: 0 };
    /** Draws progress p (0–1). Returns the front (or null at rest). */
    const draw = (p) => {
      for (let i = 0; i < 2; i++) {
        const s = shots[i];
        if (s.live && isLiveVideo(s.src)) {
          paint(s.c, s.src);
          r.setScreen(i, s.c, g.W, g.H, g.style.blur);
        }
      }
      const t = clamp(p, 0, 1) * g.total;
      const lumps = rimLumps(t, g.W, g.H, g.style.cornerRadius, g.style.rimPulse);
      const see = g.overlay ? 2 : !!opts.seeThroughAfterReveal;
      if (p <= 0 || p >= 1) {
        r.render(null, g.style, lumps, null, p >= 1, g.overlay ? 2 : false);
        return null;
      }
      const front = waveFront(p, g.source, g.W, g.H, g.style, g.focus, g.flip);
      let n = 0;
      if (front.time > 0) {
        for (const part of particles) {
          const at = particleAt(part, front, g.source, g.style);
          if (at.a <= 0.002) continue;
          buf.data[n * 3] = at.x;
          buf.data[n * 3 + 1] = at.y;
          buf.data[n * 3 + 2] = Math.floor(part.size * 10) + Math.min(at.a, 0.999);
          n++;
        }
      }
      buf.count = n;
      r.render(front, g.style, lumps, buf, false, see);
      return front;
    };
    return { r, draw };
  }

  /* The anchor's "gulp": scale(0.93) over the anticipation, then a springy
     release (preview.css .dw-button / .is-gulp). Vertical only, as upstream. */
  function gulp(g) {
    const el = g.anchor;
    if (!el || !el.style || g.mode !== 'vertical' || g.style.anticipation <= 0) return { release() {}, restore() {} };
    const prevT = el.style.transform;
    const prevTr = el.style.transition;
    const base = prevT && prevT !== 'none' ? prevT + ' ' : '';
    el.style.transition = `transform ${g.style.anticipation}s cubic-bezier(0.4, 0, 0.6, 1)`;
    void el.offsetWidth;
    el.style.transform = base + 'scale(0.93)';
    let released = false;
    let restored = false;
    let timer = 0;
    return {
      release() {
        if (released) return;
        released = true;
        el.style.transition = 'transform 0.28s cubic-bezier(0.34, 1.35, 0.64, 1)';
        el.style.transform = prevT;
        timer = setTimeout(() => this.restore(), 320);
      },
      restore() {
        if (restored) return;
        restored = true;
        clearTimeout(timer);
        el.style.transform = prevT;
        el.style.transition = prevTr;
      },
    };
  }

  function crossfade(g, shots, seconds, hooks) {
    const box = mountBox(g, 'div');
    shots.forEach((s, i) => {
      const st = s.c.style;
      st.position = 'absolute';
      st.inset = '0';
      st.width = '100%';
      st.height = '100%';
      st.opacity = i === 0 ? '1' : '0';
      box.appendChild(s.c);
    });
    document.body.appendChild(box);
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const p = clamp((performance.now() - start) / 1000 / seconds, 0, 1);
      shots[1].c.style.opacity = String(p);
      if (p >= 1) {
        hooks.revealed();
        hooks.end();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      box.remove();
      shots.forEach((s) => { s.c.width = s.c.height = 0; });
    };
  }

  /**
   * play({ from, to, origin, mode, rect, anchor, onRevealed, tuning }) -> Promise<void>
   * The promise carries `.revealed` (a Promise) and `.finish()` (jump to the end).
   */
  function play(o = {}) {
    if (current) current.finish();
    let resolveDone;
    let resolveRevealed;
    const done = new Promise((res) => { resolveDone = res; });
    const revealed = new Promise((res) => { resolveRevealed = res; });
    let isRevealed = false;
    let ended = false;
    let teardown = () => {};
    let gulpCtl = { release() {}, restore() {} };
    const fireRevealed = () => {
      if (isRevealed) return;
      isRevealed = true;
      resolveRevealed();
      for (const cb of [o.onRevealed, opts.onRevealed]) if (cb) try { cb(); } catch (e) { console.error(e); }
    };
    const run = {
      finish() {
        if (ended) return;
        ended = true;
        fireRevealed();
        gulpCtl.restore();
        try { teardown(); } catch (e) { /* ignore */ }
        if (current === run) current = null;
        resolveDone();
      },
    };
    done.revealed = revealed;
    done.finish = () => run.finish();
    if (destroyed) {
      run.finish();
      return done;
    }
    current = run;

    let g;
    let shots;
    marks.length = 0;
    mark('click→play');
    try {
      g = prepare(o);
      mark('prepare');
      shots = rasterise(g, o.from, o.to);
      mark('rasterise');
    } catch (e) {
      report(e);
      run.finish();
      return done;
    }
    const hooks = { revealed: fireRevealed, end: () => run.finish() };
    const reduce = opts.reducedMotion === true || (opts.reducedMotion === 'auto' && prefersReducedMotion());
    const tainted = shots.some((s) => s.tainted);
    if (tainted) report(new TaintError('cross-origin source: falling back to a crossfade (set crossorigin="anonymous" on the media)'));
    if (g.overlay && (reduce || !supported)) {
      // colour-only run under reduced motion: nothing to show, caller switches at once
      fireRevealed();
      run.finish();
      return done;
    }
    if (reduce || tainted || !supported) {
      teardown = crossfade(g, shots, 0.3, hooks);
      return done;
    }

    let sh;
    let stage;
    try {
      sh = sharedStage();
      mark('context');
    } catch (e) {
      report(e);
      teardown = crossfade(g, shots, 0.3, hooks);
      return done;
    }
    const canvas = mountBox(g, 'canvas', sh.canvas);
    if (canvas.width !== g.pw) canvas.width = g.pw;
    if (canvas.height !== g.ph) canvas.height = g.ph;
    try {
      stage = glStage(g, shots, sh);
    } catch (e) {
      report(e);
      if (!(e instanceof TaintError)) shared = null;
      teardown = crossfade(g, shots, 0.3, hooks);
      return done;
    }
    let raf = 0;
    const onLost = (e) => {
      e.preventDefault();
      if (ended) return;
      report(new Error('WebGL context lost mid-wave; jumping to the end'));
      run.finish();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    stage.draw(0);
    mark('first draw');
    if (o.onMount) try { o.onMount(canvas); } catch (e) { console.error(e); }
    document.body.appendChild(canvas);
    gulpCtl = gulp(g);
    const start = performance.now();
    let firstFrame = true;
    let clock = 0;
    let clockT = start;
    const frameLog = [];
    let lastT = start;
    const tick = () => {
      if (ended) return;
      if (firstFrame) { firstFrame = false; mark('first rAF'); flushMarks(g.overlay ? 'overlay' : g.mode); }
      if (debug) {
        const now = performance.now();
        if (frameLog.length < 12) frameLog.push(Math.round(now - lastT));
        else if (frameLog.length === 12) { frameLog.push(0); console.log(`[wavedebug] first frame gaps (ms): ${frameLog.slice(0, 12).join(' ')}`); }
        lastT = now;
      }
      // PORT: frame-clamped clock. A long frame (page snapshot, GC, a busy
      // main thread) advances the wave by at most 0.1 s instead of skipping it;
      // ordinary slow frame rates still run in real time.
      const nowT = performance.now();
      clock += Math.min((nowT - clockT) / 1000, 0.1) * g.speed;
      clockT = nowT;
      const elapsed = clock;
      if (elapsed >= g.style.anticipation) gulpCtl.release();
      const p = elapsed / g.total;
      if (p >= 1) {
        stage.draw(1);
        run.finish();
        return;
      }
      let front;
      try {
        front = stage.draw(p);
      } catch (e) {
        report(e);
        run.finish();
        return;
      }
      if (front && o.onFrame) {
        try { o.onFrame({ x: g.rect.x + front.ox * g.k, y: g.rect.y + front.oy * g.k, r: front.radius * g.k, revealed: front.hasCleared }); }
        catch (e) { console.error(e); }
      }
      if (front && front.hasCleared) fireRevealed();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    teardown = () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.remove();
      canvas.style.viewTransitionName = '';
      shots.forEach((s) => { s.c.width = s.c.height = 0; });
    };
    return done;
  }

  /**
   * scrub({ from, to, origin, mode, rect, anchor, tuning }) -> { render(p), info, destroy() }
   * A frozen-frame stage for checking the animation at any progress (0–1).
   * Mounts the same fixed canvas; nothing animates.
   */
  function scrub(o = {}) {
    if (!supported) throw new Error('WebGL2 unavailable');
    const g = prepare(o);
    const shots = rasterise(g, o.from, o.to);
    if (shots.some((s) => s.tainted)) throw new TaintError('cross-origin source taints the canvas');
    const sh = sharedStage();
    const canvas = mountBox(g, 'canvas', sh.canvas);
    canvas.width = g.pw;
    canvas.height = g.ph;
    const stage = glStage(g, shots, sh);
    document.body.appendChild(canvas);
    return {
      canvas,
      info: { duration: g.total, revealedAt: g.revealedAt, revealedAtSeconds: g.revealedAt * g.total, scale: g.k, dpr: g.dpr, mode: g.mode, flip: g.flip },
      render(p) {
        const f = stage.draw(p);
        return f ? { hasCleared: f.hasCleared, launched: f.launched, radius: f.radius, energy: f.energy, glow: f.glow, rim: f.rim } : null;
      },
      destroy() {
        canvas.remove();
      },
    };
  }

  /** Timing for a mode at a rect, without drawing: { duration, revealedAt (0–1), revealedAtSeconds }. */
  function timing(o = {}) {
    const g = prepare(o);
    return { duration: g.total / g.speed, revealedAt: g.revealedAt, revealedAtSeconds: (g.revealedAt * g.total) / g.speed, scale: g.k };
  }

  api.play = play;
  api.warm = warm;
  api.ready = () => !!shared && shared.r.ready();
  api.scrub = scrub;
  api.timing = timing;
  api.destroy = () => {
    destroyed = true;
    if (current) current.finish();
    if (shared) { shared.r.dispose(); shared = null; }
  };
  return api;
}

export default createWaves;
