/**
 * lab.js — one panel: pick something to do to a forest, see what the model says.
 *
 * v2 deliberately collapses the old three-tab interface. A visitor picks a scenario and a year;
 * the scenario fixes the magnitude, so there is exactly one number to move. Canopy height and
 * biomass get full charts; the other five variables appear as compact response chips, which is
 * what shows the coupling without burying the point under seven plots.
 */

import { buildCharts, buildChips, pick, BANDS } from './charts.js';

const YEARS = 41;
const YEAR0 = 1981;
const SEED = 5;

const ICON = {
  leaf: 'M5 21c0-7 4-12 14-14 0 9-5 14-14 14Zm0 0c1-4 3-6 6-8',
  axe: 'M14 3 21 10l-3 3-2-2-7 7-2.5.5L6 21l-3-3 .5-2.5L4 15l7-7-2-2 3-3Z',
  flame: 'M12 22c4 0 7-3 7-7 0-5-5-6-4-11-4 2-6 5-6 8 0-1-1-2-2-3-1 2-2 4-2 6 0 4 3 7 7 7Z',
  scissors: 'M6 3l12 12M18 3 6 15M8 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm13 0a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  sprout: 'M12 22V11m0 0C12 7 9 4 4 4c0 5 3 7 8 7Zm0 0c0-3 2-6 8-6 0 4-3 6-8 6Z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  target: 'M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20Zm0-5a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
};

/**
 * Magnitudes are chosen to sit inside what ED itself produced, so the model is never asked
 * something it has not seen. `mag` is a one-year height change in metres; `ramp` is a yearly
 * change applied from the chosen year for `span` years (null = to 2021).
 */
const SCENARIOS = [
  { id: 'none', label: 'Leave it', icon: 'leaf',
    hint: 'No action. The model grows the stand on its own.' },
  { id: 'thin', label: 'Thin it', icon: 'scissors', mag: -1.5,
    hint: 'A light thinning: 1.5 m of canopy removed.' },
  { id: 'log', label: 'Log it', icon: 'axe', mag: -6,
    hint: 'A heavy harvest: 6 m of canopy removed in one year.' },
  { id: 'fire', label: 'Burn it', icon: 'flame', mag: -4,
    hint: 'A stand-replacing fire: 4 m of canopy lost in one year.' },
  { id: 'replant', label: 'Replant', icon: 'sprout', ramp: 0.35, span: 12,
    hint: 'Twelve years of accelerated growth, then nature takes over.' },
  { id: 'protect', label: 'Protect', icon: 'shield', ramp: 0.15, span: null,
    hint: 'A little extra growth every year to 2021.' },
  { id: 'goal', label: 'Hit a target', icon: 'target',
    hint: 'Name the biomass you want in 2021; the model solves for the yearly actions.' },
];

export class Lab {
  constructor({ root, client, index, manifest, onCellChange }) {
    Object.assign(this, { root, client, manifest, ix: index });
    this.onCellChange = onCellChange || (() => {});
    this.cellId = null;
    this.age = '150';
    this.scenario = 'log';
    this.free = null;
    this.ed = null;
    this._busy = false;
    this._timer = 0;

    this.$ = (s) => root.querySelector(s);
    this.charts = buildCharts(this.$('#chart-grid'), [0, 1]);
    this.chips = buildChips(this.$('#chips'), [2, 3, 4, 5, 6]);
    this._buildSites();
    this._buildActions();
    this._wire();
  }

  get env() { return this.manifest.ages[this.age].action_envelope; }

  /* ------------------------------------------------------------- build */

  _buildSites() {
    const sel = this.$('#sel-cell');
    const regions = this.ix.regions || [];
    const a = document.createElement('optgroup');
    a.label = 'Study regions';
    const b = document.createElement('optgroup');
    b.label = 'Elsewhere (exploratory)';
    for (const c of this.ix.cells) {
      const o = document.createElement('option');
      o.value = String(c.id);
      const ns = c.lat >= 0 ? 'N' : 'S', ew = c.lon >= 0 ? 'E' : 'W';
      const where = `${Math.abs(c.lat).toFixed(1)}°${ns} ${Math.abs(c.lon).toFixed(1)}°${ew}`;
      o.textContent = c.trained ? `${regions[c.region]} · ${where}` : where;
      (c.trained ? a : b).appendChild(o);
    }
    sel.append(a, b);
  }

  _buildActions() {
    const host = this.$('#actions');
    host.textContent = '';
    this.btns = new Map();
    for (const s of SCENARIOS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scn';
      btn.dataset.id = s.id;
      btn.setAttribute('aria-pressed', String(s.id === this.scenario));
      btn.innerHTML =
        `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[s.icon]}"/></svg>` +
        `<span>${s.label}</span>`;
      btn.addEventListener('click', () => this.setScenario(s.id));
      host.appendChild(btn);
      this.btns.set(s.id, btn);
    }
  }

  _wire() {
    this.$('#sel-cell').addEventListener('change', (e) => this.setCell(Number(e.target.value)));
    this.$('#sel-age').addEventListener('change', (e) => { this.age = e.target.value; this.refresh(); });
    this.$('#btn-random').addEventListener('click', () => {
      const p = this.ix.cells;
      this.setCell(p[Math.floor(Math.random() * p.length)].id, true);
    });
    this.$('#rng-year').addEventListener('input', () => {
      this.$('#out-year').textContent = String(YEAR0 + Number(this.$('#rng-year').value));
      this._queue();
    });
    this.$('#rng-target').addEventListener('input', () => {
      this._showTarget();
      clearTimeout(this._tTimer);
      this._tTimer = setTimeout(() => this._solve(), 260);
    });
  }

  /* ------------------------------------------------------------- state */

  setScenario(id) {
    this.scenario = id;
    for (const [k, b] of this.btns) {
      const on = k === id;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const s = SCENARIOS.find((x) => x.id === id);
    this.$('#act-hint').textContent = s.hint;
    const goal = id === 'goal';
    this.$('#goal-row').hidden = !goal;
    this.$('#when-row').hidden = goal || id === 'none';
    if (goal) this._setTargetRange().then(() => this._solve());
    else this._queue();
  }

  async setCell(id, syncSelect = false) {
    this.cellId = id;
    const c = this.ix.cells.find((x) => x.id === id);
    if (syncSelect) this.$('#sel-cell').value = String(id);
    const ns = c.lat >= 0 ? 'N' : 'S', ew = c.lon >= 0 ? 'E' : 'W';
    this.$('#cell-readout').textContent =
      `${Math.abs(c.lat).toFixed(2)}°${ns}, ${Math.abs(c.lon).toFixed(2)}°${ew}` +
      (c.trained ? ` · ${this.ix.regions[c.region]}` : '');
    this.$('#extrap-warn').hidden = !!c.trained;
    this.onCellChange(c);
    await this.refresh();
  }

  /** The (41) action array for the current scenario, in metres; NaN = no action. */
  _actions() {
    const a = new Float32Array(YEARS).fill(NaN);
    const s = SCENARIOS.find((x) => x.id === this.scenario);
    if (!s || s.id === 'none' || s.id === 'goal') return a;
    const y0 = Number(this.$('#rng-year').value);
    const clamp = (v) => Math.min(this.env.max, Math.max(this.env.min, v));
    if (s.mag != null) {
      a[y0] = clamp(s.mag);
    } else if (s.ramp != null && this.free) {
      // a ramp adds to whatever the stand would have done by itself
      const end = s.span == null ? YEARS : Math.min(YEARS, y0 + s.span);
      for (let y = Math.max(y0, SEED); y < end; y++) {
        const nat = this.free[y * 7] - this.free[(y - 1) * 7];
        a[y] = clamp(nat + s.ramp);
      }
    }
    return a;
  }

  _queue() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._compute(), 90);
  }

  async refresh() {
    if (this.cellId == null) return;
    this.root.dataset.state = 'busy';
    const { run } = await this.client.send({ type: 'run', cellId: this.cellId, age: this.age });
    this.free = run;
    this.ed = (await this.client.send({ type: 'truth', cellId: this.cellId, age: this.age })).truth;
    this._rangeKey = null;
    if (this.scenario === 'goal') { await this._setTargetRange(); this._solve(); }
    else await this._compute();
  }

  async _compute() {
    if (this.cellId == null || this._busy || this.scenario === 'goal') return;
    this._busy = true;
    this.root.dataset.state = 'busy';
    const t0 = performance.now();
    try {
      const acts = this._actions();
      const any = acts.some((v) => v === v);
      const { run } = any
        ? await this.client.send({ type: 'run', cellId: this.cellId, age: this.age, actions: acts })
        : { run: null };
      const s = SCENARIOS.find((x) => x.id === this.scenario);
      this._draw(run, any && s.mag != null ? Number(this.$('#rng-year').value) : NaN);
      this.$('#compute-note').textContent =
        `${Math.round(performance.now() - t0)} ms · ${any ? 'model prediction' : 'no action'}`;
    } finally {
      this._busy = false;
      this.root.dataset.state = 'ready';
    }
  }

  _draw(act, markYear) {
    for (const c of this.charts) {
      c.update({
        ed: this.ed ? pick(this.ed, c.band) : null,
        free: this.free ? pick(this.free, c.band) : null,
        act: act ? pick(act, c.band) : null,
        markYear,
      });
    }
    for (const c of this.chips) {
      c.update({
        free: this.free ? pick(this.free, c.band) : null,
        act: act ? pick(act, c.band) : null,
      });
    }
  }

  /* ------------------------------------------------------------- target */

  async _setTargetRange() {
    if (!this.free || this.cellId == null) return;
    const key = `${this.cellId}:${this.age}`;
    if (this._rangeKey === key) return;
    const rng = this.$('#rng-target');
    rng.disabled = true;
    this.$('#out-target').textContent = 'measuring…';
    const r = await this.client.send({
      type: 'range', cellId: this.cellId, age: this.age, band: 1, year: 40, K: 5,
    });
    const pad = (r.hi - r.lo) * 0.15 || Math.abs(r.hi) * 0.1 || 1;
    this._range = { lo: r.lo - pad, hi: r.hi + pad, base: r.baseline };
    this._rangeKey = key;
    const open = r.baseline + 0.55 * (r.hi - r.baseline);
    rng.value = String(Math.round(Math.max(0, Math.min(1,
      (open - this._range.lo) / (this._range.hi - this._range.lo))) * 100));
    rng.disabled = false;
    this._showTarget();
  }

  _target() {
    const g = this._range;
    return g ? g.lo + (g.hi - g.lo) * (Number(this.$('#rng-target').value) / 100) : null;
  }

  _showTarget() {
    const t = this._target();
    if (t != null) this.$('#out-target').textContent = `${t.toFixed(1)} ${BANDS[1].unit}`;
  }

  async _solve() {
    if (!this.free || this.cellId == null) return;
    if (this._busy) { this._again = true; return; }
    const target = this._target();
    if (target == null) { await this._setTargetRange(); return; }
    this._busy = true;
    this.root.dataset.state = 'busy';
    const vd = this.$('#verdict');
    vd.dataset.status = 'working';
    vd.textContent = 'Solving…';
    const t0 = performance.now();
    try {
      const r = await this.client.send({
        type: 'solve', cellId: this.cellId, age: this.age, band: 1, year: 40, target, K: 16,
      });
      const mean = r.actions && r.actions.length
        ? Array.from(r.actions).reduce((s, v) => s + v, 0) / r.actions.length : 0;
      const per = `${mean >= 0 ? '+' : '−'}${Math.abs(mean).toFixed(2)} m`;
      vd.dataset.status = r.status === 'solved' ? 'ok' : 'no';
      vd.innerHTML = r.status === 'solved'
        ? (Math.abs(mean) < 0.005
          ? '<b>Already there.</b> No intervention needed.'
          : `<b>Reachable.</b> Grow the canopy <b>${per} a year</b>, every year from 1986.`)
        : `<b>Out of reach.</b> The most this stand can do is ` +
          `<b>${r.achieved.toFixed(1)} ${BANDS[1].unit}</b>.`;
      this._draw(r.run, NaN);
      this.$('#compute-note').textContent = `${Math.round(performance.now() - t0)} ms · inverse solve`;
    } catch (err) {
      vd.dataset.status = 'no';
      vd.textContent = `Could not solve: ${err.message}`;
    } finally {
      this._busy = false;
      this.root.dataset.state = 'ready';
      if (this._again) { this._again = false; this._solve(); }
    }
  }

  /** Called once after the first cell loads. */
  start() { this.setScenario(this.scenario); }
}
