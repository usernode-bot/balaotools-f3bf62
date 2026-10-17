'use strict';

// The photo pipeline: how an image is routed (photo-like vs flat), the
// options the photo path traces with, and what that does to a real trace
// through the engine — the mosaic-of-pixel-boxes failure the flat path shows
// on photographs.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { isPhoto, tracePhoto, photoOptions, distinctColors } = require('../lib/photo');

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

test('photoOptions trace coarsely with the histogram palette', () => {
  const imgd = gradientImage(64, 48);
  const options = photoOptions(imgd);
  // Coarse clustering and curve simplification, so noise merges into its
  // surrounding region and contours stay smooth.
  assert.equal(options.mode, 'spline');
  assert.ok(options.filterSpeckle > 10);
  assert.ok(options.layerDifference > 10);
  assert.ok(options.simplify > 0);
  // The palette is built from the pixels, capped at the photo colour count.
  assert.ok(Array.isArray(options.palette));
  assert.ok(options.palette.length > 0);
  assert.ok(options.palette.length <= 32);
});

test('a photo-like image traces into few smooth shapes, not a mosaic', () => {
  // A photo-sized gradient image traced through the photo path. The flat
  // path on the same pixels produces step art: a shape (or a hole) per
  // quantisation band boundary. The photo path must stay two orders of
  // magnitude below that and follow contours with curves.
  const grad = gradientImage(512, 384);
  const shapes = tracePhoto(grad);
  const n = shapes.reduce((acc, s) => acc + s.subpaths.length, 0);
  assert.ok(n > 0);
  assert.ok(n < 400, 'expected few shapes, got ' + n);
  // Smooth: cubic curves, not pixel-stair segments.
  const curveOps = shapes.reduce((acc, s) => acc +
    s.subpaths.reduce((a, sub) => a + sub.filter((op) => op.op === 'C').length, 0), 0);
  assert.ok(curveOps > 0, 'expected curved subpaths, got straight lines only');
});

test('a noisy photo-like image keeps detail without turning to mosaic', () => {
  // A gradient plus per-pixel noise, the way a camera's sensor output looks
  // before JPEG: enough distinct colours to route as a photo, enough texture
  // that clustering has real regions to find. The photo path must keep the
  // structure (more than the single region a bare gradient collapses to)
  // while staying far under mosaic counts.
  const w = 512, h = 384;
  const base = gradientImage(w, h);
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < w * h; i++) {
    base.data[i * 4] = Math.max(0, Math.min(255, base.data[i * 4] + Math.round((rand() - 0.5) * 60)));
    base.data[i * 4 + 1] = Math.max(0, Math.min(255, base.data[i * 4 + 1] + Math.round((rand() - 0.5) * 60)));
    base.data[i * 4 + 2] = Math.max(0, Math.min(255, base.data[i * 4 + 2] + Math.round((rand() - 0.5) * 60)));
  }
  const shapes = tracePhoto(base);
  const n = shapes.reduce((acc, s) => acc + s.subpaths.length, 0);
  assert.ok(n > 1, 'texture should produce regions, got ' + n);
  assert.ok(n < 2000, 'expected hundreds, not a mosaic, got ' + n);
  const curveOps = shapes.reduce((acc, s) => acc +
    s.subpaths.reduce((a, sub) => a + sub.filter((op) => op.op === 'C').length, 0), 0);
  assert.ok(curveOps > 0, 'expected curved subpaths');
});