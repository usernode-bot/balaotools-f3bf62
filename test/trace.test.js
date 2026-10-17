'use strict';

// The trace quality pipeline: the palette the worker feeds the engine (the
// engine's own colour sampling loses small areas' colours and shifts every
// colour), the flat-path trace itself, and the SVG parser that turns the
// engine's output back into the app's shape model.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { buildPalette, hexPalette } = require('../lib/palette');
const { traceFlat, svgToShapes, dToSubpaths } = require('../lib/vtrace');
const { toSvg, countShapes } = require('../lib/vector');

// A mostly-white image with one rare, saturated colour in a small area —
// exactly the kind of colour a sampler working on a position grid loses. The
// pixels come back as an RGBA Uint8Array, like sharp's raw output.
function imageWithDot(width, height, dot) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 250; data[i * 4 + 1] = 250; data[i * 4 + 2] = 250; data[i * 4 + 3] = 255;
  }
  for (const [x, y] of dot) {
    const i = (y * width + x) * 4;
    data[i] = 245; data[i + 1] = 158; data[i + 2] = 11; data[i + 3] = 255;
  }
  return { width, height, data };
}

test('buildPalette starts at the dominant colour and keeps a rare one', () => {
  const imgd = imageWithDot(96, 64, [[80, 30], [81, 30], [80, 31], [81, 31]]);
  const pal = buildPalette(imgd, 24);
  assert.equal(pal.length, 24);
  // The dominant colour first.
  assert.deepEqual(pal[0], { r: 250, g: 250, b: 250, a: 255 });
  // The dot's colour is in the palette, exactly.
  assert.ok(pal.some((p) => p.r === 245 && p.g === 158 && p.b === 11 && p.a === 255));
  // Deterministic: the same pixels seed the same palette.
  assert.deepEqual(buildPalette(imgd, 24), pal);
});

test('buildPalette normalises transparent pixels to one shared entry', () => {
  const width = 32, height = 32;
  const data = new Uint8Array(width * height * 4);
  // Two transparent-ish shades (alpha under the 128 cut) and one opaque.
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 3] = i % 2 ? 10 : 100; // both transparent
    data[i * 4] = 17; data[i * 4 + 1] = 18; data[i * 4 + 2] = 19;
  }
  data[(0 * width + 0) * 4 + 3] = 255;
  const pal = buildPalette({ width, height, data }, 24);
  // The dominant entry is the shared transparent corner colour.
  assert.deepEqual(pal[0], { r: 0, g: 0, b: 0, a: 0 });
});

test('hexPalette is exact "#RRGGBB" strings, opaque and deduped', () => {
  // A 3x3 dot: nine pixels, just over the ~8-px minimum patch the engine
  // forms regions from, so the colour deserves a palette slot.
  const dot = [];
  for (let y = 30; y < 33; y++) for (let x = 10; x < 13; x++) dot.push([x, y]);
  const imgd = imageWithDot(64, 48, dot);
  const hex = hexPalette(imgd, 24);
  // Every entry is a six-digit uppercase hex colour.
  assert.ok(hex.length > 0);
  for (const s of hex) assert.match(s, /^#[0-9A-F]{6}$/);
  // The dot's exact colour made it in.
  assert.ok(hex.includes('#F59E0B'), 'the rare dot colour must survive');
  // Sub-patch colours do not: they can never form a region, and a blend
  // shade stealing a small feature's colour is the failure this prevents.
  const tiny = imageWithDot(64, 48, [[10, 10], [11, 10]]);
  assert.ok(!hexPalette(tiny, 24).includes('#F59E0B'),
    'a sub-patch colour must not take a palette slot');
  // A lossy encoding (JPEG) shatters one colour into many one-pixel shades a
  // few steps apart. Folded into buckets they re-coalesce into a whole
  // patch, so the feature keeps a palette entry — some shade within a few
  // steps of the source colour, not the surrounding background.
  const shattered = [];
  for (let i = 0; i < 12; i++) {
    shattered.push([20 + (i % 4), 10 + Math.floor(i / 4),
      245 + [0, 1, -1, 2][i % 4], 158 + [0, 1, -1, 2][i % 4], 11 + [0, -1, -2, -3][i % 4]]);
  }
  const noisy = { width: 64, height: 48, data: new Uint8Array(64 * 48 * 4) };
  for (let i = 0; i < 64 * 48; i++) {
    noisy.data[i * 4] = 250; noisy.data[i * 4 + 1] = 250;
    noisy.data[i * 4 + 2] = 250; noisy.data[i * 4 + 3] = 255;
  }
  for (const [x, y, r, g, b] of shattered) {
    const i = (y * noisy.width + x) * 4;
    noisy.data[i] = r; noisy.data[i + 1] = g; noisy.data[i + 2] = b;
    noisy.data[i + 3] = 255;
  }
  const near = (s, t) => Math.abs(parseInt(s.slice(1, 3), 16) - t[0]) +
    Math.abs(parseInt(s.slice(3, 5), 16) - t[1]) +
    Math.abs(parseInt(s.slice(5, 7), 16) - t[2]);
  assert.ok(hexPalette(noisy, 24).some((s) => near(s, [245, 158, 11]) < 40),
    'a shattered colour must still earn a palette entry');
  // No duplicates: buildPalette pads with the dominant colour, the fixed
  // palette has no use for that.
  assert.equal(new Set(hex).size, hex.length);
  // Deterministic.
  assert.deepEqual(hexPalette(imgd, 24), hex);
});

test('a traced image keeps its small area colour, exactly', async () => {
  // A flat-colour drawing with a small orange dot, anti-aliased like any
  // real upload (sharp rasterises the SVG). The built palette must carry the
  // dot's exact colour, the engine must keep it as a shape of its own, and
  // the whole drawing stays a handful of shapes, not a mosaic.
  const png = await sharp(Buffer.from(
    "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'>" +
    "<rect width='300' height='200' fill='white'/>" +
    "<rect x='20' y='20' width='100' height='80' fill='#1d4ed8'/>" +
    "<rect x='160' y='20' width='100' height='80' fill='#e11d48'/>" +
    "<circle cx='81' cy='181' r='3' fill='#f59e0b'/></svg>"))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const imgd = {
    width: png.info.width,
    height: png.info.height,
    data: new Uint8Array(png.data),
  };
  const shapes = traceFlat(imgd);
  const svg = toSvg(shapes, imgd.width, imgd.height, imgd.width, imgd.height);
  assert.ok(countShapes(shapes) > 0);
  // The dot's exact colour is one of the traced shapes.
  assert.ok(svg.includes('rgb(245,158,11)'),
    'the orange dot should survive as its own exact colour');
  // Small: a flat drawing is a few shapes, each a few curve segments.
  assert.ok(countShapes(shapes) < 50,
    'expected a handful of shapes, got ' + countShapes(shapes));
  assert.ok(Buffer.byteLength(svg) < 20000,
    'expected a small SVG, got ' + Buffer.byteLength(svg) + ' bytes');
});

test('the parser folds relative commands and splits subpaths at Z', () => {
  // vtracer writes compact relative commands with leading-dot decimals and
  // packs several subpaths into one path (Z then M). The parsed ops must be
  // absolute and each Z must close one subpath.
  const subs = dToSubpaths('M10,10c2,0,4,0,6,0c-2,4,-4,4,-6,0Zm2,2l1,1Z');
  assert.equal(subs.length, 2);
  // First subpath: the relative cubics fold into absolute coordinates.
  assert.deepEqual(subs[0][0], { op: 'M', pts: [10, 10] });
  assert.deepEqual(subs[0][1], { op: 'C', pts: [12, 10, 14, 10, 16, 10] });
  assert.deepEqual(subs[0][2], { op: 'C', pts: [14, 14, 12, 14, 10, 10] });
  // Second subpath: an m right after Z resolves against the closed
  // subpath's start point (10,10), and it is its own subpath.
  assert.deepEqual(subs[1][0], { op: 'M', pts: [12, 12] });
  assert.deepEqual(subs[1][1], { op: 'L', pts: [13, 13] });
});

test('svgToShapes keeps fills and draw order, drops empty paths', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<path d="M0,0L1,0L1,1Z" fill="#0E9F6E"/>' +
    '<path d="M0,0" fill="#111827"/>' + // no ops: dropped
    '<path d="M5,5L6,5L6,6Z" fill="#E11D47"/></svg>';
  const shapes = svgToShapes(svg);
  assert.equal(shapes.length, 2);
  assert.deepEqual(shapes[0].rgb, [14, 159, 110]);
  assert.deepEqual(shapes[1].rgb, [225, 29, 71]);
  assert.deepEqual(shapes[0].subpaths[0][0].pts, [0, 0]);
  assert.deepEqual(shapes[1].subpaths[0][1].pts, [6, 5]);
});

test('the flat trace re-renders like the engine\'s own SVG', async () => {
  // The app's shape model and writers (lib/vector.js) re-author the engine's
  // SVG with fill-rule evenodd; vtracer draws regions stacked with nonzero.
  // The two must agree pixel for pixel on flat art.
  const png = await sharp(Buffer.from(
    "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'>" +
    "<rect width='300' height='200' fill='white'/>" +
    "<rect x='20' y='20' width='100' height='80' fill='#1d4ed8'/>" +
    "<rect x='160' y='20' width='100' height='80' fill='#e11d48'/>" +
    "<circle cx='81' cy='181' r='3' fill='#f59e0b'/></svg>"))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const imgd = {
    width: png.info.width,
    height: png.info.height,
    data: new Uint8Array(png.data),
  };
  const shapes = traceFlat(imgd);
  const vtracer = require('@visioncortex/vtracer');
  const pal = hexPalette(imgd, 24);
  const engineSvg = vtracer.convertPixels(imgd.data, imgd.width, imgd.height, {
    mode: 'spline', palette: pal, filterSpeckle: 2, layerDifference: 16,
    cornerThreshold: 60, lengthThreshold: 4, spliceThreshold: 20, pathPrecision: 2,
  });
  const ours = toSvg(shapes, imgd.width, imgd.height, imgd.width, imgd.height);
  const a = await sharp(Buffer.from(engineSvg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(Buffer.from(ours)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(a.info.width, b.info.width);
  assert.equal(a.info.height, b.info.height);
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (Math.abs(a.data[i] - b.data[i]) > 8) diff++;
  }
  // Rendering engines differ by sub-pixel anti-aliasing at worst.
  assert.ok(diff <= 200,
    're-authored SVG should match the engine\'s, got ' + diff + ' differing channels');
});