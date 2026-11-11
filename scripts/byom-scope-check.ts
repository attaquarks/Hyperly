// Bring-your-own-model connectivity: local providers must be reachable.
//
// WHY THIS EXISTS
// ---------------
// Custom providers running on the user's own machine (freellmapi, Ollama,
// LM Studio — anything on http://localhost:PORT) were "failing on
// connectivity" from the dashboard. Traced root cause: every provider request
// goes through tauri-plugin-http (tauriFetch), whose scope is checked in Rust
// with URLPattern semantics. In URLPattern, an omitted port binds to the
// SCHEME DEFAULT — `http://**` matches http://host/ (port 80) but NOT
// http://localhost:3010/v1/chat/completions. Verified against the same
// urlpattern semantics: `new URLPattern("http://**").test("http://localhost:3010/x")`
// is false, while `http://**:*` is true. So the capability must carry the
// port-wildcard patterns too, or every BYOM server on a non-80 port is
// rejected at the scope gate before the request ever leaves the process.
//
// THIS SCRIPT asserts, on the real tree:
//   A. both capability files (default.json for macOS, cross-platform.json for
//      Windows/Linux) allow the port-wildcard forms;
//   B. the provider request paths use the Tauri client for http(s) URLs (the
//      scope is only consulted there; plain web fetch would hit CORS on local
//      servers that do not send CORS headers).
//
// Run with:  node --experimental-strip-types scripts/byom-scope-check.ts

import { readFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

const failures: string[] = [];
const assert = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

const CAPABILITIES = [
  "src-tauri/capabilities/default.json",
  "src-tauri/capabilities/cross-platform.json",
];

for (const cap of CAPABILITIES) {
  const source = read(cap);
  assert(source.length > 0, `${cap}: file missing`);
  for (const pattern of ["http://**", "https://**", "http://**:*", "https://**:*"]) {
    assert(
      source.includes(`"url": "${pattern}"`),
      `${cap}: the http scope must include "${pattern}" — without the port wildcard, every local BYOM server (freellmapi/Ollama/LM Studio on localhost:PORT) is rejected by the plugin scope (URLPattern binds an omitted port to the scheme default)`
    );
  }
}

// The request paths must go through the Tauri client, whose scope now allows
// local ports — a web fetch would hit CORS on servers that do not send the
// CORS headers, which is most local model servers.
const stt = read("src/lib/functions/stt.function.ts");
assert(
  /fetchImpl \?\? \(url\?\.includes\("http"\) \? tauriFetch : fetch\)/.test(stt),
  "stt.function.ts: STT requests must select the Tauri client for http(s) URLs"
);
const ai = read("src/lib/functions/ai-response.function.ts");
assert(
  /fetchImpl \?\? \(url\?\.includes\("http"\) \? tauriFetch : fetch\)/.test(ai),
  "ai-response.function.ts: AI requests must select the Tauri client for http(s) URLs"
);

if (failures.length > 0) {
  console.error(`FAIL - BYOM scope invariants broken (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  "PASS - BYOM connectivity: both capability files allow port-wildcard URLs\n" +
    "       (local servers on localhost:PORT reachable), and the provider\n" +
    "       request paths route through the Tauri HTTP client."
);
