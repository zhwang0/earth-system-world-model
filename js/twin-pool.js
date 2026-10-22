/**
 * twin-pool.js — the digital twin's model workers, side by side.
 *
 * A landscape is hundreds of independent 40-year rollouts, so they are spread over a few module
 * workers (js/twin-worker.js), one CPU core each, leaving one for the page. Each worker carries at
 * most one small batch at a time, so results stream back as they finish and a newer job for a
 * cell can still replace an older one that has not started.
 *
 *   const pool = new Pool({ base, region: 'amazon', age: 150 });
 *   pool.onResult = (cell, v, run) => {...};
 *   await pool.ready;
 *   pool.submit([{ cell: 7, v: 1, actions: null }], { front: true });
 */

const BATCH = 2;

export class Pool {
  constructor({ base, region, age = 150, size }) {
    const cores = navigator.hardwareConcurrency || 4;
    this.size = size || Math.max(1, Math.min(6, cores - 1));
    this.queue = [];
    this.onResult = null;
    this.onIdle = null;
    this.workers = [];
    const inits = [];
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(new URL('./twin-worker.js', import.meta.url), { type: 'module' });
      const slot = { w, busy: 0 };
      this.workers.push(slot);
      inits.push(new Promise((resolve, reject) => {
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'ready') { this._listen(slot); resolve(); }
          else if (m.type === 'error') reject(new Error(m.message));
        };
        w.onerror = (e) => reject(new Error(e.message || 'twin worker failed to start'));
      }));
      w.postMessage({ type: 'init', base, region, age });
    }
    this.ready = Promise.all(inits);
  }

  _listen(slot) {
    slot.w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'result') {
        if (this.onResult) this.onResult(m.cell, m.v, m.run);
      } else if (m.type === 'done' || m.type === 'error') {
        if (m.type === 'error') console.error('twin worker:', m.message);
        slot.busy = 0;
        this._pump();
      }
    };
  }

  /**
   * Jobs are {cell, v, actions}. A newer job replaces a waiting one for the same cell and the same
   * question: a cell's undisturbed run (actions null) and its scenario are different questions,
   * and one must never evict the other.
   */
  submit(jobs, { front = false } = {}) {
    const key = (j) => `${j.cell}:${j.actions ? 'act' : 'free'}`;
    const keys = new Set(jobs.map(key));
    this.queue = this.queue.filter((j) => !keys.has(key(j)));
    this.queue = front ? [...jobs, ...this.queue] : [...this.queue, ...jobs];
    this._pump();
  }

  /** Jobs not yet finished: waiting plus in flight. */
  get pending() {
    return this.queue.length + this.workers.reduce((s, x) => s + x.busy, 0);
  }

  _pump() {
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) continue;
      const jobs = this.queue.splice(0, BATCH);
      slot.busy = jobs.length;
      slot.w.postMessage({ type: 'run', jobs });
    }
    if (!this.pending && this.onIdle) this.onIdle();
  }

  terminate() {
    for (const { w } of this.workers) w.terminate();
    this.workers = [];
  }
}
