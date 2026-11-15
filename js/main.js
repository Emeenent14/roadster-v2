import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clamp01, smooth, seg, bump, lerp, V } from './util.js';
import { buildSet, buildEnvironment, rampPath, S_LIP, RAMP } from './set.js';
import { Smoke } from './fx.js';
import { buildCar, layoutInspect, CAR_H } from './car.js';

/* ================================================================== *
 *  Config
 * ================================================================== */
const MODEL_URL = 'models/roadster.glb?v=1';   // bump v when the file changes
const MODEL_BYTES = 3299168;
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');              // ?debug snaps instantly; ?debug&p=0.6 jumps to a point in the story
const INSPECT = params.has('inspect');          // ?inspect lays the model's pieces out in a grid
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const instant = DEBUG || INSPECT || reduceMotion;
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const S_START = -2.5;     // the car waits just short of where the ramp starts to curve
const LAND_Z = -24;       // where it comes down
const STOP_Z = 1.2;       // where the sprint ends, right in front of the camera
const HOVER_Y = 7;        // height at which the four floor jets catch the fall

// The story, as slices of total scroll progress (0 → 1)
const ACTS = [
  [0.0, 'THE RAMP'], [0.036, 'THE CLIMB'], [0.15, 'KICKFLIP'], [0.235, 'THE BURN'], [0.305, 'TOUCHDOWN'],
  [0.347, 'SPRINT'], [0.5, 'TEARDOWN'], [0.66, 'DETAILS'], [0.895, 'SNAP'], [0.935, 'RESERVE'],
];
const T = {
  climb: [0.036, 0.15], flight: [0.15, 0.235], roll: [0.158, 0.218], hover: [0.235, 0.305], squash: [0.305, 0.34],
  sprint: [0.352, 0.428], brake: [0.42, 0.465],
  teardown: [0.5, 0.63], wheelOut: [0.662, 0.7], wheelRoll: [0.742, 0.792],
  snap: [0.895, 0.915], flash: [0.9, 0.945],
};
const damp = (rate, dt) => (instant ? 1 : 1 - Math.exp(-rate * dt));

/* ================================================================== *
 *  Renderer, scene, post
 * ================================================================== */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
let pixelRatio = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.0075);
scene.environment = buildEnvironment(renderer);
scene.environmentIntensity = 0.8;
const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.05, 700);

// bloom for lights and jets; a multisampled target keeps edges smooth through the effect chain
const bufSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(bufSize.x, bufSize.y, { samples: 4, type: THREE.HalfFloatType }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.42, 0.6, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const set = buildSet(scene, renderer);
const smoke = new Smoke(scene, 950);
smoke.redLineX = set.stripX;
let car = null;
const detail = new THREE.SpotLight(0xffffff, 0, 0, 0.5, 0.85, 0);
if (DEBUG || INSPECT) window.__rs = { scene, THREE, camera, renderer, composer, smoke, get car() { return car; } };

/* ================================================================== *
 *  Car motion: everything is a function of progress p
 * ================================================================== */
const lip = rampPath(S_LIP);
const LIP_PITCH = -(Math.PI / 2 - RAMP.A);                      // nose 40° above level, roof down
const C0 = lip.pos.clone().addScaledVector(lip.up, CAR_H);        // the car's centre as it leaves the lip
const FLIGHT_DZ = LAND_Z - 0.8 - C0.z;
const FL_A = (lip.fwd.y / lip.fwd.z) * FLIGHT_DZ;                 // leave along the ramp's own tangent
const FL_B = FL_A + (C0.y - (HOVER_Y + CAR_H));

const st = { origin: V(), center: V(), quat: new THREE.Quaternion(), s: S_START, squash: 0, pass: -1 };
const pt = { pos: V(), fwd: V(), up: V() };
const _x = V(), _up = V(), _m = new THREE.Matrix4(), _qx = new THREE.Quaternion(), _qz = new THREE.Quaternion();
const AX = V(1, 0, 0), AZ = V(0, 0, 1);
const fromPitchRoll = (pitch, roll) => st.quat.copy(_qx.setFromAxisAngle(AX, pitch)).multiply(_qz.setFromAxisAngle(AZ, roll));

function carState(p, time) {
  st.squash = 0;
  if (p < T.climb[1]) {
    // up the ramp: from rest, building speed, still moving at the lip
    const t = seg(p, ...T.climb), e = 2 * t * t - t * t * t;
    st.s = lerp(S_START, S_LIP, e);
    rampPath(st.s, pt);
    _x.crossVectors(pt.up, pt.fwd);
    st.quat.setFromRotationMatrix(_m.makeBasis(_x, pt.up, pt.fwd));
    st.origin.copy(pt.pos);
    st.center.copy(pt.pos).addScaledVector(pt.up, CAR_H);
    st.pass = st.s / S_LIP;
    return;
  }
  st.pass = 1.05;
  if (p < T.flight[1]) {
    // off the lip inverted: a ballistic arc while the side thrusters roll it upright
    const t = seg(p, ...T.flight);
    st.center.set(0, C0.y + FL_A * t - FL_B * t * t, C0.z + FLIGHT_DZ * t);
    fromPitchRoll(lerp(LIP_PITCH, 0.07, smooth(t)), Math.PI * (1 - smooth(seg(p, ...T.roll))));
  } else if (p < T.hover[1]) {
    // four floor jets catch it and lower it onto the ground
    const t = seg(p, ...T.hover);
    st.center.set(0, CAR_H + HOVER_Y * Math.pow(1 - t, 2.2), lerp(C0.z + FLIGHT_DZ, LAND_Z, smooth(t)));
    const wobble = reduceMotion ? 0 : (1 - t);
    fromPitchRoll(0.07 * (1 - smooth(Math.min(1, t * 2.2))) - 0.03 * bump(t), Math.sin(time * 3.1) * 0.014 * wobble);
    st.center.x = Math.sin(time * 1.7) * 0.05 * wobble;
  } else {
    const tq = seg(p, ...T.squash);
    st.squash = bump(tq) * (1 - tq) * 1.7;                                   // suspension compressing on impact
    const ts = seg(p, ...T.sprint);
    const run = ts < 0.86 ? 0.93 * Math.pow(ts / 0.86, 2.3) : 0.93 + 0.07 * (1 - Math.pow(1 - (ts - 0.86) / 0.14, 2));
    st.center.set(0, CAR_H, lerp(LAND_Z, STOP_Z, run));
    const tb = seg(p, ...T.brake);
    fromPitchRoll(-0.028 * bump(seg(p, T.sprint[0], T.sprint[0] + 0.03)) + 0.05 * bump(tb) * (1 - tb), 0);
  }
  _up.set(0, 1, 0).applyQuaternion(st.quat);
  st.origin.copy(st.center).addScaledVector(_up, -CAR_H * (1 - st.squash * 0.07));
}

/* ================================================================== *
 *  Cameras. Each key: where the camera is, what it looks at, lens.
 *   pos   world position        (rel: true → measured from the car's centre)
 *   look  offset from the car's centre  (abs: true → a fixed point in the world)
 *   cut   jump to this shot instead of gliding from the previous one
 *   sx    slide the picture sideways (fraction of screen height) to leave room for text
 * ================================================================== */
const hubAt = (dx, dy, dz) => () => (car ? [car.anchors.hub.x + dx, car.anchors.hub.y + dy, car.anchors.hub.z + dz + STOP_Z] : [0, 0, 0]);
const seatAt = (dx, dy, dz) => () => (car ? [car.anchors.cockpit.x + dx, car.anchors.cockpit.y + dy, car.anchors.cockpit.z + dz + STOP_Z] : [0, 0, 0]);
const KEYS = [
  // behind the car at the foot of the ramp
  // (a long lens from far back, so the ramp towers right behind the car)
  { p: 0.0,   pos: [2.2, 0.95, 4],      look: [0, 2.3, -34], abs: true, fov: 9.5, wide: true, my: 0.25 },
  { p: 0.036, pos: [1.6, 0.9, 2],       look: [0, 3.3, -34], abs: true, fov: 10.5, wide: true, my: 0.25 },
  // wide: the whole ramp, car climbing
  { p: 0.038, cut: true, pos: [25, 2.2, -7], look: [0, 13.2, -42.5], abs: true, fov: 44, wide: true },
  { p: 0.094, pos: [23.5, 2.4, -8],     look: [0, 13.8, -42.5], abs: true, fov: 43, wide: true },
  // out in front of the wall, watching the car climb it
  { p: 0.096, cut: true, rel: true, pos: [7, 1.5, 19], look: [0, 2.2, 0], fov: 30 },
  { p: 0.126, rel: true, pos: [4.5, 7.5, 17], look: [0, 2.6, 0], fov: 30 },
  // wide again: overhang, launch, roll
  { p: 0.128, cut: true, pos: [27, 1.9, -3], look: [0, 17.5, -40], abs: true, fov: 44, wide: true },
  { p: 0.152, pos: [27, 1.9, -3],       look: [0, 20.5, -38], abs: true, fov: 42, wide: true },
  { p: 0.2,   pos: [25, 1.8, -2],       look: [0, -3, 0], fov: 38, wide: true },
  { p: 0.238, pos: [22, 1.7, -7],       look: [0, -2.6, 0], fov: 34, wide: true },
  // the burn and the landing, side on
  { p: 0.275, pos: [18, 1.5, -14],      look: [0, -1.2, 0], fov: 32 },
  { p: 0.305, pos: [16.5, 1.4, -18],    look: [0, 1.0, 0], fov: 32 },
  { p: 0.345, pos: [17.5, 1.6, -16],    look: [0, 1.4, 0.5], fov: 32 },
  // down-range, low: the car comes out of its own cloud
  { p: 0.347, cut: true, pos: [0.9, 0.34, 7.2], look: [0, 0.1, 0], fov: 28 },
  { p: 0.392, pos: [0.9, 0.34, 7.2],    look: [0, 0, 0], fov: 60 },
  { p: 0.437, pos: [0.9, 0.42, 6.4],    look: [0, -0.1, 0.6], fov: 44 },
  { p: 0.49,  pos: [1.6, 0.8, 7.2],     look: [0, -0.05, 0.4], fov: 36, sx: -0.12 },
  // teardown: a slow walk round the car as it comes apart
  { p: 0.545, pos: [6.6, 3.6, 9.2],     look: [0, 1.1, 0], fov: 34, sx: 0.14 },
  { p: 0.645, pos: [8.2, 2.6, 5.8],     look: [0, 1.25, 0], fov: 34, sx: 0.14 },
  // the front wheel comes off its hub and stops in front of the lens, then rolls away
  { p: 0.7,   pos: hubAt(3.3, 0.22, 0.55), look: hubAt(1.0, 0.02, 0), abs: true, fov: 26, near: true, pf: 1.5 },
  { p: 0.745, pos: hubAt(3.2, 0.22, 0.45), look: hubAt(1.0, 0.02, 0), abs: true, fov: 26, near: true, pf: 1.5 },
  { p: 0.798, pos: hubAt(2.0, 0.2, 0.3),   look: hubAt(-0.1, 0, 0), abs: true, fov: 28, near: true, pf: 1.5 },
  // into the driver's seat
  { p: 0.838, pos: seatAt(0.5, 0.9, -1.3), look: seatAt(0, -0.05, 0.9), abs: true, fov: 50, near: true },
  { p: 0.885, pos: seatAt(0, 0.3, -0.42),  look: seatAt(0, -0.05, 0.9), abs: true, fov: 62, near: true },
  // back out for the snap and the close
  { p: 0.925, pos: [6.0, 1.9, 8.6],     look: [0, 0.05, 0], fov: 32 },
  { p: 1.0,   pos: [4.6, 1.2, 9.0],     look: [0, 0.05, 0], fov: 32, sx: -0.3 },
];
const _pa = V(), _pb = V(), _la = V(), _lb = V(), _look = V(), _a = V(), _b = V();
const arr = (v) => (typeof v === 'function' ? v() : v);
const keyPos = (k, out) => { const a = arr(k.pos); out.set(a[0], a[1], a[2]); return k.rel ? out.add(st.center) : out; };
const keyLook = (k, out) => { const a = arr(k.look); out.set(a[0], a[1], a[2]); return k.abs ? out : out.add(st.center); };
let shakeAmt = 0;
const phoneLift = (k) => k.my ?? (k.wide ? 0.04 : 0.12);
function applyCamera(p, time) {
  let i = 0;
  while (i < KEYS.length - 2 && p >= KEYS[i + 1].p) i++;
  const A = KEYS[i], B = KEYS[i + 1];
  const t = B.cut ? 0 : smooth(clamp01((p - A.p) / (B.p - A.p)));
  camera.position.lerpVectors(keyPos(A, _pa), keyPos(B, _pb), t);
  _look.lerpVectors(keyLook(A, _la), keyLook(B, _lb), t);
  const narrow = camera.aspect < 0.9;
  const stepBack = A.pf ?? (A.near ? 1 : A.wide ? 1.12 : 1.45);
  if (narrow && stepBack !== 1) camera.position.sub(_look).multiplyScalar(stepBack).add(_look);   // phones: step back
  if (!reduceMotion) {
    camera.position.x += Math.sin(time * 0.23) * 0.06 + (Math.random() - 0.5) * shakeAmt;
    camera.position.y += Math.sin(time * 0.31) * 0.03 + (Math.random() - 0.5) * shakeAmt;
  }
  if (camera.position.y < 0.12) camera.position.y = 0.12;
  camera.lookAt(_look);
  camera.fov = lerp(A.fov, B.fov, t) * (narrow && !A.wide ? 1.12 : 1);
  const w = window.innerWidth, h = window.innerHeight;
  const sx = narrow ? 0 : lerp(A.sx || 0, B.sx || 0, t);
  // phones: lift the picture so the caption underneath does not cover the car
  const my = narrow ? lerp(phoneLift(A), phoneLift(B), t) : 0;
  camera.setViewOffset(w, h, -sx * h, my * h, w, h);    // also applies the new fov
}

/* ================================================================== *
 *  Page UI
 * ================================================================== */
const caps = [...document.querySelectorAll('.cap')].map((el) => ({ el, from: +el.dataset.from, to: +el.dataset.to }));
const actNum = document.getElementById('actNum'), actName = document.getElementById('actName');
const railFill = document.getElementById('railFill'), cue = document.getElementById('cue');
const hud = document.getElementById('hud'), hudSpeed = document.getElementById('hudSpeed');
const hudBar = document.getElementById('hudBar'), hudDot = document.getElementById('hudDot');
const flashEl = document.getElementById('flash'), labelsEl = document.getElementById('labels');
const spacer = document.getElementById('spacer'), hudPath = document.querySelector('.hud__map path');
const railTicks = document.getElementById('railTicks');
ACTS.forEach(([p]) => { const i = document.createElement('i'); i.style.left = p * 100 + '%'; railTicks.appendChild(i); });

const LABELS = [
  ['canopy', 'Tinted canopy'], ['shell', 'Body shell'], ['tanks', 'Air tanks', 'red'], ['battery', 'Structural battery'],
  ['motor', 'Rear drive units'], ['brakes', 'Brakes'], ['fans', 'Suction fans'], ['thrusters', 'Cold-gas thrusters', 'red'],
].map(([key, text, tone]) => {
  const el = document.createElement('div');
  el.className = 'label' + (tone ? ' label--' + tone : '');
  el.textContent = text;
  labelsEl.appendChild(el);
  return { key, el };
});

let shownAct = -1;
function updateUi(p, tear) {
  for (const c of caps) c.el.classList.toggle('is-on', ready && p >= c.from && p < c.to);
  railFill.style.width = (p * 100).toFixed(2) + '%';
  cue.classList.toggle('is-hidden', p > 0.012);
  let a = 0;
  while (a < ACTS.length - 1 && p >= ACTS[a + 1][0]) a++;
  if (a !== shownAct) { shownAct = a; actNum.textContent = String(a + 1).padStart(2, '0'); actName.textContent = ACTS[a][1]; }

  const showLabels = car && tear > 0.92 && p > 0.555 && p < 0.652;
  const w = window.innerWidth, h = window.innerHeight;
  for (const l of LABELS) {
    const tg = car && car.labels[l.key];
    if (!tg) continue;
    _a.copy(tg.local); tg.obj.localToWorld(_a); _a.project(camera);
    l.el.style.transform = `translate(${((_a.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-_a.y * 0.5 + 0.5) * h).toFixed(1)}px) translateY(-50%)`;
    l.el.classList.toggle('is-on', !!showLabels && _a.z < 1);
  }

  const inCockpit = p > 0.828 && p < 0.888;
  hud.classList.toggle('is-on', inCockpit);
  if (inCockpit) {
    const t = seg(p, 0.828, 0.888);
    hudSpeed.textContent = String(Math.round(t * 248)).padStart(3, '0');
    hudBar.style.width = (40 + t * 60).toFixed(0) + '%';
    const q = hudPath.getPointAtLength(hudPath.getTotalLength() * t);
    hudDot.setAttribute('cx', q.x.toFixed(1)); hudDot.setAttribute('cy', q.y.toFixed(1));
  }
}

let lenis = null;
if (!instant) {
  import('https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.mjs')
    .then(({ default: Lenis }) => { lenis = new Lenis({ lerp: 0.075, wheelMultiplier: 0.85 }); if (!ready) lenis.stop(); })
    .catch(() => {});
}
document.getElementById('replay').addEventListener('click', () => {
  if (lenis) lenis.scrollTo(0, { duration: 2.4 }); else window.scrollTo({ top: 0, behavior: 'smooth' });
});
const scrollProgress = () => clamp01(window.scrollY / Math.max(1, spacer.offsetHeight - window.innerHeight));

/* ================================================================== *
 *  Loader: pressurising the tanks
 * ================================================================== */
const loaderEl = document.getElementById('loader'), cellsEl = document.getElementById('loadCells');
const loadPct = document.getElementById('loadPct'), loadStatus = document.getElementById('loadStatus');
const CELLS = 24;
for (let i = 0; i < CELLS; i++) cellsEl.appendChild(document.createElement('i'));
const LOAD_STATUS = ['Sealing tanks', 'Chilling the lines', 'Spinning up fans', 'Arming nozzles', 'Holding pressure'];
const load = { real: 0, shown: 0, vent: 0, loaded: false, failed: false, done: false, last: 0 };
let ready = false;
loaderEl.addEventListener('pointerdown', () => { load.vent = 1; });   // tap to vent: pressure dips, then recovers

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
  load.shown = instant ? load.real : load.shown + Math.max(0, Math.min((load.real - load.shown) * 5 * dt + 5 * dt, 80 * dt, load.real - load.shown));
  load.vent *= Math.pow(0.03, dt);
  const shownP = Math.max(0, load.shown - load.vent * 22);
  const lit = Math.round((shownP / 100) * CELLS);
  [...cellsEl.children].forEach((c, i) => { c.classList.toggle('is-on', i < lit); c.classList.toggle('is-hot', i < lit && i >= CELLS - 4); });
  loadPct.textContent = Math.round(shownP);
  if (!load.failed) loadStatus.textContent = LOAD_STATUS[Math.min(LOAD_STATUS.length - 1, Math.floor((load.shown / 100) * LOAD_STATUS.length))];
  if (load.loaded && load.shown >= 99.9) {
    load.done = true;
    loadStatus.textContent = 'Boost ready';
    loaderEl.classList.add('is-ready');
    setTimeout(begin, instant ? 0 : 450);
    return;
  }
  if (!load.failed) requestAnimationFrame(tickLoader);
}
requestAnimationFrame(tickLoader);

new GLTFLoader().load(
  MODEL_URL,
  (gltf) => {
    car = buildCar(gltf.scene, scene);
    // a small light for the wheel and brake close-ups
    const h = car.anchors.hub;
    detail.position.set(h.x + 3.4, 1.9, h.z + 2.4 + STOP_Z);
    detail.target.position.set(h.x + 0.5, h.y, h.z + STOP_Z);
    scene.add(detail, detail.target);
    if (INSPECT) setupInspect();
    renderer.compile(scene, camera);
    load.real = 100; load.loaded = true;
  },
  (xhr) => { load.real = Math.max(load.real, Math.min(99, (xhr.loaded / (xhr.total || MODEL_BYTES)) * 100)); },
  (err) => { console.error(err); load.failed = true; loadStatus.textContent = 'Could not load the 3D model'; }
);

function setupInspect() {
  layoutInspect(car);
  // a plain grey studio: hide the whole set, light everything evenly
  scene.children.forEach((c) => { c.visible = false; });
  car.root.visible = true;
  car.wheels.forEach((w) => { w.pivot.visible = false; });
  car.brakeGroup.visible = false;
  scene.background = new THREE.Color(0x6f747a);
  scene.environment = null;
  scene.fog = null;
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(6, 14, 10);
  scene.add(sun);
  bloom.enabled = false;
  document.querySelectorAll('.chrome, .rail, .cue, .fx, #story').forEach((el) => { el.style.display = 'none'; });
  car.parts.forEach((part) => {
    const el = document.createElement('div');
    el.className = 'label is-on';
    el.textContent = `${part.index} · L${part.layer}`;
    labelsEl.appendChild(el);
    part.el = el;
  });
}

/* ================================================================== *
 *  Resize
 * ================================================================== */
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(w, h);
}
window.addEventListener('resize', resize);

/* ================================================================== *
 *  Frame loop
 * ================================================================== */
const clock = new THREE.Clock();
let fixedP = (DEBUG && params.has('p')) ? +params.get('p') : null;
let p = fixedP ?? 0, lastP = p;
let simTime = 0, manual = false, debugEnergy = null;
let lastScroll = window.scrollY, scrollVel = 0, spin = 0, lastZ = null, lastS = null;
const _wp = V(), _wd = V(), _n = V();
const acc = { ground: 0, rear: 0 };
let perfN = 0, perfT = 0, perfLevel = 0;
const rnd = (a, b) => a + Math.random() * (b - a);
/** how many puffs to emit this frame: a steady rate while it lasts, plus extra for distance scrolled */
const quota = (key, perSecond, perProgress, dt, dp) => { acc[key] += perSecond * dt + perProgress * dp; const n = Math.floor(acc[key]); acc[key] -= n; return n; };

function emitEffects(dt, time, energy, pow) {
  const dp = Math.abs(p - lastP), k = 0.6 + energy * 0.7;
  const cz = st.center.z, cx = st.center.x;

  // floor jets: where each one meets the ground it throws up a rolling cloud
  if (pow.hover > 0.05) {
    const n = quota('ground', 48 * pow.hover * k, 1500, dt, dp);
    for (let i = 0; i < n; i++) {
      const { jet, nz } = car.jets.hover[(Math.random() * 4) | 0];
      _wp.copy(nz.p); car.root.localToWorld(_wp);
      _wd.copy(nz.d).applyQuaternion(car.root.quaternion);
      const reach = _wp.y / Math.max(0.25, -_wd.y);
      if (reach < 9.5) {
        const hx = _wp.x + _wd.x * reach, hz = _wp.z + _wd.z * reach;
        // thrown outwards along the ground: the cloud spreads wide and stays low, then billows up as it ages
        const a = Math.atan2(hz - cz, hx - cx) + rnd(-1.1, 1.1), sp = rnd(1.5, 6.8), sh = rnd(0.72, 1);
        const tall = Math.random() < 0.22;                       // a few puffs climb, giving the cloud its lumps
        smoke.spawn({ x: hx + rnd(-0.3, 0.3), y: 0.25, z: hz + rnd(-0.3, 0.3), vx: Math.cos(a) * sp, vy: tall ? rnd(1.2, 3) : rnd(0.05, 0.7), vz: Math.sin(a) * sp,
          life: rnd(3.4, 6.2), size: rnd(0.6, 1.0), grow: tall ? rnd(2.2, 3.4) : rnd(1.3, 2.7), alpha: rnd(0.68, 0.9), rise: tall ? rnd(0.3, 0.6) : rnd(0.04, 0.2), drag: rnd(0.8, 1.3),
          r: 0.9 * sh, g: 0.93 * sh, b: 0.97 * sh });
      }
      void jet;
    }
  }
  // rear thrusters on the sprint: a wall of vapour thrown back down the runway
  if (pow.rear > 0.05) {
    const n = quota('rear', 120 * pow.rear * k, 1500, dt, dp);
    for (let i = 0; i < n; i++) {
      const { nz } = car.jets.rear[(Math.random() * 4) | 0];
      _wp.copy(nz.p).addScaledVector(nz.d, rnd(0.6, 2.4)); car.root.localToWorld(_wp);
      smoke.spawn({ x: _wp.x + rnd(-0.2, 0.2), y: Math.max(0.3, _wp.y + rnd(-0.1, 0.3)), z: _wp.z, vx: rnd(-1.6, 1.6), vy: rnd(0.2, 1.4), vz: -rnd(4, 10),
        life: rnd(1.8, 3.2), size: rnd(0.5, 0.8), grow: rnd(2, 3.4), alpha: rnd(0.55, 0.78), rise: 0.3, drag: 1.5 });
    }
  }
  // touchdown: one hard ring of dust and vapour
  if ((lastP < T.hover[1]) !== (p < T.hover[1])) {
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2, sp = rnd(3.5, 9), sh = rnd(0.8, 1);
      smoke.spawn({ x: cx + Math.cos(a) * 1.2, y: 0.4, z: cz + Math.sin(a) * 2.2, vx: Math.cos(a) * sp, vy: rnd(0.3, 1.8), vz: Math.sin(a) * sp,
        life: rnd(4, 7), size: rnd(0.9, 1.4), grow: rnd(2.2, 4), alpha: rnd(0.68, 0.88), rise: rnd(0.12, 0.38), drag: rnd(0.9, 1.4),
        r: 0.9 * sh, g: 0.92 * sh, b: 0.95 * sh });
    }
  }
}

renderer.setAnimationLoop((now) => {
  if (manual) return;                      // the capture tool is stepping frames itself
  lenis?.raf(now);
  frame(Math.min(clock.getDelta(), 0.05));
});

function frame(dt) {
  simTime += dt;
  const time = simTime;

  // --- progress
  const sy = window.scrollY;
  scrollVel += ((sy - lastScroll) / Math.max(dt, 0.001) - scrollVel) * 0.15;
  lastScroll = sy;
  const energy = debugEnergy ?? Math.min(1, Math.abs(scrollVel) / 1800);   // how hard the user is scrolling
  lastP = p;
  p += ((fixedP ?? scrollProgress()) - p) * damp(7, dt);

  if (!car) { applyCamera(p, time); composer.render(); return; }
  if (INSPECT) { renderInspect(); return; }

  // --- car
  carState(p, time);
  car.root.position.copy(st.origin);
  car.root.quaternion.copy(st.quat);
  car.root.scale.set(1, 1 - st.squash * 0.035, 1);
  car.root.visible = ready;
  car.root.updateMatrixWorld(true);
  set.ledMat.uniforms.uPass.value = st.pass;

  // --- teardown: canopy, then shell, then lower body rise off the chassis; snap drops them back
  const tear = smooth(seg(p, ...T.teardown)) * (1 - Math.pow(seg(p, ...T.snap), 3));
  const cab = smooth(seg(p, 0.8, 0.835));   // for the cockpit shot the body settles back down and only the canopy stays off
  const lift = [0, 1.05 * smooth(seg(tear, 0.35, 0.9)) * (1 - cab), 1.95 * smooth(seg(tear, 0.15, 0.7)) * (1 - cab), 2.95 * smooth(seg(tear, 0, 0.5))];
  for (const part of car.parts) part.obj.position.set(part.base.x, part.base.y + lift[part.layer], part.base.z);
  car.core.visible = tear > 0.004 && cab < 0.995;

  // --- wheels
  const back = 1 - Math.pow(seg(p, ...T.snap), 3);
  const slide = 0.4 * smooth(seg(tear, 0.55, 1)) * (1 - cab);          // every wheel eases off its hub
  const heroOut = smooth(seg(p, ...T.wheelOut)) * back, heroRoll = smooth(seg(p, ...T.wheelRoll)) * back;
  const dz = lastZ === null ? 0 : st.center.z - lastZ, ds = lastS === null || p >= T.climb[1] ? 0 : st.s - lastS;
  lastZ = st.center.z; lastS = st.s;
  spin += (p < T.climb[1] ? -ds : p >= T.hover[1] ? dz : 0) / car.wheelR + (p >= T.climb[1] && p < T.hover[1] ? dt * 9 : 0);
  for (const w of car.wheels) {
    const x = w.base.x + w.side * slide + (w.hero ? w.side * heroOut * 0.62 : 0);
    const roll = w.hero ? heroRoll * 6.5 : 0;                          // the loose wheel rolls off down the runway
    w.pivot.position.set(x, w.base.y, w.base.z + roll);
    w.spinner.rotation.x = spin + roll / car.wheelR;
  }
  for (const f of car.fans) f.rotation.y += dt * (p < T.flight[0] ? 30 : 6);
  car.mats.fanRing.emissiveIntensity = tear * 0.9;

  // --- thrusters
  const flick = reduceMotion ? 1 : 0.86 + energy * 0.3;
  const pow = {
    roll: Math.pow(bump(seg(p, ...T.roll)), 0.55) * flick,
    hover: smooth(seg(p, T.flight[1] - 0.022, T.flight[1])) * (1 - smooth(seg(p, T.hover[1], T.hover[1] + 0.014))) * flick,
    nose: smooth(seg(p, T.hover[0] - 0.012, T.hover[0] + 0.006)) * (1 - smooth(seg(p, T.hover[0] + 0.022, T.hover[0] + 0.045))) * flick,
    rear: seg(p, T.sprint[0] - 0.006, T.sprint[0] + 0.004) * (1 - seg(p, T.sprint[1] - 0.014, T.sprint[1] - 0.002)) * flick,
  };
  for (const { jet, nz } of car.jets.hover) {
    _wp.copy(nz.p); car.root.localToWorld(_wp);
    _wd.copy(nz.d).applyQuaternion(car.root.quaternion);
    jet.userData.set(pow.hover, Math.min(9.5, Math.max(0.6, _wp.y / Math.max(0.25, -_wd.y))), time);
  }
  for (const { jet } of car.jets.roll) jet.userData.set(pow.roll, 2.7, time);
  for (const { jet } of car.jets.nose) jet.userData.set(pow.nose, 2.2, time);
  for (const { jet } of car.jets.rear) jet.userData.set(pow.rear, 3.4, time);
  const thrust = Math.max(pow.roll * 0.6, pow.hover, pow.rear, pow.nose * 0.5);
  if (ready && !reduceMotion) emitEffects(dt, time, energy, pow);
  smoke.update(dt, camera, time);
  car.mats.nozzle.emissiveIntensity += (thrust * 5 - car.mats.nozzle.emissiveIntensity) * damp(10, dt);
  car.thrustLight.intensity = pow.hover * 32 + pow.roll * 20 + pow.rear * 40;

  // --- lights
  set.follow.position.copy(st.center).add(_n.set(5.5, 11, 9));
  set.follow.target.position.copy(st.center);
  set.work.intensity = tear * 3 * (1 - cab * 0.55);
  detail.intensity = 2.1 * smooth(seg(p, 0.655, 0.7)) * (1 - smooth(seg(p, 0.8, 0.83)));
  const flash = bump(seg(p, ...T.flash)) * (1 - seg(p, ...T.flash));
  car.beam.intensity = (p < T.hover[1] ? 120 : p < T.brake[0] ? 60 : 14) + flash * 300;
  for (const m of car.mats.headlights) m.emissiveIntensity = 2.5 + flash * 14;
  for (const m of car.mats.tail) m.emissiveIntensity = 3.5 + pow.rear * 3;

  // --- impacts: camera shake + white flash
  const hit = bump(seg(p, 0.303, 0.33)) + bump(seg(p, 0.418, 0.448)) + bump(seg(p, 0.9, 0.925));
  shakeAmt = reduceMotion ? 0 : hit * (0.05 + energy * 0.1) + thrust * 0.01;
  flashEl.style.opacity = (Math.pow(bump(seg(p, 0.898, 0.918)), 2) * 0.5).toFixed(3);
  bloom.strength = 0.42 + thrust * 0.25 + flash * 0.7;

  applyCamera(p, time);
  updateUi(p, tear);
  composer.render();

  // --- keep it smooth on weaker devices
  if (ready && dt < 0.1 && !document.hidden) {
    perfN++; perfT += dt;
    if (perfN >= 90) {
      const fps = perfN / perfT; perfN = 0; perfT = 0;
      if (fps < 40 && perfLevel < 3) {
        perfLevel++;
        pixelRatio = Math.min(pixelRatio, perfLevel === 1 ? 1.5 : 1);
        if (perfLevel === 2) renderer.shadowMap.enabled = false;
        if (perfLevel === 3) bloom.enabled = false;
        resize();
      }
    }
  }
}

/* Developer capture (only with ?debug): step the simulation as if someone were scrolling,
 * and save a contact sheet of frames to .shots/ through the local dev server. */
if (DEBUG) {
  const grab = (w) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = Math.round((w * canvas.height) / canvas.width);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  };
  /** steps: [{ to, frames, label }] — p glides to `to` over `frames` simulated frames (60 per second), then that frame is kept */
  window.__rs.sheet = async (name, steps, { cols = 3, cell = 560, energy = 0.5, start = null } = {}) => {
    manual = true; debugEnergy = energy;
    if (start !== null) { fixedP = start; frame(1 / 60); }
    const rows = Math.ceil(steps.length / cols), ch = Math.round((cell * canvas.height) / canvas.width);
    const sheet = document.createElement('canvas');
    sheet.width = cols * cell; sheet.height = rows * ch;
    const g = sheet.getContext('2d');
    g.font = '15px monospace';
    steps.forEach((s, i) => {
      const from = fixedP ?? 0;
      for (let f = 1; f <= s.frames; f++) { fixedP = lerp(from, s.to, f / s.frames); frame(1 / 60); }
      const x = (i % cols) * cell, y = Math.floor(i / cols) * ch;
      g.drawImage(grab(cell), x, y);
      g.fillStyle = '#3f6'; g.fillText(`${s.label || ''} p=${s.to}`, x + 8, y + 18);
    });
    manual = false; debugEnergy = null;
    const blob = await new Promise((r) => sheet.toBlob(r, 'image/jpeg', 0.86));
    await fetch('/__shot?name=' + name, { method: 'POST', body: blob });
    return `${name}: ${steps.length} frames, smoke puffs alive ${smoke.liveCount}`;
  };
}

function renderInspect() {
  car.root.visible = true;
  car.root.position.set(0, 0, 0); car.root.quaternion.identity(); car.root.updateMatrixWorld(true);
  const side = params.get('inspect') === 'side';
  camera.position.set(side ? 26 : 0.01, side ? 12 : 34, side ? 34 : 9); camera.lookAt(0, 0, 8.5); camera.fov = 40; camera.updateProjectionMatrix();
  const w = window.innerWidth, h = window.innerHeight;
  for (const part of car.parts) {
    _a.copy(part.grid).setY(0).add(_b.set(0, 0, 2.3)).project(camera);
    part.el.style.transform = `translate(${((_a.x * 0.5 + 0.5) * w - 30).toFixed(0)}px, ${((-_a.y * 0.5 + 0.5) * h).toFixed(0)}px)`;
  }
  composer.render();
}
