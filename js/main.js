import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clamp01, smooth, seg, bump, lerp, V } from './util.js';
import { buildSet, buildEnvironment, rampPath, S_LIP, RAMP } from './set.js';
import { Smoke } from './fx.js';
import { buildCar, mountWheels, CAR_H } from './car.js';

/* ================================================================== *
 *  Config
 * ================================================================== */
// the high-detail car (see tools/subdivide.mjs); ?model=src loads the original for comparison
const MODEL_URL = new URLSearchParams(location.search).get('model') === 'src' ? 'models/roadster.glb?v=1' : 'models/roadster-hd.glb?v=1';   // bump v when a file changes
const WHEEL_URL = 'models/wheel.glb?v=1';
const BYTES = { car: 2197632, wheel: 662640 };
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');              // ?debug snaps instantly; ?debug&u=3.4 jumps to a point in the story
const USE_BLOOM = params.get('fx') !== '0';     // ?fx=0 renders without the bloom pass (for comparing cost)
// ?demo plays the story by itself for screen recording; ?render turns that into an MP4 file (see "Demo mode" below)
const RENDER = params.has('render');
const DEMO = params.has('demo') || RENDER;
const reduceMotion = !DEMO && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const instant = DEBUG || reduceMotion;
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const S_START = -2.5;     // the car waits just short of where the ramp starts to curve
const LAND_Z = -24;       // where it comes down
const STOP_Z = 30;        // where the sprint ends
const HOVER_Y = 7;        // height at which the four floor jets catch the fall
const HERO_OUT = 1.15;   // how far the loose wheel comes off its hub towards the lens
const LOGO_UP = 0;        // wheel angle at which the badge on its centre cap stands upright

/* ================================================================== *
 *  The page drives the story. Position in the story is "u":
 *  the section's index plus how far through that section you have scrolled.
 * ================================================================== */
const sections = [...document.querySelectorAll('[data-key]')];
const IDX = Object.fromEntries(sections.map((s, i) => [s.dataset.key, i]));
const { hero: H, climb: C, launch: L, burn: B, sprint: S, aero: A, teardown: TD, wheel: W, cockpit: K, trims: R } = IDX;
let tops = [], heights = [];
function measure() {
  tops = sections.map((s) => s.offsetTop);
  heights = sections.map((s) => s.offsetHeight);
}
function scrollU() {
  const y = window.scrollY;
  let i = 0;
  while (i < sections.length - 1 && y >= tops[i + 1]) i++;
  return i + clamp01((y - tops[i]) / heights[i]);
}
// When each beat happens, in u
const T = {
  climb: [C - 0.1, L],                 // pulls away just before the first section ends
  flight: [L, B - 0.1],
  roll: [L + 0.1, L + 0.72],
  hover: [B - 0.1, B + 0.66],
  squash: [B + 0.66, B + 0.86],
  sprint: [S + 0.14, S + 0.74],
  brake: [S + 0.7, S + 0.93],
  tear: [TD + 0.04, TD + 0.56],
  wheelOut: [W + 0.03, W + 0.26],
  wheelRoll: [W + 0.56, W + 0.9],
  cab: [K, K + 0.3],
  snap: [R, R + 0.1],
  flash: [R + 0.03, R + 0.2],
};
const damp = (rate, dt) => (instant ? 1 : 1 - Math.exp(-rate * dt));

/* ================================================================== *
 *  Renderer, scene, post
 * ================================================================== */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !USE_BLOOM, powerPreference: 'high-performance' });
// render at most ~1.8 million pixels: sharp enough with 4x multisampling, and cheap enough to hold 60 fps
const basePixelRatio = () => Math.min(window.devicePixelRatio, 1.25, Math.sqrt(1.8e6 / (window.innerWidth * window.innerHeight)));
let pixelRatio = basePixelRatio();
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.0075);
scene.environment = buildEnvironment(renderer);
scene.environmentIntensity = 0.8;
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 700);

let composer = null, bloom = null;
if (USE_BLOOM) {
  // a multisampled target keeps edges smooth through the bloom chain
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(size.x, size.y, { samples: 4, type: THREE.HalfFloatType }));
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.4, 0.55, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}
const render = () => (composer ? composer.render() : renderer.render(scene, camera));
let perfLevel = 0;   // how far the frame-rate guard has had to step quality down

const set = buildSet(scene, renderer);
set.follow.shadow.mapSize.set(1024, 1024);
set.work.position.z = STOP_Z + 7.3;      // the teardown light stands over wherever the car stops
set.work.target.position.z = STOP_Z;
const smoke = new Smoke(scene, 700);
smoke.redLineX = set.stripX;
const detail = new THREE.SpotLight(0xffffff, 0, 0, 0.5, 0.85, 0);   // for the wheel and brake close-ups
let car = null;
if (DEBUG) window.__rs = { scene, THREE, camera, renderer, smoke, get car() { return car; } };

/* ================================================================== *
 *  Car motion: everything is a function of u
 * ================================================================== */
const lip = rampPath(S_LIP);
const LIP_PITCH = -(Math.PI / 2 - RAMP.A);                      // nose 40° above level, roof down
const C0 = lip.pos.clone().addScaledVector(lip.up, CAR_H);        // the car's centre as it leaves the lip
const FLIGHT_DZ = LAND_Z - 0.8 - C0.z;
const FL_A = (lip.fwd.y / lip.fwd.z) * FLIGHT_DZ;                 // leave along the ramp's own tangent
const FL_B = FL_A + (C0.y - (HOVER_Y + CAR_H));

const st = { origin: V(), center: V(0, CAR_H, RAMP.ZB - S_START), quat: new THREE.Quaternion(), up: V(0, 1, 0), s: S_START, squash: 0, pass: -1 };
const pt = { pos: V(), fwd: V(), up: V() };
const _x = V(), _m = new THREE.Matrix4(), _qx = new THREE.Quaternion(), _qz = new THREE.Quaternion();
const AX = V(1, 0, 0), AZ = V(0, 0, 1);
const fromPitchRoll = (pitch, roll) => st.quat.copy(_qx.setFromAxisAngle(AX, pitch)).multiply(_qz.setFromAxisAngle(AZ, roll));

function carState(u, time) {
  st.squash = 0;
  if (u < T.climb[1]) {
    // up the ramp: from rest, building speed, still moving at the lip
    const t = seg(u, ...T.climb), e = 2 * t * t - t * t * t;
    st.s = lerp(S_START, S_LIP, e);
    rampPath(st.s, pt);
    _x.crossVectors(pt.up, pt.fwd);
    st.quat.setFromRotationMatrix(_m.makeBasis(_x, pt.up, pt.fwd));
    st.origin.copy(pt.pos);
    st.center.copy(pt.pos).addScaledVector(pt.up, CAR_H);
    st.up.copy(pt.up);
    st.pass = st.s / S_LIP;
    return;
  }
  st.pass = 1.05;
  if (u < T.flight[1]) {
    // off the lip inverted: a ballistic arc while the side thrusters roll it upright
    const t = seg(u, ...T.flight);
    st.center.set(0, C0.y + FL_A * t - FL_B * t * t, C0.z + FLIGHT_DZ * t);
    fromPitchRoll(lerp(LIP_PITCH, 0.07, smooth(t)), Math.PI * (1 - smooth(seg(u, ...T.roll))));
  } else if (u < T.hover[1]) {
    // four floor jets catch it and lower it onto the ground
    const t = seg(u, ...T.hover);
    st.center.set(0, CAR_H + HOVER_Y * Math.pow(1 - t, 2.2), lerp(C0.z + FLIGHT_DZ, LAND_Z, smooth(t)));
    const wobble = reduceMotion ? 0 : 1 - t;
    fromPitchRoll(0.07 * (1 - smooth(Math.min(1, t * 2.2))) - 0.03 * bump(t), Math.sin(time * 3.1) * 0.014 * wobble);
    st.center.x = Math.sin(time * 1.7) * 0.05 * wobble;
  } else {
    const tq = seg(u, ...T.squash);
    st.squash = bump(tq) * (1 - tq) * 1.7;                                   // suspension compressing on impact
    const ts = seg(u, ...T.sprint);
    const run = ts < 0.86 ? 0.93 * Math.pow(ts / 0.86, 2.3) : 0.93 + 0.07 * (1 - Math.pow(1 - (ts - 0.86) / 0.14, 2));
    st.center.set(0, CAR_H, lerp(LAND_Z, STOP_Z, run));
    const tb = seg(u, ...T.brake);
    fromPitchRoll(-0.028 * bump(seg(u, T.sprint[0], T.sprint[0] + 0.12)) + 0.05 * bump(tb) * (1 - tb), 0);
  }
  st.up.set(0, 1, 0).applyQuaternion(st.quat);
  st.origin.copy(st.center).addScaledVector(st.up, -CAR_H * (1 - st.squash * 0.07));
}

/* ================================================================== *
 *  Camera. It stays close and moves continuously (no cuts).
 *   off    offset from the car's centre.  loc: 1 → measured in the car's own axes, so the
 *          camera rides with it up the wall;  loc: 0 → in world axes.
 *   abs    a fixed place in the world instead (the car comes to the camera)
 *   look   what it aims at: an offset from the car (same axes as off), or lookAbs for a fixed point
 *   hold   park here: no drift through this key
 *   sx/sy  slide the picture right/up (fraction of screen height) to leave room for the text
 *   pf     how far to step back on phones (default 1.9)
 * ================================================================== */
const hubAt = (dx, dy, dz) => () => (car ? [car.anchors.hub.x + dx, car.anchors.hub.y + dy, car.anchors.hub.z + dz + STOP_Z] : [0, 1, 0]);
const seatAt = (dx, dy, dz) => () => (car ? [car.anchors.cockpit.x + dx, car.anchors.cockpit.y + dy, car.anchors.cockpit.z + dz + STOP_Z] : [0, 1, 0]);
const KEYS = [
  // at the foot of the ramp, just behind the car
  { u: H,          loc: 1, off: [2.7, 1.0, -5.6], look: [0.6, 1.5, 5], fov: 42, sy: 0.08 },
  { u: H + 0.9,    loc: 1, off: [1.9, 0.9, -6.0], look: [0.3, 1.9, 7], fov: 43, sy: 0.06 },
  // chase: the camera rides up the ramp with the car, so the world tips over around it
  { u: C + 0.02,   loc: 1, off: [1.3, 1.5, -6.2], look: [0, 0.9, 5], fov: 46, sx: 0.12 },
  { u: C + 0.3,    loc: 1, off: [0.8, 1.8, -5.6], look: [0, 0.8, 6], fov: 50, sx: 0.1 },
  // swing out in front of the wall: the car is vertical and the ground is a long way down
  { u: C + 0.55,   loc: 0, off: [8, -1.2, 6], look: [0, 0.6, 0], fov: 40, sx: 0.12 },
  // underneath, looking up as it goes over the top
  { u: C + 0.82,   loc: 0, off: [5, -5.5, 7.2], look: [0, 0.4, 0], fov: 42, sx: 0.08 },
  { u: L,          loc: 0, off: [3.5, -6.5, 7.8], look: [0, 0.2, 0], fov: 44 },
  // the roll, close
  { u: L + 0.3,    loc: 0, off: [6.5, -2.6, 7.4], look: [0, 0, 0], fov: 36, sx: -0.1 },
  { u: L + 0.62,   loc: 0, off: [7.4, -0.6, 5.4], look: [0, 0, 0], fov: 32, sx: -0.12 },
  { u: B - 0.1,    loc: 0, off: [8.6, -1.6, 5], look: [0, -0.5, 0], fov: 34, sx: -0.06 },
  // on the ground, looking up at the four jets as it comes down
  { u: B + 0.12,   abs: [7.4, 0.7, -19], look: [0, -1.0, 0], fov: 38, sx: 0.1 },
  // ...then rising with the cloud, to look down on the car sitting in it
  { u: B + 0.42,   abs: [7.8, 2.3, -18.4], look: [0, -0.2, 0], fov: 37, sx: 0.1 },
  { u: B + 0.68,   abs: [7.6, 3.9, -17.8], look: [0, 0.1, 0], fov: 36, sx: 0.1 },
  { u: S + 0.04,   abs: [6.4, 3.4, -15.5], look: [0, 0.3, 0.5], fov: 36, sx: 0.08 },
  // sprint: launch from behind the rear thrusters, run alongside, then pull ahead as it brakes
  // (the view from behind is held for most of the run, closing in on the tail the whole time)
  { u: S + 0.12,   loc: 0, off: [3.0, 0.5, -5.8], look: [0, -0.05, 0.6], fov: 46, sx: 0.06 },
  { u: S + 0.3,    loc: 0, off: [3.3, 0.48, -5.0], look: [0, -0.05, 0.9], fov: 54, sx: 0.06 },
  { u: S + 0.5,    loc: 0, off: [2.8, 0.42, -3.9], look: [0, -0.05, 1], fov: 58, sx: 0.06 },
  { u: S + 0.68,   loc: 0, off: [4.6, 0.4, 1.2], look: [0, -0.1, 0.6], fov: 54, sx: 0.04 },
  { u: S + 0.84,   loc: 0, off: [2.4, 0.2, 5.6], look: [0, -0.05, 0.4], fov: 42 },
  // design: a slow walk round the nose
  { u: A + 0.05,   loc: 0, off: [1.5, 0.15, 5.4], look: [0, -0.05, 0.4], fov: 36 },
  { u: A + 0.55,   loc: 0, off: [-4.4, 0.55, 4.6], look: [0, 0, 0.2], fov: 34, sx: -0.14 },
  // teardown
  { u: TD + 0.02,  loc: 0, off: [4.3, 1.8, 5.6], look: [0, 0.2, 0], fov: 38, sx: 0.14 },
  { u: TD + 0.5,   loc: 0, off: [5.4, 2.7, 5.6], look: [0, 1.25, 0], fov: 44, sx: 0.12 },
  { u: TD + 0.96,  loc: 0, off: [6.0, 1.5, 2.6], look: [0, 0.9, 0.5], fov: 42, sx: 0.12 },
  // the wheel comes off its hub to the lens, then rolls away
  { u: W + 0.26,   abs: hubAt(2.75, 0.12, 0.3), lookAbs: hubAt(0.4 + HERO_OUT, 0.01, 0), fov: 26, sx: 0.24, pf: 1.5, hold: true },
  { u: W + 0.56,   abs: hubAt(2.7, 0.2, -0.2), lookAbs: hubAt(0.4 + HERO_OUT, 0.01, 0), fov: 26, sx: 0.24, pf: 1.5, hold: true },
  { u: W + 0.94,   abs: hubAt(2.0, 0.2, 0.3), lookAbs: hubAt(-0.1, 0, 0), fov: 28, sx: 0.16, pf: 1.5 },
  // into the driver's seat
  { u: K + 0.42,   abs: seatAt(0.5, 0.9, -1.3), lookAbs: seatAt(0, -0.05, 0.9), fov: 50, pf: 1 },
  { u: K + 0.9,    abs: seatAt(0.12, 0.62, -0.95), lookAbs: seatAt(0, -0.08, 0.9), fov: 54, pf: 1, hold: true },
  // back out for the close
  { u: R + 0.16,   loc: 0, off: [4.2, 1.2, 5.2], look: [0, 0.1, 0], fov: 34, sy: 0.15 },
  { u: R + 0.7,    loc: 0, off: [3.3, 0.85, 5.6], look: [0, 0.1, 0], fov: 34, sy: 0.18, hold: true },
];
const arr = (v) => (typeof v === 'function' ? v() : v);
const _o = V(), _ol = V();
/** where a key puts the camera right now (they follow the car, so this changes every frame) */
function resolve(k, pos, look, up) {
  const loc = k.loc || 0;
  if (k.abs) { const a = arr(k.abs); pos.set(a[0], a[1], a[2]); }
  else {
    _o.set(k.off[0], k.off[1], k.off[2]);
    if (loc) _ol.copy(_o).applyQuaternion(st.quat), _o.lerp(_ol, loc);
    pos.copy(st.center).add(_o);
  }
  if (k.lookAbs) { const a = arr(k.lookAbs); look.set(a[0], a[1], a[2]); }
  else {
    const l = k.look || [0, 0, 0];
    _o.set(l[0], l[1], l[2]);
    if (loc) _ol.copy(_o).applyQuaternion(st.quat), _o.lerp(_ol, loc);
    look.copy(st.center).add(_o);
  }
  up.set(0, 1, 0).lerp(st.up, loc).normalize();
}
const P = [V(), V(), V(), V()], LK = [V(), V(), V(), V()], UP = [V(), V(), V(), V()];
const _m1 = V(), _m2 = V(), _look = V(), _up = V(), _a = V(), _b = V();
/** smooth curve through the keys: position and velocity are both continuous, so the camera never jerks */
function hermite(out, p0, p1, p2, p3, k0, k1, k2, k3, t) {
  const d = k2.u - k1.u;
  if (k1.hold) _m1.set(0, 0, 0); else _m1.subVectors(p2, p0).multiplyScalar(d / Math.max(1e-4, k2.u - k0.u));
  if (k2.hold) _m2.set(0, 0, 0); else _m2.subVectors(p3, p1).multiplyScalar(d / Math.max(1e-4, k3.u - k1.u));
  const t2 = t * t, t3 = t2 * t;
  out.copy(p1).multiplyScalar(2 * t3 - 3 * t2 + 1).addScaledVector(_m1, t3 - 2 * t2 + t).addScaledVector(p2, -2 * t3 + 3 * t2).addScaledVector(_m2, t3 - t2);
}
let shakeAmt = 0;
function applyCamera(u, time) {
  let i = 0;
  while (i < KEYS.length - 2 && u >= KEYS[i + 1].u) i++;
  const k1 = KEYS[i], k2 = KEYS[i + 1], k0 = KEYS[Math.max(0, i - 1)], k3 = KEYS[Math.min(KEYS.length - 1, i + 2)];
  const ks = [k0, k1, k2, k3];
  for (let n = 0; n < 4; n++) resolve(ks[n], P[n], LK[n], UP[n]);
  const t = clamp01((u - k1.u) / (k2.u - k1.u)), ts = smooth(t);
  hermite(camera.position, P[0], P[1], P[2], P[3], k0, k1, k2, k3, t);
  hermite(_look, LK[0], LK[1], LK[2], LK[3], k0, k1, k2, k3, t);
  _up.lerpVectors(UP[1], UP[2], ts).normalize();

  const narrow = camera.aspect < 0.9;
  const back = narrow ? lerp(k1.pf ?? 1.9, k2.pf ?? 1.9, ts) : 1;                 // phones: step back so the whole car fits the narrow frame
  if (back !== 1) camera.position.sub(_look).multiplyScalar(back).add(_look);
  if (!reduceMotion) {
    camera.position.x += Math.sin(time * 0.23) * 0.05 + (Math.random() - 0.5) * shakeAmt;
    camera.position.y += Math.sin(time * 0.31) * 0.03 + (Math.random() - 0.5) * shakeAmt;
  }
  if (camera.position.y < 0.12) camera.position.y = 0.12;
  camera.up.copy(_up);
  camera.lookAt(_look);
  camera.fov = lerp(k1.fov, k2.fov, ts) * (narrow ? 1.1 : 1);
  const w = window.innerWidth, h = window.innerHeight;
  const sx = narrow ? 0 : lerp(k1.sx || 0, k2.sx || 0, ts);
  const sy = narrow ? 0.14 : lerp(k1.sy || 0, k2.sy || 0, ts);                    // phones: car above, text below
  camera.setViewOffset(w, h, -sx * h, sy * h, w, h);                              // also applies the new fov
}

/* ================================================================== *
 *  Page UI
 * ================================================================== */
const flashEl = document.getElementById('flash'), labelsEl = document.getElementById('labels');
const progressEl = document.getElementById('progress');
const LABELS = [
  ['canopy', 'Canopy'], ['shell', 'Body shell'], ['tanks', 'Air tanks'], ['battery', 'Battery'],
  ['motor', 'Rear drive units'], ['brakes', 'Brakes'], ['fans', 'Suction fans'], ['thrusters', 'Cold-gas thrusters'],
].map(([key, text]) => {
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = text;
  labelsEl.appendChild(el);
  return { key, el };
});
function updateUi(u, tear) {
  progressEl.style.width = ((u / sections.length) * 100).toFixed(2) + '%';
  const show = car && tear > 0.92 && u > TD + 0.6 && u < TD + 0.97;
  const w = window.innerWidth, h = window.innerHeight;
  for (const l of LABELS) {
    const tg = car && car.labels[l.key];
    if (!tg) continue;
    if (show) {
      _a.copy(tg.local); tg.obj.localToWorld(_a); _a.project(camera);
      l.el.style.transform = `translate(${((_a.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-_a.y * 0.5 + 0.5) * h).toFixed(1)}px) translateY(-50%)`;
    }
    l.el.classList.toggle('is-on', !!show && _a.z < 1);
  }
}

const io = new IntersectionObserver((entries) => {
  entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
}, { threshold: 0.2 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

let lenis = null;
if (!instant && !DEMO) {
  import('https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.mjs')
    .then(({ default: Lenis }) => { lenis = new Lenis({ lerp: 0.1, wheelMultiplier: 0.9 }); if (!ready) lenis.stop(); })
    .catch(() => {});
}
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const el = document.querySelector(a.getAttribute('href'));
    if (!el) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(el.offsetTop, { duration: 2 });
    else window.scrollTo({ top: el.offsetTop, behavior: reduceMotion ? 'auto' : 'smooth' });
  });
});

/* ================================================================== *
 *  Loading
 * ================================================================== */
const loaderEl = document.getElementById('loader');
const loadFill = document.getElementById('loadFill'), loadPct = document.getElementById('loadPct');
const load = { car: 0, wheel: 0, shown: 0, loaded: false, failed: false, done: false, last: 0 };
let ready = false;
function begin() {
  ready = true;
  loaderEl.classList.add('is-done');
  document.body.classList.add('is-ready');
  lenis?.start();
}
function tickLoader(now) {
  if (load.done) return;
  const dt = Math.min((now - (load.last || now)) / 1000, 1);
  load.last = now;
  const real = load.loaded ? 100 : Math.min(99, ((load.car + load.wheel) / (BYTES.car + BYTES.wheel)) * 100);
  load.shown = instant ? real : load.shown + Math.max(0, Math.min((real - load.shown) * 6 * dt + 6 * dt, 110 * dt, real - load.shown));
  loadFill.style.width = load.shown.toFixed(1) + '%';
  loadPct.textContent = Math.round(load.shown);
  if (load.loaded && load.shown >= 99.9) { load.done = true; setTimeout(begin, instant ? 0 : 250); return; }
  if (!load.failed) requestAnimationFrame(tickLoader);
}
requestAnimationFrame(tickLoader);

const gltf = new GLTFLoader();
gltf.setMeshoptDecoder(MeshoptDecoder);
Promise.all([
  gltf.loadAsync(MODEL_URL, (x) => { load.car = Math.min(x.loaded, BYTES.car); }),
  gltf.loadAsync(WHEEL_URL, (x) => { load.wheel = Math.min(x.loaded, BYTES.wheel); }),
]).then(([carFile, wheelFile]) => {
  car = buildCar(carFile.scene, scene);
  mountWheels(car, wheelFile.scene);
  const h = car.anchors.hub;
  detail.position.set(h.x + 3.6, 2.2, h.z + 2.6 + STOP_Z);
  detail.target.position.set(h.x + 0.4 + HERO_OUT, h.y, h.z + STOP_Z);
  scene.add(detail, detail.target);
  warmUp();
  load.loaded = true;
}).catch((err) => {
  console.error(err);
  load.failed = true;
  document.querySelector('.loader__mark').textContent = 'Could not load the 3D models';
});

/** Compile every shader and upload every texture behind the loader, so nothing stutters the first time it appears. */
function warmUp() {
  const hidden = [];
  scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
  renderer.compile(scene, camera);
  carState(0, 0);
  car.root.position.copy(st.origin); car.root.quaternion.copy(st.quat); car.root.updateMatrixWorld(true);
  applyCamera(0, 0);
  render();
  hidden.forEach((o) => { o.visible = false; });
}

/* ================================================================== *
 *  Resize
 * ================================================================== */
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  if (perfLevel === 0) pixelRatio = basePixelRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h);
  if (composer) { composer.setPixelRatio(pixelRatio); composer.setSize(w, h); }
  measure();
}
window.addEventListener('resize', resize);
window.addEventListener('load', measure);
measure();

/* ================================================================== *
 *  Frame loop
 * ================================================================== */
const clock = new THREE.Clock();
let fixedU = (DEBUG && params.has('u')) ? +params.get('u') : null;
let u = fixedU ?? 0, lastU = u;
let simTime = 0, manual = false, debugEnergy = null;
let lastScroll = window.scrollY, scrollVel = 0, spin = 0, lastZ = null, lastS = null;
const _wp = V(), _wd = V(), _n = V();
const acc = { ground: 0, rear: 0 };
let perfN = 0, perfT = 0;
const rnd = (a, b) => a + Math.random() * (b - a);
/** how many puffs to emit this frame: a steady rate while it lasts, plus extra for distance scrolled */
const quota = (key, perSecond, perU, dt, du) => { acc[key] += perSecond * dt + perU * du; const n = Math.floor(acc[key]); acc[key] -= n; return n; };

/** The camera is close, so most vapour is thrown to the far side of the car: it becomes a backdrop, not a white-out. */
function awayFromLens(a, x, z) {
  const tx = camera.position.x - x, tz = camera.position.z - z, len = Math.hypot(tx, tz) || 1;
  const toward = (Math.cos(a) * tx + Math.sin(a) * tz) / len;
  if (toward > 0.15 && Math.random() < 0.88) return a + Math.PI + rnd(-0.5, 0.5);
  return a;
}

function emitEffects(dt, energy, pow) {
  const du = Math.abs(u - lastU), k = 0.6 + energy * 0.7;
  const cz = st.center.z, cx = st.center.x;
  // floor jets: where each one meets the ground it throws up a rolling cloud
  if (pow.hover > 0.05) {
    const n = quota('ground', 44 * pow.hover * k, 130, dt, du);
    for (let i = 0; i < n; i++) {
      const { nz } = car.jets.hover[(Math.random() * 4) | 0];
      _wp.copy(nz.p); car.root.localToWorld(_wp);
      _wd.copy(nz.d).applyQuaternion(car.root.quaternion);
      const reach = _wp.y / Math.max(0.25, -_wd.y);
      if (reach > 9.5) continue;
      const hx = _wp.x + _wd.x * reach, hz = _wp.z + _wd.z * reach;
      // thrown outwards along the ground: the cloud spreads wide and stays low, then billows up as it ages
      let a = Math.atan2(hz - cz, hx - cx) + rnd(-1.1, 1.1);
      a = awayFromLens(a, hx, hz);
      const sp = rnd(1.5, 6.8), sh = rnd(0.72, 1);
      const tall = Math.random() < 0.2;                        // a few puffs climb, giving the cloud its lumps
      smoke.spawn({ x: hx + rnd(-0.3, 0.3), y: 0.25, z: hz + rnd(-0.3, 0.3), vx: Math.cos(a) * sp, vy: tall ? rnd(1.2, 3) : rnd(0.05, 0.7), vz: Math.sin(a) * sp,
        life: rnd(3.4, 6.2), size: rnd(0.6, 1.0), grow: tall ? rnd(2.2, 3.4) : rnd(1.3, 2.7), alpha: rnd(0.68, 0.9), rise: tall ? rnd(0.3, 0.6) : rnd(0.04, 0.2), drag: rnd(0.8, 1.3),
        r: 0.9 * sh, g: 0.93 * sh, b: 0.97 * sh });
    }
  }
  // rear thrusters on the sprint: a wall of vapour thrown back down the runway
  if (pow.rear > 0.05) {
    const n = quota('rear', 110 * pow.rear * k, 230, dt, du);
    for (let i = 0; i < n; i++) {
      const { nz } = car.jets.rear[(Math.random() * 4) | 0];
      _wp.copy(nz.p).addScaledVector(nz.d, rnd(0.6, 2.4)); car.root.localToWorld(_wp);
      smoke.spawn({ x: _wp.x + rnd(-0.2, 0.2), y: Math.max(0.3, _wp.y + rnd(-0.1, 0.3)), z: _wp.z, vx: rnd(-1.6, 1.6), vy: rnd(0.2, 1.4), vz: -rnd(4, 10),
        life: rnd(1.8, 3.2), size: rnd(0.5, 0.8), grow: rnd(2, 3.4), alpha: rnd(0.55, 0.78), rise: 0.3, drag: 1.5 });
    }
  }
  // touchdown: one hard ring of dust and vapour
  if ((lastU < T.hover[1]) !== (u < T.hover[1])) {
    for (let i = 0; i < 46; i++) {
      const a = awayFromLens(Math.random() * Math.PI * 2, cx, cz), sp = rnd(3.5, 9), sh = rnd(0.8, 1);
      smoke.spawn({ x: cx + Math.cos(a) * 1.2, y: 0.4, z: cz + Math.sin(a) * 2.2, vx: Math.cos(a) * sp, vy: rnd(0.3, 1.8), vz: Math.sin(a) * sp,
        life: rnd(4, 7), size: rnd(0.9, 1.4), grow: rnd(2.2, 4), alpha: rnd(0.68, 0.88), rise: rnd(0.12, 0.38), drag: rnd(0.9, 1.4),
        r: 0.9 * sh, g: 0.92 * sh, b: 0.95 * sh });
    }
  }
}

/* ================================================================== *
 *  Demo mode, for screen recording: the page scrolls itself at a steady pace.
 *    ?demo                    the whole story, top to bottom
 *    &from=climb&to=sprint    start / end at a section (its key) or at a story position (e.g. 4.5)
 *    &speed=0.5               screen heights per second
 *    &delay=3                 seconds to wait before it starts (time to start the recorder)
 *    &nav=1                   keep the top bar (hidden by default)
 *    &loop=1                  start over when it reaches the end
 *  Keys: Space pauses / resumes, R starts over.
 *
 *  ?render takes the same options and renders the run frame by frame straight into an MP4, so nothing
 *  is dropped however heavy the scene is. Open it through render.html, which runs it at a fixed video size
 *  (see js/render.js and js/render-stage.js).
 * ================================================================== */
let demo = null;
if (DEMO) {
  const root = document.documentElement;
  // a live demo hides the page's chrome; a render keeps the site exactly as a visitor sees it
  root.classList.add(RENDER ? 'is-render' : 'is-demo');
  if (params.get('nav') === '1') root.classList.add('is-demo-nav');
  const at = (v, fallback) => (v === null ? fallback : v in IDX ? IDX[v] : Number.isFinite(+v) ? +v : fallback);
  const yOf = (uu) => {
    const i = Math.min(sections.length - 1, Math.max(0, Math.floor(uu)));
    return Math.min(tops[i] + (uu - i) * heights[i], document.documentElement.scrollHeight - window.innerHeight);
  };
  // a render takes its time: about a minute and a half for the whole page, with a beat on the title first
  const speed = +(params.get('speed') || (RENDER ? 0.25 : 0.5)), delay = +(params.get('delay') ?? (RENDER ? 2.5 : 3)), loop = params.get('loop') === '1';
  const tail = +(params.get('tail') ?? (RENDER ? 0.6 : 1.2));   // seconds to hold once it stops (a render ends then)
  const RAMP_T = 1.2;                       // seconds to ease up to speed, and down again at the end
  let t = -delay, playing = true, T = Infinity;
  demo = {
    // distance along the run after t seconds: ease in, cruise, ease out
    step(dt) {
      if (!ready) return;
      const y0 = yOf(at(params.get('from'), 0)), y1 = yOf(at(params.get('to'), sections.length));
      const D = Math.max(1, y1 - y0), v = speed * window.innerHeight, a = Math.min(RAMP_T, D / v);
      T = D / v + a;
      if (playing) t += dt;
      const tt = Math.max(0, Math.min(T, t));
      const d = tt < a ? (v * tt * tt) / (2 * a) : tt < T - a ? v * (tt - a / 2) : D - (v * (T - tt) ** 2) / (2 * a);
      window.scrollTo({ top: y0 + d, behavior: 'instant' });   // the page's CSS asks for smooth scrolling, which would lag every step
      if (t > T + 2 && loop) t = -delay;
    },
    restart() { t = -delay; playing = true; },
    get finished() { return t >= T + tail; },
    get seconds() { return delay + T + tail; },        // length of the whole run (known after the first step)
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); playing = !playing; }
    if (e.code === 'KeyR') demo.restart();
  });
  if (DEBUG) window.__rs.demo = demo;
  if (RENDER) {
    import('./render.js').then(({ renderVideo }) => renderVideo({
      canvas,
      // ready once the models are in; the loader screen's own animation doesn't run in a background tab, so don't wait for it
      whenReady: () => new Promise((res) => { const check = () => (ready ? res() : load.loaded ? (begin(), res()) : setTimeout(check, 100)); check(); }),
      // jump straight to the start, so the first frames don't fly through the story to get there
      start() { manual = true; demo.restart(); demo.step(0); u = lastU = scrollU(); },
      // one frame of the story at a fixed time step
      step(dt) { demo.step(dt); frame(dt); },
      get finished() { return demo.finished; },
      get seconds() { return demo.seconds; },
      setPixelRatio(pr) {
        pixelRatio = pr;
        renderer.setPixelRatio(pr); renderer.setSize(window.innerWidth, window.innerHeight);
        if (composer) { composer.setPixelRatio(pr); composer.setSize(window.innerWidth, window.innerHeight); }
      },
    }, params));
  } else console.info('Demo mode: Space pauses, R restarts. Options: from, to, speed, delay, nav, loop.');
}

// the 3D viewer takes over the screen: pause this scene and the page's scrolling while it is open
let paused = false;
window.addEventListener('viewer:open', () => { paused = true; lenis?.stop(); });
window.addEventListener('viewer:close', () => { paused = false; clock.getDelta(); lenis?.start(); });

renderer.setAnimationLoop((now) => {
  if (manual || paused) return;            // the capture tool is stepping frames itself, or the viewer is open
  lenis?.raf(now);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (demo && !RENDER) demo.step(dt);       // a render steps the demo itself, frame by frame
  frame(dt);
});

function frame(dt) {
  simTime += dt;
  const time = simTime;

  // --- where we are in the story
  const sy = window.scrollY;
  scrollVel += ((sy - lastScroll) / Math.max(dt, 0.001) - scrollVel) * 0.15;
  lastScroll = sy;
  const energy = debugEnergy ?? Math.min(1, Math.abs(scrollVel) / 1800);   // how hard the user is scrolling
  lastU = u;
  u += ((fixedU ?? scrollU()) - u) * damp(9, dt);

  if (!car) { render(); return; }

  // --- car
  carState(u, time);
  car.root.position.copy(st.origin);
  car.root.quaternion.copy(st.quat);
  car.root.scale.set(1, 1 - st.squash * 0.035, 1);
  car.root.visible = ready;
  car.root.updateMatrixWorld(true);
  set.ledMat.uniforms.uPass.value = st.pass;

  // --- teardown: canopy, then shell, then lower body rise off the chassis; the snap drops them back
  const back = 1 - Math.pow(seg(u, ...T.snap), 3);
  const tear = smooth(seg(u, ...T.tear)) * back;
  const cab = smooth(seg(u, ...T.cab));     // for the cockpit the body settles back down and only the canopy stays off
  const lift = [0, 1.05 * smooth(seg(tear, 0.35, 0.9)) * (1 - cab), 1.95 * smooth(seg(tear, 0.15, 0.7)) * (1 - cab), 2.95 * smooth(seg(tear, 0, 0.5))];
  for (const part of car.parts) part.obj.position.set(part.base.x, part.base.y + lift[part.layer], part.base.z);
  car.core.visible = tear > 0.004 && cab < 0.995;

  // --- wheels
  const slide = 0.4 * smooth(seg(tear, 0.55, 1)) * (1 - cab);          // every wheel eases off its hub
  const heroOut = smooth(seg(u, ...T.wheelOut)) * back, heroRoll = smooth(seg(u, ...T.wheelRoll)) * back;
  const onRamp = u < T.climb[1], onGround = u >= T.hover[1];
  const dz = lastZ === null ? 0 : st.center.z - lastZ, ds = lastS === null || !onRamp ? 0 : st.s - lastS;
  lastZ = st.center.z; lastS = st.s;
  spin += (onRamp ? ds : onGround ? dz : 0) / car.wheelR + (!onRamp && !onGround ? dt * 9 : 0);
  for (const w of car.wheels) {
    const x = w.base.x + w.side * slide + (w.hero ? w.side * heroOut * HERO_OUT : 0);
    const roll = w.hero ? heroRoll * 6.5 : 0;                          // the loose wheel rolls off down the runway
    w.pivot.position.set(x, w.base.y, w.base.z + roll);
    // on its way to the lens the loose wheel turns until its badge stands upright
    const upright = LOGO_UP + Math.round((spin - LOGO_UP) / (Math.PI * 2)) * Math.PI * 2;
    w.spinner.rotation.x = spin + roll / car.wheelR + (w.hero ? (upright - spin) * heroOut : 0);
  }
  for (const f of car.fans) f.rotation.y += dt * 6;
  car.mats.fanRing.emissiveIntensity = tear * 0.9;

  // --- thrusters
  const flick = reduceMotion ? 1 : 0.86 + energy * 0.3;
  const pow = {
    roll: Math.pow(bump(seg(u, ...T.roll)), 0.55) * flick,
    hover: smooth(seg(u, T.hover[0] - 0.14, T.hover[0])) * (1 - smooth(seg(u, T.hover[1], T.hover[1] + 0.08))) * flick,
    nose: smooth(seg(u, T.hover[0] - 0.08, T.hover[0] + 0.04)) * (1 - smooth(seg(u, T.hover[0] + 0.16, T.hover[0] + 0.32))) * flick,
    rear: seg(u, T.sprint[0] - 0.04, T.sprint[0] + 0.02) * (1 - seg(u, T.sprint[1] - 0.09, T.sprint[1] - 0.02)) * flick,
  };
  for (const { jet, nz } of car.jets.hover) {
    _wp.copy(nz.p); car.root.localToWorld(_wp);
    _wd.copy(nz.d).applyQuaternion(car.root.quaternion);
    jet.userData.set(pow.hover, Math.min(9.5, Math.max(0.6, _wp.y / Math.max(0.25, -_wd.y))), time);
  }
  for (const { jet } of car.jets.roll) jet.userData.set(pow.roll, 2.7, time);
  for (const { jet } of car.jets.nose) jet.userData.set(pow.nose, 2.2, time);
  for (const { jet } of car.jets.rear) jet.userData.set(pow.rear * 0.55, 3.0, time);   // they point at the lens here, so keep them from blowing out
  const thrust = Math.max(pow.roll * 0.6, pow.hover, pow.rear, pow.nose * 0.5);
  if (ready && !reduceMotion) emitEffects(dt, energy, pow);
  car.mats.nozzle.emissiveIntensity += (thrust * 5 - car.mats.nozzle.emissiveIntensity) * damp(10, dt);
  car.thrustLight.intensity = pow.hover * 26 + pow.roll * 16 + pow.rear * 14;

  // --- lights
  set.follow.position.copy(st.center).add(_n.set(5.5, 11, 9));
  set.follow.target.position.copy(st.center);
  set.work.intensity = tear * 3 * (1 - cab * 0.55);
  const closeUp = smooth(seg(u, W, W + 0.2)) * (1 - smooth(seg(u, W + 0.94, K + 0.1)));
  detail.intensity = 1.6 * closeUp;
  const flash = bump(seg(u, ...T.flash)) * (1 - seg(u, ...T.flash));
  car.beam.intensity = (u < T.hover[1] ? 120 : u < T.brake[0] ? 60 : 14) + flash * 300;
  for (const m of car.mats.headlights) m.emissiveIntensity = 2.5 + flash * 14;
  for (const m of car.mats.tail) m.emissiveIntensity = 3.5 + pow.rear * 3;

  // --- impacts: camera shake + white flash
  const hit = bump(seg(u, T.squash[0] - 0.01, T.squash[0] + 0.14)) + bump(seg(u, T.brake[0] + 0.02, T.brake[0] + 0.16)) + bump(seg(u, R + 0.04, R + 0.14));
  shakeAmt = reduceMotion ? 0 : hit * (0.04 + energy * 0.08) + thrust * 0.008;
  flashEl.style.opacity = (Math.pow(bump(seg(u, R + 0.02, R + 0.12)), 2) * 0.45).toFixed(3);
  if (bloom) bloom.strength = 0.4 + thrust * 0.22 + flash * 0.6;

  applyCamera(u, time);
  smoke.update(dt, camera, time);
  updateUi(u, tear);
  render();

  // --- keep it smooth on weaker devices: drop resolution first, then shadows, then bloom
  if (ready && !manual && !DEMO && dt < 0.1 && !document.hidden) {   // (a demo keeps full quality: the recorder can cost frames)
    perfN++; perfT += dt;
    if (perfN >= 75) {
      const fps = perfN / perfT; perfN = 0; perfT = 0;
      if (fps < 45 && perfLevel < 3) {
        perfLevel++;
        if (perfLevel === 1) pixelRatio = Math.min(pixelRatio, 0.85);
        if (perfLevel === 2) { pixelRatio = Math.min(pixelRatio, 0.75); renderer.shadowMap.enabled = false; }
        if (perfLevel === 3 && bloom) bloom.enabled = false;
        resize();
      }
    }
  }
}

/* ================================================================== *
 *  Developer tools (only with ?debug)
 *   __rs.sheet(name, steps)  step the story as if someone were scrolling and save a contact sheet to .shots/
 *   __rs.bench(u, n)         average cost of a frame at one point in the story, in milliseconds
 * ================================================================== */
if (DEBUG) {
  const grab = (w) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = Math.round((w * canvas.height) / canvas.width);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  };
  window.__rs.sheet = async (name, steps, { cols = 4, cell = 480, energy = 0.5, start = null } = {}) => {
    manual = true; debugEnergy = energy;
    if (start !== null) { fixedU = start; frame(1 / 60); }
    const rows = Math.ceil(steps.length / cols), ch = Math.round((cell * canvas.height) / canvas.width);
    const sheet = document.createElement('canvas');
    sheet.width = cols * cell; sheet.height = rows * ch;
    const g = sheet.getContext('2d');
    g.font = '15px monospace';
    steps.forEach((s, i) => {
      const from = fixedU ?? 0;
      for (let f = 1; f <= s.frames; f++) { fixedU = lerp(from, s.to, f / s.frames); frame(1 / 60); }
      const x = (i % cols) * cell, y = Math.floor(i / cols) * ch;
      g.drawImage(grab(cell), x, y);
      g.fillStyle = '#3f6'; g.fillText(`${s.label || ''} u=${s.to}`, x + 8, y + 18);
    });
    manual = false; debugEnergy = null;
    const blob = await new Promise((r) => sheet.toBlob(r, 'image/jpeg', 0.86));
    await fetch('/__shot?name=' + name, { method: 'POST', body: blob });
    return `${name}: ${steps.length} frames, smoke puffs alive ${smoke.liveCount}`;
  };
  window.__rs.bench = (at, n = 40) => {
    manual = true; fixedU = at;
    const gl = renderer.getContext(), px = new Uint8Array(4);
    for (let i = 0; i < 5; i++) frame(1 / 60);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);        // wait for the GPU to finish
    const t0 = performance.now();
    for (let i = 0; i < n; i++) frame(1 / 60);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    manual = false;
    return +((performance.now() - t0) / n).toFixed(2);
  };
  window.__rs.tune = (o) => {
    if (o.dpr) { pixelRatio = o.dpr; resize(); }
    if ('shadows' in o) renderer.shadowMap.enabled = o.shadows;
    if ('bloom' in o && bloom) bloom.enabled = o.bloom;
    if ('smoke' in o) smoke.mesh.visible = o.smoke;
    return { dpr: pixelRatio, buffer: [canvas.width, canvas.height], shadows: renderer.shadowMap.enabled, bloom: bloom ? bloom.enabled : false };
  };
}
