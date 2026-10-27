/**
 * forest3d.js — the stage's forest: plots of trees that follow the model's canopy height.
 *
 * The rule is the one stand.js set: in every year the trees' mean height is the canopy height the
 * model predicts. A scenario that leaves the stand shorter than no action shows the shortfall as
 * trees that are gone (cut, or burnt to snags), the rest standing exactly as they do without
 * action; whatever the model then lets the stand recover grows back in the gaps. A scenario that
 * adds growth makes every tree taller. Everything else on a plot (the marking paint, the flagging
 * tape, the planted saplings, the fence, the fire) illustrates the action; none of it changes a
 * number.
 *
 * All trees are drawn through five instanced batches, rebuilt every frame from the year t, so any
 * year can be shown directly: a scrub back through a fire shows the fire.
 */

import * as THREE from '../assets/vendor/three.module.js';

/* ------------------------------------------------------------------ small maths */

/** A tiny seeded generator, so a site always grows the same forest. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (n) => {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};

function vhash(x, y, z) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise in [0, 1], for shaping geometry. */
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(vhash(xi, yi, zi), vhash(xi + 1, yi, zi), u), l(vhash(xi, yi + 1, zi), vhash(xi + 1, yi + 1, zi), u), v),
    l(l(vhash(xi, yi, zi + 1), vhash(xi + 1, yi, zi + 1), u), l(vhash(xi, yi + 1, zi + 1), vhash(xi + 1, yi + 1, zi + 1), u), v),
    w);
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** Linear interpolation into a 41-year series at a fractional year. */
export function at(series, y) {
  if (!series) return NaN;
  const i = Math.max(0, Math.min(40, y));
  const i0 = Math.floor(i), i1 = Math.min(40, i0 + 1), f = i - i0;
  return series[i0] * (1 - f) + series[i1] * f;
}

/* ------------------------------------------------------------------ shaders */

// Wind bends each instance by the square of its height above the plot; leaves and bark get a
// procedural grain so a crown reads as foliage rather than a ball.
const GLSL_NOISE = /* glsl */ `
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vn(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1,0,0)), f.x), mix(h13(i + vec3(0,1,0)), h13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h13(i + vec3(0,0,1)), h13(i + vec3(1,0,1)), f.x), mix(h13(i + vec3(0,1,1)), h13(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

const FRAG = {
  // clumps of leaves with darker gaps between them, a ragged silhouette (fragments at grazing
  // angles are cut away by noise), and a darker underside
  leaf: /* glsl */ `
    float na = vn(vLocal * 5.0 + 1.7), nb = vn(vLocal * 12.0 + 4.1), nc = vn(vLocal * 27.0);
    vec3 leafN = vec3(nb, nc, na);
    float ln = na * 0.5 + nb * 0.32 + nc * 0.18;
    float clump = smoothstep(0.3, 0.72, na * 0.6 + nb * 0.4);
    diffuseColor.rgb *= (0.6 + 0.62 * ln) * mix(0.62, 1.1, clump);
    diffuseColor.rgb *= mix(0.52, 1.07, smoothstep(-0.95, 0.9, vLocal.y));
    float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
    float cut = nb * 0.65 + nc * 0.35;
    if (cut < (1.0 - facing) * 1.25 - 0.2) discard;`,
  bark: /* glsl */ `
    float bn = vn(vec3(vLocal.x * 6.0, vLocal.y * 1.4, vLocal.z * 6.0)) * 0.6 + vn(vLocal * 21.0) * 0.4;
    diffuseColor.rgb *= 0.74 + 0.46 * bn;`,
  frond: /* glsl */ `
    float fn = vn(vLocal * vec3(26.0, 9.0, 40.0)) ;
    diffuseColor.rgb *= 0.72 + 0.5 * fn;
    diffuseColor.rgb *= mix(0.7, 1.05, smoothstep(-0.3, 0.2, vLocal.y));`,
};

// Growth beyond the no-action stand: each crown carries, per instance, the height its no-action twin
// reaches (aMark.x) and how strongly to show the difference (aMark.y). Above that height the
// foliage turns lime and a bright contour rings the crown at the no-action level.
const CAP_COLOR = /* glsl */ `
    float capA = vWY - vMark.x;
    float capK = vMark.y * smoothstep(0.0, uCapW * 2.5, capA);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.25, 1.55, 0.8) + vec3(0.03, 0.05, 0.0), capK * 0.75);`;
const CAP_GLOW = /* glsl */ `
    float capL = vMark.y * exp(-capA * capA / (uCapW * uCapW));
    totalEmissiveRadiance += vec3(0.62, 1.0, 0.3) * (capK * 0.035 + capL * 0.75);`;

function windify(mat, U, kind) {
  const cap = kind !== 'bark';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uWind = U.uWind;
    sh.uniforms.uHRef = U.uHRef;
    sh.uniforms.uCapW = U.uCapW;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aWind;
attribute vec2 aMark;
uniform float uTime;
uniform float uWind;
uniform float uHRef;
varying vec3 vLocal;
varying vec2 vMark;
varying float vWY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vLocal = position;
vMark = aMark;
vWY = 0.0;
vec3 windOff = vec3(0.0);
#ifdef USE_INSTANCING
{
  vec3 wp = (instanceMatrix * vec4(transformed, 1.0)).xyz;
  vWY = wp.y;
  float hh = clamp(wp.y / uHRef, 0.0, 1.6);
  float a = aWind.y * hh * hh * uWind;
  windOff = vec3(sin(uTime * 1.15 + aWind.x + wp.x * 0.05) + 0.3 * sin(uTime * 2.7 + aWind.x * 2.3),
                 0.0,
                 0.45 * cos(uTime * 0.9 + aWind.x * 1.7 + wp.z * 0.05)) * a;
}
#endif`)
      .replace('#include <project_vertex>', `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition.xyz += windOff;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`)
      .replace('#include <worldpos_vertex>', `#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  vec4 worldPosition = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    worldPosition = instanceMatrix * worldPosition;
  #endif
  worldPosition.xyz += windOff;
  worldPosition = modelMatrix * worldPosition;
#endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uCapW;
varying vec3 vLocal;
varying vec2 vMark;
varying float vWY;
${GLSL_NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
${FRAG[kind]}
${cap ? CAP_COLOR : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
${cap ? CAP_GLOW : ''}`);
    if (kind === 'leaf') {
      // break the smooth ball into facets of light, as leaves do
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize(normal + (leafN - 0.5) * 1.1);`);
    }
  };
  mat.customProgramCacheKey = () => `eswm-${kind}`;
}

/* ------------------------------------------------------------------ geometry */

/** Average normals over coincident vertices, so seams in a displaced sphere do not show. */
function smoothNormals(g) {
  g.computeVertexNormals();
  const p = g.attributes.position, n = g.attributes.normal;
  const acc = new Map();
  const key = (i) => `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
  for (let i = 0; i < p.count; i++) {
    const k = key(i);
    const a = acc.get(k) || [0, 0, 0];
    a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i);
    acc.set(k, a);
  }
  for (let i = 0; i < p.count; i++) {
    const a = acc.get(key(i));
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    n.setXYZ(i, a[0] / l, a[1] / l, a[2] / l);
  }
  return g;
}

/** A lumpy unit ball with a flatter underside: one clump of foliage. */
function blobGeometry(detail) {
  const g = new THREE.SphereGeometry(1, detail ? 13 : 10, detail ? 9 : 7);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = vnoise(x * 1.7 + 3, y * 1.7, z * 1.7) * 0.55 + vnoise(x * 3.9, y * 3.9 + 7, z * 3.9) * 0.3
      + vnoise(x * 8.3 + 11, y * 8.3, z * 8.3) * 0.15;
    const k = 0.78 + 0.4 * n;
    p.setXYZ(i, x * k, y * k * (y < 0 ? 0.8 : 1), z * k);
  }
  return smoothNormals(g);
}

/** One tier of a spruce: a cone with a ragged, drooping rim. */
function coneGeometry() {
  const g = new THREE.ConeGeometry(1, 1, 14, 3, false).translate(0, 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const a = Math.atan2(z, x);
    const rim = 1 - y;                                   // 1 at the base, 0 at the tip
    const j = 0.82 + 0.34 * vnoise(Math.cos(a) * 2.2 + 5, Math.sin(a) * 2.2, y * 3);
    p.setXYZ(i, x * j, y - rim * rim * 0.14 * vnoise(a * 3 + 1, 0, 0), z * j);
  }
  return smoothNormals(g);
}

/** A trunk: unit radius at the base, 0.62 at the top, base at the origin. */
const woodGeometry = () => new THREE.CylinderGeometry(0.62, 1, 1, 9, 4, false).translate(0, 0.5, 0);
/** A straight post: stumps, cut faces, fence posts, tubes, wires and tape. */
const postGeometry = () => new THREE.CylinderGeometry(1, 1, 1, 10, 1, false).translate(0, 0.5, 0);

/** A palm frond along +x: rises, then droops, tapering, with a slight V-fold. */
function frondGeometry() {
  const S = 10;
  const pos = [], idx = [];
  for (let s = 0; s <= S; s++) {
    const u = s / S;
    const x = u, y = 0.28 * u - 0.62 * u * u;
    const w = 0.15 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.05)), 0.75) + 0.004;
    pos.push(x, y - w * 0.35, -w, x, y + 0.012, 0, x, y - w * 0.35, w);
  }
  for (let s = 0; s < S; s++) {
    const a = s * 3, b = (s + 1) * 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ batches */

/** One instanced mesh, refilled every frame. */
class Batch {
  constructor(scene, geo, mat, cap, { shadow = true } = {}) {
    this.cap = cap;
    this.wind = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aWind', this.wind);
    this.mark = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aMark', this.mark);
    const m = this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.count = 0;
    this.n = 0;
    scene.add(m);
  }

  begin() { this.n = 0; }

  push(mat4, color, phase = 0, sway = 0, markY = 0, markK = 0) {
    const i = this.n;
    if (i >= this.cap) return;
    mat4.toArray(this.mesh.instanceMatrix.array, i * 16);
    const c = this.mesh.instanceColor.array;
    c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b;
    this.wind.array[i * 2] = phase;
    this.wind.array[i * 2 + 1] = sway;
    this.mark.array[i * 2] = markY;
    this.mark.array[i * 2 + 1] = markK;
    this.n = i + 1;
  }

  end() {
    const m = this.mesh;
    m.count = this.n;
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor.needsUpdate = true;
    this.wind.needsUpdate = true;
    this.mark.needsUpdate = true;
  }
}

/*
 * The canopy a scenario took away, drawn where it would stand: a glass tree, rim-lit, with level
 * lines climbing it. A depth pass first, so only its outer surface is shaded and the overlapping
 * clumps of a crown read as one shape. Faint ghosts (still fading in) skip the depth pass, so they
 * never hide smoke or each other.
 */
const GHOST_VS = /* glsl */ `
uniform float uPass;
varying vec3 vN;
varying vec3 vP;
varying float vFade;
void main() {
#ifdef USE_INSTANCING_COLOR
  vFade = instanceColor.r;
#else
  vFade = 1.0;
#endif
  mat4 m = modelMatrix * instanceMatrix;
  vec4 p = m * vec4(position, 1.0);
  vP = p.xyz;
  vN = normalize(transpose(inverse(mat3(m))) * normal);
  gl_Position = projectionMatrix * viewMatrix * p;
  if (uPass > 0.5 && vFade < 0.4) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;
const GHOST_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uScan;
varying vec3 vN;
varying vec3 vP;
varying float vFade;
void main() {
  vec3 V = normalize(cameraPosition - vP);
  float f = 1.0 - abs(dot(normalize(vN), V));
  float scan = smoothstep(0.8, 1.0, fract(vP.y * uScan - uTime * 0.4));
  float a = vFade * (0.16 + 0.78 * f * f * f + 0.36 * scan);
  gl_FragColor = vec4(uColor * (0.9 + 0.6 * f), min(1.0, a));
}`;

class GhostBatch {
  constructor(scene, geo, cap, depth, color) {
    this.cap = cap;
    this.a = new THREE.InstancedMesh(geo, depth, cap);
    this.b = new THREE.InstancedMesh(geo, color, cap);
    this.a.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.a.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.b.instanceMatrix = this.a.instanceMatrix;
    this.b.instanceColor = this.a.instanceColor;
    this.a.renderOrder = 1;          // after the trees, among the opaque
    this.b.renderOrder = 3;
    for (const m of [this.a, this.b]) {
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
    this.n = 0;
  }

  begin() { this.n = 0; }

  push(mat4, fade) {
    const i = this.n;
    if (i >= this.cap) return;
    mat4.toArray(this.a.instanceMatrix.array, i * 16);
    this.a.instanceColor.array[i * 3] = fade;
    this.n = i + 1;
  }

  end() {
    this.a.count = this.b.count = this.n;
    this.a.instanceMatrix.needsUpdate = true;
    this.a.instanceColor.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ species */

const WOOD = 0, POST = 1, BLOB = 2, CONE = 3, FROND = 4;
const TRUNK = 0, LIMB = 1, CROWN = 2, BUTT = 3, HUB = 4;

const col = (hex) => new THREE.Color(hex);
const PAL = {
  tropical: { leaf: [0x2f6a2b, 0x3b7a31, 0x2a5d36, 0x4c7f2b, 0x35703f, 0x557f34], bark: 0x6f604f,
    emergent: [0x4e873a, 0x5b8f3c], palm: [0x3f7a2c, 0x4d8634], slender: [0x6f9455, 0x7a9c5c],
    slenderBark: 0xa9a598, palmBark: 0x7a6b58 },
  temperate: { leaf: [0x4f8a32, 0x5d9438, 0x467c2f, 0x6a9a3c, 0x3f7430], bark: 0x55412f,
    conifer: [0x2b5241, 0x305a45, 0x24493a], coniferBark: 0x4a3527, slender: [0x7ea14a], slenderBark: 0x8c8172 },
  boreal: { leaf: [0x2b5241], bark: 0x4a3527, conifer: [0x22473a, 0x2a5040, 0x1f3f33, 0x2d4f3a],
    coniferBark: 0x45342a, birch: [0x9cba4c, 0xa8c157, 0x8fb046], birchBark: 0xdedad0 },
};

const GROUND = {
  tropical: { a: 0x3a2a1c, b: 0x4a3423, c: 0x34452a, under: 'fern' },
  temperate: { a: 0x55402b, b: 0x6b5232, c: 0x5c6e33, under: 'shrub' },
  boreal: { a: 0x6d7444, b: 0x8b8f62, c: 0x4a4a2e, under: 'moss' },
};

const MIX = {
  tropical: [['emergent', 0.1], ['broad', 0.62], ['palm', 0.2], ['slender', 0.08]],
  temperate: [['broad', 0.64], ['conifer', 0.3], ['slender', 0.06]],
  boreal: [['conifer', 0.78], ['birch', 0.22]],
};

// relative height of each kind of tree in the stand, before the stand is normalized to mean 1
const REL = {
  emergent: [1.36, 1.55], broad: [0.88, 1.08], palm: [0.5, 0.72], slender: [0.86, 1.04],
  conifer: [0.86, 1.1], birch: [0.74, 0.94],
};

const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _e0 = new THREE.Euler();
const Y_UP = new THREE.Vector3(0, 1, 0);

function partM(x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  return new THREE.Matrix4().compose(_v0.set(x, y, z), _q0.setFromEuler(_e0.set(rx, ry, rz)), _v1.set(sx, sy, sz));
}

function cylBetween(a, b, r) {
  _v2.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _v2.length();
  _q0.setFromUnitVectors(Y_UP, _v2.normalize());
  return new THREE.Matrix4().compose(_v0.set(a[0], a[1], a[2]), _q0, _v1.set(r, len, r));
}

/**
 * A tree in tree units: base at the origin, top at y = 1. `parts` are batched shapes with their
 * local matrices; the tree is scaled to its height and capped width when drawn.
 */
function template(kind, biome, rand) {
  const parts = [];
  const pal = PAL[biome];
  const pick = (arr) => col(arr[Math.floor(rand() * arr.length)]);
  const jitter = (c, s = 1) => c.offsetHSL((rand() - 0.5) * 0.03 * s, (rand() - 0.5) * 0.1 * s, (rand() - 0.5) * 0.08 * s);
  const add = (b, role, m, c) => parts.push({ b, role, m, c });
  let trunkR = 0.016, crownR = 0.2;

  if (kind === 'broad') {
    const Rc = crownR = (biome === 'tropical' ? 0.235 : 0.25) * (0.86 + rand() * 0.28);
    const leaf = jitter(pick(pal.leaf));
    const bark = jitter(col(pal.bark), 0.5);
    const cy = 1 - Rc * 0.95;
    const th = cy - Rc * 0.2;
    trunkR = 0.016;
    add(WOOD, TRUNK, partM(0, 0, 0, trunkR, th, trunkR), bark);
    for (let k = 0; k < 3; k++) {
      const a = rand() * Math.PI * 2;
      add(WOOD, LIMB, cylBetween([0, th * 0.8, 0], [Math.cos(a) * Rc * 0.62, cy - Rc * 0.15, Math.sin(a) * Rc * 0.62], trunkR * 0.42), bark);
    }
    add(BLOB, CROWN, partM(0, cy, 0, Rc * 0.8, Rc * 0.64, Rc * 0.8, 0, rand() * 6, 0), leaf);
    const n = 7;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rand() * 0.6;
      const d = Rc * (0.56 + rand() * 0.18), r = Rc * (0.42 + rand() * 0.16);
      add(BLOB, CROWN, partM(Math.cos(a) * d, cy + (rand() - 0.45) * Rc * 0.36, Math.sin(a) * d, r, r * 0.82, r,
        rand() * 6, rand() * 6, 0), jitter(leaf.clone(), 0.6));
    }
    for (let k = 0; k < 3; k++) {                    // the crown's lower skirt
      const a = (k / 3) * Math.PI * 2 + rand();
      const r = Rc * (0.36 + rand() * 0.12);
      add(BLOB, CROWN, partM(Math.cos(a) * Rc * 0.42, cy - Rc * 0.42, Math.sin(a) * Rc * 0.42, r, r * 0.7, r, 0, rand() * 6, 0),
        jitter(leaf.clone().multiplyScalar(0.85), 0.6));
    }
    add(BLOB, CROWN, partM((rand() - 0.5) * Rc * 0.2, 1 - Rc * 0.42, (rand() - 0.5) * Rc * 0.2, Rc * 0.52, Rc * 0.42, Rc * 0.52, 0, rand() * 6, 0), jitter(leaf.clone(), 0.6));
  } else if (kind === 'emergent') {
    const Rc = crownR = 0.3 * (0.9 + rand() * 0.2);
    const leaf = jitter(pick(pal.emergent));
    const bark = jitter(col(pal.bark).offsetHSL(0, -0.05, 0.06), 0.5);
    const top = 1 - 0.07;
    const th = top - 0.12;
    trunkR = 0.02;
    add(WOOD, TRUNK, partM(0, 0, 0, trunkR, th + 0.02, trunkR), bark);
    for (let k = 0; k < 4; k++) {                    // buttress roots
      const a = (k / 4) * Math.PI * 2 + rand() * 0.6;
      add(WOOD, BUTT, cylBetween([Math.cos(a) * 0.06, 0, Math.sin(a) * 0.06], [0, 0.085, 0], trunkR * 0.55), bark);
    }
    const n = 8;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rand() * 0.5;
      const d = Rc * (0.35 + rand() * 0.6), r = Rc * (0.3 + rand() * 0.14);
      const x = Math.cos(a) * d, z = Math.sin(a) * d, y = top - 0.02 + (rand() - 0.5) * 0.03;
      if (k % 2 === 0) add(WOOD, LIMB, cylBetween([0, th - 0.01, 0], [x * 0.85, y - 0.015, z * 0.85], trunkR * 0.36), bark);
      add(BLOB, CROWN, partM(x, y, z, r, r * 0.5, r, rand() * 0.3, rand() * 6, 0), jitter(leaf.clone(), 0.7));
    }
    add(BLOB, CROWN, partM(0, top + 0.015, 0, Rc * 0.42, Rc * 0.26, Rc * 0.42), jitter(leaf.clone(), 0.5));
  } else if (kind === 'palm') {
    crownR = 0.3;
    trunkR = 0.012;
    const bark = jitter(col(pal.palmBark), 0.5);
    const leaf = jitter(pick(pal.palm));
    const lean = (rand() - 0.5) * 0.12;
    const pts = [[0, 0, 0], [lean * 0.3, 0.33, 0], [lean * 0.75, 0.62, 0], [lean, 0.88, 0]];
    for (let k = 0; k < 3; k++) add(WOOD, TRUNK, cylBetween(pts[k], pts[k + 1], trunkR * (1 - k * 0.12)), bark);
    const [tx, ty] = [lean, 0.88];
    const n = 10;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rand() * 0.4;
      const L = 0.26 + rand() * 0.08;
      const pitch = 0.35 + rand() * 0.55;
      add(FROND, CROWN, partM(tx, ty, 0, L, L, L, 0, a, pitch), jitter(leaf.clone(), 0.6));
    }
    add(BLOB, HUB, partM(tx, ty, 0, 0.03, 0.05, 0.03), col(0x4a5a2a));
  } else if (kind === 'slender') {
    crownR = 0.13;
    trunkR = 0.0095;
    const bark = jitter(col(biome === 'tropical' ? pal.slenderBark : pal.slenderBark), 0.4);
    const leaf = jitter(pick(pal.slender));
    const th = 0.8;
    add(WOOD, TRUNK, partM(0, 0, 0, trunkR, th, trunkR), bark);
    const n = 3 + Math.floor(rand() * 2);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rand() * 0.7;
      const x = Math.cos(a) * 0.1, z = Math.sin(a) * 0.1, y = 0.9 + rand() * 0.06;
      add(WOOD, LIMB, cylBetween([0, th - 0.06, 0], [x, y - 0.02, z], trunkR * 0.55), bark);
      add(BLOB, CROWN, partM(x, y, z, 0.085, 0.05, 0.085, rand() * 0.4, rand() * 6, 0), jitter(leaf.clone(), 0.5));
    }
  } else if (kind === 'conifer') {
    crownR = 0.15;
    trunkR = 0.014;
    const leaf = jitter(pick(pal.conifer));
    const bark = jitter(col(pal.coniferBark), 0.4);
    add(WOOD, TRUNK, partM(0, 0, 0, trunkR, 0.97, trunkR), bark);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const y0 = 0.1 + i * 0.142;
      const r = (0.155 - i * 0.021) * (0.9 + rand() * 0.2);
      add(CONE, CROWN, partM(0, y0, 0, r, 0.27 - i * 0.012, r, 0, rand() * 6, 0), jitter(leaf.clone(), 0.5));
    }
  } else {                                            // birch
    crownR = 0.11;
    trunkR = 0.0095;
    const leaf = jitter(pick(pal.birch));
    const bark = jitter(col(pal.birchBark), 0.3);
    add(WOOD, TRUNK, partM(0, 0, 0, trunkR, 0.86, trunkR), bark);
    for (let k = 0; k < 2; k++) {
      const a = rand() * Math.PI * 2;
      add(WOOD, LIMB, cylBetween([0, 0.52, 0], [Math.cos(a) * 0.06, 0.7, Math.sin(a) * 0.06], trunkR * 0.45), bark);
    }
    const ys = [0.6, 0.71, 0.81, 0.9];
    for (const y of ys) {
      const r = 0.075 + rand() * 0.02;
      add(BLOB, CROWN, partM((rand() - 0.5) * 0.05, y, (rand() - 0.5) * 0.05, r, r * 1.25, r, 0, rand() * 6, 0), jitter(leaf.clone(), 0.6));
    }
  }
  for (const p of parts) p.m.toArray(p.a = new Float32Array(16));
  // the crown's top, in tree units: where growth beyond the no-action stand starts to show
  const boxes = partBoxes();
  let top = 0;
  for (const p of parts) {
    if (p.role === CROWN || p.role === HUB) top = Math.max(top, _box.copy(boxes[p.b]).applyMatrix4(p.m).max.y);
  }
  return { parts, trunkR, crownR, top: top || 1 };
}

const _box = new THREE.Box3();
let _boxes = null;
/** Each batch shape's bounds in its own units, measured once. */
function partBoxes() {
  if (_boxes) return _boxes;
  _boxes = [];
  for (const [b, g] of [[WOOD, woodGeometry()], [POST, postGeometry()], [BLOB, blobGeometry(true)], [CONE, coneGeometry()], [FROND, frondGeometry()]]) {
    g.computeBoundingBox();
    _boxes[b] = g.boundingBox.clone();
    g.dispose();
  }
  return _boxes;
}

/* ------------------------------------------------------------------ layout */

/** The biome a cell's stand is drawn as: latitude only, as in stand.js. */
export function biomeOf(cell) {
  const lat = Math.abs((cell && cell.lat) || 0);
  return lat < 23.5 ? 'tropical' : lat < 50 ? 'temperate' : 'boreal';
}

/**
 * A plot of forest for this site. Hc is the stand's own height scale (the peak of its no-action
 * canopy), which sets the plot's size so a 13 m boreal stand and a 30 m rainforest both fill it.
 */
export function makeLayout(cell, Hc, { light = false } = {}) {
  const biome = biomeOf(cell);
  const rand = rng(((cell && cell.id) || 0) * 2654435761 + 11);
  const W = Math.max(18, Math.min(62, Hc * 1.55));
  const D = W * 0.6;
  const nx = light ? 7 : 9, nz = light ? 5 : 6;
  const sx = W / nx, sz = D / nz;
  const mix = MIX[biome];
  const trees = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      let u = rand(), kind = mix[0][0];
      for (const [k, p] of mix) { if (u < p) { kind = k; break; } u -= p; }
      const [r0, r1] = REL[kind];
      const t = template(kind, biome, rand);
      trees.push({
        kind, ...t,
        x: -W / 2 + sx * (ix + 0.5) + (rand() - 0.5) * sx * 0.62,
        z: -D / 2 + sz * (iz + 0.5) + (rand() - 0.5) * sz * 0.55,
        r: r0 + (r1 - r0) * rand(),
        yaw: rand() * Math.PI * 2,
        phase: rand() * 6.283,
        fall: rand() * Math.PI * 2,
        lean: rand() * 0.06,
        leanDir: rand() * Math.PI * 2,
        seed: Math.floor(rand() * 1e9),
      });
    }
  }
  const mean = trees.reduce((s, t) => s + t.r, 0) / trees.length;
  for (const t of trees) t.r /= mean;

  // the understory: ferns or shrubs, a few rocks, an old fallen log or two
  const under = [];
  const nU = light ? 20 : 32;
  for (let k = 0; k < nU; k++) {
    under.push({
      kind: rand() < 0.16 ? 'rock' : GROUND[biome].under,
      x: (rand() - 0.5) * W * 0.94, z: (rand() - 0.5) * D * 0.92,
      s: 0.6 + rand() * 0.8, yaw: rand() * 6.28, seed: Math.floor(rand() * 1e9),
      c: col(biome === 'boreal' ? 0x5c6a34 : biome === 'temperate' ? 0x557d30 : 0x2f6a2c).offsetHSL((rand() - 0.5) * 0.04, (rand() - 0.5) * 0.15, (rand() - 0.5) * 0.08),
    });
  }
  const logs = [];
  for (let k = 0; k < (light ? 1 : 2); k++) {
    logs.push({ x: (rand() - 0.5) * W * 0.7, z: (rand() - 0.5) * D * 0.6, yaw: rand() * 6.28, L: W * (0.12 + rand() * 0.08) });
  }
  // young trees under the canopy: scenery that fills the trunk space, never counted in the mean
  const spacing = Math.sqrt(sx * sz);
  const young = [];
  const nY = light ? 8 : 16;
  for (let k = 0, tries = 0; k < nY && tries < 400; tries++) {
    const x = (rand() - 0.5) * W * 0.92, z = (rand() - 0.5) * D * 0.9;
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < spacing * 0.34)) continue;
    const u = rand();
    const kind = biome === 'boreal' ? (u < 0.6 ? 'conifer' : 'birch') : biome === 'temperate' ? (u < 0.75 ? 'broad' : 'conifer') : (u < 0.55 ? 'broad' : 'palm');
    young.push({ kind, ...template(kind, biome, rand), x, z, r: 0.17 + rand() * 0.17, yaw: rand() * 6.28, phase: rand() * 6.28, seed: Math.floor(rand() * 1e9) });
    k++;
  }
  return { cell, biome, W, D, Hc, sx, sz, spacing, trees, young, under, logs, wCap: Hc * 1.05 };
}

/* ------------------------------------------------------------------ the scenario's plan */

const EVENT = {
  thin: { from: -1, to: 0.35, ms: 2000 },
  log: { from: -1, to: 0.5, ms: 2700 },
  fire: { from: -1, to: 0.35, ms: 3300 },
  replant: { from: -1, to: 0, ms: 1400 },
  protect: { from: -1, to: 0, ms: 1100 },
};

/** The slowed stretch of the timeline in which this scenario's action happens, or null. */
export function eventWindow(kind, Y) {
  const e = EVENT[kind];
  if (!e || !Number.isFinite(Y)) return null;
  return { t0: Math.max(0, Y + e.from), t1: Math.min(40, Y + e.to), ms: e.ms };
}

/** Which trees go first. A harvest takes a patch, a fire sweeps from one side, a thinning picks. */
function orderFor(L, kind) {
  const idx = L.trees.map((_, i) => i);
  const { W, D } = L;
  const score = idx.map((i) => {
    const t = L.trees[i];
    const n = hash(t.seed);
    if (kind === 'log') {
      const dx = (t.x - W * 0.12) / W, dz = (t.z - D * 0.5) / D;
      return Math.hypot(dx * 1.1, dz * 1.35) + n * 0.08;
    }
    if (kind === 'fire') return t.x / W + (n - 0.5) * 0.24 - (t.z / D) * 0.12;
    // thinning: a scatter, leaning to the front where it can be seen, sparing the emergents
    return n - 0.45 * (t.z / D) + (t.kind === 'emergent' ? 2 : 0);
  });
  idx.sort((a, b) => score[a] - score[b]);
  if (kind !== 'thin') return idx;
  // keep thinned trees apart from each other
  const out = [];
  const rest = idx.slice();
  while (rest.length) {
    let best = 0, bestD = -1;
    for (let k = 0; k < Math.min(rest.length, 8); k++) {
      const t = L.trees[rest[k]];
      let d = Infinity;
      for (const j of out) d = Math.min(d, Math.hypot(t.x - L.trees[j].x, t.z - L.trees[j].z));
      const s = Math.min(d, L.spacing * 2.2) - k * 0.15 * L.spacing;
      if (s > bestD) { bestD = s; best = k; }
    }
    out.push(rest.splice(best, 1)[0]);
  }
  return out;
}

/**
 * Turn a scenario's predicted heights into what happens on the plot.
 *   s = { free, act, kind, Y, span }  (heights in metres; Y the action year, span for ramps)
 */
export function planScenario(L, s) {
  const N = L.trees.length;
  const p = {
    free: s.free, act: s.act, kind: s.kind, Y: s.Y, span: s.span ?? null,
    gone: new Int8Array(N).fill(-1),    // index into `felled`, or -1
    felled: [], mode: null, sumStanding: N, props: [],
  };
  if (!s.act) return p;
  const single = (s.kind === 'thin' || s.kind === 'log' || s.kind === 'fire') && Number.isFinite(s.Y);
  if (single) {
    const Y = s.Y;
    const fe = Math.max(0, 1 - s.act[Y] / s.free[Y]);
    const order = orderFor(L, s.kind);
    const goal = fe * N;                       // the trees' relative heights sum to N
    let acc = 0, m = 0;
    while (m < order.length - 1 && acc + L.trees[order[m]].r * 0.5 < goal) { acc += L.trees[order[m]].r; m++; }
    p.mode = s.kind === 'fire' ? 'burn' : 'cut';
    p.sumStanding = N - acc;
    const t0 = Y - 1;
    // a harvest fells into its own clearing; everything falls away from the viewer
    let cx = 0, cz = 0;
    for (let q = 0; q < m; q++) { cx += L.trees[order[q]].x / m; cz += L.trees[order[q]].z / m; }
    for (let q = 0; q < m; q++) {
      const i = order[q];
      const tr = L.trees[i];
      const u = m > 1 ? q / (m - 1) : 0;
      const f = { i, q, u };
      if (p.mode === 'cut') {
        f.mark = t0 + 0.03 + 0.12 * u;
        f.fall = t0 + (s.kind === 'log' ? 0.2 + 0.62 * u : 0.24 + 0.56 * u);
        f.dur = s.kind === 'log' ? 0.13 : 0.15;
        f.haul = Y + 0.04 + 0.26 * u;
        let dx = s.kind === 'log' ? cx - tr.x : (hash(tr.seed + 11) - 0.5) * 2;
        if (Math.abs(dx) < 0.3) dx = hash(tr.seed + 13) < 0.5 ? -1 : 1;
        const dz = -(0.35 + 0.65 * hash(tr.seed + 17)) * Math.abs(dx);
        f.dir = Math.atan2(dz, dx) + (hash(tr.seed + 19) - 0.5) * 0.4;
        const len = tr.r * Math.max(...s.free) * 0.95;
        if (Math.abs(tr.x + Math.cos(f.dir) * len) > L.W / 2) f.dir = Math.PI - f.dir;
        if (tr.z + Math.sin(f.dir) * len < -L.D / 2 - 1) {
          const sx = Math.sign(Math.cos(f.dir)) || 1;
          f.dir = Math.atan2(-Math.max(0, tr.z + L.D / 2 + 1) / len, sx * 0.9);
        }
      } else {
        f.ignite = t0 + 0.08 + 0.58 * u;
        // snags stand for years; some are still up decades later
        f.snagFall = Y + 4 + 22 * hash(tr.seed + 3);
      }
      // the gap regrows next to its stump, at whatever height the model leaves it
      const a = hash(tr.seed + 5) * Math.PI * 2;
      f.rx = tr.x + Math.cos(a) * L.spacing * 0.28;
      f.rz = tr.z + Math.sin(a) * L.spacing * 0.28;
      f.rk = 0.82 + 0.36 * hash(tr.seed + 7);
      p.gone[i] = p.felled.length;
      p.felled.push(f);
    }
    // the flagging tape around a harvest: the patch's bounding box, a little outside it
    if (s.kind === 'log' && m) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const f of p.felled) {
        const t = L.trees[f.i];
        x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x); z0 = Math.min(z0, t.z); z1 = Math.max(z1, t.z);
      }
      const pad = L.spacing * 0.45;
      p.tape = [Math.max(-L.W / 2 + 0.3, x0 - pad), Math.min(L.W / 2 - 0.3, x1 + pad),
        Math.max(-L.D / 2 + 0.3, z0 - pad), Math.min(L.D / 2 - 0.3, z1 + pad)];
    }
  }
  if (s.kind === 'replant' && Number.isFinite(s.Y)) {
    // three planting lines, skipping spots too close to a trunk
    const rand = rng(L.cell.id * 31 + 7);
    const rows = [-0.22, 0.06, 0.33];
    let k = 0;
    for (const rz of rows) {
      for (let x = -L.W / 2 + L.spacing * 0.6; x < L.W / 2 - L.spacing * 0.4; x += L.spacing * 0.78) {
        const px = x + (rand() - 0.5) * 0.5, pz = rz * L.D + (rand() - 0.5) * 0.6;
        if (L.trees.some((t) => Math.hypot(t.x - px, t.z - pz) < L.spacing * 0.32)) continue;
        p.props.push({ type: 'sapling', x: px, z: pz, k: k++, j: 0.8 + rand() * 0.4, yaw: rand() * 6.28 });
      }
    }
    for (const pr of p.props) pr.u = pr.k / Math.max(1, k - 1);
  }
  if (s.kind === 'protect' && Number.isFinite(s.Y)) {
    const posts = [];
    const ins = 0.6;
    const per = 2 * (L.W + L.D);
    const n = Math.round(per / Math.max(3, L.spacing * 0.9));
    for (let k = 0; k < n; k++) {
      let d = (k / n) * per;
      let x, z;
      const w = L.W - 2 * ins, dd = L.D - 2 * ins;
      if (d < w) { x = -w / 2 + d; z = dd / 2; } else if ((d -= w) < dd) { x = w / 2; z = dd / 2 - d; } else if ((d -= dd) < w) { x = w / 2 - d; z = -dd / 2; } else { d -= w; x = -w / 2; z = -dd / 2 + d; }
      posts.push({ type: 'post', x, z, u: k / n });
    }
    p.props = posts;
  }
  return p;
}

/* ------------------------------------------------------------------ the forest */

const _m = new THREE.Matrix4(), _mt = new THREE.Matrix4(), _mp = new THREE.Matrix4();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _qf = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _c = new THREE.Color(), _c2 = new THREE.Color();
const CHAR = col(0x1d1916), EMBER = col(0xff5a14), SCORCH = col(0x6b3a1c), CUT = col(0xdcbb8b), OLD_CUT = col(0x8e7f6c);
const SLASH = col(0x7a5a3a), TUBE = col(0xe2e9de), SAPLING = col(0x86c24f), POSTC = col(0x8b6b47), WIRE = col(0xa7adb3);
const PAINT = col(0xff7a1a), TAPE = col(0xff4f1f), ROCK = col(0x7d7a72), LOGC = col(0x5a4636), MOSS = col(0x4c6b34);
const PICK = col(0xff9d52);
const BARE = col(0x6a4a30), BARE_B = col(0x5e4a33), GREEN = col(0x5f7d34), GREEN_B = col(0x7d8a4c);
const NO_MARK = [0, 0];

export class Forest {
  constructor(scene, { light = false } = {}) {
    this.scene = scene;
    this.light = light;
    this.U = {
      uTime: { value: 0 }, uWind: { value: 0.35 }, uHRef: { value: 30 }, uCapW: { value: 0.3 },
      uGhost: { value: new THREE.Color(0xb4f5e6) }, uScan: { value: 1 },
    };
    const wood = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    const leaf = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0 });
    const frond = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
    windify(wood, this.U, 'bark');
    windify(leaf, this.U, 'leaf');
    windify(frond, this.U, 'frond');
    const capT = light ? 1 : 1.6;
    this.batch = [
      new Batch(scene, woodGeometry(), wood, Math.round(2400 * capT)),
      new Batch(scene, postGeometry(), wood, Math.round(1100 * capT)),
      new Batch(scene, blobGeometry(!light), leaf, Math.round(3000 * capT)),
      new Batch(scene, coneGeometry(), leaf, Math.round(900 * capT)),
      new Batch(scene, frondGeometry(), frond, Math.round(1500 * capT)),
    ];
    // one program for both passes (only uniforms differ), so the colour pass meets the depth exactly
    const ghost = (pass) => new THREE.ShaderMaterial({
      uniforms: { uPass: { value: pass }, uColor: this.U.uGhost, uTime: this.U.uTime, uScan: this.U.uScan },
      vertexShader: GHOST_VS, fragmentShader: GHOST_FS,
      transparent: !pass, depthWrite: !!pass, colorWrite: !pass, depthFunc: THREE.LessEqualDepth,
    });
    const gf = ghost(1), gb = ghost(0);
    const capG = light ? 700 : 1400;
    this.ghost = [];
    for (const [b, n] of [[WOOD, capG], [BLOB, capG], [CONE, capG / 2], [FROND, capG]]) {
      this.ghost[b] = new GhostBatch(scene, this.batch[b].mesh.geometry, n, gf, gb);
    }
    this.plots = [new Plot(scene), new Plot(scene)];
    this._mk = NO_MARK;
  }

  setLayout(L, hTop) {
    this.L = L;
    this.U.uHRef.value = Math.max(8, L.Hc);
    this.U.uCapW.value = 0.3 * Math.max(0.6, L.Hc / 30);
    this.U.uScan.value = 1.6 / Math.max(0.6, L.Hc / 30);
    for (const p of this.plots) p.build(L, hTop);
  }

  begin() { for (const b of this.batch) b.begin(); for (const g of this.ghost) g?.begin(); }
  end() { for (const b of this.batch) b.end(); for (const g of this.ghost) g?.end(); }

  /** Draw one plot at time t. `o` is the plot's origin; `plan` its scenario (or the free run). */
  pose(k, o, plan, t, fx, dt, opts = {}) {
    const L = this.L;
    if (!L) return;
    const plot = this.plots[k];
    const Hf = at(plan.free, t);
    const Ha = plan.act ? at(plan.act, t) : Hf;
    const Y = plan.Y;
    const S = Math.max(0.6, L.Hc / 30);              // stumps and slash: tied to the trees' own size
    const P = Math.max(1.3, L.Hc / 15);              // illustrative props, drawn large enough to read

    // how tall the standing trees are, and how tall the regrowth in the gaps (see the header)
    let kStand = Hf > 1e-6 ? Ha / Hf : 1;
    let regrow = 0;
    if (plan.mode) {
      if (t < Y) kStand = 1;
      else {
        const N = L.trees.length;
        const R = N * Ha - Hf * plan.sumStanding;
        if (R >= 0) { kStand = 1; regrow = plan.felled.length ? R / plan.felled.length : 0; } else kStand = (N * Ha) / (Hf * plan.sumStanding);
      }
    }

    // what the difference looks like on the trees: a lime cap where the stand outgrew no action,
    // a ghost where it fell short of it (every standing tree, if they all came out shorter)
    const gain = kStand > 1 ? clamp01((kStand - 1) / 0.025) : 0;
    const short = kStand < 0.985 ? 0.7 * clamp01((1 - kStand) / 0.05) : 0;

    const fire = { x: 0, y: 0, z: 0, w: 0 };
    for (let i = 0; i < L.trees.length; i++) {
      const tr = L.trees[i];
      const g = plan.gone[i];
      const f = g >= 0 ? plan.felled[g] : null;
      const bx = o.x + tr.x, bz = o.z + tr.z, by = o.y;
      const h0 = tr.r * Hf;
      if (!f) {
        if (gain) this._mk = [by + tr.top * h0, gain];
        this._tree(tr, bx, by, bz, Math.max(0.05, h0 * kStand), 1, 0, null, 1);
        this._mk = NO_MARK;
        if (short) this._ghostTree(tr, bx, by, bz, h0, short);
        continue;
      }
      // the tree it would have been, once this one is down
      const gone = plan.mode === 'cut' ? smooth(f.fall + f.dur * 0.6, f.fall + f.dur + 0.3, t)
        : smooth(f.ignite + 0.1, f.ignite + 0.42, t);
      if (gone > 0) this._ghostTree(tr, bx, by, bz, h0, gone);

      if (plan.mode === 'cut') {
        const hCut = tr.r * at(plan.free, f.fall);
        const sh = this._stumpH(hCut, S);
        const stump = t >= f.fall;
        if (t < f.fall) {
          // trees chosen for the cut are picked out first: paint for a thinning, the patch for a harvest
          const pick = plan.kind === 'thin' ? smooth(f.mark, f.mark + 0.06, t) : smooth(Y - 1, Y - 0.92, t);
          this._tree(tr, bx, by, bz, Math.max(0.05, h0), 1, 0, null, 1, null, pick * 0.42);
          if (t >= f.mark && plan.kind === 'thin') this._mark(tr, bx, by, bz, hCut, smooth(f.mark, f.mark + 0.06, t), P);
        } else if (t < f.haul + 0.22) {
          // the bole hinges on its stump, accelerates, lands with a small rebound
          const p = (t - f.fall) / f.dur;
          const ang = p < 1 ? (Math.PI / 2 - 0.05) * Math.pow(p, 2.4)
            : (Math.PI / 2 - 0.05) - 0.06 * Math.sin(Math.PI * clamp01((p - 1) / 0.35)) * (p < 1.35 ? 1 : 0);
          const shrink = 1 - smooth(f.haul, f.haul + 0.22, t);
          if (shrink > 0.01) this._tree(tr, bx, by + sh, bz, Math.max(0.1, hCut - sh), shrink, ang, f.dir, 0);
          // the landing: a cloud of dust along the bole
          if (fx && opts.live && f._landed !== true && p >= 1 && p < 1.6) {
            f._landed = true;
            const dx = Math.cos(f.dir), dz = Math.sin(f.dir);
            for (let n = 0; n < 14; n++) {
              const d = (0.35 + 0.65 * Math.random()) * hCut;
              fx.emit('dust', bx + dx * d, by + 0.4 * S, bz + dz * d, { s: 1.6, s1: 5.5 });
            }
          }
          if (fx && opts.live && f._chips !== true && p >= 0 && p < 0.5) {
            f._chips = true;
            for (let n = 0; n < 10; n++) fx.emit('chip', bx, by + 0.7 * S, bz);
          }
        }
        if (t < f.fall - 0.02) { f._landed = false; f._chips = false; }
        if (stump) {
          this._stump(tr, bx, by, bz, hCut, t - f.fall, S);
          if (t > f.haul + 0.12) this._slash(tr, f.dir, bx, by, bz, hCut, t - f.haul, S);
        }
      } else {
        // a burn: ignite, flame up the crown, char, stand as a snag, fall years later, decay
        const hFire = tr.r * at(plan.free, f.ignite);
        const u = (t - f.ignite) / 0.32;
        if (u < 0) this._tree(tr, bx, by, bz, Math.max(0.05, h0), 1, 0, null, 1);
        else if (u < 1) {
          const burn = { char: smooth(0.08, 0.6, u), lit: Math.sin(Math.PI * clamp01(u / 0.7)), crown: 1 - smooth(0.22, 0.78, u) };
          this._tree(tr, bx, by, bz, hFire * (1 - 0.26 * smooth(0.3, 0.85, u)), 1, 0, null, 0.4, burn);
          const I = smooth(0, 0.12, u) * (1 - smooth(0.6, 1, u));
          fire.x += bx * I; fire.y += (by + hFire * 0.6) * I; fire.z += bz * I; fire.w += I;
          if (fx && opts.live && dt > 0) this._flames(tr, bx, by, bz, hFire, I, fx, dt);
        } else {
          const snagH = hFire * 0.74;
          const pf = (t - f.snagFall) / 0.55;
          if (pf < 0) this._snag(tr, bx, by, bz, snagH, 0, 1);
          else {
            const ang = (Math.PI / 2 - 0.04) * Math.pow(clamp01(pf), 2.2);
            const decay = 1 - smooth(f.snagFall + 2, f.snagFall + 12, t);
            if (decay > 0.02) this._snag(tr, bx, by, bz, snagH, ang, decay);
          }
          if (fx && opts.live && dt > 0 && u < 1.8 && Math.random() < dt * 9) {
            fx.emit('smoke', bx, by + snagH * 0.7, bz, { s: 1.4, s1: 7, life: 3 });
          }
        }
      }
      // the regrowth the model allows, in the gap
      if (t >= Y && regrow > 0.3) this._regrow(tr, o.x + f.rx, by, o.z + f.rz, regrow * f.rk);
    }

    // the understory: shrinks under a harvest or a fire and comes back over a few years
    for (const y of L.young) {
      const { k, burnt } = this._hit(y, plan, t);
      if (k < 0.04 || burnt > 0.5) continue;
      const h = Math.max(0.05, y.r * Hf * Math.min(1, kStand));
      this._tree(y, o.x + y.x, o.y, o.z + y.z, h, k, 0, null, 0.7);
    }
    for (const u of L.under) this._under(u, o, plan, t, Hf, S);
    for (const lg of L.logs) this._oldLog(lg, o, S);

    // the action's own props
    if (plan.tape) this._tape(plan, o, t, P);
    for (const pr of plan.props || []) this._prop(pr, plan, o, t, P);

    plot.paint(plan, t, L);
    if (fire.w > 0) { fire.x /= fire.w; fire.y /= fire.w; fire.z /= fire.w; }
    return { Hf, Ha, fire };
  }

  /* -- drawing helpers. Each writes into the batches; the matrices are tree -> world. */

  _treeMatrix(tr, bx, by, bz, h, shrink, ang, dir) {
    const w = Math.min(h, this.L.wCap);
    _mt.makeRotationY(tr.yaw);
    _m.compose(_p.set(0, 0, 0), _q.identity(), _s.set(w * shrink, h * shrink, w * shrink));
    _mt.multiply(_m);                                  // R_y · S
    if (ang) {
      _axis.set(Math.sin(dir), 0, -Math.cos(dir));     // fall towards (cos dir, 0, sin dir)
      _qf.setFromAxisAngle(_axis, ang);
      _mt.premultiply(_mp.makeRotationFromQuaternion(_qf));
    }
    _mt.premultiply(_mp.makeTranslation(bx, by, bz));
    return _mt;
  }

  /** The no-action twin of a tree, as a ghost: `fade` from 0 (none) to 1. */
  _ghostTree(tr, bx, by, bz, h, fade) {
    const M = this._treeMatrix(tr, bx, by, bz, h, 1, tr.lean || 0, tr.leanDir || 0);
    for (const p of tr.parts) {
      const G = this.ghost[p.b];
      if (G) G.push(_mp.multiplyMatrices(M, _m.fromArray(p.a)), fade);
    }
  }

  _tree(tr, bx, by, bz, h, shrink, ang, dir, sway, burn = null, pick = 0) {
    const M = ang ? this._treeMatrix(tr, bx, by, bz, h, shrink, ang, dir)
      : this._treeMatrix(tr, bx, by, bz, h, shrink, tr.lean || 0, tr.leanDir || 0);
    const B = this.batch;
    const swayAmt = ang ? 0 : sway;
    const [mY, mK] = this._mk;
    for (const p of tr.parts) {
      if (burn && (p.role === CROWN || p.role === HUB)) {
        if (burn.crown < 0.02) continue;
        _m.fromArray(p.a);
        // the crown shrinks towards its own centre as it burns away
        const k = burn.crown;
        _p.setFromMatrixPosition(_m);
        _m.scale(_s.set(k, k, k));
        _m.setPosition(_p);
        _c.copy(p.c).lerp(EMBER, burn.lit * 0.75).lerp(CHAR, burn.char);
        B[p.b].push(_mp.multiplyMatrices(M, _m), _c, tr.phase, swayAmt);
        continue;
      }
      if (burn && p.role === LIMB) {
        _c.copy(p.c).lerp(CHAR, burn.char);
        B[p.b].push(_mp.multiplyMatrices(M, _m.fromArray(p.a)), _c, tr.phase, swayAmt);
        continue;
      }
      if (burn) {
        _c.copy(p.c).lerp(SCORCH, burn.lit * 0.5).lerp(CHAR, burn.char);
        B[p.b].push(_mp.multiplyMatrices(M, _m.fromArray(p.a)), _c, tr.phase, swayAmt);
        continue;
      }
      const c = pick > 0 && (p.role === CROWN || p.role === HUB) ? _c.copy(p.c).lerp(PICK, pick) : p.c;
      B[p.b].push(_mp.multiplyMatrices(M, _m.fromArray(p.a)), c, tr.phase, swayAmt, mY, mK);
    }
  }

  /** A burnt tree left standing: the bole, blackened, with two broken limbs. */
  _snag(tr, bx, by, bz, h, ang, decay) {
    const M = this._treeMatrix(tr, bx, by, bz, h, decay, ang, -Math.PI / 2 + (hash(tr.seed + 23) - 0.5) * 1.8);
    const B = this.batch;
    const trunk = tr.parts.find((p) => p.role === TRUNK);
    _m.fromArray(trunk.a);
    _c.copy(CHAR).offsetHSL(0, 0, (hash(tr.seed) - 0.5) * 0.04);
    // stretch the template's trunk to the snag's full height
    const e = _m.elements;
    const sy = Math.hypot(e[4], e[5], e[6]) || 1;
    _m.scale(_s.set(1, 1 / sy, 1));
    B[WOOD].push(_mp.multiplyMatrices(M, _m), _c, tr.phase, 0);
    const r = tr.trunkR;
    for (let k = 0; k < 2; k++) {
      const a = tr.yaw + k * 2.4;
      _m.copy(cylBetween([0, 0.62 + k * 0.14, 0], [Math.cos(a) * 0.09, 0.74 + k * 0.14, Math.sin(a) * 0.09], r * 0.45));
      B[WOOD].push(_mp.multiplyMatrices(M, _m), _c, tr.phase, 0);
    }
  }

  _stumpH(h, S) { return Math.min(0.9 * S, h * 0.08); }

  _stump(tr, bx, by, bz, h, age, S) {
    const w = Math.min(h, this.L.wCap);
    const r = tr.trunkR * w * 1.04;
    const sh = this._stumpH(h, S);
    _m.compose(_p.set(bx, by, bz), _q.identity(), _s.set(r, sh, r));
    _c.copy(this._barkOf(tr));
    this.batch[POST].push(_m, _c, 0, 0);
    _m.compose(_p.set(bx, by + sh, bz), _q.identity(), _s.set(r * 0.93, 0.02 * S, r * 0.93));
    _c.copy(CUT).lerp(OLD_CUT, smooth(0, 6, age));
    this.batch[POST].push(_m, _c, 0, 0);
  }

  /** Branches left where the crown landed, rotting away over a few years. */
  _slash(tr, a, bx, by, bz, h, age, S) {
    const k = 1 - smooth(1, 7, age);
    if (k < 0.03) return;
    const d = h * 0.62;
    const r = Math.min(h, this.L.wCap) * 0.04 * (0.4 + 0.6 * k);
    _m.compose(_p.set(bx + Math.cos(a) * d, by + r * 0.2, bz + Math.sin(a) * d), _q.setFromEuler(_e0.set(0, -a, 0)),
      _s.set(r * 1.7, r * 0.42, r));
    _c.copy(SLASH).lerp(OLD_CUT, smooth(0.5, 5, age));
    this.batch[BLOB].push(_m, _c, 0, 0);
  }

  _mark(tr, bx, by, bz, h, k, S) {
    const w = Math.min(h, this.L.wCap);
    const r = tr.trunkR * w * 1.09;
    _m.compose(_p.set(bx, by + 2.2 * S, bz), _q.identity(), _s.set(r * (0.7 + 0.42 * k), 0.75 * S * k, r * (0.7 + 0.42 * k)));
    this.batch[POST].push(_m, PAINT, 0, 0);
  }

  _regrow(tr, x, y, z, h) {
    const kind = this.L.biome === 'boreal' ? 'birch' : this.L.biome === 'tropical' ? 'slender' : 'broad';
    const t = tr._regrowT || (tr._regrowT = template(kind, this.L.biome, rng(tr.seed + 99)));
    const fake = { yaw: tr.yaw + 1.3, parts: t.parts, phase: tr.phase + 1 };
    this._tree(fake, x, y, z, h, 1, 0, null, 1);
  }

  _barkOf(tr) { const p = tr.parts.find((q) => q.role === TRUNK); return p ? p.c : LOGC; }

  _flames(tr, bx, by, bz, h, I, fx, dt) {
    const crownY = by + h * 0.8;
    const rate = I * 70 * dt;                        // particles this frame, on average
    const count = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
    for (let n = 0; n < count; n++) {
      const up = Math.random();
      const y = by + h * (0.05 + 0.9 * up * up);
      const spread = Math.min(h, this.L.wCap) * tr.crownR * (0.3 + 0.7 * up);
      const a = Math.random() * 6.283;
      fx.emit('flame', bx + Math.cos(a) * spread, y, bz + Math.sin(a) * spread, { s: 1.4 + 1.6 * I });
    }
    if (Math.random() < I * 18 * dt) fx.emit('ember', bx, crownY, bz);
    if (Math.random() < I * 10 * dt) fx.emit('smoke', bx, crownY + h * 0.1, bz, { s: 2.2, s1: 10, life: 4 + Math.random() * 2 });
    if (Math.random() < I * 22 * dt) fx.emit('glow', bx, by + h * 0.45, bz, { s: Math.min(h, this.L.wCap) * 0.9 / Math.max(0.6, fx.scale), life: 0.3 });
    // the ground fire under it
    if (Math.random() < I * 26 * dt) {
      const a = Math.random() * 6.283, d = Math.random() * this.L.spacing * 0.7;
      fx.emit('flame', bx + Math.cos(a) * d, by + 0.1, bz + Math.sin(a) * d, { s: 0.9 + Math.random() * 0.6, life: 0.35 + Math.random() * 0.3 });
    }
  }

  /** What a harvest or a fire did to the understory at this spot: its size, and how burnt. */
  _hit(u, plan, t) {
    let k = 1, burnt = 0;
    if (!plan.mode) return { k, burnt };
    // the nearest felled tree decides what happened here
    if (u._plan !== plan) {
      u._plan = plan;
      u._f = null;
      let best = Infinity;
      for (const f of plan.felled) {
        const tr = this.L.trees[f.i];
        const d = Math.hypot(tr.x - u.x, tr.z - u.z);
        if (d < best) { best = d; u._f = f; }
      }
      if (best > this.L.spacing * (plan.mode === 'burn' ? 1.0 : 0.7)) u._f = null;
    }
    const f = u._f;
    if (f) {
      if (plan.mode === 'burn') {
        const tb = f.ignite - 0.03;
        if (t >= tb) {
          burnt = 1 - smooth(tb + 1.5, tb + 5, t);
          k = t < tb + 0.2 ? 1 - smooth(tb, tb + 0.15, t) : smooth(tb + 1, tb + 5, t);
        }
      } else if (t >= f.fall) {
        k = t < f.fall + 0.5 ? 0.3 : 0.3 + 0.7 * smooth(f.fall + 0.5, f.fall + 4, t);
      }
    }
    return { k, burnt };
  }

  _under(u, o, plan, t, Hf, S) {
    // grows in with a young stand, never above a fraction of the canopy
    const scaleH = Math.min(3 * S, Math.max(0.25, Hf * 0.1)) * u.s;
    const { k, burnt } = this._hit(u, plan, t);
    if (k < 0.04) return;
    const x = o.x + u.x, z = o.z + u.z;
    if (u.kind === 'rock') {
      _m.compose(_p.set(x, o.y + 0.1 * S * u.s, z), _q.setFromEuler(_e0.set(0.3, u.yaw, 0.2)), _s.set(0.9 * S * u.s, 0.5 * S * u.s, 0.7 * S * u.s));
      this.batch[BLOB].push(_m, ROCK, 0, 0);
      return;
    }
    _c.copy(u.c).lerp(CHAR, burnt * 0.9);
    if (u.kind === 'fern') {
      for (let n = 0; n < 5; n++) {
        const a = u.yaw + n * 1.256;
        const L = scaleH * k * 1.1;
        _m.compose(_p.set(x, o.y + 0.05, z), _q.setFromEuler(_e0.set(0, a, 0.55)), _s.set(L, L, L));
        this.batch[FROND].push(_m, _c, u.yaw, 0.6);
      }
    } else {
      const r = scaleH * k * (u.kind === 'moss' ? 0.5 : 0.6);
      _m.compose(_p.set(x, o.y + r * 0.35, z), _q.setFromEuler(_e0.set(0, u.yaw, 0)), _s.set(r * 1.3, r * (u.kind === 'moss' ? 0.45 : 0.85), r));
      this.batch[BLOB].push(_m, _c, u.yaw, 0.4);
    }
  }

  _oldLog(lg, o, S) {
    const r = 0.32 * S;
    _m.compose(_p.set(o.x + lg.x, o.y + r * 0.7, o.z + lg.z), _q.setFromEuler(_e0.set(0, lg.yaw, Math.PI / 2)), _s.set(r, lg.L, r));
    _m.multiply(_mp.makeTranslation(0, -0.5, 0));
    this.batch[POST].push(_m, MOSS, 0, 0);
  }

  _tape(plan, o, t, S) {
    const Y = plan.Y;
    const k = smooth(Y - 1, Y - 0.9, t) * (1 - smooth(Y + 0.35, Y + 0.6, t));
    if (k < 0.02) return;
    const [x0, x1, z0, z1] = plan.tape;
    const y = o.y + 1.0 * S;
    const r = 0.06 * S;
    const seg = (ax, az, bx, bz) => {
      _m.copy(cylBetween([o.x + ax, y, o.z + az], [o.x + bx, y, o.z + bz], r * k));
      this.batch[POST].push(_m, TAPE, 0, 0);
    };
    seg(x0, z0, x1, z0); seg(x1, z0, x1, z1); seg(x1, z1, x0, z1); seg(x0, z1, x0, z0);
    for (const [px, pz] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
      _m.compose(_p.set(o.x + px, o.y, o.z + pz), _q.identity(), _s.set(0.09 * S, 1.15 * S * k, 0.09 * S));
      this.batch[POST].push(_m, POSTC, 0, 0);
    }
  }

  _prop(pr, plan, o, t, S) {
    const Y = plan.Y;
    if (pr.type === 'sapling') {
      const t0 = Y - 1 + 0.12 + 0.6 * pr.u;
      if (t < t0) return;
      const pop = smooth(t0, t0 + 0.08, t);
      const span = plan.span || 12;
      const grow = clamp01((t - Y) / span);
      const h = (0.7 + 3.6 * grow * grow * (3 - 2 * grow)) * S * pr.j * pop;
      const x = o.x + pr.x, z = o.z + pr.z, y = o.y;
      if (t < Y + 6) {
        const tube = 1.15 * S * Math.min(1, pop * 1.2);
        _m.compose(_p.set(x, y, z), _q.identity(), _s.set(0.11 * S, tube, 0.11 * S));
        this.batch[POST].push(_m, TUBE, 0, 0);
      }
      _m.compose(_p.set(x, y, z), _q.identity(), _s.set(0.04 * S, h * 0.75, 0.04 * S));
      this.batch[WOOD].push(_m, LOGC, pr.yaw, 0.6);
      const r = Math.max(0.25 * S, h * 0.28);
      _m.compose(_p.set(x, y + h * 0.82, z), _q.setFromEuler(_e0.set(0, pr.yaw, 0)), _s.set(r, r * 1.1, r));
      this.batch[BLOB].push(_m, SAPLING, pr.yaw, 0.7);
      return;
    }
    if (pr.type === 'post') {
      const t0 = Y - 1 + 0.12 + 0.55 * pr.u;
      if (t < t0) return;
      const k = smooth(t0, t0 + 0.1, t);
      _m.compose(_p.set(o.x + pr.x, o.y, o.z + pr.z), _q.identity(), _s.set(0.11 * S, 1.6 * S * k, 0.11 * S));
      this.batch[POST].push(_m, POSTC, 0, 0);
      // wire to the next post, once both stand
      const next = plan.props[(plan.props.indexOf(pr) + 1) % plan.props.length];
      const t1 = Y - 1 + 0.12 + 0.55 * next.u + 0.1;
      if (t >= Math.max(t0 + 0.1, t1) || (next.u === 0 && t >= Y - 1 + 0.8)) {
        for (const hh of [0.75, 1.35]) {
          _m.copy(cylBetween([o.x + pr.x, o.y + hh * S, o.z + pr.z], [o.x + next.x, o.y + hh * S, o.z + next.z], 0.022 * S));
          this.batch[POST].push(_m, WIRE, 0, 0);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ one plot's scenery */

/** Soil layers for a slab's cut faces, drawn once. */
function soilTexture(biome) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  const top = biome === 'boreal' ? '#3a3a24' : biome === 'temperate' ? '#2e2216' : '#2a1d13';
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, top);
  grad.addColorStop(0.08, top);
  grad.addColorStop(0.1, '#33241a');
  grad.addColorStop(0.42, '#3d2b1d');
  grad.addColorStop(0.5, '#6b4a2e');
  grad.addColorStop(1, '#8a6a45');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 128);
  const rand = rng(77);
  // stones in the mineral layer, fine roots in the organic one
  for (let k = 0; k < 70; k++) {
    g.fillStyle = `rgba(${150 + rand() * 40},${130 + rand() * 30},${105 + rand() * 25},${0.35 + rand() * 0.3})`;
    g.beginPath();
    g.ellipse(rand() * 512, 66 + rand() * 60, 2 + rand() * 5, 1.5 + rand() * 3, rand() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(190,160,120,.35)';
  g.lineWidth = 1;
  for (let k = 0; k < 40; k++) {
    let x = rand() * 512, y = 12 + rand() * 30;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 5; s++) { x += (rand() - 0.5) * 18; y += 3 + rand() * 8; g.lineTo(x, y); }
    g.stroke();
  }
  for (let k = 0; k < 2200; k++) {
    g.fillStyle = `rgba(0,0,0,${rand() * 0.12})`;
    g.fillRect(rand() * 512, rand() * 128, 1 + rand() * 2, 1 + rand() * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

class Plot {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
  }

  build(L, hTop) {
    this.group.traverse((ch) => {
      ch.geometry?.dispose();
      if (ch.material) for (const m of [].concat(ch.material)) { m.map?.dispose(); m.dispose(); }
    });
    this.group.clear();
    const { W, D } = L;
    const depth = Math.max(2.4, W * 0.075);
    this.depth = depth;

    // the ground: vertex colours, so a harvest or a fire can mark it
    const nx = Math.round(W / 0.75), nz = Math.round(D / 0.75);
    const geo = new THREE.PlaneGeometry(W, D, nx, nz).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const base = new Float32Array(pos.count * 3);
    const g = GROUND[L.biome];
    const ca = col(g.a), cb = col(g.b), cc = col(g.c);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const n1 = vnoise(x * 0.18 + 3, 0, z * 0.18), n2 = vnoise(x * 0.6, 5, z * 0.6);
      _c.copy(ca).lerp(cb, n1).lerp(cc, smooth(0.55, 0.85, vnoise(x * 0.09, 9, z * 0.09)) * 0.85);
      _c.multiplyScalar(0.82 + 0.3 * n2);
      // a few centimetres of relief, rising nowhere near the edges
      const e = Math.min(1, (W / 2 - Math.abs(x)) / 1.5, (D / 2 - Math.abs(z)) / 1.5);
      pos.setY(i, (n1 - 0.5) * 0.35 * Math.max(0, e));
      base[i * 3] = _c.r; base[i * 3 + 1] = _c.g; base[i * 3 + 2] = _c.b;
    }
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.BufferAttribute(base.slice(), 3).setUsage(THREE.DynamicDrawUsage));
    this.base = base;
    this.ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    this.ground.receiveShadow = true;
    this.group.add(this.ground);
    this.marks = null;

    // the slab under it, cut to show the soil
    const soil = soilTexture(L.biome);
    soil.repeat.set(W / 12, 1);
    const side = new THREE.MeshStandardMaterial({ map: soil, roughness: 1 });
    const soilZ = soil.clone();
    soilZ.repeat.set(D / 12, 1);
    soilZ.needsUpdate = true;
    const sideZ = new THREE.MeshStandardMaterial({ map: soilZ, roughness: 1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x15100c, roughness: 1 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W, depth, D).translate(0, -depth / 2 - 0.02, 0),
      [sideZ, sideZ, dark, dark, side, side]);
    slab.receiveShadow = true;
    slab.castShadow = true;
    this.group.add(slab);

    // the canopy levels, as rails around the plot at the height its trees average: no action
    // dashed, this plot's own solid, the gap between them filled. They read through the trees:
    // they are a measurement, not scenery.
    this.railFree = rail(W, D, 0x7fe3b2, true);
    this.railAct = rail(W, D, 0xf2994a, false);
    this.gap = sides(W, D, new THREE.MeshBasicMaterial({
      color: 0xf2994a, transparent: true, opacity: 0.2, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide }));
    this.gap.renderOrder = 5;
    this.group.add(this.railFree, this.railAct, this.gap);
    this.W = W; this.D = D;
  }

  /** The canopy levels: no action (dashed) and this plot's own (solid), with the gap filled. */
  levels(Hf, Ha, act, thick) {
    const open = act && Math.abs(Ha - Hf) > 0.02;
    this.railFree.position.y = Hf;
    this.railFree.scale.y = thick * 1.4;
    this.railAct.visible = act;
    this.gap.visible = open;
    if (act) {
      this.railAct.position.y = Ha;
      this.railAct.scale.y = thick * 1.9;
      this.gap.position.y = Math.min(Ha, Hf);
      this.gap.scale.y = Math.max(0.001, Math.abs(Ha - Hf));
      this.gap.userData.mat.color.set(Ha < Hf ? 0xf2994a : 0x9ce07a);
    }
  }

  /** Mark the ground: bare earth under a harvest, char and embers under a fire, then green-up. */
  paint(plan, t, L) {
    const colAttr = this.ground.geometry.attributes.color;
    const arr = colAttr.array;
    if (!plan.mode) {
      if (this._painted) { arr.set(this.base); colAttr.needsUpdate = true; this._painted = false; }
      return;
    }
    if (this.marks?.plan !== plan) this._bind(plan, L);
    const { vi, fi, w } = this.marks;
    const bare = L.biome === 'boreal' ? BARE_B : BARE, green = L.biome === 'boreal' ? GREEN_B : GREEN;
    for (let k = 0; k < vi.length; k++) {
      const i = vi[k];
      const f = plan.felled[fi[k]];
      const wk = w[k];
      _c.setRGB(this.base[i * 3], this.base[i * 3 + 1], this.base[i * 3 + 2]);
      if (plan.mode === 'cut') {
        if (t >= f.fall) {
          _c2.copy(bare).lerp(green, smooth(f.fall + 0.6, f.fall + 4.5, t) * 0.8);
          _c.lerp(_c2, wk * smooth(f.fall, f.fall + 0.15, t));
        }
      } else {
        const tb = f.ignite - 0.03;
        if (t >= tb) {
          const glow = (1 - smooth(tb + 0.05, tb + 0.3, t)) * smooth(tb, tb + 0.03, t);
          _c2.copy(CHAR).lerp(EMBER, glow * 0.9);
          const rec = smooth(tb + 1, tb + 6, t);
          if (rec > 0) _c2.lerp(bare, Math.min(1, rec * 1.5) * 0.7).lerp(green, rec * 0.75);
          _c.lerp(_c2, wk * smooth(tb, tb + 0.06, t));
        }
      }
      arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b;
    }
    colAttr.needsUpdate = true;
    this._painted = true;
  }

  /** For each ground vertex near a felled tree: which one, and how strongly (a ragged disc). */
  _bind(plan, L) {
    const pos = this.ground.geometry.attributes.position;
    const arr = this.ground.geometry.attributes.color.array;
    arr.set(this.base);
    const R = L.spacing * (plan.mode === 'burn' ? 0.95 : 0.62);
    const vi = [], fi = [], w = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      let best = Infinity, bf = -1;
      for (let k = 0; k < plan.felled.length; k++) {
        const tr = L.trees[plan.felled[k].i];
        const d = Math.hypot(tr.x - x, tr.z - z);
        if (d < best) { best = d; bf = k; }
      }
      if (bf < 0) continue;
      const rr = R * (0.75 + 0.5 * vnoise(x * 0.45, 2, z * 0.45));
      const wk = 1 - smooth(rr * 0.55, rr, best);
      if (wk <= 0.001) continue;
      vi.push(i); fi.push(bf); w.push(wk);
    }
    this.marks = { plan, vi: Int32Array.from(vi), fi: Int32Array.from(fi), w: Float32Array.from(w) };
  }
}

/** Four upright quads on the edges of a W x D plot, one unit tall from y = 0 (scaled to size). */
function sides(W, D, mat) {
  const g = new THREE.Group();
  const gw = new THREE.PlaneGeometry(W, 1).translate(0, 0.5, 0);
  const gd = new THREE.PlaneGeometry(D, 1).translate(0, 0.5, 0);
  for (const [geo, x, z, ry] of [[gw, 0, D / 2, 0], [gw, 0, -D / 2, 0], [gd, -W / 2, 0, Math.PI / 2], [gd, W / 2, 0, Math.PI / 2]]) {
    const q = new THREE.Mesh(geo, mat);
    q.position.set(x, 0, z);
    q.rotation.y = ry;
    q.renderOrder = 5;
    g.add(q);
  }
  g.userData.mat = mat;
  return g;
}

/** A level drawn around the plot's edges, centred on y = 0 and one unit thick. */
function rail(W, D, color, dashed) {
  const g = new THREE.Group();
  const mk = (len) => {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: dashed ? 0.95 : 1,
      depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide });
    if (dashed) { m.map = dashTexture(); m.map.repeat.set(len / 2.2, 1); }
    return m;
  };
  const mW = mk(W), mD = mk(D);
  const gw = new THREE.PlaneGeometry(W, 1), gd = new THREE.PlaneGeometry(D, 1);
  for (const [geo, mat, x, z, ry] of [[gw, mW, 0, D / 2, 0], [gw, mW, 0, -D / 2, 0], [gd, mD, -W / 2, 0, Math.PI / 2], [gd, mD, W / 2, 0, Math.PI / 2]]) {
    const q = new THREE.Mesh(geo, mat);
    q.position.set(x, 0, z);
    q.rotation.y = ry;
    q.renderOrder = 6;
    g.add(q);
  }
  return g;
}

function dashTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 4;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 38, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
