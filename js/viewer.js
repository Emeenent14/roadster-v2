// js/viewer.js — full-screen interactive 3D viewer.
// It builds the same car as the story (high-detail body, detailed wheels, chassis hardware,
// thrusters) in its own clean studio, and pauses the page's scene while it is open.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildCar, mountWheels, NOZZLES } from './car.js';

const MODEL_URL = 'models/roadster-hd.glb?v=1';
const WHEEL_URL = 'models/wheel.glb?v=1';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let active = false, ready = false, loading = null;
let renderer, scene, camera, controls, car, clock;
let tween = null, activeHot = null;
let vt = 0;                                              // viewer time in seconds (steps with the frames, so a video render stays in sync)
const state = { chassis: 0, canopy: 0, thrust: 0 };      // targets (0/1)
const shown = { chassis: 0, canopy: 0, thrust: 0 };      // eased values actually displayed
let paints = [];                                         // body paint materials the swatches recolour

/* ============ Elements ============ */
const $ = (id) => document.getElementById(id);
const viewer = $('viewer'), canvas = $('viewerCanvas');
const colorPicker = $('colorPicker');
const btn = { chassis: $('toggleTeardown'), thrust: $('toggleThrust'), spin: $('autoRotate'), reset: $('resetView') };
const hotWrap = $('viewerHotspots'), info = $('viewerInfo'), infoTitle = $('viewerInfoTitle'), infoText = $('viewerInfoText');
const paintName = $('viewerPaint');

/* ============ Hotspots: a point on the car, and how the camera frames it ============ */
// at: car-space point (x right, y up, z forward). az/el/dist: camera orbit around it. Flags switch views on.
const HOTSPOTS = [
  { id: 'nose', title: 'Hidden Aero', text: 'No visible headlights and no wings bolted on. One light bar runs the full width of the nose; everything that moves air sits flush with the body.', at: () => [0, 0.52, car.dim.z / 2 - 0.05], az: 0.35, el: 0.12, dist: 3.4 },
  { id: 'wheel', title: 'Wheels', text: 'Thin spokes and very little mass. Less weight to spin up means the car answers sooner.', at: () => car.anchors.hub.toArray(), az: 1.25, el: 0.1, dist: 2.3, normal: [1, 0, 0] },
  { id: 'cockpit', title: 'Cockpit', text: 'A yoke, a fixed seat and only the information the driver needs. The canopy lifts to show it.', at: () => car.anchors.cockpit.toArray(), az: 0.5, el: 0.62, dist: 3.2, canopy: 1, normal: [0, 1, 0] },
  { id: 'rear', title: 'Rear Thrusters', text: 'Cold-gas thrusters behind the car add to the launch. Here they are fired for you.', at: () => [0, 0.45, -car.dim.z / 2], az: Math.PI - 0.45, el: 0.14, dist: 4.2, thrust: 1, normal: [0, 0, -1] },
  { id: 'chassis', title: 'Chassis', text: 'Under the body: a battery, three motors, two air tanks for the thrusters and suction fans in the floor. (Illustrative.)', at: () => [car.dim.x / 2 - 0.05, 0.3, -0.55], look: () => [0, 0.55, 0], az: 0.8, el: 0.42, dist: 6.6, chassis: 1, normal: [1, 0, 0] },
];

/* ============ Setup ============ */
function init() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0c);
  scene.fog = new THREE.Fog(0x0a0a0c, 18, 40);

  camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.minDistance = 1.8;
  controls.maxDistance = 16;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.8;
  controls.autoRotateSpeed = 1.2;
  controls.addEventListener('start', () => { tween = null; if (activeHot) selectHot(null, false); });
  clock = new THREE.Clock();

  buildLighting();
  buildFloor();
  setDefaultView(true);
}

function buildLighting() {
  scene.add(new THREE.HemisphereLight(0x2a3040, 0x080808, 0.6));
  const key = new THREE.SpotLight(0xfff5e8, 3.5, 0, 0.5, 0.7, 0);
  key.position.set(8, 10, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const fill = new THREE.SpotLight(0xc8d8ff, 1.5, 0, 0.6, 0.8, 0);
  fill.position.set(-7, 6, 3);
  scene.add(fill, fill.target);
  const rim = new THREE.SpotLight(0xffffff, 2.0, 0, 0.5, 0.6, 0);
  rim.position.set(-2, 8, -8);
  scene.add(rim, rim.target);

  // studio reflections: a long overhead softbox and two side strips that draw lines along the body
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ color: 0x111115, side: THREE.BackSide })));
  const panel = (w, h, k, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 1, 0); env.add(m);
    return m;
  };
  panel(6, 20, 1.6, [0, 20, 0]).rotation.set(Math.PI / 2, 0, 0);
  panel(20, 1.4, 2.4, [15, 4, 0]);
  panel(20, 1.4, 1.4, [-15, 4, 0]);
  panel(10, 5, 0.6, [0, 6, 18]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
}

function buildFloor() {
  const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 64), new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.85, metalness: 0.1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const ring = new THREE.Mesh(new THREE.RingGeometry(11.8, 12, 64), new THREE.MeshBasicMaterial({ color: 0x222228 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.005;
  scene.add(ring);
}

/* ============ Load the car (the same build the story uses) ============ */
function loadCar() {
  if (loading) return loading;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loading = Promise.all([loader.loadAsync(MODEL_URL), loader.loadAsync(WHEEL_URL)]).then(([carFile, wheelFile]) => {
    car = buildCar(carFile.scene, scene);
    mountWheels(car, wheelFile.scene);
    car.root.updateMatrixWorld(true);
    car.beam.intensity = 25;
    // paint: the white clear-coated body panels (shared materials, so recolouring one recolours all)
    const set = new Set();
    for (const p of car.parts) {
      const m = p.obj.material;
      if (m.isMeshPhysicalMaterial && !m.transparent && m.color.r > 0.5) set.add(m);
    }
    paints = [...set];
    buildHotspots();
    ready = true;
    viewer.classList.add('is-ready');
  }).catch((err) => {
    console.error(err);
    infoTitle.textContent = 'Could not load the 3D model';
    infoText.textContent = '';
    info.hidden = false;
  });
  return loading;
}

/* ============ Hotspots ============ */
function buildHotspots() {
  for (const h of HOTSPOTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'viewer__hotspot';
    b.setAttribute('aria-label', h.title);
    b._hot = h;
    b.addEventListener('click', () => selectHot(activeHot === h ? null : h));
    hotWrap.appendChild(b);
  }
}
const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3();
function updateHotspots() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  for (const b of hotWrap.children) {
    const hs = b._hot;
    _p.fromArray(hs.at());
    car.root.localToWorld(_p);
    // hide dots on the far side of the car
    _n.fromArray(hs.normal || [Math.sign(_p.x) || 0, 0, Math.sign(_p.z)]).normalize();
    const facing = _n.dot(_c.copy(camera.position).sub(_p).normalize());
    _p.project(camera);
    const hidden = _p.z > 1 || facing < 0.05 || (activeHot && activeHot !== hs) || shown.chassis > 0.5 && hs.id !== 'chassis' && !activeHot;
    b.classList.toggle('is-hidden', !!hidden);
    b.classList.toggle('is-active', activeHot === hs);
    b.style.transform = `translate(${((_p.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-_p.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
  }
}
function orbitPos(target, az, el, dist) {
  const k = camera.aspect < 0.9 ? 1.75 : 1;                     // phones: step back (with a wider lens, see resize)
  return new THREE.Vector3(
    target.x + dist * k * Math.sin(az) * Math.cos(el),
    target.y + dist * k * Math.sin(el),
    target.z + dist * k * Math.cos(az) * Math.cos(el)
  );
}
function flyTo(pos, target, ms = 1300) {
  tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, start: vt * 1000, ms: reduceMotion ? 1 : ms };
}
function selectHot(h, fly = true) {
  activeHot = h;
  if (!h) { info.hidden = true; return; }
  infoTitle.textContent = h.title;
  infoText.textContent = h.text;
  info.hidden = false;
  setToggle('canopy', h.canopy ? 1 : 0);
  setToggle('chassis', h.chassis ? 1 : 0);
  setToggle('thrust', h.thrust ? 1 : 0);
  if (fly) {
    const t = new THREE.Vector3().fromArray((h.look || h.at)());
    car.root.localToWorld(t);
    flyTo(orbitPos(t, h.az, h.el, h.dist), t);
  }
}

/* ============ Actions ============ */
function setToggle(name, on) {
  state[name] = on ? 1 : 0;
  if (!btn[name]) return;                 // the canopy has no button: only the cockpit hotspot lifts it
  btn[name].classList.toggle('is-active', !!on);
  btn[name].setAttribute('aria-pressed', on ? 'true' : 'false');
}
function setPaint(swatch) {
  colorPicker.querySelectorAll('.viewer__swatch').forEach((s) => s.classList.toggle('is-active', s === swatch));
  if (paintName) paintName.textContent = swatch.title;
  const ano = swatch.dataset.finish === 'ano';     // satin anodised metal; the others are glossy clear-coated paint
  for (const m of paints) {
    m.userData.target = new THREE.Color(swatch.dataset.color);
    m.roughness = ano ? 0.44 : 0.4;
    m.metalness = ano ? 0.45 : 0.08;
    m.clearcoat = ano ? 0.3 : 0.85;
    m.clearcoatRoughness = ano ? 0.35 : 0.2;
  }
}
function setDefaultView(instant = false) {
  const target = new THREE.Vector3(0, 0.62, 0);
  const pos = orbitPos(target, 0.72, 0.2, 7.6);
  if (instant) { camera.position.copy(pos); controls.target.copy(target); controls.update(); }
  else flyTo(pos, target);
}
function resetAll() {
  selectHot(null, false);
  setToggle('canopy', 0); setToggle('chassis', 0); setToggle('thrust', 0);
  controls.autoRotate = false;
  btn.spin.classList.remove('is-active');
  setPaint(colorPicker.querySelector('.viewer__swatch'));
  setDefaultView();
}

/* ============ Animation ============ */
const ease = (t) => t * t * (3 - 2 * t);
const seg = (v, a, b) => Math.min(1, Math.max(0, (v - a) / (b - a)));
const _wp = new THREE.Vector3(), _wd = new THREE.Vector3(), _tw0 = new THREE.Vector3(), _tw1 = new THREE.Vector3();
function frame(fixedDt) {
  if (!active) return;
  const dt = fixedDt ?? Math.min(clock.getDelta(), 0.05);
  vt += dt;
  const time = vt;
  const k = reduceMotion ? 1 : 1 - Math.exp(-dt * 4);
  for (const key in shown) shown[key] += (state[key] - shown[key]) * k;

  if (tween) {
    const t = ease(Math.min(1, (vt * 1000 - tween.start) / tween.ms));
    // swing round the car rather than straight through it: blend the direction and the distance separately
    controls.target.lerpVectors(tween.t0, tween.t1, t);
    const d0 = _tw0.subVectors(tween.p0, tween.t0), d1 = _tw1.subVectors(tween.p1, tween.t1);
    const len = d0.length() + (d1.length() - d0.length()) * t;
    camera.position.copy(d0.normalize().lerp(d1.normalize(), t).normalize().multiplyScalar(len)).add(controls.target);
    if (t >= 1) tween = null;
  }
  controls.update(dt);

  if (car) {
    // chassis: canopy, then shell, then lower body rise off the rolling chassis (same as the story)
    const c = ease(shown.chassis), canopyLift = 0.75 * ease(shown.canopy) * (1 - c);
    const lift = [0, 1.05 * ease(seg(c, 0.35, 0.9)), 1.95 * ease(seg(c, 0.15, 0.7)), 2.95 * ease(seg(c, 0, 0.5)) + canopyLift];
    for (const part of car.parts) part.obj.position.set(part.base.x, part.base.y + lift[part.layer], part.base.z);
    car.core.visible = c > 0.004;
    const slide = 0.4 * ease(seg(c, 0.55, 1));
    for (const w of car.wheels) w.pivot.position.set(w.base.x + w.side * slide, w.base.y, w.base.z);
    for (const f of car.fans) f.rotation.y += dt * 6;
    car.mats.fanRing.emissiveIntensity = c * 0.9;

    // thrusters: rear and side jets, the floor jets sit right on the ground here so they stay short
    const p = shown.thrust * (reduceMotion ? 1 : 0.9 + 0.1 * Math.sin(time * 40));
    for (const { jet } of car.jets.rear) jet.userData.set(p, 3.0, time);
    for (const { jet, nz } of car.jets.hover) {
      _wp.copy(nz.p); car.root.localToWorld(_wp);
      _wd.copy(nz.d).applyQuaternion(car.root.quaternion);
      jet.userData.set(p * 0.7, Math.max(0.15, _wp.y / Math.max(0.25, -_wd.y)), time);
    }
    car.mats.nozzle.emissiveIntensity = shown.thrust * 5;
    car.thrustLight.intensity = shown.thrust * 18;
    for (const m of car.mats.tail) m.emissiveIntensity = 3.5 + shown.thrust * 2;
    for (const m of paints) if (m.userData.target) m.color.lerp(m.userData.target, k);

    car.root.updateMatrixWorld(true);
    updateHotspots();
  }
  renderer.render(scene, camera);
}

/* ============ Open / close ============ */
function resize() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  // a tall phone screen sees very little side to side: use a wider lens and allow zooming further out
  const narrow = camera.aspect < 0.9;
  camera.fov = narrow ? 46 : 35;
  controls.maxDistance = narrow ? 28 : 16;
  // shift the picture up so the car sits above the control panel (more on short or narrow screens)
  const lift = w < 700 ? 0.2 : h < 700 ? 0.17 : 0.1;
  camera.setViewOffset(w, h, 0, lift * h, w, h);
  camera.updateProjectionMatrix();
}
function open() {
  if (active) return;
  if (!renderer) init();
  active = true;
  viewer.classList.add('is-open');
  viewer.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('is-viewer');
  window.dispatchEvent(new CustomEvent('viewer:open'));     // the page pauses its own scene and scrolling
  resize();
  setDefaultView(true);
  clock.getDelta();
  renderer.setAnimationLoop(() => frame());   // (not frame itself: the loop passes a timestamp)
  loadCar();
  $('viewerClose').focus({ preventScroll: true });
}
function close() {
  if (!active) return;
  active = false;
  renderer.setAnimationLoop(null);
  viewer.classList.remove('is-open');
  viewer.setAttribute('aria-hidden', 'true');
  document.documentElement.classList.remove('is-viewer');
  window.dispatchEvent(new CustomEvent('viewer:close'));
}

/* ============ Events ============ */
document.querySelectorAll('[data-open-viewer]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); open(); }));
$('viewerClose').addEventListener('click', close);
colorPicker.addEventListener('click', (e) => { const s = e.target.closest('.viewer__swatch'); if (s) setPaint(s); });
btn.chassis.addEventListener('click', () => {
  setToggle('chassis', !state.chassis);
  if (activeHot) selectHot(null, false);
  // step back so the lifted body stays in frame, or return to the normal view
  if (state.chassis) { const t = new THREE.Vector3(0, 1.45, 0); flyTo(orbitPos(t, 0.8, 0.32, 9.6), t); }
  else setDefaultView();
});
btn.thrust.addEventListener('click', () => setToggle('thrust', !state.thrust));
btn.spin.addEventListener('click', () => { controls.autoRotate = !controls.autoRotate; btn.spin.classList.toggle('is-active', controls.autoRotate); });
btn.reset.addEventListener('click', resetAll);
window.addEventListener('resize', resize);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) close(); });
// warm the model cache once the page is idle, so the viewer opens quickly
if ('requestIdleCallback' in window) requestIdleCallback(() => fetch(MODEL_URL).catch(() => {}), { timeout: 8000 });
if (new URLSearchParams(location.search).has('viewer')) open();

/* ============ Hooks for the video render (js/render.js) ============ */
// The render opens the viewer the way a visitor does (a click), then takes over its clock:
// from then on nothing moves until step() is called with a fixed time step.
export const viewerApi = {
  get canvas() { return canvas; },
  get open() { return active; },
  get ready() { return ready; },
  takeOver(pixelRatio) { renderer.setAnimationLoop(null); renderer.setPixelRatio(pixelRatio); renderer.setSize(window.innerWidth, window.innerHeight); },
  step(dt) { frame(dt); },
};
