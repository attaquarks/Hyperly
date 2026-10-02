import { useCallback, useEffect, useRef, useState } from "react";
import { MicVAD } from "@ricky0123/vad-web";
import { fetchSTT } from "@/lib";
import { SpeechBlockQueue } from "@/lib/speech-block-queue";
import { getTranscriptStore } from "@/lib/database/transcript-adapter";
import { floatArrayToWav } from "@/lib/utils";
import { readStoredVadConfig } from "@/lib/vad-config";
import { getMicrophoneStream } from "@/lib/microphone";
import { micRedemptionMs } from "@/lib/turn-boundary";
import { useApp } from "@/contexts";

/**
 * The one microphone implementation, shared by the Ask room and Listen.
 *
 * This drives `MicVAD` from `@ricky0123/vad-web` directly, instead of through
 * that package's `useMicVAD` React wrapper. The wrapper's teardown is unsafe in
 * a way that permanently disables the microphone in both rooms:
 *
 *   1. Its setup effect sets `canceled = true` in the cleanup, then resolves its
 *      async setup and runs `if (canceled) { await myvad.destroy(); return; }`.
 *      React StrictMode double-invokes effects in development, so this runs on
 *      every mount: an instance is created, torn down, and never started.
 *   2. `MicVAD.destroy()` calls `getAudioInstances()` unconditionally as its
 *      first statement, and that accessor throws "MicVAD has null stream, audio
 *      context, or processor adapter" while `_stream`/`_audioContext`/`_vadNode`
 *      are null. They are only assigned inside `start()`, so destroying an
 *      unstarted instance always throws.
 *   3. The wrapper catches that throw inside the same effect and stores it as
 *      its own `errored` state, which then blocks its `start()` forever.
 *
 * The symptom was a mic that switched on, captured nothing, and produced no
 * `user` transcript, with no permission prompt ever shown — `getUserMedia` was
 * never reached, because the failure is in teardown rather than acquisition.
 *
 * Note step 2 also fires whenever the wrapper's effect deps change, so this is
 * not only a development/StrictMode problem.
 *
 * Owning the lifecycle here removes the whole class of bug: an instance that was
 * never started is never destroyed, and no failure latches the hook off.
 *
 * Callbacks are held in refs, so callers may pass fresh inline closures every
 * render without rebuilding the VAD.
 *
 * Device switching: the instance is rebuilt per microphone id, so consumers
 * additionally remount this hook on `key={`${deviceId}:${sensitivity}`}`. That
 * keeps a slider change (which alters the detection thresholds) taking effect,
 * since those are read when the instance is created.
 */
export interface VoiceInputOptions {
  /** Desired on/off state; the VAD is started and paused to follow it. */
  active: boolean;
  /** Live partial transcript while the user is still speaking. */
  onPartial?: (text: string) => void;
  /** A finalized utterance, already transcribed. */
  onUtterance: (text: string) => void;
  /** Load failures and failed transcriptions. */
  onError?: (message: string) => void;
}

export interface VoiceInputState {
  listening: boolean;
  loading: boolean;
  errored: string | false;
}

// How often a live partial transcript is produced mid-utterance.
const PARTIAL_INTERVAL_MS = 2000;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Map 0-1 voice sensitivity onto vad-web's speech thresholds.
 *
 * Higher sensitivity lowers the bar for calling a frame speech. At the 0.5
 * default this gives positive 0.5 / negative 0.35, which is the behaviour this
 * app has always had — the formula is unchanged.
 *
 * Note these are not vad-web's own defaults: its frame processor ships 0.3 and
 * 0.25, so the middle of the slider is stricter than the library. The clamps
 * only guard the ends: at 0 no normal speech would clear the bar, and at 1
 * every breath would.
 */
const speechThresholds = (voiceSensitivity: number) => {
  const sensitivity = Math.min(1, Math.max(0, voiceSensitivity));
  const positive = Math.min(0.9, Math.max(0.15, 1 - sensitivity));
  return {
    positiveSpeechThreshold: positive,
    negativeSpeechThreshold: Math.max(0.1, positive - 0.15),
  };
};

/**
 * Tear an instance down without letting teardown throw or leak.
 *
 * `MicVAD.destroy()` calls `getAudioInstances()` before it checks any state,
 * and that accessor throws whenever the stream, audio context or vad node are
 * still null — which is the case for an instance that was created but never
 * started. React StrictMode's double-invoked effects hit exactly that sequence,
 * and the wrapper's error state used to latch the mic off as a result.
 *
 * Do not "simplify" this to a bare `vad.destroy()`: the try/catch is the fix,
 * not defensive noise.
 */
const safeDestroy = async (vad: MicVAD): Promise<void> => {
  try {
    await vad.destroy();
  } catch (error) {
    // The throw happened at destroy()'s first statement, so it never reached
    // `model.release()`. Release it here so a create-then-teardown cycle does
    // not strand an ONNX session. `model` is private in the published types,
    // hence the narrow cast; every access is optional, so this degrades to a
    // no-op if the field is ever renamed.
    const model = (
      vad as unknown as { model?: { release?: () => Promise<void> } }
    ).model;
    try {
      await model?.release?.();
    } catch {
      // Nothing further to release.
    }
    console.debug("VAD torn down before it started:", messageOf(error));
  }
};

const concatFrames = (frames: Float32Array[]): Float32Array => {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
};

export const useVoiceInput = ({
  active,
  onPartial,
  onUtterance,
  onError,
}: VoiceInputOptions): VoiceInputState => {
  const { selectedSttProvider, allSttProviders, selectedAudioDevices } =
    useApp();
  const micDeviceId = selectedAudioDevices.input?.id;
  // The name is what bridges the native id to the WebView one; without it a
  // mismatched id can only fall back to the system default.
  const micDeviceName = selectedAudioDevices.input?.name;

  // Latest callbacks and provider selection, so the VAD's own options never
  // need to change identity.
  const onPartialRef = useRef(onPartial);
  const onUtteranceRef = useRef(onUtterance);
  const onErrorRef = useRef(onError);
  const providerRef = useRef(selectedSttProvider);
  const providersRef = useRef(allSttProviders);

  useEffect(() => {
    onPartialRef.current = onPartial;
  }, [onPartial]);
  useEffect(() => {
    onUtteranceRef.current = onUtterance;
  }, [onUtterance]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    providerRef.current = selectedSttProvider;
  }, [selectedSttProvider]);
  useEffect(() => {
    providersRef.current = allSttProviders;
  }, [allSttProviders]);

  const [listening, setListening] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState<string | false>(false);
  // Flips true once an instance exists and can be started. `active` is applied
  // against this rather than against mount, so a start requested while the
  // model is still loading is applied when it finishes instead of being lost.
  const [ready, setReady] = useState(false);

  const vadRef = useRef<MicVAD | null>(null);
  // Bumped by every teardown. Async work captures the value it began with and
  // discards its result if the instance it was acting on has since been
  // replaced — otherwise a `start()` that resolves late would report state for
  // a destroyed VAD, or worse, act on one.
  const generationRef = useRef(0);
  // vad-web builds its own AudioContext inside start() and never resumes it —
  // there is no `resume()` call anywhere in the library. WebView2 can hand back
  // a context in the "suspended" state, and a suspended context connects the
  // worklet but never schedules it: the stream is live, the microphone indicator
  // is on, and the VAD receives zero frames. The result is no transcript and no
  // error to explain it, in every room that shares this hook. Owning the context
  // here is what lets us resume it as part of starting.
  const audioContextRef = useRef<AudioContext | null>(null);

  const framesRef = useRef<Float32Array[]>([]);
  const accumulatingRef = useRef(false);
  const partialInFlightRef = useRef(false);
  const lastPartialAtRef = useRef(0);
  // Proves audio is actually flowing through the worklet. Without this, a
  // context that never schedules is indistinguishable from a silent room.
  const sawFrameRef = useRef(false);

  const resetAccumulator = useCallback(() => {
    accumulatingRef.current = false;
    framesRef.current = [];
    partialInFlightRef.current = false;
    onPartialRef.current?.("");
  }, []);

  const resolveProvider = () =>
    providerRef.current.provider
      ? providersRef.current.find((p) => p.id === providerRef.current.provider) ??
        null
      : null;

  /** Transcribe a buffer, or return "" when no provider is configured. */
  const transcribe = async (audio: Float32Array): Promise<string> => {
    const provider = resolveProvider();
    if (!provider) return "";
    return fetchSTT({
      provider,
      selectedProvider: providerRef.current,
      audio: floatArrayToWav(audio, 16000, "wav"),
    });
  };

  /**
   * Durable speech blocks (Phase 4 R2, issue #15). The queue owns retry, backoff
   * and dead-lettering, so a provider failure can no longer destroy captured
   * audio: the frame accumulator is cleared only *after* the block has been
   * handed over. Every callback reads a ref, so the queue can be created once
   * and still see current props.
   */
  const queueRef = useRef<SpeechBlockQueue<Float32Array> | null>(null);
  const getQueue = (): SpeechBlockQueue<Float32Array> => {
    if (!queueRef.current) {
      queueRef.current = new SpeechBlockQueue<Float32Array>({
        transcribe: (block) => transcribe(block.audio),
        onText: async (text) => {
          const trimmed = text.trim();
          // Clear the live partial BEFORE handing the final words over. The Ask
          // room surfaces the final utterance through the same channel it uses
          // for partials, so clearing afterwards erased the text that had just
          // arrived and the transcript appeared to vanish.
          onPartialRef.current?.("");
          if (!trimmed) {
            if (!resolveProvider()) {
              onErrorRef.current?.(
                "No speech provider selected. Please select one in settings."
              );
            }
            return;
          }
          // Phase 4 R3: durable BEFORE the caller can hand this to the AI, and
          // the queue awaits this callback, so the write really has completed
          // first. A persistence failure is reported, never fatal.
          try {
            const store = await getTranscriptStore();
            await store.addEvent({
              source: "microphone",
              kind: "final",
              text: trimmed,
            });
          } catch (persistError) {
            console.warn("Could not persist mic transcript event:", persistError);
          }
          onUtteranceRef.current(trimmed);
        },
        onError: (error) => {
          console.error("Mic transcription failed:", error);
          onPartialRef.current?.("");
          onErrorRef.current?.(messageOf(error));
        },
        onDeadLetter: (block, error) => {
          // The audio stays in `queueRef.current.deadLetters`, and R3 gives it a
          // durable home: the raw f32 bytes go to `transcript_dead_letter_audio`
          // so a provider outage costs a retry, not the speech.
          void (async () => {
            try {
              const store = await getTranscriptStore();
              const raw = new Uint8Array(
                block.audio.buffer.slice(
                  block.audio.byteOffset,
                  block.audio.byteOffset + block.audio.byteLength
                )
              );
              await store.addDeadLetter({
                source: "microphone",
                audio: raw,
                attempts: block.attempts,
                error: messageOf(error),
              });
            } catch (persistError) {
              console.warn("Could not persist dead-letter audio:", persistError);
            }
          })();
          onErrorRef.current?.(
            `Microphone audio could not be transcribed after ${block.attempts} attempts: ${messageOf(error)}`
          );
        },
        onOverflow: () => {
          onErrorRef.current?.(
            "Speech queue is full; this utterance was not transcribed."
          );
        },
      });
    }
    return queueRef.current;
  };
  useEffect(() => () => queueRef.current?.dispose(), []);

  // Build (and rebuild) the VAD. Rebuilt per microphone id, which is also the
  // only input to the capture constraints below.
  useEffect(() => {
    // Bump the generation so any start/pause still in flight from the previous
    // instance discards its result. The value itself is read by the effect that
    // applies `active`; here it is only the increment that matters.
    ++generationRef.current;
    let disposed = false;

    vadRef.current = null;
    setReady(false);
    setLoading(true);
    setListening(false);
    setErrored(false);
    sawFrameRef.current = false;
    resetAccumulator();

    const acquire = async () => {
      // `getMicrophoneStream` verifies the stored id against the WebView's own
      // device list and recovers the device by name when it does not match.
      // The stored id comes from the Rust backend and is a native (WASAPI /
      // Core Audio / PulseAudio) endpoint id, which the WebView does not
      // recognise — passing it straight to getUserMedia threw
      // OverconstrainedError and the mic captured nothing at all.
      const stream = await getMicrophoneStream(micDeviceId, micDeviceName);
      const track = stream.getAudioTracks()[0];
      console.info(
        `[voice] mic acquired: ${stream.getAudioTracks().length} track(s), ` +
          `muted=${track?.muted}, enabled=${track?.enabled}, ` +
          `settings=${JSON.stringify(track?.getSettings?.() ?? {})}`
      );
      return stream;
    };

    // Built here rather than in `acquire` because `MicVAD.start()` reads it
    // synchronously, and passed in so vad-web adopts ours instead of making its
    // own unreachable one. A context created before the user's gesture starts
    // suspended — the start path resumes it.
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    console.info(
      `[voice] audio context created: state="${audioContext.state}", ` +
        `sampleRate=${audioContext.sampleRate}`
    );

    const thresholds = speechThresholds(
      readStoredVadConfig().voice_sensitivity
    );

    const setup = async () => {
      let vad: MicVAD;
      try {
        vad = await MicVAD.new({
          ...thresholds,
          // Phase 4 R1: the shared turn-finalization hangover (2000 ms - see
          // src/lib/turn-boundary.ts). vad-web's default is 1400 ms, which cut
          // the same sentence at a different pause than the Rust VAD loop used
          // for system audio. vad-web floors this to whole 96 ms frames and
          // restarts the countdown on speech, exactly like the Rust side.
          redemptionMs: micRedemptionMs(),
          // Serve the VAD runtime (worklet, Silero model, onnxruntime wasm) from
          // local assets in public/vad. The library defaults to jsdelivr CDN
          // URLs, which the app's CSP (script-src 'self') blocks — so the VAD
          // would silently fail to load and the mic would capture nothing.
          baseAssetPath: "/vad/",
          onnxWASMBasePath: "/vad/",
          // Must be explicit: vad-web's default is `true`, which makes
          // `MicVAD.new` start capturing the moment the model loads, before
          // `active` has any say. Actually starting is the drive effect's job —
          // it is the only place that knows `active`, and it applies `active`
          // again once `ready` flips, so a start requested during load is not
          // lost.
          startOnLoad: false,
          // Supplying the context keeps `ownsAudioContext` false, so vad-web will
          // not close it in destroy() — the teardown below does that instead.
          audioContext,
          getStream: acquire,
          // vad-web stops every track on pause, which is what we want — the mic
          // light must go out when the VAD is off. But its default resume
          // re-acquires the stream with its OWN hardcoded constraints, so a
          // pause/resume cycle silently swapped in the system-default device and
          // dropped the gain and echo settings. Both directions go through
          // `acquire`, so the mic that comes back is the one the user selected.
          pauseStream: async (stream: MediaStream) => {
            stream.getTracks().forEach((track) => track.stop());
          },
          resumeStream: acquire,
          onSpeechStart: () => {
            framesRef.current = [];
            accumulatingRef.current = true;
            lastPartialAtRef.current = Date.now();
            onPartialRef.current?.("");
          },
          onVADMisfire: () => {
            accumulatingRef.current = false;
            framesRef.current = [];
            onPartialRef.current?.("");
          },
          onFrameProcessed: (
            probabilities: { isSpeech: number },
            frame: Float32Array
          ) => {
            // Proves the worklet is actually running and the model is returning
            // verdicts. Without it, a context that never schedules looks exactly
            // like a silent room.
            if (!sawFrameRef.current) {
              sawFrameRef.current = true;
              console.info(
                `[voice] first audio frame reached the VAD ` +
                  `(isSpeech=${probabilities.isSpeech.toFixed(3)}, ` +
                  `threshold=${thresholds.positiveSpeechThreshold.toFixed(2)})`
              );
            }

            if (!accumulatingRef.current) return;
            framesRef.current.push(frame);

            const now = Date.now();
            if (
              now - lastPartialAtRef.current < PARTIAL_INTERVAL_MS ||
              partialInFlightRef.current
            ) {
              return;
            }
            if (!resolveProvider()) return;

            lastPartialAtRef.current = now;
            partialInFlightRef.current = true;
            void transcribe(concatFrames(framesRef.current))
              .then((partial) => {
                if (partial && partial.trim()) onPartialRef.current?.(partial);
              })
              .catch((err) => console.warn("Partial mic STT failed:", err))
              .finally(() => {
                partialInFlightRef.current = false;
              });
          },
          onSpeechEnd: (audio) => {
            accumulatingRef.current = false;
            // Phase 4 R2: the queue takes ownership of the audio here, so
            // clearing the accumulator can no longer lose the utterance. Its
            // `transcribe` is the same provider call as before; a failure now
            // means retry-then-dead-letter instead of silent loss.
            framesRef.current = [];
            getQueue().enqueue("microphone", audio);
          },
        });
      } catch (error) {
        // Model/worklet load failed. This is recoverable: the effect re-runs on
        // a device change, and nothing here latches the mic off.
        if (disposed) return;
        setLoading(false);
        setErrored(messageOf(error));
        onErrorRef.current?.(`Voice input unavailable: ${messageOf(error)}`);
        return;
      }

      if (disposed) {
        // Torn down while the model was still loading, so this instance was
        // never started — `destroy()` would throw, see `safeDestroy`.
        void safeDestroy(vad);
        return;
      }

      vadRef.current = vad;
      setLoading(false);
      setReady(true);
    };

    void setup();

    return () => {
      disposed = true;
      // Invalidate any in-flight start/pause from this generation.
      generationRef.current += 1;
      const vad = vadRef.current;
      vadRef.current = null;
      if (vad) void safeDestroy(vad);
      // We supplied the context, so vad-web's own close — guarded by
      // `ownsAudioContext` — never runs. Closing it here is what stops a
      // remount (device or sensitivity change) from leaking one per switch.
      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (context && context.state !== "closed") void context.close();
    };

    // `micDeviceId`/`micDeviceName` are the inputs to `acquire`, so they are
    // this effect's identity — a device rename must rebuild the VAD too.
    // `resetAccumulator` is stable.
  }, [micDeviceId, micDeviceName, resetAccumulator]);

  // Apply `active` to the instance, but only once it exists. This depends on
  // `ready` as well as `active` so that a start requested during model load is
  // applied the moment the model finishes — the previous implementation dropped
  // those starts silently.
  useEffect(() => {
    const vad = vadRef.current;
    if (!ready || !vad) return;

    const generation = generationRef.current;

    if (active && !vad.listening) {
      void (async () => {
        try {
          // The fix for a silently dead microphone. vad-web never resumes its
          // context, so if the browser created it suspended the worklet is
          // connected but never scheduled: no frames, no VAD, no transcript and
          // no error. Resuming here, on the user's gesture that turned the mic
          // on, is what starts audio actually flowing.
          const context = audioContextRef.current;
          if (context && context.state !== "running") {
            await context.resume();
            console.info(
              `[voice] audio context resumed: state="${context.state}"`
            );
          }
          await vad.start();
          if (generation !== generationRef.current) return;
          setErrored(false);
          setListening(true);
        } catch (error) {
          if (generation !== generationRef.current) return;
          // A genuine failure — a rejected `getUserMedia`, a device already in
          // use. Reported, but deliberately not latched: `ready` stays true, so
          // the next toggle retries rather than leaving a permanently dead mic.
          console.error("Mic capture failed:", error);
          setListening(false);
          setErrored(messageOf(error));
          onErrorRef.current?.(messageOf(error));
        }
      })();
    } else if (!active && vad.listening) {
      void (async () => {
        try {
          await vad.pause();
        } catch (error) {
          console.warn("VAD pause failed:", error);
        }
        if (generation !== generationRef.current) return;
        setListening(false);
        resetAccumulator();
      })();
    }
  }, [active, ready, resetAccumulator]);

  return {
    listening,
    loading,
    errored,
  };
};
