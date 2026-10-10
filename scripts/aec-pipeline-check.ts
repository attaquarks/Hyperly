import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMicAec } from "../src/lib/aec/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hook = readFileSync(join(ROOT, "src/hooks/useVoiceInput.ts"), "utf8");

console.log("AEC pipeline - Step 0 bypass preserves the original mic stream");

const source = {} as MediaStream;
const enabled = createMicAec(source, true);
assert.strictEqual(enabled.output, source, "enabled bypass must return source identity");
assert.strictEqual(enabled.source, source, "session must retain the original source");
assert.deepEqual(enabled.status, { state: "bypass", reason: "no-reference" });
console.log("  ok    enabled bypass returns the exact source stream object");

const disabled = createMicAec(source, false);
assert.strictEqual(disabled.output, source, "disabled path must return source identity");
assert.strictEqual(disabled.source, source, "disabled session must retain the source");
assert.deepEqual(disabled.status, { state: "off" });
console.log("  ok    disabled path returns the exact source stream object");

assert.match(hook, /createMicAec\(source, readAecEnabled\(\)\)/);
assert.match(hook, /session\.source\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
assert.match(hook, /micAec\?\.source\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
console.log("  ok    microphone acquisition uses the saved toggle and teardown stops source");

console.log("PASS - the Step 0 AEC bypass is an identity-preserving no-op.");
