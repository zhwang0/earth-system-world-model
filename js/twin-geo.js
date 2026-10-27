/**
 * twin-geo.js — where the landscape is.
 *
 * The board is a real 8° x 8° block of the western Amazon, so it should look like one: its tiles
 * carry the NASA Blue Marble image of their own 0.5° cell, the country around the block lies under
 * the board as a darker map that fades into the page, and the rivers, towns and borders are named
 * on top. Labels are HTML, projected from the board each time the camera moves.
 *
 *   const geo = new Geo({ base, meta, scene, layer });
 *   await geo.load();                    // the JSON and both images
 *   geo.slabShader(material);            // tiles show their own patch of the image
 *   geo.place(camera, w, h, view);       // after any camera move
 *   geo.nearest(lat, lon)                // { name, km } of the closest town
 */

import * as THREE from '../assets/vendor/three.module.js';

const D2R = Math.PI / 180;
const R_EARTH_KM = 6371.0088;

// the towns around the block worth naming: the region's two Amazon cities and Colombia's capital
const AROUND = new Set(['Iquitos', 'Manaus', 'Bogota']);

// the rivers still named on a phone
const MAJOR = new Set(['Solimões (Amazon)', 'Japurá', 'Rio Negro', 'Içá · Putumayo']);

// where a river's name sits
const RIVER_AT = {
  Amazonas: [[-67.4, -3.0, 'Solimões (Amazon)'], [-71.6, -4.1, 'Amazon']],
  Japurá: [[-66.4, -2.1, 'Japurá']],
  Caquetá: [[-71.2, -0.9, 'Caquetá']],
  Putumayo: [[-69.6, -2.9, 'Içá · Putumayo']],
  Negro: [[-65.5, -0.65, 'Rio Negro']],
  Uaupés: [[-69.1, 0.55, 'Vaupés']],
  Juruá: [[-67.6, -5.2, 'Juruá']],
  Jutaí: [[-68.6, -4.4, 'Jutaí']],
  Javari: [[-72.2, -5.0, 'Javari']],
  Napo: [[-74.6, -1.9, 'Napo']],
  Purús: [[-64.6, -6.7, 'Purus']],
  Guainía: [[-67.6, 2.0, 'Guainía']],
};

export class Geo {
  constructor({ base, meta, scene, layer }) {
    Object.assign(this, { base, meta, scene, layer });
    this.labels = [];
    this.ready = false;
    this.uSat = { value: null };
    this.uHasSat = { value: 0 };
    this.uGain = { value: 1.35 };
  }

  /** Board coordinates of a place: one unit per cell, the board centred on the origin. */
  xz(lon, lat) {
    const m = this.meta;
    return [(lon - m.lon0) / m.res_deg - (m.cols - 1) / 2, (m.lat0 - lat) / m.res_deg - (m.rows - 1) / 2];
  }

  async load() {
    const url = (f) => `${this.base}/assets/twin/${f}`;
    const g = this.g = await (await fetch(url(`${this.meta.name}-geo.json`))).json();
    const loader = new THREE.TextureLoader();
    const tex = async (f) => {
      const t = await loader.loadAsync(url(f));
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    };
    const [sat, ctx] = await Promise.all([tex(g.block.img), tex(g.context.img)]);
    this.uSat.value = sat;
    this.uHasSat.value = 1;
    this._context(ctx);
    this._labels();
    this.ready = true;
  }

  /**
   * Tiles show their own patch of the image on top; an edit or a clearing tints it toward the
   * instance colour by `aMix` (0 = the photograph, 1 = the tint). Sides keep the instance colour.
   */
  slabShader(mat, mixAttr) {
    const [x0, z0] = this.xz(this.meta.lon0 - this.meta.res_deg / 2, this.meta.lat0 + this.meta.res_deg / 2);
    const span = this.meta.cols;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uSat = this.uSat;
      sh.uniforms.uHasSat = this.uHasSat;
      sh.uniforms.uGain = this.uGain;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aMix;
varying vec2 vSatUv;
varying float vTop;
varying float vMix;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec4 wp = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
#endif
  vSatUv = vec2((wp.x - (${x0.toFixed(3)})) / ${span.toFixed(1)}, 1.0 - (wp.z - (${z0.toFixed(3)})) / ${span.toFixed(1)});
  vTop = step(0.5, normal.y);
  vMix = aMix;
}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D uSat;
uniform float uHasSat;
uniform float uGain;
varying vec2 vSatUv;
varying float vTop;
varying float vMix;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
if (vTop > 0.5 && uHasSat > 0.5) {
  vec3 sat = texture2D(uSat, vSatUv).rgb * uGain;
  diffuseColor.rgb = mix(sat, diffuseColor.rgb, vMix);
}`);
    };
    mat.customProgramCacheKey = () => 'twin-slab-sat';
    mat.needsUpdate = true;
  }

  /** The country around the block: the same image, wider and darker, fading into the page. */
  _context(tex) {
    const c = this.g.context;
    const [x0, z0] = this.xz(c.lon0, c.lat0);
    const [x1, z1] = this.xz(c.lon1, c.lat1);
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2);
    const [bx0, bz0] = this.xz(this.g.block.lon0, this.g.block.lat0);
    const [bx1, bz1] = this.xz(this.g.block.lon1, this.g.block.lat1);
    this.uCtx = { uBright: { value: 0.62 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex },
        uBright: this.uCtx.uBright,
        uBox: { value: new THREE.Vector4((bx0 - x0) / (x1 - x0), (bz0 - z0) / (z1 - z0), (bx1 - x0) / (x1 - x0), (bz1 - z0) / (z1 - z0)) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uBright;
        uniform vec4 uBox;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(uMap, vUv).rgb;
          // fade to the page's black away from the block
          vec2 q = vec2(vUv.x, 1.0 - vUv.y);
          vec2 m = (uBox.xy + uBox.zw) * 0.5;
          vec2 d = (q - m) * vec2(1.0, 1.15);
          float v = 1.0 - smoothstep(0.16, 0.5, length(d));
          gl_FragColor = vec4(c * uBright * v, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const mesh = this.ctxMesh = new THREE.Mesh(geo, mat);
    mesh.position.set((x0 + x1) / 2, -0.78, (z0 + z1) / 2);
    mesh.renderOrder = -1;
    this.scene.add(mesh);
  }

  _labels() {
    const g = this.g;
    const mk = (cls, html, lon, lat, y, show) => {
      const el = document.createElement('div');
      el.className = `twl ${cls}`;
      el.innerHTML = html;
      this.layer.appendChild(el);
      const [x, z] = this.xz(lon, lat);
      const inside = Math.abs(x) <= this.meta.cols / 2 && Math.abs(z) <= this.meta.rows / 2;
      this.labels.push({ el, p: new THREE.Vector3(x, inside ? y : -0.76, z), show, inside, lon, lat });
    };
    for (const c of g.countries) mk('twl-country', c.name, c.lon, c.lat, 0, ['map', 'forest', 'change']);
    for (const r of g.rivers) {
      for (const [lon, lat, name] of RIVER_AT[r.name] || []) {
        // on the river itself, lying along its nearest stretch
        const { at, dir } = this._riverAt(r, lon, lat);
        mk(`twl-river${MAJOR.has(name) ? '' : ' is-minor'}`, name, at[0], at[1], 0.02, ['map']);
        this.labels[this.labels.length - 1].dir = dir;
      }
    }
    for (const t of g.places) {
      const [x, z] = this.xz(t.lon, t.lat);
      const inside = Math.abs(x) <= this.meta.cols / 2 && Math.abs(z) <= this.meta.rows / 2;
      const big = t.rank <= 3 || (t.pop || 0) > 40000;
      // inside the block every town is named; around it only a few to orient by
      if (!inside && !AROUND.has(t.name)) continue;
      mk(`twl-town${big ? ' is-big' : ''}`, t.name === 'Bogota' ? 'Bogotá' : t.name, t.lon, t.lat, 1.05, inside ? ['map', 'forest', 'change'] : ['map']);
    }
    const b = g.block;
    mk('twl-block', `${this.meta.rows} × ${this.meta.cols} cells · 0.5° each`, b.lon0, b.lat0 + 0.35, 0, ['map']);
    this.labels[this.labels.length - 1].p.set(-this.meta.cols / 2, 0.02, -this.meta.rows / 2 - 0.7);
  }

  /** The point of river r nearest (lon, lat), and the river's direction there in board space. */
  _riverAt(r, lon, lat) {
    let best = Infinity, at = [lon, lat], dir = [1, 0];
    for (const line of r.lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = line[i], [bx, by] = line[i + 1];
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const d = Math.hypot(mx - lon, my - lat);
        if (d < best) { best = d; at = [mx, my]; dir = [bx - ax, -(by - ay)]; }
      }
    }
    const n = Math.hypot(dir[0], dir[1]) || 1;
    return { at, dir: [dir[0] / n, dir[1] / n] };
  }

  /** Project the labels for this camera; `view` picks which are shown. */
  place(cam, w, h, view, lift = 1) {
    const v = new THREE.Vector3(), v2 = new THREE.Vector3();
    for (const L of this.labels) {
      const on = L.show.includes(view);
      if (L.el._on !== on) { L.el._on = on; L.el.classList.toggle('is-on', on); }
      if (!on && !L.el._placed) continue;
      // towns on the board float over its trees, and sink to the ground when the trees go
      const y = L.inside && L.el.classList.contains('twl-town') ? 0.02 + 1.03 * lift : L.p.y;
      v.set(L.p.x, y, L.p.z).project(cam);
      if (v.z > 1) continue;
      const x = (v.x * 0.5 + 0.5) * w, yy = (-v.y * 0.5 + 0.5) * h;
      let rot = 0;
      if (L.dir) {
        v2.set(L.p.x + L.dir[0], y, L.p.z + L.dir[1]).project(cam);
        const dx = (v2.x - v.x) * w, dy = -(v2.y - v.y) * h;
        rot = Math.atan2(dy, dx);
        if (rot > Math.PI / 2) rot -= Math.PI;
        if (rot < -Math.PI / 2) rot += Math.PI;
      }
      const tr = L.dir
        ? `translate(${x.toFixed(1)}px, ${yy.toFixed(1)}px) translate(-50%, -50%) rotate(${rot.toFixed(3)}rad)`
        : L.el.classList.contains('twl-town') || L.el.classList.contains('twl-block')
          ? `translate(${x.toFixed(1)}px, ${yy.toFixed(1)}px) translate(-3px, -50%)`
          : `translate(${x.toFixed(1)}px, ${yy.toFixed(1)}px) translate(-50%, -50%)`;
      if (L.el._tr !== tr) { L.el._tr = tr; L.el.style.transform = tr; }
      L.el._placed = true;
    }
  }

  /** The closest named town to a point, and how far, in km. */
  nearest(lat, lon) {
    if (!this.g) return null;
    let best = null;
    for (const t of this.g.places) {
      const p1 = lat * D2R, p2 = t.lat * D2R, dl = (t.lon - lon) * D2R;
      const km = R_EARTH_KM * Math.acos(Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl)));
      if (!best || km < best.km) best = { name: t.name, country: t.country, km };
    }
    return best;
  }
}
