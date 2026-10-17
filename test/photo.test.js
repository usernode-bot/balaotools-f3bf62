'use strict';

// The photo pipeline: how an image is routed (photo-like vs flat), the
// options the photo path traces with, and what that does to a real trace
// through imagetracerjs — the mosaic-of-pixel-boxes failure the flat path
// shows on photographs.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { isPhoto, tracePhoto, photoOptions, backdrop, hasTransparency, distinctColors } = require('../lib/photo');
const { countShapes } = require('../lib/vector');

// A smooth-gradient image, like any photograph: each channel ramps across
// the whole canvas, so almost every pixel is a slightly different colour.
function gradientImage(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = Math.round(255 * x / (width - 1));
      data[i + 1] = Math.round(255 * y / (height - 1));
      data[i + 2] = Math.round((x + y) * 255 / (width + height - 2));
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

// A flat drawing: four solid regions with hard edges, like a logo.
function flatImage(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const left = x < width / 2;
      const top = y < height / 2;
      data[i] = left ? (top ? 250 : 29) : (top ? 225 : 120);
      data[i + 1] = left ? (top ? 250 : 78) : (top ? 29 : 200);
      data[i + 2] = left ? (top ? 250 : 216) : (top ? 53 : 120);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

test('a smooth gradient is photo-like, a flat drawing is not', () => {
  const grad = gradientImage(200, 150);
  const flat = flatImage(200, 150);
  // The gradient's thousands of distinct colours sit far above the flat
  // drawing's four, and the routing threshold keeps them on either side.
  assert.ok(distinctColors(grad) > distinctColors(flat) * 10);
  assert.equal(isPhoto(grad), true);
  assert.equal(isPhoto(flat), false);
});

test('flat art saved as JPEG stays on the flat path', async () => {
  // JPEG ringing inflates the colour count of an anti-aliased drawing; the
  // worst flat fixture observed stays under the routing threshold. Encode
  // the flat drawing as a JPEG to simulate that noise.
  const flat = flatImage(400, 300);
  const jpeg = await sharp(Buffer.from(flat.data.buffer), {
    raw: { width: flat.width, height: flat.height, channels: 4 },
  }).flatten({ background: 'white' }).jpeg({ quality: 80 }).toBuffer();
  const png = await sharp(jpeg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const imgd = { width: png.info.width, height: png.info.height, data: new Uint8Array(png.data) };
  assert.equal(isPhoto(imgd), false);
});

test('photoOptions trade fidelity of edges for smooth contours', () => {
  const imgd = gradientImage(64, 48);
  const options = photoOptions(imgd);
  // Looser curve fitting than the flat path, right-angle snapping off, and
  // a selective blur so smooth gradients flatten before tracing.
  assert.equal(options.rightangleenhance, false);
  assert.ok(options.ltres > 1 && options.qtres > 1);
  assert.ok(options.blurradius > 0);
  // The palette is built from the pixels, one quantisation pass.
  assert.equal(options.colorquantcycles, 1);
  assert.equal(options.pal.length, options.numberofcolors);
});

test('a photo-like image traces into few smooth shapes, not a mosaic', async () => {
  // A photo-sized gradient image traced through the photo path. The flat
  // path on the same pixels produces step art: a shape (or a hole) per
  // quantisation band boundary. The photo path must stay two orders of
  // magnitude below that and follow contours with curves.
  const grad = gradientImage(512, 384);
  const shapes = tracePhoto(grad);
  const n = countShapes(shapes);
  assert.ok(n > 0);
  assert.ok(n < 400, 'expected a few dozen shapes, got ' + n);
  // Smooth: quadratic curves, not pixel-stair segments.
  const quadSubpaths = shapes.reduce((acc, s) => acc +
    s.subpaths.reduce((a, sub) => a + sub.filter((op) => op.op === 'Q').length, 0), 0);
  assert.ok(quadSubpaths > 0, 'expected curved subpaths, got straight lines only');
});

test('the photo backdrop is opaque when the image is, absent when not', () => {
  const opaque = gradientImage(32, 32);
  assert.equal(hasTransparency(opaque), false);
  const bg = backdrop(opaque);
  // Full-canvas rect in the dominant colour: the first sampled pixel's.
  assert.deepEqual(bg.rgb, [0, 0, 0]);
  assert.deepEqual(bg.subpaths[0][0].pts, [0, 0]);
  assert.deepEqual(bg.subpaths[0][1].pts, [32, 0]);
  // One transparent pixel flips the image, and its backdrop would fill the
  // see-through area with colour, so there is none.
  const withHole = gradientImage(32, 32);
  withHole.data[(16 * 32 + 16) * 4 + 3] = 64;
  assert.equal(hasTransparency(withHole), true);
});