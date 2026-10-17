'use strict';

// The trace quality pipeline: the palette the worker feeds the tracer (the
// tracer's own colour sampling loses small areas' colours and shifts every
// colour), and what that does to a real trace through imagetracerjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const ImageTracer = require('imagetracerjs');
const { buildPalette, traceOptions } = require('../lib/palette');
const { fromTracedata, toSvg, countShapes } = require('../lib/vector');

// The base options server.js sends the worker (the palette and the single
// quantisation pass are added by the worker, from lib/palette.js).
const BASE = {
  numberofcolors: 24,
  ltres: 1,
  qtres: 1,
  pathomit: 8,
  rightangleenhance: true,
};

// A mostly-white image with one rare, saturated colour in a small area —
// exactly the kind of colour the tracer's grid sampling loses. The pixels
// come back as an RGBA Uint8Array, like sharp's raw output.
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

test('traceOptions pins a single quantisation pass and the built palette', () => {
  const imgd = imageWithDot(32, 32, [[0, 0]]);
  const options = traceOptions(imgd, BASE);
  assert.equal(options.colorquantcycles, 1);
  assert.equal(options.pal.length, BASE.numberofcolors);
  // The caller's other options come through unchanged.
  assert.equal(options.ltres, BASE.ltres);
  assert.equal(options.pathomit, BASE.pathomit);
  assert.equal(options.numberofcolors, BASE.numberofcolors);
});

test('a traced image keeps its small area colour, exactly', async () => {
  // A flat-colour drawing with a small orange dot. Anti-aliased, like any
  // real upload (sharp rasterises the SVG): on such images the tracer's own
  // colour sampling never samples the dot and its k-means passes settle the
  // nearest entry on a neighbouring colour instead, so the dot came out
  // shifted or missing. The built palette must carry the dot's exact colour.
  const png = await sharp(Buffer.from(
    "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'>" +
    "<rect width='300' height='200' fill='white'/>" +
    "<rect x='20' y='20' width='100' height='80' fill='#1d4ed8'/>" +
    "<rect x='160' y='20' width='100' height='80' fill='#e11d48'/>" +
    "<circle cx='81' cy='181' r='2' fill='#f59e0b'/></svg>"))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const imgd = {
    width: png.info.width,
    height: png.info.height,
    data: new Uint8Array(png.data),
  };
  const td = ImageTracer.imagedataToTracedata(imgd, traceOptions(imgd, BASE));
  const shapes = fromTracedata(td);
  const svg = toSvg(shapes, imgd.width, imgd.height, imgd.width, imgd.height);
  assert.ok(countShapes(shapes) > 0);
  // The dot's exact colour is one of the traced shapes.
  assert.ok(svg.includes('rgb(245,158,11)'),
    'the orange dot should survive as its own exact colour');
});
