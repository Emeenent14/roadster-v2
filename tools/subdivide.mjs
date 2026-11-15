// Rebuilds the car's surfaces at higher density.
//
//   node tools/subdivide.mjs [input.glb] [output.glb]
//
// Each body mesh is welded, then refined with Loop subdivision. Edges sharper than CREASE_DEG
// (and open borders) are marked as creases and kept sharp, so curved panels get smoother while
// the car's design lines stay crisp. Shading normals are then rebuilt, split along the creases.
// Mesh, node and material names are kept, so the site's rig still finds every part.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';

const [, , IN = 'models-src/roadster-source.glb', OUT = 'models-src/roadster-hd.glb'] = process.argv;
const CREASE_DEG = 34;       // dihedral angle above which an edge counts as a design line
const NORMAL_DEG = 34;       // faces further apart than this do not share a shading normal

// How many subdivision passes per part (matched against the material name). Each pass is ×4 triangles.
const LEVELS = [
  [/base021/i, 2],                          // white body shell: the most visible surface
  [/baseblack02|baseblack03|baseblack221/i, 2],
  [/object01/i, 2],
  [/glass/i, 2],
  [/base031/i, 2],
  [/object21/i, 1],                         // already dense
  [/interior|steering/i, 1],                // seats and wheel, seen in the cockpit shot
];

/* ------------------------------------------------------------------ */
function weld(pos, idx, tol) {
  const map = new Map(), out = [], remap = new Uint32Array(pos.length / 3);
  const q = (v) => Math.round(v / tol);
  for (let i = 0; i < pos.length / 3; i++) {
    const key = `${q(pos[3 * i])},${q(pos[3 * i + 1])},${q(pos[3 * i + 2])}`;
    let j = map.get(key);
    if (j === undefined) { j = out.length / 3; map.set(key, j); out.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]); }
    remap[i] = j;
  }
  const faces = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
    if (a !== b && b !== c && c !== a) faces.push(a, b, c);          // drop collapsed triangles
  }
  return { P: out, F: faces };
}

const ekey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
function faceNormal(P, a, b, c, out = [0, 0, 0]) {
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
  return out;                                                          // length = 2 × area
}
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

function buildEdges(F) {
  const edges = new Map();
  for (let f = 0; f < F.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const a = F[3 * f + k], b = F[3 * f + ((k + 1) % 3)], o = F[3 * f + ((k + 2) % 3)];
      const key = ekey(a, b);
      let e = edges.get(key);
      if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), faces: [], opp: [] }; edges.set(key, e); }
      e.faces.push(f); e.opp.push(o);
    }
  }
  return edges;
}

/** Marks design lines: open borders, non-manifold edges and folds sharper than CREASE_DEG. */
function findCreases(P, F, edges) {
  const cosT = Math.cos((CREASE_DEG * Math.PI) / 180), creases = new Set();
  const fn = [];
  for (let f = 0; f < F.length / 3; f++) fn.push(norm(faceNormal(P, F[3 * f], F[3 * f + 1], F[3 * f + 2])));
  for (const [key, e] of edges) {
    if (e.faces.length !== 2) { creases.add(key); continue; }
    const n0 = fn[e.faces[0]], n1 = fn[e.faces[1]];
    if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < cosT) creases.add(key);
  }
  return creases;
}

/** One pass of Loop subdivision with sharp creases (Hoppe et al. rules). */
function loopPass(P, F, creases) {
  const nV = P.length / 3, edges = buildEdges(F);
  const nbrs = Array.from({ length: nV }, () => new Set());
  const creaseNbrs = Array.from({ length: nV }, () => []);
  for (const [key, e] of edges) {
    nbrs[e.a].add(e.b); nbrs[e.b].add(e.a);
    if (creases.has(key)) { creaseNbrs[e.a].push(e.b); creaseNbrs[e.b].push(e.a); }
  }
  const NP = new Float64Array(nV * 3);
  for (let v = 0; v < nV; v++) {
    const c = creaseNbrs[v].length;
    let x, y, z;
    if (c >= 3) { x = P[3 * v]; y = P[3 * v + 1]; z = P[3 * v + 2]; }                          // corner: stays put
    else if (c === 2) {                                                                         // on a design line: smooth along it only
      const [a, b] = creaseNbrs[v];
      x = 0.75 * P[3 * v] + 0.125 * (P[3 * a] + P[3 * b]);
      y = 0.75 * P[3 * v + 1] + 0.125 * (P[3 * a + 1] + P[3 * b + 1]);
      z = 0.75 * P[3 * v + 2] + 0.125 * (P[3 * a + 2] + P[3 * b + 2]);
    } else {                                                                                    // smooth surface
      const n = nbrs[v].size;
      if (!n) { x = P[3 * v]; y = P[3 * v + 1]; z = P[3 * v + 2]; }
      else {
        const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
        x = (1 - n * beta) * P[3 * v]; y = (1 - n * beta) * P[3 * v + 1]; z = (1 - n * beta) * P[3 * v + 2];
        for (const u of nbrs[v]) { x += beta * P[3 * u]; y += beta * P[3 * u + 1]; z += beta * P[3 * u + 2]; }
      }
    }
    NP[3 * v] = x; NP[3 * v + 1] = y; NP[3 * v + 2] = z;
  }
  // a point in the middle of every edge
  const out = Array.from(NP), mid = new Map(), newCreases = new Set();
  for (const [key, e] of edges) {
    const { a, b } = e;
    let x, y, z;
    if (creases.has(key) || e.faces.length !== 2) {
      x = (P[3 * a] + P[3 * b]) / 2; y = (P[3 * a + 1] + P[3 * b + 1]) / 2; z = (P[3 * a + 2] + P[3 * b + 2]) / 2;
    } else {
      const [o0, o1] = e.opp;
      x = 0.375 * (P[3 * a] + P[3 * b]) + 0.125 * (P[3 * o0] + P[3 * o1]);
      y = 0.375 * (P[3 * a + 1] + P[3 * b + 1]) + 0.125 * (P[3 * o0 + 1] + P[3 * o1 + 1]);
      z = 0.375 * (P[3 * a + 2] + P[3 * b + 2]) + 0.125 * (P[3 * o0 + 2] + P[3 * o1 + 2]);
    }
    const m = out.length / 3;
    out.push(x, y, z);
    mid.set(key, m);
    if (creases.has(key)) { newCreases.add(ekey(a, m)); newCreases.add(ekey(m, b)); }
  }
  const NF = [];
  for (let f = 0; f < F.length / 3; f++) {
    const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
    const ab = mid.get(ekey(a, b)), bc = mid.get(ekey(b, c)), ca = mid.get(ekey(c, a));
    NF.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { P: out, F: NF, creases: newCreases };
}

/** Shading normals: each corner averages only the neighbouring faces on its side of a design line. */
function creasedNormals(P, F) {
  const cosT = Math.cos((NORMAL_DEG * Math.PI) / 180), nF = F.length / 3;
  const fnRaw = [], fn = [];
  for (let f = 0; f < nF; f++) { const r = faceNormal(P, F[3 * f], F[3 * f + 1], F[3 * f + 2]); fnRaw.push(r); fn.push(norm(r)); }
  const vf = Array.from({ length: P.length / 3 }, () => []);
  for (let f = 0; f < nF; f++) for (let k = 0; k < 3; k++) vf[F[3 * f + k]].push(f);
  const pos = [], nor = [], idx = [], seen = new Map();
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < 3; k++) {
      const v = F[3 * f + k], me = fn[f];
      let x = 0, y = 0, z = 0;
      for (const g of vf[v]) {
        const o = fn[g];
        if (me[0] * o[0] + me[1] * o[1] + me[2] * o[2] < cosT) continue;
        x += fnRaw[g][0]; y += fnRaw[g][1]; z += fnRaw[g][2];             // area-weighted
      }
      const n = norm([x, y, z]);
      const key = `${v}|${Math.round(n[0] * 500)},${Math.round(n[1] * 500)},${Math.round(n[2] * 500)}`;
      let i = seen.get(key);
      if (i === undefined) {
        i = pos.length / 3; seen.set(key, i);
        pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); nor.push(n[0], n[1], n[2]);
      }
      idx.push(i);
    }
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx) };
}

/* ------------------------------------------------------------------ */
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(IN);
const buffer = doc.getRoot().listBuffers()[0];
let before = 0, after = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const name = prim.getMaterial()?.getName() || '';
    const level = (LEVELS.find(([re]) => re.test(name)) || [])[1] || 0;
    const tris = (prim.getIndices() ? prim.getIndices().getCount() : prim.getAttribute('POSITION').getCount()) / 3;
    before += tris;
    if (!level) { after += tris; continue; }
    const posAcc = prim.getAttribute('POSITION');
    const raw = posAcc.getArray();
    const idx = prim.getIndices() ? Array.from(prim.getIndices().getArray()) : [...Array(posAcc.getCount()).keys()];
    const min = posAcc.getMin([]), max = posAcc.getMax([]);
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    let { P, F } = weld(raw, idx, diag * 1e-5);
    let creases = findCreases(P, F, buildEdges(F));
    for (let i = 0; i < level; i++) ({ P, F, creases } = loopPass(P, F, creases));
    const g = creasedNormals(P, F);
    for (const sem of prim.listSemantics()) if (sem !== 'POSITION' && sem !== 'NORMAL') prim.setAttribute(sem, null);
    prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(g.pos).setBuffer(buffer));
    prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(g.nor).setBuffer(buffer));
    prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(g.idx).setBuffer(buffer));
    after += g.idx.length / 3;
    console.log(`${name.padEnd(42)} level ${level}  ${String(tris).padStart(6)} → ${String(g.idx.length / 3).padStart(7)} tris`);
  }
}
await doc.transform(prune());
await io.write(OUT, doc);
console.log(`\ntotal ${before} → ${after} triangles, written to ${OUT}`);
