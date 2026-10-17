'use strict';

// The vtracer engine bridge. vtracer (Rust vectorizer, WASM build) returns a
// finished SVG; the app's shape model and its two writers (lib/vector.js)
// stay the single source of truth for downloads, so this module parses that
// SVG back into shapes. vtracer draws regions stacked — big regions first,
// smaller ones over them, every pixel painted at least once — which the
// writers reproduce with fill-rule="evenodd": a nested contour inside its
// parent becomes a hole in the parent, and the child shape painted after it
// fills the hole back in.

const { convertPixels } = require('@visioncortex/vtracer');
const { hexPalette } = require('./palette');

// The flat path (logos, drawings, text). A fixed palette built from the
// image's own histogram keeps every colour exact — including rare ones, the
// reason `filterSpeckle` stays low: a speckle filter of 4 already eats a
// 2-px-radius dot, 2 keeps it while still dropping single-pixel JPEG noise.
// spline mode turns every contour into curves.
const FLAT_COLORS = 24;
const FLAT_FILTER_SPECKLE = 2;
const FLAT_LAYER_DIFFERENCE = 16;
const FLAT_CORNER_THRESHOLD = 60;
const FLAT_LENGTH_THRESHOLD = 4;
const FLAT_SPLICE_THRESHOLD = 20;

// One trace of flat art: histogram palette + the options above.
function traceFlat(imgd) {
  return trace(imgd, {
    mode: 'spline',
    palette: hexPalette(imgd, FLAT_COLORS),
    filterSpeckle: FLAT_FILTER_SPECKLE,
    layerDifference: FLAT_LAYER_DIFFERENCE,
    cornerThreshold: FLAT_CORNER_THRESHOLD,
    lengthThreshold: FLAT_LENGTH_THRESHOLD,
    spliceThreshold: FLAT_SPLICE_THRESHOLD,
    pathPrecision: 2,
  });
}

// One hex fill ("#0E9F6E") -> [r, g, b].
function rgbFromFill(fill) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(fill || '');
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// An SVG path "d" -> subpaths, split at every Z (each Z closes one subpath).
// The ops are the ones the shape model knows: M/L/C, all absolute (relative
// commands are folded in as they are parsed — including an m right after a z,
// which SVG resolves against the closed subpath's start). Q/square/arc
// commands would need conversion but vtracer only emits lines and cubics —
// anything else fails the trace loudly rather than drawing it wrong.
function dToSubpaths(d) {
  // A number: optional sign and decimal point, no leading zero required
  // (vtracer writes ".28"), with an optional exponent.
  const NUM = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?';
  const tokens = d.match(new RegExp('[MmLlCcZz]|' + NUM, 'g'));
  if (!tokens) return [];
  const subpaths = [];
  let ops = [];
  let i = 0;
  // Current point and the start of the current subpath (Z returns there).
  let x = 0, y = 0, sx = 0, sy = 0;
  // Last cubic's second control point, for smooth shorthand curves.
  let prevC = null;
  let cur;
  const nums = (n) => {
    const out = [];
    while (out.length < n && i < tokens.length && tokens[i] !== undefined &&
           /[.eE+-]|^\d+$/.test(tokens[i])) {
      out.push(parseFloat(tokens[i++]));
    }
    if (out.length !== n) throw new Error('vtracer path: expected ' + n + ' numbers');
    return out;
  };
  const isNum = (t) => t !== undefined && /[.eE+-]|^\d+$/.test(t);
  while (i < tokens.length) {
    let t = tokens[i++];
    if (isNum(t)) {
      // A bare number repeats the last command implicitly (SVG path spec).
      if (!cur) throw new Error('vtracer path: number before any command');
      i--; // reprocess as part of the repeated command
      t = cur;
    }
    const rel = t === t.toLowerCase() && t !== 'z' && t !== 'Z';
    switch (t.toLowerCase()) {
      case 'm': {
        const [px, py] = nums(2);
        if (rel) { x += px; y += py; } else { x = px; y = py; }
        sx = x; sy = y;
        cur = 'm';
        ops.push({ op: 'M', pts: [x, y] });
        // Later coordinate pairs in one M are treated as line commands.
        let implied = 'l';
        while (isNum(tokens[i])) {
          const [lx, ly] = nums(2);
          if (rel) { x += lx; y += ly; } else { x = lx; y = ly; }
          ops.push({ op: implied, pts: [x, y] });
          implied = 'l';
        }
        break;
      }
      case 'l': {
        cur = 'l';
        while (isNum(tokens[i])) {
          const [lx, ly] = nums(2);
          if (rel) { x += lx; y += ly; } else { x = lx; y = ly; }
          ops.push({ op: 'L', pts: [x, y] });
        }
        break;
      }
      case 'c': {
        cur = 'c';
        while (isNum(tokens[i])) {
          const [x1, y1, x2, y2, px, py] = nums(6);
          const a = rel ? [x + x1, y + y1, x + x2, y + y2, x + px, y + py]
                        : [x1, y1, x2, y2, px, py];
          x = a[4]; y = a[5];
          prevC = [a[2], a[3]];
          ops.push({ op: 'C', pts: a });
        }
        break;
      }
      case 's': {
        // Smooth cubic: first control point is the reflection of the last
        // one. (vtracer does not emit it, but the parser stays honest.)
        cur = 's';
        while (isNum(tokens[i])) {
          const [x2, y2, px, py] = nums(4);
          const c1 = prevC ? [2 * x - prevC[0], 2 * y - prevC[1]] : [x, y];
          const a = rel ? [c1[0], c1[1], x + x2, y + y2, x + px, y + py]
                        : [c1[0], c1[1], x2, y2, px, py];
          x = a[4]; y = a[5];
          prevC = [a[2], a[3]];
          ops.push({ op: 'C', pts: a });
        }
        break;
      }
      case 'q': {
        cur = 'q';
        while (isNum(tokens[i])) {
          const [x1, y1, px, py] = nums(4);
          const a = rel ? [x + x1, y + y1, x + px, y + py] : [x1, y1, px, py];
          x = a[2]; y = a[3];
          prevC = null;
          ops.push({ op: 'Q', pts: a });
        }
        break;
      }
      case 'z': {
        if (ops.length) subpaths.push(ops);
        ops = [];
        x = sx; y = sy;
        cur = null;
        break;
      }
      default:
        throw new Error('vtracer path: unsupported command ' + t);
    }
  }
  if (ops.length) subpaths.push(ops);
  return subpaths;
}

// VTracer's SVG -> shapes, in lib/vector.js's model.
function svgToShapes(svg) {
  const shapes = [];
  const re = /<path\b[^>]*>/g;
  let m;
  while ((m = re.exec(svg))) {
    const tag = m[0];
    const d = /d="([^"]*)"/.exec(tag);
    const fill = /fill="([^"]*)"/.exec(tag);
    const rgb = rgbFromFill(fill && fill[1]);
    if (!d || !rgb) continue;
    const subpaths = dToSubpaths(d[1]).filter((s) => s.length > 1);
    if (subpaths.length) shapes.push({ rgb, subpaths });
  }
  return shapes;
}

// One trace: pixels -> vtracer options -> shapes.
function trace(imgd, options) {
  const svg = convertPixels(
    Buffer.from(imgd.data.buffer, imgd.data.byteOffset, imgd.data.length),
    imgd.width, imgd.height, options);
  return svgToShapes(svg);
}

module.exports = { trace, traceFlat, svgToShapes, dToSubpaths, rgbFromFill };