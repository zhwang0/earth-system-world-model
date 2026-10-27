/**
 * stage3d.js — the forest on the lab's stage, in 3D.
 *
 * With no action there is one plot: the stand the model grows by itself. Choose an action and the
 * future forks: the plot slides left as "No action", and a second plot with the same trees rises
 * beside it to live through your scenario. Both follow the model year by year (forest3d.js has the
 * rule), and the wall behind each plot carries its canopy height, so the difference stays legible
 * however small it is.
 *
 * Same interface as stand.js, which remains the fallback when WebGL is missing:
 *
 *   const stage = createStage(stageEl);        // null without WebGL
 *   stage.setSite(cell);
 *   stage.setSeries({ free, act, kind, year, span, label });
 *   stage.setYear(23.4);
 *   stage.schedule(from)                       // the playback's segments, slowed through the action
 */

import * as THREE from '../assets/vendor/three.module.js';
import { Forest, makeLayout, planScenario, eventWindow, at, smooth, clamp01 } from './forest3d.js';
import { FX } from './fx3d.js';

const YEAR0 = 1981;
const MS_PER_YEAR = 82;
const GAP = 0.15;                 // between the two plots, in plot widths
const FOV = 24;
const FIRE_SKY = new THREE.Color(0xffb27a);
const _tagV = new THREE.Vector3();

const EVENT_TEXT = {
  thin: 'Thinning',
  log: 'Harvest',
  fire: 'Fire',
  replant: 'Planting',
  protect: 'Protected',
};

export function createStage(el, { onLost } = {}) {
  // ask quietly first: three.js logs an error when it cannot get a context
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) return null;
  try {
    const s = new Stage3D(el);
    s.onLost = onLost || null;
    return s;
  } catch (err) {
    console.warn('3D stage unavailable, drawing the flat one:', err);
    return null;
  }
}

const peak = (s) => (s ? s.reduce((m, v) => Math.max(m, v), 0) : 0);
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);

class Stage3D {
  constructor(el) {
    this.el = el;
    const canvas = this.canvas = el.querySelector('.stage-gl');
    if (!canvas) throw new Error('no .stage-gl canvas');
    const small = matchMedia('(max-width: 560px)').matches;
    this.light = small || (navigator.hardwareConcurrency || 8) <= 4;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const r = this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
    });
    r.setPixelRatio(Math.min(this.light ? 1.5 : 2, window.devicePixelRatio || 1));
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.12;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;

    const scene = this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(FOV, 2, 0.5, 2000);

    this.sky = new THREE.Color(0xd8e9ff);
    this.hemi = new THREE.HemisphereLight(0xd8e9ff, 0x2b2419, 1.35);
    scene.add(this.hemi);
    const sun = this.sun = new THREE.DirectionalLight(0xfff0d6, 2.9);
    sun.castShadow = true;
    const sm = this.light ? 1024 : 2048;
    sun.shadow.mapSize.set(sm, sm);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.05;
    scene.add(sun, sun.target);
    this.fireLight = new THREE.PointLight(0xff7a2e, 0, 0, 1.4);
    scene.add(this.fireLight);

    // the plots stand on nothing; a shadow catcher grounds them
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.32 }));
    this.floor.receiveShadow = true;
    scene.add(this.floor);

    this.forest = new Forest(scene, { light: this.light });
    this.fx = new FX(scene, { light: this.light });

    this.cell = null;
    this.L = null;
    this.series = { free: null, act: null, kind: 'none', year: NaN, span: null, label: '' };
    this.planA = null;
    this.planB = null;
    this.t = 40;
    this.fork = 0;
    this.forkTo = 0;
    this.time = 0;
    this.view = { az: -0.12, el: 0.4, dist: 120, tx: 0, ty: 12 };
    this.goal = { ...this.view };
    this.drag = { az: 0, el: 0, idle: 0, on: false };
    this.visible = false;
    this.dirty = true;

    this._overlay();
    this._wire();
    this._resize();
  }

  /* ------------------------------------------------------------ the interface */

  setSite(cell) {
    this.cell = cell;
  }

  setSeries({ free, act = null, kind = 'none', year = NaN, span = null, label = '' }) {
    if (!free) return;
    this.series = { free, act, kind, year, span, label };
    const Hc = Math.max(6, peak(free));
    const cellChanged = !this.L || this.L.cell !== this.cell;
    if (cellChanged || Math.abs(Hc - this.L.Hc) / this.L.Hc > 0.02) {
      this.L = makeLayout(this.cell, Hc, { light: this.light });
      this._hTop = 0;
      this.fx.clear();
    }
    const L = this.L;
    const rMax = L.trees.reduce((m, t) => Math.max(m, t.r), 0);
    const hTop = Math.max(Hc, peak(act)) * rMax * 1.04;
    // one scale per result; the wall is rebuilt only when the canopy outgrows it
    if (!this._hTop || hTop > this._hTop * 1.02 || hTop < this._hTop * 0.9) {
      this._hTop = hTop;
      this.forest.setLayout(L, hTop);
    }
    this.fx.scale = Math.max(0.5, L.Hc / 30);
    this.planA = planScenario(L, { free });
    this.planB = act ? planScenario(L, { free, act, kind, Y: year, span }) : null;
    // a different action, or the same one moved: its smoke and dust go with it
    const key = `${kind}:${year}`;
    if (key !== this._planKey) { this._planKey = key; this.fx.clear(); }
    if (act) this.planBShown = this.planB;
    this.forkTo = act ? 1 : 0;
    if (this.reduced) this.fork = this.forkTo;
    this._fit();
    this._sunFit();
    this.dirty = true;
    this._kick();
  }

  setYear(y) {
    if (y === this.t) return;
    this.t = y;
    this.dirty = true;
    this._kick();
  }

  valuesAt(y) {
    const { free, act } = this.series;
    return { free: at(free, y), act: act ? at(act, y) : NaN };
  }

  /** Playback segments from year `from` to 2021: steady, but slow through the action itself. */
  schedule(from = 0) {
    const { kind, year, act } = this.series;
    const ev = act ? eventWindow(kind, year) : null;
    const segs = [];
    let t = Math.max(0, Math.min(40, from));
    const base = act ? MS_PER_YEAR : MS_PER_YEAR * 0.8;     // nothing happens without an action: keep it brisk
    if (ev && ev.t1 > t) {
      if (ev.t0 > t) { segs.push({ t0: t, t1: ev.t0, ms: (ev.t0 - t) * base }); t = ev.t0; }
      segs.push({ t0: t, t1: ev.t1, ms: ev.ms * ((ev.t1 - t) / (ev.t1 - ev.t0)) });
      t = ev.t1;
    }
    if (t < 40) segs.push({ t0: t, t1: 40, ms: (40 - t) * base });
    return segs;
  }

  /* ------------------------------------------------------------ overlay */

  _overlay() {
    const mk = (cls, html) => {
      const d = document.createElement('div');
      d.className = cls;
      d.innerHTML = html;
      this.el.appendChild(d);
      return d;
    };
    this.tagA = mk('ptag ptag-a', '<span class="ptag-l"><i class="sw sw-free"></i><span class="ptag-n">No action</span></span><b class="ptag-v"></b>');
    this.tagB = mk('ptag ptag-b', '<span class="ptag-l"><i class="sw sw-act"></i><span class="ptag-n"></span></span><b class="ptag-v"></b>');
    // the gap between the two canopy levels, measured at the scenario plot's corner
    this.dim = mk('pdim', '<span class="pdim-t"></span>');
    this.toast = mk('stage-toast', '<b></b><span></span>');
    this.el.classList.add('has-gl');
  }

  _tagsAt(oA, oB, Hf, Ha) {
    const L = this.L;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    // write to the DOM only what changed: this runs every frame
    const put = (node, key, val, html = false) => {
      if (node[key] === val) return;
      node[key] = val;
      if (html) node.innerHTML = val; else node.textContent = val;
    };
    const place = (tag, o) => {
      const v = _tagV.set(o.x, o.y - this.forest.plots[0].depth, L.D / 2).project(this.cam);
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      const tr = `translate(${x.toFixed(1)}px, ${(y + 8).toFixed(1)}px) translateX(-50%)`;
      if (tag._tr !== tr) { tag._tr = tr; tag.style.transform = tr; }
    };
    this._tagEls ||= {
      va: this.tagA.querySelector('.ptag-v'), n: this.tagB.querySelector('.ptag-n'),
      vb: this.tagB.querySelector('.ptag-v'), d: this.dim.querySelector('.pdim-t'),
    };
    const T = this._tagEls;
    place(this.tagA, oA);
    put(T.va, '_v', `${Hf.toFixed(1)} m`);
    const b = this.fork > 0.02 && this.planBShown;
    const op = b ? smooth(0.5, 1, this.fork).toFixed(3) : '0';
    if (this.tagB._op !== op) { this.tagB._op = op; this.tagB.style.opacity = op; }
    const d = Ha - Hf;
    const flat = Math.abs(d) < 0.05;
    const dop = b && !flat ? op : '0';
    // the stage's key names only the marks on show: ghosts for a loss, lit crowns for a gain
    const diff = b && this.fork > 0.5 ? (flat ? 'same' : d < 0 ? 'loss' : 'gain') : '';
    if (this._diff !== diff) {
      this._diff = diff;
      if (diff) this.el.dataset.diff = diff; else delete this.el.dataset.diff;
    }
    if (this.dim._op !== dop) { this.dim._op = dop; this.dim.style.opacity = dop; }
    if (b) {
      place(this.tagB, oB);
      put(T.n, '_v', this.series.label || 'Your scenario');
      put(T.vb, '_v', `${Ha.toFixed(1)} m`);
    }
    if (b && !flat) {
      // a dimension line from one rail to the other, just outside the plot's front-right corner
      const v1 = _tagV.set(oB.x + L.W / 2, oB.y + Hf, oB.z + L.D / 2).project(this.cam);
      const x1 = (v1.x * 0.5 + 0.5) * w, y1 = (-v1.y * 0.5 + 0.5) * h;
      const v2 = _tagV.set(oB.x + L.W / 2, oB.y + Ha, oB.z + L.D / 2).project(this.cam);
      const y2 = (-v2.y * 0.5 + 0.5) * h;
      const top = Math.min(y1, y2), len = Math.max(2, Math.abs(y2 - y1));
      const left = Math.min(x1 + 10, w - 8);
      const tr = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
      const ht = `${len.toFixed(1)}px`;
      if (this.dim._tr !== tr) { this.dim._tr = tr; this.dim.style.transform = tr; }
      if (this.dim._h !== ht) { this.dim._h = ht; this.dim.style.height = ht; }
      const pct = Hf > 0 ? (d / Hf) * 100 : 0;
      const sg = d > 0 ? '+' : '−';
      put(T.d, '_v', `<b>${sg}${Math.abs(d).toFixed(1)} m</b><span>${sg}${Math.abs(pct).toFixed(0)}%</span>`, true);
      const sign = d > 0 ? 'pos' : 'neg';
      if (this.dim.dataset.sign !== sign) this.dim.dataset.sign = sign;
      const flip = left > w - (w < 600 ? 62 : 120);
      if (this.dim._flip !== flip) { this.dim._flip = flip; this.dim.classList.toggle('is-flip', flip); }
    }

    // the action's moment, named while it happens
    const { kind, year, act } = this.series;
    const ev = act ? eventWindow(kind, year) : null;
    const on = ev && this.t >= ev.t0 - 0.05 && this.t <= ev.t1 + (kind === 'replant' ? 0.6 : 0.25) && this.t < 40;
    if (on) put(this.toast, '_v', `<b>${YEAR0 + year}</b><span>${EVENT_TEXT[kind] || ''}</span>`, true);
    if (this.toast._on !== !!on) { this.toast._on = !!on; this.toast.classList.toggle('is-on', !!on); }
  }

  /* ------------------------------------------------------------ camera */

  _origins() {
    const L = this.L;
    const off = L.W / 2 + (L.W * GAP) / 2;
    const f = easeOut(this.fork);
    const rise = (this.forest.plots[1].depth + this._hTop) * 1.25;
    return {
      oA: { x: -off * f, y: 0, z: 0 },
      oB: { x: off, y: -rise * (1 - f), z: 0 },
      off,
    };
  }

  /** Fit both plots (or the one) and their tallest tree between the readouts. */
  _fit() {
    const L = this.L;
    if (!L) return;
    const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 360;
    const off = L.W / 2 + (L.W * GAP) / 2;
    const two = this.forkTo > 0;
    const x0 = (two ? -off : 0) - L.W / 2, x1 = (two ? off : 0) + L.W / 2;
    const depth = this.forest.plots[0].depth || 3;
    const y0 = -depth, y1 = this._hTop;
    const z0 = -L.D / 2 - 1, z1 = L.D / 2;
    const narrow = w < 600;
    const top = 1 - 2 * ((narrow ? 58 : 84) / h);
    const bot = -1 + 2 * ((narrow ? 40 : 46) / h);
    const side = narrow ? 0.98 : 0.95;
    // with two plots, keep room on the right for the measured gap beside the scenario plot
    const lo = -side, hi = side - (two ? (2 * (narrow ? 70 : 120)) / w : 0);
    const cam = this.cam;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    const g = this.goal;
    g.az = narrow ? -0.08 : -0.12;
    g.el = narrow ? 0.44 : 0.5;
    g.tx = (x0 + x1) / 2;
    g.ty = (y0 + y1) / 2;
    g.dist = g.dist || 120;
    const v = new THREE.Vector3();
    const tanH = Math.tan((FOV * Math.PI) / 360);
    for (let it = 0; it < 8; it++) {
      this._place(cam, g, 0, 0);
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const X of [x0, x1]) for (const Y of [y0, y1]) for (const Z of [z0, z1]) {
        v.set(X, Y, Z).project(cam);
        a = Math.min(a, v.x); b = Math.max(b, v.x); c = Math.min(c, v.y); d = Math.max(d, v.y);
      }
      const s = Math.max((b - a) / (hi - lo), (d - c) / (top - bot));
      g.dist *= s;
      g.ty += (((c + d) / 2) - (top + bot) / 2) * g.dist * tanH;
      g.tx += (((a + b) / 2) - (lo + hi) / 2) * g.dist * tanH * cam.aspect;
    }
    if (!this._fitted || this.reduced) { Object.assign(this.view, g); this._fitted = true; }
  }

  _place(cam, v, daz, del) {
    const el = v.el + del, az = v.az + daz;
    cam.position.set(v.tx + v.dist * Math.cos(el) * Math.sin(az), v.ty + v.dist * Math.sin(el), v.dist * Math.cos(el) * Math.cos(az));
    cam.lookAt(v.tx, v.ty, 0);
    cam.updateMatrixWorld();
  }

  _sunFit() {
    const L = this.L;
    const span = L.W * 1.3 + this._hTop;
    const s = this.sun;
    s.position.set(-0.55 * span, 1.15 * span, 0.85 * span);
    s.target.position.set(0, 0, 0);
    const c = s.shadow.camera;
    const e = L.W * 1.25 + this._hTop * 0.5;
    Object.assign(c, { left: -e, right: e, top: e, bottom: -e, near: 1, far: span * 4 });
    c.updateProjectionMatrix();
    this.floor.scale.set(L.W * 6, 1, L.D * 6);
  }

  /* ------------------------------------------------------------ the loop */

  _wire() {
    const c = this.canvas;
    new ResizeObserver(() => this._resize()).observe(this.el);
    new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible) this._kick();
    }, { threshold: 0 }).observe(this.el);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this._kick(); });
    // a lost GPU context hands the stage back to the flat drawing
    c.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.el.classList.remove('has-gl');
      for (const n of [this.tagA, this.tagB, this.dim, this.toast]) n.remove();
      if (this.onLost) this.onLost();
    });

    // turn the plots a little: a drag rotates, letting go eases back
    let px = 0, py = 0;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.drag.on = true;
      px = e.clientX; py = e.clientY;
      c.setPointerCapture(e.pointerId);
      this.el.classList.add('is-turning');
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag.on) return;
      const d = this.drag;
      d.az = Math.max(-0.55, Math.min(0.55, d.az - (e.clientX - px) * 0.0045));
      d.el = Math.max(-0.12, Math.min(0.32, d.el + (e.clientY - py) * 0.003));
      px = e.clientX; py = e.clientY;
      d.idle = 0;
      this._kick();
    });
    const up = () => { this.drag.on = false; this.el.classList.remove('is-turning'); };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.fx.setView(h * this.renderer.getPixelRatio(), FOV);
    this._fit();
    if (this.L) Object.assign(this.view, this.goal);
    this.dirty = true;
    this._kick();
  }

  _kick() {
    if (this.raf || !this.visible || document.hidden || this.lost) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((n) => this._frame(n));
  }

  _frame(now) {
    this.raf = 0;
    if (!this.visible || document.hidden || this.lost || !this.L || !this.planA) return;
    // a forest only stirring in the wind is drawn at half rate; anything that moves gets every frame
    if (!this._active && !this.dirty && now - this.last < 30) {
      this.raf = requestAnimationFrame((n) => this._frame(n));
      return;
    }
    const real = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    // particles step at most 50 ms at a time; the camera and the fork keep wall-clock pace
    const moving = this._step(Math.min(0.05, real), Math.min(0.3, real));
    this._active = moving;
    this.renderer.render(this.scene, this.cam);
    this.dirty = false;
    // keep going while anything moves; under reduced motion, only while something changes
    if (!this.reduced || moving) this.raf = requestAnimationFrame((n) => this._frame(n));
  }

  _step(dt, ease = dt) {
    const L = this.L;
    let moving = false;
    if (!this.reduced) {
      this.time += dt;
      this.forest.U.uTime.value = this.time;
    } else {
      this.forest.U.uWind.value = 0;
    }

    // the fork, the camera, the visitor's turn
    const k = 1 - Math.exp(-ease * 4.2);
    if (this.fork !== this.forkTo) {
      const step = this.reduced ? 1 : ease / 0.95;
      this.fork = this.forkTo > this.fork ? Math.min(this.forkTo, this.fork + step) : Math.max(this.forkTo, this.fork - step);
      moving = true;
    }
    const v = this.view, g = this.goal;
    for (const key of ['az', 'el', 'dist', 'tx', 'ty']) {
      const d = g[key] - v[key];
      if (Math.abs(d) > 1e-4 * (key === 'dist' ? v.dist : 1)) { v[key] += this.reduced ? d : d * k; moving = true; }
    }
    const drag = this.drag;
    if (!drag.on && (drag.az || drag.el)) {
      drag.idle += ease;
      if (drag.idle > 2.5) {
        drag.az *= Math.exp(-ease * 2);
        drag.el *= Math.exp(-ease * 2);
        if (Math.abs(drag.az) < 1e-3 && Math.abs(drag.el) < 1e-3) { drag.az = 0; drag.el = 0; }
      }
      moving = true;
    }
    // a slow drift, so a still forest still looks alive
    const drift = this.reduced ? 0 : Math.sin(this.time * 0.11) * 0.035;
    this._place(this.cam, v, drag.az + drift, drag.el);

    // the plots
    const { oA, oB } = this._origins();
    const pA = this.forest.plots[0], pB = this.forest.plots[1];
    pA.group.position.set(oA.x, oA.y, oA.z);
    pB.group.position.set(oB.x, oB.y, oB.z);
    const showB = this.fork > 0.002 && !!this.planBShown;
    pB.group.visible = showB;
    const planB = this.planB || this.planBShown;
    const t = this.t;
    this.forest.begin();
    const a = this.forest.pose(0, oA, this.planA, t, null, dt, {});
    let b = null;
    if (showB) b = this.forest.pose(1, oB, planB, t, this.fx, dt, { live: true });
    this.forest.end();

    // the canopy levels on the walls, about two pixels thick
    const thick = (2 * 2 * v.dist * Math.tan((FOV * Math.PI) / 360)) / Math.max(200, this.canvas.clientHeight) * 1.1;
    pA.levels(a.Hf, a.Hf, false, thick);
    if (b) pB.levels(b.Hf, b.Ha, true, thick);

    // firelight and smoke-dimmed sun
    const fw = b ? b.fire.w : 0;
    const fire = clamp01(fw / 3);
    if (fw > 0.01) {
      const fl = this.fireLight;
      fl.position.set(b.fire.x, b.fire.y + L.Hc * 0.15, b.fire.z + L.D * 0.25);
      const flick = 0.82 + 0.18 * Math.sin(this.time * 23) * Math.sin(this.time * 7.3 + 1);
      fl.intensity = 320 * fire * flick * (L.Hc / 30) ** 1.4;
      moving = true;
    } else this.fireLight.intensity = 0;
    this._fire = (this._fire || 0) + (fire - (this._fire || 0)) * Math.min(1, dt * 3);
    this.sun.intensity = 2.9 * (1 - 0.3 * this._fire);
    this.hemi.color.copy(this.sky).lerp(FIRE_SKY, this._fire * 0.45);
    this.floor.position.set(0, -pA.depth - 0.05, 0);

    this.fx.update(dt);
    if (this.fx.busy) moving = true;
    this._tagsAt(oA, oB, a.Hf, b ? b.Ha : a.Hf);
    return moving || this.dirty;
  }
}
