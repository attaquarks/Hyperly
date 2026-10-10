import { Channel, invoke } from "@tauri-apps/api/core";

export interface AecReferenceFrame {
  seq: number;
  tsNs: number;
  sampleRate: 16000;
  samples: number[];
}

/** Open the Rust raw-loopback Channel while Listen capture is already running. */
export const startAecReference = async (
  onFrame: (frame: AecReferenceFrame) => void
): Promise<() => Promise<void>> => {
  const channel = new Channel<AecReferenceFrame>();
  channel.onmessage = onFrame;
  await invoke("start_aec_reference", { channel });

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    await invoke("stop_aec_reference");
  };
};
