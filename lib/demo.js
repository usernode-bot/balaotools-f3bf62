'use strict';

// The staging demo: six hand-written sample drawings as shapes, built through
// the same writers the tracer uses. Request-time injection only — nothing is
// stored, and no real data is involved.

const { toSvg, toEps } = require('./vector');

// Tiny parser for absolute SVG path commands (M L H V C Q Z), so the demo
// drawings can be written as ordinary path strings.
function parsePath(d) {
  const ops = [];
  const tokens = d.match(/[MLHVQCZ]|-?\d*\.?\d+/g) || [];
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  const last = () => ops[ops.length - 1].pts;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') ops.push({ op: 'M', pts: [num(), num()] });
    else if (cmd === 'L') ops.push({ op: 'L', pts: [num(), num()] });
    else if (cmd === 'H') ops.push({ op: 'L', pts: [num(), last()[1]] });
    else if (cmd === 'V') ops.push({ op: 'L', pts: [last()[0], num()] });
    else if (cmd === 'C') ops.push({ op: 'C', pts: [num(), num(), num(), num(), num(), num()] });
    else if (cmd === 'Q') ops.push({ op: 'Q', pts: [num(), num(), num(), num()] });
  }
  return ops;
}

function shape(rgb, ...subpaths) {
  return { rgb, subpaths: subpaths.map(parsePath) };
}

// A circle as four cubics (kappa 0.5523), since the shape model has no arcs.
function circle(cx, cy, r) {
  const k = 0.5523 * r;
  return 'M' + cx + ' ' + (cy - r) +
    'C' + (cx + k) + ' ' + (cy - r) + ' ' + (cx + r) + ' ' + (cy - k) + ' ' + (cx + r) + ' ' + cy +
    'C' + (cx + r) + ' ' + (cy + k) + ' ' + (cx + k) + ' ' + (cy + r) + ' ' + cx + ' ' + (cy + r) +
    'C' + (cx - k) + ' ' + (cy + r) + ' ' + (cx - r) + ' ' + (cy + k) + ' ' + (cx - r) + ' ' + cy +
    'C' + (cx - r) + ' ' + (cy - k) + ' ' + (cx - k) + ' ' + (cy - r) + ' ' + cx + ' ' + (cy - r) + 'Z';
}

// Times fixed to the wall clock of the request (a staging preview may be
// shown as of a chosen moment), so the list reads like the drawn screen.
const atToday = (now, hh, mm) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
const atYesterday = (now, hh, mm) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hh, mm, 0, 0);
const atDay = (now, day, hh, mm) => new Date(now.getFullYear(), now.getMonth(), day, hh, mm, 0, 0);

const WHITE = 'M0 0 H160 V160 H0 Z';

// A photo-like sample: a photograph posterises into hundreds of tiles, which
// is the kind of result the anchor overlay now leaves off by default. The
// tiles are deterministic, so the sample looks the same in every preview.
const MOSAIC = (() => {
  const art = [shape([255, 255, 255], WHITE)];
  const rects = [];
  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 16; col++) {
      const rgb = [
        50 + ((row * 11 + col * 5) * 7) % 180,
        45 + ((row * 6 + col * 13) * 5) % 190,
        60 + ((row * 17 + col * 7) * 3) % 170,
      ];
      const x = col * 10;
      const y = row * 10;
      art.push(shape(rgb, 'M' + x + ' ' + y + ' H' + (x + 10) + ' V' + (y + 10) + ' H' + x + ' Z'));
      rects.push('<rect x="' + x + '" y="' + y + '" width="10" height="10" fill="rgb(' +
        rgb.join(',') + ')"/>');
    }
  }
  return { art, svg: rects.join('') };
})();

const DEMOS = [
  {
    id: 'demo-1',
    filename: 'balloon-logo.png',
    when: (now) => atToday(now, 9, 12),
    art: [
      shape([191, 227, 245], WHITE),
      shape([228, 72, 59], 'M80 18C48 18 30 42 30 66C30 92 56 108 70 120H90C104 108 130 92 130 66C130 42 112 18 80 18Z'),
      shape([246, 201, 69], 'M80 18C66 18 58 42 58 66C58 92 70 108 74 120H86C90 108 102 92 102 66C102 42 94 18 80 18Z'),
      shape([138, 90, 52], 'M70 132 H90 V146 H70 Z'),
    ],
    // The drawn "original": the photo-like picture, strings included.
    originalSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
      '<rect width="160" height="160" fill="#BFE3F5"/>' +
      '<path d="M28 140C28 130 38 126 46 128C50 120 64 120 68 130C76 128 82 134 80 140Z" fill="#FFFFFF"/>' +
      '<path d="M80 18C48 18 30 42 30 66C30 92 56 108 70 120H90C104 108 130 92 130 66C130 42 112 18 80 18Z" fill="#E4483B"/>' +
      '<path d="M80 18C66 18 58 42 58 66C58 92 70 108 74 120H86C90 108 102 92 102 66C102 42 94 18 80 18Z" fill="#F6C945"/>' +
      '<path d="M70 120L72 132M90 120L88 132" stroke="#5B3A22" stroke-width="2"/>' +
      '<rect x="70" y="132" width="20" height="14" rx="2" fill="#8A5A34"/></svg>',
  },
  {
    id: 'demo-2',
    filename: 'kopi-cup-sketch.jpg',
    when: (now) => atToday(now, 8, 40),
    art: [
      shape([255, 255, 255], WHITE),
      shape([107, 68, 48],
        'M40 64 H112 V104C112 124 96 136 76 136C56 136 40 124 40 104Z',
        'M112 76 H122C136 76 136 100 122 100 H112 Z',
        'M118 80 H122C130 80 130 96 122 96 H118 Z'),
      shape([184, 169, 154], 'M60 52C60 36 72 44 72 24 Z', 'M88 52C88 36 100 44 100 24 Z'),
      shape([216, 210, 200], 'M32 140 H120 V148 H32 Z'),
    ],
    originalSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
      '<rect width="160" height="160" fill="#FFFDF8"/>' +
      '<path d="M40 64H112V104C112 124 96 136 76 136C56 136 40 124 40 104Z" fill="#6B4430"/>' +
      '<path d="M112 76H124C132 76 132 100 124 100H112" fill="none" stroke="#6B4430" stroke-width="10"/>' +
      '<path d="M60 52C60 36 72 44 72 24M88 52C88 36 100 44 100 24" fill="none" stroke="#B8A99A" stroke-width="8" stroke-linecap="round"/>' +
      '<path d="M36 144H124" stroke="#D8D2C8" stroke-width="8" stroke-linecap="round"/></svg>',
  },
  {
    id: 'demo-3',
    filename: 'leaf-stamp.png',
    when: (now) => atYesterday(now, 16, 5),
    art: [
      shape([255, 255, 255], WHITE),
      shape([62, 155, 95], 'M32 128C32 64 72 32 132 28C132 88 100 128 32 128Z'),
      shape([31, 94, 54], 'M30 130 L96 64 L102 68 L36 134 Z'),
    ],
    originalSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
      '<rect width="160" height="160" fill="#FBFCFA"/>' +
      '<path d="M32 128C32 64 72 32 132 28C132 88 100 128 32 128Z" fill="#3E9B5F"/>' +
      '<path d="M32 128L96 64" stroke="#1F5E36" stroke-width="6" stroke-linecap="round"/></svg>',
  },
  {
    id: 'demo-4',
    filename: 'star-badge-v2.png',
    when: (now) => atYesterday(now, 11, 30),
    art: [
      shape([29, 59, 110], circle(80, 80, 60)),
      shape([246, 201, 69], 'M80 37L91.2 66.6L122.8 68.1L98.1 87.9L106.5 118.4L80 101L53.5 118.4L61.9 87.9L37.2 68.1L68.8 66.6Z'),
    ],
    originalSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
      '<circle cx="80" cy="80" r="60" fill="#1D3B6E"/>' +
      '<path d="M80 37L91.2 66.6L122.8 68.1L98.1 87.9L106.5 118.4L80 101L53.5 118.4L61.9 87.9L37.2 68.1L68.8 66.6Z" fill="#F6C945"/></svg>',
  },
  {
    id: 'demo-5',
    filename: 'wave-pattern.jpg',
    when: (now) => atDay(now, 12, 19, 48),
    art: [
      shape([255, 255, 255], WHITE),
      shape([77, 179, 219], 'M16 32C40 8 56 56 80 32C104 8 120 56 144 32V56H16Z'),
      shape([42, 143, 184], 'M16 72C40 48 56 96 80 72C104 48 120 96 144 72V96H16Z'),
      shape([23, 96, 127], 'M16 104C40 80 56 128 80 104C104 80 120 128 144 104V128H16Z'),
    ],
    originalSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
      '<rect width="160" height="160" fill="#2A8FB8"/>' +
      '<path d="M0 32C24 8 40 56 64 32C88 8 104 56 128 32C144 16 152 24 160 32V40H0Z" fill="#4DB3DB"/>' +
      '<path d="M0 104C24 80 40 128 64 104C88 80 104 128 128 104C144 88 152 96 160 104V160H0Z" fill="#17607F"/></svg>',
  },
  {
    id: 'demo-6',
    filename: 'cat-doodle.png',
    when: (now) => atDay(now, 10, 14, 22),
    art: [
      shape([255, 255, 255], WHITE),
      shape([242, 165, 65], 'M40 136V72L32 32L60 56H100L128 32L120 72V136Z'),
      shape([43, 43, 43], circle(64, 88, 8), circle(96, 88, 8)),
    ],
    originalSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
      '<rect width="160" height="160" fill="#FFFFFF"/>' +
      '<path d="M40 136V72L32 32L60 56H100L128 32L120 72V136Z" fill="#F2A541"/>' +
      '<circle cx="64" cy="88" r="8" fill="#2B2B2B"/>' +
      '<circle cx="96" cy="88" r="8" fill="#2B2B2B"/>' +
      '<path d="M72 108H88L80 116Z" fill="#2B2B2B"/></svg>',
  },
  {
    id: 'demo-7',
    filename: 'staging-demo-photo.png',
    when: (now) => atDay(now, 8, 17, 25),
    art: MOSAIC.art,
    originalSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
      MOSAIC.svg + '</svg>',
  },
];

// Items ready for the client, built with the same writers the tracer uses.
function demoConversions(now) {
  return DEMOS.map((demo) => {
    const svg = toSvg(demo.art, 160, 160, 160, 160);
    const base = demo.filename.replace(/\.[a-z]+$/i, '');
    const eps = toEps(demo.art, 160, 160, 160, 160, base);
    return {
      id: demo.id,
      filename: demo.filename,
      createdAt: demo.when(now).toISOString(),
      width: 160,
      height: 160,
      shapes: demo.art.length,
      svg,
      eps,
      originalSvg: demo.originalSvg,
    };
  });
}

module.exports = { demoConversions };