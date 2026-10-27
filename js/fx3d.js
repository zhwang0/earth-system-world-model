/**
 * fx3d.js — the stage's particles: flame, ember, smoke, dust and wood chips.
 *
 * Two point clouds, one blended additively (fire light) and one normally (smoke and dust). They are
 * decoration on top of the model's numbers: what burns, falls or stands is decided in forest3d.js
 * from the predicted canopy height; this file only makes the moment visible.
 *
 *   const fx = new FX(scene);
 *   fx.emit('flame', x, y, z, { s: 2 });   // sizes and speeds in metres, scaled by fx.scale
 *   fx.update(dt);                           // every frame
 */

import * as THREE from '../assets/vendor/three.module.js';

const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
uniform float uScale;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(-mv.z, 0.5);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uTex;
varying vec4 vColor;
void main() {
  float a = texture2D(uTex, gl_PointCoord).a * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <colorspace_fragment>
}`;

const TYPES = { flame: 0, ember: 1, glow: 2, smoke: 3, dust: 4, chip: 5 };

/** A soft round sprite, drawn once. */
function softTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,.62)');
  r.addColorStop(0.7, 'rgba(255,255,255,.16)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

const lin = (hex) => new THREE.Color(hex);           // sRGB in, linear out
const C = {
  flame0: lin(0xfff0b0), flame1: lin(0xff8a2a), flame2: lin(0xb3260c),
  ember: lin(0xffa040), glow: lin(0xff6a1c),
  smoke0: lin(0x6f6a64), smoke1: lin(0xb4aea6),
  dust: lin(0x9a8466), chip: lin(0xe2c08e),
};

class Cloud {
  constructor(scene, cap, blending, tex) {
    this.cap = cap;
    this.next = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.col = new Float32Array(cap * 4);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.vel = new Float32Array(cap * 3);
    this.age = new Float32Array(cap).fill(1);
    this.life = new Float32Array(cap).fill(1);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.seed = new Float32Array(cap);
    this.type = new Uint8Array(cap);
    this.alive = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTex: { value: tex }, uScale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      blending,
      toneMapped: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = blending === THREE.AdditiveBlending ? 4 : 3;
    scene.add(this.points);
  }

  spawn(type, x, y, z, vx, vy, vz, life, s0, s1) {
    const i = this.next;
    this.next = (i + 1) % this.cap;
    this.type[i] = type;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.seed[i] = Math.random() * 100;
  }

  update(dt, scale, windX) {
    let alive = 0;
    const { pos, vel, age, life, size, col } = this;
    for (let i = 0; i < this.cap; i++) {
      if (age[i] >= life[i]) { if (size[i] !== 0) { size[i] = 0; col[i * 4 + 3] = 0; } continue; }
      alive++;
      age[i] += dt;
      const u = Math.min(1, age[i] / life[i]);
      const t = this.type[i];
      const j = i * 3, k = i * 4;
      let ax = 0, ay = 0, drag = 1;
      let c, a, s;
      if (t === TYPES.flame) {
        ay = 7 * scale; drag = Math.exp(-dt * 2.2);
        ax = (Math.random() - 0.5) * 9 * scale;
        c = u < 0.4 ? mix(C.flame0, C.flame1, u / 0.4) : mix(C.flame1, C.flame2, (u - 0.4) / 0.6);
        a = smooth(0, 0.1, u) * Math.pow(1 - u, 1.3) * 0.95;
        s = this.s0[i] * (0.55 + 0.75 * Math.sin(Math.PI * Math.pow(u, 0.7)));
      } else if (t === TYPES.ember) {
        ay = 2.4 * scale; drag = Math.exp(-dt * 0.9);
        ax = windX * 0.6 + (Math.random() - 0.5) * 6 * scale;
        c = C.ember;
        a = (1 - u) * (0.55 + 0.45 * Math.sin(age[i] * 28 + this.seed[i]));
        s = this.s0[i];
      } else if (t === TYPES.glow) {
        drag = 0;
        c = C.glow;
        a = Math.sin(Math.PI * u) * 0.3;
        s = this.s0[i];
      } else if (t === TYPES.smoke) {
        ay = 1.1 * scale; drag = Math.exp(-dt * 0.55);
        ax = windX + (Math.random() - 0.5) * 1.5 * scale;
        c = mix(C.smoke0, C.smoke1, u);
        a = smooth(0, 0.12, u) * Math.pow(1 - u, 1.2) * 0.42;
        s = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(u);
      } else if (t === TYPES.dust) {
        ay = 0.4 * scale; drag = Math.exp(-dt * 2.6);
        c = C.dust;
        a = Math.pow(1 - u, 1.6) * 0.5;
        s = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(u);
      } else {
        ay = -9 * scale; drag = Math.exp(-dt * 0.8);
        c = C.chip;
        a = 1 - u;
        s = this.s0[i];
      }
      vel[j] = vel[j] * drag + ax * dt;
      vel[j + 1] = vel[j + 1] * drag + ay * dt;
      vel[j + 2] = vel[j + 2] * drag;
      pos[j] += vel[j] * dt;
      pos[j + 1] += vel[j + 1] * dt;
      pos[j + 2] += vel[j + 2] * dt;
      if (t === TYPES.chip && pos[j + 1] < 0.02) { pos[j + 1] = 0.02; vel[j] *= 0.5; vel[j + 1] = 0; vel[j + 2] *= 0.5; }
      size[i] = s;
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b; col[k + 3] = a;
    }
    this.alive = alive;
    const g = this.geo.attributes;
    g.position.needsUpdate = true;
    g.aSize.needsUpdate = true;
    g.aColor.needsUpdate = true;
  }

  clear() {
    this.age.fill(1);
    this.size.fill(0);
    this.col.fill(0);
    this.alive = 0;
    const g = this.geo.attributes;
    g.aSize.needsUpdate = true;
    g.aColor.needsUpdate = true;
  }
}

const _c = new THREE.Color();
function mix(a, b, u) { return _c.copy(a).lerp(b, Math.max(0, Math.min(1, u))); }
function smooth(e0, e1, x) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

export class FX {
  constructor(scene, { light = false } = {}) {
    const tex = softTexture();
    this.add = new Cloud(scene, light ? 900 : 1800, THREE.AdditiveBlending, tex);
    this.norm = new Cloud(scene, light ? 600 : 1200, THREE.NormalBlending, tex);
    this.scale = 1;        // metres per "reference metre": the stand's own size over 30 m
    this.wind = 1.6;       // m/s drift for smoke and embers
  }

  get busy() { return this.add.alive + this.norm.alive > 0; }

  /** Point sizes are in world metres; this converts them for the current view. */
  setView(heightPx, fovDeg) {
    const k = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.add.mat.uniforms.uScale.value = k;
    this.norm.mat.uniforms.uScale.value = k;
  }

  /**
   * Emit one particle. `s` is a size in reference metres. Velocities get a little spread so a
   * burst is never a column.
   */
  emit(kind, x, y, z, { s = 1, s1 = null, vx = 0, vy = 0, vz = 0, life = null } = {}) {
    const k = this.scale;
    const r = () => (Math.random() - 0.5);
    switch (kind) {
      case 'flame':
        this.add.spawn(TYPES.flame, x + r() * s * k * 0.5, y, z + r() * s * k * 0.5,
          r() * 1.5 * k, (2 + Math.random() * 3) * k, r() * 1.5 * k,
          life ?? 0.45 + Math.random() * 0.45, s * k, 0);
        break;
      case 'ember':
        this.add.spawn(TYPES.ember, x, y, z, r() * 3 * k, (2 + Math.random() * 5) * k, r() * 3 * k,
          life ?? 1.2 + Math.random() * 1.6, (0.1 + Math.random() * 0.12) * k, 0);
        break;
      case 'glow':
        this.add.spawn(TYPES.glow, x, y, z, 0, 0, 0, life ?? 0.35, s * k, 0);
        break;
      case 'smoke':
        this.norm.spawn(TYPES.smoke, x + r() * s * k, y, z + r() * s * k,
          vx + r() * 1.2 * k, (vy || 2.5 + Math.random() * 2) * k, vz + r() * 1.2 * k,
          life ?? 3 + Math.random() * 2.5, s * k, (s1 ?? s * 5) * k);
        break;
      case 'dust':
        this.norm.spawn(TYPES.dust, x, y, z, vx + r() * 4 * k, (0.5 + Math.random()) * k, vz + r() * 4 * k,
          life ?? 0.9 + Math.random() * 0.8, s * k, (s1 ?? s * 4) * k);
        break;
      case 'chip':
        this.norm.spawn(TYPES.chip, x, y, z, r() * 5 * k, (2 + Math.random() * 3) * k, r() * 5 * k,
          life ?? 0.7 + Math.random() * 0.5, (0.07 + Math.random() * 0.06) * k, 0);
        break;
      default:
    }
  }

  update(dt) {
    const d = Math.min(dt, 0.05);
    this.add.update(d, this.scale, this.wind * this.scale);
    this.norm.update(d, this.scale, this.wind * this.scale);
  }

  clear() { this.add.clear(); this.norm.clear(); }
}
