/**
 * lab.js — one panel: pick something to do to a forest, see what the model says.
 *
 * v2 deliberately collapses the old three-tab interface. A visitor picks a scenario and a year;
 * the scenario fixes the magnitude, so there is exactly one number to move. Two charts answer it:
 * canopy height, the edited variable, and biomass, the response it carries. No scenario may raise
 * the canopy past H_MAX; the worker levels a run off there (solve.js capHeights).
 *
 * Above them stands the forest itself: in 3D (stage3d.js), where an action forks the plot into
 * two futures, or flat (stand.js) without WebGL. A new scenario or site plays once, slowed through
 * the action, and a single focus year ties the stand, the charts' crosshair and every reported
 * difference together: the playhead while it plays, the year under the pointer while one is read,
 * 2021 at rest.
 */

import { buildCharts, pick, BANDS, Policy } from './charts.js';
import { Stand } from './stand.js';
import { Locator } from './locator.js';
import { svgIcon } from './icons.js';

const YEARS = 41;
const YEAR0 = 1981;
const SEED = 5;
const PLAY_MS = 2600;
// no action, and no target, may raise the canopy past this (m): the forest levels off there
const H_MAX = 50;

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
    hint: 'Name the biomass you want in 2021; the model solves for the yearly actions, keeping the canopy under 50 m.' },
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
    this.fy = null;              // the focus year; null = at rest, which reads 2021
    this._src = 'chart';         // what the visitor is reading it from
    this._playNext = false;      // play the next result through its forty years
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.$ = (s) => root.querySelector(s);
    this.charts = buildCharts(this.$('#chart-grid'), [0, 1]);
    this.policy = new Policy(this.$('#policy'));
    this.stand = new Stand(this.$('#stand'));
    this._upgradeStage();
    this.loc = new Locator(this.$('#loc'), this.$('#loc-pin'));
    for (const c of this.charts) c.onHover = (y) => this._read(y, 'chart');
    this.policy.onHover = (y) => this._read(y, 'policy');
    this._buildSites();
    this._buildActions();
    this._wire();
  }

  get env() { return this.manifest.ages[this.age].action_envelope; }

  /* ------------------------------------------------------------- build */

  /**
   * The flat drawing holds the stage until the 3D forest is ready; three.js is already on its way
   * for the hero's globe. Without WebGL the drawing simply stays.
   */
  _upgradeStage() {
    import('./stage3d.js').then(({ createStage }) => {
      const flat = this.stand;
      const s = createStage(this.$('#stage'), {
        onLost: () => {
          this.stand = flat;
          if (this._site) flat.setSite(this._site);
          if (this._ser) flat.setSeries(this._ser);
          flat.setYear(this.fy == null ? YEARS - 1 : this.fy);
        },
      });
      if (!s) return;
      if (this._site) s.setSite(this._site);
      if (this._ser) s.setSeries(this._ser);
      s.setYear(this.fy == null ? YEARS - 1 : this.fy);
      this.stand = s;
    }).catch((err) => console.warn('3D stage unavailable:', err));
  }

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
      btn.innerHTML = `${svgIcon(s.icon)}<span>${s.label}</span>`;
      btn.addEventListener('click', () => this.setScenario(s.id));
      host.appendChild(btn);
      this.btns.set(s.id, btn);
    }
  }

  _wire() {
    this.$('#sel-cell').addEventListener('change', (e) => this.setCell(Number(e.target.value)));
    this.$('#sel-age').addEventListener('change', (e) => {
      this.age = e.target.value;
      this._playNext = 'site';
      this.refresh();
    });
    this.$('#btn-random').addEventListener('click', () => {
      const p = this.ix.cells;
      this.setCell(p[Math.floor(Math.random() * p.length)].id, true);
    });
    this.$('#rng-year').addEventListener('input', () => {
      this.$('#out-year').textContent = String(YEAR0 + Number(this.$('#rng-year').value));
      this._queue();
    });
    // letting go of the year replays the action at its new date
    this.$('#rng-year').addEventListener('change', () => {
      this._playNext = 'year';
      this._queue();
    });
    this.$('#rng-target').addEventListener('input', () => {
      this._showTarget();
      clearTimeout(this._tTimer);
      this._tTimer = setTimeout(() => this._solve(), 260);
    });
    this.$('#btn-replay').addEventListener('click', () => {
      const y = this._ser && this._ser.year;
      this._play(Number.isFinite(y) ? Math.max(0, y - 6) : 0);
    });
    // a reading taken with a finger stays until the visitor touches something else
    document.addEventListener('pointerdown', (e) => {
      if (this.fy != null && !this._raf && !e.target.closest('.chart svg, .policy-svg, .stage-gl')) this._focus(null);
    });
    // the first play waits until the stand is actually on screen
    this._seen = false;
    this._pending = null;
    new IntersectionObserver(([e]) => {
      this._seen = e.isIntersecting;
      if (this._seen && this._pending != null) { const from = this._pending; this._pending = null; this._play(from); }
    }, { threshold: 0.4 }).observe(this.$('#stage'));
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
    this._playNext = 'scenario';
    if (goal) this._setTargetRange().then(() => this._solve());
    else this._queue();
  }

  async setCell(id, syncSelect = false) {
    this.cellId = id;
    const c = this.ix.cells.find((x) => x.id === id);
    if (syncSelect) this.$('#sel-cell').value = String(id);
    const ns = c.lat >= 0 ? 'N' : 'S', ew = c.lon >= 0 ? 'E' : 'W';
    this.$('#cell-readout').innerHTML =
      `<span>${Math.abs(c.lat).toFixed(2)}°${ns} ${Math.abs(c.lon).toFixed(2)}°${ew}</span>` +
      `<span>${c.trained ? this.ix.regions[c.region] : 'Outside the study regions'}</span>`;
    this.$('#extrap-warn').hidden = !!c.trained;
    this._site = c;
    this.stand.setSite(c);
    this.loc.flyTo(c.lat, c.lon);
    this.onCellChange(c);
    this._playNext = 'site';
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
      const { run, capped } = any
        ? await this.client.send({ type: 'run', cellId: this.cellId, age: this.age, actions: acts, hMax: H_MAX })
        : { run: null };
      const s = SCENARIOS.find((x) => x.id === this.scenario);
      this._draw(run, any && s.mag != null ? Number(this.$('#rng-year').value) : NaN);
      this.$('#compute-note').textContent = `${Math.round(performance.now() - t0)} ms · ` +
        `${any ? 'model prediction' : 'no action'}${capped ? ` · canopy held at ${H_MAX} m` : ''}`;
    } finally {
      this._busy = false;
      this.root.dataset.state = 'ready';
    }
  }

  _draw(act, markYear) {
    this.$('#key-act').hidden = !act;
    for (const c of this.charts) {
      c.update({
        ed: this.ed ? pick(this.ed, c.band) : null,
        free: this.free ? pick(this.free, c.band) : null,
        act: act ? pick(act, c.band) : null,
        markYear,
      });
    }
    // the stage needs the action's date for ramps too, and a name for the scenario's plot
    const s = SCENARIOS.find((x) => x.id === this.scenario);
    const y0 = Number(this.$('#rng-year').value);
    const dated = !!act && !!s && (s.mag != null || s.ramp != null);
    this._ser = {
      free: pick(this.free, 0),
      act: act ? pick(act, 0) : null,
      kind: this.scenario,
      year: dated ? y0 : NaN,
      span: s && s.ramp != null ? s.span : null,
      label: !act ? '' : dated ? `${s.label} · ${YEAR0 + y0}` : 'Your plan',
    };
    this.stand.setSeries(this._ser);
    if (this._playNext) {
      // a new site grows from 1981; a new action starts just before it happens
      const from = this._playNext === 'site' || !dated ? 0 : Math.max(0, y0 - 3.5);
      this._playNext = false;
      this._play(from);
    } else this._focus(this.fy, this._tip);
  }

  /* ------------------------------------------------------------- time */

  /** One focus year for the whole panel. y: fractional year index, or null for 2021 at rest. */
  _focus(y, tip = false, src = this._src) {
    this.fy = y;
    this._tip = tip;
    this._src = src;
    for (const c of this.charts) c.setFocus(y, tip && src === 'chart');
    this.policy.setFocus(y, tip && src === 'policy');
    const sy = y == null ? YEARS - 1 : y;
    this.stand.setYear(sy);
    this._hud(sy);
  }

  /** The visitor reads a year off a chart: that takes over from the playhead. */
  _read(y, src) {
    this._stop();
    this._focus(y, y != null, src);
  }

  _hud(y) {
    const { free, act } = this.stand.valuesAt(y);
    const yr = String(YEAR0 + Math.round(y));
    this.$('#stage-year').textContent = yr;
    if (!Number.isFinite(free)) return;
    this.$('#stage-read').innerHTML = Number.isFinite(act)
      ? `<span><i class="sw sw-act"></i>Your scenario <b>${act.toFixed(1)} m</b></span>` +
        `<span><i class="sw sw-free"></i>No action <b>${free.toFixed(1)} m</b></span>`
      : `<span><i class="sw sw-free"></i>Canopy height <b>${free.toFixed(1)} m</b></span>`;
  }

  /**
   * Play the current result from year `from` to 2021, once. The 3D stage slows the playhead
   * through the action itself, so a fire or a harvest takes the seconds it needs to be seen.
   */
  _play(from = 0) {
    this._stop();
    if (this.reduced) { this._focus(null); return; }
    if (!this._seen) { this._pending = from; this._focus(null); return; }
    const last = YEARS - 1;
    const segs = this.stand.schedule ? this.stand.schedule(from)
      : [{ t0: from, t1: last, ms: (PLAY_MS * (last - from)) / last }];
    const total = segs.reduce((s, g) => s + g.ms, 0);
    const t0 = performance.now();
    this.root.classList.add('is-playing');
    const step = (now) => {
      let e = now - t0;
      if (e < total) {
        let y = last;
        for (const g of segs) {
          if (e <= g.ms) { y = g.t0 + (g.t1 - g.t0) * (g.ms ? e / g.ms : 1); break; }
          e -= g.ms;
        }
        this._focus(y);
        this._raf = requestAnimationFrame(step);
      } else {
        this._stop();
        this._focus(null);
      }
    };
    this._raf = requestAnimationFrame(step);
  }

  _stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.root.classList.remove('is-playing');
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
      type: 'range', cellId: this.cellId, age: this.age, band: 1, year: 40, K: 5, hMax: H_MAX,
    });
    // a little headroom past what the stand can reach, so "out of reach" can be shown; none at the
    // top when the 50 m ceiling, not the stand, sets it
    const pad = (r.hi - r.lo) * 0.15 || Math.abs(r.hi) * 0.1 || 1;
    this._range = { lo: r.lo - pad, hi: r.hi + (r.capped ? 0 : pad), base: r.baseline };
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
        type: 'solve', cellId: this.cellId, age: this.age, band: 1, year: 40, target, K: 16, hMax: H_MAX,
      });
      // what the stand would have done on its own, year by year, against what the plan asks
      const nat = new Float32Array(36);
      for (let k = 0; k < 36; k++) nat[k] = this.free[(k + SEED) * 7] - this.free[(k + SEED - 1) * 7];
      const acts = Float32Array.from(r.actions || []);
      let extra = 0;
      for (let k = 0; k < acts.length; k++) extra += acts[k] - nat[k];
      extra = acts.length ? extra / acts.length : 0;
      const per = `${extra >= 0 ? '+' : '−'}${Math.abs(extra).toFixed(2)} m`;
      vd.dataset.status = r.status === 'solved' ? 'ok' : 'no';
      vd.innerHTML = r.status === 'solved'
        ? (Math.abs(extra) < 0.005
          ? '<b>Already there.</b> No intervention needed.'
          : `<b>Reachable.</b> About <b>${per}</b> of canopy a year beyond natural growth, 1986–2021.`)
        : `<b>Out of reach.</b> The most this stand can do is ` +
          `<b>${r.achieved.toFixed(1)} ${BANDS[1].unit}</b>.`;
      if (acts.length === 36) this.policy.update({ actions: acts, nat });
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
