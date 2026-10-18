'use strict';

// The shape model and its two writers, checked against hand-made shapes (no
// tracer involved): one square with a hole, one with a quadratic segment.

const test = require('node:test');
const assert = require('node:assert/strict');
const { toSvg, toEps, countShapes } = require('../lib/vector');

const op = (name, pts) => ({ op: name, pts });

// A 4x4 red square (0,0)-(4,4) with a 2x2 hole in the middle: one shape,
// two closed subpaths — the second is the hole, which evenodd (SVG) and
// eofill (PostScript) cut out of the fill.
const squareWithHole = {
  rgb: [228, 72, 59],
  subpaths: [
    [op('M', [0, 0]), op('L', [4, 0]), op('L', [4, 4]), op('L', [0, 4]), op('L', [0, 0])],
    [op('M', [1, 1]), op('L', [3, 1]), op('L', [3, 3]), op('L', [1, 3]), op('L', [1, 1])],
  ],
};

test('toSvg writes the hole with fill-rule evenodd', () => {
  const svg = toSvg([squareWithHole], 4, 4, 4, 4);
  assert.equal(countShapes([squareWithHole]), 1);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4">'));
  assert.ok(svg.includes('fill="rgb(228,72,59)"'));
  assert.ok(svg.includes('fill-rule="evenodd"'));
  assert.ok(svg.includes('M0 0L4 0L4 4L0 4L0 0Z'));
  assert.ok(svg.includes('M1 1L3 1L3 3L1 3L1 1Z'));
  assert.ok(svg.endsWith('</svg>'));
});

test('toEps writes an EPSF header, a y-flipped eofill path and no hole fill', () => {
  const eps = toEps([squareWithHole], 4, 4, 4, 4, 'my%image');
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

test('a quadratic segment stays a Q in SVG and becomes a cubic in EPS', () => {
  const shape = {
    rgb: [0, 0, 0],
    subpaths: [[
      op('M', [0, 0]), op('L', [4, 0]), op('Q', [6, 2, 4, 4]),
      op('L', [0, 4]), op('L', [0, 0]),
    ]],
  };
  const svg = toSvg([shape], 4, 4, 4, 4);
  // The quadratic's control point and end point, verbatim.
  assert.ok(svg.includes('Q6 2 4 4'));
  const eps = toEps([shape], 4, 4, 4, 4, 'q');
  // Q -> cubic: inner controls two thirds of the way to the control point.
  assert.ok(eps.includes('5.333 1.333 5.333 2.667 4.000 4.000 curveto'));
});
