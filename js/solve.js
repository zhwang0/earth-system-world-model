/**
 * solve.js — inverse problems on the world model: "what would I have to do to get that?"
 *
 * Three honest operations, in rising order of what they assume:
 *
 *   actionsForHeightPath()  EXACT. D_h is a strictly increasing scalar map at all three stand
 *                           ages, so the action that produces a wanted height increment is found
 *                           by bisection with no search over rollouts. Verified: asking for
 *                           40.00 m at year 40 lands on 40.0000 m.
 *
 *   frontier()              The reachable envelope. One batched rollout over K growth offsets
 *                           gives every outcome this stand can reach and the policy behind each.
 *                           24 scenarios cost about 3.6x a single rollout.
 *
 *   solveForTarget()        Reads a target off the frontier, then refines locally. It reports
 *                           OUT_OF_REACH rather than inventing an answer, and it does not assume
 *                           the response is increasing: at some cells faster growth LOWERS
 *                           biomass (ED's own behaviour where fire thins a stand but spares the
 *                           tallest trees), and a naive bisection would silently return nonsense.
 *
 * Actions are in metres of canopy-height change per year. Everything here is a question about a
 * learned emulator, not a forestry prescription.
 */

import { CONST } from './wm.js';

const { L, N_YR, N_BAND } = CONST;

/** Rollout with no action: the model grows the stand itself. */
export function freeRun(model, clim, state, climEmb = null) {
  return model.rollout(clim, state, null, 1, climEmb);
}

/** The model's own yearly height increments over years 5..40, in metres (length 36). */
export function naturalIncrements(run) {
  const n = N_YR - L;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ty = L + i;
    out[i] = run[ty * N_BAND] - run[(ty - 1) * N_BAND];
  }
  return out;
}

/**
 * Exact: the per-year actions that make canopy height follow `targetPath`.
 * @param {Float32Array} targetPath heights in metres for years 4..40 (length 37); index 0 is the
 *        year-4 seed and is not editable.
 * @returns {Float32Array} actions for years 5..40 (length 36), metres
 */
export function actionsForHeightPath(model, targetPath) {
  const n = targetPath.length - 1;
  const want = new Float32Array(n);
  for (let i = 0; i < n; i++) want[i] = targetPath[i + 1] - targetPath[i];
  return model.invertDh(want);
}

/** Where an action sits relative to what ED itself produced. Drives the UI's warning state. */
export function actionZone(aMetres, env) {
  const a = Math.abs(aMetres) < 1e-12 ? 0 : aMetres;
  if (a >= env.p1 && a <= env.p99) return 'typical';
  if (a >= env.min && a <= env.max) return 'rare';
  return 'extrapolation';
}

/**
 * The largest uniform growth offset (m/yr beyond natural growth) that keeps the canopy at or below
 * hMax in every year. Exact, not searched: actions start in year L, and with inverted actions the
 * height path is h(y) = free(y) + d * (y - L + 1), so the binding year gives d directly.
 */
export function capOffset(free, hMax) {
  if (!(hMax < Infinity)) return Infinity;
  let d = Infinity;
  for (let y = L; y < N_YR; y++) d = Math.min(d, (hMax - free[y * N_BAND]) / (y - L + 1));
  return Math.max(0, d);
}

/**
 * Hold a rollout under a canopy ceiling. Years before the canopy would first pass hMax keep their
 * own actions, so the run is unchanged up to there; from then on each year asks for the run's own
 * increment, cut to what stays under hMax, so the canopy levels off at the ceiling. Exact, through
 * D_h's inverse. Returns the original run when it never reaches hMax.
 */
export function capHeights(model, clim, state, actions, run, hMax, climEmb = null) {
  let first = -1;
  for (let y = L; y < N_YR; y++) if (run[y * N_BAND] > hMax) { first = y; break; }
  if (first < 0) return { run, actions, capped: false };
  const out = actions ? Float32Array.from(actions) : new Float32Array(N_YR).fill(NaN);
  const n = N_YR - first;
  const want = new Float32Array(n);
  let h = run[(first - 1) * N_BAND];
  for (let i = 0; i < n; i++) {
    const y = first + i;
    const inc = run[y * N_BAND] - run[(y - 1) * N_BAND];
    want[i] = Math.min(inc, hMax - h);
    h += want[i];
  }
  out.set(model.invertDh(want), first);
  return { run: model.rollout(clim, state, out, 1, climEmb), actions: out, capped: true };
}

/** Build a (41) action array for years 5..40 from 36 increments; years 0..4 stay NaN (the seed). */
function pad(acts36) {
  const a = new Float32Array(N_YR).fill(NaN);
  a.set(acts36, L);
  return a;
}

/**
 * The reachable envelope: scan K uniform growth offsets in one batched rollout.
 * @param {object} opts.env  the stand age's action envelope from the model manifest
 * @param {number} opts.K    number of scenarios over the full range (24 is a good default)
 * @param {boolean} opts.clamp keep every action inside [env.min, env.max] (default true)
 * @param {number[]} [opts.only] [from, to) — evaluate only this slice of the K scenarios, while
 *        still spacing the offsets over the full range. Lets a worker stream the scan in pieces
 *        so the chart fills in instead of freezing until all K are done.
 * @returns {{deltas, actions, runs, B}} runs is (B*41*7) in original units
 */
export function frontier(model, clim, state, nat, {
  env, K = 24, clamp = true, climEmb = null, only = null, dCap = Infinity,
} = {}) {
  let natMax = -Infinity, natMin = Infinity;
  for (let i = 0; i < nat.length; i++) {
    if (nat[i] > natMax) natMax = nat[i];
    if (nat[i] < natMin) natMin = nat[i];
  }
  // Offsets wide enough that the extremes saturate the envelope in every year once clamped:
  // at dMin every year sits at env.min, at dMax every year sits at env.max. That makes the scan
  // span the full range this stand can reach without ever leaving what the model was trained on.
  const n = nat.length;
  const dMin = env.min - natMax;
  // dCap (capOffset) stops the scan where the canopy would pass its ceiling
  const dMax = Math.max(dMin, Math.min(env.max - natMin, dCap));

  const from = only ? only[0] : 0;
  const to = only ? Math.min(only[1], K) : K;
  const B = to - from;

  const deltas = new Float32Array(B);
  const want = new Float32Array(B * n);
  for (let j = 0; j < B; j++) {
    const k = from + j;
    const d = K === 1 ? 0 : dMin + (dMax - dMin) * (k / (K - 1));
    deltas[j] = d;
    for (let i = 0; i < n; i++) want[j * n + i] = nat[i] + d;
  }
  const inv = model.invertDh(want);                    // one batched inversion, not B of them

  const actions = new Float32Array(B * N_YR).fill(NaN);
  const perScenario = [];
  for (let j = 0; j < B; j++) {
    const a = inv.slice(j * n, (j + 1) * n);
    if (clamp) for (let i = 0; i < n; i++) a[i] = Math.min(env.max, Math.max(env.min, a[i]));
    perScenario.push(a);
    actions.set(a, j * N_YR + L);
  }
  const runs = model.rollout(clim, state, actions, B, climEmb);
  return { deltas, actions: perScenario, runs, B };
}

/** Pull one scenario's series for one band out of a batched rollout. */
export function series(runs, b, band) {
  const out = new Float32Array(N_YR);
  for (let y = 0; y < N_YR; y++) out[y] = runs[(b * N_YR + y) * N_BAND + band];
  return out;
}

/**
 * Find the growth policy that lands a chosen band on `target` at `year`.
 *
 * Returns { status, delta, actions, run, reachable:[lo,hi], monotone, achieved }.
 * status is 'solved' | 'out_of_reach'. When the target is outside the reachable range the
 * closest achievable policy is returned instead, so the page can say so honestly and still show
 * the best this stand can do.
 */
export function solveForTarget(model, clim, state, nat, {
  band = 1, year = N_YR - 1, target, env, K = 24, refine = 12, climEmb = null, dCap = Infinity,
} = {}) {
  const f = frontier(model, clim, state, nat, { env, K, climEmb, dCap });
  const vals = new Float32Array(K);
  for (let k = 0; k < K; k++) vals[k] = f.runs[(k * N_YR + year) * N_BAND + band];

  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < K; k++) { lo = Math.min(lo, vals[k]); hi = Math.max(hi, vals[k]); }

  // is the response ordered in the offset at all? (it is not, at some cells)
  let up = 0, down = 0;
  for (let k = 1; k < K; k++) { if (vals[k] > vals[k - 1]) up++; else if (vals[k] < vals[k - 1]) down++; }
  const monotone = up === 0 || down === 0;

  const inRange = target >= lo && target <= hi;

  // nearest scenario on the scanned frontier
  let best = 0, bestErr = Infinity;
  for (let k = 0; k < K; k++) {
    const e = Math.abs(vals[k] - target);
    if (e < bestErr) { bestErr = e; best = k; }
  }

  const finish = (status, delta, actions, run, achieved) => ({
    status, delta, actions, run, achieved, reachable: [lo, hi], monotone, frontier: f, values: vals,
  });

  if (!inRange) {
    return finish('out_of_reach', f.deltas[best], f.actions[best],
      sliceRun(f.runs, best), vals[best]);
  }

  // refine between the two frontier points that bracket the target, by bisection on the offset.
  // Local bracketing (rather than global) is what keeps this correct when the response is not
  // ordered over the whole range.
  let a = best, b = best;
  for (let k = 0; k < K - 1; k++) {
    if ((vals[k] - target) * (vals[k + 1] - target) <= 0) { a = k; b = k + 1; break; }
  }
  let dA = f.deltas[a], dB = f.deltas[b], vA = vals[a];
  let dMid = 0.5 * (dA + dB), run = null, achieved = vals[best];
  for (let it = 0; it < refine; it++) {
    dMid = 0.5 * (dA + dB);
    const want = new Float32Array(nat.length);
    for (let i = 0; i < nat.length; i++) want[i] = nat[i] + dMid;
    const act = Float32Array.from(model.invertDh(want),
      (v) => Math.min(env.max, Math.max(env.min, v)));
    run = model.rollout(clim, state, pad(act), 1, climEmb);
    achieved = run[year * N_BAND + band];
    if ((achieved - target) * (vA - target) > 0) { dA = dMid; vA = achieved; } else { dB = dMid; }
  }
  const want = new Float32Array(nat.length);
  for (let i = 0; i < nat.length; i++) want[i] = nat[i] + dMid;
  const actions = Float32Array.from(model.invertDh(want),
    (v) => Math.min(env.max, Math.max(env.min, v)));
  run = model.rollout(clim, state, pad(actions), 1, climEmb);
  achieved = run[year * N_BAND + band];
  return finish('solved', dMid, actions, run, achieved);
}

function sliceRun(runs, b) {
  return runs.slice(b * N_YR * N_BAND, (b + 1) * N_YR * N_BAND);
}

export { pad as padActions };
