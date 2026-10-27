/**
 * why.js — the case for interactivity, made with the model rather than said about it.
 *
 * Two cards share one question. The passive emulator has no input for an action, so asking it
 * changes nothing; the world model takes the action and answers with a forty-year run, computed
 * here when the button is pressed (the time shown is that request's own round trip).
 *
 *   new Why({ root, client, cellId, age, manifest });
 */

import { svgIcon } from './icons.js';

const YEAR0 = 1981;
const YEARS = 41;
const SEED = 5;
const AT = 20;                       // 2001
const W = 400, H = 150;
const PAD = { l: 34, r: 14, t: 12, b: 24 };

const ASKS = [
  { id: 'log', label: 'log it', icon: 'axe', mag: -6 },
  { id: 'fire', label: 'burn it', icon: 'flame', mag: -4 },
  { id: 'replant', label: 'replant it', icon: 'sprout', ramp: 0.35, span: 12 },
];

// the coupled variables quoted under the answer: index into the 7-band state, and a short name
const COUPLED = [[1, 'biomass'], [2, 'soil carbon'], [4, 'GPP']];

const NS = 'http://www.w3.org/2000/svg';
const el = (n, a = {}, parent) => {
  const e = document.createElementNS(NS, n);
  for (const k in a) e.setAttribute(k, a[k]);
  if (parent) parent.appendChild(e);
  return e;
};

export class Why {
  constructor({ root, client, cellId, age = '150', manifest }) {
    Object.assign(this, { root, client, cellId, age });
    this.env = manifest.ages[age].action_envelope;
    this.$ = (s) => root.querySelector(s);
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.cards = {
      passive: this.$('.vs-passive'),
      world: this.$('.vs-world'),
    };
    this.asked = false;
    this._buttons();
    this._load();
  }

  _buttons() {
    const host = this.$('#vs-acts');
    host.textContent = '';
    this.btns = new Map();
    for (const a of ASKS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vs-act';
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `${svgIcon(a.icon)}<span>${a.label}</span>`;
      b.addEventListener('click', () => { this.asked = true; this.ask(a.id, b); });
      host.appendChild(b);
      this.btns.set(a.id, b);
    }
  }

  async _load() {
    try {
      const { run } = await this.client.send({ type: 'run', cellId: this.cellId, age: this.age });
      this.free = run;
      const h = this._band(run, 0);
      const lo = Math.min(...h), hi = Math.max(...h);
      this.dom = [Math.max(0, lo * 0.7), hi * 1.22];
      for (const card of Object.values(this.cards)) this._frame(card.querySelector('.vs-chart'));
      this.root.dataset.state = 'ready';
      this._autoplay();
    } catch (err) {
      this.root.dataset.state = 'failed';
      console.warn('why: model unavailable', err);
    }
  }

  /** Ask once by itself when the cards first come into view, so the contrast is seen. */
  _autoplay() {
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      setTimeout(() => { if (!this.asked) this.ask('log', this.btns.get('log')); }, this.reduced ? 0 : 900);
    }, { threshold: 0.55 });
    io.observe(this.$('.vs-grid'));
  }

  _band(run, k) {
    const out = new Array(YEARS);
    for (let y = 0; y < YEARS; y++) out[y] = run[y * 7 + k];
    return out;
  }

  _x(y) { return PAD.l + ((W - PAD.l - PAD.r) * y) / (YEARS - 1); }
  _y(v) {
    const [lo, hi] = this.dom;
    return PAD.t + (H - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo));
  }
  _path(vals, from = 0) {
    let d = '';
    for (let y = from; y < YEARS; y++) d += `${y === from ? 'M' : 'L'}${this._x(y).toFixed(1)} ${this._y(vals[y]).toFixed(1)}`;
    return d;
  }

  /** Axes, the no-action forecast, and an empty layer for the answer. */
  _frame(svg) {
    svg.textContent = '';
    const [lo, hi] = this.dom;
    const step = hi - lo > 24 ? 10 : 5;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      el('line', { class: 'vs-grid-l', x1: PAD.l, x2: W - PAD.r, y1: this._y(v), y2: this._y(v) }, svg);
      const t = el('text', { class: 'vs-lbl', x: PAD.l - 6, y: this._y(v) + 3.5, 'text-anchor': 'end' }, svg);
      t.textContent = String(v);
    }
    for (const y of [0, AT, 40]) {
      const t = el('text', { class: 'vs-lbl', x: this._x(y), y: H - 6, 'text-anchor': y === 0 ? 'start' : y === 40 ? 'end' : 'middle' }, svg);
      t.textContent = String(YEAR0 + y);
    }
    const u = el('text', { class: 'vs-lbl vs-unit', x: PAD.l, y: PAD.t - 2 }, svg);
    u.textContent = 'canopy height, m';
    el('path', { class: 'vs-free', d: this._path(this._band(this.free, 0)) }, svg);
    el('g', { class: 'vs-ans' }, svg);
  }

  _actions(a) {
    const acts = new Float32Array(YEARS).fill(NaN);
    const clamp = (v) => Math.min(this.env.max, Math.max(this.env.min, v));
    if (a.mag != null) acts[AT] = clamp(a.mag);
    else {
      for (let y = Math.max(AT, SEED); y < Math.min(YEARS, AT + a.span); y++) {
        acts[y] = clamp(this.free[y * 7] - this.free[(y - 1) * 7] + a.ramp);
      }
    }
    return acts;
  }

  async ask(id, btn) {
    if (!this.free || this._busy) return;
    const a = ASKS.find((x) => x.id === id);
    for (const [k, b] of this.btns) {
      b.classList.toggle('is-on', k === id);
      b.setAttribute('aria-pressed', String(k === id));
    }
    this._busy = true;
    this.root.dataset.state = 'asking';
    this._fly(btn);

    // the passive emulator: there is nowhere to put the question
    this._refuse(a);

    // the world model: a real request, timed end to end
    const t0 = performance.now();
    let run;
    try {
      ({ run } = await this.client.send({ type: 'run', cellId: this.cellId, age: this.age, actions: this._actions(a) }));
    } catch (err) {
      this._busy = false;
      this.root.dataset.state = 'ready';
      return;
    }
    const ms = Math.round(performance.now() - t0);
    await this._wait(this.reduced ? 0 : 520);
    this._answer(a, run, ms);
    this._busy = false;
    this.root.dataset.state = 'ready';
  }

  _wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** The action's chip flies from the button to both cards' action input. */
  _fly(btn) {
    if (this.reduced || !btn || !btn.animate) return;
    const from = btn.getBoundingClientRect();
    for (const [kind, card] of Object.entries(this.cards)) {
      const port = card.querySelector('[data-port="a"]');
      const to = port.getBoundingClientRect();
      const chip = document.createElement('span');
      chip.className = 'vs-token';
      chip.innerHTML = btn.querySelector('svg').outerHTML;
      document.body.appendChild(chip);
      const x0 = from.left + from.width / 2 - 14, y0 = from.top + from.height / 2 - 14;
      const x1 = to.left + 16 - 14, y1 = to.top + to.height / 2 - 14;
      const bounce = kind === 'passive';
      const frames = [
        { transform: `translate(${x0}px, ${y0}px) scale(.6)`, opacity: 0 },
        { transform: `translate(${x0}px, ${y0 - 18}px) scale(1)`, opacity: 1, offset: 0.12 },
        { transform: `translate(${x1}px, ${y1}px) scale(1)`, opacity: 1, offset: 0.7 },
      ];
      if (bounce) {
        frames.push({ transform: `translate(${x1 - 10}px, ${y1 - 26}px) rotate(-25deg) scale(.9)`, opacity: 1, offset: 0.82 });
        frames.push({ transform: `translate(${x1 - 18}px, ${y1 + 16}px) rotate(-60deg) scale(.7)`, opacity: 0 });
      } else {
        frames.push({ transform: `translate(${x1}px, ${y1}px) scale(.35)`, opacity: 0 });
      }
      const anim = chip.animate(frames, { duration: 760, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' });
      anim.onfinish = () => chip.remove();
      setTimeout(() => {
        port.classList.remove('is-hit');
        void port.offsetWidth;
        port.classList.add('is-hit');
      }, 530);
    }
  }

  _refuse(a) {
    const card = this.cards.passive;
    const ans = card.querySelector('.vs-ans');
    ans.textContent = '';
    const x = this._x(AT), y = this._y(this.free[AT * 7]);
    el('line', { class: 'vs-ask-l', x1: x, x2: x, y1: PAD.t, y2: H - PAD.b }, ans);
    const g = el('g', { class: 'vs-q', transform: `translate(${x} ${y - 22})` }, ans);
    el('circle', { r: 10 }, g);
    const q = el('text', { y: 4, 'text-anchor': 'middle' }, g);
    q.textContent = '?';
    card.classList.remove('is-refused');
    void card.offsetWidth;
    card.classList.add('is-refused');
    card.querySelector('.vs-say').innerHTML =
      '<b>No input for this.</b> It replays the forcing it was given. Answering means a new simulator run: weeks to months on HPC for a continent.';
  }

  _answer(a, run, ms) {
    const card = this.cards.world;
    const ans = card.querySelector('.vs-ans');
    ans.textContent = '';
    const h = this._band(run, 0);
    const f = this._band(this.free, 0);
    const lo = Math.min(...h), hi = Math.max(...h);
    if (lo < this.dom[0] || hi > this.dom[1]) {
      this.dom = [Math.min(this.dom[0], lo * 0.95), Math.max(this.dom[1], hi * 1.05)];
      for (const c of Object.values(this.cards)) this._frame(c.querySelector('.vs-chart'));
      this._refuse(a);
      return this._answer(a, run, ms);
    }
    const x = this._x(AT);
    el('line', { class: 'vs-ask-l is-on', x1: x, x2: x, y1: PAD.t, y2: H - PAD.b }, ans);
    const p = el('path', { class: 'vs-act-p', d: this._path(h, AT - 1) }, ans);
    const len = p.getTotalLength ? p.getTotalLength() : 400;
    if (!this.reduced && p.animate) {
      p.style.strokeDasharray = `${len}`;
      p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 900, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' });
    }
    const d = h[40] - f[40];
    const g = el('g', { class: 'vs-end', transform: `translate(${this._x(40)} ${this._y(h[40])})` }, ans);
    el('circle', { r: 3.6 }, g);
    const t = el('text', { x: -7, y: d < 0 ? 15 : -8, 'text-anchor': 'end' }, g);
    t.textContent = `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(1)} m`;

    const rel = (k) => {
      const v = run[40 * 7 + k], b = this.free[40 * 7 + k];
      const r = b !== 0 ? ((v - b) / Math.abs(b)) * 100 : 0;
      return `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(1)}%`;
    };
    card.querySelector('.vs-say').innerHTML =
      `<b>Answered in ${ms} ms</b>, in this tab: canopy ${t.textContent} by 2021, and with it ` +
      COUPLED.map(([k, n]) => `${n} <span class="vs-n">${rel(k)}</span>`).join(', ') + '.';
  }
}
