const AEC_SAMPLE_RATE = 16_000;
const AEC_HOP_SAMPLES = 256;
const OUTPUT_PREROLL_SAMPLES = AEC_SAMPLE_RATE * 0.064;

interface ProcessedMessage {
  type: "processed";
  id: number;
  samples: ArrayBuffer;
}

interface BypassMessage {
  type: "bypass";
}

class MicAecBridgeProcessor extends AudioWorkletProcessor {
  private bypass = false;
  private inputPhase = 0;
  private inputSum = 0;
  private inputCount = 0;
  private micFrame = new Float32Array(AEC_HOP_SAMPLES);
  private micFrameOffset = 0;
  private nextFrameId = 0;
  private readonly playback: number[] = [];
  private playbackPosition = 0;
  private playbackStarted = false;
  private underrunSent = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<ProcessedMessage | BypassMessage>) => {
      if (event.data.type === "bypass") {
        this.bypass = true;
        this.playback.length = 0;
        return;
      }

      if (event.data.samples.byteLength !== AEC_HOP_SAMPLES * Float32Array.BYTES_PER_ELEMENT) {
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

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
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
      return true;
    }

    if (this.playback.length - Math.floor(this.playbackPosition) < samplesNeeded) {
      this.bypass = true;
      if (!this.underrunSent) {
        this.underrunSent = true;
        this.port.postMessage({ type: "fault", reason: "output-queue-underrun" });
      }
      output.fill(0);
      if (input) output.set(input.subarray(0, output.length));
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

  private collectMicHops(input: Float32Array): void {
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
