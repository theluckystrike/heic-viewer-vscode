'use strict';
// Runs HEIC decodes in one worker thread (src/core/heic-worker.js). Jobs run one at a time in order. The worker is
// ended after `idleMs` without work, so the WASM memory of a big photo is given back. decodeHeic() never throws: it
// resolves { error } instead.
const path = require('path');
const { Worker } = require('worker_threads');

function createDecoder({ idleMs = 20000, timeoutMs = 120000 } = {}) {
  let worker = null, seq = 0, idle = null;
  const pending = new Map();
  let chain = Promise.resolve();

  function stop() {
    if (idle) { clearTimeout(idle); idle = null; }
    if (worker) { const w = worker; worker = null; w.terminate().catch(() => 0); }
  }
  function ensure() {
    if (worker) return worker;
    const w = new Worker(path.join(__dirname, 'heic-worker.js'));
    w.unref();
    w.on('message', (m) => { const p = pending.get(m.seq); if (p) { pending.delete(m.seq); p(m); } });
    const fail = (why) => { for (const [k, p] of pending) { pending.delete(k); p({ ok: false, error: why }); } if (worker === w) worker = null; };
    w.on('error', (e) => fail(`The HEIC decoder stopped: ${(e && e.message) || e}`));
    w.on('exit', (code) => { if (pending.size) fail(`The HEIC decoder stopped (exit code ${code}).`); if (worker === w) worker = null; });
    worker = w;
    return w;
  }
  function run(job) {
    const w = ensure();
    if (idle) { clearTimeout(idle); idle = null; }
    const s = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (pending.has(s)) { pending.delete(s); resolve({ ok: false, error: 'Decoding took more than 2 minutes and was stopped.' }); stop(); } }, timeoutMs);
      pending.set(s, (m) => { clearTimeout(t); resolve(m); });
      // Copy the bytes: the transfer list empties the buffer we were given.
      const bytes = new Uint8Array(job.bytes.length);
      bytes.set(job.bytes);
      w.postMessage({ seq: s, bytes, index: job.index || 0, itemId: job.itemId || 0, maxSide: job.maxSide || 0 }, [bytes.buffer]);
    }).finally(() => {
      if (!pending.size) { idle = setTimeout(stop, idleMs); if (idle.unref) idle.unref(); }
    });
  }
  /** job: { bytes, index?, itemId?, maxSide? } -> { width, height, rgba, count, ids, index } or { error } */
  function decodeHeic(job) {
    const p = chain.then(() => run(job));
    chain = p.catch(() => 0);
    return p.then((m) => (m && m.ok ? { width: m.width, height: m.height, rgba: m.rgba, count: m.count, ids: m.ids, index: m.index } : { error: friendly((m && m.error) || 'Unknown decoder error') }));
  }
  return { decodeHeic, stop, get running() { return !!worker; } };
}

/** Turns libheif messages into a sentence a user can act on. */
function friendly(msg) {
  const m = String(msg);
  if (/VVC/i.test(m)) return 'This image uses the VVC (H.266) codec, which this viewer cannot decode yet. The file details are shown on the right.';
  if (/AV1/i.test(m)) return 'This image uses AV1 inside a .heic or .heif file. Rename it to .avif to view it with the AVIF decoder.';
  if (/JPEG 2000|j2k/i.test(m)) return 'This image uses JPEG 2000 inside HEIF, which this viewer cannot decode.';
  if (/pitm|primary/i.test(m)) return `libheif could not read the primary image: ${m}`;
  return m;
}

module.exports = { createDecoder, friendly };
