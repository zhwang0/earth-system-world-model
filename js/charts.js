/**
 * charts.js — small, dependency-free SVG line charts for the lab.
 *
 * Each chart shows one of the seven state variables over 1981–2021: the ED simulation, the
 * model's undisturbed rollout, and the model under the visitor's intervention, optionally over
 * a translucent band showing everything the site could reach.
 */

const NS = 'http://www.w3.org/2000/svg';
const YEARS = 41;
const YEAR0 = 1981;

/**
 * Units follow the CarbonGlobe variable table (Wang et al., NeurIPS 2025, Table 6).
 *
 * Every band is the DECEMBER value of its year — that is what the model reads and predicts. For
 * the three fluxes and for LAI that matters: the stored monthly values are instantaneous rates
 * expressed per year, so December is midwinter at a seasonal site, not the annual mean. At the
 * eastern North America cell, December GPP is 0.16 against an annual mean of 1.94. The charts
 * therefore say "December" rather than implying an annual total.
 */
export const BANDS = [
  { key: 'height', label: 'Canopy height', unit: 'm', dec: false },
  { key: 'agb', label: 'Aboveground biomass', unit: 'kgC m⁻²', dec: false },
  { key: 'soil', label: 'Soil carbon', unit: 'kgC m⁻²', dec: false },
  { key: 'lai', label: 'Leaf area index', unit: 'm²/m²', dec: true },
  { key: 'gpp', label: 'Gross primary production', unit: 'kgC m⁻² yr⁻¹', dec: true },
  { key: 'npp', label: 'Net primary production', unit: 'kgC m⁻² yr⁻¹', dec: true },
  { key: 'rh', label: 'Heterotrophic respiration', unit: 'kgC m⁻² yr⁻¹', dec: true },
];

const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

/** Pick ~4 round tick values covering [lo, hi]. */
function ticks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

const fmt = (v) => {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
};

export class Chart {
  constructor(bandIndex) {
    this.band = bandIndex;
    this.spec = BANDS[bandIndex];

    this.root = document.createElement('figure');
    this.root.className = 'chart';

    const head = document.createElement('figcaption');
    head.className = 'chart-head';
    head.innerHTML = `<span class="chart-title">${this.spec.label}</span>` +
      `<span class="chart-unit">${this.spec.unit}</span>` +
      (this.spec.dec
        ? '<span class="chart-note" title="The model reads and predicts each year\'s December' +
          ' value. For a seasonal forest that is midwinter, not the annual mean.">Dec</span>'
        : '');
    this.delta = document.createElement('span');
    this.delta.className = 'chart-delta';
    head.appendChild(this.delta);
    this.root.appendChild(head);

    this.svg = el('svg', { viewBox: '0 0 320 150', preserveAspectRatio: 'none',
      role: 'img', 'aria-label': `${this.spec.label} over 1981 to 2021` });
    this.root.appendChild(this.svg);

    this.W = 320; this.H = 150;
    this.m = { l: 44, r: 8, t: 8, b: 22 };
  }

  _x(i) {
    const { l, r } = this.m;
    return l + (this.W - l - r) * (i / (YEARS - 1));
  }

  _y(v, lo, hi) {
    const { t, b } = this.m;
    const h = this.H - t - b;
    return t + h * (1 - (v - lo) / (hi - lo || 1));
  }

  _path(arr, lo, hi) {
    let d = '';
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) continue;
      d += `${d ? 'L' : 'M'}${this._x(i).toFixed(2)} ${this._y(arr[i], lo, hi).toFixed(2)}`;
    }
    return d;
  }

  /**
   * @param {object} s  {ed, free, act, envLo, envHi, markYear}
   *        each series is a Float32Array of 41 values, or null to omit
   */
  update(s) {
    const svg = this.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const pools = [s.ed, s.free, s.act, s.envLo, s.envHi].filter(Boolean);
    let lo = Infinity, hi = -Infinity;
    for (const p of pools) {
      for (let i = 0; i < p.length; i++) {
        const v = p[i];
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
    lo = Math.min(lo - pad, hi);
    hi = hi + pad;
    if (lo > 0 && lo < (hi - lo)) lo = 0;          // keep zero in view when it is close

    const g = el('g');
    svg.appendChild(g);

    // gridlines + y labels
    for (const tv of ticks(lo, hi)) {
      const y = this._y(tv, lo, hi);
      g.appendChild(el('line', { class: 'gridline', x1: this.m.l, x2: this.W - this.m.r, y1: y, y2: y }));
      const tx = el('text', { class: 'lbl lbl-y', x: this.m.l - 6, y: y + 3.5, 'text-anchor': 'end' });
      tx.textContent = fmt(tv);
      g.appendChild(tx);
    }

    // x labels
    for (const yr of [0, 10, 20, 30, 40]) {
      const x = this._x(yr);
      const tx = el('text', { class: 'lbl lbl-x', x, y: this.H - 6, 'text-anchor': 'middle' });
      tx.textContent = String(YEAR0 + yr);
      g.appendChild(tx);
    }
    g.appendChild(el('line', { class: 'ax', x1: this.m.l, x2: this.W - this.m.r,
      y1: this.H - this.m.b, y2: this.H - this.m.b }));

    // the seed window: years 0-4 are ED, not prediction
    g.appendChild(el('rect', { class: 'seed', x: this.m.l, y: this.m.t,
      width: this._x(4) - this.m.l, height: this.H - this.m.t - this.m.b }));

    // reachable envelope
    if (s.envLo && s.envHi) {
      let d = '';
      for (let i = 0; i < YEARS; i++) d += `${i ? 'L' : 'M'}${this._x(i)} ${this._y(s.envHi[i], lo, hi)}`;
      for (let i = YEARS - 1; i >= 0; i--) d += `L${this._x(i)} ${this._y(s.envLo[i], lo, hi)}`;
      g.appendChild(el('path', { class: 'band-fill', d: d + 'Z' }));
    }

    if (Number.isFinite(s.markYear)) {
      const x = this._x(s.markYear);
      g.appendChild(el('line', { class: 'cursor', x1: x, x2: x, y1: this.m.t, y2: this.H - this.m.b }));
    }

    if (s.ed) g.appendChild(el('path', { class: 'series ed', d: this._path(s.ed, lo, hi) }));
    if (s.free) g.appendChild(el('path', { class: 'series free', d: this._path(s.free, lo, hi) }));
    if (s.act) g.appendChild(el('path', { class: 'series act', d: this._path(s.act, lo, hi) }));

    // year-40 delta readout
    if (s.act && s.free) {
      const a = s.act[YEARS - 1], f = s.free[YEARS - 1];
      const d = a - f;
      const pct = f !== 0 ? (100 * d) / Math.abs(f) : 0;
      this.delta.textContent = `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))} ${this.spec.unit}` +
        (Math.abs(pct) < 1000 ? ` (${d >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)` : '');
      this.delta.dataset.sign = d > 1e-9 ? 'pos' : d < -1e-9 ? 'neg' : 'flat';
      this.delta.hidden = false;
    } else {
      this.delta.hidden = true;
    }
  }
}

/** Build one chart per state variable into `container`. */
export function buildCharts(container, order = [0, 1, 2, 3, 4, 5, 6]) {
  container.textContent = '';
  const charts = order.map((b) => {
    const c = new Chart(b);
    container.appendChild(c.root);
    return c;
  });
  return charts;
}

/** Pull band `b`'s 41-year series out of a flat (41*7) rollout. */
export function pick(run, b) {
  const out = new Float32Array(YEARS);
  for (let y = 0; y < YEARS; y++) out[y] = run[y * 7 + b];
  return out;
}
