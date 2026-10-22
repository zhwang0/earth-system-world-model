/**
 * stand.js — the forest itself: a stand of trees that follows the model's canopy height.
 *
 * An illustration driven by numbers. In every year the trees' mean height is the canopy height
 * the model predicts. When a scenario leaves the stand shorter than it would otherwise be, the
 * shortfall shows as cleared ground (stumps, or snags after a fire) rather than as uniformly
 * shrunken trees: closer to how ED represents a disturbance, as an area cleared beside an area
 * left standing. When a scenario adds growth, the trees simply stand taller.
 *
 *   const stand = new Stand(svg);
 *   stand.setSite(cell);                                // tree mix and layout for this place
 *   stand.setSeries({ free, act, kind, year });         // heights in metres, 41 years
 *   stand.setYear(23.4);                                // fractional years animate smoothly
 */

const NS = 'http://www.w3.org/2000/svg';
const W = 1000;
const H = 280;
const YEARS = 41;
const H_MIN = 12;          // the smallest stand height the stage scales up to fill
const HEADROOM = 72;       // stage units kept clear for the readout
const HORIZON = 150;

// two rows give the stand depth; the far row is smaller, higher and dimmer
const ROWS = [
  { n: 16, ground: 176, k: 0.62, cls: 'far' },
  { n: 20, ground: 244, k: 1, cls: 'near' },
];

// Unit trees: base at (0, 0), top at y = -1, drawn at height 1 and scaled per year.
const SHAPES = {
  round: {
    trunk: 'M-.026 0 L-.017 -.52 L.017 -.52 L.026 0 Z',
    crown: 'M0 -1 C.12 -1 .21 -.92 .22 -.8 C.33 -.79 .4 -.68 .37 -.57 C.35 -.46 .24 -.4 .12 -.42 ' +
      'C.06 -.36 -.06 -.36 -.12 -.42 C-.24 -.4 -.35 -.46 -.37 -.57 C-.4 -.68 -.33 -.79 -.22 -.8 ' +
      'C-.21 -.92 -.12 -1 0 -1 Z',
  },
  cone: {
    trunk: 'M-.02 0 L-.014 -.2 L.014 -.2 L.02 0 Z',
    crown: 'M0 -1 L.11 -.7 L.06 -.71 L.18 -.42 L.09 -.43 L.23 -.13 L-.23 -.13 L-.09 -.43 L-.18 -.42 ' +
      'L-.06 -.71 L-.11 -.7 Z',
  },
  // a rainforest emergent: a tall bole that splits into limbs under a broad, lumpy crown
  umbrella: {
    trunk: 'M-.028 0 L-.016 -.64 L-.17 -.84 L-.145 -.855 L-.012 -.71 L-.007 -.87 L.007 -.87 ' +
      'L.012 -.71 L.145 -.855 L.17 -.84 L.016 -.64 L.028 0 Z',
    crown: 'M-.4 -.84 C-.44 -.9 -.37 -.96 -.29 -.94 C-.27 -1 -.17 -1.02 -.11 -.98 C-.06 -1.03 .06 -1.03 ' +
      '.11 -.98 C.17 -1.02 .27 -1 .29 -.94 C.37 -.96 .44 -.9 .4 -.84 C.37 -.79 .27 -.79 .22 -.81 ' +
      'C.15 -.77 .07 -.78 0 -.8 C-.07 -.78 -.15 -.77 -.22 -.81 C-.27 -.79 -.37 -.79 -.4 -.84 Z',
  },
};

/** A tiny seeded generator, so a site always grows the same forest. */
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

const el = (n, a = {}, parent) => {
  const e = document.createElementNS(NS, n);
  for (const k in a) e.setAttribute(k, a[k]);
  if (parent) parent.appendChild(e);
  return e;
};

/** Linear interpolation into a 41-year series at a fractional year. */
function at(series, y) {
  if (!series) return NaN;
  const i = Math.max(0, Math.min(YEARS - 1, y));
  const i0 = Math.floor(i), i1 = Math.min(YEARS - 1, i0 + 1), f = i - i0;
  return series[i0] * (1 - f) + series[i1] * f;
}

export class Stand {
  constructor(svg) {
    this.svg = svg;
    this.series = { free: null, act: null, kind: 'none', year: NaN };
    this.trees = [];
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMax slice');
    this._scene();
  }

  /* ------------------------------------------------------------ scenery */

  _scene() {
    const svg = this.svg;
    const defs = el('defs', {}, svg);

    const g = (id, stops, attrs = { x1: 0, y1: 0, x2: 0, y2: 1 }) => {
      const lg = el('linearGradient', { id, ...attrs }, defs);
      for (const [o, c, a = 1] of stops) el('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, lg);
    };
    g('st-crown-near', [[0, '#B9DB8A'], [0.45, '#5FA35F'], [1, '#1D5640']]);
    g('st-crown-far', [[0, '#6F9A6A'], [1, '#22453A']]);
    g('st-floor', [[0, '#0F1C18', 0], [0.35, '#0F1C18', 1], [1, '#0A1210', 1]]);
    g('st-fade', [[0, '#fff', 0], [1, '#fff', 1]]);

    const glow = el('radialGradient', { id: 'st-glow', cx: 0.5, cy: 0.5, r: 0.5 }, defs);
    el('stop', { offset: 0, 'stop-color': '#9CC46A', 'stop-opacity': 0.22 }, glow);
    el('stop', { offset: 1, 'stop-color': '#9CC46A', 'stop-opacity': 0 }, glow);
    const ember = el('radialGradient', { id: 'st-ember', cx: 0.5, cy: 0.5, r: 0.5 }, defs);
    el('stop', { offset: 0, 'stop-color': '#FF9A3D', 'stop-opacity': 0.75 }, ember);
    el('stop', { offset: 0.55, 'stop-color': '#E2541C', 'stop-opacity': 0.28 }, ember);
    el('stop', { offset: 1, 'stop-color': '#E2541C', 'stop-opacity': 0 }, ember);

    // the floor: a perspective grid that says "simulation" without a word of copy
    const mask = el('mask', { id: 'st-floor-mask' }, defs);
    el('rect', { x: 0, y: HORIZON, width: W, height: H - HORIZON, fill: 'url(#st-fade)' }, mask);
    el('ellipse', { cx: W / 2, cy: HORIZON + 6, rx: 560, ry: 92, fill: 'url(#st-glow)' }, svg);
    el('rect', { x: 0, y: HORIZON, width: W, height: H - HORIZON, fill: 'url(#st-floor)' }, svg);
    const grid = el('g', { class: 'st-grid', mask: 'url(#st-floor-mask)' }, svg);
    const vx = W / 2, vy = HORIZON - 90;
    for (let i = -16; i <= 16; i++) {
      const xb = vx + i * 92;
      const t = (HORIZON - vy) / (H - vy);
      el('line', { x1: vx + (xb - vx) * t, y1: HORIZON, x2: xb, y2: H }, grid);
    }
    for (let k = 1; k <= 9; k++) {
      const y = HORIZON + (H - HORIZON) * (k / 9) ** 1.7;
      el('line', { x1: 0, y1: y, x2: W, y2: y }, grid);
    }

    // the canopy levels run between the rows, so the near trees stand in front of them
    this.gRows = ROWS.map((row) => el('g', { class: `st-row st-${row.cls}` }));
    svg.append(this.gRows[0]);
    this.lvlFree = el('line', { class: 'st-lvl st-lvl-free', x1: 0, x2: W, y1: -10, y2: -10 }, svg);
    this.lvlAct = el('line', { class: 'st-lvl st-lvl-act', x1: 0, x2: W, y1: -10, y2: -10 }, svg);
    svg.append(this.gRows[1]);
    this.ember = el('ellipse', { cx: W / 2, cy: 246, rx: 540, ry: 70, fill: 'url(#st-ember)', opacity: 0 }, svg);
  }

  /** Lay out a stand for this site: the tree mix follows latitude, the layout follows the id. */
  setSite(cell) {
    const r = rng(((cell && cell.id) || 0) * 2654435761 + 7);
    const lat = Math.abs((cell && cell.lat) || 0);
    const mix = lat < 23.5 ? { umbrella: 0.4, round: 0.6, cone: 0 }
      : lat < 50 ? { umbrella: 0, round: 0.7, cone: 0.3 }
        : { umbrella: 0, round: 0.15, cone: 0.85 };
    const pickShape = () => {
      const u = r();
      return u < mix.umbrella ? 'umbrella' : u < mix.umbrella + mix.round ? 'round' : 'cone';
    };

    this.trees = [];
    ROWS.forEach((row, ri) => {
      const gRow = this.gRows[ri];
      gRow.textContent = '';
      const span = W + 120, step = span / row.n;
      const rel = [];
      for (let i = 0; i < row.n; i++) rel.push(0.8 + 0.4 * r());
      const mean = rel.reduce((s, v) => s + v, 0) / row.n;
      // the order in which this row gives way when the stand is cleared (Fisher-Yates)
      const order = rel.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let i = 0; i < row.n; i++) {
        const shape = pickShape();
        const x = -60 + step * (i + 0.5) + (r() - 0.5) * step * 0.55;
        const g = el('g', { transform: `translate(${x.toFixed(1)} ${row.ground})` }, gRow);
        const sway = el('g', { class: 'st-sway' }, g);
        sway.style.animationDelay = `${(-r() * 7).toFixed(2)}s`;
        sway.style.animationDuration = `${(5.5 + r() * 3).toFixed(2)}s`;
        const grow = el('g', {}, sway);
        el('path', { class: 'st-trunk', d: SHAPES[shape].trunk }, grow);
        el('path', { class: 'st-crown', d: SHAPES[shape].crown, fill: `url(#st-crown-${row.cls})` }, grow);
        const stump = el('g', { class: 'st-stump', opacity: 0, transform: `scale(${row.k})` }, g);
        el('path', { d: 'M-6 0 L-5 -10 L5 -10 L6 0 Z' }, stump);
        el('ellipse', { class: 'st-cut', cx: 0, cy: -10, rx: 5, ry: 1.8 }, stump);
        const snag = el('g', { class: 'st-snag', opacity: 0 }, g);
        const snagPath = el('path', {}, snag);
        this.trees.push({
          row, grow, stump, snag, snagPath,
          rel: rel[i] / mean,
          rank: (order.indexOf(i) + 0.5) / row.n,
          shape,
        });
      }
    });
    this.setYear(this.year ?? YEARS - 1);
  }

  /** free/act are 41-year canopy heights in metres; act is null when nothing is done. */
  setSeries({ free, act, kind = 'none', year = NaN }) {
    this.series = { free, act, kind, year };
    // One scale per result, never per frame, so the trees do not rescale mid-play. It is set by
    // the site's own undisturbed stand, so a 13 m boreal stand fills the stage as a 30 m tropical
    // one does and every scenario at a site shares it; it grows only when a scenario outgrows it
    // (the tallest tree is ~1.2x the mean).
    const peak = (s) => (s ? s.reduce((m, v) => Math.max(m, v), 0) : 0);
    this.hTop = Math.max(H_MIN, peak(free) * 1.3, peak(act) * 1.25);
    this.setYear(this.year ?? YEARS - 1);
  }

  /** Values at a (fractional) year, for the readout. */
  valuesAt(y) {
    const { free, act } = this.series;
    return { free: at(free, y), act: act ? at(act, y) : NaN };
  }

  setYear(y) {
    this.year = y;
    const { free, act, kind, year: actYear } = this.series;
    if (!free || !this.trees.length) return;

    const hFree = at(free, y);
    const hAct = act ? at(act, y) : hFree;
    // stage units per metre, so the tallest tree of this result still fits under the readout
    const pxm = (ROWS[1].ground - HEADROOM) / (this.hTop || H_MIN);
    const ratio = hFree > 1e-6 ? hAct / hFree : 1;
    const cleared = Math.max(0, 1 - ratio);           // share of the stand that is gone
    const standing = ratio >= 1 ? hAct : hFree;       // what the trees that remain stand at
    const burnt = kind === 'fire';

    for (const t of this.trees) {
      const hPx = Math.max(0.5, t.rel * standing * pxm * t.row.k);
      // Cleared trees go smallest rank first. The one on the boundary is shrunk by its share
      // rather than faded, so at rest it reads as a smaller tree, and in the harvest year the
      // trees visibly come down.
      const n = t.row.n;
      const gone = Math.max(0, Math.min(1, (cleared - t.rank) * n + 0.5));
      const h = Math.max(0.5, hPx * (1 - gone));
      // widen less than the trees grow, so tall stands do not turn into one blob
      const sx = Math.min(h, 120 * t.row.k) * (t.shape === 'cone' ? 0.95 : 1);
      t.grow.setAttribute('transform', `scale(${sx.toFixed(2)} ${h.toFixed(2)})`);
      t.grow.setAttribute('opacity', gone > 0.97 ? 0 : 1);
      const mark = Math.max(0, Math.min(1, (gone - 0.3) / 0.4)).toFixed(3);
      if (burnt) {
        t.stump.setAttribute('opacity', 0);
        t.snag.setAttribute('opacity', mark);
        if (gone > 0) {
          const s = hPx * 0.46, b = s * 0.55;
          t.snagPath.setAttribute('d',
            `M-2.2 0 L-1.2 ${-s} L1.2 ${-s} L2.2 0 Z M0 ${-b} L${s * 0.22} ${-b - s * 0.2} ` +
            `L${s * 0.22 + 1.4} ${-b - s * 0.2 + 1} L1 ${-b + 2.5} Z`);
        }
      } else {
        t.snag.setAttribute('opacity', 0);
        t.stump.setAttribute('opacity', mark);
      }
    }

    // a fire glows for a couple of years around the burn, then is gone
    let glow = 0;
    if (burnt && Number.isFinite(actYear) && y >= actYear - 0.5) glow = Math.exp(-(y - actYear + 0.5) / 1.1);
    this.ember.setAttribute('opacity', glow.toFixed(3));

    // the two canopy levels, measured on the near row: the stand without action, and with it
    const ground = ROWS[1].ground;
    const yFree = ground - hFree * pxm, yAct = ground - hAct * pxm;
    const showFree = !!act;
    this.lvlFree.setAttribute('y1', showFree ? yFree.toFixed(1) : -10);
    this.lvlFree.setAttribute('y2', showFree ? yFree.toFixed(1) : -10);
    this.lvlAct.setAttribute('y1', yAct.toFixed(1));
    this.lvlAct.setAttribute('y2', yAct.toFixed(1));
    this.lvlAct.classList.toggle('is-free', !act);
  }
}
