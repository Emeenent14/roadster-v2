import * as THREE from 'three';

export const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const smooth = (t) => t * t * (3 - 2 * t);
/** 0 → 1 as p moves from a to b */
export const seg = (p, a, b) => clamp01((p - a) / (b - a));
export const bump = (t) => Math.sin(Math.PI * clamp01(t));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Small seeded value-noise generator: n2(x, y) and fbm(x, y, octaves), both in 0..1 */
export function makeNoise(seed = 1) {
  const perm = new Uint16Array(512), vals = new Float32Array(256);
  let s = (seed * 9301 + 49297) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = rnd(); }
  for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const n2 = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const X = xi & 255, Y = yi & 255;
    const a = vals[perm[perm[X] + Y] & 255], b = vals[perm[perm[X + 1] + Y] & 255];
    const c = vals[perm[perm[X] + Y + 1] & 255], d = vals[perm[perm[X + 1] + Y + 1] & 255];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x, y, oct = 5) => {
    let f = 0, amp = 0.5, tot = 0;
    for (let i = 0; i < oct; i++) { f += n2(x, y) * amp; tot += amp; x = x * 2.03 + 17.1; y = y * 2.03 + 9.7; amp *= 0.5; }
    return f / tot;
  };
  return { n2, fbm, rnd };
}

/** Collects straight members (a → b) and turns them into one instanced mesh of thin boxes. */
export class BeamSet {
  constructor() { this.list = []; }
  add(a, b, t = 0.1) { this.list.push([a.clone(), b.clone(), t]); return this; }
  build(material) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, this.list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = V(0, 1, 0), d = V(), mid = V(), sc = V();
    this.list.forEach(([a, b, t], i) => {
      d.subVectors(b, a);
      const len = d.length();
      q.setFromUnitVectors(up, d.normalize());
      mid.addVectors(a, b).multiplyScalar(0.5);
      m.compose(mid, q, sc.set(t, len, t));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }
}
