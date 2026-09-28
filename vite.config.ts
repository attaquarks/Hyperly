import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "node:fs";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// onnxruntime-web loads its runtime by URL, not by import specifier: with
// `onnxWASMBasePath: "/vad/"` (set in AutoSpeechVad and ListenUserMic) it
// fetches the .wasm and then dynamically imports "/vad/ort-wasm-simd-threaded.mjs".
// That second step is what breaks `vite dev`, because /vad is the public dir
// and Vite only lets public files be *fetched*, never put through the module
// pipeline:
//
//   Failed to load url /vad/ort-wasm-simd-threaded.mjs (resolved id: ...).
//   This file is in /public and will be copied as-is during build without
//   going through the plugin transforms ...
//
// The request does not reach Vite's own public-file handler even though the
// file is in public/. `servePublicMiddleware` steps aside whenever a request
// looks like an import (vite/dist/node/chunks/config.js), so the module is
// handed to transformMiddleware, which resolves it to a public file and
// throws ERR_LOAD_PUBLIC_URL. Both of ORT's own `import()` calls already carry
// `/*@vite-ignore*/`, so this is not a transform of anything it wrote — it is
// the browser fetching the asset and the dev server mistaking it for a graph
// edge.
//
// Registering the middleware directly here — rather than returning a function
// from `configureServer`, which Vite appends *after* its own — puts it ahead
// of the pipeline, so the file is served byte-for-byte as the plain asset it
// is. Only the .mjs glue is intercepted; the .wasm, the Silero models and the
// worklet are fetched rather than imported and already work.
//
// Production never needs this: `public/` is copied to the output as-is and the
// browser fetches from there, with no dev server in the path.
const serveVadRuntime = (): Plugin => {
  const isVadModule = (url: string): boolean =>
    /^\/vad\/[A-Za-z0-9._-]+\.mjs(?:\?.*)?$/.test(url);

  return {
    name: "hyperly:serve-vad-runtime",
    configureServer(server) {
      const dir = path.resolve(__dirname, "public/vad");
      server.middlewares.use((req, res, next) => {
        if (!req.url || !isVadModule(req.url)) return next();
        const file = path.join(dir, path.posix.basename(req.url.split("?")[0]));
        if (!file.startsWith(dir) || !fs.existsSync(file)) return next();
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Content-Length", fs.statSync(file).size);
        fs.createReadStream(file).pipe(res);
      });
    },
  };
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), serveVadRuntime()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Nothing belongs in `optimizeDeps.exclude` here.
  //
  // Pre-bundling is what converts a CommonJS package into something a browser
  // can evaluate, so anything excluded is served raw instead. That bit us two
  // ways, in the same corner of the app:
  //
  //   1. `@ricky0123/vad-web` is CJS-only — dist/index.js opens with
  //      `Object.defineProperty(exports, "__esModule", ...)`. Served raw, the
  //      browser was handed `exports`, which does not exist there, and every
  //      lazy import that reached it threw "exports is not defined": the
  //      Listen room's ListenUserMic and the Ask panel's AutoSpeechVad.
  //
  //   2. `onnxruntime-web` looks safe — its root entry is ESM
  //      (dist/ort.bundle.min.mjs). But its exports map also publishes
  //      CommonJS under the `require` condition ("./wasm" -> ort.wasm.min.js),
  //      and `@ricky0123/vad-web/dist/real-time-vad.js` — the module both of
  //      those components load — calls `require("onnxruntime-web/wasm")`.
  //      Excluded, that specifier was left external, and a CJS require() of an
  //      external cannot be expressed in ESM output, so esbuild emitted its
  //      `__require` shim, which throws
  //        Dynamic require of "onnxruntime-web/wasm" is not supported
  //
  // Both want pre-bundling, so both get it. The VAD runtime is still served
  // from public/ at load time via `baseAssetPath`/`onnxWASMBasePath` ("/vad/",
  // set in AutoSpeechVad and ListenUserMic), which is a runtime fetch and does
  // not depend on how the JS was bundled.
  //
  // `node scripts/dep-format-check.ts` guards this rule.
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
