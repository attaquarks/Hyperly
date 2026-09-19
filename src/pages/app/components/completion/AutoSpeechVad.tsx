import { fetchSTT } from "@/lib";
import { UseCompletionReturn } from "@/types";
import { useMicVAD } from "@ricky0123/vad-react";
import { LoaderCircleIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components";
import { useApp } from "@/contexts";
import { floatArrayToWav } from "@/lib/utils";

interface AutoSpeechVADProps {
  submit: UseCompletionReturn["submit"];
  setState: UseCompletionReturn["setState"];
  enableVAD: UseCompletionReturn["enableVAD"];
  setEnableVAD: UseCompletionReturn["setEnableVAD"];
  setMicTranscript: UseCompletionReturn["setMicTranscript"];
  microphoneDeviceId?: string;
}

// How often a live partial transcript is produced while the user is still
// speaking. Mirrors the ~2s cadence of the listen panel's partial updates.
const PARTIAL_INTERVAL_MS = 2000;

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

const AutoSpeechVADInternal = ({
  submit,
  setState,
  enableVAD,
  setEnableVAD,
  setMicTranscript,
  microphoneDeviceId,
}: AutoSpeechVADProps) => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const { selectedSttProvider, allSttProviders } = useApp();

  // Frames of the current utterance, accumulated between speech start and
  // speech end so partial transcripts can be produced mid-utterance.
  const framesRef = useRef<Float32Array[]>([]);
  const accumulatingRef = useRef(false);
  const partialInFlightRef = useRef(false);
  const lastPartialAtRef = useRef(0);

  const resolveProviderConfig = () => {
    if (!selectedSttProvider.provider) return null;
    return (
      allSttProviders.find((p) => p.id === selectedSttProvider.provider) ?? null
    );
  };

  const audioConstraints: MediaTrackConstraints =
    microphoneDeviceId && microphoneDeviceId !== "default"
      ? { deviceId: { exact: microphoneDeviceId } }
      : {};

  const vad = useMicVAD({
    userSpeakingThreshold: 0.6,
    // Never auto-start: the mic is driven by enableVAD (mic button / global
    // shortcut) via the effect below.
    startOnLoad: false,
    // vad-react >=0.0.31 replaced `additionalAudioConstraints` with a `getStream`
    // callback; mirror the lib's default audio constraints + our device selection.
    getStream: async () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
          ...audioConstraints,
        },
      }),
    onSpeechStart: () => {
      framesRef.current = [];
      accumulatingRef.current = true;
      lastPartialAtRef.current = Date.now();
      setMicTranscript("");
    },
    onVADMisfire: () => {
      accumulatingRef.current = false;
      framesRef.current = [];
      setMicTranscript("");
    },
    onFrameProcessed: (_probabilities: any, frame: Float32Array) => {
      // Verified against the installed vad-web: `onFrameProcessed` always
      // receives the frame (RealTimeVADCallbacks in real-time-vad.d.ts),
      // so live partials are always available while accumulating.
      if (!accumulatingRef.current) return;
      framesRef.current.push(frame);

      const now = Date.now();
      if (
        now - lastPartialAtRef.current < PARTIAL_INTERVAL_MS ||
        partialInFlightRef.current
      ) {
        return;
      }
      const providerConfig = resolveProviderConfig();
      if (!providerConfig) return;

      lastPartialAtRef.current = now;
      partialInFlightRef.current = true;
      const audioBlob = floatArrayToWav(
        concatFrames(framesRef.current),
        16000,
        "wav"
      );
      fetchSTT({
        provider: providerConfig,
        selectedProvider: selectedSttProvider,
        audio: audioBlob,
      })
        .then((partial) => {
          if (partial && partial.trim()) setMicTranscript(partial);
        })
        .catch((err) => console.warn("Partial mic STT failed:", err))
        .finally(() => {
          partialInFlightRef.current = false;
        });
    },
    onSpeechEnd: async (audio) => {
      accumulatingRef.current = false;
      framesRef.current = [];
      try {
        // convert float32array to blob
        const audioBlob = floatArrayToWav(audio, 16000, "wav");

        if (!selectedSttProvider.provider) {
          console.warn("No speech provider selected");
          setState((prev: any) => ({
            ...prev,
            error:
              "No speech provider selected. Please select one in settings.",
          }));
          return;
        }

        const providerConfig = resolveProviderConfig();
        if (!providerConfig) {
          console.warn("Selected speech provider configuration not found");
          setState((prev: any) => ({
            ...prev,
            error:
              "Speech provider configuration not found. Please check your settings.",
          }));
          return;
        }

        setIsTranscribing(true);

        const transcription = await fetchSTT({
          provider: providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
        });

        if (transcription) {
          // Show the final utterance under the "User" label, then hand it to
          // the completion flow.
          setMicTranscript(transcription);
          submit(transcription);
        }
      } catch (error) {
        console.error("Failed to transcribe audio:", error);
        setState((prev: any) => ({
          ...prev,
          error:
            error instanceof Error ? error.message : "Transcription failed",
        }));
      } finally {
        setIsTranscribing(false);
      }
    },
  });

  // The mic's on/off state is owned by useCompletion (enableVAD) so the mic
  // button, the global shortcut, and any future caller all drive one flag;
  // the VAD simply follows it.
  useEffect(() => {
    if (enableVAD && !vad.listening) {
      vad.start();
    } else if (!enableVAD && vad.listening) {
      vad.pause();
      accumulatingRef.current = false;
      framesRef.current = [];
      setMicTranscript("");
    }
  }, [enableVAD, vad.listening]);

  return (
    <Button
      size="icon"
      onClick={() => setEnableVAD(!enableVAD)}
      className="cursor-pointer"
      title={enableVAD ? "Stop voice input" : "Start voice input"}
    >
      {isTranscribing ? (
        <LoaderCircleIcon className="h-4 w-4 animate-spin text-green-500" />
      ) : vad.userSpeaking ? (
        <LoaderCircleIcon className="h-4 w-4 animate-spin" />
      ) : enableVAD ? (
        <MicOffIcon className="h-4 w-4 animate-pulse" />
      ) : (
        <MicIcon className="h-4 w-4" />
      )}
    </Button>
  );
};

export const AutoSpeechVAD = (props: AutoSpeechVADProps) => {
  return <AutoSpeechVADInternal key={props.microphoneDeviceId} {...props} />;
};
