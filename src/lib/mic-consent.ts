/**
 * In-app microphone consent (Phase 4 R7, issue #12).
 *
 * The app must never open the microphone without an explicit, remembered
 * decision from the user. The Rust side (src-tauri/src/mic_permission.rs)
 * denies every WebView2 microphone request until `set_mic_consent(true)` has
 * been called, so this module is the single door:
 *
 *   * `getMicrophoneStream` (src/lib/microphone.ts) calls
 *     `requestMicConsent()` before its first `getUserMedia`, and
 *   * the prompt (`MicConsentDialog`, mounted at the app root) resolves the
 *     request and persists the answer under `mic_consent`.
 *
 * The Rust flag is process state, not storage, so `syncMicConsentToBackend()`
 * re-asserts the stored decision on every boot (main.tsx).
 */
import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "@/lib/storage";

export const MIC_CONSENT_STORAGE_KEY = "mic_consent";
const GRANTED = "granted";

type Listener = () => void;

const listeners = new Set<Listener>();
let pending: Array<(granted: boolean) => void> = [];
let promptOpen = false;

const emit = (): void => {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A broken subscriber must not take the prompt down with it.
    }
  });
};

/** True once the user has accepted the prompt at least once. */
export const hasMicConsent = (): boolean =>
  safeLocalStorage.getItem(MIC_CONSENT_STORAGE_KEY) === GRANTED;

/** Snapshot for `useSyncExternalStore` in the dialog. */
export const isMicConsentPromptOpen = (): boolean => promptOpen;

export const subscribeMicConsent = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Re-assert the stored decision on the Rust side. Called once per boot, since
 * the WebView2 handler starts denying again with every process.
 */
export const syncMicConsentToBackend = async (): Promise<void> => {
  try {
    await invoke("set_mic_consent", { granted: hasMicConsent() });
  } catch {
    // Non-fatal: capture paths will surface a refusal if the flag is wrong.
  }
};

/**
 * The single entry point every capture path goes through. Resolves `true`
 * immediately when consent is already stored; otherwise opens the prompt and
 * resolves with the user's answer. Resolves `false` on a decline.
 */
export const requestMicConsent = (): Promise<boolean> => {
  if (hasMicConsent()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    pending.push(resolve);
    promptOpen = true;
    emit();
  });
};

/** Called by the dialog with the user's answer. Persists and unblocks waiters. */
export const answerMicConsent = async (granted: boolean): Promise<void> => {
  promptOpen = false;
  if (granted) safeLocalStorage.setItem(MIC_CONSENT_STORAGE_KEY, GRANTED);
  try {
    await invoke("set_mic_consent", { granted });
  } catch {
    // Non-fatal, as above.
  }
  const waiters = pending;
  pending = [];
  waiters.forEach((resolve) => resolve(granted));
  emit();
};
