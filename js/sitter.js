// sitter.js — Alex's own 3D figure, seated on the top edge of a strip card (Nov 12).
//
//   const s = await createSitter(hostEl, { modelUrl, strip, avoid, getVelocity, isDragging, onGesture });
//   s.setPaused(bool); s.destroy();
//
// He sits on the card nearest the middle of the strip and rides with it (a point of the
// card's top edge is read every frame, including the fold's slices). Near a screen edge he
// fades out and sits back down on the card nearest the middle once the strip is calm.
// Head follows the cursor. A click on his own pixels: he hops down and stands on the page a
// little under the strip while the carousel keeps moving behind him; ~2.5 s later (or on a
// second click) he hops back up onto whichever card is above him. Phones: he comes and goes,
// seated ~5–10 s on the most visible card, then somewhere else. With an older GLB that has
// no hop clips (or no clip timing file) the click runs the earlier stand-up on the edge.
// Reduced motion: a still seated pose. The canvas never takes pointer events: hits are
// tested on his rendered pixels.
//
// The pieces (loadThree, loadFigure, makeStage, frameCamera, createLook, createShadow)
// are exported; sitter-test.html runs createSitter itself on a mock strip.

const THREE_VERSION = '0.170.0';
const ESM = `https://esm.sh/three@${THREE_VERSION}`;
const CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}`;

// ---- model facts (assets/3d/alex-sitter.glb) ------------------------------------------
// Origin = the seat point: y = 0 is the underside of his thighs in `sit`. Faces +Z.
export const FIG = {
  SEAT_TO_HEAD: 1.05,     // seat to top of head, seated
  STAND_GROUND: -0.4228,  // feet in `stand`, below the seat
  STAND_H: 1.79,          // standing height
};
const STAND_K = FIG.STAND_H / FIG.SEAT_TO_HEAD;    // fallback (standing ON the edge): head height / seated head height (1.705)
const TURN_DEG = 24;
const SPEED = 1.3;                                  // fallback standup (and its reverse) play speed
const STAND_HOLD = 2.5;                             // s standing in front of the card before hopping back up
const FACE_Z = -0.1;                                // the card face, just behind his hips

const THEMES = {
  light: { hemiSky: 0xffffff, hemiGround: 0xd8d8d8, hemi: 2.2, key: 1.1, rim: 0.6, shadowWall: 0.4, shadowFloor: 0.36 },
  // as js/walker.js: on near-black the black trousers vanish, so lift the fill and draw the
  // silhouette with a cool-neutral back light (no glow, no outline)
  dark: { hemiSky: 0xffffff, hemiGround: 0xbfbfbf, hemi: 2.5, key: 1.25, rim: 2.6, shadowWall: 0.5, shadowFloor: 0.6 },
};

let threePromise = null;
export function loadThree() {
  if (!threePromise) {
    threePromise = Promise.all([
      import(ESM),
      import(`${ESM}/examples/jsm/loaders/GLTFLoader.js`),
      import(`${ESM}/examples/jsm/loaders/DRACOLoader.js`),
    ]).then(([THREE, g, d]) => ({ THREE, GLTFLoader: g.GLTFLoader, DRACOLoader: d.DRACOLoader }));
    threePromise.catch(() => { threePromise = null; });
  }
  return threePromise;
}

function webglAvailable() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }
  catch (_) { return false; }
}

/* Renderer, lights (the walker's treatment), a turned pivot at the seat point. */
export function makeStage(THREE, canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xffffff, 0xd8d8d8, 2.2); scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(2, 4, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0xf2f5ff, 0); rim.position.set(-3, 3.5, -5); scene.add(rim);
  const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 100);
  const pivot = new THREE.Group();                  // the fixed presentation turn; never moved by the pointer
  pivot.rotation.y = THREE.MathUtils.degToRad(TURN_DEG);
  scene.add(pivot);
  const applyTheme = (name) => {
    const t = THEMES[name] || THEMES.light;
    hemi.color.setHex(t.hemiSky); hemi.groundColor.setHex(t.hemiGround); hemi.intensity = t.hemi;
    key.intensity = t.key; rim.intensity = t.rim;
    return t;
  };
  return { renderer, scene, camera, pivot, hemi, key, rim, applyTheme };
}

/* Camera so that `ppu` px = 1 unit and the seat point lands on canvas px (seatX, seatY). */
export function frameCamera(THREE, camera, W, H, ppu, seatX, seatY) {
  camera.aspect = W / H;
  const d = H / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * ppu);
  // the eye at seat height: the seat plane (the card's top, a ledge going back into the page) is
  // then seen edge-on, so everything resting on it (his bottom, his hands) is drawn exactly on the
  // card's top edge line. (It was 0.55 u above: the back of his seat was drawn above the edge,
  // a sliver of page showed under it.)
  camera.position.set(0, 0, d);
  camera.lookAt(0, 0, 0);
  camera.clearViewOffset(); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const p = new THREE.Vector3(0, 0, 0).project(camera);
  camera.setViewOffset(W, H, (p.x * 0.5 + 0.5) * W - seatX, (-p.y * 0.5 + 0.5) * H - seatY, W, H);
  camera.updateProjectionMatrix();
}

/* The hop timing contract written by the model build (assets/3d/alex-sitter-clips.json).
   Accepts { clips: { hopdown: {...} } } or { hopdown: {...} }. null when unusable. */
export async function loadClipTiming(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    const j = await r.json(), c = j.clips || j;
    const ok = (x) => x && Number.isFinite(+x.takeoff) && Number.isFinite(+x.land) && +x.land > +x.takeoff;
    // walk (v5): ground speed in model units/s (`speed`, else stride length / cycle), hips offset of the stand pose
    const wk = c.walk, wSpeed = wk && (+wk.speed || ((+wk.strideLength || +wk.stride) / (+wk.cycleDuration || +wk.duration)));
    const walk = Number.isFinite(wSpeed) && wSpeed > 0 ? { speed: wSpeed, cycle: +wk.cycleDuration || +wk.duration || 1.4, hips: [+wk.hipsX || 0.1067, +wk.hipsForwardZ || 0.42] } : null;
    const seat = j.seat && Number.isFinite(+j.seat.xMin) && Number.isFinite(+j.seat.xMax) ? { xMin: +j.seat.xMin, xMax: +j.seat.xMax, z: ((+j.seat.zFront || 0.12) + (+j.seat.zBack || 0.12)) / 2 } : null;
    return ok(c.hopdown) && ok(c.hopup) ? { hopdown: { takeoff: +c.hopdown.takeoff, land: +c.hopdown.land }, hopup: { takeoff: +c.hopup.takeoff, land: +c.hopup.land }, walk, seat, hands: j.hands || null } : null;
  } catch (_) { return null; }
}

/* GLB → model in the pivot, bones, mixer, the actions, the fallback lift curve, the feet. */
export async function loadFigure(T, url, pivot) {
  const { THREE } = T;
  const draco = new T.DRACOLoader().setDecoderPath(`${CDN}/examples/jsm/libs/draco/gltf/`);
  const gltf = await new T.GLTFLoader().setDRACOLoader(draco).loadAsync(url);
  draco.dispose();
  const model = gltf.scene;
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    if (o.material && o.material.isMeshStandardMaterial) {
      o.material.roughness = 0.85; o.material.metalness = 0;
    }
  });
  pivot.add(model);
  const bones = {};
  model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const mixer = new THREE.AnimationMixer(model);
  const clip = (n) => gltf.animations.find((c) => c.name === n || c.name.toLowerCase().split(/[|:/]/).pop() === n);
  if (!clip('sit') || !clip('stand') || !bones.Head || !bones.neck || !bones.Spine) throw new Error('sitter: model is missing clips or bones');
  const A = { sit: mixer.clipAction(clip('sit')), stand: mixer.clipAction(clip('stand')) };
  if (clip('walk')) A.walk = mixer.clipAction(clip('walk'));     // v5: an in-place loop (the GLB's leap clip is not used)
  for (const n of ['standup', 'hopdown', 'hopup', 'walkstart', 'walkstop']) {
    if (!clip(n)) continue;
    A[n] = mixer.clipAction(clip(n));
    A[n].setLoop(THREE.LoopOnce, 1); A[n].clampWhenFinished = true;
  }
  const v = new THREE.Vector3();
  const poseAt = (a, t) => { mixer.stopAllAction(); a.reset().setEffectiveWeight(1).play(); a.time = t; mixer.update(0); model.updateMatrixWorld(true); };

  // fallback (no hop clips): how far he has risen in `standup` (0..1, monotone), from the
  // clip's own hip height, so his feet land on the card's top edge when he stands
  let liftAt = () => 0;
  if (A.standup) {
    const N = 64, curve = new Float32Array(N + 1), ys = [], a = A.standup, d = a.getClip().duration;
    for (let i = 0; i <= N; i++) { poseAt(a, (i / N) * d); ys.push(bones.Hips.getWorldPosition(v).y); }
    for (let i = 0; i <= N; i++) { const k = THREE.MathUtils.clamp((ys[i] - ys[0]) / (ys[N] - ys[0]), 0, 1); curve[i] = k * k * (3 - 2 * k); }
    for (let i = 1; i <= N; i++) curve[i] = Math.max(curve[i], curve[i - 1]);
    liftAt = (t) => { const x = THREE.MathUtils.clamp(t / d, 0, 1) * N, i = Math.floor(x); return curve[i] + (curve[Math.min(i + 1, N)] - curve[i]) * (x - i); };
  }
  // where his feet stand in `stand` frame 0 (world, with the turn): the point that must land on the card's bottom edge
  poseAt(A.stand, 0);
  const feet = new THREE.Vector3(); let nf = 0;
  for (const n of ['LeftToeBase', 'RightToeBase', 'LeftFoot', 'RightFoot']) if (bones[n]) { feet.add(bones[n].getWorldPosition(v)); nf++; }
  if (nf) feet.divideScalar(nf);
  feet.y = FIG.STAND_GROUND;
  mixer.stopAllAction();
  return { gltf, model, bones, mixer, A, liftAt, feet };
}

/* ---- the card's visible top edge ----------------------------------------------------------
   Several covers start with a thin pale band (UI chrome, a light frame) that is nearly invisible
   on the light page, so the eye reads the artwork below it as the card's top. Per cover, a small
   CORS copy of its top rows is read once: per column, the first row that stands out from the page
   background (ΔL* ≥ 25), searched only in the top 5 % of the card. No such row (a genuinely pale
   card, or a dark card on the dark page): the tile's own edge. Results are fractions of the card
   height, so they hold at every size. */
const edgeData = new Map();          // url → Promise<{ w, rows, total, px }>
function coverData(url) {
  if (!edgeData.has(url)) {
    edgeData.set(url, new Promise((res) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => {
        try {
          const w = 512, total = Math.round(w * im.naturalHeight / im.naturalWidth), rows = Math.ceil(total * 0.06);
          const c = document.createElement('canvas'); c.width = w; c.height = rows;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(im, 0, 0, im.naturalWidth, im.naturalHeight * rows / total, 0, 0, w, rows);
          res({ w, rows, total, px: x.getImageData(0, 0, w, rows).data });
        } catch (_) { res(null); }
      };
      im.onerror = () => res(null);
      im.src = /\/upload\//.test(url) ? url.replace(/\/upload\/(?:[a-z]_[^/]*\/)?/, '/upload/w_512,q_auto/') : url;
    }));
  }
  return edgeData.get(url);
}
const Lstar = (r, g, b) => {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
};
/* the visible top as a fraction of the card height, over the columns u0..u1 (fractions of its width) */
function visibleTop(d, u0, u1, pageL) {
  if (!d) return 0;
  const cap = Math.min(d.rows, Math.round(d.total * 0.05)), tops = [];
  for (let cx = Math.max(0, Math.floor(u0 * d.w)); cx <= Math.min(d.w - 1, Math.ceil(u1 * d.w)); cx += 2) {
    let r = 0;
    for (; r < cap; r++) { const i = (r * d.w + cx) * 4; if (Math.abs(Lstar(d.px[i], d.px[i + 1], d.px[i + 2]) - pageL) >= 25) break; }
    tops.push(r >= cap ? 0 : r);                                  // nothing within the band: the tile edge
  }
  tops.sort((a, b) => a - b);
  return tops.length ? tops[tops.length >> 1] / d.total : 0;
}

/* ---- cursor look-at --------------------------------------------------------------------
   Why it used to spin: three's PropertyMixer only writes a bone when the clip's value has
   changed since its last write, so `local *= delta` every frame compounded on any bone
   whose keys were still for a frame (Spine as much as Head): an unbounded turn.
   Now nothing accumulates: the clip's local rotations of Spine / neck / Head are put back
   before the mixer runs (restore) and read right after it (capture), and every frame the
   look offset is rebuilt from scratch on that base (apply); applying twice, or with no
   mixer write in between, gives the same pose. Rotation only: built from the parent's world
   rotation (normalised), positions and scales are never touched. Yaw about the world
   vertical, pitch about the figure's own left-right axis, no roll. Hips, legs, the model
   group and the pivot are never touched (the 24° presentation turn is a constant).
   Target: a saturating map of the cursor's px offset from his head (atan of offset/depth,
   then a soft limit), so far away or behind just saturates, it can never wrap.
   Easing: 1 − e^(−k·dt) with dt ≤ 1/30 s, at most 180°/s. Clamped after easing, in total
   (yaw ±45°, pitch 15° up / 20° down) and per bone (yaw Spine 7° / neck 16° / Head 22°,
   pitch Spine 0 (≤ 3) / neck 40 % / Head 60 %). */
export function createLook(THREE, { bones, pivot, turnDeg = TURN_DEG }) {
  const D = THREE.MathUtils.degToRad, R2D = THREE.MathUtils.radToDeg;
  const YAW = D(45), UP = D(15), DOWN = D(20), MAXV = D(180), DEPTH = 420, IDLE_MS = 4000;
  // [bone, yaw share, yaw clamp, pitch share, pitch clamp up, pitch clamp down]
  const CHAIN = [
    [bones.Spine, 0.15, D(7), 0, D(3), D(3)],
    [bones.neck, 0.35, D(16), 0.4, D(6), D(8)],
    [bones.Head, 0.5, D(22), 0.6, D(9), D(12)],
  ].filter((c) => c[0]);
  const base = CHAIN.map(([b]) => b.quaternion.clone());
  const applied = CHAIN.map(() => ({ yaw: 0, pitch: 0 }));
  const max = CHAIN.map(() => ({ yaw: 0, pitch: 0 }));
  const turn = D(turnDeg);
  let yaw = 0, pitch = 0, weight = 0, ptr = null, lastMove = -1e9, hold = IDLE_MS, warned = false;
  const _p = new THREE.Quaternion(), _r = new THREE.Quaternion(), _y = new THREE.Quaternion(), _x = new THREE.Quaternion(),
    _ax = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _v = new THREE.Vector3();
  const soft = (x, m) => m * Math.tanh(x / m);          // smooth saturation at ±m, never past it
  const clamp = THREE.MathUtils.clamp;
  return {
    /* holdMs: how long the look stays on that point (a tap gives a short glance) */
    pointer(x, y, holdMs = IDLE_MS) {
      if (x == null || !Number.isFinite(x) || !Number.isFinite(y)) { ptr = null; return; }
      ptr = { x, y }; lastMove = performance.now(); hold = holdMs;
    },
    get idle() { return !ptr || performance.now() - lastMove > hold; },
    restore() { CHAIN.forEach(([b], i) => b.quaternion.copy(base[i])); },
    capture() { CHAIN.forEach(([b], i) => base[i].copy(b.quaternion)); },
    /* headScreen: the head's on-screen px; want: 0..1 (fades the look out, e.g. mid-hop) */
    update(dt, headScreen, want = 1) {
      const t = Math.min(Math.max(dt, 0), 1 / 30);
      let ty = 0, tp = 0;
      if (want > 0 && !this.idle && headScreen && Number.isFinite(headScreen.x) && Number.isFinite(headScreen.y)) {
        const a = Math.atan((ptr.x - headScreen.x) / DEPTH) - turn;   // ±90° at most, then model-space (he is turned)
        const p = Math.atan((ptr.y - headScreen.y) / DEPTH);
        ty = soft(a, YAW); tp = p > 0 ? soft(p, DOWN) : soft(p, UP);
      }
      const k = 1 - Math.exp(-t * 6), cap = MAXV * t;
      yaw = clamp(yaw + clamp((ty - yaw) * k, -cap, cap), -YAW, YAW);
      pitch = clamp(pitch + clamp((tp - pitch) * k, -cap, cap), -UP, DOWN);
      weight = clamp(weight + (want - weight) * (1 - Math.exp(-t * 8)), 0, 1);
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(weight)) { yaw = pitch = weight = 0; }
    },
    apply() {
      this.restore();
      const wy = yaw * weight, wp = pitch * weight;
      pivot.updateWorldMatrix(true, true);
      pivot.getWorldQuaternion(_p);
      _ax.set(1, 0, 0).applyQuaternion(_p);                    // the figure's left-right axis
      CHAIN.forEach(([b, ky, my, kp, mu, md], i) => {
        // per-bone angles, clamped after easing
        const by = clamp(wy * ky, -my, my), bp = clamp(wp * kp, -mu, md);
        applied[i].yaw = by; applied[i].pitch = bp;
        max[i].yaw = Math.max(max[i].yaw, Math.abs(by)); max[i].pitch = Math.max(max[i].pitch, Math.abs(bp));
        if (!warned && (Math.abs(by) > my + 1e-6 || bp > md + 1e-6 || -bp > mu + 1e-6)) { warned = true; console.warn('[sitter] look-at angle over its clamp on', b.name, R2D(by), R2D(bp)); }
        if (Math.abs(by) < 1e-6 && Math.abs(bp) < 1e-6) return;
        _y.setFromAxisAngle(_up, by);
        _x.setFromAxisAngle(_ax, bp);
        _r.copy(_y).multiply(_x);                               // world-space delta R
        b.parent.getWorldQuaternion(_p).normalize();           // parent's rotation only (P)
        // local' = P^-1 · R · P · local  ⇒  world' = R · world
        _x.copy(_p).invert().multiply(_r).multiply(_p);
        b.quaternion.premultiply(_x).normalize();
        b.updateMatrixWorld(true);
      });
      const ty = applied.reduce((s, a) => s + Math.abs(a.yaw), 0);
      if (!warned && ty > YAW + 1e-6) { warned = true; console.warn('[sitter] look-at total yaw over 45°', R2D(ty)); }
    },
    headScreen(camera, rect) {
      bones.Head.getWorldPosition(_v).project(camera);
      return { x: rect.left + (_v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-_v.y * 0.5 + 0.5) * rect.height };
    },
    get state() {
      const deg = (o) => ({ yaw: +R2D(o.yaw).toFixed(2), pitch: +R2D(o.pitch).toFixed(2) });
      return { yaw: +R2D(yaw * weight).toFixed(2), pitch: +R2D(pitch * weight).toFixed(2), weight: +weight.toFixed(3),
        bones: Object.fromEntries(CHAIN.map(([b], i) => [b.name, deg(applied[i])])),
        max: Object.fromEntries(CHAIN.map(([b], i) => [b.name, deg(max[i])])) };
    },
    /* per bone: the angle (deg) between its final local rotation and the clip's own (debug) */
    deviation() { return Object.fromEntries(CHAIN.map(([b], i) => [b.name, +R2D(b.quaternion.angleTo(base[i])).toFixed(3)])); },
        resetMax() { max.forEach((m) => { m.yaw = m.pitch = 0; }); },
  };
}

/* ---- grounding shadow ------------------------------------------------------------------
   Round 2 (Alex: "weird and cut"): no shadow map and no receiver you could ever see. Each
   receiver is a projector: the figure is drawn from the receiving plane, along the key
   light's direction (top-front-right), into a 256 px target; a fragment's darkness falls
   with its distance from the plane ((1 − d/far)²), then the target is blurred twice. So the
   shadow is darkest where he touches (the seat line, the soles), and the higher parts lay a
   fainter, softer cast toward the back-left. The plane that shows it is pure black at that
   alpha only; it fades to nothing well before its own edges, and the card clip is a soft
   rounded rect (a few px of feather), never a cut.
     wall:  the card face (seated: masked to the card; standing: the card and the page,
            nothing below the ground line).
     floor: the page "floor" at his feet while he is off the card (hop and standing). */
export function createShadow(THREE, { scene, renderer }) {
  const L = new THREE.Vector3(2, 4, 5).normalize();            // toward the key light
  const RES = 256;
  const depthMat = new THREE.MeshDepthMaterial();
  depthMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
      'float k = clamp( 1.0 - fragCoordZ, 0.0, 1.0 ); gl_FragColor = vec4( vec3( 0.0 ), k * k );');
  };
  const blurMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, dir: { value: new THREE.Vector2() } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
    // 9-tap gaussian through linear sampling
    fragmentShader: `uniform sampler2D map; uniform vec2 dir; varying vec2 vUv;
      void main() {
        float a = texture2D( map, vUv ).a * 0.2270270270;
        a += ( texture2D( map, vUv + dir * 1.3846153846 ).a + texture2D( map, vUv - dir * 1.3846153846 ).a ) * 0.3162162162;
        a += ( texture2D( map, vUv + dir * 3.2307692308 ).a + texture2D( map, vUv - dir * 3.2307692308 ).a ) * 0.0702702703;
        gl_FragColor = vec4( 0.0, 0.0, 0.0, a );
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const tmp = new THREE.WebGLRenderTarget(RES, RES, { depthBuffer: false });
  const v3 = () => new THREE.Vector3();

  function projector(kind) {
    const floor = kind === 'floor';
    const rt = new THREE.WebGLRenderTarget(RES, RES);
    const cam = new THREE.OrthographicCamera();
    cam.matrixAutoUpdate = false;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        map: { value: rt.texture }, opacity: { value: 0.3 },
        rect: { value: new THREE.Vector4(0, 0, 1, 1) }, radius: { value: 0.1 }, feather: { value: 0.035 }, maskW: { value: 0 },
        ground: { value: -1e3 }, groundW: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; varying vec3 vW; void main() { vUv = uv; vec4 w = modelMatrix * vec4( position, 1.0 ); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: `uniform sampler2D map; uniform float opacity, radius, feather, maskW, ground, groundW; uniform vec4 rect;
        varying vec2 vUv; varying vec3 vW;
        float sdRound( vec2 p, vec2 b, float r ) { vec2 q = abs( p ) - b + r; return length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - r; }
        void main() {
          float a = texture2D( map, vUv ).a;
          vec2 e = min( vUv, 1.0 - vUv );
          a *= smoothstep( 0.0, 0.14, min( e.x, e.y ) );                       // nothing reaches the plane's own edges
          float m = 1.0 - smoothstep( -feather, 0.0, sdRound( vW.xy - rect.xy, rect.zw, radius ) );
          a *= mix( 1.0, m, maskW );                                          // seated: the card only, soft-edged
          a *= mix( 1.0, smoothstep( ground - 0.03, ground + 0.05, vW.y ), groundW );   // standing: not below his ground line
          gl_FragColor = vec4( 0.0, 0.0, 0.0, a * opacity );
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.renderOrder = 1; mesh.frustumCulled = false; mesh.visible = false;
    if (floor) mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);
    const N = floor ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const U = new THREE.Vector3(1, 0, 0), V = floor ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const LN = L.dot(N), kU = L.dot(U) / LN, kV = L.dot(V) / LN;
    const rx = v3(), ry = v3(), rz = v3(), o = v3();
    return {
      floor, rt, cam, mat, mesh, far: floor ? 0.6 : 0.9, active: false,
      /* plane centre (world), size along U and V */
      place(cx, cy, cz, w, h) {
        o.set(cx, cy, cz);
        mesh.position.set(cx, cy + (floor ? 0.001 : 0), cz + (floor ? 0 : 0.001));
        mesh.scale.set(w, h, 1);
        // world → clip: slide each point along the light onto the plane (u, v), depth = its height above the plane
        rx.copy(U).addScaledVector(N, -kU).multiplyScalar(2 / w);
        ry.copy(V).addScaledVector(N, -kV).multiplyScalar(2 / h);
        rz.copy(N).multiplyScalar(2 / this.far);
        cam.projectionMatrix.set(
          rx.x, rx.y, rx.z, -o.dot(rx),
          ry.x, ry.y, ry.z, -o.dot(ry),
          rz.x, rz.y, rz.z, -o.dot(rz) - 1,
          0, 0, 0, 1);
        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      },
    };
  }
  const wall = projector('wall'), floor = projector('floor');
  const list = [wall, floor];
  const BLUR = [2.6, 1.2];                                    // texels per tap step, two rounds

  function pass(src, dst, dx, dy) {
    blurMat.uniforms.map.value = src.texture; blurMat.uniforms.dir.value.set(dx / RES, dy / RES);
    renderer.setRenderTarget(dst); renderer.render(quadScene, quadCam);
  }
  let on = true;
  return {
    wall, floor, L,
    /* render the active projectors (call before the main render) */
    update() {
      for (const p of list) p.mesh.visible = false;
      if (!on) return;
      const prevTarget = renderer.getRenderTarget(), prevAlpha = renderer.getClearAlpha();
      const prevColor = renderer.getClearColor(new THREE.Color());
      renderer.setClearColor(0x000000, 0);
      scene.overrideMaterial = depthMat;
      for (const p of list) {
        if (!p.active) continue;
        renderer.setRenderTarget(p.rt); renderer.clear(); renderer.render(scene, p.cam);
      }
      scene.overrideMaterial = null;
      for (const p of list) {
        if (!p.active) continue;
        for (const s of BLUR) { pass(p.rt, tmp, s, 0); pass(tmp, p.rt, 0, s); }
        p.mesh.visible = true;
      }
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevColor, prevAlpha);
    },
    setOpacity(wallO, floorO) { wall.mat.uniforms.opacity.value = wallO; floor.mat.uniforms.opacity.value = floorO; },
    set enabled(v) { on = !!v; },
    get enabled() { return on; },
    dispose() {
      for (const p of list) { p.rt.dispose(); p.mat.dispose(); p.mesh.geometry.dispose(); }
      tmp.dispose(); blurMat.dispose(); quad.geometry.dispose(); depthMat.dispose();
    },
  };
}

/* ---- the homepage figure ----------------------------------------------------------------
   opts: modelUrl, clipsUrl, strip (the element holding the .tile cards), avoid (text he must
   never cover: the info row), below (what his landing must not reach: the folder row),
   getVelocity / isDragging (the strip), onGesture, seat (fraction of the card height),
   test hooks freeze / clip / edge. */
export async function createSitter(host, {
  modelUrl, clipsUrl, strip, avoid, below, getVelocity = () => 0, isDragging = () => false, onGesture,
  seat, freeze = null, clip: forced = null, edge = 0.14,
} = {}) {
  if (!(host instanceof Element) || !strip) throw new TypeError('createSitter: host and strip are required');
  if (!webglAvailable()) throw new Error('WebGL is not available');
  const T = await loadThree();
  const { THREE } = T;

  const canvas = document.createElement('canvas');
  canvas.className = 'sitter-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const st = makeStage(THREE, canvas);
  const { renderer, scene, camera, pivot } = st;
  const fig = await loadFigure(T, modelUrl, pivot);
  const { model, bones, mixer, A, liftAt, feet } = fig;
  // the timing file is only asked for when the GLB has the hop clips (no 404 with an older GLB)
  const timing = A.hopdown && A.hopup ? await loadClipTiming(clipsUrl || modelUrl.replace(/\.glb$/i, '-clips.json')) : null;
  // hop mode only when the GLB has the hop clips AND the timing file says when he leaves / lands
  const HOP = !!(timing && A.hopdown && A.hopup);
  // desktop relocation walks along the floor (v5: `walk` clip + its ground speed)
  const WALK = !!(HOP && A.walk && timing.walk);
  // v6: a real mocap walk (0.637 u/s). At 1.0 it covers ~61 px/s at 1440 (96 px/u), under the strip's ~70 px/s
  // drift, so it plays 1.2x (~73-77 px/s), the cap; ground speed is scaled the same, so no foot slides
  const WALK_RATE = 1.2;
  if (WALK) for (const k of ['walk', 'walkstart', 'walkstop']) if (A[k]) A[k].timeScale = WALK_RATE;
  const look = createLook(THREE, { bones, pivot });
  const shadow = createShadow(THREE, { scene, renderer });
  const gl = renderer.getContext();
  const root = document.documentElement;
  const clamp = THREE.MathUtils.clamp, smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

  const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reducedMQ.matches;
  const phoneMQ = matchMedia('(max-width: 768px)');          // the site's phone layout (css/home.css)
  const theme = () => (root.dataset.theme === 'dark' ? 'dark' : 'light');
  const setTheme = () => { const t = st.applyTheme(theme()); shadow.setOpacity(t.shadowWall, t.shadowFloor); dirty = true; if (typeof readPageL === 'function') setTimeout(readPageL, 60); };

  host.appendChild(canvas);

  // ---- layout ---------------------------------------------------------------------------
  // seat-to-head = 35 % of the card height (100 px at 1440×900), never under 64 px; on phones
  // never over 110 px. He rides one card across the whole strip, so he is shown only where that
  // ride line clears the info row's text everywhere (else: not shown in this layout).
  const SEAT_K = seat || 0.35;
  let phone = false, tight = false, mode = 'desktop', lineClear = true;
  let seatPx = 0, ppu = 0, W = 0, H = 0, seatX = 0, seatY = 0, fits = false, canStand = false, radius = 12, cardPx = 0;
  let drop = 0, overPx = 0, groundY = 0;  // hop mode: model offset (units) to the landing line; landing below the card (px); its world y
  let contact = null, seatShift = 0;      // measured seat contact (canvas px) and the page-side offset that seats him
  const HAND_M = 0.48;                    // u from his seat to a card side edge: the hands sit at ±0.31 u, plus the corner radius
  const SINK = 1.5;                       // px his bottom sinks below his seat line (cloth on a ledge, never a gap)
  function measure() {
    const sr = strip.getBoundingClientRect();
    cardPx = sr.height;
    phone = tight = phoneMQ.matches;
    mode = phone ? 'mobile' : 'desktop';
    seatPx = phone ? clamp(cardPx * SEAT_K, 64, 110) : Math.max(64, cardPx * SEAT_K);
    if (!HOP && A.standup) {                                  // the fallback stands ON the edge: it needs the room above
      const gap = sr.top - (avoid ? avoid.getBoundingClientRect().bottom : -1e9);
      seatPx = Math.max(64, Math.min(seatPx, (gap - 8) / STAND_K));
    }
    frameNo++;
    lineClear = true;
    for (let x = 0.06 * innerWidth; x <= 0.94 * innerWidth; x += 12) if (!textClear({ x, y: sr.top }, seatPx)) { lineClear = false; break; }
    fits = cardPx > 0 && seatPx <= 0.6 * cardPx && lineClear;
    radius = parseFloat(getComputedStyle(root).getPropertyValue('--r-media')) || 12;
    if (!fits) { canStand = false; show(false, true); phase = 'wait'; tile = null; run(); return; }
    ppu = seatPx / FIG.SEAT_TO_HEAD;
    // landing: a little under the card's bottom edge (19 % of his seated height, 19 px at 100),
    // less if the folder row is close; no hop at all if his feet and their shadow would reach it
    const room = (below ? below.getBoundingClientRect().top : innerHeight) - sr.bottom;
    const keep = 0.2 * seatPx + 6;                           // his contact shadow and a margin under the soles
    overPx = clamp(Math.min(0.19 * seatPx, room - keep), 0, 0.19 * seatPx);
    const above = HOP ? 1.25 : 1.9, belowU = HOP ? (cardPx + overPx) / ppu + 0.8 : 0.85;
    W = Math.round(3.0 * ppu); H = Math.round((above + belowU) * ppu);
    seatX = Math.round(W / 2); seatY = Math.round(above * ppu);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    renderer.setSize(W, H, false);
    frameCamera(THREE, camera, W, H, ppu, seatX, seatY);
    // seat contact, measured on his own rendered pixels so it holds for any GLB version: the
    // underside of his bottom and thighs across the seat patch (the shins are folded away at the
    // knees for this one render) sinks SINK px below his seat line
    if (state === 'sit') contact = seatContact();
    seatShift = contact ? seatY + SINK - contact.y : 0;
    if (HOP) {
      // the soles (stand frame 0, with the clip's forward travel) must land on the landing line:
      // solve the world height at the feet's depth (the projection is linear in y here), then
      // check it on the rendered pixels (the shoe tips are nearer the camera than the foot bones)
      const cy = (y) => (-new THREE.Vector3(feet.x, y, feet.z).project(camera).y * 0.5 + 0.5) * H;
      const y0 = feet.y, y1 = feet.y - 3, c0 = cy(y0), c1 = cy(y1), want = seatY + cardPx + overPx - seatShift, k = (y1 - y0) / (c1 - c0);
      let yFeet = y0 + (want - c0) * k;
      drop = yFeet - feet.y;
      const ext = state === 'sit' ? standExtent() : null;
      if (ext) { yFeet += (want - ext.bottom) * k; drop = yFeet - feet.y; }
      groundY = yFeet;
      canStand = room >= keep;
    } else {
      canStand = !!A.standup;
    }
    cardKey = '';
    dirty = true;
    run();
  }

  /* the seated pose (sit frame 0) with the shins folded away, rendered once (not shown): the
     lowest opaque row in the columns around his hips, and under each hand (canvas px) */
  function seatContact() {
    mixer.stopAllAction(); look.restore();
    A.sit.reset().setEffectiveWeight(1).play(); mixer.update(0);
    model.position.y = 0;
    const legs = ['LeftLeg', 'RightLeg'].map((n) => bones[n]).filter(Boolean), saved = legs.map((b) => b.scale.clone());
    legs.forEach((b) => b.scale.setScalar(1e-3));
    model.updateMatrixWorld(true);
    const v = new THREE.Vector3(), sx = (b) => (b.getWorldPosition(v).project(camera).x * 0.5 + 0.5) * W;
    // the figure's own pixels only: the shadow planes must not be in this render (their alpha would
    // read as his seat, a few px low, and lift him off the edge; that was the "too high" seat)
    shadow.wall.mesh.visible = shadow.floor.mesh.visible = false;
    renderer.render(scene, camera);
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight, k = bw / W, buf = new Uint8Array(bw * bh * 4);
    gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const low = (x0, x1) => {
      let best = -1;
      for (let x = Math.max(0, Math.round(x0 * k)); x <= Math.min(bw - 1, Math.round(x1 * k)); x++)
        for (let y = 0; y < bh; y++) if (buf[(y * bw + x) * 4 + 3] > 40) { if (best < 0 || y < best) best = y; break; }
      return best < 0 ? null : (bh - best) / k;
    };
    // the seat's lowest row per column across the seat patch (the clip file's seat.xMin…xMax at its
    // contact depth, projected with his turn; else ±0.2 u around the hips); the contact is the HIGHEST
    // of those over the inner 70 % of the patch, so no column there shows a gap. The hands (v3: on
    // the ledge beside the hips) are measured on their own columns.
    const px = (x, z) => (v.set(x, 0, z).applyMatrix4(pivot.matrixWorld).project(camera).x * 0.5 + 0.5) * W;
    const sp = timing?.seat;
    let x0, x1;
    if (sp) { const a = px(sp.xMin, sp.z), b = px(sp.xMax, sp.z); x0 = Math.min(a, b); x1 = Math.max(a, b); }
    else { const hx = sx(bones.Hips); x0 = hx - 0.2 * ppu; x1 = hx + 0.2 * ppu; }
    const cols = [];
    for (let x = x0; x <= x1; x += 1) { const y = low(x, x); if (y != null && Math.abs(y - seatY) < 0.25 * ppu) cols.push([x, y]); }
    const n = cols.length, inner = cols.slice(Math.floor(n * 0.15), Math.ceil(n * 0.85));
    const out = { y: inner.length ? Math.min(...inner.map((c) => c[1])) : null, cols, profile: cols.map((c) => +(c[1] - seatY).toFixed(1)), hands: ['LeftHand', 'RightHand'].filter((n) => bones[n]).map((n) => {
      const h = timing?.hands?.[n === 'LeftHand' ? 'left' : 'right'], x = h ? px(h.x, h.z) : sx(bones[n]);
      return { name: n, y: low(x - 0.03 * ppu, x + 0.03 * ppu) };
    }) };
    legs.forEach((b, i) => b.scale.copy(saved[i]));
    sitNow(true); draw();
    return out.y == null ? null : out;
  }

  /* the stand pose at the current drop, rendered once (not shown: the sit pose is drawn again
     in the same task): its lowest and highest opaque rows in canvas px */
  function standExtent() {
    mixer.stopAllAction(); look.restore();
    A.stand.reset().setEffectiveWeight(1).play(); mixer.update(0);
    model.position.y = drop; model.updateMatrixWorld(true);
    { const was = shadow.enabled; shadow.enabled = false; draw(); shadow.enabled = was; }
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight, buf = new Uint8Array(bw * bh * 4);
    gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let lo = -1, hi = -1;
    for (let y = 0; y < bh && lo < 0; y++) for (let x = 0; x < bw; x++) if (buf[(y * bw + x) * 4 + 3] > 200) { lo = y; break; }
    for (let y = bh - 1; y >= 0 && hi < 0; y--) for (let x = 0; x < bw; x++) if (buf[(y * bw + x) * 4 + 3] > 200) { hi = y; break; }
    model.position.y = 0;
    sitNow(true); draw();
    return lo < 0 ? null : { bottom: (bh - lo) * H / bh, top: (bh - 1 - hi) * H / bh };
  }

  // ---- where he is: a point on a card's top edge, or a fixed spot on the page ----------
  let tile = null, seatOff = 0, cardKey = '';
  /* the on-screen point of a card's top edge at `off` px (the card's own px) from its centre;
     a card in the fold is drawn as slices on the arc, so the point is read between two slices */
  function anchorOf(el, off = 0) {
    if (!el || !el.isConnected || el.style.visibility === 'hidden') return null;
    const w = el.offsetWidth;
    if (el.classList.contains('is-sliced')) {
      const sl = el.querySelectorAll('.slice'), n = sl.length;
      if (n < 2) return null;
      const pos = clamp((off + w / 2) / (w / n) - 0.5, 0, n - 1.001), i = Math.min(n - 2, Math.floor(pos)), f = pos - i;
      const a = sl[i], b = sl[i + 1];
      if (a.style.visibility === 'hidden' || b.style.visibility === 'hidden') return null;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return { x: ra.left + ra.width / 2 + (rb.left + rb.width / 2 - ra.left - ra.width / 2) * f, y: ra.top + (rb.top - ra.top) * f, h: ra.height + (rb.height - ra.height) * f };
    }
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    return { x: r.left + r.width / 2 + off * (r.width / w), y: r.top, h: r.height };
  }
  /* where he sits on a card: on its visible top edge (see visibleTop), and on a folded card on the
     lowest point of the edge under his seat (he sinks a little on the high side, never shows a gap) */
  const coverOf = (el) => { const m = el.querySelector('img, video'); return m ? (m.tagName === 'VIDEO' ? m.poster : m.currentSrc || m.src || m.dataset.later) : null; };
  const edgeOf = new Map();               // url → analysed top rows (null while loading / unreadable)
  let pageL = 100;
  function readPageL() { const c = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)?.map(Number) || [255, 255, 255]; pageL = Lstar(c[0], c[1], c[2]); }
  function analyseCovers() {
    const urls = [...new Set([...strip.querySelectorAll('.tile')].map(coverOf).filter(Boolean))];
    return Promise.all(urls.map((u) => coverData(u).then((d) => { edgeOf.set(u, d); })));
  }
  function insetPx(el, off) {
    const u = coverOf(el), d = u && edgeOf.get(u);
    if (!d) return 0;
    const w = el.offsetWidth, half = 0.42 * ppu, c = (off + w / 2) / w;
    return visibleTop(d, c - half / w, c + half / w, pageL) * cardPx;
  }
  function seatOn(el, off) {
    const a = anchorOf(el, off);
    if (!a) return a;
    if (el.classList.contains('is-sliced')) {
      const s = 0.2 * ppu;
      for (const d of [-s, s]) { const b = anchorOf(el, off + d); if (b) a.y = Math.max(a.y, b.y); }
    }
    // he sits INTO the card, not on its hairline: ~9 % of his seated height (6–12 px) below the tile
    // edge, so a strip of the card shows behind his hips and under his hands; and never above the
    // visible edge (the pale-band covers). His underside then sinks SINK px further.
    const sink = Math.max(clamp(0.09 * seatPx, 6, 12) - SINK, insetPx(el, off));
    a.y += sink * (a.h / cardPx || 1);                           // (a folded card is drawn taller or shorter)
    return a;
  }
  /* the card's top edge as a screen span (union of its visible slices when folded) */
  function spanOf(el) {
    if (!el || el.style.visibility === 'hidden') return null;
    if (el.classList.contains('is-sliced')) {
      let l = Infinity, r = -Infinity;
      el.querySelectorAll('.slice').forEach((s) => { if (s.style.visibility === 'hidden') return; const q = s.getBoundingClientRect(); l = Math.min(l, q.left); r = Math.max(r, q.right); });
      return r > l ? { l, r } : null;
    }
    const q = el.getBoundingClientRect();
    return q.width ? { l: q.left, r: q.right, t: q.top, b: q.bottom } : null;
  }
  /* share of a card inside the viewport (both axes; the page scrolls on phones) */
  function visibleShare(el) {
    const q = el.getBoundingClientRect();
    if (!q.width || !q.height) return 0;
    const w = Math.max(0, Math.min(q.right, innerWidth) - Math.max(q.left, 0)), h = Math.max(0, Math.min(q.bottom, innerHeight) - Math.max(q.top, 0));
    return (w * h) / (q.width * q.height);
  }
  // the info row's own text boxes (line by line): he may sit where the row is blank
  let textCache = null, textFrame = -1, frameNo = 0;
  function textRects() {
    if (textFrame === frameNo && textCache) return textCache;
    textFrame = frameNo; textCache = [];
    if (!avoid || phone) return textCache;                             // phones: he may pass in front of the info text (it sits behind him)
    const tw = document.createTreeWalker(avoid, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/\S/.test(n.data) ? 1 : 3) });
    const rg = document.createRange();
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { rg.selectNodeContents(n); for (const q of rg.getClientRects()) if (q.width) textCache.push(q); }
    avoid.querySelectorAll('svg').forEach((s) => { const q = s.getBoundingClientRect(); if (q.width) textCache.push(q); });
    return textCache;
  }
  /* may he sit at screen point a (seat point on a card's top edge)? */
  function placeOK(a, s = seatPx) {
    if (!a) return false;
    const vw = innerWidth, half = 0.4 * s;                              // his seated box, hands included (0.42 u)
    if (tight ? a.x - half < 4 || a.x + half > vw - 4                    // tight: just inside the screen (no fold on phones)
      : a.x < vw * edge || a.x > vw * (1 - edge)) return false;         // else: away from the edges and the fold's steep part
    const up = !HOP && state !== 'sit' ? STAND_K : 1;                    // the fallback stands on the edge
    const top = a.y - s * up - 6;
    if (top < 0 && !phone) return false;
    for (const q of textRects()) if (q.right > a.x - half && q.left < a.x + half && q.bottom > top && q.top < a.y) return false;
    return true;
  }
  /* the info row's text is clear of his seated box at a */
  function textClear(a, s) {
    const half = 0.4 * s, top = a.y - s - 6;
    for (const q of textRects()) if (q.right > a.x - half && q.left < a.x + half && q.bottom > top && q.top < a.y) return false;
    return true;
  }
  /* his card: the one nearest the middle (at least 70 % in view), at its centre */
  function pick() {
    let best = null, bs = -Infinity;
    const cx = innerWidth / 2;
    for (const el of strip.querySelectorAll('.tile')) {
      if (el.style.visibility === 'hidden') continue;
      const vis = el.classList.contains('is-sliced') ? 1 : visibleShare(el);
      if (vis < (phone ? 0.5 : 0.7) || el.offsetWidth / 2 < HAND_M * ppu) continue;       // his hands stay on the card, clear of its corners
      const a = seatOn(el, 0);
      if (!placeOK(a)) continue;
      // phones show barely more than one card: take the one coming in, so he rides it across the whole screen
      const s = phone ? (getVelocity() > 20 ? -a.x : a.x) : -Math.abs(a.x - cx);
      if (s > bs) { bs = s; best = { el, off: 0 }; }
    }
    return best;
  }
  /* hop up: the card whose top edge is above x, with room for his hands to its side edges;
     travel (px) allowed only once he has waited */
  function seatAbove(x, travel) {
    const margin = HAND_M * ppu;
    let best = null, bs = Infinity;
    for (const el of strip.querySelectorAll('.tile')) {
      const sp = spanOf(el);
      if (!sp || sp.r - sp.l < 2 * margin) continue;
      const xs = clamp(x, sp.l + margin, sp.r - margin), d = Math.abs(xs - x);
      if (d > travel) continue;
      const off = ((xs - sp.l) / (sp.r - sp.l) - 0.5) * el.offsetWidth;
      const a = seatOn(el, off);
      if (!placeOK(a)) continue;
      const s = d * 4 - Math.min(xs - sp.l, sp.r - xs);
      if (s < bs) { bs = s; best = { el, off }; }
    }
    return best;
  }
  // a fixed spot on the page (relative to the host, so a phone's page scroll carries it)
  let land = null, target = null;
  const hostRect = () => host.getBoundingClientRect();
  const pageAt = (hr, at = land) => ({ x: hr.left + at.x, y: hr.top + at.y });
  const lerpA = (p, q, b) => (q ? { x: p.x + (q.x - p.x) * b, y: p.y + (q.y - p.y) * b, h: q.h } : p);

  // ---- state machine ---------------------------------------------------------------------
  // One authoritative state; every position is derived each frame from the strip's current layout.
  //   sit      on his card (riding it, on- or off-screen)
  //   hopdown  card → the page floor a little under the strip (a click / tap)
  //   stand    on the floor while the carousel slides behind him
  //   walk     (desktop) along the floor toward his target card, in profile, at the clip's ground speed
  //   stop     walkstop (his speed ramps to 0) · turn: back to face the viewer
  //   hopup    floor → onto the target card (locked from the decision until he sits on it)
  //   standup / sitdown   older GLBs without hop clips
  // No timers: every transition is checked in step() against the current state.
  // A trip: he walks toward the middle along the floor (against the drift, so the cards come to him);
  // the first comfortable card that passes over him is locked as his target, and stays locked through
  // the stop, the turn and the hop up until he sits on it. While the strip is busy nothing is locked.
  let state = 'sit', stateT = 0, current = A.sit, upAsked = false, upWait = 0, react = 0, lastTransition = '';
  let plan = null, walkDir = 1, walkT = 0, facing = TURN_DEG;
  const transitions = [];
  function fadeTo(a, t) { if (current !== a) current.crossFadeTo(a, t, false); current = a; }
  function go(next) {
    lastTransition = `${state}→${next} @${(performance.now() / 1000).toFixed(1)}s${target?.el ? ' card ' + target.el.dataset.i : ''}`;
    transitions.push(lastTransition); if (transitions.length > 30) transitions.shift();
    if (DEBUG_LOOK) console.log('[sitter]', lastTransition);
    if (next === 'hopdown') { A.hopdown.reset().setEffectiveWeight(1).play(); fadeTo(A.hopdown, 0.12); land = null; onGesture?.('start'); }
    else if (next === 'hopup') { A.hopup.reset().setEffectiveWeight(1).play(); fadeTo(A.hopup, 0.12); }
    else if (next === 'walk') {
      const s = A.walkstart && current === A.stand ? A.walkstart : A.walk;      // from standing: walkstart first (its speed ramps up)
      s.reset().setEffectiveWeight(1).play(); fadeTo(s, s === A.walk && current !== A.stand ? 0 : 0.2); walkT = 0;
    } else if (next === 'stop') { const s = A.walkstop || A.stand; s.reset().setEffectiveWeight(1).play(); fadeTo(s, A.walkstop ? 0.05 : 0.25); }
    else if (next === 'turn') { A.stand.reset().setEffectiveWeight(1).play(); fadeTo(A.stand, 0.2); }
    else if (next === 'standup') {
      A.standup.reset(); A.standup.timeScale = SPEED; A.standup.setEffectiveWeight(1).play();
      fadeTo(A.standup, 0.3); onGesture?.('start');
    } else if (next === 'stand') { A.stand.reset().setEffectiveWeight(1).play(); fadeTo(A.stand, HOP ? 0.12 : 0.25); upAsked = false; upWait = 0; }
    else if (next === 'sitdown') {
      A.standup.reset(); A.standup.timeScale = -SPEED; A.standup.time = A.standup.getClip().duration;
      A.standup.setEffectiveWeight(1).play(); current.crossFadeTo(A.standup, 0.25, false); current = A.standup;
    } else if (next === 'sit') {
      if (current !== A.sit) { A.sit.reset().setEffectiveWeight(1).play(); fadeTo(A.sit, HOP ? 0.12 : 0.15); }
      if (target) { tile = target.el; seatOff = target.off; target = null; }   // he now rides the card he landed on
      sitSince = performance.now();
      land = null; plan = null; onGesture?.('end');
    }
    state = next; stateT = 0;
  }
  const done = (a) => a.time >= a.getClip().duration - 1e-3;
  /* the trip's card: the valid card nearest the middle (relocation), or nearest to x (after a click) */
  /* on-screen ground speed (px/s) at the depth of his feet */
  // (the clip plays WALK_RATE× and the ground speed is scaled by exactly the same, so no foot slides)
  const groundPx = () => { const d = camera.position.z; return WALK_RATE * timing.walk.speed * ppu * d / Math.max(1, d - _h.z); };
  let prevWalkT = 0;
  const wrapped = () => current === A.walk && A.walk.time < prevWalkT;   // the walk loop just came round to t = 0 (between steps)
  function step(dt, calm, hr, now) {
    stateT += dt;
    if (state === 'hopdown' && done(A.hopdown)) go('stand');
    else if (state === 'stand' && HOP && plan === 'reloc' && stateT >= 0.2 && calm) {
      target = null; go('walk');
    } else if (state === 'stand' && HOP && (stateT >= STAND_HOLD || upAsked) && calm) {
      // back up onto the card above him; none above: the nearest within 60 px once he has waited 1.5 s,
      // or (desktop) he walks to the nearest one
      upWait += dt;
      const t = target || seatAbove(pageAt(hr).x, upWait < 1.5 ? 0 : 60);
      if (t) { target = t; go('hopup'); }
      else if (upWait >= 1.5 && WALK && mode === 'desktop') { target = null; go('walk'); }
    } else if (state === 'walk') {
      // he walks toward the middle (against the drift, so the cards come to him); the first comfortable
      // card that passes over him (after 0.8 s) is locked as his target; he stops between steps
      walkT += dt;
      if (A.walkstart && current === A.walkstart && done(A.walkstart)) { A.walk.reset().setEffectiveWeight(1).play(); fadeTo(A.walk, 0); }
      const x = pageAt(hr).x, vg = groundPx();
      const ramp = current === A.walkstart ? clamp(A.walkstart.time / A.walkstart.getClip().duration, 0, 1) : 1;
      // relocation: toward the side the cards come in from, to a card he will then ride right across the
      // screen (landing in the flat part on that side: 55–68 % of the width, mirrored for the other drift);
      // after a click: toward the middle, landing anywhere in the flat middle
      const v = getVelocity(), inDir = v < -20 ? -1 : 1;                 // cards moving left (v > 0) come in from the right
      const goal = plan === 'click' ? innerWidth / 2 : inDir > 0 ? 0.62 * innerWidth : 0.38 * innerWidth;
      const want = Math.abs(goal - x) > 40 ? Math.sign(goal - x) : walkDir;
      if (want !== walkDir && (wrapped() || current === A.walkstart)) walkDir = want;   // turning round only between steps
      if (!target && calm && walkT > 0.8) {
        // the card that will be over him when he has stopped and turned (~0.8 s of drift ahead), and in the
        // flat part once he sits on it (stop + turn + hop ≈ 2.7 s): no fold under the hop
        const t = seatAbove(x + v * 0.8 + walkDir * 0.25 * vg, 20), pt = t && seatOn(t.el, t.off), xl = pt && pt.x - v * 2.7;
        const lo = plan === 'click' ? 0.32 : inDir > 0 ? 0.55 : 0.32, hi = plan === 'click' ? 0.68 : inDir > 0 ? 0.68 : 0.45;
        if (pt && xl > lo * innerWidth && xl < hi * innerWidth) target = t;
      }
      if (target && current === A.walk && wrapped()) go('stop');
      if (state === 'walk') land.x += walkDir * vg * ramp * dt;            // the clip's own ground speed: the planted foot does not slide
    } else if (state === 'stop') {
      const vg = groundPx(), k = A.walkstop ? clamp(A.walkstop.time / A.walkstop.getClip().duration, 0, 1) : 1;
      land.x += walkDir * vg * (1 - k) * dt;                               // the stop's speed ramps from walk speed to 0
      if (!A.walkstop || done(A.walkstop)) go('turn');
    } else if (state === 'turn' && stateT >= 0.3 && calm) {
      // hop up onto the locked card: from here it is not re-picked (the hop blends to its moving seat)
      const to = target && seatOn(target.el, target.off);
      if (!(to && placeOK(to) && Math.abs(to.x - pageAt(hr).x) <= 120)) target = null;
      if (target) go('hopup'); else go('walk');
    } else if (state === 'hopup' && done(A.hopup)) go('sit');
    else if (state === 'standup' && done(A.standup)) go('stand');
    else if (state === 'stand' && !HOP && stateT >= 2.0) go('sitdown');
    else if (state === 'sitdown' && A.standup.time <= 1e-3) go('sit');
  }
  function sitNow(keepTime) {               // straight to the seated loop (placement, reduced motion, measuring)
    const was = state, t = A.sit.time;
    mixer.stopAllAction();
    look.restore();
    A.sit.reset().setEffectiveWeight(1).play(); A.sit.timeScale = 1;
    if (keepTime) A.sit.time = t;                                        // a re-measure must not restart his idle
    current = A.sit; state = 'sit'; stateT = 0; land = null; target = null; plan = null; facing = TURN_DEG;
    turnAbout(TURN_DEG);
    mixer.update(0); look.capture();
    if (was !== 'sit') onGesture?.('end');
    dirty = true;
  }
  /* progress through the airborne part of the current hop (0 before takeoff, 1 after landing) */
  function air() {
    const hop = state === 'hopdown' ? timing?.hopdown : state === 'hopup' ? timing?.hopup : null;
    if (!hop) return state === 'stand' || state === 'walk' || state === 'stop' || state === 'turn' ? 1 : 0;
    return clamp((A[state].time - hop.takeoff) / (hop.land - hop.takeoff), 0, 1);
  }
  /* the model's vertical offset: hop mode = the extra drop to the landing line, ballistic between
     takeoff and land (gravity ease-in down, mirrored ease-out up); fallback = the lift */
  function offsetY() {
    if (HOP) {
      if (state === 'stand' || state === 'walk' || state === 'stop' || state === 'turn') return drop;
      const u = air();
      return state === 'hopdown' ? drop * u * u : state === 'hopup' ? drop * (1 - u) * (1 - u) : 0;
    }
    const lift = state === 'stand' ? 1 : current === A.standup ? liftAt(A.standup.time) : 0;
    return -FIG.STAND_GROUND * lift;
  }
  /* look weight: on while seated and standing; off in the air of a hop (±0.1 s) */
  function lookWant() {
    if (state === 'sit' || state === 'stand' || state === 'walk' || state === 'stop' || state === 'turn') return 1;
    if (!HOP) return 0;
    const hop = timing[state], t = A[state].time;
    return t < hop.takeoff - 0.1 || t > hop.land + 0.1 ? 1 : 0;
  }
  /* where the seat point is drawn this frame. Seated: on his card. Off the card he belongs to
     the page: at takeoff the spot under him is fixed, through the air his anchor blends from the
     moving card to it (and back, onto the card above him, for the hop up), so the carousel keeps
     moving behind him with no snap. */
  function anchorNow(hr) {
    const card = tile ? seatOn(tile, seatOff) : null;
    if (!HOP || state === 'sit' || state === 'standup' || state === 'sitdown') return card;
    if (state === 'hopdown') {
      const u = air();
      if (u <= 0 || !land) { if (card) land = { x: card.x - hr.left, y: strip.getBoundingClientRect().top - hr.top }; return card; }
      return lerpA(card || pageAt(hr), pageAt(hr), smooth(u));
    }
    if (!land) { const c = card || { x: innerWidth / 2, y: strip.getBoundingClientRect().top }; land = { x: c.x - hr.left, y: strip.getBoundingClientRect().top - hr.top }; }
    if (state === 'stand' || state === 'walk' || state === 'stop' || state === 'turn') return pageAt(hr);
    const to = target ? seatOn(target.el, target.off) : null;
    if (to) lastTo = to;
    return lerpA(pageAt(hr), to || lastTo, smooth(air()));             // hopup: to the locked card's moving seat
  }

  let vx = 0, prevAx = null, lastTo = null, sitSince = -1e9;
  const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _yAx = new THREE.Vector3(0, 1, 0);
  /* turn the figure to `deg` about his hips (on the floor the stand/walk hips sit 0.42 u in front of
     the seat point; turning about the seat point would swing him sideways) */
  function turnAbout(deg) {
    const hp = timing?.walk?.hips || [0.1067, 0.42];
    pivot.rotation.set(0, deg * Math.PI / 180, 0);              // (at the presentation turn the offset below is 0)
    _p0.set(hp[0], 0, hp[1]).applyAxisAngle(_yAx, TURN_DEG * Math.PI / 180);
    _p1.set(hp[0], 0, hp[1]).applyAxisAngle(_yAx, deg * Math.PI / 180);
    pivot.position.set(_p0.x - _p1.x, 0, _p0.z - _p1.z);
  }

  // ---- render, shadows, pixel hit test ------------------------------------------------
  let dirty = true, lastA = null;
  const _h = new THREE.Vector3();
  function shadows() {
    const sw = shadow.wall, sf = shadow.floor;
    bones.Hips.getWorldPosition(_h);
    const u = state === 'hopdown' ? air() : state === 'hopup' ? 1 - air() : state === 'sit' ? 0 : 1;   // how far off the card, onto the page
    // the wall: centred under his hips, kept inside the canvas
    const top = seatY / ppu - 0.05, bot = -(H - seatY) / ppu + 0.05, half = W / ppu / 2 - 0.05;
    const wh = Math.min(2.7, top - bot), ww = Math.min(2.5, 2 * half);
    const cy = clamp(_h.y - 0.55, bot + wh / 2, top - wh / 2), cx = clamp(_h.x, -half + ww / 2, half - ww / 2);
    sw.place(cx, cy, FACE_Z, ww, wh);
    sw.active = true;
    const m = sw.mat.uniforms;
    // the card the shadow lies on, as a soft rounded rect from the card's real on-screen box, relative to his seat
    const mc = state === 'hopup' && air() > 0.5 ? target?.el : tile;
    const ch = cardPx / ppu;
    if (mc && lastA) {
      const sp = spanOf(mc), topY = anchorOf(mc, 0)?.y;
      if (sp && topY != null) m.rect.value.set(((sp.l + sp.r) / 2 - lastA.x) / ppu, (lastA.y - topY + seatShift) / ppu - ch / 2, (sp.r - sp.l) / 2 / ppu, ch / 2);
    }
    m.radius.value = radius / ppu; m.feather.value = 3 / ppu;
    m.maskW.value = HOP ? 1 - u : 1;
    m.ground.value = groundY; m.groundW.value = HOP ? u : 0;
    // the floor: under his feet on the landing line, while he is on the page
    sf.active = HOP && state !== 'sit';
    if (sf.active) {
      const z0 = FACE_Z, z1 = feet.z + 0.7;
      sf.place(clamp(_h.x, -half + 1.1, half - 1.1), groundY, (z0 + z1) / 2, Math.min(2.2, 2 * half), z1 - z0);   // under him as he walks
    }
    shadow.update();
  }
  function draw() { shadows(); renderer.render(scene, camera); dirty = false; }
  const px = new Uint8Array(4 * 41 * 41);
  /* is (x, y) on his rendered pixels? (alpha > 200: the figure is opaque, the shadow is not) */
  function onFigure(x, y, r, fresh) {
    if (!shown || !onPage || !tile) return false;
    const rc = canvas.getBoundingClientRect();
    if (x < rc.left - r || x > rc.right + r || y < rc.top - r || y > rc.bottom + r) return false;
    if (fresh) draw();
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    const sx = Math.round((x - rc.left) * bw / rc.width), sy = Math.round(bh - (y - rc.top) * bh / rc.height);
    r = Math.min(20, Math.round(r * bw / rc.width));
    const x0 = Math.max(0, sx - r), y0 = Math.max(0, sy - r), w = Math.min(bw, sx + r + 1) - x0, h = Math.min(bh, sy + r + 1) - y0;
    if (w <= 0 || h <= 0) return false;
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let i = 3; i < w * h * 4; i += 4) if (px[i] > 200) return true;
    return false;
  }
  const interactive = () => !reduced && !test && shown && onPage && phase === 'ride' && (state === 'sit' || (HOP && state === 'stand' && plan !== 'reloc'));

  // ---- pointer: look, hover, click / tap -------------------------------------------------
  let mouse = null, down = null, hovering = false;
  const setHover = (h) => {
    if (h === hovering) return;
    hovering = h;
    root.classList.toggle('sitter-hover', h);
    document.body.style.cursor = h ? 'pointer' : '';      // the strip's label reads this and steps aside
  };
  // the cursor drives the look; touch has no cursor: no look-at from touches
  const onMove = (e) => {
    if (e.pointerType !== 'mouse') { mouse = null; return; }
    look.pointer(e.clientX, e.clientY); mouse = { x: e.clientX, y: e.clientY };
  };
  const onLeave = () => { look.pointer(null); mouse = null; setHover(false); };
  const onOut = (e) => { if (!e.relatedTarget) onLeave(); };                  // the pointer left the window
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY }; };
  const onClick = (e) => {
    if (!interactive() || e.button > 0) return;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;   // that was a drag
    const top = document.elementFromPoint(e.clientX, e.clientY);
    if (!top || top.closest('.win-layer, .lb, a, .bio, .dock')) return;          // a window or a control is on top
    if (!onFigure(e.clientX, e.clientY, e.pointerType === 'mouse' ? 2 : 10, true)) return;
    if (state === 'sit' && !canStand) return;                                      // no room under the strip: the tap goes to the card
    e.preventDefault(); e.stopPropagation();                                       // the card under him does not open
    setHover(false);
    if (state === 'stand') { upAsked = true; return; }                             // a second click: back up now
    plan = 'click'; target = null; go(HOP ? 'hopdown' : 'standup');
  };
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('pointerdown', onDown, { capture: true, passive: true });
  addEventListener('click', onClick, true);
  document.addEventListener('pointerout', onOut);
  addEventListener('blur', onLeave);
  let lastScroll = -1e9;
  const onScroll = () => { lastScroll = performance.now(); };
  addEventListener('scroll', onScroll, { passive: true, capture: true });

  // ---- loop ----------------------------------------------------------------------------
  // phase: 'wait' (not placed: hidden, polled on a timer, no frames) · 'ride' (on his card)
  let phase = 'wait', shown = false, shownAt = 0, hidePending = false, raf = 0, poll = 0, prevT = 0, busyAt = -1e9, appearAt = 0, awaySince = 0;
  let onPage = true;                        // false while his card is culled or he is wholly off-screen: the canvas is hidden at once (no frozen frame)
  let paused = false, visible = document.visibilityState !== 'hidden', inView = true;
  const test = forced != null || freeze != null;                // screenshot paths (sitter-test.html)
  /* show / hide = the CSS opacity fade (~220 ms): only when he is placed (first appearance, or
     re-seated while out of view) and when a layout leaves no room. Never flaps: a layout hide
     within 0.8 s of showing waits until then and is dropped if there is room again. */
  const show = (v, layout) => {
    if (v) { hidePending = false; if (!shown) { shown = true; shownAt = performance.now(); canvas.classList.add('is-on'); } return; }
    if (!shown) return;
    if (layout && performance.now() - shownAt < 800) { hidePending = true; return; }
    shown = false; hidePending = false; canvas.classList.remove('is-on'); setHover(false);
  };
  const setOnPage = (v) => { if (v === onPage) return; onPage = v; canvas.style.visibility = v ? '' : 'hidden'; if (!v) setHover(false); };
  /* calm: the strip (and on phones the page) has been still for a moment */
  function calmFor(now) {
    const v = Math.abs(getVelocity());
    if (v >= 260 || isDragging() || now - lastScroll < 250) busyAt = now;
    return now - busyAt;
  }
  function appear(p, now) {
    tile = p.el; seatOff = p.off; phase = 'ride'; appearAt = now; awaySince = 0;
    sitNow();
  }
  function pollTick() {
    poll = 0;
    const now = performance.now();
    if (phase === 'wait' && calmFor(now) > 300 && (edgesReady || now - bornAt > 1500)) {
      frameNo++;
      const p = pick();
      if (p) appear(p, now);
    }
    run();
  }
  let edgesReady = false;
  const bornAt = performance.now();
  readPageL();
  analyseCovers().then(() => { edgesReady = true; });

  function frame(t) {
    raf = 0;
    if (!fits || phase === 'wait') { show(false, true); run(); return; }
    raf = requestAnimationFrame(frame);
    frameNo++;
    const tStart = DEBUG_LOOK ? performance.now() : 0;
    const dt = Math.min(0.05, (t - (prevT || t)) / 1000);
    prevT = t;
    const now = performance.now(), calm = calmFor(now) > 250;
    const hr = hostRect();
    if (hidePending && now - shownAt >= 800) { show(false, true); if (!shown) { phase = 'wait'; run(); return; } }
    // his card was rebuilt (a resize re-lays the strip): place him again
    if (tile && !tile.isConnected) { tile = null; phase = 'wait'; show(false); setOnPage(true); sitNow(); run(); return; }

    // desktop with room under the strip: relocation is a walk along the floor. Only once the strip has
    // been calm for 0.4 s: his card is about to leave the comfortable zone (predicted from its speed)
    // → hop down; he is already out of view with it → walk in from the nearest edge on the floor line.
    const relocOK = mode === 'desktop' && WALK && canStand && !test && !reduced;
    if (relocOK && state === 'sit') {
      const p = tile ? seatOn(tile, seatOff) : null;
      if (p && prevAx != null && dt > 0) vx = vx * 0.8 + ((p.x - prevAx) / dt) * 0.2;
      prevAx = p ? p.x : null;
      const body = 0.55 * ppu, away = !p || p.x + body < 0 || p.x - body > innerWidth;
      if (calmFor(now) > 400 && now - sitSince > 8000) {
        if (away) {
          const v = getVelocity(), fromLeft = v < -20;            // he comes in from the side the cards come in from
          {
            land = { x: (fromLeft ? -1.6 * body : innerWidth + 1.6 * body) - hr.left, y: strip.getBoundingClientRect().top - hr.top };
            target = null; plan = 'enter'; walkDir = fromLeft ? 1 : -1; facing = 90 * walkDir;
            A.stand.reset().play(); current.crossFadeTo(A.stand, 0, false); current = A.stand;
            go('walk');
          }
        } else {
          // only when his card is really about to leave, on the side it exits (seat within 10 % of that edge)
          const xp = p.x + vx * 0.6, exit = getVelocity() < -20 ? xp > 0.9 * innerWidth : xp < 0.1 * innerWidth;
          if (exit) { plan = 'reloc'; target = null; go('hopdown'); }
        }
      }
    }

    const a = anchorNow(hr);
    lastA = a;
    // no anchor (his card culled / folded edge-on) or wholly off-screen: hide the canvas at once
    // (he is out of view anyway), so no frozen last frame is ever left behind
    const offScreen = !a || a.x + W / 2 < 0 || a.x - W / 2 > innerWidth || a.y + H < 0 || a.y - H > innerHeight;
    setOnPage(!offScreen);
    // re-seat, the only relocation: his card has been out of view (seated) and the strip calm for 1.2 s,
    // and the card is not coming back by itself (the strip carries cards in from the side it moves away from)
    // (phones: never; he stays on his one project and is simply out of view when it is)
    if (state === 'sit' && offScreen && !test && !reduced && !relocOK && !phone) {
      const v = getVelocity(), x = a ? a.x : (tile?.getBoundingClientRect().left ?? 0);
      const coming = (x > innerWidth && v > 20) || (x < 0 && v < -20);
      awaySince = awaySince || now;
      if (!coming && calmFor(now) > 1200 && now - awaySince > 1200) {
        const p = pick();
        if (p) { show(false); appear(p, now); return; }                   // out of view: no one sees the move; he fades in on the new card
      }
    } else awaySince = 0;
    if (!a) { step(dt, calm, hr, now); mixer.update(dt); if (DEBUG_LOOK) debugState(now); return; }

    // glue the canvas to the anchor (transform only); a small settle as he appears
    // (not rounded: the tiles are not either, so he and his card move by the same sub-pixel steps)
    const settle = !reduced && now - appearAt < 400 ? -7 * (1 - smooth((now - appearAt) / 380)) : 0;
    canvas.style.transform = `translate3d(${(a.x - seatX - hr.left).toFixed(2)}px,${(a.y - seatY - hr.top + seatShift + settle).toFixed(2)}px,0)`;
    if (DEBUG_LOOK) { const k = a.x - hr.left, ky = a.y - hr.top; if (dbg.prevX != null) { const d = Math.hypot(k - dbg.prevX, ky - dbg.prevY); if (state !== 'sit' || dbg.prevState !== 'sit') { dbg.hopJump = Math.max(dbg.hopJump, d); if (state !== dbg.prevState) dbg.edgeJump = Math.max(dbg.edgeJump || 0, d); } dbg.maxJump = Math.max(dbg.maxJump, d); } dbg.prevX = k; dbg.prevY = ky; dbg.prevState = state; }
    if (phase === 'ride' && !shown && !offScreen) { show(true); dirty = true; }

    if (reduced || (freeze != null && !dirty)) { if (dirty) draw(); return; }
    if (freeze != null) { pose(); draw(); return; }

    // animate: the look-at base is restored before the mixer and captured right after it
    step(dt, calm, hr, now);
    if (react > 0) { react -= dt; A.sit.timeScale = react > 0 ? 2.2 : 1; }
    // facing: exactly in profile along the floor while walking (so the stride runs along the screen and
    // the planted foot holds still), eased ~0.3 s; back to the viewer otherwise; turned about his hips
    const want = state === 'walk' || state === 'stop' ? 90 * walkDir : TURN_DEG;
    facing += (want - facing) * (1 - Math.exp(-dt * 10));
    turnAbout(facing);
    look.restore();
    prevWalkT = A.walk ? A.walk.time : 0;
    mixer.update(dt);
    model.position.y = offsetY();
    model.updateMatrixWorld(true);
    look.capture();
    if (DEBUG_LOOK) debugState(now);
    if (offScreen) return;                                                // nothing to draw out of view
    const rc = { left: a.x - seatX, top: a.y - seatY + seatShift, width: W, height: H };
    look.update(dt, look.headScreen(camera, rc), lookWant());
    look.apply();
    draw();
    if (DEBUG_LOOK) { dbg.ms += performance.now() - tStart; dbg.msN++; debugLook(); debugLines(a, hr); }
    // hover: only the figure's own pixels, only while the cursor is over the canvas box
    setHover(!!mouse && interactive() && !isDragging() && onFigure(mouse.x, mouse.y, 1, false));
  }

  /* ?freeze / ?clip (test page): hold a clip at a time, with the same offsets and shadows */
  function pose() {
    const a = A[forced] || A.sit;
    mixer.stopAllAction();
    a.reset().setEffectiveWeight(1).play();
    a.time = Math.min(freeze || 0, a.getClip().duration);
    a.paused = true; current = a; state = forced && A[forced] ? forced : 'sit';
    mixer.update(0);
    model.position.y = offsetY();
    model.updateMatrixWorld(true);
  }

  // ?sitterdebug: maxima actually applied (per bone), bone scale, head–neck distance, anchor steps
  const DEBUG_LOOK = /[?&]sitterdebug\b/.test(location.search);
  const dbg = { ms: 0, msN: 0, edgeJump: 0, prevY: null, scaleDev: 0, headNeck: null, headNeckDev: 0, frames: 0, dev: {}, last: null, prevX: null, prevState: 'sit', maxJump: 0, hopJump: 0 };
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();
  // ?sitterdebug: two 1 px lines under him, red at his computed seat underside, blue at the card's real top edge
  let dbgLines = null;
  function debugLines(a, hr) {
    if (!dbgLines) {
      dbgLines = ['#e00', '#06f'].map((c) => { const d = document.createElement('div'); Object.assign(d.style, { position: 'fixed', left: '0', top: '0', width: '140px', height: '1px', background: c, zIndex: 9, pointerEvents: 'none', opacity: '.8' }); document.body.appendChild(d); return d; });
    }
    const seatPage = a.y - seatY + seatShift + (contact ? contact.y : seatY);       // where his seat underside is drawn
    const edge = state === 'sit' && tile ? seatOn(tile, seatOff)?.y : null;   // where his seat line is on the card
    dbgLines[0].style.transform = `translate(${a.x - 70}px, ${seatPage - 0.5}px)`;
    dbgLines[1].style.transform = edge == null ? 'translate(-999px,0)' : `translate(${a.x - 70}px, ${edge - 0.5}px)`;
  }
  let dbgText = null;
  function debugState(now) {
    if (!dbgText) { dbgText = document.createElement('div'); Object.assign(dbgText.style, { position: 'fixed', left: '8px', top: '8px', zIndex: 99, font: '11px/1.35 ui-monospace, Menlo, monospace', color: '#fff', background: 'rgba(0,0,0,.72)', padding: '4px 6px', borderRadius: '4px', pointerEvents: 'none', whiteSpace: 'pre' }); document.body.appendChild(dbgText); }
    if (now - (dbgText._t || 0) < 100) return; dbgText._t = now;
    dbgText.textContent = `sitter ${state}${plan ? ' (' + plan + ')' : ''} · ${mode}${onPage ? '' : ' · off-screen'}${calmFor(now) > 250 ? '' : ' · strip busy'}\ncard ${tile ? tile.dataset.i : '-'}  target ${target?.el ? target.el.dataset.i : '-'}  strip ${getVelocity().toFixed(0)} px/s\nlast ${lastTransition}`;
  }
  function debugLook() {
    dbg.frames++;
    for (const n of ['Spine', 'neck', 'Head']) { const sc = bones[n].scale; dbg.scaleDev = Math.max(dbg.scaleDev, Math.abs(sc.x - 1), Math.abs(sc.y - 1), Math.abs(sc.z - 1)); }
    const d = bones.Head.getWorldPosition(_a).distanceTo(bones.neck.getWorldPosition(_b));
    if (dbg.headNeck == null) dbg.headNeck = d; else dbg.headNeckDev = Math.max(dbg.headNeckDev, Math.abs(d - dbg.headNeck) / dbg.headNeck);
    const dev = look.deviation();
    for (const n in dev) dbg.dev[n] = Math.max(dbg.dev[n] || 0, dev[n]);
    dbg.last = dev;
  }

  /* frames only while he is shown (or fading); hidden, a 200 ms timer looks for a place */
  function run() {
    const on = visible && inView && !paused && fits;
    if (!on) { if (raf) cancelAnimationFrame(raf); raf = 0; clearTimeout(poll); poll = 0; return; }
    if (phase === 'wait') { if (raf) cancelAnimationFrame(raf); raf = 0; if (!poll) poll = setTimeout(pollTick, 200); }
    else { clearTimeout(poll); poll = 0; if (!raf) { prevT = 0; raf = requestAnimationFrame(frame); } }
  }
  const onVis = () => { visible = document.visibilityState !== 'hidden'; run(); };
  document.addEventListener('visibilitychange', onVis);
  const io = new IntersectionObserver((es) => { inView = es[es.length - 1].isIntersecting; run(); });
  io.observe(strip);
  let rT = 0;
  const ro = new ResizeObserver(() => { clearTimeout(rT); rT = setTimeout(measure, 140); });
  ro.observe(strip); if (avoid) ro.observe(avoid);
  const mo = new MutationObserver(setTheme);
  mo.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  const onReduced = () => { reduced = reducedMQ.matches; sitNow(); measure(); dirty = true; };
  reducedMQ.addEventListener?.('change', onReduced);
  const onLost = (e) => { e.preventDefault(); show(false); paused = true; run(); };
  canvas.addEventListener('webglcontextlost', onLost);

  setTheme();
  measure();
  sitNow();
  if (test) {
    if (freeze != null) pose();
    else if (A[forced]) { mixer.stopAllAction(); current = A[forced]; state = forced === 'standup' ? 'standup' : forced; current.reset().setEffectiveWeight(1).play(); current.setLoop(THREE.LoopRepeat, Infinity); }
  }
  run();

  return {
    setPaused(v) { paused = !!v; if (paused) setHover(false); run(); },
    destroy() {
      cancelAnimationFrame(raf); raf = 0; clearTimeout(poll);
      io.disconnect(); ro.disconnect(); mo.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      reducedMQ.removeEventListener?.('change', onReduced);
      removeEventListener('pointermove', onMove); removeEventListener('pointerdown', onDown, true);
      removeEventListener('click', onClick, true); document.removeEventListener('pointerout', onOut); removeEventListener('blur', onLeave);
      removeEventListener('scroll', onScroll, true);
      setHover(false); mixer.stopAllAction(); shadow.dispose(); renderer.dispose(); canvas.remove();
    },
    // test hooks (not part of the contract)
    get _state() {
      return { profile: contact?.profile, mode: HOP ? 'hop' : 'fallback-standup', layout: mode, lineClear, phase, state, t: +current.time.toFixed(2), shown, fits, canStand, seatPx: +seatPx.toFixed(1),
        overPx: +overPx.toFixed(1), seatShift: +seatShift.toFixed(2), // px below the card's top edge after placement (> 0 = sunk into it, < 0 = a gap): the seat patch's highest point, each hand's lowest
        contact: contact && { measured: +(contact.y - seatY).toFixed(2), seat: +(contact.y - seatY + seatShift).toFixed(2), hands: contact.hands.map((h) => ({ name: h.name, below: h.y == null ? null : +(h.y - seatY + seatShift).toFixed(2) })) }, drop: +drop.toFixed(3), offsetY: +model.position.y.toFixed(3), tile: tile && +tile.dataset.i, seatOff: +seatOff.toFixed(1),
        loop: raf ? 'raf' : poll ? 'timer' : 'off', look: look.state, debug: dbg };
    },
    _look: look,
    _setShadow(v) { shadow.enabled = v; dirty = true; },
    _hit: (x, y) => onFigure(x, y, 1, true),
    _anchor: () => anchorNow(hostRect()),
    get _transitions() { return transitions.slice(); },
    /* per card in the strip: which edge he sits on (px below the tile edge, at the card's centre) */
    _edges() { return [...strip.querySelectorAll('.tile')].filter((el) => el.style.visibility !== 'hidden').map((el) => ({ i: +el.dataset.i, cover: (coverOf(el) || '').split('/').pop(), analysed: !!edgeOf.get(coverOf(el)), insetPx: +insetPx(el, 0).toFixed(2) })); },
    _card: () => seatOn(tile, seatOff),
    _canvas: canvas,
    /* lowest and highest opaque pixel rows of the figure (page px), from the rendered frame */
    _extent() {
      { const was = shadow.enabled; shadow.enabled = false; draw(); shadow.enabled = was; }
      const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight, buf = new Uint8Array(bw * bh * 4);
      gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let lo = -1, hi = -1;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (buf[(y * bw + x) * 4 + 3] > 200) { if (lo < 0) lo = y; hi = y; break; }
      const r = canvas.getBoundingClientRect(), k = r.height / bh;
      draw();
      return lo < 0 ? null : { bottom: r.top + (bh - lo) * k, top: r.top + (bh - 1 - hi) * k };
    },
  };
}
