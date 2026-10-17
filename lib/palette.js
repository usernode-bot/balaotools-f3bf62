'use strict';

// Palette construction for the tracer. imagetracerjs's own colour sampling
// (colorsampling 2) picks palette entries on a position grid and then averages
// them with k-means passes, so a colour that covers little of the image — a
// small dot, a thin stroke — never gets an entry, and every colour drifts
// toward its neighbourhood's average. Both wreck fidelity. Instead: histogram
// the pixels and seed the palette with a count-weighted farthest-point walk —
// exact source colours, common ones first, rare-but-distinct ones still kept —
// and run the tracer with a single quantisation pass so nothing is averaged
// afterwards.

// Weighted histogram of sampled pixels (the stride keeps the sample around
// 300k pixels on any input size). Fully transparent pixels share one corner
// of the colour cube so they form a single transparent entry.
function histogram(imgd) {
  const { data, width, height } = imgd;
  const stride = Math.max(1, Math.round(Math.sqrt((width * height) / 300000)));
  const counts = new Map();
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      let r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) { r = 0; g = 0; b = 0; a = 0; }
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

// Farthest-point seeding, weighted by how much of the image each colour
// covers (sqrt so a hundredfold-larger region still loses to a genuinely far
// colour): score = distance to the chosen set * sqrt(count). Distances are
// rectilinear RGBA, the same measure the tracer itself quantises with.
function buildPalette(imgd, n) {
  const counts = histogram(imgd);
  const colors = [];
  counts.forEach((c, key) => colors.push({
    n: c,
    r: (key >>> 24) & 255, g: (key >>> 16) & 255, b: (key >>> 8) & 255, a: key & 255,
  }));
  const dist = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) +
    Math.abs(a.b - b.b) + Math.abs(a.a - b.a);
  // Seed with the most common colour, then repeatedly take the colour with
  // the best distance-times-coverage score. Each colour's distance to the set
  // is kept incremental, so the whole walk is O(distinct colours * palette).
  const nearest = new Float64Array(colors.length).fill(Infinity);
  let first = 0, firstN = -1;
  for (let i = 0; i < colors.length; i++) {
    if (colors[i].n > firstN) { firstN = colors[i].n; first = i; }
  }
  const pal = [];
  const add = (idx) => {
    const c = colors[idx];
    pal.push({ r: c.r, g: c.g, b: c.b, a: c.a });
    for (let i = 0; i < colors.length; i++) {
      const d = dist(colors[i], c);
      if (d < nearest[i]) nearest[i] = d;
    }
  };
  add(first);
  while (pal.length < n) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < colors.length; i++) {
      const score = nearest[i] * Math.sqrt(colors[i].n);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    // Every remaining colour is already in the palette: stop rather than
    // pick one arbitrarily.
    if (best < 0 || bestScore <= 0) break;
    add(best);
  }
  // Fewer distinct colours than asked for: fill the rest with the dominant
  // colour. The tracer walks one layer per entry, so duplicates are harmless
  // (they trace as overlapping same-coloured shapes, which draw nothing new).
  while (pal.length < n) pal.push({ ...pal[0] });
  return pal;
}

// The options for one trace: the caller's base, the built palette, and a
// single quantisation pass — cycles > 1 re-averages the palette toward pixel
// clusters, which is the colour drift this module exists to prevent.
function traceOptions(imagedata, base) {
  return {
    ...base,
    colorquantcycles: 1,
    pal: buildPalette(imagedata, base.numberofcolors),
  };
}

module.exports = { buildPalette, traceOptions };
