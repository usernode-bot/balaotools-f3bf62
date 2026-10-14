'use strict';

// The shape model and its two writers, checked against hand-made tracedata
// (no tracer involved): one square with a hole, one fully transparent layer
// that must be skipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromTracedata, toSvg, toEps, countShapes } = require('../lib/vector');

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