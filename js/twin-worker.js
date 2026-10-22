/**
 * twin-worker.js — one of the digital twin's model workers.
 *
 * The twin runs a few of these side by side (js/twin-pool.js), because a landscape is hundreds of
 * independent 40-year rollouts. Each worker loads the weights and the region itself; after the
 * first, both come from the HTTP cache.
 *
 *   init {base, region, age}           -> {type:'ready'}
 *   run  {jobs:[{cell, v, actions}]}   -> one {type:'result', cell, v, run} per job, then {type:'done'}
 *
 * `actions` is a (41) array of height changes in metres (NaN = none) or null for no action; `v` is
 * the caller's version stamp, echoed back so superseded answers can be dropped.
 */

import { WorldModel } from './wm.js';
import { loadRegion } from './twin-data.js';

let model = null;
let region = null;
let age = '150';
const embs = new Map();            // cell -> encoded forcing, reused across that cell's scenarios

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      age = String(msg.age || 150);
      const manifest = await (await fetch(`${msg.base}/assets/model/manifest.json`)).json();
      [model, region] = await Promise.all([
        WorldModel.load(`${msg.base}/assets/model`, age, manifest),
        loadRegion(msg.base, msg.region),
      ]);
      self.postMessage({ type: 'ready', seq: msg.seq });
      return;
    }
    if (msg.type === 'run') {
      for (const j of msg.jobs) {
        if (!embs.has(j.cell)) embs.set(j.cell, model.encodeClim(region.clim[j.cell], 1));
        const acts = j.actions ? Float32Array.from(j.actions) : null;
        const run = model.rollout(region.clim[j.cell], region.seed(age, j.cell), acts, 1, embs.get(j.cell));
        self.postMessage({ type: 'result', cell: j.cell, v: j.v, run }, [run.buffer]);
      }
      self.postMessage({ type: 'done', seq: msg.seq });
      return;
    }
    throw new Error(`unknown message ${msg.type}`);
  } catch (err) {
    self.postMessage({ type: 'error', seq: msg.seq, message: String((err && err.message) || err) });
  }
};
