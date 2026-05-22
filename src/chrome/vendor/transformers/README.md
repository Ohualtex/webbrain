# Vendored @huggingface/transformers

The WebGPU provider (`src/providers/webgpu.js`) loads the in-browser ONNX
runtime via `@huggingface/transformers`. The relevant build files are
committed in this directory so the extension works straight from a
fresh `git clone` — no per-developer vendoring step.

## What's here

| File / dir | Source | Purpose |
| --- | --- | --- |
| `transformers.web.js` | `node_modules/@huggingface/transformers/dist/` | Browser ESM bundle, UNMINIFIED (patched, see below) |
| `ort.webgpu.mjs` | `node_modules/onnxruntime-web/dist/` | WebGPU backend, UNMINIFIED (~662KB) |
| `onnxruntime-common/` (21 files) | `node_modules/onnxruntime-common/dist/esm/` | `Tensor` + session types, imported by transformers.web.js (~85KB total) |
| `ort-wasm-simd-threaded.jsep.mjs` | `node_modules/onnxruntime-web/dist/` | WASM-CPU fallback loader |
| `ort-wasm-simd-threaded.jsep.wasm` | `node_modules/onnxruntime-web/dist/` | WASM-CPU runtime (~25MB) |

**Why unminified.** Chrome Web Store and AMO require readable source for
review; minified blobs can get review delays or outright rejection.
The unminified builds are larger (1.1MB vs 422KB for transformers,
662KB vs 111KB for the webgpu backend) but still well within the
extension package budget, and they don't impact runtime — the browser
just sees more JS to parse, which is microseconds.

The `.web.js` build is the browser ESM variant — not
`transformers.js` (dual ESM/CJS), not `transformers.node.*`. The
import path in `src/offscreen/offscreen.js` is hard-coded to
`transformers.web.js`; if you change which build is vendored, update
that import.

### Patch: rewrite the bare specifiers

The upstream `transformers.web.js` contains TWO bare module specifiers
the browser can't resolve without an import map or a bundler — MV3's
CSP (`script-src 'self'`) can block inline import maps on some Chrome
versions, so we patch both at vendoring time:

```bash
# 1. onnxruntime-web's WebGPU backend
sed -i 's|"onnxruntime-web/webgpu"|"./ort.webgpu.mjs"|' \
  src/chrome/vendor/transformers/transformers.web.js

# 2. onnxruntime-common (Tensor + session types). transformers.web.js
#    has `import { Tensor } from "onnxruntime-common";`. We vendor the
#    onnxruntime-common ESM tree under ./onnxruntime-common/ and point
#    the import at its index.js.
sed -i 's|"onnxruntime-common"|"./onnxruntime-common/index.js"|' \
  src/chrome/vendor/transformers/transformers.web.js
```

Each occurs exactly once per release (a third hit for the
`@huggingface/transformers` literal at line ~10667 is inside a JSDoc
example string, not a real import — leave it). After sed-ing, verify:

```bash
grep -E '(import|export)[^"]*from\s+"[a-zA-Z@]' \
  src/chrome/vendor/transformers/transformers.web.js \
  | grep -v '^\s*//' | grep -v '^\s*\*'
# expected: empty output
```

## Current vendored version

| webbrain | @huggingface/transformers | onnxruntime-web |
| --- | --- | --- |
| 7.4.0+ | 4.2.0 | (matched, transitive dep of transformers) |

## Updating

```bash
npm install @huggingface/transformers@latest
cp node_modules/@huggingface/transformers/dist/transformers.web.js \
   src/chrome/vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort.webgpu.mjs \
   src/chrome/vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs \
   src/chrome/vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm \
   src/chrome/vendor/transformers/

# onnxruntime-common (21 small .js files, ~85KB) — wholesale-copy
# the ESM tree.
rm -rf src/chrome/vendor/transformers/onnxruntime-common
mkdir  src/chrome/vendor/transformers/onnxruntime-common
cp node_modules/onnxruntime-common/dist/esm/*.js \
   src/chrome/vendor/transformers/onnxruntime-common/

# Re-apply the bare-specifier patches:
sed -i 's|"onnxruntime-web/webgpu"|"./ort.webgpu.mjs"|' \
  src/chrome/vendor/transformers/transformers.web.js
sed -i 's|"onnxruntime-common"|"./onnxruntime-common/index.js"|' \
  src/chrome/vendor/transformers/transformers.web.js
```

Then bump the version row in the table above, commit, and re-run the
extension to verify Qwen 3 still loads.

## Why vendored and not loaded from a CDN?

Manifest V3 extensions' CSP is `script-src 'self' 'wasm-unsafe-eval'`.
Remote scripts (`<script src="https://cdn...">` or dynamic-imported
remote URLs) are blocked. The Chrome Web Store will also reject a
manifest that loosens this to allow remote scripts. Vendoring is the
only path.

## Runtime configuration

`offscreen.js` configures the library to:

- Fetch model weights from the HuggingFace CDN (`allowRemoteModels = true`).
- Cache them in IndexedDB (the library's default — first-run downloads
  big, subsequent runs are instant).
- Pin `env.backends.onnx.wasm.wasmPaths` to this directory's
  `chrome-extension://` URL so the runtime finds the `.wasm` file
  reliably regardless of how the library is bundled.

If a future library version changes the `env.backends.onnx.wasm` shape,
the `wasmPaths` setter is wrapped in a try/catch — failure falls back
to the library's own resolution heuristics.

## Files NOT vendored (and why)

- `transformers.min.js` / `transformers.js` (dual ESM/CJS builds) —
  redundant with the `.web.js` we use; the dual variants embed Node-
  only code paths we never reach.
- `transformers.node.*` — Node runtime, unused.
- `ort.webgpu.bundle.*.mjs` — the "bundle" variants inline the WebGPU
  backend into a single file but are minified only. We use the plain
  `ort.webgpu.mjs` (unminified, non-bundle) instead since the bare
  imports it'd need (Node-only `node:fs` etc.) never fire in browsers.
- `ort-wasm-simd-threaded.asyncify.wasm` / `.jspi.wasm` / plain `.wasm` —
  CPU fallback variants. Adding them would let the provider fall back
  to WASM-CPU when WebGPU is absent, but for now we surface a clear
  "WebGPU not available" error instead. Add these later if we want
  CPU fallback for systems without WebGPU.
