/**
 * lab.js — the what-if laboratory.
 *
 * Owns the three interaction modes and keeps them honest:
 *   disturb  one height change in one year
 *   manage   a year-by-year action schedule, painted on a strip
 *   target   name an outcome for 2021 and let the model solve for the actions
 *
 * Every action is reported against the range ED itself produced across the 203 study cells, so
 * the visitor can always see whether they are asking a fair question or extrapolating.
 */

import { buildCharts, pick, BANDS } from './charts.js';

const YEARS = 41;
const YEAR0 = 1981;
const SEED = 5;

const fmtM = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} m`;

export class Lab {
  constructor({ root, client, index, manifest, onCellChange }) {
    this.root = root;
    this.client = client;
    this.ix = index;
    this.manifest = manifest;
    this.onCellChange = onCellChange || (() => {});

    this.cellId = null;
    this.age = '150';
    this.mode = 'disturb';
    this.schedule = new Float32Array(YEARS).fill(NaN);
    this.free = null;
    this.ed = null;
    this._timer = 0;
    this._busy = false;

    this.$ = (s) => root.querySelector(s);
    this.charts = buildCharts(this.$('#chart-grid'), [0, 1, 2, 3, 4, 5, 6]);
    this._buildSitePicker();
    this._buildSchedule();
    this._wire();
  }

  get env() { return this.manifest.ages[this.age].action_envelope; }

  /* ----------------------------------------------------------- scaffolding */

  _buildSitePicker() {
    const sel = this.$('#sel-cell');
    const regions = this.ix.regions || [];
    const studied = document.createElement('optgroup');
    studied.label = 'Study regions (trained and evaluated)';
    const other = document.createElement('optgroup');
    other.label = 'Elsewhere on Earth (extrapolation)';

    const named = (c) => {
      const ns = c.lat >= 0 ? 'N' : 'S';
      const ew = c.lon >= 0 ? 'E' : 'W';
      const where = `${Math.abs(c.lat).toFixed(2)}°${ns} ${Math.abs(c.lon).toFixed(2)}°${ew}`;
      return c.trained ? `${regions[c.region] || 'Study region'} · ${where}` : where;
    };

    for (const c of this.ix.cells) {
      const o = document.createElement('option');
      o.value = String(c.id);
      o.textContent = named(c);
      (c.trained ? studied : other).appendChild(o);
    }
    sel.append(studied, other);
  }

  _buildSchedule() {
    const host = this.$('#sched');
    host.textContent = '';
    this.bars = [];
    for (let y = SEED; y < YEARS; y++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'zero';
      b.dataset.year = String(y);
      b.title = `${YEAR0 + y}`;
      b.setAttribute('aria-label', `${YEAR0 + y}: no action`);
      host.appendChild(b);
      this.bars.push(b);
    }

    let painting = false;
    const paint = (ev) => {
      const t = document.elementFromPoint(
        ev.clientX ?? ev.touches?.[0]?.clientX, ev.clientY ?? ev.touches?.[0]?.clientY);
      if (!t || t.parentElement !== host) return;
      const y = Number(t.dataset.year);
      const mag = Number(this.$('#rng-mag').value);
      this.schedule[y] = mag;
      this._paintBar(t, mag);
      this._queue();
    };
    host.addEventListener('pointerdown', (e) => {
      painting = true; host.setPointerCapture(e.pointerId); paint(e); e.preventDefault();
    });
    host.addEventListener('pointermove', (e) => { if (painting) paint(e); });
    host.addEventListener('pointerup', () => { painting = false; });
    host.addEventListener('pointercancel', () => { painting = false; });
  }

  _paintBar(bar, mag) {
    const y = Number(bar.dataset.year);
    const on = Number.isFinite(mag) && Math.abs(mag) > 1e-6;
    bar.className = !on ? 'zero' : mag > 0 ? 'pos' : 'neg';
    const z = on ? this._zone(mag) : 'typical';
    if (on && z !== 'typical') bar.dataset.zone = z; else delete bar.dataset.zone;
    const h = on ? Math.min(1, Math.abs(mag) / 3) : 0;
    bar.style.setProperty('--amt', h.toFixed(3));
    bar.setAttribute('aria-label', on ? `${YEAR0 + y}: ${fmtM(mag)}` : `${YEAR0 + y}: no action`);
  }

  _zone(a) {
    const e = this.env;
    if (a >= e.p1 && a <= e.p99) return 'typical';
    if (a >= e.min && a <= e.max) return 'rare';
    return 'extrapolation';
  }

  _wire() {
    this.$('#sel-cell').addEventListener('change', (e) => this.setCell(Number(e.target.value)));
    this.$('#sel-age').addEventListener('change', (e) => { this.age = e.target.value; this.refresh(); });
    this.$('#btn-random').addEventListener('click', () => {
      const pool = this.ix.cells;
      this.setCell(pool[Math.floor(Math.random() * pool.length)].id, true);
    });

    for (const tab of this.root.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => this.setMode(tab.dataset.mode));
    }

    const yr = this.$('#rng-year'), mg = this.$('#rng-mag');
    const sync = () => {
      this.$('#out-year').textContent = String(YEAR0 + Number(yr.value));
      const m = Number(mg.value);
      this.$('#out-mag').textContent = fmtM(m);
      const z = this._zone(m);
      const note = this.$('#zone-note');
      note.dataset.zone = z;
      note.textContent = z === 'typical'
        ? 'Within the yearly height changes the model saw in training.'
        : z === 'rare'
          ? 'Large, but ED did produce changes this size — rarely.'
          : 'Beyond anything in training. The model is extrapolating.';
      this._queue();
    };
    yr.addEventListener('input', sync);
    mg.addEventListener('input', sync);
    this._syncDisturb = sync;

    for (const chip of this.root.querySelectorAll('.chip')) {
      chip.addEventListener('click', () => this._preset(chip.dataset.preset));
    }

    this.$('#sel-band').addEventListener('change', async () => {
      this._rangeKey = null;
      await this._setTargetRange();
      this._retarget();
    });
    this.$('#rng-target').addEventListener('input', () => this._queueTarget());
  }

  /* ----------------------------------------------------------- state */

  setMode(mode) {
    this.mode = mode;
    for (const t of this.root.querySelectorAll('.tab')) {
      const on = t.dataset.mode === mode;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', String(on));
    }
    for (const p of this.root.querySelectorAll('.panel[data-for]')) {
      p.hidden = p.dataset.for !== mode;
    }
    if (mode === 'target') this._setTargetRange().then(() => this._retarget());
    else this._queue();
  }

  async setCell(id, syncSelect = false) {
    this.cellId = id;
    const c = this.ix.cells.find((x) => x.id === id);
    if (syncSelect) this.$('#sel-cell').value = String(id);
    const ns = c.lat >= 0 ? 'N' : 'S', ew = c.lon >= 0 ? 'E' : 'W';
    this.$('#cell-readout').textContent =
      `${Math.abs(c.lat).toFixed(2)}°${ns}, ${Math.abs(c.lon).toFixed(2)}°${ew}` +
      (c.trained ? ` · ${this.ix.regions[c.region]}${c.split ? ` · ${c.split} cell` : ''}`
        : ' · outside the study regions');
    this.$('#extrap-warn').hidden = !!c.trained;
    this.onCellChange(c);
    await this.refresh();
  }

  _preset(name) {
    const mg = this.$('#rng-mag'), yr = this.$('#rng-year');
    if (this.mode === 'disturb') {
      if (name === 'clearcut') { mg.value = '-6'; yr.value = '20'; }
      else if (name === 'thin') { mg.value = '-1'; yr.value = '15'; }
      else if (name === 'boost') { mg.value = '1.5'; yr.value = '10'; }
      else { mg.value = '0'; }
      this._syncDisturb();
      return;
    }
    this.schedule.fill(NaN);
    if (name === 'ramp') {
      for (let y = SEED; y < YEARS; y++) this.schedule[y] = 0.2 + 0.6 * ((y - SEED) / (YEARS - SEED));
    } else if (name === 'rotation') {
      for (let y = SEED; y < YEARS; y++) this.schedule[y] = (y - SEED) % 12 === 11 ? -3 : 0.3;
    }
    for (const b of this.bars) this._paintBar(b, this.schedule[Number(b.dataset.year)]);
    this._queue();
  }

  /** The action array for the current mode. */
  _actions() {
    const a = new Float32Array(YEARS).fill(NaN);
    if (this.mode === 'disturb') {
      const y = Number(this.$('#rng-year').value);
      const m = Number(this.$('#rng-mag').value);
      if (Math.abs(m) > 1e-6) a[y] = m;
    } else if (this.mode === 'manage') {
      for (let y = SEED; y < YEARS; y++) {
        if (Number.isFinite(this.schedule[y]) && Math.abs(this.schedule[y]) > 1e-6) {
          a[y] = this.schedule[y];
        }
      }
    }
    return a;
  }

  _queue() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._compute(), 110);
  }

  /** Reload the baselines for the current cell/age, then recompute. */
  async refresh() {
    if (this.cellId == null) return;
    this.root.dataset.state = 'busy';
    const { run } = await this.client.send({ type: 'run', cellId: this.cellId, age: this.age });
    this.free = run;
    this.ed = (await this.client.send({ type: 'truth', cellId: this.cellId, age: this.age })).truth;
    this._syncDisturb?.();
    this._rangeKey = null;              // the reachable range is per cell+age+band
    await this._compute();
    if (this.mode === 'target') { await this._setTargetRange(); this._retarget(); }
  }

  async _compute() {
    if (this.cellId == null || this._busy) return;
    if (this.mode === 'target') return;
    this._busy = true;
    this.root.dataset.state = 'busy';
    const t0 = performance.now();
    try {
      const acts = this._actions();
      const any = acts.some((v) => Number.isFinite(v));
      const { run } = any
        ? await this.client.send({ type: 'run', cellId: this.cellId, age: this.age, actions: acts })
        : { run: null };
      this._draw({ act: run, markYear: this.mode === 'disturb' && any
        ? Number(this.$('#rng-year').value) : NaN });
      this._note(`${Math.round(performance.now() - t0)} ms · ${any ? 'intervention applied' : 'no action'}`);
    } finally {
      this._busy = false;
      this.root.dataset.state = 'ready';
    }
  }

  _draw({ act, envLo, envHi, markYear }) {
    for (let i = 0; i < this.charts.length; i++) {
      const b = this.charts[i].band;
      this.charts[i].update({
        ed: this.ed ? pick(this.ed, b) : null,
        free: this.free ? pick(this.free, b) : null,
        act: act ? pick(act, b) : null,
        envLo: envLo ? pick(envLo, b) : null,
        envHi: envHi ? pick(envHi, b) : null,
        markYear,
      });
    }
  }

  _note(t) { this.$('#compute-note').textContent = t; }

  /* ----------------------------------------------------------- target mode */

  /**
   * Scale the target slider to what this site can actually reach, with a little headroom either
   * side so an impossible target is still reachable by the slider — discovering that a forest
   * cannot get there is part of the point. Measured lazily, only when the tab is opened.
   */
  async _setTargetRange() {
    if (!this.free || this.cellId == null) return;
    const b = Number(this.$('#sel-band').value);
    const key = `${this.cellId}:${this.age}:${b}`;
    if (this._rangeKey === key) return;

    const out = this.$('#out-target');
    const rng = this.$('#rng-target');
    rng.disabled = true;
    out.textContent = 'measuring…';
    const r = await this.client.send({
      type: 'range', cellId: this.cellId, age: this.age, band: b, year: 40, K: 5,
    });
    const pad = (r.hi - r.lo) * 0.15 || Math.abs(r.hi) * 0.1 || 1;
    this._range = { lo: r.lo - pad, hi: r.hi + pad, reach: [r.lo, r.hi], base: r.baseline };
    this._rangeKey = key;
    // Open on an outcome that is both reachable and non-trivial: part-way from the undisturbed
    // result towards the site's ceiling, so the first answer shows a real policy rather than
    // "do nothing".
    const opening = r.baseline + 0.55 * (r.hi - r.baseline);
    const f = (opening - this._range.lo) / (this._range.hi - this._range.lo);
    rng.value = String(Math.round(Math.max(0, Math.min(1, f)) * 100));
    rng.disabled = false;
    this._showTargetValue();
  }

  _targetValue() {
    const g = this._range;
    if (!g) return null;
    return g.lo + (g.hi - g.lo) * (Number(this.$('#rng-target').value) / 100);
  }

  _showTargetValue() {
    const b = Number(this.$('#sel-band').value);
    const t = this._targetValue();
    if (t != null) this.$('#out-target').textContent = `${t.toFixed(2)} ${BANDS[b].unit}`;
  }

  /** Slider moves are cheap; solving is not. Coalesce to the latest request. */
  _queueTarget() {
    this._showTargetValue();
    clearTimeout(this._tTimer);
    this._tTimer = setTimeout(() => this._retarget(), 260);
  }

  async _retarget() {
    if (!this.free || this.cellId == null) return;
    if (this._busy) { this._retargetAgain = true; return; }
    const b = Number(this.$('#sel-band').value);
    const target = this._targetValue();
    if (target == null) { await this._setTargetRange(); return; }

    this._busy = true;
    this.root.dataset.state = 'busy';
    const vd = this.$('#verdict');
    vd.dataset.status = 'working';
    vd.textContent = 'Solving…';
    const t0 = performance.now();
    try {
      const r = await this.client.send({
        type: 'solve', cellId: this.cellId, age: this.age, band: b, year: 40, target, K: 16,
      });
      const unit = BANDS[b].unit;
      const mean = r.actions && r.actions.length
        ? Array.from(r.actions).reduce((s, v) => s + v, 0) / r.actions.length : 0;
      if (r.status === 'solved') {
        const trivial = Math.abs(mean) < 0.005;
        vd.dataset.status = 'ok';
        vd.innerHTML =
          `<p><strong>Reachable.</strong> ${BANDS[b].label} hits ` +
          `<b>${r.achieved.toFixed(2)} ${unit}</b> in 2021.</p>` +
          (trivial
            ? `<p class="policy">No intervention needed — that is roughly where the stand goes on its own.</p>`
            : `<p class="policy">The policy: on average <b>${fmtM(mean)}</b> of height change per year, ` +
              `every year from 1986.</p>`) +
          `<p class="fine">Site can reach ${r.reachable[0].toFixed(2)}–${r.reachable[1].toFixed(2)} ${unit}` +
          `${r.monotone ? '' : '. Note: the response is not ordered here — more growth does not simply mean more of this variable'}.</p>`;
      } else {
        vd.dataset.status = 'no';
        vd.innerHTML =
          `<p><strong>Out of reach.</strong> Through structural growth alone this site can only ` +
          `reach ${r.reachable[0].toFixed(2)}–${r.reachable[1].toFixed(2)} ${unit} by 2021.</p>` +
          `<p class="policy">Closest it can do: <b>${r.achieved.toFixed(2)} ${unit}</b>, at ` +
          `${fmtM(mean)} per year.</p>`;
      }
      this._draw({ act: r.run, markYear: NaN });
      this._note(`${Math.round(performance.now() - t0)} ms · inverse solve`);
    } catch (err) {
      vd.dataset.status = 'no';
      vd.textContent = `Could not solve: ${err.message}`;
    } finally {
      this._busy = false;
      this.root.dataset.state = 'ready';
      if (this._retargetAgain) { this._retargetAgain = false; this._retarget(); }
    }
  }
}
