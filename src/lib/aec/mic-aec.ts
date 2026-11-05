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
/**
 * The user's mic is delayed by this much before the AEC, so its content time
 * aligns with the scheduled reference. The model sees a constant pairing
 * delay of SCHEDULE_AHEAD_SECONDS - MIC_DELAY_SECONDS = 200 ms — measured on
 * the real engine as its BEST operating point (21.7 dB ERLE; the model even
 * cancels across 100↔400 ms jumps, but 200 ms constant is where ERLE peaks).
 * The cost is 200 ms of latency on the user's own transcript path.
 */
const MIC_DELAY_SECONDS = 0.2;
/**
 * Engine-conceal budget: concealed hops within the window that mean the
 * pipeline genuinely cannot keep up. 96 over 5 s absorbs a full ~1.5 s
 * worker stall (a saturated machine hiccup) without abandoning the session;
 * anything SUSTAINED past that still bypasses honestly. The in-flight queue
 * (64 hops ≈ 1 s) absorbs the stall before concealment even starts.
 */
const ENGINE_CONCEAL_BYPASS_COUNT = 96;
const CONCEAL_BYPASS_WINDOW_MS = 5_000;
/** Latest worklet stats, attached to bypass errors so a failure names its
 * numbers (the worker once sat at 0.15× realtime under machine load — the
 * message must say so instead of guessing). */
let lastStats: WorkletStats | null = null;
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
  let micDelayNode: DelayNode | null = null;
  let refBusNode: GainNode | null = null;
  let rawRouteConnected = false;
  let lastStatsHops = 0;
  let lastTelemetryMs = 0;
  let resolveReferenceReady: (() => void) | null = null;
  let monitorMicDevice: (() => void) | null = null;
  let activeFeed: AecReferenceFeed | null = null;
  const engineConcealTimesMs: number[] = [];
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
    lastStatsHops = 0;
    lastStats = null;
    resolveReferenceReady = null;
    monitorMicDevice = null;
    activeFeed?.detach();
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
    // Detach the scheduler before the nodes go away, so a top-up cannot
    // schedule into a disconnected bus.
    activeFeed?.detach();
    bridgeNode?.port.postMessage({ type: "bypass" });
    bridgeNode?.port.close();
    bridgeNode?.disconnect();
    micDelayNode?.disconnect();
    refBusNode?.disconnect();
    sourceNode?.disconnect();
    destination?.disconnect();
    bridgeNode = null;
    micDelayNode = null;
    refBusNode = null;
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
      // Drop the delayed route entirely (input → micDelay → bridge): leaving
      // it connected alongside the raw route would double-route the mic.
      input.disconnect();
      micDelayNode?.disconnect();
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
      // The only conceal source left is ENGINE saturation (in-flight cap).
      // Reference "conceals" no longer exist: the reference is a live audio
      // input on the audio thread; starvation pairs silent refs and logs.
      const ring = engineConcealTimesMs;
      ring.push(nowMs);
      while (ring.length > 0 && nowMs - ring[0] > CONCEAL_BYPASS_WINDOW_MS) {
        ring.shift();
      }
      console.warn(
        `[aec] concealing mic hop; ${message.kind}: ${message.why} | engine sits at ` +
          `${ring.length}/${ENGINE_CONCEAL_BYPASS_COUNT} within ${CONCEAL_BYPASS_WINDOW_MS / 1000}s` +
          (lastStats
            ? ` (in-flight ${lastStats.inFlight}, sheds ${lastStats.overflows}, starved ${lastStats.underruns}, hops ${lastStats.hops})`
            : "")
      );
      if (ring.length >= ENGINE_CONCEAL_BYPASS_COUNT) {
        bypass(
          "overload",
          new Error(
            "AEC cannot sustain realtime" +
              (lastStats
                ? ` (rtt avg ${lastStats.rttAvgMs.toFixed(1)}ms, in-flight ${lastStats.inFlight}, sheds ${lastStats.overflows}, starved ${lastStats.underruns})`
                : "")
          )
        );
      }
      return;
    }
    if (message.type !== "stats") return;
    const stats = message as WorkletStats;

    // Telemetry FIRST — every tick carries the numbers, including the tick
    // that (later) bypasses, so a failure names its layer instead of hiding
    // behind an error string.
    if (import.meta.env.DEV && performance.now() - lastTelemetryMs >= HOP_TELEMETRY_INTERVAL_MS) {
      lastTelemetryMs = performance.now();
      console.info(
        `[aec] hop rtt avg ${stats.rttAvgMs.toFixed(1)}ms max ${stats.rttMaxMs.toFixed(1)}ms in-flight ${stats.inFlight} concealed ${engineConcealTimesMs.length}/5s | ref queue ${(stats.bufferedSamples / AEC_SAMPLE_RATE).toFixed(2)}s drift-sheds ${stats.overflows} starved ${stats.underruns}`
      );
    }

    // Drift sheds are MAINTENANCE TELEMETRY, never a bypass: they mean the
    // ref queue shed its oldest hop or two to clock skew, or the engine was
    // briefly lagging and the surplus was shed. The first cut of this
    // architecture wired a ladder here — it fired on a startup transient
    // (mic delay node settling while the schedule-ahead window primes) and
    // killed the AEC within its first second on EVERY activation. The
    // honest arbiter for "cannot sustain realtime" is the engine conceal
    // budget below: sustained in-flight saturation still bypasses.
    const newHops = Math.max(0, stats.hops - lastStatsHops);
    for (let i = 0; i < newHops; i += 1) recovery.noteWorkerSuccess();
    lastStatsHops = stats.hops;
    lastStats = stats;

    // Device/rate changes used to be checked per hop on the main thread; the
    // hop path no longer passes through here, so the stats cadence carries it.
    monitorMicDevice?.();

    if (status.state === "active") {
      status = {
        state: "active",
        model: MODEL_NAME,
        refDelayMs: 200,
        hops: stats.hops,
      };
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

        // TWO inputs: 0 = the mic (delayed by MIC_DELAY_SECONDS so its
        // content time aligns with the scheduled reference), 1 = the
        // scheduled reference bus. The worklet pairs the two 16 kHz hop
        // streams one-to-one.
        const bridge = new AudioWorkletNode(audioContext, "hyperly-mic-aec-bridge", {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: "explicit",
          processorOptions: { sampleRate: AEC_SAMPLE_RATE, hop: AEC_HOP_SAMPLES },
        });
        bridgeNode = bridge;

        const workerChannel = new MessageChannel();
        bridge.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
          handleWorkletMessage(event.data);
        };
        bridge.port.postMessage(
          { type: "init", workerPort: workerChannel.port2 },
          [workerChannel.port2]
        );
        worker.postMessage({ type: "init", port: workerChannel.port1 }, [workerChannel.port1]);

        // The reference reaches the worklet as a SCHEDULED audio stream: the
        // feed accumulates loopback samples and keeps SCHEDULE_AHEAD_SECONDS
        // of them queued on the audio thread's clock via AudioBufferSource
        // nodes, so UI-thread stalls cannot touch the delivery (this was the
        // failure mode that bypassed the AEC for its whole life). The mic is
        // delayed by MIC_DELAY_SECONDS so both streams arrive content-aligned.
        const micDelay = audioContext.createDelay(1.0);
        micDelay.delayTime.value = MIC_DELAY_SECONDS;
        micDelayNode = micDelay;
        const refBus = audioContext.createGain();
        refBusNode = refBus;

        input.disconnect();
        rawRouteConnected = false;
        input.connect(micDelay);
        micDelay.connect(bridge);
        refBus.connect(bridge, 0, 1);
        bridge.connect(destinationNode);
        output = destinationNode.stream;

        // The scheduler starts feeding the graph only now, so the ref queue
        // and mic hops accrue together and nothing is shed at startup.
        feed.attach(audioContext, refBus);

        if (!(await waitForWorkletReferenceReady())) {
          throw new Error("Reference audio did not prime two 16 kHz hops in the worklet");
        }
        if (disposed) {
          stopWorker();
          activating = false;
          return;
        }

        worker.onerror = (event) => bypass("overload", new Error(event.message || "LocalVQE worker error"));
        worker.onmessageerror = () => bypass("overload", new Error("LocalVQE worker message could not be decoded"));
        bridge.addEventListener("processorerror", () => bypass("overload", new Error("Mic AEC worklet failed")));

        publish({
          state: "active",
          model: MODEL_NAME,
          // The constant pairing delay the engine is fed: the reference is
          // scheduled SCHEDULE_AHEAD ahead, the mic is delayed MIC_DELAY —
          // measured as the model's best operating point.
          refDelayMs: 200,
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
