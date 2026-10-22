/**
 * charts.js — dependency-free SVG for the lab.
 *
 * Two full charts (canopy height, biomass) carry the story; the remaining five variables
 * become compact chips — a sparkline and the 2021 difference. That still shows the coupling
 * the paper is about without putting seven plots in front of a first-time visitor.
 */

const NS = 'http://www.w3.org/2000/svg';
const YEARS = 41;
const YEAR0 = 1981;

/**
 * Units follow the CarbonGlobe variable table (Wang et al., NeurIPS 2025, Table 6). Every band
 * is the December value; for LAI and the three fluxes that is an instantaneous rate, so at a
 * seasonal site December is midwinter rather than the annual mean.
 */
export const BANDS = [
  { key: 'height', label: 'Canopy height', short: 'Height', unit: 'm' },
  { key: 'agb', label: 'Aboveground biomass', short: 'Biomass', unit: 'kgC m⁻²' },
  { key: 'soil', label: 'Soil carbon', short: 'Soil carbon', unit: 'kgC m⁻²' },
  { key: 'lai', label: 'Leaf area index', short: 'Leaf area', unit: 'm²/m²' },
  { key: 'gpp', label: 'Gross primary production', short: 'GPP', unit: 'kgC m⁻² yr⁻¹' },
  { key: 'npp', label: 'Net primary production', short: 'NPP', unit: 'kgC m⁻² yr⁻¹' },
  { key: 'rh', label: 'Heterotrophic respiration', short: 'Respiration', unit: 'kgC m⁻² yr⁻¹' },
];

const el = (n, a = {}) => {
  const e = document.createElementNS(NS, n);
  for (const k in a) e.setAttribute(k, a[k]);
  return e;
};

const fmt = (v) => {
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
};

function ticks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const mag = 10 ** Math.floor(Math.log10(span / n));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= span / n) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/** Decimals that print every multiple of `step` exactly: 20 -> 0, 2.5 -> 1, 0.25 -> 2. */
function decimals(step) {
  let d = 0;
  while (d < 4 && Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) > 1e-6 * 10 ** d) d++;
  return d;
}

function extent(series) {
  let lo = Infinity, hi = -Infinity;
  for (const s of series) {
    if (!s) continue;
    for (let i = 0; i < s.length; i++) {
      const v = s[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) return [0, 1];
  const pad = (hi - lo) * 0.14 || Math.abs(hi) * 0.1 || 1;
  lo -= pad; hi += pad;
  if (lo > 0 && lo < hi - lo) lo = 0;
  return [lo, hi];
}

/* ------------------------------------------------------------------ chart */

export class Chart {
  constructor(bandIndex) {
    this.band = bandIndex;
    this.spec = BANDS[bandIndex];
    this.W = 420; this.H = 210;
    this.m = { l: 48, r: 12, t: 10, b: 26 };

    this.root = document.createElement('figure');
    this.root.className = 'chart';
    const head = document.createElement('figcaption');
    head.className = 'chart-head';
    head.innerHTML = `<span class="chart-title">${this.spec.label}</span>` +
      `<span class="chart-unit">${this.spec.unit}</span>`;
    this.delta = document.createElement('span');
    this.delta.className = 'chart-delta';
    head.appendChild(this.delta);
    this.root.append(head);
    this.svg = el('svg', { viewBox: `0 0 ${this.W} ${this.H}`, role: 'img',
      'aria-label': `${this.spec.label}, 1981 to 2021` });
    this.root.append(this.svg);
  }

  _x(i) { return this.m.l + (this.W - this.m.l - this.m.r) * (i / (YEARS - 1)); }
  _y(v, lo, hi) {
    const h = this.H - this.m.t - this.m.b;
    return this.m.t + h * (1 - (v - lo) / (hi - lo || 1));
  }
  _path(a, lo, hi) {
    let d = '';
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i])) continue;
      d += `${d ? 'L' : 'M'}${this._x(i).toFixed(1)} ${this._y(a[i], lo, hi).toFixed(1)}`;
    }
    return d;
  }

  update(s) {
    const svg = this.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const [lo, hi] = extent([s.ed, s.free, s.act]);
    const g = el('g');
    svg.append(g);

    const tk = ticks(lo, hi);
    const dec = decimals(tk.length > 1 ? tk[1] - tk[0] : 1);
    for (const t of tk) {
      const y = this._y(t, lo, hi);
      g.append(el('line', { class: 'gridline', x1: this.m.l, x2: this.W - this.m.r, y1: y, y2: y }));
      const tx = el('text', { class: 'lbl lbl-y', x: this.m.l - 7, y: y + 3.5, 'text-anchor': 'end' });
      tx.textContent = (Math.abs(t) < 1e-9 ? 0 : t).toFixed(dec);
      g.append(tx);
    }
    for (const yr of [0, 10, 20, 30, 40]) {
      const anchor = yr === 0 ? 'start' : yr === 40 ? 'end' : 'middle';
      const tx = el('text', { class: 'lbl lbl-x', x: this._x(yr), y: this.H - 7, 'text-anchor': anchor });
      tx.textContent = String(YEAR0 + yr);
      g.append(tx);
    }
    g.append(el('rect', { class: 'seed', x: this.m.l, y: this.m.t,
      width: this._x(4) - this.m.l, height: this.H - this.m.t - this.m.b }));

    if (Number.isFinite(s.markYear)) {
      const x = this._x(s.markYear);
      g.append(el('line', { class: 'cursor', x1: x, x2: x, y1: this.m.t, y2: this.H - this.m.b }));
    }
    if (s.ed) g.append(el('path', { class: 'series ed', d: this._path(s.ed, lo, hi) }));
    if (s.free) g.append(el('path', { class: 'series free', d: this._path(s.free, lo, hi) }));
    if (s.act) {
      g.append(el('path', { class: 'series act', d: this._path(s.act, lo, hi) }));
      g.append(el('circle', { class: 'dot-mark', r: 4,
        cx: this._x(YEARS - 1), cy: this._y(s.act[YEARS - 1], lo, hi) }));
    }

    if (s.act && s.free) {
      const d = s.act[YEARS - 1] - s.free[YEARS - 1];
      const f = s.free[YEARS - 1];
      const pct = f !== 0 ? (100 * d) / Math.abs(f) : 0;
      this.delta.textContent = `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))} ${this.spec.unit}` +
        (Math.abs(pct) < 1000 ? `  ${d >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(0)}%` : '');
      this.delta.dataset.sign = d > 1e-9 ? 'pos' : d < -1e-9 ? 'neg' : 'flat';
      this.delta.hidden = false;
    } else {
      this.delta.hidden = true;
    }
  }
}

/* ------------------------------------------------------------------- chip */

export class Chip {
  constructor(bandIndex) {
    this.band = bandIndex;
    this.spec = BANDS[bandIndex];
    this.root = document.createElement('div');
    this.root.className = 'chip';
    this.root.title = `${this.spec.label} (${this.spec.unit})`;
    this.root.innerHTML = `<p class="chip-l">${this.spec.short}</p>`;
    this.svg = el('svg', { class: 'chip-s', viewBox: '0 0 72 22', 'aria-hidden': 'true' });
    this.root.append(this.svg);
    this.val = document.createElement('p');
    this.val.className = 'chip-d';
    this.root.append(this.val);
  }

  update({ free, act }) {
    const svg = this.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const [lo, hi] = extent([free, act]);
    const X = (i) => 1 + 70 * (i / (YEARS - 1));
    const Y = (v) => 3 + 16 * (1 - (v - lo) / (hi - lo || 1));
    const path = (a) => {
      let d = '';
      for (let i = 0; i < a.length; i++) d += `${d ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(a[i]).toFixed(1)}`;
      return d;
    };
    if (free) svg.append(el('path', { class: 'series free', d: path(free) }));
    if (act) svg.append(el('path', { class: 'series act', d: path(act) }));

    if (act && free) {
      const d = act[YEARS - 1] - free[YEARS - 1];
      this.val.textContent = `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}`;
      this.val.dataset.sign = d > 1e-9 ? 'pos' : d < -1e-9 ? 'neg' : 'flat';
    } else {
      this.val.textContent = free ? fmt(free[YEARS - 1]) : '—';
      this.val.dataset.sign = 'flat';
    }
  }
}

export function buildCharts(host, order) {
  host.textContent = '';
  return order.map((b) => { const c = new Chart(b); host.append(c.root); return c; });
}

export function buildChips(host, order) {
  host.textContent = '';
  return order.map((b) => { const c = new Chip(b); host.append(c.root); return c; });
}

export function pick(run, b) {
  const out = new Float32Array(YEARS);
  for (let y = 0; y < YEARS; y++) out[y] = run[y * 7 + b];
  return out;
}
