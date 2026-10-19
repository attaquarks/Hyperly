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
        if (!(await waitForReferenceBuffer(feed))) {
          throw new Error("Reference feed did not provide two contiguous 16 kHz hops");
        }
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
            bypass("no-reference", new Error("Reference feed is unavailable or has a sequence gap"));
            return;
          }
          if (feed.status.overflows !== lastReferenceOverflowCount) {
            const newOverflows = feed.status.overflows - lastReferenceOverflowCount;
            lastReferenceOverflowCount = feed.status.overflows;
            if (recovery.noteOverflows(newOverflows) === "bypass") {
              bypass("overload", new Error("Reference FIFO overflow recurred"));
              return;
            }
          }
          if (pending.size >= 2) {
            bypass("overload", new Error("LocalVQE worker queue overrun"));
            return;
          }

          const reference = feed.takeRef(AEC_HOP_SAMPLES);
          if (!reference) {
            bypass("no-reference", new Error("Reference FIFO underrun"));
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
          const gap = feed.consumeGap();
          pending.add(message.id);
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
            nextExpectedOutputId += 1;
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
