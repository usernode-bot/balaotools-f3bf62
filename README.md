# BalaoTools

Turn an image into vector files the group can download. Pick a PNG, JPEG,
WebP or GIF (up to 30 MB); the app traces it into coloured shapes on its
own server, shows the original and the traced vector side by side, and
offers the result as **SVG** and **EPS**, named after the image.

## How it works

- **Tracing** runs on the server: `sharp` decodes the upload (EXIF
  rotation applied, long edge capped at 2400 px), then `vtracer`
  (WASM build of the Rust vectorizer) runs in a worker thread, one
  trace at a time per process (a second upload from the same user gets
  a `busy` answer while one is running). Photos are downscaled and
  lightly blurred first so they trace into smooth posterised shapes
  instead of mosaics. A trace that takes longer than five minutes is
  stopped; finished results are kept for fifteen minutes and then
  dropped.
- **Downloads** are built from the traced shapes by `lib/vector.js`:
  SVG paths with `fill-rule="evenodd"`, and an EPSF-3.0 PostScript file
  with the same shapes (quadratic curves become cubic ones).
- **The recent list** (last 12 conversions) lives on this device in
  IndexedDB — nothing about your images is stored server-side beyond the
  fifteen-minute result cache.
- **Staging demo**: `/?demo=1` shows seven sample conversions with the
  demo note above the list. `server.js` injects the samples into the
  page itself while `IS_STAGING` (production never sees the route);
  nothing is stored and nothing ships in the production HTML.

## Layout

- `public/index.html` — the one screen; `public/app.js` wires it
- `server.js` — auth, upload/trace/poll API, demo route
- `lib/vector.js` — shapes → SVG/EPS writers; `lib/vtrace.js` — the
  vtracer engine bridge; `lib/photo.js` — the photo pipeline;
  `lib/palette.js` — palette construction; `lib/trace-worker.js` —
  the tracing worker; `lib/demo.js` — the staging demo shapes
- `styles/tailwind-input.css` + `tailwind.config.js` — the design kit
  (`npm run build` compiles `public/tailwind.css`)

## Tests

`npm test` runs the writer tests (`test/vector.test.js`), the trace
pipeline tests (`test/trace.test.js`) and the photo pipeline tests
(`test/photo.test.js`).
The screens in `dapp.json` are checked by the platform.

Both declared checks set `allowConsoleErrors`: the centrally hosted
bridge looks up `api/public/app-host?host=<the host>` on the platform,
and for the loopback host the local checks run against that lookup gets
a 404 from the platform. On real staging and production hosts the
lookup resolves and the pages load with no console errors.