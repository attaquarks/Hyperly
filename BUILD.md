# Hyperly — Build Notes

> The toolchain troubleshooting below is Windows-specific. On macOS, install
> Xcode Command Line Tools (`xcode-select --install`), then use the same
> `npm install` / `npm run tauri dev` / `npm run tauri build` commands —
> the bundle lands in `src-tauri/target/release/bundle/` as a `.app`/`.dmg`.

## Prerequisites

1. **Node.js 20+** and **npm 10+** (already installed).
2. **Rust toolchain** via `rustup` with both:
   - `stable-x86_64-pc-windows-msvc` (default)
   - `stable-x86_64-pc-windows-gnu` (auto-fallback)
3. **MinGW64** at `C:\\mingw64` (provides `gcc.exe`, `link.exe`, etc. for
   the GNU toolchain). The wrapper script auto-detects this.
4. **Microsoft Visual Studio Build Tools** with the C++ workload
   (optional — only needed if you use the MSVC toolchain).

## First-time setup

If `C:\\Users\\Atta\\.cargo\\bin` is not on your PATH yet, the
`npm run tauri` script auto-detects it via
`scripts/tauri-with-path.cjs`. No manual `set PATH=...` required.

If you want the cargo CLI on your PATH permanently (recommended):

```powershell
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($path -notlike '*\.cargo\bin*') {
  [Environment]::SetEnvironmentVariable(
    'Path', $path + ';C:\Users\Atta\.cargo\bin', 'User')
}
```

Then open a **fresh** terminal so the change takes effect.

## Run in dev mode

```powershell
cd <your-Hyperly-checkout>
npm install
npm run tauri dev
```

The wrapper script:
1. Prepends `C:\\Users\\Atta\\.cargo\\bin` to PATH.
2. If the active toolchain is MSVC and `link.exe` is missing, switches
   to the GNU toolchain and points CC/CXX/AR at MinGW64.
3. Spawns the real `@tauri-apps/cli` with the same arguments.

## Build a release MSI / EXE

```powershell
npm run tauri build
```

The output lands in `src-tauri\\target\\release\\bundle\\`.

## Security & asset configuration (read before touching CSP or the /vad runtime)

Three facts that only make sense together:

1. **`csp` vs `devCsp` differ on purpose** (`src-tauri/tauri.conf.json`). The
   production policy has no `'unsafe-inline'` in `script-src`; `devCsp` adds it
   because Vite's dev pipeline injects inline scripts. Keep the production
   string the stricter one — do not "align" them.
2. **The production CSP allows no remote assets, so the voice-activity runtime
   ships locally.** `public/vad/` carries the onnxruntime-web wasm/mjs, the
   Silero models and the audio worklet, copied byte-for-byte from
   `node_modules` — no CDN. `serveVadRuntime` in `vite.config.ts` serves the
   `.mjs` correctly under `vite dev`.
3. **Two guards keep (2) honest:**
   - `node scripts/vad-asset-serve-check.ts` — boots a real dev server and
     asserts every `/vad` asset is served intact.
   - `node scripts/vad-asset-provenance-check.ts` — hashes `public/vad` against
     `node_modules`, fails on drift, and requires `@ricky0123/vad-web` to be
     declared exactly as installed.

Also recorded so it is not re-litigated: `optimizeDeps` and `serveVadRuntime`
in `vite.config.ts` were audited in Phase 3 and their comments are accurate —
no change needed (P2Cbeta #11).

## Common issues

### `failed to get cargo metadata: program not found`

Means `cargo` was not on the spawn-time PATH. The wrapper fixes this
automatically. If you see it anyway, run `npm install` again so the
wrapper is in place, and confirm `node` is on PATH.

### `linker `link.exe` not found` (MSVC toolchain)

The wrapper will auto-switch to the GNU toolchain if MinGW64 is
present. If not, either:

- Install Visual Studio Build Tools with the C++ workload, OR
- Install MinGW64 (e.g. via MSYS2) and the GNU toolchain:
  ```powershell
  rustup toolchain install stable-x86_64-pc-windows-gnu
  ```

### JSON parse error in tauri.conf.json

Tauri uses strict JSON. No trailing commas, no comments. The current
config has been verified valid.

### First build is slow

`cargo` will download and compile ~300 crates on the first build
(15-25 minutes). Subsequent builds are incremental (seconds to
minutes).
