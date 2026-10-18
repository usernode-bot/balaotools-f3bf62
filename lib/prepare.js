'use strict';

// Upload preparation: the tuned tracer options and the sharp decode that
// turns an uploaded image into RGBA pixels ready for the trace worker.
// Kept out of server.js so the tests can reach it without starting the
// server.

const sharp = require('sharp');

const TRACE_COLORS = 24; // the palette the tracer quantises down to

// Tuned for cleaner output than imagetracerjs's defaults: tighter curve
// fits (ltres/qtres 0.75 instead of 1; 0.5 was measured to collapse
// circles into dense straight-line polylines with no curve segments at
// all), noise specks removed by the median filter in decode instead of by
// dropping short paths (pathomit 6, down from 8), an extra palette
// refinement pass (colorquantcycles 4, up from 3) and the tracer's 1 px
// noise-line filter on. Measured on a 2400 px photo: these trace in ~11 s
// at the same peak heap as the old options, while pathomit 4 or
// colorquantcycles 5 pushed the trace past the worker's default heap.
// colorsampling 2 keeps the result deterministic: the same image always
// traces to the same shapes.
const TRACE_OPTIONS = {
  numberofcolors: TRACE_COLORS,
  ltres: 0.75,
  qtres: 0.75,
  pathomit: 6,
  colorsampling: 2,
  colorquantcycles: 4,
  linefilter: true,
  roundcoords: 1,
  blursize: 0,
  rightangleenhance: true,
};

const MIN_TRACE_SIDE = 1200; // small images are enlarged to this before tracing
const MAX_TRACE_SIDE = 2400; // the long side is capped at this before tracing

// sharp's raw pixel output -> ImageTracer's imagedata (flat RGBA).
function toImagedata(buffer, width, height) {
  return { width, height, data: new Uint8Array(buffer) };
}

// The trace dims and the display dims differ twice over: EXIF rotation can
// swap the axes, and the long side is brought to MIN/MAX_TRACE_SIDE before
// tracing. Two passes, because sharp runs its operations in a fixed internal
// order (resize before median in one pipeline): the median denoise has to
// happen at native size, before any resampling.
async function decode(body) {
  const meta = await sharp(body).metadata();
  const swap = meta.orientation >= 5 && meta.orientation <= 8;
  const outW = swap ? meta.height : meta.width;
  const outH = swap ? meta.width : meta.height;
  // pass 1: orient and denoise at native size. median(3) removes isolated
  // specks (JPEG noise, screenshot dust) while keeping hard edges; no
  // Gaussian blur, which would add in-between colour slivers along edges.
  const first = await sharp(body)
    .rotate()
    .median(3)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // pass 2: small images up to 1200 on the long side, big ones capped at 2400
  const long = Math.max(first.info.width, first.info.height);
  const target = long < MIN_TRACE_SIDE ? MIN_TRACE_SIDE : MAX_TRACE_SIDE;
  const { data, info } = await sharp(first.data, {
    raw: { width: first.info.width, height: first.info.height, channels: 4 },
  })
    .resize(target, target, { fit: 'inside', withoutEnlargement: long >= MIN_TRACE_SIDE })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    imagedata: toImagedata(data, info.width, info.height),
    traceW: info.width,
    traceH: info.height,
    outW,
    outH,
  };
}

module.exports = { TRACE_COLORS, TRACE_OPTIONS, decode };