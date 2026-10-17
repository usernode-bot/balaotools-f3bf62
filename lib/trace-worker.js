'use strict';

// Worker thread: receives RGBA pixels plus whether the server classified the
// image as photo-like, runs the tracing engine (synchronous, WASM) and posts
// back shapes only.

const { parentPort } = require('worker_threads');
const { traceFlat } = require('./vtrace');
const { tracePhoto } = require('./photo');

parentPort.on('message', (msg) => {
  try {
    // Photos: their own options (lib/photo.js). The pixels arrive already
    // downscaled and blurred (server.js). Flat art: the histogram palette
    // and the flat options (lib/vtrace.js).
    const shapes = msg.photo ? tracePhoto(msg.imagedata) : traceFlat(msg.imagedata);
    parentPort.postMessage({ shapes });
  } catch (err) {
    parentPort.postMessage({ error: err && err.message ? err.message : 'failed' });
  }
});