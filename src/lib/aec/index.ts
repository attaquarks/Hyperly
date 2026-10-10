import { safeLocalStorage } from "../storage/helper.ts";

export type AecStatus =
  | { state: "off" }
  | { state: "bypass"; reason: "no-reference" | "init-failed" | "overload" }
  | { state: "active"; model: string; refDelayMs: number; hops: number };

export interface MicAecSession {
  /** Stream supplied to vad-web. Step 0 always returns the original stream. */
  output: MediaStream;
  /** Original getUserMedia stream; teardown must stop this stream. */
  source: MediaStream;
  status: AecStatus;
  dispose: () => void;
}

export const AEC_ENABLED_STORAGE_KEY = "hyperly.aec.enabled";
export const DEFAULT_AEC_ENABLED = true;

export const readAecEnabled = (): boolean => {
  const stored = safeLocalStorage.getItem(AEC_ENABLED_STORAGE_KEY);
  if (stored === null) return DEFAULT_AEC_ENABLED;
  return stored === "true";
};

export const writeAecEnabled = (enabled: boolean): void => {
  safeLocalStorage.setItem(AEC_ENABLED_STORAGE_KEY, String(enabled));
};

/**
 * Step 0 deliberately has no processing stage: vad-web receives the exact
 * MediaStream returned by getUserMedia. Keeping source alongside output now
 * makes teardown correct when a later step introduces a destination stream.
 */
export const createMicAec = (
  source: MediaStream,
  enabled = readAecEnabled()
): MicAecSession => ({
  output: source,
  source,
  status: enabled ? { state: "bypass", reason: "no-reference" } : { state: "off" },
  dispose: () => {},
});
