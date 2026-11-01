import { createLocalVqeWorker } from "./localvqe-worker-factory.ts";
import { getActiveAecReferenceFeed, type AecReferenceFeed } from "./reference.ts";
import { AecRecoveryPolicy } from "./recovery.ts";
import {
  readAecEnabled,
  type AecStatus,
  type MicAecSession,
} from "./index.ts";

const AEC_SAMPLE_RATE = 16_000;
const AEC_HOP_SAMPLES = 256;
const MODEL_NAME = "LocalVQE GTCRN-AEC compact";
const WORKER_LOAD_TIMEOUT_MS = 20_000;
const REFERENCE_START_TIMEOUT_MS = 500;
const WARMUP_HOPS = 3;
const WARMUP_TIMEOUT_MS = 10_000;
/** In-flight process hops before a new hop is concealed. Live telemetry: the
 * engine drains a full queue to 0 between stalls (avg rtt 8-24ms incl. main-
 * thread pickup, spikes to ~150ms = ~10 hops arriving at once), so the queue
 * must absorb a stall and let the engine catch up. 16 hops = 256ms matches the
 * worklet's 250ms output-queue bound; deeper would only overrun it. */
const WORKER_INFLIGHT_LIMIT = 16;
/** Concealed hops within WORKER_DROP_BYPASS_WINDOW_MS that mean the pipeline
 * genuinely cannot keep up; anything below is scheduling jitter to absorb. */
const WORKER_DROP_BYPASS_COUNT = 16;
/** Reference underruns are transient by nature (the FIFO refills in ~20ms and
 * a dead feed is caught by the ready-state check), so they get a far larger
 * budget before the honest bypass: ~1s of consecutive silence in 5s. */
const REF_UNDERRUN_BYPASS_COUNT = 64;
const WORKER_DROP_BYPASS_WINDOW_MS = 5_000;
const HOP_RTT_HISTORY = 64;
const HOP_TELEMETRY_INTERVAL_MS = 1_000;

interface WorkerReady {
  type: "ready";
  sampleRate: number;
  hop: number;
}

interface WorkerProcessed {
  type: "processed";
  id: number;
  samples: ArrayBuffer;
  rc: 0;
}

interface WorkerFailure {
  type: "error";
  id?: number;
  message: string;
}

type WorkerMessage = WorkerReady | WorkerProcessed | WorkerFailure | { type: string };

interface WorkletMicHop {
  type: "mic-hop";
  id: number;
  samples: ArrayBuffer;
}

interface WorkletFault {
  type: "fault";
  reason: string;
}

type WorkletMessage = WorkletMicHop | WorkletFault;

const waitForReferenceBuffer = async (
  feed: AecReferenceFeed
): Promise<boolean> => {
  const deadline = performance.now() + REFERENCE_START_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (feed.status.state === "degraded" || feed.status.state === "closed") return false;
    if (feed.status.state === "ready" && feed.bufferedSamples >= AEC_HOP_SAMPLES * 2) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
};

const waitForWorker = (worker: Worker): Promise<WorkerReady> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("LocalVQE worker load timed out")),
      WORKER_LOAD_TIMEOUT_MS
    );
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "ready") {
        clearTimeout(timeout);
        resolve(message as WorkerReady);
      } else if (message.type === "error") {
        clearTimeout(timeout);
        reject(new Error((message as WorkerFailure).message));
      }
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      reject(new Error(event.message || "LocalVQE worker failed to load"));
    };
    worker.postMessage({ type: "load" });
  });

/**
 * Drives silent hops through the engine before the live bridge is wired. The
 * first processFrame call pays one-time WASM lazy-init/JIT cost far above the
 * two-deep queue budget, which bypassed the AEC within ~3 hops of activation.
 * The mic route is still raw pass-through here, so the wait is free.
 */
const warmUpWorker = (worker: Worker): Promise<void> =>
  new Promise((resolve, reject) => {
    let sent = 0;
    let done = 0;
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      worker.onmessage = null;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("LocalVQE warmup timed out")),
      WARMUP_TIMEOUT_MS
    );
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "error") {
        finish(new Error((message as WorkerFailure).message));
        return;
      }
      if (message.type !== "processed") return;
      done += 1;
      if (done >= sent) finish();
    };
    for (; sent < WARMUP_HOPS; sent += 1) {
      const mic = new Float32Array(AEC_HOP_SAMPLES);
      const ref = new Float32Array(AEC_HOP_SAMPLES);
      // Negative ids cannot collide with the live bridge's monotonically
      // increasing mic-hop ids, and warmup fully drains before it is wired.
      worker.postMessage(
        { type: "process", id: -(sent + 1), mic, ref, gap: false },
        [mic.buffer, ref.buffer]
      );
    }
  });

/**
 * Builds a worker-backed mic pipeline only when the saved toggle and the
 * existing Listen reference feed are both available. Every startup failure
 * leaves output identical to source; runtime failures switch the bridge to an
 * explicitly reported raw pass-through for the rest of this mic session.
 */
export const createMicAec = (
  source: MediaStream,
  enabled = readAecEnabled()
): MicAecSession => {
  let output = source;
  let status: AecStatus = enabled
    ? { state: "bypass", reason: "no-reference" }
    : { state: "off" };
  let onStatus: ((status: AecStatus | undefined) => void) | undefined;
  let disposed = false;
  let activating = false;
  let worker: Worker | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let bridgeNode: AudioWorkletNode | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;
  let rawRouteConnected = false;
  let pending = new Set<number>();
  let nextExpectedMicId = 0;
  let nextExpectedOutputId = 0;
  let lastReferenceOverflowCount = 0;
  const hopPostedAtMs = new Map<number, number>();
  const hopRttsMs: number[] = [];
  const skippedOutputIds = new Set<number>();
  const dropTimesMs: number[] = [];
  const refUnderrunTimesMs: number[] = [];
  let pendingMicGap = false;
  let lastHopTelemetryMs = 0;
  const recovery = new AecRecoveryPolicy();
  let removeTrackMonitor = (): void => {};

  const publish = (next: AecStatus): void => {
    const changed = status.state !== next.state ||
      (status.state === "bypass" && next.state === "bypass" && status.reason !== next.reason);
    status = next;
    if (changed) onStatus?.(status);
  };

  const stopWorker = (): void => {
    const currentWorker = worker;
    worker = null;
    pending.clear();
    hopPostedAtMs.clear();
    skippedOutputIds.clear();
    dropTimesMs.length = 0;
    refUnderrunTimesMs.length = 0;
    pendingMicGap = false;
    if (currentWorker) {
      currentWorker.onmessage = null;
      currentWorker.onerror = null;
      currentWorker.onmessageerror = null;
      currentWorker.terminate();
    }
  };

  const detachTrackMonitor = (): void => {
    removeTrackMonitor();
    removeTrackMonitor = () => {};
  };

  const disconnectGraph = (): void => {
    bridgeNode?.port.postMessage({ type: "bypass" });
    bridgeNode?.port.close();
    bridgeNode?.disconnect();
    sourceNode?.disconnect();
    destination?.disconnect();
    bridgeNode = null;
    sourceNode = null;
    destination = null;
  };

  const restoreRawRoute = (): void => {
    const input = sourceNode;
    const outputNode = destination;
    if (!input || !outputNode) return;

    bridgeNode?.port.postMessage({ type: "bypass" });
    bridgeNode?.port.close();
    bridgeNode?.disconnect();
    bridgeNode = null;
    try {
      input.disconnect();
      input.connect(outputNode);
      rawRouteConnected = true;
      output = outputNode.stream;
    } catch (error) {
      rawRouteConnected = false;
      output = source;
      console.warn("[aec] could not restore the raw microphone route:", error);
    }
  };

  const disposeSession = (preserveOutput = false): void => {
    if (disposed) return;
    disposed = true;
    detachTrackMonitor();
    disconnectGraph();
    stopWorker();
    source.getTracks().forEach((track) => track.stop());
    if (!preserveOutput) output = source;
    onStatus = undefined;
  };

  const teardownForSourceChange = (error: Error): void => {
    if (disposed) return;
    console.warn("[aec] microphone source changed; ending this AEC session:", error);
    publish({ state: "bypass", reason: "overload" });
    // Keep the output identity until vad-web pauses it; the source and AEC graph
    // are already stopped, and the next acquire creates a fresh session.
    disposeSession(true);
  };

  const bypass = (reason: "no-reference" | "init-failed" | "overload", error?: unknown): void => {
    if (disposed || status.state === "bypass" && status.reason === reason) return;
    if (error) console.warn(`[aec] bypass (${reason}):`, error);
    detachTrackMonitor();
    if (bridgeNode) restoreRawRoute();
    stopWorker();
    publish({ state: "bypass", reason });
  };

  /** Forward concealment markers in strict id order, exactly when their turn comes. */
  const flushSkippedOutputs = (): void => {
    while (skippedOutputIds.has(nextExpectedOutputId)) {
      skippedOutputIds.delete(nextExpectedOutputId);
      bridgeNode?.port.postMessage({ type: "dropped", id: nextExpectedOutputId });
      nextExpectedOutputId += 1;
    }
  };

  /**
   * Conceal one hop: silence for its id, filter reset on the next posted hop,
   * one strike against the matching budget. Transient starvation (in-flight
   * backlog, momentary reference emptiness) recovers within tens of
   * milliseconds; only a sustained drain of either budget bypasses — engine
   * slowdowns and reference-delivery failures are different pathologies with
   * different budgets.
   */
  const concealHop = (
    id: number,
    why: string,
    ring: number[],
    budgetCount: number,
    budgetLabel: string
  ): void => {
    skippedOutputIds.add(id);
    pendingMicGap = true;
    const nowMs = performance.now();
    ring.push(nowMs);
    while (ring.length > 0 && nowMs - ring[0] > WORKER_DROP_BYPASS_WINDOW_MS) {
      ring.shift();
    }
    console.warn(`[aec] concealing mic hop ${id}; ${why}`);
    if (ring.length >= budgetCount) {
      bypass("overload", new Error(budgetLabel));
    }
  };

  const session: MicAecSession = {
    get output() {
      return output;
    },
    source,
    get status() {
      return status;
    },
    activate: async (audioContext, referenceFeed, reportStatus) => {
      if (!enabled || disposed || activating) return;
      activating = true;
      onStatus = reportStatus;
      const feed = referenceFeed ?? getActiveAecReferenceFeed();
      if (!feed || feed.status.state === "degraded" || feed.status.state === "closed") {
        publish({ state: "bypass", reason: "no-reference" });
        activating = false;
        return;
      }

      try {
        if (audioContext.sampleRate < AEC_SAMPLE_RATE) {
          throw new Error(`AudioContext rate ${audioContext.sampleRate} Hz is below 16 kHz`);
        }

        // Hand VAD a stable stream immediately. Until the worker and worklet
        // are ready, this graph carries the original mic audio unchanged.
        const input = audioContext.createMediaStreamSource(source);
        const destinationNode = audioContext.createMediaStreamDestination();
        sourceNode = input;
        destination = destinationNode;
        input.connect(destinationNode);
        rawRouteConnected = true;
        output = destinationNode.stream;

        const micTrack = source.getAudioTracks()[0];
        if (!micTrack) throw new Error("Microphone stream has no audio track");
        const initialSettings = micTrack.getSettings();
        const initialDeviceId = initialSettings.deviceId;
        const initialTrackSampleRate = initialSettings.sampleRate;
        const onTrackEnded = (): void => {
          teardownForSourceChange(new Error("Microphone track ended"));
        };
        micTrack.addEventListener("ended", onTrackEnded);
        removeTrackMonitor = () => micTrack.removeEventListener("ended", onTrackEnded);

        worker = createLocalVqeWorker();
        const ready = await waitForWorker(worker);
        if (disposed) {
          stopWorker();
          activating = false;
          return;
        }
        if (ready.sampleRate !== AEC_SAMPLE_RATE || ready.hop !== AEC_HOP_SAMPLES) {
          throw new Error(`Unexpected LocalVQE format ${ready.sampleRate} Hz/${ready.hop}-sample hop`);
        }
        await warmUpWorker(worker);
        if (disposed) {
          stopWorker();
          activating = false;
          return;
        }
        if (!(await waitForReferenceBuffer(feed))) {
          throw new Error("Reference feed did not provide two contiguous 16 kHz hops");
        }
        // Audio accumulated before this consumer existed is stale beyond the
        // declared refDelayMs band, and the rate-matched FIFO never sheds it on
        // its own. Clamp before the first hop; not an overflow — no count, no
        // gap, the AEC never saw the dropped span.
        feed.trimExcess();
        lastReferenceOverflowCount = feed.status.overflows;

        const workletUrl = new URL("/aec/mic-aec-worklet.js", location.origin);
        await audioContext.audioWorklet.addModule(workletUrl.href);
        if (disposed) {
          stopWorker();
          activating = false;
          return;
        }

        const bridge = new AudioWorkletNode(audioContext, "hyperly-mic-aec-bridge", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: "explicit",
          processorOptions: { sampleRate: AEC_SAMPLE_RATE, hop: AEC_HOP_SAMPLES },
        });
        bridgeNode = bridge;

        bridge.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
          const message = event.data;
          if (message.type === "fault") {
            bypass("overload", new Error(message.reason));
            return;
          }
          if (message.id !== nextExpectedMicId++) {
            bypass("overload", new Error("Mic hop sequence gap"));
            return;
          }
          if (feed.status.state !== "ready") {
            bypass(
              "no-reference",
              new Error(
                `Reference feed is unavailable (state=${feed.status.state}, reason=${feed.status.reason ?? "none"})`
              )
            );
            return;
          }
          if (feed.status.overflows !== lastReferenceOverflowCount) {
            const newOverflows = feed.status.overflows - lastReferenceOverflowCount;
            lastReferenceOverflowCount = feed.status.overflows;
            if (recovery.noteOverflows(newOverflows) === "bypass") {
              bypass("overload", new Error("Reference FIFO overflow recurred"));
              return;
            }
            // A tolerated overflow remains a gap; consumeGap() below sends it to the worker reset path.
          }
          if (pending.size >= WORKER_INFLIGHT_LIMIT) {
            // The engine bench runs at ~3.3 ms/hop (4.9x realtime), so depth
            // beyond the cap is result-pickup delay on the contended main
            // thread, not engine slowness. Conceal this hop (the worklet
            // inserts silence for it) and reset the filter on the next posted
            // hop; sustained inability to keep up still bypasses below.
            concealHop(
              message.id,
              `in flight ${pending.size}`,
              dropTimesMs,
              WORKER_DROP_BYPASS_COUNT,
              "AEC cannot sustain realtime"
            );
            return;
          }

          const reference = feed.takeRef(AEC_HOP_SAMPLES);
          if (!reference) {
            // A dead feed is caught above by the ready-state check; reaching
            // here means the FIFO was momentarily empty (delivery burst drew
            // it dry). The backlog refills in ~20ms — conceal, don't bypass.
            concealHop(
              message.id,
              "reference underrun",
              refUnderrunTimesMs,
              REF_UNDERRUN_BYPASS_COUNT,
              "Reference delivery cannot sustain realtime"
            );
            return;
          }

          const mic = new Float32Array(message.samples);
          const settings = micTrack.getSettings();
          if (
            (initialDeviceId !== undefined && settings.deviceId !== initialDeviceId) ||
            (initialTrackSampleRate !== undefined && settings.sampleRate !== initialTrackSampleRate)
          ) {
            teardownForSourceChange(new Error("Microphone device or sample rate changed"));
            return;
          }
          const gap = feed.consumeGap() || pendingMicGap;
          pendingMicGap = false;
          pending.add(message.id);
          hopPostedAtMs.set(message.id, performance.now());
          try {
            worker?.postMessage(
              { type: "process", id: message.id, mic, ref: reference, gap },
              [mic.buffer, reference.buffer]
            );
          } catch (error) {
            bypass("overload", error);
          }
        };

        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
          const message = event.data;
          if (message.type === "error") {
            const failure = message as WorkerFailure;
            if (failure.id === undefined || !pending.delete(failure.id) || failure.id !== nextExpectedOutputId) {
              bypass("overload", new Error(failure.message));
              return;
            }
            hopPostedAtMs.delete(failure.id);
            nextExpectedOutputId += 1;
            flushSkippedOutputs();
            bridge.port.postMessage({ type: "dropped", id: failure.id });
            const action = recovery.noteWorkerFailure();
            if (action === "reset") {
              worker?.postMessage({ type: "reset" });
            } else if (action === "bypass") {
              bypass("overload", new Error(`LocalVQE failed after its recovery reset: ${failure.message}`));
            }
            return;
          }
          if (message.type !== "processed") return;
          const processed = message as WorkerProcessed;
          const postedAtMs = hopPostedAtMs.get(processed.id);
          if (postedAtMs !== undefined) {
            hopPostedAtMs.delete(processed.id);
            hopRttsMs.push(performance.now() - postedAtMs);
            if (hopRttsMs.length > HOP_RTT_HISTORY) hopRttsMs.shift();
          }
          flushSkippedOutputs();
          if (!pending.delete(processed.id) || processed.id !== nextExpectedOutputId++) {
            bypass("overload", new Error("LocalVQE worker response sequence gap"));
            return;
          }
          if (processed.rc !== 0 || processed.samples.byteLength !== AEC_HOP_SAMPLES * 4) {
            bypass("overload", new Error("LocalVQE returned an invalid processed frame"));
            return;
          }

          recovery.noteWorkerSuccess();
          bridge.port.postMessage(
            { type: "processed", id: processed.id, samples: processed.samples },
            [processed.samples]
          );
          if (
            import.meta.env.DEV &&
            performance.now() - lastHopTelemetryMs >= HOP_TELEMETRY_INTERVAL_MS
          ) {
            lastHopTelemetryMs = performance.now();
            const avg = hopRttsMs.length
              ? hopRttsMs.reduce((sum, value) => sum + value, 0) / hopRttsMs.length
              : 0;
            const worst = hopRttsMs.length ? Math.max(...hopRttsMs) : 0;
            console.info(
              `[aec] hop rtt avg ${avg.toFixed(1)}ms max ${worst.toFixed(1)}ms in-flight ${pending.size} concealed ${dropTimesMs.length}/5s ref-concealed ${refUnderrunTimesMs.length}/5s`
            );
          }
          const hops = status.state === "active" ? status.hops + 1 : 1;
          status = {
            state: "active",
            model: MODEL_NAME,
            refDelayMs: feed.bufferedSamples / AEC_SAMPLE_RATE * 1_000,
            hops,
          };
        };
        worker.onerror = (event) => bypass("overload", new Error(event.message || "LocalVQE worker error"));
        worker.onmessageerror = () => bypass("overload", new Error("LocalVQE worker message could not be decoded"));
        bridge.addEventListener("processorerror", () => bypass("overload", new Error("Mic AEC worklet failed")));

        input.disconnect();
        rawRouteConnected = false;
        input.connect(bridge);
        bridge.connect(destinationNode);
        output = destinationNode.stream;
        publish({
          state: "active",
          model: MODEL_NAME,
          refDelayMs: feed.bufferedSamples / AEC_SAMPLE_RATE * 1_000,
          hops: 0,
        });
      } catch (error) {
        if (disposed) return;
        detachTrackMonitor();
        if (bridgeNode) restoreRawRoute();
        stopWorker();
        output = rawRouteConnected ? destination?.stream ?? source : source;
        publish({ state: "bypass", reason: "init-failed" });
        if (error) console.warn("[aec] initialization failed; using raw microphone stream:", error);
      } finally {
        activating = false;
      }
    },
    dispose: () => {
      disposeSession();
    },
  };

  return session;
};
