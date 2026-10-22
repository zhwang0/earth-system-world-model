/**
 * globe.js — the hero's Earth: a photographic planet you can spin, zoom and pick study sites on.
 *
 *   const globe = await createGlobe({canvas, cells, onPick, onReady});   // null if WebGL is out
 *   globe.flyTo(lat, lon, {zoom: 1.6, ms: 1200});
 *   globe.select(cellId);          // highlight, no camera move
 *   globe.setAutoRotate(false);
 *   globe.resize();  globe.dispose();
 *
 * What is on screen: NASA Blue Marble imagery over a displaced sphere, the ED canopy-height field
 * (assets/grid/height_a150.png, December 2021) draped on the forested land and lifting it a little,
 * a drifting cloud shell with its shadow on the ground, Black Marble city lights on the night side,
 * sun glint on water only, an atmospheric rim, the paper's six study boxes, and all 603 catalogued
 * cells as one Points draw. Seven draw calls in total.
 *
 * Everything is asked for with document-relative paths so the site works from a Pages sub-path, and
 * nothing is fetched from another origin.
 */
import * as THREE from '../assets/vendor/three.module.js';

const D2R = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// The canopy ramp: the site's forest green, dark where the stand is short, bright where it is tall.
const CANOPY_RAMP = [0x04201b, 0x0a4733, 0x1a8559, 0x56c077, 0xdaf59d];
const COL_SITE = 0xe8ffc0;   // a validated study cell (trained = true)
const COL_OTHER = 0x8fd4df;  // a globally sampled forest cell
const COL_PICK = 0xfff2cf;   // hovered or selected
const COL_BOX = 0x74e2b4;    // the paper's six study regions

// Colour maths happens in the shader in the same (gamma) space the textures are sampled in, so the
// hex bytes must survive into the uniform unconverted.
function rgb(hex) {
  return new THREE.Color().setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255,
    (hex & 255) / 255, THREE.LinearSRGBColorSpace);
}

// SphereGeometry's UVs: u = 0 at 180 W, v = 1 at the north pole — the same frame the data grid uses
// (row 0 = 89.75 N, col 0 = 179.75 W) once v is flipped.
function latLonToVec3(lat, lon, r = 1, out = new THREE.Vector3()) {
  const phi = (lon + 180) * D2R, theta = (90 - lat) * D2R;
  return out.set(-Math.cos(phi) * Math.sin(theta) * r, Math.cos(theta) * r, Math.sin(phi) * Math.sin(theta) * r);
}
function vec3ToLatLon(v) {
  const n = v.clone().normalize();
  const lat = 90 - Math.acos(clamp(n.y, -1, 1)) / D2R;
  let lon = Math.atan2(n.z, -n.x) / D2R - 180;
  if (lon < -180) lon += 360;
  return { lat, lon };
}
// The Euler (XYZ) spin that brings (lat, lon) round to face the camera.
function facing(lat, lon) {
  const p = latLonToVec3(0, lon);
  return { x: lat * D2R, y: -Math.atan2(p.x, p.z) };
}

/* ────────────────────────────────────────────────────────────────── shaders */

const GLOBE_VERT = /* glsl */`
precision highp float;
uniform sampler2D uData;
uniform float uHasData, uLift, uDataMix;
varying vec2 vUv;
varying vec3 vN, vW;
void main() {
  vUv = uv;
  // The canopy lifts the land it stands on. Coarse by design: the sphere is tessellated well below
  // the 0.5 deg grid, so this reads as relief at the limb, not as per-cell spikes.
  float h = 0.0;
  if (uHasData > 0.5) {
    vec2 d = texture2D(uData, vec2(uv.x, 1.0 - uv.y)).rg;
    float t = d.r / max(d.g, 1e-3);
    h = t * t * smoothstep(0.12, 0.62, d.g);
  }
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position * (1.0 + h * uLift * uDataMix), 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const GLOBE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uDay, uMask, uClouds, uLights, uData;
uniform vec3 uSun, uRamp[5];
uniform float uHasData, uDataMix, uCloud, uCloudShift, uNight, uSpec, uExposure, uDim;
varying vec2 vUv;
varying vec3 vN, vW;

vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  float i = min(floor(t), 3.0);
  float f = t - i;
  vec3 a = uRamp[0], b = uRamp[1];
  if (i > 2.5) { a = uRamp[3]; b = uRamp[4]; }
  else if (i > 1.5) { a = uRamp[2]; b = uRamp[3]; }
  else if (i > 0.5) { a = uRamp[1]; b = uRamp[2]; }
  return mix(a, b, f);
}

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = normalize(uSun);
  float ndl = dot(N, L);
  float lit = smoothstep(-0.14, 0.26, ndl);
  float sun = pow(max(ndl, 0.0), 0.72);

  vec3 img = texture2D(uDay, vUv).rgb;
  float land = smoothstep(0.22, 0.58, texture2D(uMask, vUv).r);

  // ED's canopy height, gamma-encoded in R with coverage in G; dividing by the filtered coverage
  // keeps coastlines from bleeding the no-data value inward.
  float t = 0.0, cov = 0.0;
  if (uHasData > 0.5) {
    vec2 d = texture2D(uData, vec2(vUv.x, 1.0 - vUv.y)).rg;
    cov = smoothstep(0.18, 0.72, d.g) * land * uDataMix;
    t = clamp(d.r / max(d.g, 1e-3), 0.0, 1.0);
  }
  float forest = cov * smoothstep(0.05, 0.52, t);

  vec3 sea  = vec3(0.004, 0.019, 0.044) + img * vec3(0.17, 0.31, 0.47);
  vec3 soil = pow(img, vec3(1.07)) * 1.15;
  vec3 leaf = ramp(0.10 + 0.88 * t);
  // The imagery keeps its texture under the data: the canopy tints the land, it does not paint it out.
  vec3 alb = mix(sea, mix(soil, leaf * 0.88 + soil * 0.30, forest * 0.82), land);

  float shade = texture2D(uClouds, vec2(vUv.x + uCloudShift + 0.0035, vUv.y + 0.0026)).r * uCloud;
  vec3 col = alb * (1.0 - 0.42 * shade) * (0.022 + 1.20 * sun) * uExposure;

  // Glint, water only — the land mask is what keeps the forests matte.
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  // A tighter, dimmer lobe than a physical sun would give: at this camera distance the sphere
  // fills enough of the frame that a bright wide lobe clips to a flat white disc over the ocean.
  col += (vec3(1.0, 0.96, 0.88) * pow(nh, 900.0) * 0.42 + vec3(0.34, 0.56, 0.88) * pow(nh, 20.0) * 0.045)
       * (1.0 - land) * lit * (1.0 - 0.85 * shade) * uSpec;

  // Night: Black Marble squared so the compression floor stays black, plus a faint glow off the
  // canopy field so the forests are still legible on the dark side.
  float dark = 1.0 - smoothstep(-0.24, 0.04, ndl);
  float lamp = texture2D(uLights, vUv).r;
  col += vec3(1.0, 0.70, 0.36) * lamp * lamp * dark * (1.0 - 0.70 * shade) * uNight * 1.6;
  col += leaf * forest * dark * 0.09 * uNight;

  // Air: the limb turns blue, most of all where the sun is.
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.7);
  col = mix(col, vec3(0.30, 0.56, 1.0) * (0.05 + 0.95 * sun), fres * (0.13 + 0.55 * lit));

  gl_FragColor = vec4(col * uDim, 1.0);
}`;

const CLOUD_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN, vW;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const CLOUD_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uClouds;
uniform vec3 uSun;
uniform float uCloudShift, uOpacity, uDim;
varying vec2 vUv;
varying vec3 vN, vW;
void main() {
  float c = texture2D(uClouds, vec2(vUv.x + uCloudShift, vUv.y)).r;
  float a = smoothstep(0.05, 0.52, c);
  if (a < 0.004) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float ndl = dot(N, normalize(uSun));
  float lit = smoothstep(-0.26, 0.30, ndl);
  float sun = pow(max(ndl, 0.0), 0.75);
  vec3 col = mix(vec3(0.05, 0.07, 0.11), vec3(1.0, 0.99, 0.96), lit) * (0.05 + 1.1 * sun);
  // a silver edge where the shell turns away: cloud tops catching light past the terminator
  col += vec3(0.55, 0.72, 1.0) * pow(1.0 - max(dot(N, V), 0.0), 2.2) * 0.30 * lit;
  gl_FragColor = vec4(col * uDim, a * uOpacity * mix(0.40, 1.0, lit));
}`;

const ATMO_VERT = /* glsl */`
varying vec3 vN, vW;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const ATMO_FRAG = /* glsl */`
precision highp float;
uniform vec3 uSun;
uniform float uOpacity;
varying vec3 vN, vW;
void main() {
  // Back faces of a 1.15x shell: brightest right at the limb, gone a little way out, and weighted
  // toward the lit side so the planet sits in its own light.
  vec3 V = normalize(cameraPosition - vW);
  vec3 N = normalize(vN);
  float k = clamp(-dot(N, V) / 0.48, 0.0, 1.0);
  float a = pow(k, 4.2);
  vec3 rel = normalize(vW);
  float lit = 0.05 + 0.95 * smoothstep(-0.40, 0.55, dot(rel, normalize(uSun)));
  vec3 col = mix(vec3(0.17, 0.42, 0.95), vec3(0.50, 0.78, 1.0), lit);
  gl_FragColor = vec4(col * (0.25 + 1.35 * lit), a * uOpacity);
}`;

const MARK_VERT = /* glsl */`
precision highp float;
attribute float aTrained, aId, aSeed;
uniform float uPx, uRef, uSel, uHover, uTime, uIntro, uStill;
varying float vT, vA, vSel, vHov;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 w = (modelMatrix * vec4(position, 1.0)).xyz;
  float face = dot(normalize(w), normalize(cameraPosition - w));
  float sel = 1.0 - step(0.5, abs(aId - uSel));
  float hov = 1.0 - step(0.5, abs(aId - uHover));
  float intro = smoothstep(aSeed * 0.5, aSeed * 0.5 + 0.5, uIntro);
  float pulse = (1.0 - uStill) * (0.5 + 0.5 * sin(uTime * 2.6));
  vT = aTrained; vSel = sel; vHov = hov;
  vA = smoothstep(0.015, 0.20, face) * mix(0.56, 1.0, aTrained) * intro;
  float s = mix(4.4, 7.6, aTrained) + hov * 3.4 + sel * (3.2 + 1.6 * pulse);
  gl_PointSize = s * uPx * clamp(uRef / max(-mv.z, 0.001), 0.6, 2.3) * (0.4 + 0.6 * intro);
  gl_Position = projectionMatrix * mv;
}`;

const MARK_FRAG = /* glsl */`
precision highp float;
uniform vec3 uCold, uWarm, uPick;
varying float vT, vA, vSel, vHov;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float core = smoothstep(0.46, 0.10, r);
  float ring = smoothstep(0.50, 0.66, r) * smoothstep(0.96, 0.74, r);
  float lift = max(vSel, vHov);
  // A soft dark disc under every dot: the only way a marker stays readable over both the Sahara
  // and the night Pacific.
  float shadow = smoothstep(1.0, 0.28, r) * (0.13 + 0.12 * lift);
  vec3 c = mix(mix(uCold, uWarm, vT), uPick, max(vSel, vHov * 0.65));
  float ink = clamp(core * 1.15 + ring * (0.6 + 0.4 * lift), 0.0, 1.0);
  gl_FragColor = vec4(mix(vec3(0.015, 0.035, 0.030), c * (1.0 + 0.45 * lift), ink),
                      max(shadow, ink) * vA);
}`;

const LINE_VERT = /* glsl */`
varying float vA;
void main() {
  vec3 w = (modelMatrix * vec4(position, 1.0)).xyz;
  vA = smoothstep(0.0, 0.26, dot(normalize(w), normalize(cameraPosition - w)));
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const LINE_FRAG = /* glsl */`
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
void main() { gl_FragColor = vec4(uColor, vA * uOpacity); }`;

const STAR_VERT = /* glsl */`
attribute float aSize, aTw;
uniform float uPx, uTime, uStill;
varying float vA;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vA = mix(0.5 + 0.5 * sin(uTime * 1.1 + aTw), 0.85, uStill);
  gl_PointSize = aSize * uPx;
}`;

const STAR_FRAG = /* glsl */`
precision highp float;
uniform float uOpacity;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  gl_FragColor = vec4(vec3(0.82, 0.90, 1.0), smoothstep(0.5, 0.0, d) * vA * uOpacity);
}`;

/* ──────────────────────────────────────────────────────────────── loading */

function loadTexture(url, loader) {
  return new Promise((resolve, reject) => loader.load(url, (t) => {
    // Shading happens in texture space, so nothing is converted on the way in.
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 4;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    resolve(t);
  }, undefined, () => reject(new Error('texture failed: ' + url))));
}

/**
 * One year out of a packed atlas, as an RG8 texture: R the gamma-encoded value, G the coverage.
 * The encoding is read from grid.json rather than assumed — 720x360 frames, 41 years laid out
 * row-major in a 7x6 tile sheet, byte 0 = no data, value = vmax * ((byte-1)/254)^(1/gamma).
 */
async function loadCanopyFrame(age, wantYear) {
  const meta = await (await fetch('assets/grid/grid.json')).json();
  const W = meta.width | 0 || 720, H = meta.height | 0 || 360;
  const cols = meta.cols | 0 || 7, years = meta.years | 0 || 41;
  const frame = clamp(wantYear == null ? years - 1 : Math.round(wantYear), 0, years - 1);
  const files = (meta.vars && meta.vars.height && meta.vars.height.files) || {};
  const name = files[String(age)] || 'height_a' + age + '.png';

  const res = await fetch(`assets/grid/${name}`);
  if (!res.ok) throw new Error(name + ': ' + res.status);
  const blob = await res.blob();
  const sx = (frame % cols) * W, sy = Math.floor(frame / cols) * H;

  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H)
    : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const opt = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  let bmp = null;
  try {
    bmp = await createImageBitmap(blob, sx, sy, W, H, opt);   // crop at decode where it is supported
    ctx.drawImage(bmp, 0, 0);
  } catch (e) {
    bmp = await createImageBitmap(blob, opt);
    ctx.drawImage(bmp, sx, sy, W, H, 0, 0, W, H);
  }
  if (bmp && bmp.close) bmp.close();

  const px = ctx.getImageData(0, 0, W, H).data;
  const rg = new Uint8Array(W * H * 2);
  for (let i = 0, n = W * H; i < n; i++) {
    const b = px[i * 4];
    if (b) { rg[i * 2] = Math.round((b - 1) * 255 / 254); rg[i * 2 + 1] = 255; }
  }
  const tex = new THREE.DataTexture(rg, W, H, THREE.RGFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/* ──────────────────────────────────────────────────────────────── the globe */

export async function createGlobe(opts = {}) {
  const canvas = opts && opts.canvas;
  if (!canvas || !canvas.getContext) return null;
  try {
    if (!document.createElement('canvas').getContext('webgl2')) return null;
  } catch (e) { return null; }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) { return null; }
  renderer.setClearColor(0x000000, 0);

  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)').matches;
  let reduced = motion.matches;

  const sw = Math.min(window.innerWidth, window.innerHeight);
  const dpr = window.devicePixelRatio || 1;
  // 4K Blue Marble where it will be seen; the 2K cut on phones, small windows and 1x displays.
  const hiRes = !coarse && sw >= 700 && (dpr >= 1.5 || Math.max(window.innerWidth, window.innerHeight) >= 1280);
  const light = coarse || sw < 620;
  const SEG = light ? 176 : 288;

  const loader = new THREE.TextureLoader();
  let day, mask;
  try {
    [day, mask] = await Promise.all([
      loadTexture(hiRes ? 'assets/tex/earth-day.webp' : 'assets/tex/earth-day-2k.webp', loader),
      loadTexture('assets/tex/land-mask.png', loader),
    ]);
  } catch (e) {
    renderer.dispose();
    return null;                       // no imagery, no globe: let the page fall back to its CSS
  }

  /* ---------------------------------------------------------------- scene */
  const scene = new THREE.Scene();
  const FOV = 28;
  const cam = new THREE.PerspectiveCamera(FOV, 1, 0.05, 300);
  const spin = new THREE.Group();          // everything that turns with the planet
  scene.add(spin);

  const blank = new THREE.DataTexture(new Uint8Array([0, 0]), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
  blank.unpackAlignment = 1;
  blank.needsUpdate = true;

  const sun = new THREE.Vector3(-0.58, 0.40, 0.70).normalize();
  const gu = {
    uDay: { value: day }, uMask: { value: mask }, uClouds: { value: blank }, uLights: { value: blank },
    uData: { value: blank }, uHasData: { value: 0 }, uDataMix: { value: 0 }, uLift: { value: 0.0052 },
    uSun: { value: sun }, uRamp: { value: CANOPY_RAMP.map(rgb) },
    uCloud: { value: 0 }, uCloudShift: { value: 0 }, uNight: { value: 1 },
    uSpec: { value: 1 }, uExposure: { value: 1 }, uDim: { value: 0 },
  };
  const globeGeo = new THREE.SphereGeometry(1, SEG, SEG / 2);
  const globeMat = new THREE.ShaderMaterial({ uniforms: gu, vertexShader: GLOBE_VERT, fragmentShader: GLOBE_FRAG });
  const globeMesh = new THREE.Mesh(globeGeo, globeMat);
  globeMesh.renderOrder = 0;
  spin.add(globeMesh);

  const cu = {
    uClouds: { value: blank }, uSun: { value: sun }, uCloudShift: gu.uCloudShift,
    uOpacity: { value: 0 }, uDim: gu.uDim,
  };
  const cloudGeo = new THREE.SphereGeometry(1.008, light ? 96 : 128, light ? 48 : 64);
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: cu, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
    transparent: true, depthWrite: false,
  });
  const cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
  cloudMesh.renderOrder = 2;
  spin.add(cloudMesh);

  const au = { uSun: { value: sun }, uOpacity: { value: 0 } };
  const atmoGeo = new THREE.SphereGeometry(1.15, 64, 32);
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: au, vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const atmo = new THREE.Mesh(atmoGeo, atmoMat);
  atmo.renderOrder = 3;
  scene.add(atmo);

  // stars
  const nStars = light ? 500 : 900;
  const sp = new Float32Array(nStars * 3), ss = new Float32Array(nStars), st = new Float32Array(nStars);
  for (let i = 0; i < nStars; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    sp[i * 3] = Math.cos(a) * s * 40; sp[i * 3 + 1] = u * 40; sp[i * 3 + 2] = Math.sin(a) * s * 40;
    ss[i] = Math.pow(Math.random(), 5) * 2.0 + 0.5;
    st[i] = Math.random() * 6.283;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(ss, 1));
  starGeo.setAttribute('aTw', new THREE.BufferAttribute(st, 1));
  const su = { uPx: { value: 1 }, uTime: { value: 0 }, uOpacity: { value: 0 }, uStill: { value: reduced ? 1 : 0 } };
  const starMat = new THREE.ShaderMaterial({
    uniforms: su, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  /* -------------------------------------------------------------- markers */
  const cells = (Array.isArray(opts.cells) ? opts.cells : [])
    .filter((c) => c && isFinite(c.lat) && isFinite(c.lon));
  const n = cells.length;
  const lat = new Float64Array(n), lon = new Float64Array(n);
  const ids = new Array(n);
  const trained = new Uint8Array(n);
  const mp = new Float32Array(n * 3), mt = new Float32Array(n), mi = new Float32Array(n), mseed = new Float32Array(n);
  const byId = new Map();
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    lat[i] = c.lat; lon[i] = c.lon; ids[i] = c.id;
    trained[i] = c.trained ? 1 : 0;
    byId.set(c.id, i);
    latLonToVec3(c.lat, c.lon, 1.011, v).toArray(mp, i * 3);
    mt[i] = trained[i];
    mi[i] = i;
    // study cells light up first, the sampled ones fill in behind them (seed stays in [0, 1])
    const r = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
    mseed[i] = trained[i] ? 0.34 * r : 0.3 + 0.7 * r;
  }
  const markGeo = new THREE.BufferGeometry();
  markGeo.setAttribute('position', new THREE.BufferAttribute(mp, 3));
  markGeo.setAttribute('aTrained', new THREE.BufferAttribute(mt, 1));
  markGeo.setAttribute('aId', new THREE.BufferAttribute(mi, 1));
  markGeo.setAttribute('aSeed', new THREE.BufferAttribute(mseed, 1));
  const mu = {
    uPx: { value: 1 }, uRef: { value: 4 }, uSel: { value: -1 }, uHover: { value: -1 },
    uTime: { value: 0 }, uIntro: { value: 0 }, uStill: { value: reduced ? 1 : 0 },
    uCold: { value: rgb(COL_OTHER) }, uWarm: { value: rgb(COL_SITE) }, uPick: { value: rgb(COL_PICK) },
  };
  const markMat = new THREE.ShaderMaterial({
    uniforms: mu, vertexShader: MARK_VERT, fragmentShader: MARK_FRAG,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const marks = new THREE.Points(markGeo, markMat);
  marks.renderOrder = 5;
  marks.frustumCulled = false;
  if (n) spin.add(marks);

  // the paper's six study boxes, drawn from the extent of their own cells
  const boxes = new Map();
  for (const c of cells) {
    if (c.region == null || !c.trained) continue;
    const b = boxes.get(c.region) || { s: 90, nn: -90, w: 180, e: -180 };
    b.s = Math.min(b.s, c.lat - 0.25); b.nn = Math.max(b.nn, c.lat + 0.25);
    b.w = Math.min(b.w, c.lon - 0.25); b.e = Math.max(b.e, c.lon + 0.25);
    boxes.set(c.region, b);
  }
  let regionLines = null;
  if (boxes.size) {
    const seg = [];
    const push = (la0, lo0, la1, lo1) => {
      const steps = Math.max(2, Math.ceil(Math.max(Math.abs(la1 - la0), Math.abs(lo1 - lo0))));
      let prev = latLonToVec3(la0, lo0, 1.004, new THREE.Vector3());
      for (let k = 1; k <= steps; k++) {
        const f = k / steps;
        const p = latLonToVec3(la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f, 1.004, new THREE.Vector3());
        seg.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        prev = p;
      }
    };
    for (const b of boxes.values()) {
      push(b.nn, b.w, b.nn, b.e); push(b.s, b.w, b.s, b.e);
      push(b.s, b.w, b.nn, b.w); push(b.s, b.e, b.nn, b.e);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
    const lu = { uColor: { value: rgb(COL_BOX) }, uOpacity: { value: 0 } };
    const lm = new THREE.ShaderMaterial({
      uniforms: lu, vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
      transparent: true, depthTest: false, depthWrite: false,
    });
    regionLines = new THREE.LineSegments(lg, lm);
    regionLines.renderOrder = 4;
    regionLines.frustumCulled = false;
    spin.add(regionLines);
  }

  // the locator around the selected site
  const ringGeo = new THREE.RingGeometry(0.022, 0.030, 48);
  const ringMat = new THREE.MeshBasicMaterial({
    color: rgb(COL_PICK), transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.renderOrder = 6;
  ring.visible = false;
  spin.add(ring);

  /* ------------------------------------------------------- layout + camera */
  let W = 1, H = 1, px = 1, baseDist = 4.6, dist = 4.6, zoom = 1;
  const Z_MIN = 0.8, Z_MAX = 2.6;
  const cssNum = (style, name, fallback) => {
    const raw = style.getPropertyValue(name).trim();
    const x = parseFloat(raw);
    return raw && isFinite(x) ? x : fallback;
  };

  function layout() {
    const a = W / H;
    const st = getComputedStyle(canvas);
    // The CSS may place the planet with --globe-x / --globe-y (fractions of the canvas) and size it
    // with --globe-fit (disc diameter as a fraction of canvas height). These are the defaults:
    //   wide screens  -> right of centre, the text column left of it; narrow -> centred and low.
    const fx = cssNum(st, '--globe-x', a >= 1.35 ? 0.68 : a >= 1.0 ? 0.60 : 0.5);
    const fy = cssNum(st, '--globe-y', a >= 1.0 ? 0.48 : 0.62);
    const fit = cssNum(st, '--globe-fit', a >= 1.35 ? 0.86 : a >= 1.0 ? 0.78 : Math.min(0.72, 0.92 * a));
    baseDist = (1 / clamp(fit, 0.25, 2)) / Math.tan(FOV * 0.5 * D2R);
    dist = Math.max(1.5, baseDist / zoom);
    const halfH = Math.tan(FOV * 0.5 * D2R) * dist, halfW = halfH * a;
    // Keeping the planet at the origin and moving the camera instead keeps picking trivial.
    cam.position.set(-(fx * 2 - 1) * halfW, -(1 - fy * 2) * halfH, dist);
    cam.lookAt(cam.position.x, cam.position.y, 0);
    cam.updateMatrixWorld();
    mu.uRef.value = baseDist;
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width || canvas.clientWidth || 1));
    H = Math.max(1, Math.round(r.height || canvas.clientHeight || 1));
    px = Math.min(window.devicePixelRatio || 1, 2);          // never more than 2x
    renderer.setPixelRatio(px);
    renderer.setSize(W, H, false);
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    mu.uPx.value = px;
    su.uPx.value = px;
    layout();
    dirty = true;
  }

  /* ------------------------------------------------------------- the loop */
  let rx = 0.22, ry = facing(0, -40).y, vx = 0, vy = 0;
  let autoRotate = !reduced, holding = false, idleAt = 0, fly = null;
  let time = 0, introT = 0, dataT = 0, last = performance.now();
  let raf = 0, visible = true, disposed = false, ready = false, dirty = true;
  let selIdx = -1, hoverIdx = -1, engaged = false;

  const _n = new THREE.Vector3(), _w = new THREE.Vector3();

  function step(dt) {
    time += dt;
    const was = introT;
    introT = reduced ? 1 : Math.min(1, introT + dt / 1.5);
    if (gu.uHasData.value > 0.5) dataT = reduced ? 1 : Math.min(1, dataT + dt / 1.2);
    if (introT !== was) dirty = true;

    if (fly) {
      const f = clamp((performance.now() - fly.t0) / fly.ms, 0, 1), e = easeInOut(f);
      rx = fly.x0 + (fly.x1 - fly.x0) * e;
      ry = fly.y0 + (fly.y1 - fly.y0) * e;
      zoom = fly.z0 + (fly.z1 - fly.z0) * e;
      layout();
      dirty = true;
      if (f >= 1) { fly = null; idleAt = performance.now() + 3200; }
    } else if (!holding) {
      if (Math.abs(vx) > 1e-5 || Math.abs(vy) > 1e-5) {
        ry += vy; rx = clamp(rx + vx, -1.15, 1.15);
        vy *= 0.93; vx *= 0.93;
        if (Math.abs(vy) < 1e-5) vy = 0;
        if (Math.abs(vx) < 1e-5) vx = 0;
        dirty = true;
      } else if (autoRotate && hoverIdx < 0 && performance.now() > idleAt) {
        ry += dt * 0.045;                      // one turn in about two and a half minutes
        dirty = true;
      }
    }
    spin.rotation.set(rx, ry, 0, 'XYZ');

    if (!reduced) {
      gu.uCloudShift.value = (gu.uCloudShift.value + dt * 0.0022) % 1;   // clouds drift off the spin
      if (cu.uOpacity.value > 0) dirty = true;
    }
    const fade = reduced ? 1 : Math.min(1, introT * 2.2);
    gu.uDim.value = fade;
    au.uOpacity.value = 0.95 * fade;
    su.uOpacity.value = 0.85 * fade;
    gu.uDataMix.value = dataT;
    mu.uTime.value = time;
    mu.uIntro.value = introT;
    su.uTime.value = time;
    if (regionLines) regionLines.material.uniforms.uOpacity.value = 0.42 * fade * dataT;

    // the locator: tangent to the sphere, fading as its site turns away
    if (selIdx >= 0) {
      _w.fromArray(mp, selIdx * 3).applyQuaternion(spin.quaternion);
      _n.copy(cam.position).sub(_w).normalize();
      const f = clamp((_n.dot(_w) / _w.length() - 0.02) / 0.22, 0, 1);
      const pulse = reduced ? 1 : 0.72 + 0.28 * Math.sin(time * 2.6);
      ring.material.opacity = f * pulse;
      ring.scale.setScalar(reduced ? 1 : 1 + 0.10 * Math.sin(time * 2.6));
      ring.visible = f > 0.01;
      if (!reduced) dirty = true;
    } else ring.visible = false;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    if (!reduced || dirty) {
      renderer.render(scene, cam);
      dirty = false;
      fireReady();
    }
  }
  function fireReady() {
    if (ready) return;
    ready = true;
    if (typeof opts.onReady === 'function') { try { opts.onReady(); } catch (e) { /* theirs */ } }
  }
  function start() { if (!raf && !disposed) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function sync() { if (visible && !document.hidden && !disposed) start(); else stop(); }

  /* ----------------------------------------------------------- interaction */
  // A decorative overlay must not eat the planet's pointer events; the page's own CSS usually says
  // so already, this is just a belt and braces.
  const grad = document.querySelector('.hero-grad');
  if (grad && getComputedStyle(grad).pointerEvents !== 'none') grad.style.pointerEvents = 'none';
  if (getComputedStyle(canvas).pointerEvents === 'none') canvas.style.pointerEvents = 'auto';
  canvas.style.touchAction = 'pan-y';    // horizontal drags turn the globe, vertical ones scroll
  canvas.style.cursor = 'default';

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function surfacePoint(cx, cy) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const o = ray.ray.origin, d = ray.ray.direction;
    const b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c;
    if (disc < 0) return null;
    const p = o.clone().addScaledVector(d, -b - Math.sqrt(disc));
    spin.updateMatrixWorld();
    return spin.worldToLocal(p);
  }
  // A click lands on the nearest catalogued cell, not on a 7 px dot: cheaper than raycasting 603
  // sprites and far kinder to touch. The budget is a fixed number of pixels, converted to degrees.
  function cellNear(p, pxBudget) {
    if (!n || !p) return -1;
    const ll = vec3ToLatLon(p);
    const perRad = (H * 0.5) / (Math.tan(FOV * 0.5 * D2R) * dist);     // pixels per globe radius
    const maxDeg = clamp(pxBudget / (perRad * D2R), 1.1, 9);
    const cl = Math.cos(ll.lat * D2R);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      let dLon = lon[i] - ll.lon;
      if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
      const dLat = lat[i] - ll.lat, x = dLon * cl;
      // the validated sites are a little easier to hit than the sampled ones
      const d = (dLat * dLat + x * x) * (trained[i] ? 0.52 : 1);
      if (d < bestD) { bestD = d; best = i; }
    }
    return Math.sqrt(bestD) <= maxDeg ? best : -1;
  }

  const pointers = new Map();
  let down = null, pinch = 0;
  const budget = (e) => (e.pointerType === 'touch' ? 34 : 24);

  function setHover(i) {
    if (i === hoverIdx) return;
    hoverIdx = i;
    mu.uHover.value = i;
    dirty = true;
  }
  function setZoom(z) {
    const next = clamp(z, Z_MIN, Z_MAX);
    if (next === zoom) return;
    zoom = next;
    layout();
    dirty = true;
  }

  function onDown(e) {
    const onSphere = !!surfacePoint(e.clientX, e.clientY);
    setHover(-1);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* older touch stacks */ }
    down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
    holding = true;
    idleAt = Infinity;
    fly = null;
    vx = vy = 0;
    if (onSphere) engaged = true;
    if (hoverIdx < 0) canvas.style.cursor = 'grabbing';
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }
  function onMove(e) {
    if (!pointers.has(e.pointerId)) {
      if (!pointers.size) {
        const p = surfacePoint(e.clientX, e.clientY);
        const i = cellNear(p, budget(e));
        setHover(i);
        canvas.style.cursor = i >= 0 ? 'pointer' : p ? 'grab' : 'default';
      }
      return;
    }
    const prev = pointers.get(e.pointerId);
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch && d) setZoom(zoom * (d / pinch));
      pinch = d;
      return;
    }
    if (down) down.moved += Math.abs(dx) + Math.abs(dy);
    const k = 0.0052 * clamp(dist / baseDist, 0.45, 1.6);
    ry += dx * k; vy = dx * k;
    rx = clamp(rx + dy * k, -1.15, 1.15); vx = dy * k;
    if (hoverIdx >= 0) setHover(-1);
    dirty = true;
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (down && down.moved < 7 && performance.now() - down.t < 600) {
      const i = cellNear(surfacePoint(e.clientX, e.clientY), budget(e));
      if (i >= 0) {
        engaged = true;
        setSelected(i);
        if (typeof opts.onPick === 'function') { try { opts.onPick(ids[i]); } catch (err) { /* theirs */ } }
      }
    }
    down = null;
    if (!pointers.size) {
      holding = false;
      idleAt = performance.now() + 4500;      // the slow turn comes back once the user settles
      canvas.style.cursor = hoverIdx >= 0 ? 'pointer' : 'default';
    }
  }
  function onWheel(e) {
    // Scrolling past the hero must stay possible: the wheel only zooms once the visitor has taken
    // hold of the planet, and only while the pointer is actually on it.
    if (!engaged || !surfacePoint(e.clientX, e.clientY)) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    setZoom(zoom * Math.exp(-e.deltaY * unit * 0.0012));
    idleAt = performance.now() + 4500;
  }
  function onLeave() { setHover(-1); }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  function setSelected(i) {
    selIdx = i;
    mu.uSel.value = i;
    if (i >= 0) {
      ring.position.fromArray(mp, i * 3).multiplyScalar(1.0015);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ring.position.clone().normalize());
    }
    dirty = true;
  }

  const onVis = () => sync();
  const onWinResize = () => resize();
  const onMotion = (e) => {
    reduced = e.matches;
    mu.uStill.value = su.uStill.value = reduced ? 1 : 0;
    if (reduced) { introT = 1; dataT = gu.uHasData.value > 0.5 ? 1 : 0; }
    autoRotate = autoRotate && !reduced;
    dirty = true;
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('resize', onWinResize);
  if (motion.addEventListener) motion.addEventListener('change', onMotion);

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; sync(); }, { threshold: 0 });
  io.observe(canvas);

  const onLost = (e) => { e.preventDefault(); stop(); };
  canvas.addEventListener('webglcontextlost', onLost);

  resize();
  if (reduced) introT = 1;
  sync();
  // deep-linked past the hero: the loop may never run, but the caller still needs its callback
  const readyTimer = setTimeout(fireReady, 1500);

  /* -------------------------------------------------- the slower arrivals */
  // Clouds, city lights and the canopy field all fade in behind the first frame rather than
  // holding it up.
  loadTexture('assets/tex/clouds.webp', loader).then((t) => {
    if (disposed) { t.dispose(); return; }
    gu.uClouds.value = t; cu.uClouds.value = t;
    gu.uCloud.value = 0.62; cu.uOpacity.value = 0.62;
    dirty = true;
  }).catch(() => {});

  loadTexture('assets/tex/night-lights.webp', loader).then((t) => {
    if (disposed) { t.dispose(); return; }
    gu.uLights.value = t;
    dirty = true;
  }).catch(() => {});

  const age = [1, 150, 300].indexOf(Number(opts.age)) >= 0 ? Number(opts.age) : 150;
  loadCanopyFrame(age, opts.year).then((t) => {
    if (disposed) { t.dispose(); return; }
    gu.uData.value = t;
    gu.uHasData.value = 1;
    if (reduced) dataT = 1;
    dirty = true;
  }).catch(() => {});

  /* ------------------------------------------------------------------ API */
  return {
    /** Animate the camera to a location. opts: {zoom: 1 = default framing, higher is closer; ms}. */
    flyTo(toLat, toLon, o) {
      if (!isFinite(toLat) || !isFinite(toLon)) return;
      o = o || {};
      const f = facing(toLat, toLon);
      let ty = f.y;
      ty += Math.round((ry - ty) / (Math.PI * 2)) * Math.PI * 2;     // go the short way round
      const z = isFinite(o.zoom) ? clamp(o.zoom, Z_MIN, Z_MAX) : zoom;
      const ms = reduced ? 0 : Math.max(0, o.ms == null ? 1200 : o.ms);
      vx = vy = 0;
      if (!ms) {
        rx = clamp(f.x, -1.15, 1.15); ry = ty; zoom = z;
        fly = null; idleAt = performance.now() + 3200;
        layout(); dirty = true;
        return;
      }
      fly = { t0: performance.now(), ms, x0: rx, y0: ry, z0: zoom, x1: clamp(f.x, -1.15, 1.15), y1: ty, z1: z };
      idleAt = Infinity;
    },
    /** Highlight one site. Pass null (or an unknown id) to clear. */
    select(cellId) {
      let i = byId.has(cellId) ? byId.get(cellId) : -1;
      if (i < 0 && byId.has(Number(cellId))) i = byId.get(Number(cellId));
      setSelected(i);
    },
    setAutoRotate(on) {
      autoRotate = !!on && !reduced;
      if (autoRotate) idleAt = 0;
      dirty = true;
    },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      clearTimeout(readyTimer);
      ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onWinResize);
      if (motion.removeEventListener) motion.removeEventListener('change', onMotion);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onLost);
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const m = o.material;
        if (m) (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
      });
      [day, mask, blank, gu.uClouds.value, gu.uLights.value, gu.uData.value]
        .forEach((t) => { if (t && t.dispose) t.dispose(); });
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
    },
  };
}
