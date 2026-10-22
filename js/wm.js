/**
 * wm.js — the paper's Earth-System World Model, running in the browser.
 *
 * A faithful port of wm4_pretrain.WM4(o6_mode="scalar") and the rollout in
 * train_wm_pretrain._rollout / whatif_rollout.rollout. No ML library: the whole model is
 * matmul, sigmoid, tanh, relu over Float32Array.
 *
 * The port was developed against a numpy reference that matches PyTorch to 7.6e-6 absolute
 * on full 36-step rollouts; assets/cells/golden.json lets the page re-verify that in the
 * browser (see tests.html).
 *
 * Shapes, in the model's normalized (z-scored) space unless stated otherwise:
 *   clim   (B, 40, 136)  annual-mean environmental forcing
 *   state  (B, 41, 7)    ED states, Dec 1981..Dec 2021; only years 0..4 seed the rollout
 *   action (B, 41)       height change into each year, in METRES; NaN = no action that year
 *   output (B, 41, 7)    in ORIGINAL units, bands [height,agb,soil,lai,gpp,npp,rh]
 */

const L = 5;            // context window, years
const N_YR = 41;        // state years 0..40
const N_CLIM = 40;      // forcing years
const N_BAND = 7;
const AGE_SCALE = 500;
const D_CLIM = 128;
const D_HID = 256;
const D_ACT = 256;
const TOK = D_CLIM + N_BAND + 1 + 1 + N_BAND * 3;   // 128 + 7 + 1 + 1 + 21 = 158

/* ---------------------------------------------------------------- kernels */

/**
 * y[b,o] = bias[o] + sum_i x[b,i] * W[o,i].  W is row-major (Out, In), as PyTorch stores it.
 *
 * Used only for the two Out=1 projections, where linear4's four-way tiling has nothing to
 * tile. Everything hot goes through linear4 instead.
 */
function linear(x, B, In, W, bias, y, Out) {
  const tail = In & 3;
  const end = In - tail;
  for (let o = 0; o < Out; o++) {
    const wo = o * In;
    const bo = bias[o];
    for (let b = 0; b < B; b++) {
      const xo = b * In;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let i = 0; i < end; i += 4) {
        s0 += x[xo + i] * W[wo + i];
        s1 += x[xo + i + 1] * W[wo + i + 1];
        s2 += x[xo + i + 2] * W[wo + i + 2];
        s3 += x[xo + i + 3] * W[wo + i + 3];
      }
      let s = s0 + s1 + s2 + s3;
      for (let i = end; i < In; i++) s += x[xo + i] * W[wo + i];
      y[b * Out + o] = s + bo;
    }
  }
  return y;
}

/**
 * The hot kernel. Four output channels are accumulated at once in four locals, so partial sums
 * stay in registers rather than being written back to memory on every input element. Weights
 * keep PyTorch's (Out, In) layout and are read as four sequential streams.
 *
 * Measured on a 36-step rollout: 160 ms with a plain dot product, 105 ms with an AXPY form
 * (which turns out to be memory-bound on the accumulator), 87 ms with this. The GRU's two
 * projections are ~90% of the arithmetic.
 */
function linear4(x, B, In, W, bias, y, Out) {
  const o4 = Out - (Out & 3);
  for (let b = 0; b < B; b++) {
    const xo = b * In, yo = b * Out;
    let o = 0;
    for (; o < o4; o += 4) {
      const w0 = o * In, w1 = w0 + In, w2 = w1 + In, w3 = w2 + In;
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let i = 0; i < In; i++) {
        const xv = x[xo + i];
        a0 += xv * W[w0 + i];
        a1 += xv * W[w1 + i];
        a2 += xv * W[w2 + i];
        a3 += xv * W[w3 + i];
      }
      y[yo + o] = a0 + bias[o];
      y[yo + o + 1] = a1 + bias[o + 1];
      y[yo + o + 2] = a2 + bias[o + 2];
      y[yo + o + 3] = a3 + bias[o + 3];
    }
    for (; o < Out; o++) {
      const wo = o * In;
      let s = 0;
      for (let i = 0; i < In; i++) s += x[xo + i] * W[wo + i];
      y[yo + o] = s + bias[o];
    }
  }
  return y;
}

function reluInPlace(a) {
  for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0;
  return a;
}

const sigmoid = (v) => 1 / (1 + Math.exp(-v));

/* ---------------------------------------------------------------- model */

export class WorldModel {
  /**
   * @param {object} manifest  assets/model/manifest.json
   * @param {string} age       "1" | "150" | "300"
   * @param {ArrayBuffer} buf  the matching wm4_age{age}.bin
   */
  constructor(manifest, age, buf) {
    this.manifest = manifest;
    this.age = String(age);
    const all = new Float32Array(buf);
    const p = {};
    for (const e of manifest.params) {
      p[e.name] = all.subarray(e.offset, e.offset + e.count);
    }
    this.p = p;

    const a = manifest.ages[this.age];
    if (!a) throw new Error(`no weights for stand age ${age}`);
    this.ageVal = a.age_val;
    this.ageMeanN = Float32Array.from(a.age_mean_n);
    this.ageSlopeN = Float32Array.from(a.age_slope_n);
    this.yMean = Float32Array.from(manifest.y_mean);
    this.yStd = Float32Array.from(manifest.y_std);
    this.floors = Float32Array.from(manifest.floors);
    this.hStd = this.yStd[0] + 1e-10;      // metres per unit of normalized height

    this._scratch = new Map();
  }

  static async load(baseUrl, age, manifest) {
    const mf = manifest || await (await fetch(`${baseUrl}/manifest.json`)).json();
    const buf = await (await fetch(`${baseUrl}/${mf.ages[String(age)].file}`)).arrayBuffer();
    return new WorldModel(mf, age, buf);
  }

  /** Reused buffers, keyed by batch size, so a drag does not allocate. */
  _bufs(B) {
    let s = this._scratch.get(B);
    if (!s) {
      s = {
        climA: new Float32Array(B * N_CLIM * D_CLIM),   // clim_enc layer 1, all years at once
        climB: new Float32Array(B * N_CLIM * D_CLIM),   // clim_enc layer 2 -> the embedding
        tok: new Float32Array(B * TOK),
        gi: new Float32Array(B * 3 * D_HID),
        gh: new Float32Array(B * 3 * D_HID),
        hid: new Float32Array(B * D_HID),
        actVec: new Float32Array(B * D_ACT),
        predAct: new Float32Array(B * D_ACT),
        tmpA: new Float32Array(B * D_ACT),
        hd: new Float32Array(B * 64),
        dh: new Float32Array(B),
        decIn: new Float32Array(B * (D_HID + 1)),
        dec1: new Float32Array(B * 64),
        o6: new Float32Array(B * 6),
      };
      this._scratch.set(B, s);
    }
    return s;
  }

  /**
   * clim_enc applied to every forcing year once, up front: the forcing is exogenous, so its
   * embedding never changes during a rollout. Treats (nCell, 40, 136) as nCell*40 rows of 136.
   * Returns (nCell, 40, 128). Cheap enough to call per rollout, but see encodeClim() for reuse.
   */
  encodeClim(clim, nCell = 1) {
    const N = nCell * N_CLIM;
    const a = new Float32Array(N * D_CLIM);
    const b = new Float32Array(N * D_CLIM);
    linear4(clim, N, 136, this.p['clim_enc.0.weight'], this.p['clim_enc.0.bias'], a, D_CLIM);
    reluInPlace(a);
    linear4(a, N, D_CLIM, this.p['clim_enc.2.weight'], this.p['clim_enc.2.bias'], b, D_CLIM);
    reluInPlace(b);
    return b;
  }

  /**
   * 40-year autoregressive rollout.
   * @param {Float32Array} clim    (B*40*136) normalized, or (40*136) to broadcast over the batch
   * @param {Float32Array} state   (B*41*7)  normalized, or (41*7) to broadcast
   * @param {Float32Array|Array} actions (B*41) metres, NaN = none; null for a free run
   * @param {number} B
   * @param {Float32Array} [climEmb] output of encodeClim(), to reuse across calls on one cell
   * @returns {Float32Array} (B*41*7) in original units
   */
  rollout(clim, state, actions, B = 1, climEmb = null) {
    const s = this._bufs(B);
    const P = this.p;

    // One cell, many scenarios (the frontier scan) is the common case: encode its forcing once
    // and let every batch item read the same rows, instead of B identical copies.
    const shared = clim.length === N_CLIM * 136;
    const emb = climEmb || this.encodeClim(clim, shared ? 1 : B);

    let stateB = state;
    if (state.length === N_YR * N_BAND && B > 1) {
      stateB = new Float32Array(B * N_YR * N_BAND);
      for (let b = 0; b < B; b++) stateB.set(state, b * N_YR * N_BAND);
    }

    const st = Float32Array.from(stateB);                    // working state, normalized
    const acts = actions || null;

    const glob = new Float32Array(B * 21);                   // [y0(7), age_mean(7), age_slope(7)]
    for (let b = 0; b < B; b++) {
      const g = b * 21, y0 = b * N_YR * N_BAND;
      for (let k = 0; k < 7; k++) {
        glob[g + k] = st[y0 + k];
        glob[g + 7 + k] = this.ageMeanN[k];
        glob[g + 14 + k] = this.ageSlopeN[k];
      }
    }

    const hasAct = new Uint8Array(B);
    const actN = new Float32Array(B);

    for (let ty = L; ty < N_YR; ty++) {
      for (let b = 0; b < B; b++) {
        const a = acts ? acts[b * N_YR + ty] : NaN;
        const on = acts != null && a === a;                  // a === a is false for NaN
        hasAct[b] = on ? 1 : 0;
        actN[b] = on ? a / this.hStd : 0;
      }

      s.hid.fill(0);                                          // GRU h_0 = 0
      for (let t = 0; t < L; t++) {
        const yr = ty - L + t;
        const isLast = t === L - 1;
        const ageV = (this.ageVal + yr) / AGE_SCALE;

        // ---- assemble the 158-dim token for every item in the batch
        for (let b = 0; b < B; b++) {
          const o = b * TOK;
          const er = (shared ? yr : b * N_CLIM + yr) * D_CLIM;
          s.tok.set(emb.subarray(er, er + D_CLIM), o);
          const sb = (b * N_YR + yr) * N_BAND;
          const masked = isLast && hasAct[b];
          s.tok[o + D_CLIM] = st[sb];                         // height is always kept
          for (let k = 1; k < N_BAND; k++) {
            s.tok[o + D_CLIM + k] = masked ? 0 : st[sb + k];  // masked response learning
          }
          s.tok[o + D_CLIM + 7] = ageV;
          s.tok[o + D_CLIM + 8] = masked ? 1 : 0;             // maskflag / "an action is given here"
          const g = b * 21;
          for (let k = 0; k < 21; k++) s.tok[o + D_CLIM + 9 + k] = glob[g + k];
        }

        // ---- GRU cell (PyTorch gate order r, z, n)
        linear4(s.tok, B, TOK, P['gru.weight_ih_l0'], P['gru.bias_ih_l0'], s.gi, 3 * D_HID);
        linear4(s.hid, B, D_HID, P['gru.weight_hh_l0'], P['gru.bias_hh_l0'], s.gh, 3 * D_HID);
        for (let b = 0; b < B; b++) {
          const go = b * 3 * D_HID, ho = b * D_HID;
          for (let j = 0; j < D_HID; j++) {
            const r = sigmoid(s.gi[go + j] + s.gh[go + j]);
            const z = sigmoid(s.gi[go + D_HID + j] + s.gh[go + D_HID + j]);
            const n = Math.tanh(s.gi[go + 2 * D_HID + j] + r * s.gh[go + 2 * D_HID + j]);
            s.hid[ho + j] = (1 - z) * n + z * s.hid[ho + j];
          }
        }
      }

      // ---- natural-dynamics head vs encoded action, chosen by the hard gate
      linear4(s.hid, B, D_HID, P['act_pred.0.weight'], P['act_pred.0.bias'], s.tmpA, D_ACT);
      reluInPlace(s.tmpA);
      linear4(s.tmpA, B, D_ACT, P['act_pred.2.weight'], P['act_pred.2.bias'], s.predAct, D_ACT);

      const apW = P['act_proj.weight'], apB = P['act_proj.bias'];
      for (let b = 0; b < B; b++) {
        const o = b * D_ACT;
        if (hasAct[b]) {
          const a = actN[b];
          for (let j = 0; j < D_ACT; j++) s.actVec[o + j] = apW[j] * a + apB[j];
        } else {
          for (let j = 0; j < D_ACT; j++) s.actVec[o + j] = s.predAct[o + j];
        }
      }

      // ---- height decoder D_h, residual height
      linear4(s.actVec, B, D_ACT, P['height_dec.0.weight'], P['height_dec.0.bias'], s.hd, 64);
      reluInPlace(s.hd);
      linear(s.hd, B, 64, P['height_dec.2.weight'], P['height_dec.2.bias'], s.dh, 1);

      // ---- other six decoded from [latent, next height]
      for (let b = 0; b < B; b++) {
        const prevH = st[(b * N_YR + ty - 1) * N_BAND];
        const newH = prevH + s.dh[b];
        s.decIn.set(s.hid.subarray(b * D_HID, (b + 1) * D_HID), b * (D_HID + 1));
        s.decIn[b * (D_HID + 1) + D_HID] = newH;
        s.dh[b] = newH;                                        // stash the level
      }
      linear4(s.decIn, B, D_HID + 1, P['dec.0.weight'], P['dec.0.bias'], s.dec1, 64);
      reluInPlace(s.dec1);
      linear4(s.dec1, B, 64, P['dec.2.weight'], P['dec.2.bias'], s.o6, 6);

      // ---- write back, clamped at the physical-zero floor
      for (let b = 0; b < B; b++) {
        const o = (b * N_YR + ty) * N_BAND;
        st[o] = Math.max(s.dh[b], this.floors[0]);
        for (let k = 0; k < 6; k++) {
          st[o + 1 + k] = Math.max(s.o6[b * 6 + k], this.floors[k + 1]);
        }
      }
    }

    // ---- denormalize
    const out = new Float32Array(B * N_YR * N_BAND);
    for (let i = 0, n = out.length; i < n; i++) {
      const k = i % N_BAND;
      out[i] = st[i] * (this.yStd[k] + 1e-10) + this.yMean[k];
    }
    return out;
  }

  /* ------------------------------------------------------- the action map */

  /**
   * D_h: the learned scalar map from an action (metres) to the height increment it produces
   * (metres). Strictly increasing at all three stand ages over at least +/-10 m, which is what
   * makes the inverse below exact.
   */
  dhOfAction(aMetres) {
    const P = this.p, n = aMetres.length;
    const av = new Float32Array(n * D_ACT);
    const apW = P['act_proj.weight'], apB = P['act_proj.bias'];
    for (let i = 0; i < n; i++) {
      const a = aMetres[i] / this.hStd, o = i * D_ACT;
      for (let j = 0; j < D_ACT; j++) av[o + j] = apW[j] * a + apB[j];
    }
    const h = new Float32Array(n * 64);
    linear4(av, n, D_ACT, this.p['height_dec.0.weight'], P['height_dec.0.bias'], h, 64);
    reluInPlace(h);
    const d = new Float32Array(n);
    linear(h, n, 64, P['height_dec.2.weight'], P['height_dec.2.bias'], d, 1);
    for (let i = 0; i < n; i++) d[i] *= this.hStd;
    return d;
  }

  /** Exact inverse of D_h by bisection on the monotone map. Returns actions in metres. */
  invertDh(wantMetres, iters = 40) {
    const n = wantMetres.length;
    let lo = new Float32Array(n).fill(-25), hi = new Float32Array(n).fill(25);
    const mid = new Float32Array(n);
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) mid[i] = 0.5 * (lo[i] + hi[i]);
      const f = this.dhOfAction(mid);
      for (let i = 0; i < n; i++) {
        if (f[i] < wantMetres[i]) lo[i] = mid[i]; else hi[i] = mid[i];
      }
    }
    for (let i = 0; i < n; i++) mid[i] = 0.5 * (lo[i] + hi[i]);
    return mid;
  }
}

export const CONST = { L, N_YR, N_CLIM, N_BAND, AGE_SCALE, TOK, D_HID };
