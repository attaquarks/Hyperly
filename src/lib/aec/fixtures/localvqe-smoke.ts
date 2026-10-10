export const LOCALVQE_SMOKE_SAMPLE_RATE = 16_000;
export const LOCALVQE_SMOKE_SECONDS = 4;

export interface LocalVqeSmokeFixture {
  reference: Float32Array;
  farEndEcho: Float32Array;
  nearEnd: Float32Array;
  doubleTalkMic: Float32Array;
}

/** Deterministic, speech-like far-end + delayed low-passed echo + near-end. */
export const makeLocalVqeSmokeFixture = (): LocalVqeSmokeFixture => {
  const sampleCount = LOCALVQE_SMOKE_SAMPLE_RATE * LOCALVQE_SMOKE_SECONDS;
  const reference = new Float32Array(sampleCount);
  const farEndEcho = new Float32Array(sampleCount);
  const nearEnd = new Float32Array(sampleCount);
  const doubleTalkMic = new Float32Array(sampleCount);
  const echoDelaySamples = 480;
  let lowPassState = 0;
  let noiseState = 0x6d2b79f5;

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / LOCALVQE_SMOKE_SAMPLE_RATE;
    const farEnvelope = 0.72 + 0.28 * Math.sin(2 * Math.PI * 0.37 * t);
    const far = farEnvelope * (
      0.23 * Math.sin(2 * Math.PI * (170 * t + 8 * t * t)) +
      0.13 * Math.sin(2 * Math.PI * 293 * t + 0.4) +
      0.08 * Math.sin(2 * Math.PI * 431 * t + 1.1)
    );
    reference[i] = far;

    const delayedFar = i >= echoDelaySamples
      ? reference[i - echoDelaySamples] * 0.4
      : 0;
    lowPassState = 0.65 * lowPassState + 0.35 * delayedFar;
    farEndEcho[i] = lowPassState;

    // Fixed-seed broadband content under a syllabic envelope; no runtime RNG.
    noiseState ^= noiseState << 13;
    noiseState ^= noiseState >>> 17;
    noiseState ^= noiseState << 5;
    const noise = (noiseState >>> 0) / 0x80000000 - 1;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 2.1 * t + 0.3));
    const nearEnvelope = 0.18 + 0.82 * syllable ** 0.7;
    const near = 0.24 * nearEnvelope * noise;
    nearEnd[i] = near;
    doubleTalkMic[i] = near + lowPassState;
  }

  return { reference, farEndEcho, nearEnd, doubleTalkMic };
};
