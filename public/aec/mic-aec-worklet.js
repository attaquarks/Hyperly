const AEC_SAMPLE_RATE = 16000;
const AEC_HOP_SAMPLES = 256;
const OUTPUT_PREROLL_SAMPLES = AEC_SAMPLE_RATE * 0.064;

class MicAecBridgeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bypass = false;
    this.inputPhase = 0;
    this.inputSum = 0;
    this.inputCount = 0;
    this.micFrame = new Float32Array(AEC_HOP_SAMPLES);
    this.micFrameOffset = 0;
    this.nextFrameId = 0;
    this.playback = [];
    this.playbackPosition = 0;
    this.playbackStarted = false;

    this.port.onmessage = (event) => {
      if (event.data.type === "bypass") {
        this.bypass = true;
        this.playback.length = 0;
        return;
      }

      if (event.data.type === "dropped") {
        for (let i = 0; i < AEC_HOP_SAMPLES; i += 1) this.playback.push(0);
        if (this.playback.length > AEC_SAMPLE_RATE * 0.25) {
          this.bypass = true;
          this.port.postMessage({ type: "fault", reason: "output-queue-overrun" });
        }
        return;
      }

      if (!event.data.samples || event.data.samples.byteLength !== AEC_HOP_SAMPLES * Float32Array.BYTES_PER_ELEMENT) {
        this.bypass = true;
        this.port.postMessage({ type: "fault", reason: "invalid-worker-frame" });
        return;
      }

      const samples = new Float32Array(event.data.samples);
      for (const sample of samples) this.playback.push(sample);
      if (this.playback.length > AEC_SAMPLE_RATE * 0.25) {
        this.bypass = true;
        this.port.postMessage({ type: "fault", reason: "output-queue-overrun" });
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;

    if (this.bypass) {
      output.fill(0);
      if (input) output.set(input.subarray(0, output.length));
      return true;
    }

    if (input) this.collectMicHops(input);

    const samplesNeeded = Math.ceil(output.length * AEC_SAMPLE_RATE / sampleRate) + 1;
    if (!this.playbackStarted && this.playback.length >= OUTPUT_PREROLL_SAMPLES) {
      this.playbackStarted = true;
    }

    if (!this.playbackStarted) {
      output.fill(0);
      if (input) output.set(input.subarray(0, output.length));
      return true;
    }

    if (this.playback.length - Math.floor(this.playbackPosition) < samplesNeeded) {
      // Output starved (a main-thread stall delayed worker results). Pass the
      // raw mic through for this render and let the queue refill instead of
      // killing the session — that is byte-identical to a temporary bypass.
      // Sustained failure still bypasses upstream (worker errors, sequence
      // gaps, the session's concealment counter).
      this.playbackStarted = false;
      output.fill(0);
      if (input) output.set(input.subarray(0, output.length));
      console.warn("[aec] worklet output starved; passing raw mic until the queue refills");
      return true;
    }

    const step = AEC_SAMPLE_RATE / sampleRate;
    for (let i = 0; i < output.length; i += 1) {
      const index = Math.floor(this.playbackPosition);
      const fraction = this.playbackPosition - index;
      const first = this.playback[index] ?? 0;
      const second = this.playback[index + 1] ?? first;
      output[i] = first + (second - first) * fraction;
      this.playbackPosition += step;
    }

    const consumed = Math.floor(this.playbackPosition);
    if (consumed > 0) {
      this.playback.splice(0, consumed);
      this.playbackPosition -= consumed;
    }
    return true;
  }

  collectMicHops(input) {
    for (const sample of input) {
      this.inputSum += sample;
      this.inputCount += 1;
      this.inputPhase += AEC_SAMPLE_RATE;
      if (this.inputPhase < sampleRate) continue;

      this.inputPhase -= sampleRate;
      this.micFrame[this.micFrameOffset] = this.inputSum / this.inputCount;
      this.micFrameOffset += 1;
      this.inputSum = 0;
      this.inputCount = 0;

      if (this.micFrameOffset === AEC_HOP_SAMPLES) {
        const id = this.nextFrameId++;
        const frame = this.micFrame;
        this.micFrame = new Float32Array(AEC_HOP_SAMPLES);
        this.micFrameOffset = 0;
        this.port.postMessage({ type: "mic-hop", id, samples: frame.buffer }, [frame.buffer]);
      }
    }
  }
}

registerProcessor("hyperly-mic-aec-bridge", MicAecBridgeProcessor);
