/**
 * data.js — the cell catalogue and its lazily-fetched binary chunks.
 *
 * Each cell carries 40 years of annual-mean climate forcing (136 features) and 41 years of
 * December ecosystem state at three stand ages, stored int16 in the model's normalized space.
 * A chunk is a plain concatenation of fixed-size cell records, so a cell is a byte-offset slice
 * — no parsing, and the browser only downloads the region you fly to.
 */

const CLIM_LEN = 40 * 136;
const STATE_LEN = 41 * 7;

export class CellStore {
  constructor(index, baseUrl) {
    this.ix = index;
    this.base = baseUrl;
    this.byId = new Map(index.cells.map((c) => [c.id, c]));
    this._chunks = new Map();     // chunk -> Promise<Int16Array>
    this._cells = new Map();      // `${id}` -> {clim, states:[Float32Array x3]}
    this.ageOrder = index.ages;
  }

  static async load(baseUrl = 'assets/cells') {
    const ix = await (await fetch(`${baseUrl}/index.json`)).json();
    return new CellStore(ix, baseUrl);
  }

  _chunk(n) {
    if (!this._chunks.has(n)) {
      const file = this.ix.chunks[n].file;
      this._chunks.set(n, fetch(`${this.base}/${file}`)
        .then((r) => r.arrayBuffer())
        .then((b) => new Int16Array(b)));
    }
    return this._chunks.get(n);
  }

  /** @returns {Promise<{meta, clim: Float32Array, states: Float32Array[]}>} */
  async cell(id) {
    const key = String(id);
    if (this._cells.has(key)) return this._cells.get(key);
    const meta = this.byId.get(id);
    if (!meta) throw new Error(`unknown cell ${id}`);
    const buf = await this._chunk(meta.chunk);

    const base = (meta.slot * this.ix.cell_bytes) / 2;        // int16 elements, not bytes
    const cs = this.ix.clim_scale, ss = this.ix.state_scale;

    const clim = new Float32Array(CLIM_LEN);
    for (let i = 0; i < CLIM_LEN; i++) clim[i] = buf[base + i] * cs;

    const states = [];
    for (let a = 0; a < this.ageOrder.length; a++) {
      const o = base + CLIM_LEN + a * STATE_LEN;
      const s = new Float32Array(STATE_LEN);
      for (let i = 0; i < STATE_LEN; i++) s[i] = buf[o + i] * ss;
      states.push(s);
    }
    const rec = { meta, clim, states };
    this._cells.set(key, rec);
    return rec;
  }

  stateFor(rec, age) {
    const i = this.ageOrder.indexOf(Number(age));
    if (i < 0) throw new Error(`no state for stand age ${age}`);
    return rec.states[i];
  }

  /** Nearest catalogued cell to a lat/lon, for click-on-the-globe picking. */
  nearest(lat, lon) {
    let best = null, bestD = Infinity;
    for (const c of this.ix.cells) {
      const dLat = c.lat - lat;
      let dLon = c.lon - lon;
      if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
      const d = dLat * dLat + dLon * dLon * Math.cos(lat * Math.PI / 180) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return { cell: best, degrees: Math.sqrt(bestD) };
  }
}
