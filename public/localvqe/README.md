# LocalVQE assets vendored for Hyperly

These files are bundled with Hyperly and served from the app's own `/localvqe/`
origin. They are not fetched from a third-party host at runtime. The selected
GTCRN-AEC compact model contains its own DAF front-end; no separate v1.4-AEC
front-end file is needed.

`localvqe-glue.mjs` is the pinned `localvqe.js` payload with an ESM default
export appended. The upstream file is a classic-script factory and has no ESM
export, so the worker uses this same-origin module instead of creating a blob
URL import. Production `script-src` permits same-origin modules but excludes
`blob:`; the shim keeps that CSP unchanged. The provenance guard verifies that
the shim is exactly the pinned glue plus its factory export. Vite does not
allow source modules to import JavaScript directly from `public/`; the worker
statically imports the Vite `?url` reference and dynamically imports that
same-origin module URL. This keeps the module under `script-src 'self'` without
creating a blob URL.

## Provenance

- Upstream repository: [localai-org/LocalVQE](https://github.com/localai-org/LocalVQE)
- Upstream source commit: [`35b116d5eb059d552fa46fac3ce2963ed13ce153`](https://github.com/localai-org/LocalVQE/commit/35b116d5eb059d552fa46fac3ce2963ed13ce153)
- Published build: upstream `pages.yml` at that commit, using Emscripten 4.0.23 and `bash web/build-wasm.sh`.
- Hyperly vendors the published WASM and glue; this checkout does not rebuild them.
- Model repository: [LocalAI-io/LocalVQE](https://huggingface.co/LocalAI-io/LocalVQE)
- Pinned model revision: [`29ca38495cba9d6393a92a4dd890f28dd81f758d`](https://huggingface.co/LocalAI-io/LocalVQE/tree/29ca38495cba9d6393a92a4dd890f28dd81f758d)
- Repository license metadata: Apache-2.0. The model weights are trained on the DNS Challenge dataset; attribution is required under CC-BY-4.0.

## Files and source hashes

| File | Bytes | Source | SHA-256 |
|---|---:|---|---|
| `localvqe.js` | 65,747 | <https://localai-org.github.io/LocalVQE/vendor/localvqe.js> | `a995cfa3fbf2a10aa61db8f6e85d8e8b2406309685ff4c5a05027e0fa0703222` |
| `localvqe-glue.mjs` | 65,792 | Derived from the pinned `localvqe.js` by appending `export { createLocalVQEModule as default };` | `ed2144b1d590afb0d3c6c54678af0ffaf8653d7b9236f6168d366e2be9288197` |
| `localvqe.wasm` | 999,408 | <https://localai-org.github.io/LocalVQE/vendor/localvqe.wasm> | `c367083af7e7d32c1f23d57605ac1b6a48b592a750fa5c39ca806ae8d3c46297` |
| `localvqe-pi-aec-v1-49k-f32.gguf` | 2,325,312 | <https://huggingface.co/LocalAI-io/LocalVQE/resolve/29ca38495cba9d6393a92a4dd890f28dd81f758d/localvqe-pi-aec-v1-49k-f32.gguf> | `b80b75b9038d0d28079a84afe7d4f0b8f6404f723af4633c05ed4f96fb30b7b8` |

## Model allowlist note

The compact GTCRN model hash is not present in upstream `kAllowed[]`. At the
pinned source commit, `make_ctx_gtcrn` loads it through `GtcrnGraph` and, when
the model embeds its DAF tensors, returns from that self-contained path before
the `load_graph_model_ex` call that enforces the allowlist. This exact model
loads in the shipped WASM without an allowlist override. Do not add a bypass or
ship the separate v1.4-AEC model for this configuration.
