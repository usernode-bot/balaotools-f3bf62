'use strict';

// Worker thread: receives RGBA pixels plus their size, runs the colour
// tracer (it is synchronous and can take minutes on a photo, so it must not
// run on the main server thread) and posts back shapes only.

const { parentPort } = require('worker_threads');
const ImageTracer = require('imagetracerjs');
const { fromTracedata } = require('./vector');
const { traceOptions } = require('./palette');
const { tracePhoto } = require('./photo');

parentPort.on('message', (msg) => {
  try {
    let shapes;
    if (msg.options.photo) {
      // Photos: their own options and backdrop (lib/photo.js). The pixels
      // arrive already downscaled (server.js).
      shapes = tracePhoto(msg.imagedata);
    } else {
      // The palette is built here, next to the pixels it describes, from the
      // caller's base options (see lib/palette.js for why not the tracer's own
      // colour sampling).
      const tracedata = ImageTracer.imagedataToTracedata(
        msg.imagedata, traceOptions(msg.imagedata, msg.options));
      shapes = fromTracedata(tracedata);
    }
    parentPort.postMessage({ shapes });
  } catch (err) {
    parentPort.postMessage({ error: err && err.message ? err.message : 'failed' });
  }
});