# Hyperly (Windows-only) — Build Notes

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
cd C:\Users\Atta\Documents\Projects\Hyperly
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
