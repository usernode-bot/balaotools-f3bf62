'use strict';

// The neutral shape model shared by the tracer, the SVG writer and the EPS
// writer. A shape is one flat colour with one or more closed subpaths (the
// extra ones are holes), so the same shapes render as SVG paths with
// fill-rule="evenodd" and as PostScript eofill.

// tracedata path -> [{ op: 'M'|'L'|'Q'|'C', pts: [...] }, ...]
function pathToSubpath(segments) {
  const ops = [];
  for (const seg of segments) {
    if (seg.type === 'Q') {
      ops.push({ op: 'Q', pts: [seg.x2, seg.y2, seg.x3, seg.y3] });
    } else {
      ops.push({ op: 'L', pts: [seg.x2, seg.y2] });
    }
  }
  if (segments.length) {
    ops.unshift({ op: 'M', pts: [segments[0].x1, segments[0].y1] });
  }
  return ops;
}

// ImageTracer.imagedataToTracedata output -> shapes. Layers whose palette
// entry is fully (or mostly) transparent carry no visible colour and are
// skipped; a non-hole path plus its hole children become one shape.
function fromTracedata(td) {
  const shapes = [];
  td.layers.forEach((layer, k) => {
    const pal = td.palette[k];
    if (!pal || (pal.a !== undefined && pal.a < 128)) return;
    for (let i = 0; i < layer.length; i++) {
      const path = layer[i];
      if (path.isholepath) continue;
      const subpaths = [pathToSubpath(path.segments)];
      for (const h of path.holechildren || []) {
        if (layer[h]) subpaths.push(pathToSubpath(layer[h].segments));
      }
      if (subpaths.some((s) => s.length > 1)) {
        shapes.push({ rgb: [pal.r, pal.g, pal.b], subpaths });
      }
    }
  });
  return shapes;
}

function countShapes(shapes) {
  return shapes.length;
}

const n2 = (v) => String(Math.round(v * 100) / 100);

function dForSubpath(sub) {
  let d = '';
  for (const op of sub) {
    if (op.op === 'M') d += 'M' + n2(op.pts[0]) + ' ' + n2(op.pts[1]);
    else if (op.op === 'L') d += 'L' + n2(op.pts[0]) + ' ' + n2(op.pts[1]);
    else if (op.op === 'C') d += 'C' + n2(op.pts[0]) + ' ' + n2(op.pts[1]) + ' ' +
      n2(op.pts[2]) + ' ' + n2(op.pts[3]) + ' ' + n2(op.pts[4]) + ' ' + n2(op.pts[5]);
    else d += 'Q' + n2(op.pts[0]) + ' ' + n2(op.pts[1]) + ' ' + n2(op.pts[2]) + ' ' + n2(op.pts[3]);
  }
  return d + 'Z';
}

function toSvg(shapes, w, h, outW, outH) {
  let out = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(outW) +
    '" height="' + Math.round(outH) + '" viewBox="0 0 ' + n2(w) + ' ' + n2(h) + '">';
  for (const shape of shapes) {
    out += '<path fill="rgb(' + shape.rgb[0] + ',' + shape.rgb[1] + ',' + shape.rgb[2] + ')"' +
      ' fill-rule="evenodd" d="';
    out += shape.subpaths.map(dForSubpath).join('');
    out += '"/>';
  }
  out += '</svg>';
  return out;
}

// A Q segment becomes one cubic: the two inner control points sit a third of
// the way in from each end towards the quadratic's control point.
function qToCubic(p0, q, p3) {
  return [
    p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1]),
    p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1]),
    p3[0], p3[1],
  ];
}

const n3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);

function toEps(shapes, w, h, outW, outH, title) {
  const bbW = Math.round(outW);
  const bbH = Math.round(outH);
  const lines = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%BoundingBox: 0 0 ' + bbW + ' ' + bbH,
    '%%HiResBoundingBox: 0 0 ' + n3(outW) + ' ' + n3(outH),
    '%%Title: ' + String(title || 'vector').replace(/[\r\n%]/g, ' '),
    '%%Creator: BalaoTools',
    '%%EndComments',
    '0 ' + n3(outH) + ' translate ' + n3(outW / w) + ' ' + n3(-outH / h) + ' scale',
  ];
  for (const shape of shapes) {
    lines.push(n3(shape.rgb[0] / 255) + ' ' + n3(shape.rgb[1] / 255) + ' ' + n3(shape.rgb[2] / 255) +
      ' setrgbcolor newpath');
    for (const sub of shape.subpaths) {
      if (!sub.length) continue;
      const start = sub[0].pts;
      lines.push(n3(start[0]) + ' ' + n3(start[1]) + ' moveto');
      let cur = [start[0], start[1]];
      for (let i = 1; i < sub.length; i++) {
        const op = sub[i];
        if (op.op === 'Q') {
          const c = qToCubic(cur, [op.pts[0], op.pts[1]], [op.pts[2], op.pts[3]]);
          lines.push(n3(c[0]) + ' ' + n3(c[1]) + ' ' + n3(c[2]) + ' ' + n3(c[3]) + ' ' +
            n3(c[4]) + ' ' + n3(c[5]) + ' curveto');
          cur = [c[4], c[5]];
        } else if (op.op === 'C') {
          lines.push(n3(op.pts[0]) + ' ' + n3(op.pts[1]) + ' ' + n3(op.pts[2]) + ' ' +
            n3(op.pts[3]) + ' ' + n3(op.pts[4]) + ' ' + n3(op.pts[5]) + ' curveto');
          cur = [op.pts[4], op.pts[5]];
        } else {
          lines.push(n3(op.pts[0]) + ' ' + n3(op.pts[1]) + ' lineto');
          cur = [op.pts[0], op.pts[1]];
        }
      }
      lines.push('closepath');
    }
    lines.push('eofill');
  }
  lines.push('showpage', '%%EOF');
  return lines.join('\n') + '\n';
}

module.exports = { fromTracedata, toSvg, toEps, countShapes };