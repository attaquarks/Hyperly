import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "@/lib/storage";

/**
 * Voice-activity-detector configuration, mirrored field-for-field by the
 * `VadConfig` struct in src-tauri/src/speaker/commands.rs.
 *
 * This lives in `lib` rather than in `useSystemAudio` because two surfaces
 * write it — the Listen panel and the Audio Settings page — and they must not
 * drift. Anything that reads or writes VAD settings goes through the helpers
 * below so the overlay and the dashboard can never disagree about the value.
 */
export interface VadConfig {
  enabled: boolean;
  hop_size: number;
  sensitivity_rms: number;
  /**
   * Voice sensitivity, 0.0-1.0. One control over the adaptive RMS threshold
   * the Rust VAD loop already computes: higher means quieter speech counts.
   * 0.5 is the tuned default. Mirrors `voice_sensitivity` in the Rust struct.
   */
  voice_sensitivity: number;
  silence_chunks: number;
  min_speech_chunks: number;
  pre_speech_chunks: number;
  noise_gate_threshold: number;
  max_recording_duration_secs: number;
}

export const VAD_CONFIG_STORAGE_KEY = "vad_config";

/**
 * Tuned defaults — matches the backend (`VadConfig::default()` in
 * src-tauri/src/speaker/commands.rs) field-for-field, `enabled` included.
 *
 * The capture engine is always the Rust VAD loop: every start forces
 * `enabled: true` onto the spawn payload (see `currentSpawnVadConfig` in
 * useSystemAudio.ts), so this flag does not pick a loop type. It stays in the
 * mirror so the two structs cannot drift (Phase 4 R10).
 */
export const DEFAULT_VAD_CONFIG: VadConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.012, // Much less sensitive - only real speech
  voice_sensitivity: 0.5, // Midpoint - the tuned threshold, unchanged
  /**
   * Kept for payload/mirror compatibility only (Phase 4 R1). The capture loop
   * derives its effective threshold from `TURN_HANGOVER_MS` (2000 ms) and the
   * live sample rate via `silence_chunks_for`, so this field no longer changes
   * behaviour at any sample rate; 94 is what that derivation yields at 48 kHz.
   * A stored config with the old 45 is therefore harmless.
   */
  silence_chunks: 94,
  min_speech_chunks: 7, // ~0.16s - captures short answers
  pre_speech_chunks: 12, // ~0.27s - enough to catch word start
  noise_gate_threshold: 0.003, // Stronger noise filtering
  max_recording_duration_secs: 180, // 3 minutes default
};

/**
 * Read the stored config, merged over the defaults.
 *
 * The merge (rather than returning the parsed object outright) is what makes
 * this safe across schema changes: a config written before a field existed
 * would otherwise load with that field `undefined` and bind a slider to NaN.
 * That is exactly what happened when `peak_threshold` became
 * `voice_sensitivity` — every existing user had a stored object without the
 * new key.
 */
export const readStoredVadConfig = (): VadConfig => {
  const raw = safeLocalStorage.getItem(VAD_CONFIG_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_VAD_CONFIG };
  try {
    return { ...DEFAULT_VAD_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_VAD_CONFIG };
  }
};

/**
 * Write the config to both stores: localStorage, so the UI reloads with it,
 * and the Rust engine, so the running loop picks it up on the next capture
 * start. Both are needed — the engine reads the spawn payload, not storage.
 */
export const persistVadConfig = async (config: VadConfig): Promise<void> => {
  safeLocalStorage.setItem(VAD_CONFIG_STORAGE_KEY, JSON.stringify(config));
  await invoke("update_vad_config", { config });
};

/** The percentage the slider shows for a config's voice sensitivity. */
export const voiceSensitivityPercent = (config: VadConfig): number =>
  Math.round(config.voice_sensitivity * 100);
