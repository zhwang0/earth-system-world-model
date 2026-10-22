/**
 * twin-data.js — the digital twin's region: a contiguous block of forest cells.
 *
 * assets/twin/<name>.json describes the block; <name>.bin holds its inputs, gzip-compressed.
 * Inside, one int16 stream is split into a low-byte plane and a high-byte plane. The stream holds
 * the forcing as (feature, cell, year), stored as year-to-year deltas because neighbouring years
 * barely differ, then the 5-year ED seeds as (age, cell, year, band). The packing roughly halves
 * the download; decode() undoes it exactly (_work/scripts/export_twin.py proves the round trip).
 */

const N_FYR = 40;
const N_FEA = 136;
const N_YR = 41;
const N_B = 7;

/** Raw bytes as served. GitHub Pages may already have gunzipped them in transit; check the magic. */
async function gunzip(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return buf;
  const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).arrayBuffer();
}

/**
 * @param {object} meta  the region's JSON
 * @param {ArrayBuffer} packed  the region's .bin, decompressed
 * @returns {{clim: Float32Array[], seed: (age, cell) => Float32Array}}  per-cell forcing (40*136)
 *          and a (41*7) state whose first five years are the ED seed, both in normalized units
 */
export function decode(meta, packed) {
  const u8 = new Uint8Array(packed);
  const n = u8.length >> 1;
  const q = new Int16Array(n);
  for (let i = 0; i < n; i++) q[i] = u8[i] | (u8[n + i] << 8);    // Int16Array wraps to signed

  const nc = meta.n_cells;
  const cs = meta.clim_scale, ss = meta.state_scale;
  const clim = [];
  for (let c = 0; c < nc; c++) clim.push(new Float32Array(N_FYR * N_FEA));
  for (let f = 0; f < N_FEA; f++) {
    for (let c = 0; c < nc; c++) {
      const o = (f * nc + c) * N_FYR, out = clim[c];
      let acc = 0;
      for (let y = 0; y < N_FYR; y++) {
        acc += q[o + y];                                           // undo the year deltas
        out[y * N_FEA + f] = acc * cs;
      }
    }
  }

  const base = N_FEA * nc * N_FYR;
  const L = meta.seed_years;
  const seed = (age, c) => {
    const a = meta.ages.indexOf(Number(age));
    if (a < 0) throw new Error(`no seed for stand age ${age}`);
    const s = new Float32Array(N_YR * N_B);                       // years 5..40 are the model's to fill
    const o = base + (a * nc + c) * L * N_B;
    for (let i = 0; i < L * N_B; i++) s[i] = q[o + i] * ss;
    return s;
  };
  return { clim, seed };
}

/** Fetch and decode a region. `base` is the site root, without a trailing slash. */
export async function loadRegion(base, name) {
  const meta = await (await fetch(`${base}/assets/twin/${name}.json`)).json();
  const packed = await gunzip(await (await fetch(`${base}/assets/twin/${meta.file}`)).arrayBuffer());
  return { meta, ...decode(meta, packed) };
}

export { gunzip };
