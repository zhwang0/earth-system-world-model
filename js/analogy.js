/**
 * analogy.js — the case for a world model, as the film opens it: a two-by-two of video and the
 * Earth system (rows), each watched or interacted with (columns).
 *
 * The video row is drawn live, a walk down a path through a wood at dusk. On the left it plays on
 * its own, like a generated video. On the right it is the same walk, and ← and → (or a click on the
 * keys) turn the view, like an interactive world model. The Earth row is the film's own stills:
 * Earth emulators (a planet's weather, DeepED's forest), then this work in the cell the question
 * left open. The cells come in once, in the film's order, the first time the grid is on screen.
 *
 *   new Analogy(document.querySelector('#ana'))
 */

const NS = 'http://www.w3.org/2000/svg';
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const svgEl = (n, a, p) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };

/** A seeded random stream, so both walks see the same world. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), a | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const mixHex = (a, b, u) => {
  const p = (h, i) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `rgb(${[0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * u)).join(',')})`;
};

/**
 * A path through a wood at dusk, seen at eye height. draw(z, yaw) puts the walker z metres down the
 * path, its view turned by yaw radians (left positive). The wood repeats every LZ metres, so the
 * walk never ends.
 */
const LZ = 180;
class Walk {
  constructor(svg) {
    this.W = 720; this.hz = 214; this.f = 470; this.eye = 1.7;
    this.sunAt = 0.42;                                       // the low sun's bearing, left of the path
    const R = seeded(11);
    this.trees = [];
    while (this.trees.length < 300) {
      const x = (R() - 0.5) * 200, z = R() * LZ;
      if (Math.abs(x) < 4.2) continue;                       // the path and its verges stay clear
      this.trees.push({ x, z, h: 6 + R() * 7, r: 1.6 + R() * 1.6, c: Math.floor(R() * 4) });
    }
    this.tufts = Array.from({ length: 140 }, () => ({ x: (R() - 0.5) * 60, z: R() * 120 }));
    const id = svg.id;
    svg.innerHTML = `<defs>
      <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1520"/><stop offset=".72" stop-color="#2c3b45"/><stop offset="1" stop-color="#55544a"/></linearGradient>
      <radialGradient id="${id}-sun"><stop offset="0" stop-color="#ffd9a0" stop-opacity=".95"/><stop offset=".18" stop-color="#f5b26b" stop-opacity=".55"/><stop offset="1" stop-color="#f2994a" stop-opacity="0"/></radialGradient>
      <linearGradient id="${id}-gnd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26332a"/><stop offset="1" stop-color="#0c140f"/></linearGradient>
      <linearGradient id="${id}-path" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a4636"/><stop offset="1" stop-color="#6b5c45"/></linearGradient></defs>`;
    svgEl('rect', { x: 0, y: 0, width: 720, height: this.hz + 1, fill: `url(#${id}-sky)` }, svg);
    this.sun = svgEl('circle', { r: 120, fill: `url(#${id}-sun)` }, svg);
    this.hillFar = svgEl('path', { fill: '#2a3637' }, svg);
    this.hillNear = svgEl('path', { fill: '#1c2a24' }, svg);
    svgEl('rect', { x: 0, y: this.hz, width: 720, height: 405 - this.hz, fill: `url(#${id}-gnd)` }, svg);
    this.path = svgEl('path', { fill: `url(#${id}-path)` }, svg);
    this.tuftEls = this.tufts.map(() => svgEl('path', { stroke: '#3c5640', 'stroke-linecap': 'round', fill: 'none' }, svg));
    this.treeEls = Array.from({ length: 110 }, () => {
      const g = svgEl('g', {}, svg);
      return { g, trunk: svgEl('line', { 'stroke-linecap': 'round' }, g), crown: svgEl('ellipse', {}, g), lit: svgEl('ellipse', {}, g) };
    });
  }

  draw(cz, h) {
    const W = this.W, f = this.f, hz = this.hz, eye = this.eye;
    const sh = Math.sin(h), ch = Math.cos(h);
    const cam = (px, pz) => { const dz = pz - cz; return [px * ch + dz * sh, -px * sh + dz * ch]; };   // [right, ahead]
    const at = (bearing) => W / 2 + f * Math.tan(h - bearing);                                     // a far thing's x
    // what stands at the horizon turns with the view but never comes closer
    this.sun.setAttribute('cx', at(this.sunAt).toFixed(1));
    this.sun.setAttribute('cy', String(hz - 26));
    const hills = (amp, ph, k) => {
      let d = `M0 ${hz + 1}`;
      for (let sx = 0; sx <= W; sx += 12) {
        const a = h - Math.atan((sx - W / 2) / f);
        d += `L${sx} ${(hz - amp * (0.55 + 0.45 * Math.sin(k * a + ph) * Math.cos(2.3 * k * a + ph * 1.7))).toFixed(1)}`;
      }
      return `${d}L${W} ${hz + 1}Z`;
    };
    this.hillFar.setAttribute('d', hills(34, 0.7, 3));
    this.hillNear.setAttribute('d', hills(20, 2.1, 5));
    // the path: its two edges, from just ahead of the walker to the horizon
    const edge = (x) => {
      const pts = [];
      for (let z = cz + 0.5; z < cz + 160; z += z - cz < 10 ? 0.5 : 4) {
        const [rx, rz] = cam(x, z);
        if (rz > 0.4) pts.push(`${(W / 2 + (f * rx) / rz).toFixed(1)} ${(hz + (f * eye) / rz).toFixed(1)}`);
      }
      return pts;
    };
    const L = edge(-1.3), Rt = edge(1.3).reverse();
    this.path.setAttribute('d', L.length && Rt.length ? `M${[...L, ...Rt].join('L')}Z` : '');
    // grass at the verges streams past
    this.tufts.forEach((p, i) => {
      const el = this.tuftEls[i];
      const z = cz + ((((p.z - cz) % 120) + 120) % 120) - 10;
      const [rx, rz] = cam(p.x, z);
      if (rz < 0.8 || rz > 70 || Math.abs(p.x) < 1.4) { el.setAttribute('d', ''); return; }
      const x = W / 2 + (f * rx) / rz, y = hz + (f * eye) / rz, k = Math.min(14, 26 / rz);
      el.setAttribute('d', `M${(x - k * 0.4).toFixed(1)} ${y.toFixed(1)}l${(k * 0.2).toFixed(1)} ${(-k).toFixed(1)}M${x.toFixed(1)} ${y.toFixed(1)}l0 ${(-k * 1.2).toFixed(1)}M${(x + k * 0.4).toFixed(1)} ${y.toFixed(1)}l${(-k * 0.2).toFixed(1)} ${(-k).toFixed(1)}`);
      el.setAttribute('stroke-width', Math.max(0.6, 3 / rz).toFixed(2));
      el.setAttribute('opacity', (0.9 * (1 - rz / 70)).toFixed(2));
    });
    // the trees, far to near; the wood comes round again every LZ metres
    const seen = [];
    for (const tr of this.trees) {
      const z = cz - 20 + ((((tr.z - cz + 20) % LZ) + LZ) % LZ);
      const [rx, rz] = cam(tr.x, z);
      if (rz < 2.2 || rz > 110) continue;
      const sx = W / 2 + (f * rx) / rz, rr = (f * tr.r) / rz;
      if (sx < -rr || sx > W + rr) continue;
      seen.push({ tr, rz, sx, rr });
    }
    seen.sort((a, b) => b.rz - a.rz);
    const crowns = [['#24563a', '#3f7d4c'], ['#2d6440', '#4f8f55'], ['#1f4d33', '#386f45'], ['#2a5a3a', '#4a8350']];
    const skip = Math.max(0, seen.length - this.treeEls.length);
    const sunX = at(this.sunAt);
    this.treeEls.forEach((el, i) => {
      const o = seen[i + skip];
      if (!o) { el.g.setAttribute('opacity', 0); return; }
      const fog = clamp01((o.rz - 10) / 95);
      // the far trees fade in out of the dusk, so the wood never pops as it comes round
      const fade = clamp01((110 - o.rz) / 14);
      const base = hz + (f * eye) / o.rz, top = hz + (f * (eye - o.tr.h)) / o.rz, cy = top + o.rr * 0.7;
      const [dark, light] = crowns[o.tr.c];
      el.g.setAttribute('opacity', fade.toFixed(2));
      el.trunk.setAttribute('x1', o.sx.toFixed(1)); el.trunk.setAttribute('x2', o.sx.toFixed(1));
      el.trunk.setAttribute('y1', base.toFixed(1)); el.trunk.setAttribute('y2', cy.toFixed(1));
      el.trunk.setAttribute('stroke', mixHex('#3d3026', '#3a4447', fog));
      el.trunk.setAttribute('stroke-width', Math.max(0.8, (f * 0.3) / o.rz).toFixed(2));
      el.crown.setAttribute('cx', o.sx.toFixed(1)); el.crown.setAttribute('cy', cy.toFixed(1));
      el.crown.setAttribute('rx', o.rr.toFixed(1)); el.crown.setAttribute('ry', (o.rr * 1.08).toFixed(1));
      el.crown.setAttribute('fill', mixHex(dark, '#3a4447', fog));
      // the side towards the sun catches the light
      const lx = o.sx + o.rr * 0.32 * Math.sign(sunX - o.sx || 1);
      el.lit.setAttribute('cx', lx.toFixed(1)); el.lit.setAttribute('cy', (cy - o.rr * 0.28).toFixed(1));
      el.lit.setAttribute('rx', (o.rr * 0.62).toFixed(1)); el.lit.setAttribute('ry', (o.rr * 0.6).toFixed(1));
      el.lit.setAttribute('fill', mixHex(light, '#3a4447', fog));
    });
  }
}

const SPEED = 3.0;          // metres a second, down the path
const LOOP = 15;            // the left cell's "video" runs fifteen seconds, then plays again
const TURN = 0.42;          // radians a key press turns the view
const ORDER = [['#ana-tl', 0], ['#ana-bl', 600], ['#ana-tr', 1200], ['#ana-br', 1800]];

export class Analogy {
  constructor(root) {
    this.root = root;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.watch = new Walk(root.querySelector('#ana-w1'));
    this.steer = new Walk(root.querySelector('#ana-w2'));
    this.bar = root.querySelector('#ana-bar');
    this.time = root.querySelector('#ana-time');
    this.keys = { 1: root.querySelector('[data-turn="1"]'), '-1': root.querySelector('[data-turn="-1"]') };
    this.z = 0; this.yaw = 0; this.yawTo = 0; this.last = 0; this.on = false; this.raf = 0;

    for (const b of root.querySelectorAll('[data-turn]')) b.addEventListener('click', () => this.turn(Number(b.dataset.turn)));
    root.querySelector('#ana-tr').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.turn(e.key === 'ArrowLeft' ? 1 : -1);
      }
    });
    this.draw();

    // the cells come in once, in the film's order; the walks run only while the grid is on screen
    let shown = false;
    new IntersectionObserver(([e]) => {
      this.on = e.isIntersecting;
      if (this.on && !shown) { shown = true; this.reveal(); }
      if (this.on && !this.reduced && !this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame((t) => this.frame(t)); }
    }, { threshold: 0.3 }).observe(root);
  }

  reveal() {
    const br = this.root.querySelector('#ana-br');
    if (this.reduced) {
      for (const [sel] of ORDER) this.root.querySelector(sel).classList.add('is-in');
      br.classList.add('is-answered');
      return;
    }
    for (const [sel, ms] of ORDER) setTimeout(() => this.root.querySelector(sel).classList.add('is-in'), ms);
    setTimeout(() => br.classList.add('is-answered'), 4200);       // the question, then this work in its place
  }

  /** A key press: the view turns, as a world model answers the move. */
  turn(dir) {
    this.yawTo = Math.max(-2 * TURN, Math.min(2 * TURN, this.yawTo + dir * TURN));
    const k = this.keys[dir];
    k.classList.add('is-on');
    clearTimeout(k._t);
    k._t = setTimeout(() => k.classList.remove('is-on'), 260);
    if (this.reduced) { this.yaw = this.yawTo; this.draw(); }
  }

  frame(now) {
    this.raf = 0;
    if (!this.on) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    if (dt >= 1 / 32) {                                     // about 30 frames a second is plenty
      this.last = now;
      this.z += SPEED * dt;
      this.yaw += (this.yawTo - this.yaw) * (1 - Math.exp(-dt * 6));
      this.draw();
    }
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  draw() {
    this.watch.draw(this.z, 0);
    this.steer.draw(this.z, this.yaw);
    const s = (this.z / SPEED) % LOOP;
    this.bar.style.width = `${(100 * s / LOOP).toFixed(2)}%`;
    this.time.textContent = `0:${String(Math.floor(s)).padStart(2, '0')}`;
  }
}
