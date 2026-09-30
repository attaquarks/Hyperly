// Build-time environment values are deliberately NOT forwarded to the compiler.
//
// This script used to read PAYMENT_ENDPOINT / API_ACCESS_KEY / APP_ENDPOINT /
// POSTHOG_API_KEY and emit them as `cargo:rustc-env=...`. That is the arming
// step for embedding secrets in the shipped binary: the value becomes part of
// the artifact the moment any source reads it with env!/option_env!. Phase 4
// R12 removed the mechanism; `scripts/secret-embedding-check.ts` guards it.
fn main() {
    tauri_build::build()
}
