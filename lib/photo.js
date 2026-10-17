'use strict';

// The photo pipeline. imagetracerjs with a fixed palette turns a photograph
// into step art: every quantised colour region traces as per-pixel boxes, so
// a photo produces tens of thousands of jagged little shapes that read as a
// mosaic. Photos get their own path: downscale (server.js does it before
// queuing), a selective blur so smooth gradients flatten before tracing,
// looser curve fitting, and a backdrop rect in the dominant colour so the
// small paths that get dropped leave no white holes. The result posterises
// the photo into a few hundred smooth contour-following shapes.
//
// Flat images (logos, drawings, text) keep the normal path — see isPhoto()
// for the split.

const ImageTracer = require('imagetracerjs');
const { buildPalette, histogram } = require('./palette');
const { fromTracedata } = require('./vector');

// A photo crosses ~1300 distinct colours at 5-bit quantisation (sensor and
// JPEG noise alone), while the noisiest flat fixture observed (anti-aliased
// art saved as JPEG) stayed under 470. Sample ~60k pixels at the image's own
// resolution: resizing first pollutes the count for small images, and 5-bit
// quantisation keeps JPEG ringing from inflating the count.
const PHOTO_MIN_DISTINCT = 800;

// The long side photos are traced at. Downscaling is the main smoothing
// lever: a photo traced at this size posterises into hundreds of shapes
// instead of tens of thousands, and the curves stay smooth however far the
// SVG is scaled up (the writers scale the traced coordinates to the original
// display size).
const PHOTO_MAX_SIDE = 512;

// Looser curve fitting than the flat path (ltres/qtres 1) so contours become
// smooth curves instead of pixel steps; a lower pathomit than the flat path
// keeps real detail now that the backdrop fills any gaps; rightangleenhance
// off because photo contours are not rectilinear.
const PHOTO_COLORS = 32;
const PHOTO_LTRES = 2.5;
const PHOTO_QTRES = 2.5;
const PHOTO_PATHOMIT = 24;
const PHOTO_BLUR_RADIUS = 4;
const PHOTO_BLUR_DELTA = 64;

// Distinct 5-bit colours among the opaque sampled pixels.
function distinctColors(imgd) {
  const { data, width, height } = imgd;
  const stride = Math.max(1, Math.round(Math.sqrt((width * height) / 60000)));
  const seen = new Set();
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      seen.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
    }
  }
  return seen.size;
}

function isPhoto(imgd) {
  return distinctColors(imgd) >= PHOTO_MIN_DISTINCT;
}

// The trace options for a photo: same palette builder as the flat path (the
// tracer's own sampling drifts colours), plus the photo-specific smoothing.
function photoOptions(imgd) {
  return {
    numberofcolors: PHOTO_COLORS,
    ltres: PHOTO_LTRES,
    qtres: PHOTO_QTRES,
    pathomit: PHOTO_PATHOMIT,
    rightangleenhance: false,
    blurradius: PHOTO_BLUR_RADIUS,
    blurdelta: PHOTO_BLUR_DELTA,
    colorquantcycles: 1,
    pal: buildPalette(imgd, PHOTO_COLORS),
  };
}

// One trace of a photo-shaped image: options above, then the backdrop rect
// (skipped for images with transparency, where dropped paths correctly leave
// see-through gaps).
function tracePhoto(imgd) {
  const tracedata = ImageTracer.imagedataToTracedata(imgd, photoOptions(imgd));
  let shapes = fromTracedata(tracedata);
  if (shapes.length && !hasTransparency(imgd)) shapes = [backdrop(imgd), ...shapes];
  return shapes;
}

// Any sampled pixel under half alpha?
function hasTransparency(imgd) {
  const { data, width, height } = imgd;
  const stride = Math.max(1, Math.round(Math.sqrt((width * height) / 60000)));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (data[(y * width + x) * 4 + 3] < 128) return true;
    }
  }
  return false;
}

// Dropping small paths is what keeps the shape count sane, but the pixels
// those paths covered are drawn by no other layer: without a backdrop every
// dropped path shows as a hole. One rect in the dominant colour sits under
// every traced shape and fills them.
function backdrop(imgd) {
  let best = null, bestN = -1;
  histogram(imgd).forEach((n, key) => {
    const a = key & 255;
    if (a >= 128 && n > bestN) {
      bestN = n;
      best = [(key >>> 24) & 255, (key >>> 16) & 255, (key >>> 8) & 255];
    }
  });
  const w = imgd.width, h = imgd.height;
  return { rgb: best, subpaths: [[
    { op: 'M', pts: [0, 0] },
    { op: 'L', pts: [w, 0] },
    { op: 'L', pts: [w, h] },
    { op: 'L', pts: [0, h] },
  ]] };
}

module.exports = {
  isPhoto,
  tracePhoto,
  photoOptions,
  distinctColors,
  hasTransparency,
  backdrop,
  PHOTO_MAX_SIDE,
};
