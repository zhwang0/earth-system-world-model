/**
 * main.js — boot: start the model worker, wire the lab, and light up the globe if WebGL allows.
 *
 * The page is useful without the globe and without WebGL; the globe is an enhancement that
 * loads last and fails quietly.
 */

import { Lab } from './lab.js';
import { createFilm } from './film.js';

const $ = (s) => document.querySelector(s);

/* ------------------------------------------------------------ worker client */

class Client {
  constructor(url) {
    this.w = new Worker(url, { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.w.onmessage = (ev) => {
      const { seq, type } = ev.data;
      const p = this.pending.get(seq);
      if (!p) return;
      if (type === 'error') { this.pending.delete(seq); p.reject(new Error(ev.data.message)); return; }
      this.pending.delete(seq);
      p.resolve(ev.data);
    };
    this.w.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(new Error(e.message || 'worker failed'));
      this.pending.clear();
    };
  }

  send(msg) {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.w.postMessage({ ...msg, seq });
    });
  }
}

/* ------------------------------------------------------------ boot */

const boot = $('#boot-text');
const setBoot = (t, done = false) => {
  if (!boot) return;
  boot.textContent = t;
  $('#boot-note')?.toggleAttribute('data-done', done);
};

async function start() {
  // Absolute, because the worker resolves relative URLs against js/, not the page. Ends without
  // a slash; works unchanged from a GitHub Pages project sub-path.
  const base = new URL('.', document.baseURI).href.replace(/\/$/, '');

  let client, ready;
  try {
    client = new Client(new URL('./worker.js', import.meta.url));
    setBoot('Loading the model…');
    ready = await client.send({ type: 'init', base });
  } catch (err) {
    setBoot('This browser could not start the model. The figures and results below still work.');
    document.querySelector('#lab-root')?.setAttribute('data-state', 'failed');
    console.error(err);
    return;
  }

  const { index, manifest } = ready;
  const nParams = manifest.params.reduce((s, p) => s + p.count, 0);
  setBoot(`${nParams.toLocaleString()} parameters running in this tab · ` +
    `${index.cells.length} forest sites`, true);

  // declared before the Lab: setCell() fires onCellChange during boot, below
  let globe = null;

  const lab = new Lab({
    root: $('#lab-root'),
    client,
    index,
    manifest,
    onCellChange: (c) => globe && globe.select(c.id),
  });

  // Open in the Amazon: region 1 is NW South America, so these are inside the training regions
  // and need no extrapolation caveat. This one's undisturbed rollout also tracks ED closely
  // (29.0 m against 28.7 m at 2021), which is the honest first impression to lead with.
  const AMAZON = { lat: -4, lon: -62 };
  const first = index.cells.find((c) => c.trained && c.split === 'test' && c.region === 1)
    || index.cells.find((c) => c.trained) || index.cells[0];
  await lab.setCell(first.id, true);

  /* --------------------------------------------------- globe (enhancement) */

  try {
    const { createGlobe } = await import('./globe.js');
    globe = await createGlobe({
      canvas: $('#globe-canvas'),
      cells: index.cells,
      onPick: (id) => {
        lab.setCell(id, true);
        $('#lab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    });
    if (globe) {
      globe.flyTo(AMAZON.lat, AMAZON.lon, { ms: 0 });   // frame the basin, then let it drift
      globe.select(first.id);
      window.addEventListener('resize', () => globe.resize(), { passive: true });
    }
  } catch (err) {
    console.warn('globe unavailable:', err);
    document.querySelector('.hero')?.classList.add('no-globe');
  }
}

/* ------------------------------------------------------------ the film */

const YEAR0 = 1981;

async function startFilm() {
  const canvas = $('#film-canvas');
  if (!canvas) return;
  // createFilm draws its first frame while constructing, which calls onYear -> marker(), so the
  // chart's dot has to exist as a binding before then even though it is built afterwards.
  let dot = null;
  const marker = (y) => {
    if (!dot) return;
    dot.setAttribute('cx', X(y));
    dot.setAttribute('cy', Y(film.meanH[y]));
  };
  let X = () => 0, Y = () => 0, film;
  try {
    film = await createFilm({
      canvas,
      onYear: (y, mean) => {
        $('#film-year').textContent = String(YEAR0 + y);
        $('#film-mean').textContent = `${mean.toFixed(1)} m`;
        const scrub = $('#film-scrub');
        if (document.activeElement !== scrub) scrub.value = String(y);
        marker(y);
      },
      onPlayState: (on) => {
        const b = $('#film-play');
        b.textContent = on ? 'Pause' : 'Play';
        b.setAttribute('aria-label', on ? 'Pause the time-lapse' : 'Play the time-lapse');
      },
    });
  } catch (err) {
    console.warn('film unavailable:', err);
    document.querySelector('#film')?.setAttribute('hidden', '');
    return;
  }
  if (!film) return;

  $('#film-cells').textContent = film.cells.toLocaleString();

  // the mean-canopy curve, drawn once; a dot tracks the current year
  const svg = $('#film-chart');
  const NS = 'http://www.w3.org/2000/svg';
  const W = 300, H = 120, ml = 34, mr = 6, mt = 10, mb = 20;
  const hi = Math.max(...film.meanH) * 1.08;
  X = (i) => ml + (W - ml - mr) * (i / (film.years - 1));
  Y = (v) => mt + (H - mt - mb) * (1 - v / hi);
  const el = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };

  for (const t of [0, 10, 20, 30]) {
    const y = Y(t);
    svg.appendChild(el('line', { class: 'gridline', x1: ml, x2: W - mr, y1: y, y2: y }));
    const tx = el('text', { class: 'lbl lbl-y', x: ml - 5, y: y + 3.5, 'text-anchor': 'end' });
    tx.textContent = `${t}`;
    svg.appendChild(tx);
  }
  for (const yr of [0, 20, 40]) {
    // the end labels are anchored inward so they cannot spill out of the viewBox
    const anchor = yr === 0 ? 'start' : yr === 40 ? 'end' : 'middle';
    const tx = el('text', { class: 'lbl lbl-x', x: X(yr), y: H - 5, 'text-anchor': anchor });
    tx.textContent = String(YEAR0 + yr);
    svg.appendChild(tx);
  }
  let d = '';
  for (let i = 0; i < film.years; i++) d += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(film.meanH[i]).toFixed(1)}`;
  svg.appendChild(el('path', { class: 'series free', d }));
  dot = el('circle', { class: 'dot-mark free', r: 3.6, cx: X(0), cy: Y(film.meanH[0]) });
  svg.appendChild(dot);
  marker(film.year);

  $('#film-play').addEventListener('click', () => film.toggle());
  $('#film-scrub').addEventListener('input', (e) => { film.pause(); film.setYear(Number(e.target.value)); });
}

/* ------------------------------------------------------------ page chrome */

function chrome() {
  // sticky nav shadow
  const nav = $('#nav');
  if (nav) {
    const io = new IntersectionObserver(
      ([e]) => nav.classList.toggle('is-stuck', !e.isIntersecting),
      { rootMargin: '-8px 0px 0px 0px', threshold: 1 });
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px';
    document.body.prepend(sentinel);
    io.observe(sentinel);
  }

  // reveal-on-scroll, skipped entirely when the visitor asked for less motion
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -12% 0px' });
    for (const n of document.querySelectorAll('.band .wrap > *, .step, .limits > article')) {
      n.classList.add('rise');
      io.observe(n);
    }
  }

  const copy = $('#btn-copy-bib');
  copy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('.bib code').textContent);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy BibTeX'; }, 1600);
    } catch { copy.textContent = 'Select and copy'; }
  });
}

chrome();
start();
startFilm();
