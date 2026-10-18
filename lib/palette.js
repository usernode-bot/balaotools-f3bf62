'use strict';

// Palette construction for the tracer. A tracer's own colour sampling picks
// palette entries on a position grid and then averages them with clustering
// passes, so a colour that covers little of the image — a small dot, a thin
// stroke — never gets an entry, and every colour drifts toward its
// neighbourhood's average. Both wreck fidelity. Instead: histogram the pixels
// and seed the palette with a count-weighted farthest-point walk — exact
// source colours, common ones first, rare-but-distinct ones still kept — and
// hand it to the engine as a fixed palette so nothing is re-quantised.

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
function paletteFromCounts(counts, n) {
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

function buildPalette(imgd, n) {
  return paletteFromCounts(histogram(imgd), n);
}

// The built palette as the engine takes it: one "#RRGGBB" string per colour,
// opaque entries only (transparent pixels are left unpainted rather than
// given a colour), deduped — buildPalette pads with the dominant colour when
// an image has fewer distinct colours than asked for, which the fixed
// palette has no use for.
//
// Colours covering fewer than the engine's minimum patch (~8 px) are left
// out entirely: they can never form a region of their own, so a palette slot
// spent on one is wasted — and worse, its blend shade can become the colour
// the engine paints a small feature with instead of the feature's own colour
// (a 3-px dot once traced as its anti-aliased ring's blend, not its core).
//
// The cut runs on FOLDED totals, not per shade. A lossy encoding shatters
// one colour into many one-pixel shades a few steps apart, and a per-shade
// cut would kill every one of them — erasing the feature instead of keeping
// it. So each shade first folds into a 5-bit-per-channel bucket (the
// representative is the bucket's most common exact shade) and the minimum
// applies to the folded total. That separates the two look-alikes: an
// anti-aliased ring's shades SCATTER along the boundary between its two real
// colours, so each bucket collects only a sliver of the ring, while a
// shattered feature's shades CLUSTER tightly and re-coalesce into buckets
// worth a whole patch. The threshold is one pixel over the engine's minimum
// (9), so a 3x3 exact patch still earns its slot while a ring sliver does
// not. The threshold is on actual pixels, so the sample-count cut follows
// the histogram stride.
const MIN_PATCH_PX = 9;

function hexPalette(imagedata, n) {
  const stride = Math.max(1,
    Math.round(Math.sqrt((imagedata.width * imagedata.height) / 300000)));
  const min = Math.max(1, Math.ceil(MIN_PATCH_PX / (stride * stride)));
  const raw = histogram(imagedata);
  // Bucket key: five bits per channel (round to the nearest multiple of 8,
  // so a shade and its ±3-step neighbours share a bucket) plus the opaque
  // bit. Each bucket remembers its most common exact shade — that shade
  // becomes the entry the engine sees.
  const buckets = new Map();
  raw.forEach((c, key) => {
    const r = (key >>> 24) & 255, g = (key >>> 16) & 255,
      b = (key >>> 8) & 255, a = key & 255;
    const bk = (((a >>> 7) << 15) | (Math.min(31, Math.round(r / 8)) << 10) |
      (Math.min(31, Math.round(g / 8)) << 5) |
      Math.min(31, Math.round(b / 8))) >>> 0;
    const e = buckets.get(bk);
    if (!e) buckets.set(bk, { total: c, bestN: c, bestKey: key });
    else {
      e.total += c;
      if (c > e.bestN) { e.bestN = c; e.bestKey = key; }
    }
  });
  const counts = new Map();
  buckets.forEach((e) => {
    if (e.total >= min) counts.set(e.bestKey, e.total);
  });
  // An image whose every colour is rare (heavy noise) would empty the
  // palette: fall back to all of them rather than nothing.
  if (counts.size === 0) buckets.forEach((e) => counts.set(e.bestKey, e.total));
  return toHex(counts, n);
}

// The photo path's palette: a plain farthest-point spread over the raw
// histogram — no folding, no minimum. A photo has no exact colours to
// protect; its noise shades have tiny counts, so the count-weighted walk
// passes them over, while folding would sum the noise into bucket totals
// and buy those shades palette slots, fragmenting the trace.
function spreadHexPalette(imagedata, n) {
  return toHex(histogram(imagedata), n);
}

// A built palette as "#RRGGBB" strings: opaque entries only (transparent
// pixels are left unpainted rather than given a colour), deduped —
// paletteFromCounts pads with the dominant colour when an image has fewer
// distinct colours than asked for, which a fixed palette has no use for.
function toHex(counts, n) {
  const seen = new Set();
  const hex = [];
  for (const c of paletteFromCounts(counts, n)) {
    if (c.a < 128) continue;
    const s = [c.r, c.g, c.b]
      .map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    if (!seen.has(s)) { seen.add(s); hex.push('#' + s); }
  }
  return hex;
}

module.exports = {
  buildPalette, hexPalette, spreadHexPalette, histogram, paletteFromCounts,
};
