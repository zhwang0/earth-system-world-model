/**
 * worker.js — the world model, off the main thread.
 *
 * A 40-year rollout is ~60 million multiply-adds and takes on the order of 90 ms, so running it
 * on the UI thread would drop frames on every slider move. The worker owns the weights and the
 * cell cache and answers four messages:
 *
 *   init     {base}                          load the manifest and the cell catalogue
 *   run      {cellId, age, actions}          one rollout            -> {run}
 *   frontier {cellId, age, K}                the reachable envelope -> streams {k, series} then {done}
 *   solve    {cellId, age, band, year, target}  inverse problem     -> {status, delta, actions, run}
 *
 * Every reply carries the request's `seq` so a stale answer from an abandoned drag can be
 * dropped by the caller.
 */

import { WorldModel } from './wm.js';
import { CellStore } from './data.js';
import {
  freeRun, naturalIncrements, frontier, solveForTarget, actionsForHeightPath, padActions,
} from './solve.js';

let base = '.';
let manifest = null;
let store = null;
const models = new Map();          // age -> WorldModel
const embs = new Map();            // `${cellId}` -> clim embedding per age

async function model(age) {
  const a = String(age);
  if (!models.has(a)) {
    models.set(a, await WorldModel.load(`${base}/assets/model`, a, manifest));
  }
  return models.get(a);
}

async function ctx(cellId, age) {
  const m = await model(age);
  const rec = await store.cell(cellId);
  const state = store.stateFor(rec, age);
  const key = `${cellId}:${age}`;
  if (!embs.has(key)) embs.set(key, m.encodeClim(rec.clim, 1));
  return { m, rec, state, emb: embs.get(key), env: manifest.ages[String(age)].action_envelope };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  const { seq, type } = msg;
  try {
    if (type === 'init') {
      base = msg.base || '.';
      manifest = await (await fetch(`${base}/assets/model/manifest.json`)).json();
      store = await CellStore.load(`${base}/assets/cells`);
      self.postMessage({ seq, type: 'ready', index: store.ix, manifest });
      return;
    }

    if (type === 'truth') {
      // the ED simulation itself, denormalized -- the line the model is judged against
      const { m, state } = await ctx(msg.cellId, msg.age);
      const truth = new Float32Array(state.length);
      for (let i = 0; i < state.length; i++) {
        const k = i % 7;
        truth[i] = state[i] * (m.yStd[k] + 1e-10) + m.yMean[k];
      }
      self.postMessage({ seq, type: 'truth', truth }, [truth.buffer]);
      return;
    }

    if (type === 'run') {
      const { m, rec, state, emb } = await ctx(msg.cellId, msg.age);
      const acts = msg.actions ? Float32Array.from(msg.actions) : null;
      const run = m.rollout(rec.clim, state, acts, 1, emb);
      self.postMessage({ seq, type: 'run', run }, [run.buffer]);
      return;
    }

    if (type === 'frontier') {
      const { m, rec, state, emb, env } = await ctx(msg.cellId, msg.age);
      const free = freeRun(m, rec.clim, state, emb);
      const nat = naturalIncrements(free);
      const K = msg.K || 16;
      // stream the scan a few scenarios at a time so the chart fills in rather than hanging
      const step = 4;
      const all = [];
      for (let k0 = 0; k0 < K; k0 += step) {
        const n = Math.min(step, K - k0);
        const sub = frontier(m, rec.clim, state, nat, { env, K, climEmb: emb, only: [k0, k0 + n] });
        all.push(sub);
        self.postMessage({ seq, type: 'frontier-part', from: k0, deltas: sub.deltas,
          runs: sub.runs }, [sub.runs.buffer]);
      }
      self.postMessage({ seq, type: 'frontier-done', free }, [free.buffer]);
      return;
    }

    if (type === 'range') {
      // What can this site reach at all? A coarse scan, used to scale the target slider so the
      // visitor is choosing among outcomes that mostly exist, with a little headroom beyond.
      const { m, rec, state, emb, env } = await ctx(msg.cellId, msg.age);
      const free = freeRun(m, rec.clim, state, emb);
      const nat = naturalIncrements(free);
      const f = frontier(m, rec.clim, state, nat, { env, K: msg.K || 5, climEmb: emb });
      const band = msg.band ?? 1, year = msg.year ?? 40;
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < f.B; k++) {
        const v = f.runs[(k * 41 + year) * 7 + band];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      self.postMessage({ seq, type: 'range', lo, hi, baseline: free[year * 7 + band] });
      return;
    }

    if (type === 'solve') {
      const { m, rec, state, emb, env } = await ctx(msg.cellId, msg.age);
      const free = freeRun(m, rec.clim, state, emb);
      const nat = naturalIncrements(free);
      const r = solveForTarget(m, rec.clim, state, nat, {
        band: msg.band ?? 1, year: msg.year ?? 40, target: msg.target, env,
        K: msg.K || 16, climEmb: emb,
      });
      self.postMessage({
        seq, type: 'solve', status: r.status, delta: r.delta, achieved: r.achieved,
        reachable: r.reachable, monotone: r.monotone,
        actions: r.actions, run: r.run, free,
      });
      return;
    }

    if (type === 'height-path') {
      const { m, rec, state, emb } = await ctx(msg.cellId, msg.age);
      const acts = actionsForHeightPath(m, Float32Array.from(msg.path));
      const run = m.rollout(rec.clim, state, padActions(acts), 1, emb);
      self.postMessage({ seq, type: 'height-path', actions: acts, run });
      return;
    }

    throw new Error(`unknown message ${type}`);
  } catch (err) {
    self.postMessage({ seq, type: 'error', message: String(err && err.message || err) });
  }
};
