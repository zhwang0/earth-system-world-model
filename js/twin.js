/**
 * twin.js — a digital twin of a forest landscape, run by the paper's world model.
 *
 * 256 cells of the western Amazon stand on a board, each one the world model rolling its own forty
 * years from its own climate record, in parallel workers (twin-pool.js), live. Paint an intervention
 * onto the board, a tool and a year per cell, and the edited cells are re-run; the timeline then
 * plays the landscape through.
 *
 * Trees follow the same rule as the single-site stand (stand.js): in every year a cell's trees
 * average the canopy height the model predicts there; a shortfall shows as cleared trees (stumps,
 * or snags after a fire), added growth as taller ones. Crowns are coloured by that height.
 *
 *   const twin = await createTwin({ root, base, manifest });   // null without WebGL
 */

import * as THREE from '../assets/vendor/three.module.js';
import { Pool } from './twin-pool.js';
import { Geo } from './twin-geo.js';
import { Locator } from './locator.js';
import { svgIcon } from './icons.js';

const YEARS = 41;
const YEAR0 = 1981;
const SEED = 5;
const YEAR_MS = 70;          // playback: one simulated year
const GROW_MS = 520;         // a cell's trees rising when its first rollout lands
const SLAB = 0.16;           // tile thickness; a tile is 1 wide
const GAP = 0.07;
const TREE_H = 0.78;         // a tree of the region's typical height stands this tall
const D2R = Math.PI / 180;
const R_EARTH_KM = 6371.0088;

const TOOLS = [
  { id: 'log', label: 'Log', icon: 'axe', color: 0xF2994A, mag: -6, what: '6 m of canopy cut' },
  { id: 'fire', label: 'Burn', icon: 'flame', color: 0xE5533A, mag: -4, what: 'a stand-replacing fire' },
  { id: 'replant', label: 'Replant', icon: 'sprout', color: 0x9CC46A, ramp: 0.35, span: 12,
    what: 'twelve years of faster growth' },
  { id: 'protect', label: 'Protect', icon: 'shield', color: 0x6CC3E8, ramp: 0.15, span: null,
    what: 'a little extra growth every year' },
  { id: 'erase', label: 'Erase', icon: 'eraser', color: null, what: 'back to no action' },
];
const TOOL = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
const TOOL_COLOR = Object.fromEntries(TOOLS.filter((t) => t.color != null).map((t) => [t.id, new THREE.Color(t.color)]));
const FLARE = new THREE.Color(0xFFD27A);

// crowns, short to tall: the globe's canopy ramp, lifted a little to read under the lights
const RAMP = [0x0d4a35, 0x1d7a4f, 0x3fa865, 0x8fd27a, 0xcfeea0].map((h) => new THREE.Color(h));
const FLOOR = new THREE.Color(0x2c3527);
const TRUNK = new THREE.Color(0x4a3a2c);
const STUMP = new THREE.Color(0xc9a277);
const EARTH = new THREE.Color(0x8a6744);
const SNAG = new THREE.Color(0x2a2522);
const SCORCH = new THREE.Color(0x7d6a3a);
// the Change view: canopy height against no action, lower in orange, higher in green
const NEUTRAL = new THREE.Color(0x56635a);
const LOWER = new THREE.Color(0xF2994A);
const HIGHER = new THREE.Color(0x9CE07A);

/** A tiny seeded generator, so the landscape is laid out the same way every visit. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (t) => 1 - (1 - t) ** 3;

/** Band `b` of a (41*7) run at a fractional year. */
function at(run, y, b) {
  const i = Math.max(0, Math.min(YEARS - 1, y));
  const i0 = Math.floor(i), i1 = Math.min(YEARS - 1, i0 + 1), f = i - i0;
  return run[i0 * 7 + b] * (1 - f) + run[i1 * 7 + b] * f;
}

function ramp(t, out) {
  const x = clamp01(t) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return out.copy(RAMP[i]).lerp(RAMP[i + 1], x - i);
}

/** The worked example: logging that spreads west through the forest, side cuts off it, a fire near it. */
function example(rows, cols) {
  const out = [];
  const front = Math.floor(rows / 2);
  for (let c = cols - 1; c >= 3; c--) out.push([front, c, 'log', Math.round(12 + (cols - 1 - c) * 1.5)]);
  for (const [c, y] of [[cols - 3, 17], [cols - 6, 21], [cols - 9, 26], [cols - 12, 30]]) {
    for (const d of [-3, -2, -1, 1, 2, 3]) out.push([front + d, c, 'log', Math.min(40, y + Math.abs(d))]);
  }
  for (const [r, c] of [[3, 9], [3, 10], [4, 9], [4, 10], [4, 11], [5, 10]]) out.push([r, c, 'fire', 27]);
  return out;
}

export async function createTwin(opts) {
  const twin = new Twin(opts);
  try {
    await twin.init();
    return twin;
  } catch (err) {
    console.warn('twin unavailable:', err);
    twin.fail(err);
    return null;
  }
}

class Twin {
  constructor({ root, base, manifest, region = 'amazon', age = 150, intro = true }) {
    Object.assign(this, { root, base, manifest, region, age: String(age) });
    this.introDone = !intro;          // intro: false skips the first look's flight (_intro)
    this.$ = (s) => root.querySelector(s);
    this.env = manifest.ages[this.age].action_envelope;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.coarse = matchMedia('(pointer: coarse)').matches;
    this.light = this.coarse || Math.min(window.innerWidth, window.innerHeight) < 620;
    this.tool = 'log';
    this.brush = this.coarse ? 3 : 1;
    // the first look is the region from high above; it zooms to the block, then settles onto the
    // board (_intro)
    this.view = this.reduced ? 'forest' : 'map';
    this.poseName = this.view === 'map' ? 'wide' : 'board';
    this.treeK = this.view === 'map' ? 0 : 1;
    this.editYear = 20;
    this.fy = YEARS - 1;               // the focus year, fractional while playing
    this.playing = false;
    this.visible = false;
    this.dirty = true;
    this.raf = 0;
    this.nFree = 0;
    this._loop = this._loop.bind(this);
  }

  /* ------------------------------------------------------------ boot */

  async init() {
    if (!document.createElement('canvas').getContext('webgl2')) throw new Error('no WebGL2');
    this.root.dataset.state = 'loading';
    this.meta = await (await fetch(`${this.base}/assets/twin/${this.region}.json`)).json();
    this._cells();
    this._scene();
    this._ui();
    this._wire();
    this._place();
    this._status('Starting the model…');
    this.t0 = performance.now();
    this.pool = new Pool({ base: this.base, region: this.region, age: this.age, size: this.light ? 3 : undefined });
    this.pool.onResult = (cell, v, run) => this._result(cell, v, run);
    this.pool.onIdle = () => this._idle();
    await this.pool.ready;
    // every cell's undisturbed forty years, then the worked example on top
    this.pool.submit(this.cells.filter((c) => c.forest).map((c) => ({ cell: c.i, v: 0, actions: null })));
    this._loadExample(false);
  }

  fail(err) {
    this.root.dataset.state = 'failed';
    this._status(err && /WebGL/.test(err.message)
      ? 'This part needs WebGL, which this browser has not made available.'
      : `The landscape could not start (${(err && err.message) || 'unknown error'}).`);
  }

  _cells() {
    const m = this.meta;
    const dl = m.res_deg * D2R;
    this.cells = m.cells.map(([row, col, lat, lon, , forest, split], i) => {
      const p0 = (lat - m.res_deg / 2) * D2R, p1 = (lat + m.res_deg / 2) * D2R;
      return {
        i, row, col, lat, lon, forest, split,
        area: R_EARTH_KM * R_EARTH_KM * dl * (Math.sin(p1) - Math.sin(p0)) * 1e6,     // m^2
        free: null, act: null, edit: null, v: 0, born: -1, deferred: false,
      };
    });
    this.grid = (r, c) => (r >= 0 && r < m.rows && c >= 0 && c < m.cols ? this.cells[r * m.cols + c] : null);
  }

  /* ------------------------------------------------------------ scene */

  _xz(c) {
    return [c.col - (this.meta.cols - 1) / 2, c.row - (this.meta.rows - 1) / 2];
  }

  _scene() {
    const canvas = this.$('#tw-canvas');
    const r = this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
    });
    r.setPixelRatio(Math.min(this.light ? 1.5 : 2, window.devicePixelRatio || 1));
    r.setClearColor(0x000000, 0);
    r.shadowMap.enabled = !this.light;
    r.shadowMap.type = THREE.PCFShadowMap;

    const scene = this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(30, 1, 0.5, 300);

    scene.add(new THREE.HemisphereLight(0xdcefff, 0x16251c, 1.3));
    const sun = new THREE.DirectionalLight(0xfff0d6, 2.4);
    sun.position.set(-9, 15, 7);
    if (!this.light) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 50 });
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.03;
    }
    scene.add(sun);

    const { rows, cols } = this.meta;
    const n = this.cells.length;
    const K = this.K = this.light ? 4 : 7;

    const plinth = new THREE.Mesh(new THREE.BoxGeometry(cols + 0.7, 0.6, rows + 0.7),
      new THREE.MeshStandardMaterial({ color: 0x0f1915, roughness: 0.9 }));
    plinth.position.y = -SLAB - 0.302;
    plinth.receiveShadow = true;
    scene.add(plinth);

    // each tile wears its own 0.5° of the satellite image (twin-geo.js); a clearing or an edit tints
    // it by aMix
    const slabGeo = new THREE.BoxGeometry(1 - GAP, SLAB, 1 - GAP).translate(0, -SLAB / 2, 0);
    this.slabMix = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    slabGeo.setAttribute('aMix', this.slabMix);
    const slabMat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
    this.geo = new Geo({ base: this.base, meta: this.meta, scene, layer: this.$('#tw-labels') });
    this.geo.slabShader(slabMat);
    this.slabs = new THREE.InstancedMesh(slabGeo, slabMat, n);
    this.slabs.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    for (const c of this.cells) {
      const [x, z] = this._xz(c);
      this.slabs.setMatrixAt(c.i, m4.makeTranslation(x, 0, z));
      this.slabs.setColorAt(c.i, FLOOR);
    }
    scene.add(this.slabs);

    const trunkGeo = new THREE.CylinderGeometry(0.5, 0.75, 1, 5, 1).translate(0, 0.5, 0);
    const crownGeo = new THREE.IcosahedronGeometry(0.5, 1);
    this.trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ roughness: 1 }), n * K);
    this.crowns = new THREE.InstancedMesh(crownGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }), n * K);
    for (const mesh of [this.trunks, this.crowns]) {
      mesh.castShadow = !this.light;
      mesh.receiveShadow = !this.light;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
    }

    // a square outline on each edited tile, in its tool's colour
    const half = (1 - GAP) / 2;
    const ring = new THREE.RingGeometry((half - 0.075) * Math.SQRT2, half * Math.SQRT2, 4, 1)
      .rotateZ(Math.PI / 4).rotateX(-Math.PI / 2).translate(0, 0.006, 0);
    this.frames = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({ toneMapped: false }), n);
    this.frames.count = 0;
    scene.add(this.frames);
    this.brushMesh = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, toneMapped: false, depthTest: false,
    }));
    this.brushMesh.renderOrder = 2;
    this.brushMesh.visible = false;
    scene.add(this.brushMesh);

    // tree layouts: a ring of six around a centre (four in a square on light devices), turned per
    // tile, with a seeded order in which a tile's trees give way when it is cleared
    const rnd = rng(20261103);
    const pattern = K === 7
      ? [[0, 0], ...Array.from({ length: 6 }, (_, k) => [0.29 * Math.cos(k * Math.PI / 3), 0.29 * Math.sin(k * Math.PI / 3)])]
      : [[-0.21, -0.21], [0.21, -0.21], [-0.21, 0.21], [0.21, 0.21]];
    for (const c of this.cells) {
      const rot = rnd() * Math.PI * 2, cr = Math.cos(rot), sr = Math.sin(rot);
      const rel = pattern.map(() => 0.82 + 0.36 * rnd());
      const emergent = Math.floor(rnd() * K);           // one rainforest emergent a tile
      rel[emergent] *= 1.22;
      const mean = rel.reduce((s, v) => s + v, 0) / K;
      const order = pattern.map((_, k) => k);
      for (let k = K - 1; k > 0; k--) {
        const j = Math.floor(rnd() * (k + 1));
        [order[k], order[j]] = [order[j], order[k]];
      }
      c.trees = pattern.map(([px, pz], k) => ({
        ox: px * cr - pz * sr + (rnd() - 0.5) * 0.05,
        oz: px * sr + pz * cr + (rnd() - 0.5) * 0.05,
        rel: rel[k] / mean,
        wid: 0.85 + 0.3 * rnd(),
        emergent: k === emergent,
        rank: (order.indexOf(k) + 0.5) / K,
        jit: rnd() * 2 - 1,
      }));
    }
    this._tmp = { m: new THREE.Matrix4(), p: new THREE.Vector3(), q: new THREE.Quaternion(),
      s: new THREE.Vector3(), c: new THREE.Color(), c2: new THREE.Color() };
    this._fit();
    this.geo.load().then(() => { this._labelsDirty = true; this._draw(); })
      .catch((err) => console.warn('twin: no map layer', err));
  }

  /**
   * The two camera poses, each fitted to the canvas: the board in 3D, with room for the readouts,
   * and the map straight from above, the block with the country around it.
   */
  _fit() {
    const canvas = this.$('#tw-canvas');
    const w = canvas.clientWidth || 800, h = canvas.clientHeight || 500;
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
    const { rows, cols } = this.meta;
    const box = (x0, x1, z0, z1, ys) => {
      const out = [];
      for (const x of [x0, x1]) for (const z of [z0, z1]) for (const y of ys) out.push(new THREE.Vector3(x, y, z));
      return out;
    };
    // the board fits between the readouts: on a phone they stack above it, so it sits lower
    const narrow = w < 600;
    const win = narrow ? [-1 + 2 * (88 / h), 1 - 2 * (124 / h)] : [-0.88, 0.7];
    const top = (pts) => this._fitPose({ azim: 0, elev: 1.38, target: new THREE.Vector3(0, -0.4, 0.5) }, pts, 0.98, [-0.86, 0.84]);
    this.poses = {
      board: this._fitPose({ azim: 0.52, elev: 0.74, target: new THREE.Vector3(0, 0, 0.6) },
        box(-cols / 2, cols / 2, -rows / 2, rows / 2, [-0.5, 0.9]), narrow ? 0.98 : 0.92, win),
      map: top(box(-cols / 2 - 5, cols / 2 + 5, -rows / 2 - 3.5, rows / 2 + 3.5, [-0.76])),
      wide: top(box(-cols / 2 - 13, cols / 2 + 13, -rows / 2 - 9, rows / 2 + 9, [-0.76])),
    };
    const want = this.poses[this.poseName];
    if (!this.pose || !this.camAnim) this.pose = { ...want, target: want.target.clone() };
    else this.camAnim.to = this.poses[this.camAnim.name];
    this._placeCam(this.pose);
    this._labelsDirty = true;
    this.dirty = true;
  }

  /** A pose whose view holds `pts` within ±fx across and within the [bottom, top] window, in NDC. */
  _fitPose(p, pts, fx, [bot, top]) {
    const P = { ...p, target: p.target.clone(), dist: 30 };
    const v = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();
    const tanH = Math.tan((this.cam.fov * Math.PI) / 360);
    for (let it = 0; it < 8; it++) {
      this._placeCam(P);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of pts) {
        v.copy(q).project(this.cam);
        x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
        y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
      }
      P.dist *= Math.max((x1 - x0) / (2 * fx), (y1 - y0) / (top - bot));
      // then slide the view so the box sits in its window
      up.set(0, 1, 0).applyQuaternion(this.cam.quaternion);
      right.set(1, 0, 0).applyQuaternion(this.cam.quaternion);
      P.target.addScaledVector(up, ((y0 + y1) / 2 - (top + bot) / 2) * P.dist * tanH)
        .addScaledVector(right, ((x0 + x1) / 2) * P.dist * tanH * this.cam.aspect);
    }
    return P;
  }

  _placeCam(p) {
    const cam = this.cam;
    cam.position.set(p.dist * Math.cos(p.elev) * Math.sin(p.azim), p.dist * Math.sin(p.elev),
      p.dist * Math.cos(p.elev) * Math.cos(p.azim)).add(p.target);
    cam.lookAt(p.target);
    cam.updateMatrixWorld();
  }

  /** Change the view; between the map and the board the camera flies and the trees rise or sink. */
  _setView(v) {
    this.view = v;
    this._viewBtns();
    const want = v === 'map' ? 'map' : 'board';
    if (this.poses && this.poseName !== want) this._fly(want, 1700, want === 'board' || this.poseName === 'board');
    this._draw();
  }

  /** Fly the camera to a named pose; `arc` lifts it on the way, between the map and the board. */
  _fly(name, ms, arc = false) {
    this.poseName = name;
    this.camAnim = { name, arc, from: { ...this.pose, target: this.pose.target.clone() }, to: this.poses[name],
      t0: performance.now(), ms: this.reduced ? 0 : ms };
    this._draw();
  }

  /** The globe in the corner, turned to the block. */
  _place() {
    const m = this.meta;
    const lat = m.lat0 - ((m.rows - 1) / 2) * m.res_deg, lon = m.lon0 + ((m.cols - 1) / 2) * m.res_deg;
    const cv = this.$('#tw-globe');
    if (cv) new Locator(cv, this.$('#tw-pin')).flyTo(lat, lon, 0);
  }

  /* ------------------------------------------------------------ the trees */

  _trees(now) {
    const { m, p, q, s, c: col, c2 } = this._tmp;
    const y = this.fy, K = this.K;
    const hs = TREE_H / this.meta.h_ref;
    const tall = this.meta.h_ref * 1.25;
    const change = this.view === 'change';
    let growing = false;
    for (const c of this.cells) {
      const [x, z] = this._xz(c);
      let grow = 0;
      if (c.free) {
        const t = this.reduced || c.born < 0 ? 1 : clamp01((now - c.born) / GROW_MS);
        if (t < 1) growing = true;
        grow = easeOut(t) * this.treeK;
      }
      const hF = c.free ? at(c.free, y, 0) : 0;
      const hA = c.act ? at(c.act, y, 0) : hF;
      const ratio = hF > 1e-6 ? hA / hF : 1;
      const cleared = Math.max(0, 1 - ratio);
      c.cleared = cleared;                                 // the ground shows through (_frames)
      const standing = ratio >= 1 ? hA : hF;
      const fireYear = c.act && c.edit && c.edit.tool === 'fire' ? c.edit.year : -1;
      const fire = fireYear >= 0 && y >= fireYear - 0.5;
      // relative difference from no action; a third of the canopy reads at full colour
      const d = Math.max(-1, Math.min(1, (ratio - 1) / 0.33));
      if (change) {
        col.copy(NEUTRAL).lerp(d < 0 ? LOWER : HIGHER, Math.abs(d) ** 0.7);
      } else {
        ramp(standing / tall, col);
        if (fire) col.lerp(SCORCH, 0.6 * Math.exp(-(y - fireYear) / 4));
        // the forest view keeps its colours, but an edited tile leans toward its change colour
        if (c.act && d !== 0) col.lerp(d < 0 ? LOWER : HIGHER, 0.5 * Math.abs(d) ** 0.7);
      }

      for (let k = 0; k < K; k++) {
        const t = c.trees[k], idx = c.i * K + k;
        const gone = clamp01((cleared - t.rank) * K + 0.5);
        const h = Math.max(1e-3, t.rel * standing * hs * grow);
        p.set(x + t.ox, 0, z + t.oz);
        if (gone > 0.97 && grow > 0) {
          // cleared: a stump, or a fire-killed snag
          if (fire) {
            s.set(0.05, h * 0.5, 0.05);
            this.trunks.setColorAt(idx, SNAG);
          } else {
            s.set(0.12, 0.06 * this.treeK, 0.12);
            this.trunks.setColorAt(idx, STUMP);
          }
          this.trunks.setMatrixAt(idx, m.compose(p, q, s));
          s.set(0, 0, 0);
          this.crowns.setMatrixAt(idx, m.compose(p, q, s));
          continue;
        }
        const hh = h * (1 - gone);
        const cw = 0.24 * t.wid * Math.min(1, 0.5 + 0.5 * hh / TREE_H) * Math.min(1, this.treeK * 3);
        if (t.emergent) {
          // a tall bole under a broad, flat crown
          s.set(0.055, hh * 0.84, 0.055);
          this.trunks.setMatrixAt(idx, m.compose(p, q, s));
          p.y = hh * 0.87;
          s.set(cw * 1.5, hh * 0.24, cw * 1.5);
        } else {
          s.set(0.045, hh * 0.6, 0.045);
          this.trunks.setMatrixAt(idx, m.compose(p, q, s));
          p.y = hh * 0.68;
          s.set(cw, hh * 0.5, cw);
        }
        this.trunks.setColorAt(idx, TRUNK);
        this.crowns.setMatrixAt(idx, m.compose(p, q, s));
        c2.copy(col).offsetHSL(0, 0, t.jit * 0.035);
        this.crowns.setColorAt(idx, c2);
      }
    }
    for (const mesh of [this.trunks, this.crowns]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    return growing;
  }

  /** Edited tiles: an outline in the tool's colour; a burn flares in its year, then settles. */
  _frames() {
    const { m, c: col } = this._tmp;
    let n = 0;
    const mix = this.slabMix.array;
    for (const c of this.cells) {
      // bare earth where the stand has been cleared, a hint of the tool's colour under any edit;
      // on the tile's top these tint the satellite image rather than replace it
      const bare = Math.min(1, (c.cleared || 0) * 1.7);
      col.copy(FLOOR).lerp(EARTH, bare);
      const tint = c.edit ? TOOL_COLOR[c.edit.tool] : null;
      if (tint) col.lerp(tint, 0.12);
      this.slabs.setColorAt(c.i, col);
      mix[c.i] = Math.min(1, bare * 0.85 + (tint ? 0.14 : 0));
      if (!c.edit) continue;
      const [x, z] = this._xz(c);
      this.frames.setMatrixAt(n, m.makeTranslation(x, 0, z));
      col.copy(tint);
      if (c.edit.tool === 'fire' && c.act) {
        const dt = this.fy - c.edit.year;
        if (dt > -0.6) col.lerp(FLARE, 0.85 * Math.exp(-Math.max(0, dt) / 1.4));
      }
      this.frames.setColorAt(n, col);
      n++;
    }
    this.frames.count = n;
    this.frames.instanceMatrix.needsUpdate = true;
    if (this.frames.instanceColor) this.frames.instanceColor.needsUpdate = true;
    this.slabs.instanceColor.needsUpdate = true;
    this.slabMix.needsUpdate = true;
  }

  /* ------------------------------------------------------------ the loop */

  _kick() {
    if (!this.raf && this.visible) this.raf = requestAnimationFrame(this._loop);
  }

  _loop(now) {
    this.raf = 0;
    const dt = Math.min(0.1, Math.max(0, (now - (this._last || now)) / 1000));
    this._last = now;
    if (this.playing) {
      const y = this.playFrom + (now - this.playT0) / YEAR_MS;
      if (y >= YEARS - 1) { this.playing = false; this._setYear(YEARS - 1); this._playBtn(); }
      else this._setYear(y);
    }
    let moving = false;
    if (this.camAnim) {
      const a = this.camAnim;
      const u = a.ms ? clamp01((now - a.t0) / a.ms) : 1;
      const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
      const P = this.pose;
      P.azim = a.from.azim + (a.to.azim - a.from.azim) * e;
      P.elev = a.from.elev + (a.to.elev - a.from.elev) * e;
      // fly out and back in, rather than straight across
      P.dist = (a.from.dist + (a.to.dist - a.from.dist) * e) * (a.arc ? 1 + 0.12 * Math.sin(Math.PI * e) : 1);
      P.target.lerpVectors(a.from.target, a.to.target, e);
      this._placeCam(P);
      if (u >= 1) this.camAnim = null;
      this._labelsDirty = true;
      moving = true;
    }
    const kTo = this.view === 'map' ? 0 : 1;
    if (this.treeK !== kTo) {
      const step = this.reduced ? 1 : dt / 0.9;
      this.treeK = kTo > this.treeK ? Math.min(kTo, this.treeK + step) : Math.max(kTo, this.treeK - step);
      this._labelsDirty = true;
      moving = true;
    }
    if (this.geo.uCtx) this.geo.uCtx.uBright.value = 0.5 + 0.38 * (1 - this.treeK);
    this.geo.uGain.value = 1.35 + 0.5 * (1 - this.treeK);      // the photograph reads brighter as a map
    const growing = this._trees(now);
    this._frames();
    if (this._labelsDirty && this.geo.ready) {
      const cv = this.renderer.domElement;
      this.geo.place(this.cam, cv.clientWidth, cv.clientHeight, this.view, this.treeK);
      this._labelsDirty = false;
    }
    this.renderer.render(this.scene, this.cam);
    this.dirty = false;
    if (this.visible && (this.playing || growing || moving || this.dirty)) this.raf = requestAnimationFrame(this._loop);
    else this._last = 0;
  }

  _draw() {
    this.dirty = true;
    this._kick();
  }

  /* ------------------------------------------------------------ the model */

  _actions(c) {
    const t = TOOL[c.edit.tool];
    const a = new Float32Array(YEARS).fill(NaN);
    const clampA = (v) => Math.min(this.env.max, Math.max(this.env.min, v));
    const y0 = c.edit.year;
    if (t.mag != null) a[y0] = clampA(t.mag);
    else {
      // a ramp adds to whatever this cell would have done by itself
      const end = t.span == null ? YEARS : Math.min(YEARS, y0 + t.span);
      for (let y = Math.max(y0, SEED); y < end; y++) {
        a[y] = clampA(c.free[y * 7] - c.free[(y - 1) * 7] + t.ramp);
      }
    }
    return a;
  }

  /** Re-run these cells under their current edits. Erased cells simply drop their scenario. */
  _run(list) {
    const jobs = [];
    for (const c of list) {
      c.v += 1;                           // anything still in flight for this cell is now stale
      c.deferred = false;
      if (!c.edit) { c.act = null; continue; }
      if (TOOL[c.edit.tool].ramp != null && !c.free) { c.deferred = true; continue; }
      jobs.push({ cell: c.i, v: c.v, actions: this._actions(c) });
    }
    if (jobs.length) {
      if (this.nFree >= this.nForest) {
        this.runT0 = performance.now();
        this.runN = jobs.length;
        this._status(`Running ${jobs.length} edited cell${jobs.length > 1 ? 's' : ''}…`, true);
      }
      this.pool.submit(jobs, { front: this.nFree >= this.nForest });
    }
    const years = list.filter((c) => c.edit).map((c) => c.edit.year);
    this.playFromNext = years.length ? Math.max(0, Math.min(...years) - 4) : null;
    this._carbon();
    this._draw();
    // nothing to re-run (an erase, a clear): replay what is left straight away
    if (!jobs.length) this._replay();
  }

  /** Play the landscape again from just before its earliest edit, or from 1981 when there is none. */
  _replay() {
    if (!this.booted) return;
    const years = this.cells.filter((c) => c.edit).map((c) => c.edit.year);
    const from = years.length ? Math.max(0, Math.min(...years) - 4) : 0;
    // edits still running: _idle plays once they land
    if (this.runT0) { this.playFromNext = from; return; }
    this._play(from);
  }

  _result(cell, v, run) {
    const c = this.cells[cell];
    if (v === 0) {
      c.free = run;
      c.born = performance.now();
      this.nFree += 1;
      if (c.deferred) this._run([c]);
      if (this.nFree < this.nForest && !this._introOn) {
        this._status(`Simulating ${this.nForest} forest cells, 1981–2021… ${this.nFree}/${this.nForest}`, true);
      }
    } else if (v === c.v) {
      c.act = run;
    } else {
      return;                             // superseded by a newer edit
    }
    this._carbon();
    this._draw();
  }

  _idle() {
    if (this.nFree < this.nForest) return;
    const first = !this.booted;
    this.booted = true;
    this.root.dataset.state = 'ready';
    if (first) {
      const s = (performance.now() - this.t0) / 1000;
      this._liveMsg = `Live · ${this.nForest} cells, ${this.nForest + this.runN0} forty-year runs ` +
        `in ${s.toFixed(1)} s on ${this.pool.size} worker${this.pool.size > 1 ? 's' : ''}`;
      if (!this._introOn) this._status(this._liveMsg);
      this._play(0);
    } else if (this.runT0) {
      const s = (performance.now() - this.runT0) / 1000;
      this._status(`Live · ${this.runN} edited cell${this.runN > 1 ? 's' : ''} re-ran in ${s.toFixed(2)} s`);
      this.runT0 = 0;
      if (this.playFromNext != null) this._play(this.playFromNext);
    }
  }

  /* ------------------------------------------------------------ editing */

  _loadExample(run = true) {
    for (const c of this.cells) c.edit = null;
    const ex = example(this.meta.rows, this.meta.cols);
    for (const [r, cc, tool, year] of ex) {
      const c = this.grid(r, cc);
      if (c && c.forest) c.edit = { tool, year };
    }
    this.nForest = this.cells.filter((c) => c.forest).length;
    this.runN0 = ex.length;
    this._run(this.cells);
    if (run) this._draw();
  }

  _clear() {
    const had = this.cells.filter((c) => c.edit);
    for (const c of had) c.edit = null;
    this._run(had);
    this._status('Cleared · every cell back to no action');
  }

  /** Board cell under a pointer, or null. */
  _pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this._ray = this._ray || new THREE.Raycaster();
    this._ray.setFromCamera(ndc, this.cam);
    const hit = new THREE.Vector3();
    if (!this._ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    const col = Math.floor(hit.x + this.meta.cols / 2), row = Math.floor(hit.z + this.meta.rows / 2);
    return this.grid(row, col);
  }

  _paint(at, changed) {
    const h = Math.floor(this.brush / 2);
    for (let dr = -h; dr <= h; dr++) for (let dc = -h; dc <= h; dc++) {
      const c = this.grid(at.row + dr, at.col + dc);
      if (!c || !c.forest) continue;
      if (this.tool === 'erase') {
        if (c.edit) { c.edit = null; changed.add(c); }
      } else if (!c.edit || c.edit.tool !== this.tool || c.edit.year !== this.editYear) {
        c.edit = { tool: this.tool, year: this.editYear };
        changed.add(c);
      }
    }
  }

  _showBrush(c) {
    if (!c) { this.brushMesh.visible = false; return; }
    const [x, z] = this._xz(c);
    this.brushMesh.position.set(x, 0.01, z);
    this.brushMesh.scale.set(this.brush, 1, this.brush);
    this.brushMesh.visible = true;
  }

  /* ------------------------------------------------------------ time */

  _setYear(y) {
    this.fy = y;
    const yr = YEAR0 + Math.round(y);
    this.$('#tw-year').textContent = String(yr);
    this.$('#tw-c-year').textContent = String(yr);
    this.$('#tw-scrub').value = String(y);
    this._carbonAt();
    if (this._hover && !this.$('#tw-tip').hidden) this._tip(...this._hover);
    this.dirty = true;
  }

  _play(from) {
    if (this.reduced) { this._setYear(YEARS - 1); this._draw(); return; }
    if (!this.seen) { this.pendingPlay = from; this._setYear(YEARS - 1); this._draw(); return; }
    this.playing = true;
    this.playFrom = from;
    this.playT0 = performance.now();
    this._setYear(from);
    this._playBtn();
    this._kick();
  }

  _pause() {
    this.playing = false;
    this._playBtn();
  }

  _playBtn() {
    const b = this.$('#tw-play');
    b.classList.toggle('is-playing', this.playing);
    b.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
  }

  /* ------------------------------------------------------------ carbon */

  /** The edits' effect on the block's aboveground carbon, every year: Mt C, from each cell's true area. */
  _carbon() {
    const diff = new Float64Array(YEARS);
    let nEd = 0, area = 0;
    for (const c of this.cells) {
      if (!c.free) continue;
      if (c.edit) { nEd++; area += c.area; }
      if (!c.act) continue;
      for (let y = 0; y < YEARS; y++) diff[y] += (c.act[y * 7 + 1] - c.free[y * 7 + 1]) * c.area / 1e9;
    }
    Object.assign(this, { diff, nEd, areaEd: area });
    this._chart();
    this._carbonAt();
  }

  _carbonAt() {
    if (!this.diff) return;
    const y = this.fy;
    let tot = 0;
    for (const c of this.cells) if (c.free) tot += at(c.act || c.free, y, 1) * c.area / 1e9;
    const i0 = Math.floor(y), f = y - i0, d = this.diff[i0] * (1 - f) + this.diff[Math.min(YEARS - 1, i0 + 1)] * f;
    const all = this.nFree >= this.nForest;
    this.$('#tw-c-total').textContent = all ? `${Math.round(tot).toLocaleString('en-US')} Mt C` : '…';
    const del = this.$('#tw-c-delta');
    if (!this.nEd) {
      del.textContent = 'No edits. Pick a tool and paint the board.';
      del.dataset.sign = 'flat';
    } else {
      const sg = Math.abs(d) < 0.05 ? '' : d > 0 ? '+' : '−';
      del.innerHTML = `Your edits <b>${sg}${Math.abs(d).toFixed(1)} Mt C</b>` +
        `<span>≈ ${sg}${Math.abs(d * 44 / 12).toFixed(0)} Mt CO₂ · ${this.nEd} cells, ` +
        `${Math.round(this.areaEd / 1e6 / 1000).toLocaleString('en-US')}k km²</span>`;
      del.dataset.sign = d > 0.05 ? 'pos' : d < -0.05 ? 'neg' : 'flat';
    }
    if (this.headX) {
      const x = (y / (YEARS - 1)) * 200;
      this.headX.setAttribute('x1', x);
      this.headX.setAttribute('x2', x);
    }
  }

  _chart() {
    const svg = this.$('#tw-c-chart');
    const NS = 'http://www.w3.org/2000/svg';
    svg.textContent = '';
    if (!this.nEd) { this.headX = null; return; }
    let lo = 0, hi = 0;
    for (const v of this.diff) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pad = (hi - lo) * 0.1 || 1;
    lo -= lo < 0 ? pad : 0; hi += hi > 0 ? pad : 0;
    const Y = (v) => 4 + 40 * (1 - (v - lo) / (hi - lo || 1));
    const X = (i) => (i / (YEARS - 1)) * 200;
    let d = `M0 ${Y(0).toFixed(1)}`;
    for (let i = 0; i < YEARS; i++) d += `L${X(i).toFixed(1)} ${Y(this.diff[i]).toFixed(1)}`;
    d += `L200 ${Y(0).toFixed(1)}Z`;
    const mk = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); svg.append(e); return e; };
    mk('line', { class: 'tw-c-zero', x1: 0, x2: 200, y1: Y(0), y2: Y(0) });
    mk('path', { class: 'tw-c-area', d });
    this.headX = mk('line', { class: 'tw-c-head', y1: 2, y2: 46 });
  }

  /* ------------------------------------------------------------ the page */

  _status(text, busy = false) {
    const s = this.$('#tw-status');
    s.textContent = text;
    s.dataset.busy = busy ? '1' : '';
  }

  _ui() {
    const tools = this.$('#tw-tools');
    tools.textContent = '';
    this.toolBtns = new Map();
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tw-tool';
      b.dataset.tool = t.id;
      if (t.color != null) b.style.setProperty('--tool', `#${t.color.toString(16).padStart(6, '0')}`);
      b.innerHTML = `${svgIcon(t.icon)}<span>${t.label}</span>`;
      b.title = `${t.label}: ${t.what}`;
      b.addEventListener('click', () => this._setTool(t.id, true));
      tools.append(b);
      this.toolBtns.set(t.id, b);
    }
    this._setTool(this.tool);
    for (const b of this.root.querySelectorAll('[data-brush]')) {
      b.addEventListener('click', () => {
        this.brush = Number(b.dataset.brush);
        this._brushBtns();
      });
    }
    this._brushBtns();
    for (const b of this.root.querySelectorAll('[data-view]')) {
      b.addEventListener('click', () => {
        this.viewTouched = true;
        this._setView(b.dataset.view);
      });
    }
    this._viewBtns();
  }

  _viewBtns() {
    for (const b of this.root.querySelectorAll('[data-view]')) {
      const on = b.dataset.view === this.view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.$('#tw-legend').hidden = this.view !== 'change';
    this.root.dataset.view = this.view;
  }

  /** Pick a tool; a visitor's pick also replays the landscape, so every choice shows its forty years. */
  _setTool(id, user = false) {
    this.tool = id;
    if (user) this._replay();
    for (const [k, b] of this.toolBtns) {
      b.classList.toggle('is-on', k === id);
      b.setAttribute('aria-pressed', String(k === id));
    }
    const t = TOOL[id];
    this.$('#tw-hint').textContent = id === 'erase'
      ? 'Erase: paint over edited cells to return them to no action.'
      : `${t.label}: ${t.what}, in the year below. Drag across the board.`;
    this.$('#tw-when').hidden = id === 'erase';
  }

  _brushBtns() {
    for (const b of this.root.querySelectorAll('[data-brush]')) {
      const on = Number(b.dataset.brush) === this.brush;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  _tip(c, e) {
    const tip = this.$('#tw-tip');
    if (!c || !c.free) { tip.hidden = true; return; }
    const y = Math.round(this.fy);
    const hF = c.free[y * 7], hA = c.act ? c.act[y * 7] : null;
    const ns = c.lat >= 0 ? 'N' : 'S', ew = c.lon >= 0 ? 'E' : 'W';
    const what = c.edit ? `${TOOL[c.edit.tool].label} in ${YEAR0 + c.edit.year}` : 'No action';
    const near = this.geo.nearest(c.lat, c.lon);
    tip.innerHTML = `<b>${Math.abs(c.lat).toFixed(2)}°${ns} ${Math.abs(c.lon).toFixed(2)}°${ew}</b>` +
      (near ? `<i>${near.km < 30 ? 'At' : `${Math.round(near.km / 5) * 5} km from`} ${near.name}, ${near.country}</i>` : '') +
      `<span>${what}${c.split ? ` · a paper ${c.split} cell` : ''}</span>` +
      `<span>Canopy, ${YEAR0 + y}: ${hA != null ? `${hA.toFixed(1)} m <i>vs ${hF.toFixed(1)} m</i>` : `${hF.toFixed(1)} m`}</span>`;
    tip.hidden = false;
    const v = this.$('.tw-view').getBoundingClientRect();
    const x = e.clientX - v.left, yy = e.clientY - v.top;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.min(v.width - tw - 8, x + 16)}px`;
    tip.style.top = `${Math.max(8, yy - th - 12)}px`;
  }

  /** The first look: where on Earth this is, from above; then down onto the board. */
  _intro() {
    this.introDone = true;
    if (this.view !== 'map') return;
    this._introOn = true;
    this._status('Western Amazon, where Brazil, Colombia and Peru meet');
    // down from the region onto the block, a moment to read it, then onto the board
    if (!this.viewTouched) this._fly('map', 2200);
    setTimeout(() => {
      this._introOn = false;
      if (!this.viewTouched) this._setView('forest');
      if (this.nFree < this.nForest) this._status(`Simulating ${this.nForest} forest cells, 1981–2021… ${this.nFree}/${this.nForest}`, true);
      else if (this._liveMsg) this._status(this._liveMsg);
    }, 4200);
  }

  _wire() {
    const cv = this.$('#tw-canvas');
    let stroke = null;
    const commit = () => {
      if (stroke && stroke.changed.size) this._run([...stroke.changed]);
      stroke = null;
    };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.booted && this.nFree === 0) return;
      this._pause();
      stroke = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', live: false, changed: new Set() };
      if (!stroke.touch) {
        // a mouse or pen paints from the first press; a finger waits to see if it is a tap or a scroll
        stroke.live = true;
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* old touch stacks */ }
        const c = this._pick(e);
        if (c) { this._paint(c, stroke.changed); this._draw(); }
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const c = this._pick(e);
      this._showBrush(c && c.forest ? c : null);
      if (stroke && stroke.id === e.pointerId) {
        if (stroke.touch && !stroke.live && Math.abs(e.clientX - stroke.x) > 10) stroke.live = true;
        if (stroke.live && c) this._paint(c, stroke.changed);
        this.$('#tw-tip').hidden = true;
      } else if (!stroke) {
        this._hover = [c, { clientX: e.clientX, clientY: e.clientY }];
        this._tip(c, e);
      }
      this._draw();
    });
    cv.addEventListener('pointerup', (e) => {
      if (!stroke || stroke.id !== e.pointerId) return;
      if (stroke.touch && !stroke.live && Math.hypot(e.clientX - stroke.x, e.clientY - stroke.y) < 10) {
        const c = this._pick(e);
        if (c) this._paint(c, stroke.changed);
      }
      commit();
      this._draw();
    });
    cv.addEventListener('pointercancel', () => { stroke = null; });
    cv.addEventListener('pointerleave', () => {
      this._showBrush(null);
      this.$('#tw-tip').hidden = true;
      this._draw();
    });

    const yin = this.$('#tw-year-in');
    yin.value = String(this.editYear);
    this.$('#tw-out-year').textContent = String(YEAR0 + this.editYear);
    yin.addEventListener('input', () => {
      this.editYear = Number(yin.value);
      this.$('#tw-out-year').textContent = String(YEAR0 + this.editYear);
    });
    this.$('#tw-example').addEventListener('click', () => { this._pause(); this._loadExample(); });
    this.$('#tw-clear').addEventListener('click', () => { this._pause(); this._clear(); });
    this.$('#tw-play').addEventListener('click', () => {
      if (this.playing) this._pause();
      else this._play(this.fy >= YEARS - 1.01 ? 0 : this.fy);
    });
    this.$('#tw-scrub').addEventListener('input', (e) => {
      this._pause();
      this._setYear(Number(e.target.value));
      this._draw();
    });

    new ResizeObserver(() => { this._fit(); this._draw(); }).observe(cv);
    new IntersectionObserver(([en]) => {
      this.visible = en.isIntersecting;
      if (this.visible) this._kick();
    }, { threshold: 0 }).observe(cv);
    // the first play waits until the board is mostly on screen
    new IntersectionObserver(([en]) => {
      this.seen = en.isIntersecting;
      if (this.seen && !this.introDone) this._intro();
      if (this.seen && this.pendingPlay != null) {
        const from = this.pendingPlay;
        this.pendingPlay = null;
        this._play(from);
      }
    }, { threshold: 0.45 }).observe(cv);
  }
}
