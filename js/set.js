// The location: a night test site with one very tall concrete ramp.
import * as THREE from 'three';
import { V, canvasTexture, makeNoise, BeamSet } from './util.js';

/* ------------------------------------------------------------------ *
 *  Ramp profile: a quarter-circle off the ground, a vertical wall,
 *  then an overhang that curls 50° past vertical.
 * ------------------------------------------------------------------ */
export const RAMP = { R1: 10, H: 7.5, R2: 14, A: (50 * Math.PI) / 180, W: 3.3, ZB: -34 };
const L1 = (RAMP.R1 * Math.PI) / 2, L2 = RAMP.R2 * RAMP.A;
export const S_VERT = L1;                 // where the wall goes vertical
export const S_OVER = L1 + RAMP.H;        // where the overhang starts
export const S_LIP = L1 + RAMP.H + L2;    // the top edge

/** Point on the driving surface at distance s along it (s < 0 is the flat approach). */
export function rampPath(s, out = { pos: V(), fwd: V(), up: V() }) {
  const { R1, H, R2, ZB } = RAMP;
  if (s <= 0) { out.pos.set(0, 0, ZB - s); out.fwd.set(0, 0, -1); out.up.set(0, 1, 0); return out; }
  if (s > L1 && s <= L1 + H) { out.pos.set(0, R1 + (s - L1), ZB - R1); out.fwd.set(0, 1, 0); out.up.set(0, 0, 1); return out; }
  let th, cz, cy, R;
  if (s <= L1) { th = s / R1; cz = ZB; cy = R1; R = R1; }
  else { th = Math.PI / 2 + Math.min(s - L1 - H, L2) / R2; cz = ZB - R1 + R2; cy = R1 + H; R = R2; }
  const sn = Math.sin(th), cs = Math.cos(th);
  out.pos.set(0, cy - R * cs, cz - R * sn);
  out.fwd.set(0, sn, -cs);
  out.up.set(0, cs, sn);
  return out;
}

/* ------------------------------------------------------------------ *
 *  Textures
 * ------------------------------------------------------------------ */
function concreteTexture() {
  const noise = makeNoise(7);
  return canvasTexture(512, 4096, (g, W, Hh) => {
    // low-res mottling and water stains, scaled up
    const lw = 128, lh = 1024;
    const small = document.createElement('canvas'); small.width = lw; small.height = lh;
    const sg = small.getContext('2d'), img = sg.createImageData(lw, lh);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const blot = noise.fbm(x / 22, y / 22, 4), streak = noise.fbm(x / 4 + 40, y / 90, 3), fine = noise.n2(x * 0.9, y * 0.9);
      const edge = Math.min(1, Math.min(x, lw - x) / 10);
      const v = 112 + (blot - 0.5) * 78 + (streak - 0.5) * 52 + (fine - 0.5) * 16 - (1 - edge) * 24;
      const i = (y * lw + x) * 4;
      img.data[i] = v; img.data[i + 1] = v + 1; img.data[i + 2] = v + 3; img.data[i + 3] = 255;
    }
    sg.putImageData(img, 0, 0);
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, 0, 0, W, Hh);
    // formwork joints and tie holes
    const panels = 29;
    for (let i = 1; i < panels; i++) {
      const y = Math.round((i / panels) * Hh);
      g.fillStyle = 'rgba(40,42,45,0.5)'; g.fillRect(0, y, W, 3);
      g.fillStyle = 'rgba(210,212,214,0.18)'; g.fillRect(0, y + 3, W, 2);
      g.fillStyle = 'rgba(30,31,33,0.55)';
      for (const x of [70, 190, 322, 442]) { g.beginPath(); g.arc(x, y - 44, 4, 0, 7); g.fill(); }
    }
    g.fillStyle = 'rgba(40,42,45,0.4)'; g.fillRect(170, 0, 2, Hh); g.fillRect(340, 0, 2, Hh);
    // worn white centre line
    for (let y = 0; y < Hh; y += 6) {
      const wear = noise.n2(3.3, y / 37);
      g.fillStyle = `rgba(236,238,238,${0.62 + wear * 0.34})`;
      g.fillRect(248 + (noise.n2(9.1, y / 300) - 0.5) * 2, y, 16, 6);
    }
  });
}

function asphaltRoughness() {
  const noise = makeNoise(21);
  const t = canvasTexture(256, 256, (g, W) => {
    const img = g.createImageData(W, W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const v = 150 + noise.fbm(x / 30, y / 30, 4) * 90 + (noise.n2(x * 1.7, y * 1.7) - 0.5) * 30;
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(70, 70);
  return t;
}

/** Reflections for a night site: mostly black, with the floodlights, the red wall and a faint sky. */
export function buildEnvironment(renderer) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(80, 24, 12), new THREE.MeshBasicMaterial({ color: 0x020203, side: THREE.BackSide })));
  const panel = (w, h, k, pos, color = 0xffffff) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 0.6, 0); s.add(m);
    return m;
  };
  panel(22, 22, 0.55, [0, 26, 0]).rotation.set(Math.PI / 2, 0, 0);   // soft overhead: keeps the white paint readable
  panel(12, 3, 9, [-30, 5, -4]);                                     // floodlight bank
  panel(40, 0.5, 6, [-18, 0.6, 0], 0xff1a22);                        // the red wall
  panel(8, 4, 3.5, [26, 7, 12], 0xcfe2ff);                           // cool fill from the camera side
  panel(10, 1.2, 2.5, [0, 3, 30]);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.03).texture;
  pm.dispose();
  return tex;
}

/* ------------------------------------------------------------------ *
 *  Build everything
 * ------------------------------------------------------------------ */
export function buildSet(scene, renderer) {
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const glow = (hex, k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), fog: false });

  // --- ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 1, roughnessMap: asphaltRoughness(), metalness: 0, envMapIntensity: 0.35 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const apron = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.02, 13), new THREE.MeshStandardMaterial({ color: 0x232426, roughness: 0.95 }));
  apron.position.set(0, 0.022, RAMP.ZB + 5);
  apron.receiveShadow = true;
  scene.add(apron);

  // painted lines crossing the pad, as seen from the air
  const paint = new THREE.MeshStandardMaterial({ color: 0x8d8f90, roughness: 0.85 });
  for (const rot of [0.42, -0.42]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 150), paint);
    line.rotation.set(-Math.PI / 2, 0, rot); line.position.set(0, 0.012, -6);
    scene.add(line);
  }

  // --- the ramp
  const concreteMap = concreteTexture();
  concreteMap.anisotropy = maxAniso;
  const concrete = new THREE.MeshStandardMaterial({ map: concreteMap, bumpMap: concreteMap, bumpScale: 0.9, roughness: 0.93, metalness: 0, envMapIntensity: 0.3 });
  const plain = new THREE.MeshStandardMaterial({ color: 0x66686a, roughness: 0.95 });
  const N = 200, S0 = -1.4, TH = 0.4, W = RAMP.W, pt = { pos: V(), fwd: V(), up: V() };
  const facePos = [], faceUv = [], faceIdx = [], bodyPos = [], bodyIdx = [];
  for (let i = 0; i <= N; i++) {
    const s = S0 + ((S_LIP - S0) * i) / N, v = i / N;
    rampPath(s, pt);
    const y = Math.max(pt.pos.y, 0.02), z = pt.pos.z;
    const oy = Math.max(y - pt.up.y * TH, 0), oz = z - pt.up.z * TH;
    facePos.push(-W / 2, y, z, W / 2, y, z);
    faceUv.push(0, v, 1, v);
    bodyPos.push(-W / 2, oy, oz, W / 2, oy, oz,          // back skin
      -W / 2, y, z, -W / 2, oy, oz,                      // left edge
      W / 2, y, z, W / 2, oy, oz);                       // right edge
    if (i < N) {
      const a = i * 2, b = a + 2;
      faceIdx.push(a, a + 1, b, a + 1, b + 1, b);        // wound so the driving surface faces the car
      const o = i * 6, n = o + 6;
      bodyIdx.push(o, o + 1, n, o + 1, n + 1, n, o + 2, o + 3, n + 2, o + 3, n + 3, n + 2, o + 4, n + 4, o + 5, o + 5, n + 4, n + 5);
    }
  }
  const faceGeo = new THREE.BufferGeometry();
  faceGeo.setAttribute('position', new THREE.Float32BufferAttribute(facePos, 3));
  faceGeo.setAttribute('uv', new THREE.Float32BufferAttribute(faceUv, 2));
  faceGeo.setIndex(faceIdx); faceGeo.computeVertexNormals();
  const face = new THREE.Mesh(faceGeo, concrete);
  face.receiveShadow = true;
  scene.add(face);
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(bodyPos, 3));
  bodyGeo.setIndex(bodyIdx); bodyGeo.computeVertexNormals();
  plain.side = THREE.DoubleSide;
  scene.add(new THREE.Mesh(bodyGeo, plain));

  // LED edge strips: red ahead of the car, white where it has already been
  const ledMat = new THREE.ShaderMaterial({
    uniforms: { uPass: { value: -1 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform float uPass; varying vec2 vUv;
      void main(){ float done = smoothstep(uPass + 0.015, uPass - 0.015, vUv.x);
        vec3 c = mix(vec3(1.0, 0.05, 0.08) * 2.4, vec3(0.85, 0.93, 1.0) * 1.25, done);
        gl_FragColor = vec4(c, 1.0); }`,
  });
  for (const x of [-W / 2 - 0.03, W / 2 + 0.03]) {
    const pts = [];
    for (let i = 0; i <= 90; i++) { rampPath((S_LIP * i) / 90, pt); pts.push(V(x, Math.max(pt.pos.y, 0.02) + pt.up.y * 0.05, pt.pos.z + pt.up.z * 0.05)); }
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 260, 0.032, 6), ledMat));
  }
  for (const sx of [-1, 1]) {            // red bars on the ground either side of the base
    const bar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.06, 0.06), glow(0xff1218, 2.2));
    bar.position.set(sx * (W / 2 + 2.6), 0.12, RAMP.ZB - 2.4);
    scene.add(bar);
  }

  // --- steel truss hugging the back of the ramp
  const beams = new BeamSet();
  const nodes = [];
  for (let s = 1.2; s <= S_LIP + 0.01; s += 1.72) {
    rampPath(Math.min(s, S_LIP), pt);
    const inner = (x) => V(x, Math.max(pt.pos.y - pt.up.y * 0.5, 0), pt.pos.z - pt.up.z * 0.5);
    const outer = (x) => V(x, Math.max(pt.pos.y - pt.up.y * 2.6, 0), pt.pos.z - pt.up.z * 2.6);
    nodes.push({ iL: inner(-1.45), iR: inner(1.45), oL: outer(-1.75), oR: outer(1.75) });
  }
  nodes.forEach((n, i) => {
    beams.add(n.iL, n.oL, 0.08).add(n.iR, n.oR, 0.08).add(n.oL, n.oR, 0.08).add(n.iL, n.iR, 0.07);
    const m = nodes[i + 1];
    if (!m) return;
    beams.add(n.iL, m.iL, 0.11).add(n.iR, m.iR, 0.11).add(n.oL, m.oL, 0.11).add(n.oR, m.oR, 0.11);
    if (i % 2) beams.add(n.iL, m.oL, 0.06).add(n.iR, m.oR, 0.06).add(n.oL, m.oR, 0.06);
    else beams.add(n.oL, m.iL, 0.06).add(n.oR, m.iR, 0.06).add(n.oR, m.oL, 0.06);
  });
  // back-stays holding up the overhang
  const zw = RAMP.ZB - RAMP.R1;
  for (const [k, gz] of [[0.42, zw - 9], [0.62, zw - 13], [0.86, zw - 17]]) {
    const n = nodes[Math.round(k * (nodes.length - 1))];
    for (const side of ['oL', 'oR']) beams.add(n[side], V(n[side].x * 1.6, 0, gz), 0.1);
    beams.add(V(-2.8, 0, gz), V(2.8, 0, gz), 0.08);
  }
  const steel = new THREE.MeshStandardMaterial({ color: 0x5d6168, roughness: 0.55, metalness: 0.7, envMapIntensity: 0.5 });
  scene.add(beams.build(steel));

  // --- site dressing: the red wall, marker lights, floodlight banks, drones, far lights
  const STRIP_X = -13;
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 66), glow(0xff1016, 1.5));
  strip.position.set(STRIP_X, 0.3, -6);
  scene.add(strip);
  const stripGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 70),
    new THREE.MeshBasicMaterial({
      map: canvasTexture(64, 4, (g) => { const gr = g.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, 'rgba(255,20,24,0)'); gr.addColorStop(0.5, 'rgba(255,20,24,0.1)'); gr.addColorStop(1, 'rgba(255,20,24,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 4); }),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    })
  );
  stripGlow.rotation.x = -Math.PI / 2; stripGlow.position.set(STRIP_X, 0.015, -6);
  scene.add(stripGlow);

  const dot = new THREE.SphereGeometry(1, 10, 8), mx = new THREE.Matrix4();
  const place = (list, material) => {
    const im = new THREE.InstancedMesh(dot, material, list.length);
    list.forEach(([x, y, z, r], i) => { mx.makeScale(r, r, r).setPosition(x, y, z); im.setMatrixAt(i, mx); });
    scene.add(im);
  };
  const markers = [];
  for (let z = -38; z <= 26; z += 2.2) markers.push([STRIP_X - 1.6, 0.55, z, 0.055]);
  place(markers, glow(0xffffff, 5));
  const floods = [];
  for (const [bx, bz, n] of [[-46, -8, 9], [-60, 26, 7], [58, -62, 5]]) {
    for (let i = 0; i < n; i++) for (const y of [2.1, 3.0]) floods.push([bx, y, bz + (i - n / 2) * 1.05, 0.2]);
  }
  place(floods, glow(0xeef4ff, 16));
  const drones = [];
  for (const [x, y, z] of [[-34, 27, -46], [22, 36, -80], [-70, 31, 6], [44, 24, -20]]) for (let i = 0; i < 4; i++) drones.push([x + i * 0.7, y, z, 0.1]);
  place(drones, glow(0xffffff, 8));
  const far = [], noise = makeNoise(5);
  for (let i = 0; i < 150; i++) { const a = noise.rnd() * Math.PI * 2, r = 170 + noise.rnd() * 220; far.push(Math.cos(a) * r, 0.4 + noise.rnd() * 3.5, Math.sin(a) * r); }
  const farGeo = new THREE.BufferGeometry();
  farGeo.setAttribute('position', new THREE.Float32BufferAttribute(far, 3));
  scene.add(new THREE.Points(farGeo, new THREE.PointsMaterial({ color: new THREE.Color(0xffe9c8).multiplyScalar(1.6), size: 2, sizeAttenuation: false, fog: false })));

  /* ---------------------------------------------------------------- *
   *  Lighting
   * ---------------------------------------------------------------- */
  const spot = (hex, intensity, pos, target, angle, penumbra = 0.7, decay = 0) => {
    const l = new THREE.SpotLight(hex, intensity, 0, angle, penumbra, decay);
    l.position.copy(pos); l.target.position.copy(target);
    scene.add(l, l.target);
    return l;
  };
  scene.add(new THREE.HemisphereLight(0x1b2433, 0x000000, 0.4));
  // the ramp is the one brightly lit object on site
  const rampWash = spot(0xf2f6ff, 2.0, V(15, 5, -13), V(0, 14.5, zw), 0.56, 0.5);
  // a spot that follows the car and throws its shadow
  const follow = spot(0xffffff, 1.6, V(6, 12, 10), V(0, 0, 0), 0.34, 1);
  follow.castShadow = true;
  follow.shadow.mapSize.set(2048, 2048);
  follow.shadow.camera.near = 6; follow.shadow.camera.far = 60;
  follow.shadow.bias = -0.0006; follow.shadow.normalBias = 0.03;
  // floodlight bank: one wide light rims the car and back-lights the smoke along the whole run.
  // (every light costs on every pixel, so the scene keeps as few as it can; the red wall's glow
  //  on the car comes from the reflection map instead of real lights)
  spot(0xe6efff, 1.4, V(-52, 5, 6), V(0, 0.8, -10), 0.62, 0.8);
  // neutral work light for the teardown (off until needed)
  const work = spot(0xffffff, 0, V(4.5, 7.5, 8.5), V(0, 0.7, 1.2), 0.62, 0.9);

  return { ledMat, follow, work, rampWash, stripX: STRIP_X };
}
