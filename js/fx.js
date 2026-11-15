// Cold-gas effects: thin luminous jets, and thick lit smoke that billows where they hit the ground.
import * as THREE from 'three';
import { makeNoise, clamp01 } from './util.js';

/* ------------------------------------------------------------------ *
 *  Smoke: a few hundred large soft puffs, sorted and lit from above
 * ------------------------------------------------------------------ */
function smokeAtlas() {
  // four different puff shapes in a 2×2 sheet; alpha is the shape, red is fine detail
  const S = 256, noise = makeNoise(13);
  const c = document.createElement('canvas'); c.width = c.height = S * 2;
  const g = c.getContext('2d'), img = g.createImageData(S * 2, S * 2);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * S, oy = Math.floor(cell / 2) * S, off = cell * 31.7;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = (x / S) * 2 - 1, v = (y / S) * 2 - 1, r = Math.hypot(u, v);
      const lump = noise.fbm(u * 1.7 + off, v * 1.7 + off, 5);
      const wisp = noise.fbm(u * 4.5 + off * 2, v * 4.5 - off, 4);
      let d = 1 - (r + (lump - 0.5) * 1.15) / 0.9;           // ragged, lumpy edge
      d = clamp01(d * 3.4);                                    // firm body, so puffs read as solid billows
      const edge = clamp01((1 - r) * 6);                       // never touch the quad border
      const i = ((oy + y) * S * 2 + ox + x) * 4;
      img.data[i] = 120 + wisp * 135; img.data[i + 1] = 0; img.data[i + 2] = 0;
      img.data[i + 3] = Math.pow(d, 0.85) * (0.78 + 0.22 * wisp) * edge * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export class Smoke {
  constructor(scene, max = 950) {
    this.max = max;
    const f = (n) => new Float32Array(max * n);
    this.p = f(3); this.v = f(3);
    this.age = f(1); this.life = f(1); this.size0 = f(1); this.grow = f(1);
    this.rot = f(1); this.spin = f(1); this.alpha = f(1); this.rise = f(1); this.drag = f(1); this.cell = f(1);
    this.tint = f(3);
    this.alive = new Uint8Array(max);
    this.cursor = 0;
    this.order = new Uint16Array(max); this.depth = f(1);
    this.liveCount = 0;
    /** set from outside: where red light spills from, so nearby smoke picks it up */
    this.redLineX = -13;

    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    this.iPos = new THREE.InstancedBufferAttribute(f(3), 3);
    this.iPar = new THREE.InstancedBufferAttribute(f(4), 4);
    this.iTint = new THREE.InstancedBufferAttribute(f(3), 3);
    for (const a of [this.iPos, this.iPar, this.iTint]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos); geo.setAttribute('iPar', this.iPar); geo.setAttribute('iTint', this.iTint);
    geo.instanceCount = 0;
    this.geo = geo;

    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: smokeAtlas() } },
      transparent: true, depthWrite: false, premultipliedAlpha: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec4 iPar; attribute vec3 iTint;
        varying vec2 vUv; varying float vAlpha; varying vec3 vTint; varying float vH; varying float vCell;
        void main(){
          float cs = cos(iPar.y), sn = sin(iPar.y);
          vec2 r = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);
          vec4 mv = viewMatrix * vec4(iPos, 1.0);
          mv.xy += r * iPar.x;
          vH = r.y + 0.5;                 // 0 at the bottom of the puff on screen, 1 at the top
          vUv = uv; vAlpha = iPar.z * smoothstep(1.0, 4.5, -mv.z); vTint = iTint; vCell = iPar.w;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec2 vUv; varying float vAlpha; varying vec3 vTint; varying float vH; varying float vCell;
        void main(){
          vec2 cell = vec2(mod(vCell, 2.0), floor(vCell * 0.5));
          vec4 t = texture2D(uMap, (clamp(vUv, 0.0, 1.0) + cell) * 0.5);
          float a = clamp(t.a * vAlpha, 0.0, 1.0);
          if (a < 0.004) discard;
          // lit from above: bright crowns, grey bellies
          float light = mix(0.36, 1.06, smoothstep(0.1, 0.9, vH)) * (0.66 + 0.34 * t.r);
          gl_FragColor = vec4(max(vTint * light, vec3(0.0)) * a, a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  /** o: { x,y,z, vx,vy,vz, life, size, grow, alpha, rise, drag, r,g,b } */
  spawn(o) {
    let i = this.cursor, tries = 0;
    while (this.alive[i] && tries++ < this.max) i = (i + 1) % this.max;   // prefer a free slot
    this.cursor = (i + 1) % this.max;
    const k = i * 3;
    this.p[k] = o.x; this.p[k + 1] = o.y; this.p[k + 2] = o.z;
    this.v[k] = o.vx || 0; this.v[k + 1] = o.vy || 0; this.v[k + 2] = o.vz || 0;
    this.age[i] = 0; this.life[i] = o.life || 3;
    this.size0[i] = o.size || 1; this.grow[i] = o.grow ?? 3;
    this.rot[i] = Math.random() * 6.283; this.spin[i] = (Math.random() - 0.5) * 0.5;
    this.alpha[i] = o.alpha ?? 0.6; this.rise[i] = o.rise ?? 0.35; this.drag[i] = o.drag ?? 1.4;
    this.cell[i] = (Math.random() * 4) | 0;
    this.tint[k] = o.r ?? 0.86; this.tint[k + 1] = o.g ?? 0.89; this.tint[k + 2] = o.b ?? 0.92;
    this.alive[i] = 1;
  }

  update(dt, camera, time) {
    const { p, v, age, life, alive, max } = this;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const e = camera.matrixWorld.elements, fx = -e[8], fy = -e[9], fz = -e[10];   // view direction
    let n = 0;
    for (let i = 0; i < max; i++) {
      if (!alive[i]) continue;
      age[i] += dt;
      if (age[i] >= life[i]) { alive[i] = 0; continue; }
      const k = i * 3, dr = Math.exp(-this.drag[i] * dt);
      // slow churning so the cloud keeps rolling after the burst
      v[k] += Math.sin(p[k + 1] * 0.9 + time * 0.7 + i) * 0.5 * dt;
      v[k + 2] += Math.cos(p[k] * 0.8 + time * 0.6 + i * 1.7) * 0.5 * dt;
      v[k] *= dr; v[k + 2] *= dr;
      v[k + 1] = v[k + 1] * dr + this.rise[i] * dt;
      p[k] += v[k] * dt; p[k + 1] += v[k + 1] * dt; p[k + 2] += v[k + 2] * dt;
      const size = this.size0[i] + this.grow[i] * (1 - Math.exp(-age[i] * 0.5));
      const floorY = size * 0.42;                      // keep the puff's lower edge above the ground, so it never shows a hard cut                       // puffs rest on the ground and spread
      if (p[k + 1] < floorY) { p[k + 1] = floorY; if (v[k + 1] < 0) v[k + 1] *= -0.15; }
      this.depth[i] = (p[k] - cx) * fx + (p[k + 1] - cy) * fy + (p[k + 2] - cz) * fz;
      this.order[n++] = i;
    }
    this.liveCount = n;
    const order = this.order.subarray(0, n), depth = this.depth;
    order.sort((a, b) => depth[b] - depth[a]);         // far puffs first
    const P = this.iPos.array, R = this.iPar.array, T = this.iTint.array;
    for (let j = 0; j < n; j++) {
      const i = order[j], k = i * 3, t = age[i] / life[i];
      const size = this.size0[i] + this.grow[i] * (1 - Math.exp(-age[i] * 0.5));
      P[j * 3] = p[k]; P[j * 3 + 1] = p[k + 1]; P[j * 3 + 2] = p[k + 2];
      const fadeIn = Math.min(1, age[i] / 0.18), fadeOut = 1 - Math.min(1, Math.max(0, (t - 0.45) / 0.55));
      R[j * 4] = size;
      R[j * 4 + 1] = this.rot[i] + this.spin[i] * age[i];
      R[j * 4 + 2] = this.alpha[i] * fadeIn * fadeOut * fadeOut;
      R[j * 4 + 3] = this.cell[i];
      // smoke near the red wall picks up its colour
      const red = Math.exp(-Math.pow((p[k] - this.redLineX) / 7, 2)) * Math.exp(-p[k + 1] / 5) * 0.6;
      T[j * 3] = this.tint[k] + red * 0.25;
      T[j * 3 + 1] = this.tint[k + 1] * (1 - red * 0.75);
      T[j * 3 + 2] = this.tint[k + 2] * (1 - red * 0.75);
    }
    this.iPos.needsUpdate = this.iPar.needsUpdate = this.iTint.needsUpdate = true;
    this.geo.instanceCount = n;
  }
}

/* ------------------------------------------------------------------ *
 *  Jets: a bright narrow core inside a wider faint sheath
 * ------------------------------------------------------------------ */
const jetVert = /* glsl */ `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalMatrix * normal; vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`;
const jetFrag = /* glsl */ `uniform float uTime; uniform float uPower; uniform float uSeed; uniform vec3 uColor; uniform float uGain;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main(){
    // every term is clamped: an invalid pixel here would be smeared across the frame by bloom
    float along = clamp(1.0 - vUv.y, 0.0, 1.0);                       // 0 at the nozzle, 1 at the tip
    vec3 n = vN / max(length(vN), 1e-4), v = vV / max(length(vV), 1e-4);
    float facing = pow(clamp(abs(dot(n, v)), 1e-4, 1.0), 1.5);         // soft silhouette
    float body = pow(clamp(1.0 - along, 1e-4, 1.0), 1.35);
    float streak = 0.72 + 0.28 * sin(vUv.x * 43.0 + sin(along * 17.0 - uTime * 26.0 + uSeed * 9.0) * 1.7);
    float pulse = 0.86 + 0.14 * sin(uTime * 53.0 + uSeed * 21.0);
    vec3 col = mix(uColor, vec3(1.0), pow(clamp(1.0 - along, 1e-4, 1.0), 5.0));
    float a = body * streak * pulse * facing * clamp(uPower, 0.0, 2.0) * uGain;
    gl_FragColor = vec4(max(col * a, vec3(0.0)), 1.0);
  }`;

/** Returns a group pointing down its local -Y. Call jet.userData.set(power, length, time). */
export function createJet(width = 1) {
  const group = new THREE.Group();
  const uniformsFor = (gain) => ({
    uTime: { value: 0 }, uPower: { value: 0 }, uSeed: { value: Math.random() },
    uColor: { value: new THREE.Color(0.42, 0.74, 1.0) }, uGain: { value: gain },
  });
  const layer = (rTop, rBottom, gain) => {
    const geo = new THREE.CylinderGeometry(rTop, rBottom, 1, 22, 14, true);
    geo.translate(0, -0.5, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: uniformsFor(gain), vertexShader: jetVert, fragmentShader: jetFrag,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false; m.renderOrder = 6;
    group.add(m);
    return mat;
  };
  const mats = [layer(0.035 * width, 0.11 * width, 2.6), layer(0.06 * width, 0.34 * width, 0.75)];
  group.visible = false;
  group.userData.set = (power, length, time) => {
    group.visible = power > 0.01;
    if (!group.visible) return;
    group.scale.set(1, Math.max(0.05, length), 1);
    for (const m of mats) { m.uniforms.uPower.value = power; m.uniforms.uTime.value = time; }
  };
  return group;
}
