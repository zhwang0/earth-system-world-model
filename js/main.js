/**
 * main.js — boot: start the model worker, wire the lab, light up the globe if WebGL allows.
 * The page is useful without the globe; it loads last and fails quietly.
 */

import { Lab } from './lab.js';

const $ = (s) => document.querySelector(s);

class Client {
  constructor(url) {
    this.w = new Worker(url, { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.w.onmessage = (ev) => {
      const { seq, type } = ev.data;
      const p = this.pending.get(seq);
      if (!p) return;
      this.pending.delete(seq);
      if (type === 'error') p.reject(new Error(ev.data.message));
      else p.resolve(ev.data);
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

const setBoot = (t, done = false) => {
  const b = $('#boot-text');
  if (!b) return;
  b.textContent = t;
  $('#boot-note')?.toggleAttribute('data-done', done);
};

async function start() {
  // Absolute, because the worker resolves relative URLs against js/, not the page. Ends without
  // a slash; works unchanged from a GitHub Pages project sub-path.
  const base = new URL('.', document.baseURI).href.replace(/\/$/, '');

  let client, ready;
  try {
    client = new Client(new URL('./worker.js', import.meta.url));
    ready = await client.send({ type: 'init', base });
  } catch (err) {
    setBoot('This browser could not start the model. The results below still work.');
    $('#lab-root')?.setAttribute('data-state', 'failed');
    console.error(err);
    return;
  }

  const { index, manifest } = ready;
  const n = manifest.params.reduce((s, p) => s + p.count, 0);
  setBoot(`${n.toLocaleString()} parameters running in this tab`, true);

  let globe = null;
  const lab = new Lab({
    root: $('#lab-root'), client, index, manifest,
    // the hero's Earth follows the lab, so scrolling back up finds the site you were editing
    onCellChange: (c) => {
      if (!globe) return;
      globe.select(c.id);
      globe.flyTo(c.lat, c.lon, { ms: 1400 });
    },
  });

  // Open in the Amazon: region 1 is NW South America, inside the training regions, and this
  // cell's undisturbed rollout tracks ED closely (29.0 m against 28.7 m at 2021).
  const AMAZON = { lat: -4, lon: -62 };
  const first = index.cells.find((c) => c.trained && c.split === 'test' && c.region === 1)
    || index.cells.find((c) => c.trained) || index.cells[0];
  await lab.setCell(first.id, true);
  lab.start();

  // The case for interactivity asks the same model, at the same Amazon cell, as it scrolls near.
  const whyRoot = $('#vs');
  if (whyRoot) {
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const { Why } = await import('./why.js');
      new Why({ root: whyRoot, client, cellId: first.id, age: '150', manifest });
    }, { rootMargin: '500px 0px' });
    io.observe(whyRoot);
  }

  // The landscape loads as it comes near: its own workers, the weights again (from cache) and
  // 1.4 MB of forcing. Nobody who stops at the first demo pays for it.
  const twinRoot = $('#twin-root');
  if (twinRoot) {
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const { createTwin } = await import('./twin.js');
      createTwin({ root: twinRoot, base, manifest });
    }, { rootMargin: '900px 0px' });
    io.observe(twinRoot);
  }

  try {
    const { createGlobe } = await import('./globe.js');
    globe = await createGlobe({
      canvas: $('#globe-canvas'),
      cells: index.cells,
      onPick: (id) => {
        lab.setCell(id, true);
        $('#try')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    });
    if (globe) {
      globe.flyTo(AMAZON.lat, AMAZON.lon, { ms: 0 });
      globe.select(first.id);
      window.addEventListener('resize', () => globe.resize(), { passive: true });
    }
  } catch (err) {
    console.warn('globe unavailable:', err);
    document.querySelector('.hero')?.classList.add('no-globe');
  }
}

function chrome() {
  const nav = $('#nav');
  if (nav) {
    const io = new IntersectionObserver(([e]) => nav.classList.toggle('is-stuck', !e.isIntersecting),
      { rootMargin: '-8px 0px 0px 0px', threshold: 1 });
    const s = document.createElement('div');
    s.style.cssText = 'position:absolute;top:0;height:1px;width:1px';
    document.body.prepend(s);
    io.observe(s);
  }

  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -10% 0px' });
    for (const n of document.querySelectorAll('.sec .wrap > *')) {
      n.classList.add('rise');
      io.observe(n);
    }
  }

  const copy = $('#btn-copy-bib');
  copy?.addEventListener('click', async () => {
    const pre = $('#bib');
    try {
      await navigator.clipboard.writeText(pre.textContent.trim());
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
    } catch {
      copy.textContent = 'Select it below';   // no clipboard permission: the text is on the page
    }
  });
}

chrome();
start();
