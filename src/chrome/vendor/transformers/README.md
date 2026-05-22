# Vendored @huggingface/transformers

The WebGPU provider (`src/providers/webgpu.js`) loads the in-browser ONNX
runtime via `@huggingface/transformers`. The build is too large
(~5MB JS + a ~30MB onnxruntime-web WASM blob) to commit to the repo, so
it's vendored out-of-band.

## How to drop the build in

```bash
# From the repo root:
npm install @huggingface/transformers      # or: pnpm / yarn

# Copy the ESM bundle + the onnxruntime-web WASM files into both
# chrome and firefox vendor dirs.
cp node_modules/@huggingface/transformers/dist/transformers.min.js \
   src/chrome/vendor/transformers/
cp node_modules/@huggingface/transformers/dist/transformers.min.js \
   src/firefox/vendor/transformers/

# onnxruntime-web ships its WASM separately. Copy the matching version:
cp node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.* \
   src/chrome/vendor/transformers/
cp node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.* \
   src/firefox/vendor/transformers/
```

The exact filename / path of the build inside `dist/` shifts between
library versions — check what's there. The provider tries to import
`transformers.min.js`; if you rename the build, update
`src/offscreen/offscreen.js`'s `await import('../../vendor/transformers/transformers.min.js')`
call to match.

## Why not bundle this ourselves?

We could, but:

- The library is already a single-file ESM bundle out of `npm publish` —
  no further bundling step buys us much.
- Keeping it out of git keeps the repo small and the diff history
  readable. Build artifacts don't belong in source.
- Updating the library means updating ONE file in each vendor dir.

## Why vendored and not loaded from a CDN?

Manifest V3 extensions' CSP is `script-src 'self' 'wasm-unsafe-eval'`.
Remote scripts (`<script src="https://cdn...">` or dynamic-imported
remote URLs) are blocked. The Chrome Web Store will also reject a
manifest that loosens this to allow remote scripts. Vendoring is the
only path.

## Runtime configuration

`offscreen.js` configures the library to fetch model weights from the
HuggingFace CDN (`allowRemoteModels = true`) and to cache them in
IndexedDB (the library's default). First-run for Qwen 3 0.6B q4 is
roughly 500MB; subsequent runs are instant.

If you need to pin the onnxruntime WASM location (e.g. because the
library's auto-detection picks the wrong path), set
`env.backends.onnx.wasm.wasmPaths` in `offscreen.js` to a
chrome-extension:// URL pointing at the vendor dir. Document any such
override here when you make it.

## Versions tested

| webbrain | @huggingface/transformers | notes |
| --- | --- | --- |
| 7.4.0  | (TBD, fill in when first vendored) | First release with WebGPU provider |
