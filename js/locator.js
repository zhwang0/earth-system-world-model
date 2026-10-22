/**
 * locator.js — a small Earth that turns to face the site being simulated.
 *
 * A 2D canvas, not WebGL: the hero already owns the heavy globe, and at this size an
 * orthographic raster of the 2k Blue Marble costs about a millisecond a frame. The texture is
 * decoded once at half resolution, which is still finer than a pixel here.
 *
 *   const loc = new Locator(canvas, pin);
 *   loc.flyTo(lat, lon);           // turns the short way round; the pin lands when it arrives
 */

const D2R = Math.PI / 180;
const SRC = 'assets/tex/earth-day-2k.webp';

const toVec = (lat, lon) => [
  Math.cos(lat * D2R) * Math.cos(lon * D2R),
  Math.cos(lat * D2R) * Math.sin(lon * D2R),
  Math.sin(lat * D2R),
];
const toLatLon = ([x, y, z]) => [Math.asin(Math.max(-1, Math.min(1, z))) / D2R, Math.atan2(y, x) / D2R];

export class Locator {
  constructor(canvas, pin) {
    this.c = canvas;
    this.pin = pin;
    this.ctx = canvas.getContext('2d');
    this.lat = 10;
    this.lon = -40;
    this.tex = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // fetched only as the lab comes near, so it never competes with the hero's own textures
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      this._load().then(() => this.pin?.classList.add('is-on')).catch(() => { canvas.hidden = true; });
    }, { rootMargin: '400px 0px' });
    io.observe(canvas);
  }

  async _load() {
    const img = new Image();
    img.decoding = 'async';
    img.src = SRC;
    await img.decode();
    const w = 1024, h = 512;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, w, h);
    this.tex = { w, h, px: cx.getImageData(0, 0, w, h).data };
    this._fit();
    this._draw();
  }

  _fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const css = this.c.clientWidth || 72;
    const n = Math.max(16, Math.round(css * dpr));
    if (this.c.width !== n) { this.c.width = n; this.c.height = n; }
    this.img = this.ctx.createImageData(n, n);
  }

  flyTo(lat, lon, ms = 1100) {
    const from = toVec(this.lat, this.lon), to = toVec(lat, lon);
    cancelAnimationFrame(this._raf);
    this.pin?.classList.remove('is-on');
    const dot = Math.max(-1, Math.min(1, from[0] * to[0] + from[1] * to[1] + from[2] * to[2]));
    const om = Math.acos(dot);
    if (!this.tex || this.reduced || om < 1e-4) {
      this.lat = lat; this.lon = lon;
      this._draw();
      if (this.tex) this.pin?.classList.add('is-on');
      return;
    }
    const t0 = performance.now(), so = Math.sin(om);
    const step = (now) => {
      const u = Math.min(1, (now - t0) / ms);
      const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
      const a = Math.sin((1 - e) * om) / so, b = Math.sin(e * om) / so;
      [this.lat, this.lon] = toLatLon([a * from[0] + b * to[0], a * from[1] + b * to[1], a * from[2] + b * to[2]]);
      this._draw();
      if (u < 1) this._raf = requestAnimationFrame(step);
      else { this.lat = lat; this.lon = lon; this.pin?.classList.add('is-on'); }
    };
    this._raf = requestAnimationFrame(step);
  }

  _draw() {
    if (!this.tex) return;
    const n = this.c.width, data = this.img.data;
    const { w, h, px } = this.tex;
    const R = n * 0.43, c = n / 2;
    const p0 = this.lat * D2R, l0 = this.lon * D2R;
    const sp = Math.sin(p0), cp = Math.cos(p0);
    // light from the upper left, a little in front
    const L = [-0.42, 0.5, 0.76];
    for (let j = 0; j < n; j++) {
      const y = (c - j - 0.5) / R;
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 4;
        const x = (i + 0.5 - c) / R;
        const r2 = x * x + y * y;
        if (r2 > 1) { data[o + 3] = 0; continue; }
        const z = Math.sqrt(1 - r2);
        const lat = Math.asin(y * cp + z * sp);
        const lon = l0 + Math.atan2(x, z * cp - y * sp);
        let u = ((lon / (2 * Math.PI) + 0.5) % 1 + 1) % 1;
        const tx = Math.min(w - 1, (u * w) | 0);
        const ty = Math.min(h - 1, Math.max(0, ((0.5 - lat / Math.PI) * h) | 0));
        const t = (ty * w + tx) * 4;
        const d = Math.max(0, x * L[0] + y * L[1] + z * L[2]);
        const k = 0.3 + 0.95 * d;
        // a thin blue limb, as if seen through air
        const rim = Math.max(0, (Math.sqrt(r2) - 0.72) / 0.28) ** 2 * 0.55;
        data[o] = px[t] * k * (1 - rim) + 120 * rim;
        data[o + 1] = px[t + 1] * k * (1 - rim) + 175 * rim;
        data[o + 2] = px[t + 2] * k * (1 - rim) + 255 * rim;
        // soft edge
        data[o + 3] = Math.max(0, Math.min(1, (1 - Math.sqrt(r2)) * R * 1.2)) * 255;
      }
    }
    const ctx = this.ctx;
    ctx.putImageData(this.img, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    const g = ctx.createRadialGradient(c, c, R * 0.92, c, c, R * 1.16);
    g.addColorStop(0, 'rgba(120, 180, 255, .42)');
    g.addColorStop(1, 'rgba(120, 180, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
    ctx.restore();
  }
}
