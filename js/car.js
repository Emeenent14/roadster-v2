// The car: materials, wheels, liftable body layers, the rolling chassis under them, and thrusters.
import * as THREE from 'three';
import { V, canvasTexture } from './util.js';
import { createJet } from './fx.js';

export const CAR_LENGTH = 4.6;   // world units
export const CAR_H = 0.62;       // height of the car's centre above its wheels

const boxOf = (o) => new THREE.Box3().setFromObject(o);

// Thruster positions in car space (x right, y up, z forward) and the way each one blows
const N = (p, d) => ({ p: V(...p), d: V(...d).normalize() });
export const NOZZLES = {
  // these four match the nozzle cylinders the model already has under its floor
  hover: [N([0.84, 0.14, 0.8], [0.1, -1, 0.06]), N([-0.84, 0.14, 0.8], [-0.1, -1, 0.06]), N([0.84, 0.14, -0.88], [0.1, -1, -0.06]), N([-0.84, 0.14, -0.88], [-0.1, -1, -0.06])],
  roll: [N([1.0, 0.5, 0.9], [0.45, 1, 0.1]), N([-1.0, 0.34, -0.9], [-0.45, -1, -0.1])],
  rear: [-0.62, -0.28, 0.28, 0.62].map((x) => N([x, 0.42, -2.27], [0, 0, -1])),
  nose: [N([0.5, 0.32, 2.18], [0.25, -0.05, 1])],
};

/* ------------------------------------------------------------------ *
 *  Materials for the downloaded model, picked by the names it shipped with
 * ------------------------------------------------------------------ */
function materialFor(m, mats) {
  const n = (m.name || '').toLowerCase();
  const lum = m.color ? m.color.r * 0.3 + m.color.g * 0.6 + m.color.b * 0.1 : 1;
  if (/glass/.test(n)) {
    // dark tinted canopy; the gold only shows in its reflections
    return new THREE.MeshPhysicalMaterial({
      name: m.name, color: 0x070605, roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03,
      specularColor: new THREE.Color(0xffc27a), specularIntensity: 1, envMapIntensity: 2.4,
      transparent: true, opacity: 0.975, side: THREE.DoubleSide,
    });
  }
  if (/lightr/.test(n)) { const x = new THREE.MeshStandardMaterial({ name: m.name, color: 0x1a0000, emissive: 0xff1118, emissiveIntensity: 3.5 }); mats.tail.push(x); return x; }
  if (/lightw/.test(n)) { const x = new THREE.MeshStandardMaterial({ name: m.name, color: 0x101214, emissive: 0xe4f1ff, emissiveIntensity: 2.5 }); mats.headlights.push(x); return x; }
  if (/slalights/.test(n)) return new THREE.MeshStandardMaterial({ name: m.name, color: 0x15171a, roughness: 0.5, metalness: 0.4 });
  if (/cylinder008baseblack21$|cylinder008baseblack21mtl|meshescoloured/.test(n)) return new THREE.MeshStandardMaterial({ name: m.name, color: 0x6f747a, roughness: 0.36, metalness: 1 }); // floor nozzles, hubs
  if (/tire/.test(n)) return new THREE.MeshStandardMaterial({ name: m.name, color: 0x060606, roughness: 0.92, metalness: 0 });
  if (/object31/.test(n)) return new THREE.MeshStandardMaterial({ name: m.name, color: 0xb9bec4, roughness: 0.36, metalness: 0.9, envMapIntensity: 1.5 }); // rims
  if (/steering/.test(n)) return new THREE.MeshStandardMaterial({ name: m.name, color: 0x141517, roughness: 0.72, metalness: 0.1 });
  if (/interior/.test(n)) return new THREE.MeshStandardMaterial({ name: m.name, color: 0xdcdcdb, roughness: 0.86, metalness: 0 });               // seats
  if (lum > 0.5) {
    // white body: satin coating under a thin clear coat
    return new THREE.MeshPhysicalMaterial({ name: m.name, color: 0xeff0f1, roughness: 0.4, metalness: 0.08, clearcoat: 0.85, clearcoatRoughness: 0.2, envMapIntensity: 1.1, side: THREE.DoubleSide });
  }
  return new THREE.MeshPhysicalMaterial({ name: m.name, color: 0x090a0b, roughness: 0.52, metalness: 0.3, clearcoat: 0.45, clearcoatRoughness: 0.35, side: THREE.DoubleSide });
}

/** Which layer a body piece belongs to when the car is taken apart: 3 canopy, 2 white shell, 1 dark lower body, 0 stays on the chassis */
function layerFor(srcName) {
  const n = srcName.toLowerCase();
  if (/glass/.test(n)) return 3;
  if (/base021|lightw|lightr/.test(n)) return 2;
  if (/baseblack02|baseblack03|baseblack221|object21|object01/.test(n)) return 1;
  return 0;
}

/* ------------------------------------------------------------------ *
 *  Rig
 * ------------------------------------------------------------------ */
export function buildCar(model, scene) {
  const root = new THREE.Group();          // moved by the story
  scene.add(root);
  const car = {
    root, wheels: [], parts: [], fans: [], labels: {}, jets: {}, wheelR: 0.34, dim: V(),
    mats: { headlights: [], tail: [], nozzle: null, fanRing: null },
    anchors: { cockpit: V(0, 0.75, 0.2), hub: V(0.9, 0.35, 1.35) },
    core: new THREE.Group(),               // chassis hardware that only shows once the body is lifted
  };
  const fix = new THREE.Group();
  fix.add(model); root.add(fix);
  root.updateMatrixWorld(true);

  // scale to a known length, point the nose down +Z (away from the red tail light), centre, sit on the floor
  let box = boxOf(model);
  const sz = box.getSize(V());
  fix.scale.setScalar(CAR_LENGTH / Math.max(sz.x, sz.z));
  fix.updateMatrixWorld(true);
  let tail = null;
  model.traverse((o) => { if (o.isMesh && /lightr/i.test(o.material.name)) tail = o; });
  if (tail) {
    const rear = boxOf(tail).getCenter(V()).sub(boxOf(model).getCenter(V()));
    fix.rotation.y = -Math.atan2(-rear.x, -rear.z);
    fix.updateMatrixWorld(true);
  }
  box = boxOf(model);
  const c = box.getCenter(V());
  fix.position.set(-c.x, -box.min.y, -c.z);
  fix.updateMatrixWorld(true);
  car.dim.copy(boxOf(model).getSize(V()));

  // materials + shadows
  const swapped = new Map(), meshes = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (!swapped.has(o.material)) swapped.set(o.material, materialFor(o.material, car.mats));
    o.userData.srcName = o.material.name || '';
    o.material = swapped.get(o.material);
    o.castShadow = true; o.receiveShadow = !o.material.transparent;
    meshes.push(o);
  });

  // lift every mesh into the root so each can move on its own
  const isWheel = (o) => /tire|object31/i.test(o.userData.srcName);
  const corners = new Map();
  for (const o of meshes) {
    root.attach(o);
    if (!isWheel(o)) continue;
    const cc = boxOf(o).getCenter(V());
    const id = (cc.x > 0 ? 'R' : 'L') + (cc.z > 0 ? 'F' : 'B');
    if (!corners.has(id)) corners.set(id, []);
    corners.get(id).push(o);
  }
  for (const [id, list] of corners) {
    const tire = list.find((o) => /tire/i.test(o.userData.srcName)) || list[0];
    const tb = boxOf(tire), wc = tb.getCenter(V());
    car.wheelR = tb.getSize(V()).y / 2;
    const pivot = new THREE.Group();
    pivot.position.copy(wc);
    root.add(pivot); pivot.updateMatrixWorld(true);
    const spinner = new THREE.Group();   // spins on the axle
    pivot.add(spinner); spinner.updateMatrixWorld(true);
    list.forEach((o) => spinner.attach(o));
    car.wheels.push({ id, pivot, spinner, stock: list, base: wc.clone(), side: Math.sign(wc.x), hero: id === 'RF' });
    if (id === 'RF') car.anchors.hub.copy(wc);
  }

  // body pieces
  meshes.filter((o) => !isWheel(o)).forEach((o, i) => {
    const b = boxOf(o), cc = b.getCenter(V());
    const layer = layerFor(o.userData.srcName);
    car.parts.push({ obj: o, base: o.position.clone(), layer, center: cc, size: b.getSize(V()), index: i });
    if (/glass/i.test(o.userData.srcName)) car.labels.canopy = { obj: o, local: o.worldToLocal(cc.clone().add(V(0.5, 0.1, 0.4))) };
    if (/base021/i.test(o.userData.srcName)) car.labels.shell = { obj: o, local: o.worldToLocal(V(cc.x + 0.4, b.max.y - 0.15, cc.z + 1.2)) };
    if (/steering/i.test(o.userData.srcName)) car.anchors.cockpit.copy(cc);
  });

  buildChassis(car);
  buildThrusters(car);

  // headlights that actually light what is in front of the car
  const beam = new THREE.SpotLight(0xe6f0ff, 0, 60, 0.55, 0.7, 1.1);
  beam.position.set(0, 0.52, 2.05);
  beam.target.position.set(0, 0.25, 16);
  root.add(beam, beam.target);
  car.beam = beam;
  const thrustLight = new THREE.PointLight(0x9fd4ff, 0, 30, 1.5);
  thrustLight.position.set(0, 0.2, 0);
  root.add(thrustLight);
  car.thrustLight = thrustLight;
  return car;
}

/* ------------------------------------------------------------------ *
 *  Rolling chassis: battery, subframes, drive units, suspension, brakes,
 *  air tanks and plumbing, suction fans. Built from simple shapes.
 * ------------------------------------------------------------------ */
function buildChassis(car) {
  const { root, core } = car;
  root.add(core);
  const brakes = new THREE.Group();        // visible through the spokes even when the body is on
  root.add(brakes);

  const ribs = canvasTexture(64, 64, (g) => { g.fillStyle = '#808080'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#d8d8d8'; for (let x = 0; x < 64; x += 8) g.fillRect(x, 0, 4, 64); }, false);
  ribs.wrapS = ribs.wrapT = THREE.RepeatWrapping;
  const weave = canvasTexture(64, 64, (g) => {
    g.fillStyle = '#0b0b0c'; g.fillRect(0, 0, 64, 64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { if ((x + y) % 4 < 2) { g.fillStyle = (x + y) % 2 ? '#2b2c2f' : '#1c1d20'; g.fillRect(x * 8, y * 8, 8, 8); } }
  });
  weave.wrapS = weave.wrapT = THREE.RepeatWrapping; weave.repeat.set(10, 5);

  const M = {
    alu: new THREE.MeshStandardMaterial({ color: 0xb4b9bf, metalness: 1, roughness: 0.4 }),
    aluRib: new THREE.MeshStandardMaterial({ color: 0xa9aeb5, metalness: 1, roughness: 0.45, bumpMap: ribs, bumpScale: 1.2 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x23252a, metalness: 0.9, roughness: 0.5 }),
    black: new THREE.MeshStandardMaterial({ color: 0x0c0c0d, metalness: 0.1, roughness: 0.78 }),
    hv: new THREE.MeshStandardMaterial({ color: 0xff6400, roughness: 0.55 }),
    caliper: new THREE.MeshPhysicalMaterial({ color: 0x8f0b13, roughness: 0.4, clearcoat: 0.7 }),
    disc: new THREE.MeshStandardMaterial({ color: 0x3a3b3e, metalness: 0.55, roughness: 0.5 }),
    spring: new THREE.MeshStandardMaterial({ color: 0xc8963c, metalness: 1, roughness: 0.35 }),
    carbon: new THREE.MeshPhysicalMaterial({ map: weave, color: 0xffffff, roughness: 0.38, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.12 }),
  };
  const add = (mesh, parent = core) => { mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh; };
  const box = (w, h, d, mat, x, y, z, parent) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return add(m, parent); };
  const cylX = (r, len, mat, x, y, z, parent, seg = 28) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat); m.rotation.z = Math.PI / 2; m.position.set(x, y, z); return add(m, parent); };
  const tube = (pts, r, mat, parent) => add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => V(...p)), false, 'catmullrom', 0.2), Math.max(8, pts.length * 8), r, 8), mat), parent);
  const rod = (a, b, r, mat, parent) => {
    const va = V(...a), vb = V(...b), d = vb.clone().sub(va);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 10), mat);
    m.position.copy(va).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize());
    return add(m, parent);
  };

  // --- structural battery pack
  ribs.repeat.set(1, 14);
  box(1.5, 0.1, 1.62, M.dark, 0, 0.17, 0);
  const lid = box(1.42, 0.016, 1.54, M.aluRib, 0, 0.228, 0);
  for (const sx of [-1, 1]) box(0.07, 0.11, 1.66, M.alu, sx * 0.785, 0.172, 0);
  const bolt = new THREE.CylinderGeometry(0.011, 0.011, 0.012, 8), bm = new THREE.Matrix4();
  const boltPos = [];
  for (let z = -0.74; z <= 0.741; z += 0.123) boltPos.push([-0.725, z], [0.725, z]);
  for (let x = -0.6; x <= 0.601; x += 0.15) boltPos.push([x, -0.785], [x, 0.785]);
  const bolts = new THREE.InstancedMesh(bolt, M.dark, boltPos.length);
  boltPos.forEach(([x, z], i) => { bm.makeTranslation(x, 0.238, z); bolts.setMatrixAt(i, bm); });
  core.add(bolts);
  box(0.44, 0.06, 0.2, M.dark, 0, 0.268, -0.66);
  box(0.3, 0.014, 0.06, M.hv, 0, 0.302, -0.66);
  tube([[0.16, 0.29, -0.76], [0.2, 0.36, -0.98], [0.16, 0.48, -1.2], [0.12, 0.5, -1.3]], 0.016, M.hv);
  tube([[-0.16, 0.29, -0.76], [-0.2, 0.36, -0.98], [-0.16, 0.48, -1.2], [-0.12, 0.5, -1.3]], 0.016, M.hv);
  tube([[0.3, 0.25, 0.8], [0.3, 0.3, 1.0], [0.16, 0.45, 1.24], [0.1, 0.48, 1.32]], 0.016, M.hv);
  car.labels.battery = { obj: lid, local: V(-0.45, 0.02, 0.35) };

  // --- subframes and drive units (two motors at the back, one at the front)
  for (const sz of [-1, 1]) {
    const z0 = sz * 0.9, z1 = sz * 1.82, zc = sz * 1.35;
    for (const sx of [-1, 1]) {
      tube([[sx * 0.5, 0.2, z0], [sx * 0.52, 0.22, zc], [sx * 0.46, 0.26, z1]], 0.028, M.dark);
      rod([sx * 0.5, 0.21, zc - 0.22], [sx * 0.54, 0.6, zc - 0.05], 0.022, M.dark);
      rod([sx * 0.5, 0.21, zc + 0.22], [sx * 0.54, 0.6, zc + 0.05], 0.022, M.dark);
    }
    rod([-0.5, 0.21, z0], [0.5, 0.21, z0], 0.026, M.dark);
    rod([-0.46, 0.26, z1], [0.46, 0.26, z1], 0.026, M.dark);
    rod([-0.54, 0.6, zc], [0.54, 0.6, zc], 0.02, M.dark);
    ribs.repeat.set(10, 1);
    const twin = sz < 0;
    for (const mxp of twin ? [-0.2, 0.2] : [0]) cylX(0.125, twin ? 0.26 : 0.34, M.aluRib, mxp, 0.31, zc);
    box(0.12, 0.25, 0.27, M.alu, 0, 0.31, zc);
    const inv = box(twin ? 0.52 : 0.4, 0.07, 0.24, M.aluRib, 0, 0.485, zc);
    box(0.16, 0.03, 0.1, M.black, 0.1, 0.53, zc);
    if (twin) car.labels.motor = { obj: inv, local: V(0.2, 0.05, 0) };
  }

  // --- suspension and brakes at each corner
  for (const w of car.wheels) {
    const sx = w.side, H = w.base, zc = H.z;
    const hubX = H.x - sx * 0.1;
    rod([hubX - sx * 0.3, H.y, zc], [sx * 0.34, 0.33, zc], 0.019, M.dark);                     // half-shaft
    box(0.06, 0.3, 0.1, M.alu, hubX - sx * 0.05, H.y, zc);                                       // upright
    for (const dz of [-0.2, 0.2]) {
      rod([hubX - sx * 0.04, H.y - 0.13, zc], [sx * 0.5, 0.21, zc + dz], 0.017, M.alu);         // lower wishbone
      rod([hubX - sx * 0.06, H.y + 0.14, zc], [sx * 0.54, 0.52, zc + dz * 0.8], 0.015, M.alu);  // upper wishbone
    }
    const lo = V(sx * 0.7, H.y - 0.1, zc + 0.02), hi = V(sx * 0.55, 0.62, zc + 0.02);
    rod(lo.toArray(), hi.toArray(), 0.022, M.dark);                                              // damper
    const axis = hi.clone().sub(lo), len = axis.length(), q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), axis.clone().normalize());
    const helix = [];
    for (let i = 0; i <= 70; i++) { const t = i / 70, a = t * Math.PI * 2 * 7; helix.push(V(Math.cos(a) * 0.043, 0.06 + t * (len - 0.12), Math.sin(a) * 0.043).applyQuaternion(q).add(lo)); }
    add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), 220, 0.0075, 6), M.spring));
    // brake: disc, hat and a caliper gripping its rear edge
    const disc = cylX(0.185, 0.03, M.disc, hubX, H.y, zc, brakes, 40);
    cylX(0.08, 0.06, M.alu, hubX + sx * 0.01, H.y, zc, brakes);
    const cal = box(0.075, 0.085, 0.17, M.caliper, hubX, H.y + 0.1, zc - Math.sign(zc) * 0.125, brakes);
    cal.rotation.x = Math.sign(zc) * 0.6;
    if (w.hero) car.labels.brakes = { obj: disc, local: V(0, 0, 0.12) };
  }

  // --- compressed-air system: two carbon-wrapped tanks and the lines that feed the nozzles
  const tanks = new THREE.Group();
  for (const z of [-0.6, -0.97]) {
    const tank = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.165, 0.72, 10, 28), M.carbon), tanks);
    tank.rotation.z = Math.PI / 2; tank.position.set(0, 0.56, z);
    for (const sx of [-1, 1]) {
      cylX(0.05, 0.07, M.alu, sx * 0.545, 0.56, z, tanks);
      const strap = add(new THREE.Mesh(new THREE.TorusGeometry(0.169, 0.008, 6, 36), M.alu), tanks);
      strap.rotation.y = Math.PI / 2; strap.position.set(sx * 0.24, 0.56, z);
    }
  }
  core.add(tanks);
  box(0.1, 0.09, 0.3, M.alu, 0.62, 0.56, -0.78);                                                 // valve block
  car.labels.tanks = { obj: tanks, local: V(-0.3, 0.75, -0.6) };
  const all = [...NOZZLES.hover, ...NOZZLES.roll, ...NOZZLES.rear, ...NOZZLES.nose];
  for (const nz of all) {
    const sx = Math.sign(nz.p.x) || 1, railX = sx * 0.84;
    tube([[0.62, 0.56, -0.78], [railX * 0.92, 0.42, -0.8], [railX, 0.3, (nz.p.z - 0.8) / 2], [railX, 0.3, nz.p.z * 0.92], nz.p.clone().addScaledVector(nz.d, -0.14).toArray()], 0.011, M.alu);
  }

  // --- suction fans set into the floor
  car.mats.fanRing = new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.9, roughness: 0.4, emissive: 0x9fdcff, emissiveIntensity: 0 });
  const fanGroup = new THREE.Group();
  for (const [x, z] of [[-0.45, 1.02], [0.45, 1.02], [-0.45, -1.04], [0.45, -1.04]]) {
    const fan = new THREE.Group();
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.08, 36, 1, true), M.dark), fan).material.side = THREE.DoubleSide;
    add(new THREE.Mesh(new THREE.TorusGeometry(0.205, 0.012, 8, 40), car.mats.fanRing), fan).rotation.x = Math.PI / 2;
    const rotor = new THREE.Group();
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 16), M.alu), rotor);
    for (let i = 0; i < 9; i++) {
      const arm = new THREE.Group(); arm.rotation.y = (i / 9) * Math.PI * 2;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.008, 0.06), M.black);
      blade.position.x = 0.125; blade.rotation.x = 0.55;
      arm.add(blade); rotor.add(arm);
    }
    fan.add(rotor); fan.position.set(x, 0.13, z);
    fanGroup.add(fan); car.fans.push(rotor);
  }
  core.add(fanGroup);
  car.labels.fans = { obj: fanGroup, local: V(0.45, 0.16, 1.02) };

  core.visible = false;
  car.brakeGroup = brakes;
}

/* ------------------------------------------------------------------ *
 *  Thrusters: nozzle bells + the jets that come out of them
 * ------------------------------------------------------------------ */
function buildThrusters(car) {
  car.mats.nozzle = new THREE.MeshStandardMaterial({ color: 0x1e2024, metalness: 1, roughness: 0.35, emissive: 0xa9dcff, emissiveIntensity: 0, side: THREE.DoubleSide });
  const bell = new THREE.LatheGeometry([[0.018, 0], [0.02, 0.05], [0.042, 0.11], [0.058, 0.15]].map(([x, y]) => new THREE.Vector2(x, y)), 20);
  const down = V(0, -1, 0), up = V(0, 1, 0);
  for (const [name, list] of Object.entries(NOZZLES)) {
    car.jets[name] = list.map((nz) => {
      const b = new THREE.Mesh(bell, car.mats.nozzle);
      b.position.copy(nz.p).addScaledVector(nz.d, -0.13);
      b.quaternion.setFromUnitVectors(up, nz.d);
      car.core.add(b);
      const jet = createJet(name === 'hover' ? 1.25 : name === 'rear' ? 1.1 : 0.8);
      jet.position.copy(nz.p);
      jet.quaternion.setFromUnitVectors(down, nz.d);
      car.root.add(jet);
      return { jet, nz };
    });
  }
  car.labels.thrusters = { obj: car.root, local: NOZZLES.rear[3].p.clone() };
}

/** Developer view: every body piece of the model laid out in a grid with its index (open the page with ?inspect). */
export function layoutInspect(car) {
  car.core.visible = false;
  car.parts.forEach((part, i) => {
    const gx = (i % 6) * 5 - 12.5, gz = Math.floor(i / 6) * 5;
    part.obj.position.copy(part.base).add(V(gx - part.center.x, 0, gz - part.center.z));
    part.grid = V(gx, part.center.y, gz);
  });
}

/**
 * Replace the car's stock wheels with a more detailed wheel model.
 * The model is a single wheel whose axle runs along its own Z, outer face towards +Z.
 */
export function mountWheels(car, wheel) {
  const holder = new THREE.Group();
  holder.add(wheel);
  holder.updateMatrixWorld(true);
  const box = boxOf(wheel), c = box.getCenter(V()), size = box.getSize(V());
  wheel.position.sub(c);                                    // spin about its own centre
  const k = (car.wheelR * 2) / Math.max(size.x, size.y);    // match the stock tyre's diameter
  wheel.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    const m = o.material, n = (m.name || '').toLowerCase();
    if (n === 'material.003') { m.roughness = 0.86; m.metalness = 0; m.color.set(0x070707); }           // tyre
    if (n === 'material.001') { m.envMapIntensity = 1.5; }                                                // gloss black rim
    if (n === 'material') { m.envMapIntensity = 1.6; }                                                    // metal hub
    if (n === 'material.002') { m.depthWrite = false; m.envMapIntensity = 1.8; }                          // translucent face cover
  });
  for (const w of car.wheels) {
    w.stock.forEach((o) => { o.visible = false; });
    const g = holder.clone(true);
    g.scale.setScalar(k);
    g.rotation.y = w.side > 0 ? Math.PI / 2 : -Math.PI / 2;  // outer face away from the car
    w.spinner.add(g);
  }
}
