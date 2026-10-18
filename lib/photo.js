'use strict';

// The photo pipeline. A photograph's thousands of near-identical colours and
// its sensor/JPEG noise fragment a naive trace into tens of thousands of
// jagged little shapes that read as a mosaic. Photos get their own path:
// the server downscales them (sharp's lanczos3) and applies a light blur
// before queuing, and the engine traces at a coarser cluster granularity with
// generous curve simplification — the result posterises the photo into a few
// hundred smooth contour-following shapes.
//
// Flat images (logos, drawings, text) keep the normal path — see isPhoto()
// for the split.

const { trace } = require('./vtrace');
const { spreadHexPalette } = require('./palette');

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

// Clustering granularity: coarser than the flat path, so noise is absorbed
// into the surrounding region instead of becoming shapes of its own, while
// the spread palette still covers the photo's real colours.
const PHOTO_COLORS = 32;
const PHOTO_FILTER_SPECKLE = 24;
const PHOTO_LAYER_DIFFERENCE = 24;
const PHOTO_SIMPLIFY = 1.5;

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

// The engine options for a photo: a plainly spread histogram palette (exact
// colours need no protecting here — see lib/palette.js), coarse clustering
// and curve simplification for smooth contours.
function photoOptions(imgd) {
  return {
    mode: 'spline',
    palette: spreadHexPalette(imgd, PHOTO_COLORS),
    filterSpeckle: PHOTO_FILTER_SPECKLE,
    layerDifference: PHOTO_LAYER_DIFFERENCE,
    cornerThreshold: 60,
    lengthThreshold: 4,
    spliceThreshold: 45,
    simplify: PHOTO_SIMPLIFY,
    pathPrecision: 2,
  };
}

// One trace of a photo-shaped image (pixels arrive downscaled and blurred
// from server.js).
function tracePhoto(imgd) {
  return trace(imgd, photoOptions(imgd));
}

module.exports = {
  isPhoto,
  tracePhoto,
  photoOptions,
  distinctColors,
  PHOTO_MAX_SIDE,
};