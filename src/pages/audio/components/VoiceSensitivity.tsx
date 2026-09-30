import { Header, Slider } from "@/components";
import { useState } from "react";
import {
  DEFAULT_VAD_CONFIG,
  persistVadConfig,
  readStoredVadConfig,
  voiceSensitivityPercent,
  type VadConfig,
} from "@/lib/vad-config";

// Voice sensitivity is the one control over how quiet speech can be and still
// register. It writes the shared VAD config, which both halves of the voice
// pipeline read: the Rust capture loop receives it through `update_vad_config`
// (and again on every capture start), and the browser-side microphone derives
// its vad-web detection thresholds from the same field in `useVoiceInput`.
//
// The value is persisted to localStorage unconditionally and to the engine on a
// best-effort basis, so a Rust-side failure still leaves the setting applied for
// the browser mic and still visible when this page reloads.
export const VoiceSensitivity = () => {
  const [config, setConfig] = useState<VadConfig>(readStoredVadConfig);
  const [engineWarning, setEngineWarning] = useState("");

  const percent = voiceSensitivityPercent(config);
  const isDefault = percent === voiceSensitivityPercent(DEFAULT_VAD_CONFIG);

  const commit = (next: VadConfig) => {
    setConfig(next);
    void persistVadConfig(next)
      .then(() => setEngineWarning(""))
      .catch((error) => {
        console.error("Failed to update VAD config:", error);
        setEngineWarning(
          "Saved, but the audio engine did not acknowledge it — the new value applies from the next capture start."
        );
      });
  };

  return (
    <div className="space-y-3">
      <Header
        title="Voice Sensitivity"
        description="How quiet speech can be and still be detected — it applies to your microphone and to system-audio capture. Raise it to catch softer speech, lower it when background noise keeps triggering."
      />

      <div className="rounded-md border border-input/50 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Sensitivity</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {percent}%
          </span>
        </div>

        <Slider
          value={[percent]}
          onValueChange={([value]) =>
            commit({ ...config, voice_sensitivity: value / 100 })
          }
          min={0}
          max={100}
          step={5}
          aria-label="Voice sensitivity"
        />

        <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
          <span>Only loud, clear speech</span>
          <span>Catches quiet speech</span>
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-muted-foreground/70">
            {isDefault
              ? "Default"
              : `Default is ${voiceSensitivityPercent(DEFAULT_VAD_CONFIG)}%`}
          </span>
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40 disabled:hover:text-muted-foreground disabled:hover:no-underline"
            onClick={() =>
              commit({
                ...config,
                voice_sensitivity: DEFAULT_VAD_CONFIG.voice_sensitivity,
              })
            }
            disabled={isDefault}
          >
            Reset
          </button>
        </div>

        {engineWarning && (
          <p className="text-xs text-amber-500 bg-amber-500/10 p-3 rounded-md">
            {engineWarning}
          </p>
        )}
      </div>
    </div>
  );
};
