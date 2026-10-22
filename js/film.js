/**
 * film.js — "Forty years over the Amazon": a time-lapse of the simulation the model learns from.
 *
 * Every frame is CarbonGlobe's ED run for a young stand (starting age 1 yr), read straight out of
 * the canopy-height atlas: 41 annual grids at 0.5 deg, 1981-2021. Nothing here is model output and
 * nothing is invented — the lab further down the page is where the model takes over.
 *
 * The atlas ships as one PNG with the 41 years packed as tiles, so this crops the Amazon window
 * out of each tile at decode time: 41 bitmaps of ~71x47 cells, about half a megabyte in total,
 * rather than holding the whole 5040x2160 sheet in memory.
 *
 * Drawn on a 2D canvas, so it runs with no WebGL and costs the hero's globe nothing.
 */

// Amazon basin window, in degrees.
const WIN = { lat0: -16, lat1: 7, lon0: -79, lon1: -44 };

// Same ramp as the globe's canopy layer, so the two readily read as one dataset.
const RAMP = [[0x04, 0x20, 0x1b], [0x0a, 0x47, 0x33], [0x1a, 0x85, 0x59],
  [0x56, 0xc0, 0x77], [0xda, 0xf5, 0x9d]];

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function rampAt(t) {
  const u = clamp(t, 0, 1) * (RAMP.length - 1);
  const i = Math.min(Math.floor(u), RAMP.length - 2);
  const f = u - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export async function createFilm(opts = {}) {
  const canvas = opts.canvas;
  if (!canvas || !canvas.getContext) return null;

  const meta = await (await fetch('assets/grid/grid.json')).json();
  const W = meta.width, H = meta.height, cols = meta.cols, years = meta.years;
  const vmax = (meta.vars.height && meta.vars.height.vmax) || meta.vmax.height;
  const gamma = meta.gamma;
  const file = (meta.vars.height.files && meta.vars.height.files['1']) || 'height_a1.png';

  // the crop, in grid cells
  const c0 = Math.round((WIN.lon0 + 179.75) / 0.5);
  const c1 = Math.round((WIN.lon1 + 179.75) / 0.5);
  const r0 = Math.round((89.75 - WIN.lat1) / 0.5);
  const r1 = Math.round((89.75 - WIN.lat0) / 0.5);
  const cw = c1 - c0 + 1, ch = r1 - r0 + 1;

  const blob = await (await fetch(`assets/grid/${file}`)).blob();

  const small = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const opt = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };

  const frames = [];          // ImageData per year, already coloured
  const meanH = new Float32Array(years);
  let coverage = 0;

  for (let y = 0; y < years; y++) {
    const sx = (y % cols) * W + c0;
    const sy = Math.floor(y / cols) * H + r0;
    let bmp;
    try {
      bmp = await createImageBitmap(blob, sx, sy, cw, ch, opt);
      sctx.clearRect(0, 0, cw, ch);
      sctx.drawImage(bmp, 0, 0);
    } catch (e) {
      bmp = await createImageBitmap(blob, opt);
      sctx.clearRect(0, 0, cw, ch);
      sctx.drawImage(bmp, sx, sy, cw, ch, 0, 0, cw, ch);
    }
    if (bmp.close) bmp.close();

    const px = sctx.getImageData(0, 0, cw, ch);
    const d = px.data;
    let sum = 0, n = 0;
    for (let i = 0, N = cw * ch; i < N; i++) {
      const byte = d[i * 4];
      if (!byte) { d[i * 4 + 3] = 0; continue; }          // no data -> transparent
      const h = vmax * Math.pow((byte - 1) / 254, 1 / gamma);
      const [r, g, b] = rampAt(0.06 + 0.94 * (h / vmax));
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
      sum += h; n++;
    }
    frames.push(px);
    meanH[y] = n ? sum / n : 0;
    if (y === years - 1) coverage = n;
  }

  // a second small canvas holds one decoded frame for scaling up
  const src = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  const srcCtx = src.getContext('2d');

  const ctx = canvas.getContext('2d');
  let year = 0, raf = 0, playing = false, last = 0, dpr = 1;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const onYear = opts.onYear || (() => {});

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round((r.width * ch / cw) * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    draw();
  }

  function draw() {
    srcCtx.putImageData(frames[year], 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, cw, ch, 0, 0, canvas.width, canvas.height);
    onYear(year, meanH[year]);
  }

  function setYear(y) {
    const v = clamp(Math.round(y), 0, years - 1);
    if (v === year) { onYear(year, meanH[year]); return; }
    year = v;
    draw();
  }

  function tick(t) {
    if (!playing) return;
    if (!last) last = t;
    // ~3.2 years a second, then hold on the last frame before looping
    if (t - last > 310) {
      last = t;
      if (year >= years - 1) { year = 0; } else { year += 1; }
      draw();
    }
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (playing || reduced) return;
    playing = true; last = 0;
    raf = requestAnimationFrame(tick);
    opts.onPlayState && opts.onPlayState(true);
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
    opts.onPlayState && opts.onPlayState(false);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  if (reduced) setYear(years - 1);          // a still, at full canopy

  // only run while on screen
  const io = new IntersectionObserver(([e]) => {
    if (e.isIntersecting) { if (!reduced) play(); } else pause();
  }, { threshold: 0.25 });
  io.observe(canvas);

  const onVis = () => { if (document.hidden) pause(); };
  document.addEventListener('visibilitychange', onVis);

  return {
    years, meanH, cells: coverage, reduced,
    get year() { return year; },
    get playing() { return playing; },
    setYear, play, pause,
    toggle() { playing ? pause() : play(); },
    dispose() {
      pause(); ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
