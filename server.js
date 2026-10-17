const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { toSvg, toEps, countShapes } = require('./lib/vector');
const { isPhoto, PHOTO_MAX_SIDE } = require('./lib/photo');
const { demoConversions } = require('./lib/demo');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ---------------------------------------------------------------------------
// Image tracing. An upload is decoded with sharp immediately, then traced in
// a worker thread (the tracer is synchronous and can take minutes), one at a
// time, FIFO. Results live in memory, belong to the user who uploaded them,
// and expire.
// ---------------------------------------------------------------------------

const MAX_UPLOAD = 30 * 1024 * 1024; // 30 MB
const TRACE_COLORS = 24; // the palette the tracer quantises down to
const TRACE_TIMEOUT_MS = 5 * 60 * 1000; // give up on a stuck trace
const RESULT_TTL_MS = 15 * 60 * 1000; // ready results expire after this
// The base trace options. The palette itself is not set here: the worker
// builds it from the image (lib/palette.js) — the tracer's own colour
// sampling misses small areas' colours and its k-means passes shift every
// colour, so `pal` comes from the histogram instead. `colorquantcycles` is
// set to 1 there too for the same reason. (`colorsampling` is dropped since
// the built palette replaces it; the old `blursize` was never a real option
// of this tracer and did nothing.)
const TRACE_OPTIONS = {
  numberofcolors: TRACE_COLORS,
  ltres: 1,
  qtres: 1,
  pathomit: 8,
  rightangleenhance: true,
};

const jobs = new Map(); // id -> job
const queue = []; // job ids waiting for the single worker slot

// sharp's raw pixel output -> ImageTracer's imagedata (flat RGBA).
function toImagedata(buffer, width, height) {
  return { width, height, data: new Uint8Array(buffer) };
}

// The trace dims and the display dims differ twice over: EXIF rotation can
// swap the axes, and the long side is capped at 2400 before tracing — except
// for photo-like images, which are classified from that decode and then
// downscaled far further (photos traced this size posterise into hundreds of
// smooth shapes; traced at full size they come out as tens of thousands of
// jagged per-pixel boxes).
async function decode(body) {
  const meta = await sharp(body).metadata();
  const swap = meta.orientation >= 5 && meta.orientation <= 8;
  const outW = swap ? meta.height : meta.width;
  const outH = swap ? meta.width : meta.height;
  const { data, info } = await sharp(body)
    .rotate()
    .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let trace = {
    imagedata: toImagedata(data, info.width, info.height),
    traceW: info.width,
    traceH: info.height,
  };
  let photo = false;
  if (isPhoto(trace.imagedata)) {
    photo = true;
    const downscaled = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .resize(PHOTO_MAX_SIDE, PHOTO_MAX_SIDE, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    trace = {
      imagedata: toImagedata(downscaled.data, downscaled.info.width, downscaled.info.height),
      traceW: downscaled.info.width,
      traceH: downscaled.info.height,
    };
  }
  return { photo, ...trace, outW, outH };
}

let running = null; // the job being traced right now, if any

function finishJob(job, patch) {
  clearTimeout(job.timer);
  job.worker = null;
  Object.assign(job, patch);
  job.imagedata = null; // pixels are only needed while tracing
  if (running === job) running = null;
  pump();
}

function pump() {
  if (running) return;
  const nextId = queue.shift();
  if (!nextId) return;
  const job = jobs.get(nextId);
  if (!job || job.status !== 'queued') return pump();
  running = job;
  job.status = 'tracing';
  const worker = new Worker(path.join(__dirname, 'lib', 'trace-worker.js'));
  job.worker = worker;
  job.timer = setTimeout(() => {
    // The tracer is synchronous inside the worker: a stuck one never answers,
    // so the only way out is to kill the thread.
    finishJob(job, { status: 'failed', error: 'timeout' });
    worker.terminate();
  }, TRACE_TIMEOUT_MS);
  worker.on('message', (msg) => {
    if (msg.error) return finishJob(job, { status: 'failed', error: 'trace_failed' });
    try {
      const svg = toSvg(msg.shapes, job.traceW, job.traceH, job.outW, job.outH);
      const eps = toEps(msg.shapes, job.traceW, job.traceH, job.outW, job.outH, job.title);
      finishJob(job, {
        status: 'ready',
        svg,
        eps,
        shapes: countShapes(msg.shapes),
        failedShapeless: countShapes(msg.shapes) === 0,
      });
    } catch {
      finishJob(job, { status: 'failed', error: 'trace_failed' });
    }
  });
  worker.on('error', () => finishJob(job, { status: 'failed', error: 'trace_failed' }));
  worker.on('exit', () => {
    // A worker that exits without a message (crash, timeout kill) fails its
    // job, unless the timeout or a message already resolved it.
    if (job.worker === worker && job.status === 'tracing') {
      finishJob(job, { status: 'failed', error: 'trace_failed' });
    }
  });
  worker.postMessage({
    imagedata: job.imagedata,
    options: job.photo ? { photo: true } : TRACE_OPTIONS,
  });
}

// Ready (and failed) results are transient: sweep the old ones every minute.
const sweeper = setInterval(() => {
  const cutoff = Date.now() - RESULT_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'queued' && job.status !== 'tracing' &&
        job.finishedAt && job.finishedAt < cutoff) {
      jobs.delete(id);
    }
  }
}, 60 * 1000);
sweeper.unref();

// Upload: decode now (fast), queue the expensive trace, answer 202. The
// client polls GET /api/trace/:id from here on. Only the raw bytes are
// accepted, so the JSON parser above never sees this body.
app.post('/api/trace', express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD }), async (req, res) => {
  const ctype = req.headers['content-type'] || '';
  if (!ctype.startsWith('application/octet-stream')) {
    return res.status(415).json({ error: 'unsupported_type' });
  }
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'no_file' });
  }
  // One trace at a time per user: a second upload while one is queued or
  // tracing is answered 409, so nobody piles up minutes-long jobs.
  const userId = req.user ? req.user.id : null;
  for (const job of jobs.values()) {
    if (job.userId === userId && (job.status === 'queued' || job.status === 'tracing')) {
      return res.status(409).json({ error: 'busy' });
    }
  }
  let decoded;
  try {
    decoded = await decode(req.body);
  } catch {
    return res.status(415).json({ error: 'unsupported_format' });
  }
  const job = {
    id: crypto.randomUUID(),
    userId,
    title: String(req.query.name || 'vector').slice(0, 80).replace(/[\r\n%]/g, ' '),
    status: 'queued',
    createdAt: req.now,
    finishedAt: null,
    photo: decoded.photo,
    imagedata: decoded.imagedata,
    traceW: decoded.traceW,
    traceH: decoded.traceH,
    outW: decoded.outW,
    outH: decoded.outH,
    svg: null,
    eps: null,
    shapes: 0,
    error: null,
    worker: null,
    timer: null,
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  pump();
  return res.status(202).json({ id: job.id });
});

app.get('/api/trace/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  // Someone else's job is nobody's job: 404, never its contents.
  if (!job || job.userId !== (req.user ? req.user.id : null)) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (job.status === 'queued') {
    return res.json({ status: 'queued', position: queue.indexOf(job.id) + 1 });
  }
  if (job.status === 'tracing') return res.json({ status: 'tracing' });
  job.finishedAt = job.finishedAt || Date.now();
  if (job.status === 'failed') {
    return res.json({ status: 'failed', error: job.error || 'failed' });
  }
  return res.json({
    status: 'ready',
    svg: job.svg,
    eps: job.eps,
    width: job.outW,
    height: job.outH,
    shapes: job.shapes,
  });
});

// The staging demo: six hand-drawn samples injected at request time, only on
// staging and only when the page asks for them (?demo=1). Nothing is stored.
// The samples ride in the page itself (window.USERNODE_DEMO), so the demo
// screen renders the same for signed-out check and preview loads as for
// signed-in ones — no API round-trip, and nothing in production sees this.
app.get('/', (req, res, next) => {
  if (!IS_STAGING || req.query.demo !== '1') return next();
  const shell = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  // `<` escaped so a closing script tag inside a sample could never end the
  // bootstrap early.
  const demo = JSON.stringify(demoConversions(req.now)).replace(/</g, '\\u003c');
  const boot = '<script>window.USERNODE_DEMO=' + demo + ';</script>';
  const withDemo = shell.replace('<script src="/app.js" defer></script>',
    boot + '\n  <script src="/app.js" defer></script>');
  return res.send(withDemo);
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/balaotools-f3bf62/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/balaotools-f3bf62/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Body-parser errors (an oversized upload is the expected one here) mapped
// to the codes the client knows; everything else is logged and kept generic.
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'too_large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_request' });
  }
  console.error(err);
  return res.status(500).json({ error: 'internal' });
});

async function start() {
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The platform stops the container with SIGTERM: close the listener and
  // stop any running trace, then leave (the queue is memory-only by design).
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('Shutting down');
    server.close(() => process.exit(0));
    for (const job of jobs.values()) {
      if (job.worker) {
        clearTimeout(job.timer);
        job.worker.terminate();
      }
    }
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

start().catch(err => { console.error(err); process.exit(1); });