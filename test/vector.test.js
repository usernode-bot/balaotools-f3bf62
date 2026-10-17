'use strict';

// The shape model and its two writers, checked against hand-made tracedata
// (no tracer involved): one square with a hole, one fully transparent layer
// that must be skipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const ImageTracer = require('imagetracerjs');
const { fromTracedata, toSvg, toEps, countShapes } = require('../lib/vector');
const { TRACE_OPTIONS, decode } = require('../lib/prepare');

// A 4x4 red square (0,0)-(4,4) with a 2x2 hole in the middle, as
// ImageTracer.imagedataToTracedata reports it: one non-hole path whose
// holechildren indexes the hole path in the same layer.
const squareWithHole = {
  palette: [{ r: 228, g: 72, b: 59, a: 255 }, { r: 0, g: 0, b: 0, a: 0 }],
  layers: [
    [
      {
        isholepath: false,
        holechildren: [1],
        segments: [
          { type: 'L', x1: 0, y1: 0, x2: 4, y2: 0 },
          { type: 'L', x1: 4, y1: 0, x2: 4, y2: 4 },
          { type: 'L', x1: 4, y1: 4, x2: 0, y2: 4 },
          { type: 'L', x1: 0, y1: 4, x2: 0, y2: 0 },
        ],
      },
      {
        isholepath: true,
        holechildren: [],
        segments: [
          { type: 'L', x1: 1, y1: 1, x2: 3, y2: 1 },
          { type: 'L', x1: 3, y1: 1, x2: 3, y2: 3 },
          { type: 'L', x1: 3, y1: 3, x2: 1, y2: 3 },
          { type: 'L', x1: 1, y1: 3, x2: 1, y2: 1 },
        ],
      },
    ],
    // A fully transparent palette entry carries no visible colour.
    [],
  ],
};

test('fromTracedata keeps the colour shape with its hole and skips transparent layers', () => {
  const shapes = fromTracedata(squareWithHole);
  assert.equal(countShapes(shapes), 1);
  assert.deepEqual(shapes[0].rgb, [228, 72, 59]);
  // The main path plus its one hole child, in order.
  assert.equal(shapes[0].subpaths.length, 2);
  assert.deepEqual(shapes[0].subpaths[0][0], { op: 'M', pts: [0, 0] });
  assert.deepEqual(shapes[0].subpaths[1][0], { op: 'M', pts: [1, 1] });
});

test('toSvg writes the hole with fill-rule evenodd', () => {
  const [shape] = fromTracedata(squareWithHole);
  const svg = toSvg([shape], 4, 4, 4, 4);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4">'));
  assert.ok(svg.includes('fill="rgb(228,72,59)"'));
  assert.ok(svg.includes('fill-rule="evenodd"'));
  assert.ok(svg.includes('M0 0L4 0L4 4L0 4L0 0Z'));
  assert.ok(svg.includes('M1 1L3 1L3 3L1 3L1 1Z'));
  assert.ok(svg.endsWith('</svg>'));
});

test('toEps writes an EPSF header, a y-flipped eofill path and no hole fill', () => {
  const [shape] = fromTracedata(squareWithHole);
  const eps = toEps([shape], 4, 4, 4, 4, 'my%image');
  assert.ok(eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0\n'));
  assert.ok(eps.includes('%%BoundingBox: 0 0 4 4'));
  assert.ok(eps.includes('%%HiResBoundingBox: 0 0 4.000 4.000'));
  // The title is sanitised: no % (a PostScript comment marker).
  assert.ok(eps.includes('%%Title: my image'));
  assert.ok(eps.includes('%%Creator: BalaoTools'));
  // Colour as 0..1 RGB.
  assert.ok(eps.includes('0.894 0.282 0.231 setrgbcolor'));
  // The y-flip so PostScript's bottom-up coordinates draw the image upright.
  assert.ok(eps.includes('0 4.000 translate 1.000 -1.000 scale'));
  assert.ok(eps.includes('eofill'));
  assert.ok(eps.includes('showpage'));
  assert.ok(eps.trimEnd().endsWith('%%EOF'));
});

test('a quadratic segment becomes a cubic in EPS and stays a Q in SVG', () => {
  const td = {
    palette: [{ r: 0, g: 0, b: 0, a: 255 }],
    layers: [[
      {
        isholepath: false,
        holechildren: [],
        segments: [
          { type: 'L', x1: 0, y1: 0, x2: 4, y2: 0 },
          { type: 'Q', x1: 4, y1: 0, x2: 6, y2: 2, x3: 4, y3: 4 },
          { type: 'L', x1: 4, y1: 4, x2: 0, y2: 4 },
          { type: 'L', x1: 0, y1: 4, x2: 0, y2: 0 },
        ],
      },
    ]],
  };
  const [shape] = fromTracedata(td);
  const svg = toSvg([shape], 4, 4, 4, 4);
  // The quadratic's control point and end point, verbatim.
  assert.ok(svg.includes('Q6 2 4 4'));
  const eps = toEps([shape], 4, 4, 4, 4, 'q');
  // Q -> cubic: inner controls two thirds of the way to the control point.
  assert.ok(eps.includes('5.333 1.333 5.333 2.667 4.000 4.000 curveto'));
});
// ---------------------------------------------------------------------------
// Decode and tracer options (lib/prepare.js): the tuning and the sharp
// preprocessing that clean the picture up before it is traced.
// ---------------------------------------------------------------------------

// A PNG of the given size and colour, built with sharp.
function png(width, height, r, g, b, extras = []) {
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } })
    .png()
    .composite(extras)
    .toBuffer();
}

test('TRACE_OPTIONS are tuned and the colour cap is kept', () => {
  assert.equal(TRACE_OPTIONS.numberofcolors, 24);
  assert.equal(TRACE_OPTIONS.ltres, 0.75);
  assert.equal(TRACE_OPTIONS.qtres, 0.75);
  assert.equal(TRACE_OPTIONS.pathomit, 6);
  assert.equal(TRACE_OPTIONS.colorsampling, 2);
  assert.equal(TRACE_OPTIONS.linefilter, true);
});

test('a small image is enlarged to 1200 on the long side before tracing', async () => {
  const body = await png(100, 50, 255, 255, 255);
  const d = await decode(body);
  assert.equal(d.traceW, 1200);
  assert.equal(d.traceH, 600);
  // The downloaded file keeps the original size.
  assert.equal(d.outW, 100);
  assert.equal(d.outH, 50);
  assert.equal(d.imagedata.data.length, 1200 * 600 * 4);
});

test('a mid-size image is traced at its own size', async () => {
  const d = await decode(await png(1600, 800, 255, 255, 255));
  assert.equal(d.traceW, 1600);
  assert.equal(d.traceH, 800);
});

test('a large image is still capped at 2400 on the long side', async () => {
  const d = await decode(await png(3000, 1500, 255, 255, 255));
  assert.equal(d.traceW, 2400);
  assert.equal(d.traceH, 1200);
  assert.equal(d.outW, 3000);
  assert.equal(d.outH, 1500);
});

test('an isolated speck is removed by the denoise, not traced', async () => {
  const dot = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png().toBuffer();
  const body = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .composite([{ input: dot, left: 32, top: 32 }])
    .toBuffer();
  const d = await decode(body);
  // 64 px enlarged to 1200: original pixel (32,32) lands at (600,600).
  const i = (600 * d.imagedata.width + 600) * 4;
  const p = d.imagedata.data;
  assert.ok(p[i] > 200 && p[i + 1] < 60 && p[i + 2] < 60,
    `expected red at (600,600), got ${p[i]},${p[i + 1]},${p[i + 2]}`);
});

test('the tuned options trace a circle into a few smooth shapes', () => {
  // 300x300 white imagedata with one filled red circle, traced in-process
  // with the same options the worker uses.
  const w = 300, h = 300, r = 100;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = (x - 150) * (x - 150) + (y - 150) * (y - 150) <= r * r;
      data[i] = inside ? 228 : 255;
      data[i + 1] = inside ? 72 : 255;
      data[i + 2] = inside ? 59 : 255;
      data[i + 3] = 255;
    }
  }
  const td = ImageTracer.imagedataToTracedata({ width: w, height: h, data }, TRACE_OPTIONS);
  const shapes = fromTracedata(td);
  assert.ok(countShapes(shapes) <= 4, `expected at most 4 shapes, got ${countShapes(shapes)}`);
  const red = shapes.find(s => s.rgb[0] > 180 && s.rgb[1] < 120 && s.rgb[2] < 120);
  assert.ok(red, 'expected one near-red shape');
  const hasCurve = red.subpaths.some(sp => sp.some(seg => seg.op === 'Q'));
  assert.ok(hasCurve, 'expected the circle outline to use quadratic curves');
});
