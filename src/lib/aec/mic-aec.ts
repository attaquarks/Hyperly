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
/** Engine-conceal budget: concealed hops within the window that mean the
 * pipeline genuinely cannot keep up; anything below is scheduling jitter. */
const ENGINE_CONCEAL_BYPASS_COUNT = 16;
/** Reference-conceal budget: reference underruns are transient by nature (the
 * FIFO refills in ~20ms and a dead feed reports feed-degraded immediately),
 * so they tolerate ~1s of consecutive silence in 5s before the honest bypass. */
const REF_CONCEAL_BYPASS_COUNT = 64;
const CONCEAL_BYPASS_WINDOW_MS = 5_000;
const HOP_TELEMETRY_INTERVAL_MS = 1_000;

interface WorkerReady {
  type: "ready";
  sampleRate: number;
  hop: number;
}

interface WorkerFailure {
  type: "error";
  id?: number;
  message: string;
}

type WorkerMessage = WorkerReady | WorkerFailure | { type: string };

interface WorkletFault {
  type: "fault";
  reason: string;
}

interface WorkletFeedDegraded {
  type: "feed-degraded";
  reason: string;
}

interface WorkletWorkerError {
  type: "worker-error";
  message: string;
}

interface WorkletConcealed {
  type: "concealed";
  kind: "engine" | "ref";
  why: string;
}

interface WorkletRefReady {
  type: "ref-ready";
}

interface WorkletStats {
  type: "stats";
  hops: number;
  bufferedSamples: number;
  inFlight: number;
  rttAvgMs: number;
  rttMaxMs: number;
  overflows: number;
  underruns: number;
  gaps: number;
}

type WorkletMessage =
  | WorkletFault
  | WorkletFeedDegraded
  | WorkletWorkerError
  | WorkletConcealed
  | WorkletRefReady
  | WorkletStats;

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
 * realtime queue budget, which bypassed the AEC within ~3 hops of activation.
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
      // Negative ids cannot collide with the worklet's monotonically
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
 *
 * Architecture: the AudioWorklet owns the realtime path end to end — it
 * buffers the reference, pairs each mic hop with reference audio, and talks
 * to the engine worker over a dedicated MessagePort. The main thread's jobs
 * are forwarding reference frames fire-and-forget, reporting status, and
 * running policy (recovery ladder, conceal budgets, bypass).
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
  let lastReferenceOverflowCount = 0;
  let lastStatsHops = 0;
  let lastTelemetryMs = 0;
  let resolveReferenceReady: (() => void) | null = null;
  let monitorMicDevice: (() => void) | null = null;
  let activeFeed: AecReferenceFeed | null = null;
  const engineConcealTimesMs: number[] = [];
  const refConcealTimesMs: number[] = [];
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
    engineConcealTimesMs.length = 0;
    refConcealTimesMs.length = 0;
    lastReferenceOverflowCount = 0;
    lastStatsHops = 0;
    resolveReferenceReady = null;
    monitorMicDevice = null;
    activeFeed?.detachForwarder();
    activeFeed = null;
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
    // Detach the reference forwarder before the node port closes, so a frame
    // in flight cannot hit a dead port and flip the shared feed to degraded.
    activeFeed?.detachForwarder();
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

  /**
   * Main-thread policy for worklet reports. The audio thread handles all
   * realtime bookkeeping (silence for concealed hops, sequencing, buffering);
   * this handler only feeds the recovery machinery and status.
   */
  const handleWorkletMessage = (message: WorkletMessage): void => {
    if (message.type === "ref-ready") {
      resolveReferenceReady?.();
      return;
    }
    if (message.type === "fault") {
      bypass("overload", new Error(message.reason));
      return;
    }
    if (message.type === "feed-degraded") {
      bypass(
        "no-reference",
        new Error(`Reference feed degraded in the worklet (${message.reason})`)
      );
      return;
    }
    if (message.type === "worker-error") {
      // Silence and sequencing for the failed hop were handled on the audio
      // thread; only the recovery ladder lives here.
      const action = recovery.noteWorkerFailure();
      if (action === "reset") {
        worker?.postMessage({ type: "reset" });
      } else if (action === "bypass") {
        bypass("overload", new Error(`LocalVQE failed after its recovery reset: ${message.message}`));
      }
      return;
    }
    if (message.type === "concealed") {
      const nowMs = performance.now();
      const isEngine = message.kind === "engine";
      const ring = isEngine ? engineConcealTimesMs : refConcealTimesMs;
      ring.push(nowMs);
      while (ring.length > 0 && nowMs - ring[0] > CONCEAL_BYPASS_WINDOW_MS) {
        ring.shift();
      }
      console.warn(`[aec] concealing mic hop; ${message.kind}: ${message.why}`);
      const budget = isEngine ? ENGINE_CONCEAL_BYPASS_COUNT : REF_CONCEAL_BYPASS_COUNT;
      if (ring.length >= budget) {
        bypass(
          "overload",
          new Error(
            isEngine
              ? "AEC cannot sustain realtime"
              : "Reference delivery cannot sustain realtime"
          )
        );
      }
      return;
    }
    if (message.type !== "stats") return;
    const stats = message as WorkletStats;

    if (stats.overflows !== lastReferenceOverflowCount) {
      const newOverflows = stats.overflows - lastReferenceOverflowCount;
      lastReferenceOverflowCount = stats.overflows;
      if (recovery.noteOverflows(newOverflows) === "bypass") {
        bypass("overload", new Error("Reference FIFO overflow recurred"));
        return;
      }
      // A tolerated overflow is marked as a gap on the audio thread, which
      // sends it to the worker reset path with the next paired hop.
    }
    const newHops = Math.max(0, stats.hops - lastStatsHops);
    for (let i = 0; i < newHops; i += 1) recovery.noteWorkerSuccess();
    lastStatsHops = stats.hops;

    // Device/rate changes used to be checked per hop on the main thread; the
    // hop path no longer passes through here, so the stats cadence carries it.
    monitorMicDevice?.();

    if (status.state === "active") {
      status = {
        state: "active",
        model: MODEL_NAME,
        refDelayMs: (stats.bufferedSamples / AEC_SAMPLE_RATE) * 1_000,
        hops: stats.hops,
      };
    }

    if (import.meta.env.DEV && performance.now() - lastTelemetryMs >= HOP_TELEMETRY_INTERVAL_MS) {
      lastTelemetryMs = performance.now();
      console.info(
        `[aec] hop rtt avg ${stats.rttAvgMs.toFixed(1)}ms max ${stats.rttMaxMs.toFixed(1)}ms in-flight ${stats.inFlight} concealed ${engineConcealTimesMs.length}/5s ref-concealed ${refConcealTimesMs.length}/5s | ref depth ${(stats.bufferedSamples / AEC_SAMPLE_RATE).toFixed(2)}s overflows ${stats.overflows} underruns ${stats.underruns} gaps ${stats.gaps}`
      );
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
      activeFeed = feed;

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
        monitorMicDevice = () => {
          const settings = micTrack.getSettings();
          if (
            (initialDeviceId !== undefined && settings.deviceId !== initialDeviceId) ||
            (initialTrackSampleRate !== undefined && settings.sampleRate !== initialTrackSampleRate)
          ) {
            teardownForSourceChange(new Error("Microphone device or sample rate changed"));
          }
        };

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

        // The worker channel hands the worklet ↔ engine traffic to the audio
        // thread. Reference frames do NOT get a second MessageChannel: the
        // worklet's node-port handler owns the `ref`/`trim`/`bypass` message
        // types, and an init-transferred refPort would need its own onmessage
        // the worklet never installs — which is exactly how every frame was
        // silently dropped (ref depth 0.00s, "did not prime two contiguous
        // hops", init-failed, raw mic). The feed posts straight to the node
        // port; the sample buffer still transfers, so this stays off the
        // realtime hot path.
        const workerChannel = new MessageChannel();
        bridge.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
          handleWorkletMessage(event.data);
        };
        bridge.port.postMessage(
          { type: "init", workerPort: workerChannel.port2 },
          [workerChannel.port2]
        );
        worker.postMessage({ type: "init", port: workerChannel.port1 }, [workerChannel.port1]);
        // Start frame delivery into the worklet only now: its FIFO starts
        // primed from the feed's pre-attach backlog and fills in realtime.
        feed.attachForwarder(bridge.port);

        if (!(await waitForWorkletReferenceReady())) {
          throw new Error("Reference feed did not prime two contiguous 16 kHz hops in the worklet");
        }
        // Frames buffered before the forwarder was attached can exceed the
        // declared refDelayMs band; the worklet clamps before the first hop.
        // Not an overflow — no count, no gap, the AEC never saw the dropped span.
        bridge.port.postMessage({ type: "trim" });
        if (disposed) {
          stopWorker();
          activating = false;
          return;
        }

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
          refDelayMs: 0,
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

  /** Resolves when the worklet reports its reference FIFO holds two hops. */
  function waitForWorkletReferenceReady(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        resolveReferenceReady = null;
        resolve(false);
      }, REFERENCE_START_TIMEOUT_MS);
      resolveReferenceReady = () => {
        clearTimeout(timeout);
        resolveReferenceReady = null;
        resolve(true);
      };
    });
  }

  return session;
};
