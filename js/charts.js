/**
 * charts.js — dependency-free SVG for the lab.
 *
 * Two full charts (canopy height, biomass) carry the story; the remaining five variables
 * become compact chips — a sparkline and the difference. That still shows the coupling the
 * paper is about without putting seven plots in front of a first-time visitor.
 *
 * Everything here answers to one focus year. At rest that is 2021; while the stand plays it is
 * the playhead; under the pointer it is the year being read. The charts draw a crosshair at it,
 * and the headline differences and the chips report it.
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

const SERIES = [['act', 'Your scenario'], ['free', 'No action'], ['ed', 'ED simulation']];

const el = (n, a = {}) => {
  const e = document.createElementNS(NS, n);
  for (const k in a) e.setAttribute(k, a[k]);
  return e;
};

const fmt = (v) => {
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
};

const signed = (d) => `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}`;
const NIL = 5e-4;            // below what fmt() can show: the scenario has not diverged yet
const signOf = (d) => (d > NIL ? 'pos' : d < -NIL ? 'neg' : 'flat');

/** A 41-year series read at a fractional year, so the playhead moves smoothly. */
export function at(series, y) {
  const i = Math.max(0, Math.min(YEARS - 1, y));
  const i0 = Math.floor(i), i1 = Math.min(YEARS - 1, i0 + 1), f = i - i0;
  return series[i0] * (1 - f) + series[i1] * f;
}

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

/**
 * Pointer -> year, for any SVG whose plot spans [x0, x1] of a viewBox W wide, over `n` slots.
 * `geom` is asked on every event, so it stays right after a resize redraws the plot.
 * A mouse reads on hover; a finger reads while it drags sideways (the page keeps vertical
 * scrolling, see touch-action in the CSS) and the reading stays after it lifts.
 */
function scrub(svg, geom, n, first, onYear) {
  let touching = false;
  const yearAt = (cx) => {
    const { W, x0, x1 } = geom();
    const r = svg.getBoundingClientRect();
    const t = (((cx - r.left) / r.width) * W - x0) / (x1 - x0);
    return first + Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
  };
  svg.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    touching = true;
    onYear(yearAt(e.clientX), true);
  });
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && !touching) return;
    onYear(yearAt(e.clientX), e.pointerType === 'touch');
  });
  const lift = () => { touching = false; };
  svg.addEventListener('pointerup', lift);
  svg.addEventListener('pointercancel', lift);
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') onYear(null, false); });
}

/** Put a tooltip beside x (CSS px within `host`), flipping to the left past the edge. */
function place(tip, host, svg, xCss) {
  const r = svg.getBoundingClientRect(), h = host.getBoundingClientRect();
  const x = r.left - h.left + xCss;
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.max(4, x + 14 + tw > h.width - 4 ? x - 14 - tw : x + 14)}px`;
  tip.style.top = `${r.top - h.top + 4}px`;
}

/* ------------------------------------------------------------------ chart */

export class Chart {
  constructor(bandIndex) {
    this.band = bandIndex;
    this.spec = BANDS[bandIndex];
    this.W = 420; this.H = 210;
    this.m = { l: 48, r: 12, t: 10, b: 26 };
    this.fy = null;
    this.onHover = null;

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
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    this.root.append(this.tip);
    scrub(this.svg, () => ({ W: this.W, x0: this.m.l, x1: this.W - this.m.r }), YEARS, 0,
      (y, touch) => this.onHover && this.onHover(y, touch));
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
    Object.assign(this, { s, lo, hi });
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

    // the crosshair: a playhead while the stand plays, a reading under the pointer
    this.ov = el('g', { class: 'focus', visibility: 'hidden' });
    this.ovLine = el('line', { class: 'focus-line', y1: this.m.t, y2: this.H - this.m.b });
    this.ov.append(this.ovLine);
    this.ovDots = [];
    for (const [k] of SERIES) {
      if (!s[k]) continue;
      const c = el('circle', { class: `focus-dot ${k}`, r: 3.6 });
      this.ov.append(c);
      this.ovDots.push([k, c]);
    }
    g.append(this.ov);
    this._focus();
  }

  /** y: fractional year index or null (rest: 2021, no crosshair). tip: show the reading. */
  setFocus(y, tip = false) {
    this.fy = y;
    this.fTip = tip;
    this._focus();
  }

  _focus() {
    const s = this.s;
    if (!s) return;
    const y = this.fy;
    const py = y == null ? YEARS - 1 : y;

    // the headline number: how far the action has moved this variable by the focus year
    if (s.act && s.free) {
      const f = at(s.free, py), d = at(s.act, py) - f;
      const pct = f !== 0 ? (100 * d) / Math.abs(f) : 0;
      this.delta.textContent = Math.abs(d) < NIL ? 'no change' : `${signed(d)} ${this.spec.unit}` +
        (Math.abs(pct) < 1000 ? `  ${d >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(0)}%` : '');
      this.delta.dataset.sign = signOf(d);
      this.delta.hidden = false;
    } else {
      this.delta.hidden = true;
    }

    if (y == null) {
      this.ov.setAttribute('visibility', 'hidden');
      this.tip.hidden = true;
      return;
    }
    const x = this._x(y);
    this.ov.setAttribute('visibility', 'visible');
    this.ovLine.setAttribute('x1', x);
    this.ovLine.setAttribute('x2', x);
    for (const [k, c] of this.ovDots) {
      c.setAttribute('cx', x);
      c.setAttribute('cy', this._y(at(s[k], y), this.lo, this.hi));
    }
    if (!this.fTip) { this.tip.hidden = true; return; }

    const yr = Math.round(y);
    this.tip.innerHTML = `<b>${YEAR0 + yr}</b>` + SERIES.filter(([k]) => s[k]).map(([k, label]) =>
      `<span class="tip-row"><i class="sw sw-${k}"></i><span class="tip-l">${label}</span>` +
      `<span class="tip-v">${fmt(s[k][yr])}</span></span>`).join('');
    this.tip.hidden = false;
    place(this.tip, this.root, this.svg, (x / this.W) * this.svg.getBoundingClientRect().width);
  }
}

/* ------------------------------------------------------------------- chip */

export class Chip {
  constructor(bandIndex) {
    this.band = bandIndex;
    this.spec = BANDS[bandIndex];
    this.fy = null;
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
    this.X = (i) => 1 + 70 * (i / (YEARS - 1));
    this.Y = (v) => 3 + 16 * (1 - (v - lo) / (hi - lo || 1));
    Object.assign(this, { free, act });
    const path = (a) => {
      let d = '';
      for (let i = 0; i < a.length; i++) d += `${d ? 'L' : 'M'}${this.X(i).toFixed(1)} ${this.Y(a[i]).toFixed(1)}`;
      return d;
    };
    if (free) svg.append(el('path', { class: 'series free', d: path(free) }));
    if (act) svg.append(el('path', { class: 'series act', d: path(act) }));
    this.dot = el('circle', { class: 'chip-dot', r: 1.9, visibility: 'hidden' });
    svg.append(this.dot);
    this._focus();
  }

  setFocus(y) {
    this.fy = y;
    this._focus();
  }

  _focus() {
    const { free, act } = this;
    const y = this.fy == null ? YEARS - 1 : this.fy;
    if (act && free) {
      const d = at(act, y) - at(free, y);
      this.val.textContent = Math.abs(d) < NIL ? '0' : signed(d);
      this.val.dataset.sign = signOf(d);
    } else {
      this.val.textContent = free ? fmt(at(free, y)) : '—';
      this.val.dataset.sign = 'flat';
    }
    const line = act || free;
    if (this.fy == null || !line) { this.dot.setAttribute('visibility', 'hidden'); return; }
    this.dot.setAttribute('visibility', 'visible');
    this.dot.setAttribute('cx', this.X(this.fy).toFixed(2));
    this.dot.setAttribute('cy', this.Y(at(line, this.fy)).toFixed(2));
  }
}

/* ----------------------------------------------------------------- policy */

/**
 * The answer to "what should we do each year?": the yearly height change the solver prescribes
 * for 1986-2021, against what the stand would have done on its own.
 */
export class Policy {
  constructor(host) {
    this.W = 1000; this.H = 120;
    this.m = { l: 52, r: 10, t: 10, b: 24 };
    this.fy = null;
    this.onHover = null;
    host.textContent = '';
    this.host = host;
    const head = document.createElement('p');
    head.className = 'policy-head';
    head.innerHTML = '<span class="policy-title">The plan, year by year</span>' +
      '<span class="policy-key"><span><i class="sw sw-act"></i>Height change to make</span>' +
      '<span><i class="sw sw-nat"></i>What it would do anyway</span></span>';
    this.svg = el('svg', { class: 'policy-svg', role: 'img',
      'aria-label': 'Yearly canopy height change in the solved plan, 1986 to 2021' });
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    host.append(head, this.svg, this.tip);
    // 36 bars, years 5..40
    scrub(this.svg, () => ({ W: this.W, x0: this.m.l, x1: this.W - this.m.r }), 36, 5,
      (y, touch) => this.onHover && this.onHover(y, touch));
    // Drawn at the strip's own pixel width, not scaled from a fixed viewBox: a 36-bar strip is
    // so wide that scaling it onto a phone would shrink its labels to nothing.
    let t = 0;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { if (this.actions && host.clientWidth >= 50) this.update(this); }, 120);
    }).observe(host);
  }

  _x(k) { return this.m.l + ((this.W - this.m.l - this.m.r) * (k + 0.5)) / 36; }

  /** actions, nat: 36 yearly height changes in metres for 1986..2021. */
  update({ actions, nat }) {
    Object.assign(this, { actions, nat });
    const svg = this.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const w = Math.round(this.host.clientWidth);
    if (w >= 50) this.W = w;
    svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    let lo = 0, hi = 0;
    for (let k = 0; k < 36; k++) {
      lo = Math.min(lo, actions[k], nat[k]);
      hi = Math.max(hi, actions[k], nat[k]);
    }
    const pad = (hi - lo) * 0.08 || 0.1;
    lo -= lo < 0 ? pad : 0; hi += pad;
    const top = this.m.t, bot = this.H - this.m.b;
    const Y = (v) => top + (bot - top) * (1 - (v - lo) / (hi - lo));
    this.Y = Y;

    const all = ticks(lo, hi, 2);
    const dec = decimals(all.length > 1 ? all[1] - all[0] : 1);
    for (const t of [0, ...all.filter((v) => Math.abs(v) > 1e-9 && v > lo && v < hi)]) {
      const y = Y(t);
      svg.append(el('line', { class: t === 0 ? 'zeroline' : 'gridline',
        x1: this.m.l, x2: this.W - this.m.r, y1: y, y2: y }));
      const tx = el('text', { class: 'lbl lbl-y', x: this.m.l - 8, y: y + 3.5, 'text-anchor': 'end' });
      tx.textContent = t === 0 ? '0' : `${t > 0 ? '+' : '−'}${Math.abs(t).toFixed(dec)}`;
      svg.append(tx);
    }
    const unit = el('text', { class: 'lbl lbl-u', x: this.m.l - 8, y: top + 2, 'text-anchor': 'end' });
    unit.textContent = 'm/yr';
    svg.append(unit);

    const bw = ((this.W - this.m.l - this.m.r) / 36) * 0.62;
    this.bars = [];
    for (let k = 0; k < 36; k++) {
      const y0 = Y(0), y1 = Y(actions[k]);
      const b = el('rect', { class: 'pbar', x: (this._x(k) - bw / 2).toFixed(1), width: bw.toFixed(1),
        y: Math.min(y0, y1).toFixed(1), height: Math.max(0.8, Math.abs(y1 - y0)).toFixed(1), rx: 1.5 });
      svg.append(b);
      this.bars.push(b);
    }
    let d = '';
    for (let k = 0; k < 36; k++) d += `${k ? 'L' : 'M'}${this._x(k).toFixed(1)} ${Y(nat[k]).toFixed(1)}`;
    svg.append(el('path', { class: 'pnat', d }));
    for (const [k, yr] of [[0, '1986'], [15, '2001'], [35, '2021']]) {
      const tx = el('text', { class: 'lbl lbl-x', x: this._x(k), y: this.H - 6,
        'text-anchor': k === 0 ? 'start' : k === 35 ? 'end' : 'middle' });
      tx.textContent = yr;
      svg.append(tx);
    }
    this._focus();
  }

  /** y: year index 5..40 or null. */
  setFocus(y, tip = false) {
    this.fy = y;
    this.fTip = tip;
    this._focus();
  }

  _focus() {
    if (!this.bars) return;
    const k = this.fy == null ? -1 : Math.round(this.fy) - 5;
    this.bars.forEach((b, i) => b.classList.toggle('is-on', i === k));
    if (k < 0 || k > 35 || !this.fTip) { this.tip.hidden = true; return; }
    this.tip.innerHTML = `<b>${YEAR0 + 5 + k}</b>` +
      `<span class="tip-row"><i class="sw sw-act"></i><span class="tip-l">Plan</span>` +
      `<span class="tip-v">${signed(this.actions[k])} m</span></span>` +
      `<span class="tip-row"><i class="sw sw-nat"></i><span class="tip-l">On its own</span>` +
      `<span class="tip-v">${signed(this.nat[k])} m</span></span>`;
    this.tip.hidden = false;
    place(this.tip, this.host, this.svg, (this._x(k) / this.W) * this.svg.getBoundingClientRect().width);
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
