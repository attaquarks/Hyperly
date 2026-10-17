import { safeLocalStorage } from "../storage/helper.ts";

export type AecStatus =
  | { state: "off" }
  | { state: "bypass"; reason: "no-reference" | "init-failed" | "overload" }
  | { state: "active"; model: string; refDelayMs: number; hops: number };

export interface MicAecSession {
  /** Stream supplied to vad-web; raw source in bypass, processed destination when active. */
  output: MediaStream;
  /** Original getUserMedia stream; teardown must stop this stream. */
  source: MediaStream;
  status: AecStatus;
  /** Start processing after mic acquisition; failures leave output on the raw source. */
  activate: (
    audioContext: AudioContext,
    referenceFeed: import("./reference.ts").AecReferenceFeed | null,
    onStatus?: (status: AecStatus | undefined) => void
  ) => Promise<void>;
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

export { createMicAec } from "./mic-aec.ts";
