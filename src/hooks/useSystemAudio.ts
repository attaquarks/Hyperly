import { useEffect, useState, useCallback, useRef } from "react";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import { fetchSTT, fetchAIResponse } from "@/lib/functions";
import { SpeechBlockQueue } from "@/lib/speech-block-queue";
import { getTranscriptStore } from "@/lib/database/transcript-adapter";
import {
  DEFAULT_QUICK_ACTIONS,
  DEFAULT_SYSTEM_PROMPT,
  LISTEN_MODE_PROMPTS,
  STORAGE_KEYS,
} from "@/config";
import {
  safeLocalStorage,
  generateConversationTitle,
  saveConversation,
  CONVERSATION_SAVE_DEBOUNCE_MS,
  generateConversationId,
  generateMessageId,
  getConversationById,
} from "@/lib";
import { Message } from "@/types/completion";
import {
  CaptureBehavior,
  KnowledgeFile,
  ListenMode,
  TranscriptSegment,
} from "@/types/system-audio";
import { useKnowledge } from "./useKnowledge";
import { planUtterance } from "@/lib/response-policy";
import {
  DEFAULT_VAD_CONFIG,
  persistVadConfig,
  readStoredVadConfig,
  type VadConfig,
} from "@/lib/vad-config";

// VAD configuration lives in @/lib/vad-config so the Audio Settings page and
// this hook share one definition instead of two that drift apart.
// Re-exported here because the Listen settings panel imports `VadConfig` from
// this module.
export type { VadConfig };

/// Persisted preference for Listen's "Mic + system audio" toggle.
const MIC_WITH_SYSTEM_KEY = "listen_mic_with_system";

// Compose the system prompt for listen-panel AI calls: the active mode's
// preset (when it has one) rides on top of the user's configured prompt.
const composeListenPrompt = (base: string, mode: ListenMode): string => {
  const preset = LISTEN_MODE_PROMPTS[mode];
  // Every message reaching the model is tagged with where the words came from:
  // "User (microphone)" is what the person wearing the headset said, and an
  // untagged message is audio picked up out of the room by the system. Without
  // this the model cannot tell the user's own words from someone else's, and
  // answers the room instead of the user.
  const legend =
    'Each incoming message is prefixed with its source. ' +
    '"User (microphone): ..." is the user speaking directly to you. ' +
    'Anything without that prefix is audio captured from the system/room, ' +
    'which is someone else talking. Address the user directly and treat the ' +
    "user's own words as the request.";
  return preset
    ? `${base}\n\n${legend}\n\n${preset}`
    : `${base}\n\n${legend}`;
};

// Chat message interface (reusing from useCompletion)
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// Conversation interface (reusing from useCompletion)
export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type useSystemAudioType = ReturnType<typeof useSystemAudio>;

/// The capture engine reads its VAD settings from the spawn payload, not from
/// `get_vad_config`, so every start has to carry the current config. Reading
/// storage here instead of closing over React state is what lets a change made
/// on the Audio Settings page — a separate component tree — reach the engine.
const currentSpawnVadConfig = (): VadConfig => ({
  ...readStoredVadConfig(),
  // The engine is always the Rust VAD loop; the stored flag only seeds the
  // numeric fields below.
  enabled: true,
});

/// `active` scopes this hook's keyboard shortcuts to the panel that is on
/// screen. Both panels stay mounted and are hidden with CSS, so a global
/// listener would let Space start a system-audio capture while the user is
/// looking at Ask.
export function useSystemAudio({ active = true }: { active?: boolean } = {}) {
  const globalShortcuts = useGlobalShortcuts();
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  const [lastTranscription, setLastTranscription] = useState<string>("");
  const [lastAIResponse, setLastAIResponse] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [setupRequired, setSetupRequired] = useState<boolean>(false);
  const [quickActions, setQuickActions] = useState<string[]>([]);
  const [isManagingQuickActions, setIsManagingQuickActions] =
    useState<boolean>(false);
  const [vadConfig, setVadConfig] = useState<VadConfig>(DEFAULT_VAD_CONFIG);
  const [recordingProgress, setRecordingProgress] = useState<number>(0); // For continuous mode
  // Live, growing transcript shown while audio is still being captured. Each "speech-partial"
  // event from the Rust side yields an STT result that is appended here so the user can see the
  // running text. When they hit Stop & Send, the final canonical transcript replaces this.
  const [livePartial, setLivePartial] = useState<string>("");
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [listenMode, setListenMode] = useState<ListenMode>("auto");
  // Ref mirror so the speech-detected listener — whose effect deps don't
  // include listenMode — always reads the current mode.
  const listenModeRef = useRef<ListenMode>("auto");
  // Listening-bar behavior. All three modes run the same VAD capture engine;
  // they differ only in when an utterance reaches the AI: "auto" sends every
  // pause, "manual" holds everything until the user stops, and "questions"
  // sends question-shaped utterances immediately and holds the rest.
  const [captureBehavior, setCaptureBehaviorState] = useState<CaptureBehavior>(
    () => {
      try {
        const saved = safeLocalStorage.getItem(
          STORAGE_KEYS.SYSTEM_AUDIO_CAPTURE_BEHAVIOR
        );
        if (saved) {
          const parsed = JSON.parse(saved);
          if (["auto", "manual", "questions"].includes(parsed)) return parsed;
        }
      } catch {
        // fall through to the default
      }
      return "auto";
    }
  );
  const captureBehaviorRef = useRef<CaptureBehavior>(captureBehavior);
  // Mirrors `capturing` for callbacks that must not act on a stale closure — a
  // mode switch that read `false` while the engine was live would try to start
  // a second capture and hit "Capture already running".
  const capturingRef = useRef<boolean>(false);
  // Mirrors the `active` option for the same reason `capturingRef` exists: the
  // Space listener is registered once and must not read a stale panel state.
  const panelActiveRef = useRef<boolean>(active);
  // Text transcribed under Manual / "Auto · On questions" that has not been
  // sent yet. Switching to Auto folds it into the next send; a stop sends it
  // immediately.
  const pendingTranscriptRef = useRef<string>("");
  // Mirrors `livePartial` so a stop can include the in-progress utterance that
  // React state has not committed yet.
  const livePartialRef = useRef<string>("");
  // True while a `speech-detected` utterance is being transcribed, and set when
  // a stop arrives during that window so the stop is applied once the
  // transcript lands instead of dropping it.
  const sttInFlightRef = useRef<boolean>(false);
  const stopRequestedRef = useRef<boolean>(false);
  // Guards the async spawn against a concurrent start.
  const startingRef = useRef<boolean>(false);

  // AI-suggested follow-ups, regenerated after each answer.
  const [suggestedFollowUps, setSuggestedFollowUps] = useState<string[]>([]);
  // Library knowledge: the folder's file list plus the selected file's text,
  // injected into the next AI call's system prompt.
  const {
    folderName: knowledgeFolderName,
    folderFiles: knowledgeFolderFiles,
    knowledgeFile,
    isReading: isKnowledgeReading,
    readError: knowledgeReadError,
    pickFolder: pickKnowledgeFolder,
    selectFile: selectKnowledgeFile,
    clearKnowledge: clearKnowledgeFile,
  } = useKnowledge();
  const knowledgeFileRef = useRef<KnowledgeFile | null>(null);
  useEffect(() => {
    knowledgeFileRef.current = knowledgeFile;
  }, [knowledgeFile]);
  const sessionStartRef = useRef<number>(Date.now());
  // Screenshot captured via the listen panel — attached to the next AI call when manual stop fires.
  const [pendingScreenshot, setPendingScreenshot] = useState<string | null>(null);
  // Mirror in a ref so callbacks always see the latest value without rebuilding deps.
  const pendingScreenshotRef = useRef<string | null>(null);
  useEffect(() => {
    pendingScreenshotRef.current = pendingScreenshot;
  }, [pendingScreenshot]);
  // Monotonic counter for transcript segment ids. `Date.now()` collides when a
  // partial and a final land in the same millisecond, which produced duplicate
  // React keys; a counter can never repeat.
  const segmentIdRef = useRef(0);
  const nextSegmentId = () => `segment-${++segmentIdRef.current}`;
  // Live partial from the Listen "User" mic. The VAD itself runs in
  // ListenUserMic, lazy-loaded so the VAD runtime stays off the overlay's
  // first-paint graph. Rust still owns system audio.
  const [userMicPartial, setUserMicPartial] = useState<string>("");
  // Listen's "Mic + system audio" toggle. Off by default: system audio alone is
  // the mode that needs no browser microphone at all, and turning the mic on is
  // a deliberate choice. The two sources are captured and labelled separately —
  // system audio as "Speaker", the browser mic as "User" — so this adds a
  // stream, it never merges one. Persisted so the choice survives a restart.
  const [micWithSystem, setMicWithSystemState] = useState<boolean>(() => {
    try {
      return safeLocalStorage.getItem(MIC_WITH_SYSTEM_KEY) === "true";
    } catch {
      return false;
    }
  });
  const setMicWithSystem = useCallback((next: boolean) => {
    setMicWithSystemState(next);
    try {
      safeLocalStorage.setItem(MIC_WITH_SYSTEM_KEY, String(next));
    } catch {
      // A storage failure only costs the persisted preference.
    }
  }, []);
  const [isContinuousMode, setIsContinuousMode] = useState<boolean>(false);
  const [isRecordingInContinuousMode, setIsRecordingInContinuousMode] =
    useState<boolean>(false);

  const [conversation, setConversation] = useState<ChatConversation>({
    id: "",
    title: "",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  });

  // Context management states
  const [useSystemPrompt, setUseSystemPrompt] = useState<boolean>(true);
  const [contextContent, setContextContent] = useState<string>("");

  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    selectedAudioDevices,
  } = useApp();
  const abortControllerRef = useRef<AbortController | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Load context settings and VAD config from localStorage on mount
  useEffect(() => {
    const savedContext = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT
    );
    if (savedContext) {
      try {
        const parsed = JSON.parse(savedContext);
        setUseSystemPrompt(parsed.useSystemPrompt ?? true);
        setContextContent(parsed.contextContent ?? "");
      } catch (error) {
        console.error("Failed to load system audio context:", error);
      }
    }

    // Load VAD config. `readStoredVadConfig` merges what is stored over the
    // defaults, so a config written before a field existed — everyone
    // upgrading past `peak_threshold` becoming `voice_sensitivity` — cannot
    // load with that field undefined and bind a slider to NaN.
    setVadConfig(readStoredVadConfig());

    // Load listen mode
    const savedListenMode = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_LISTEN_MODE
    );
    if (savedListenMode) {
      try {
        const parsed = JSON.parse(savedListenMode);
        if (
          [
            "auto",
            "general",
            "interview",
            "coding",
            "translate",
            "meeting",
          ].includes(parsed)
        ) {
          setListenMode(parsed);
          listenModeRef.current = parsed;
        }
      } catch (error) {
        console.error("Failed to load listen mode:", error);
      }
    }

    // Nothing else sets the capture behavior: the dropdown is its only author,
    // and the state initializer above has already read what it stored. Deriving
    // a mode from the legacy `vad_config.enabled` flag used to drop anyone with
    // an old `enabled: false` into Manual without them ever choosing it — the
    // bar showed Auto while every utterance was held.
  }, []);

  // Keep the capture-state ref in step with the React state.
  useEffect(() => {
    capturingRef.current = capturing;
  }, [capturing]);

  // Load quick actions from localStorage on mount
  useEffect(() => {
    const savedActions = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS
    );
    if (savedActions) {
      try {
        const parsed = JSON.parse(savedActions);
        setQuickActions(parsed);
      } catch (error) {
        console.error("Failed to load quick actions:", error);
        setQuickActions(DEFAULT_QUICK_ACTIONS);
      }
    } else {
      setQuickActions(DEFAULT_QUICK_ACTIONS);
    }
  }, []);

  // Handle continuous recording progress events AND error events
  useEffect(() => {
    let progressUnlisten: (() => void) | undefined;
    let startUnlisten: (() => void) | undefined;
    let stopUnlisten: (() => void) | undefined;
    let errorUnlisten: (() => void) | undefined;
    let discardedUnlisten: (() => void) | undefined;

    const setupContinuousListeners = async () => {
      try {
        // Progress updates (every second)
        progressUnlisten = await listen("recording-progress", (event) => {
          const seconds = event.payload as number;
          setRecordingProgress(seconds);
        });

        // Recording started
        startUnlisten = await listen("continuous-recording-start", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(true);
        });

        // Recording stopped
        stopUnlisten = await listen("continuous-recording-stopped", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(false);
        });

        // Audio encoding errors
        errorUnlisten = await listen("audio-encoding-error", (event) => {
          const errorMsg = event.payload as string;
          console.error("Audio encoding error:", errorMsg);
          setError(`Failed to process audio: ${errorMsg}`);
          setIsProcessing(false);
          setIsAIProcessing(false);
          setIsRecordingInContinuousMode(false);
        });

        // Speech discarded (too short)
        discardedUnlisten = await listen("speech-discarded", (event) => {
          const reason = event.payload as string;
          console.log("Speech discarded:", reason);
          // Don't show error - this is expected behavior
        });
      } catch (err) {
        console.error("Failed to setup continuous recording listeners:", err);
      }
    };

    setupContinuousListeners();

    return () => {
      if (progressUnlisten) progressUnlisten();
      if (startUnlisten) startUnlisten();
      if (stopUnlisten) stopUnlisten();
      if (errorUnlisten) errorUnlisten();
      if (discardedUnlisten) discardedUnlisten();
    };
  }, []);

  const elapsedSeconds = () =>
    Math.max(0, Math.floor((Date.now() - sessionStartRef.current) / 1000));

  const upsertPartialSegment = (text: string) => {
    const timestamp = elapsedSeconds();
    setTranscriptSegments((segments) => {
      const last = segments[segments.length - 1];
      if (last?.isPartial) {
        return [
          ...segments.slice(0, -1),
          { ...last, timestamp, text, isPartial: true },
        ];
      }
      return [
        ...segments,
        {
          id: nextSegmentId(),
          timestamp,
          speaker: "Speaker",
          text,
          isPartial: true,
        },
      ];
    });
  };

  const finalizeTranscriptSegment = (text: string) => {
    const timestamp = elapsedSeconds();
    setTranscriptSegments((segments) => {
      const last = segments[segments.length - 1];
      if (last?.isPartial) {
        return [
          ...segments.slice(0, -1),
          { ...last, timestamp, text, isPartial: false },
        ];
      }
      return [
        ...segments,
        {
          id: nextSegmentId(),
          timestamp,
          speaker: "Speaker",
          text,
          isPartial: false,
        },
      ];
    });
  };

  // Typed input (quick actions, custom follow-ups) joins the transcript as
  // "User" so the thread reads as one conversation.
  const pushUserSegment = (text: string) => {
    const timestamp = elapsedSeconds();
    setTranscriptSegments((segments) => [
      ...segments,
      {
        id: nextSegmentId(),
        timestamp,
        speaker: "User",
        text,
        isPartial: false,
      },
    ]);
  };

  // ---- Phase 4 R2: durable speech blocks (the room's side) ------------------
  //
  // The listener effect below re-runs whenever the STT provider changes or the
  // conversation grows, so a queue created inside it would be rebuilt - and
  // would drop blocks it was still retrying. The queue therefore lives for the
  // hook's lifetime and reads state through refs.

  /** Latest STT provider config, so a retry uses what the user has now. */
  const sttConfigRef = useRef({
    selected: selectedSttProvider,
    providers: allSttProviders,
  });
  useEffect(() => {
    sttConfigRef.current = {
      selected: selectedSttProvider,
      providers: allSttProviders,
    };
  }, [selectedSttProvider, allSttProviders]);

  /** One attempt, with the 30 s ceiling the old inline handler enforced. */
  const withSttTimeout = <T,>(promise: Promise<T>): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error("Speech transcription timed out (30s)")),
          30000
        )
      ),
    ]);

  /**
   * Everything that happens once a room utterance has text: persist it to the
   * transcript, then let `planUtterance` decide send / hold / apply a deferred
   * stop. Moved here verbatim from the listener so a retried block runs the
   * same path as one that succeeded first time.
   */
  const applyTranscriptionRef = useRef<(text: string) => Promise<void>>(
    async () => {}
  );
  useEffect(() => {
    applyTranscriptionRef.current = async (text: string) => {
      setLastTranscription(text);
      finalizeTranscriptSegment(text);
      // The full transcript just arrived - clear the live running one so the UI
      // shows the canonical final text and the AI response.
      setLivePartial("");
      livePartialRef.current = "";
      setError("");

      // Phase 4 R3: the event is durable BEFORE any AI step runs, so a provider
      // failure - or the app dying - can never lose the utterance. A persistence
      // error is reported but must not stop the answer.
      try {
        const store = await getTranscriptStore();
        await store.addEvent({
          source: "system",
          kind: "final",
          text,
          conversationId: conversation.id || null,
        });
      } catch (persistError) {
        console.warn("Could not persist transcript event:", persistError);
      }

      // One call decides the outcome for every mode - send now, hold, or apply a
      // stop pressed while this utterance was transcribing - so Auto cannot
      // drift into the Manual/Questions path.
      const plan = planUtterance(
        captureBehaviorRef.current,
        text,
        pendingTranscriptRef.current,
        stopRequestedRef.current
      );
      stopRequestedRef.current = false;
      pendingTranscriptRef.current = plan.pending;

      if (plan.kind === "hold") return;

      if (plan.kind === "stop-and-send") {
        await stopAndSend(plan.text);
        return;
      }

      const baseSystemPrompt = useSystemPrompt
        ? systemPrompt || DEFAULT_SYSTEM_PROMPT
        : contextContent || DEFAULT_SYSTEM_PROMPT;
      const effectiveSystemPrompt = composeListenPrompt(
        baseSystemPrompt,
        listenModeRef.current
      );

      const previousMessages = (conversation.messages ?? []).map((msg) => {
        return { role: msg.role, content: msg.content };
      });

      await processWithAI(plan.text, effectiveSystemPrompt, previousMessages);
    };
  });

  /** The durable queue. Built once; disposed on unmount. */
  const speechQueueRef = useRef<SpeechBlockQueue<Blob> | null>(null);
  const getSpeechQueue = () => {
    if (!speechQueueRef.current) {
      speechQueueRef.current = new SpeechBlockQueue<Blob>({
        transcribe: async (block) => {
          const { selected, providers } = sttConfigRef.current;
          if (!selected.provider) {
            throw new Error("No speech provider selected.");
          }
          const providerConfig = providers.find(
            (p) => p.id === selected.provider
          );
          if (!providerConfig) {
            throw new Error("Speech provider config not found.");
          }
          return withSttTimeout(
            fetchSTT({
              provider: providerConfig,
              selectedProvider: selected,
              audio: block.audio,
            })
          );
        },
        onText: async (text) => {
          if (!text.trim()) {
            setError("Received empty transcription");
            return;
          }
          await applyTranscriptionRef.current(text);
        },
        onError: (error) => {
          console.error("STT Error:", error);
          setError((error as Error)?.message || "Failed to transcribe audio");
          setIsPopoverOpen(true);
        },
        onDeadLetter: (block, error) => {
          // The block is retained in the queue's dead letters, and R3 gives that
          // audio somewhere durable: transcription can fail, the speech cannot
          // be lost.
          void (async () => {
            try {
              const store = await getTranscriptStore();
              const audio = new Uint8Array(await block.audio.arrayBuffer());
              await store.addDeadLetter({
                source: "system",
                audio,
                attempts: block.attempts,
                error: (error as Error)?.message ?? String(error),
                conversationId: conversation.id || null,
              });
            } catch (persistError) {
              console.warn("Could not persist dead-letter audio:", persistError);
            }
          })();
          setError(
            `Audio could not be transcribed after ${block.attempts} attempts: ` +
              `${(error as Error)?.message ?? String(error)}`
          );
          setIsPopoverOpen(true);
        },
        onOverflow: () => {
          setError("Speech queue is full; this utterance was not transcribed.");
        },
        onIdle: () => {
          sttInFlightRef.current = false;
          stopRequestedRef.current = false;
          setIsProcessing(false);
        },
      });
    }
    return speechQueueRef.current;
  };

  useEffect(() => () => speechQueueRef.current?.dispose(), []);

  // Handle single speech detection event (both VAD and continuous modes)
  useEffect(() => {
    let speechUnlisten: (() => void) | undefined;
    let partialUnlisten: (() => void) | undefined;

    const setupEventListener = async () => {
      try {
        // Listen for incremental audio chunks and update the live transcript as we go.
        partialUnlisten = await listen(
          "speech-partial",
          async (event: { payload: string }) => {
            if (!capturing) return;
            const base64Audio = event.payload as string;
            try {
              const binaryString = atob(base64Audio);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              const audioBlob = new Blob([bytes], { type: "audio/wav" });

              if (!selectedSttProvider.provider) return;
              const providerConfig = allSttProviders.find(
                (p) => p.id === selectedSttProvider.provider
              );
              if (!providerConfig) return;

              const partial = await fetchSTT({
                provider: providerConfig,
                selectedProvider: selectedSttProvider,
                audio: audioBlob,
              });

              if (partial && partial.trim()) {
                setLivePartial(partial);
                livePartialRef.current = partial;
                upsertPartialSegment(partial);
              }
            } catch (err) {
              // Swallow partial errors so they don't interrupt the recording.
              console.warn("Partial STT failed:", err);
            }
          }
        );

        speechUnlisten = await listen("speech-detected", async (event) => {
          if (!capturing) {
            return;
          }

          let audioBlob: Blob;
          try {
            const base64Audio = event.payload as string;
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            audioBlob = new Blob([bytes], { type: "audio/wav" });
          } catch (err) {
            console.warn("Discarding malformed speech payload:", err);
            return;
          }

          // Durable (Phase 4 R2). The block goes to the queue, which transcribes
          // it, retries on failure with capped backoff, and dead-letters it with
          // the audio intact rather than dropping it. The provider lookup and the
          // 30 s ceiling moved into the queue's transcribe step, so a retry reads
          // the *current* provider instead of a stale closure. `sttInFlightRef`
          // keeps a Stop deferred until the block lands, however many attempts
          // that takes.
          sttInFlightRef.current = true;
          setIsProcessing(true);
          getSpeechQueue().enqueue("system", audioBlob);
        });
      } catch (err) {
        setError("Failed to setup speech listener");
      }
    };


    setupEventListener();

    return () => {
      if (speechUnlisten) speechUnlisten();
      if (partialUnlisten) partialUnlisten();
    };
  }, [
    capturing,
    selectedSttProvider,
    allSttProviders,
    conversation.messages?.length ?? 0,
  ]);

  // Phase 4 R3: bring back the transcript of the session the app was killed in.
  //
  // Events are written as they happen and only become a saved conversation at
  // the end, so an interrupted session leaves ORPHANS - and they are the last
  // thing the user saw. They are restored oldest-first on mount, and the same
  // call runs retention, so nothing accumulates.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const store = await getTranscriptStore();
        await store.pruneOrphans();
        const orphans = await store.listRecentOrphans();
        if (cancelled || orphans.length === 0) return;
        setTranscriptSegments((segments) => {
          // Never clobber a transcript that is already on screen.
          if (segments.length > 0) return segments;
          return orphans.map((event) => ({
            id: `restored-${event.id}`,
            timestamp: 0,
            speaker: event.source === "microphone" ? "User" : "Speaker",
            text: event.text,
            isPartial: false,
          }));
        });
      } catch (error) {
        console.warn("Could not restore the previous transcript:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Context management functions
  const saveContextSettings = useCallback(
    (usePrompt: boolean, content: string) => {
      try {
        const contextSettings = {
          useSystemPrompt: usePrompt,
          contextContent: content,
        };
        safeLocalStorage.setItem(
          STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT,
          JSON.stringify(contextSettings)
        );
      } catch (error) {
        console.error("Failed to save context settings:", error);
      }
    },
    []
  );

  const updateUseSystemPrompt = useCallback(
    (value: boolean) => {
      setUseSystemPrompt(value);
      saveContextSettings(value, contextContent);
    },
    [contextContent, saveContextSettings]
  );

  const updateContextContent = useCallback(
    (content: string) => {
      setContextContent(content);
      saveContextSettings(useSystemPrompt, content);
    },
    [useSystemPrompt, saveContextSettings]
  );

  // Quick actions management
  const saveQuickActions = useCallback((actions: string[]) => {
    try {
      safeLocalStorage.setItem(
        STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS,
        JSON.stringify(actions)
      );
    } catch (error) {
      console.error("Failed to save quick actions:", error);
    }
  }, []);

  const addQuickAction = useCallback(
    (action: string) => {
      if (action && !quickActions.includes(action)) {
        const newActions = [...quickActions, action];
        setQuickActions(newActions);
        saveQuickActions(newActions);
      }
    },
    [quickActions, saveQuickActions]
  );

  const removeQuickAction = useCallback(
    (action: string) => {
      const newActions = quickActions.filter((a) => a !== action);
      setQuickActions(newActions);
      saveQuickActions(newActions);
    },
    [quickActions, saveQuickActions]
  );

  const handleQuickActionClick = async (action: string) => {
    setError("");
    // Typed input joins the transcript labeled "User".
    pushUserSegment(action);

    const baseSystemPrompt = useSystemPrompt
      ? systemPrompt || DEFAULT_SYSTEM_PROMPT
      : contextContent || DEFAULT_SYSTEM_PROMPT;
    const effectiveSystemPrompt = composeListenPrompt(baseSystemPrompt, listenMode);

    // Include the most recent transcription in conversation history if it exists
    let updatedMessages = [...(conversation.messages ?? [])];

    if (lastTranscription && lastTranscription.trim()) {
      const lastMessage = updatedMessages[updatedMessages.length - 1];
      // Only add if it's not already the last message
      if (!lastMessage || lastMessage.content !== lastTranscription) {
        const timestamp = Date.now();
        const userMessage = {
          id: generateMessageId("user", timestamp),
          role: "user" as const,
          content: lastTranscription,
          timestamp,
        };
        updatedMessages.push(userMessage);

        // Update conversation state with the latest transcription
        setConversation((prev) => ({
          ...prev,
          messages: [userMessage, ...(prev.messages ?? [])],
          updatedAt: timestamp,
          title: prev.title || generateConversationTitle(lastTranscription),
        }));
      }
    }

    const previousMessages = updatedMessages.map((msg) => {
      return { role: msg.role, content: msg.content };
    });

    await processWithAI(action, effectiveSystemPrompt, previousMessages);
  };

  // Start continuous recording manually
  const startContinuousRecording = useCallback(async () => {
    try {
      setRecordingProgress(0);
      setError("");

      const deviceId =
        selectedAudioDevices.output?.id &&
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      // Start a new continuous recording session
      await invoke<string>("start_system_audio_capture", {
        vadConfig: currentSpawnVadConfig(),
        deviceId: deviceId,
      });
    } catch (err) {
      console.error("Failed to start continuous recording:", err);
      setError(`Failed to start recording: ${err}`);
    }
  }, [vadConfig, selectedAudioDevices.output?.id]);

  // Ignore current recording (stop without transcription). Gated on `capturing`
  // for the same reason as the Escape shortcut: the Rust-driven
  // `isRecordingInContinuousMode` can lag the actual capture state.
  const ignoreContinuousRecording = useCallback(async () => {
    if (!isContinuousMode || !capturing) return;

    try {
      // Stop the capture without processing
      await invoke<string>("stop_system_audio_capture");

      // Reset states
      setRecordingProgress(0);
      setIsProcessing(false);
      setIsRecordingInContinuousMode(false);
    } catch (err) {
      console.error("Failed to ignore recording:", err);
      setError(`Failed to ignore recording: ${err}`);
    }
  }, [isContinuousMode, capturing]);

  // After each answer, ask the provider for a few conversation-specific
  // follow-ups. Failures are silent — the four fixed chips always remain.
  const generateFollowUps = useCallback(
    async (userText: string, assistantText: string) => {
      if (!selectedAIProvider.provider) return;
      const provider = allAiProviders.find(
        (p) => p.id === selectedAIProvider.provider
      );
      if (!provider) return;

      try {
        let out = "";
        for await (const chunk of fetchAIResponse({
          provider,
          selectedProvider: selectedAIProvider,
          systemPrompt:
            "You suggest short follow-up prompts for an ongoing conversation. Reply with one suggestion per line, no numbering, no bullets, at most 8 words each.",
          history: [],
          userMessage: `Conversation excerpt:\nThem: ${userText}\nYou: ${assistantText}\n\nSuggest 3 follow-ups the user might ask next.`,
        })) {
          out += chunk;
        }
        const suggestions = out
          .split("\n")
          .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
          .filter((line) => line.length > 0 && line.length <= 60)
          .slice(0, 3);
        setSuggestedFollowUps(suggestions);
      } catch (err) {
        console.warn("Follow-up suggestions failed:", err);
      }
    },
    [selectedAIProvider, allAiProviders]
  );

  // AI Processing function
  const processWithAI = useCallback(
    async (
      transcription: string,
      prompt: string,
      previousMessages: Message[]
    ) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();

      try {
        setIsAIProcessing(true);
        setLastAIResponse("");
        setError("");

        let fullResponse = "";

        if (!selectedAIProvider.provider) {
          setError("No AI provider selected.");
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider) {
          setError("AI provider config not found.");
          return;
        }

        // Capture the current pending screenshot (if any) and clear it so it is only
        // attached to the next call.
        const screenshotForThisCall = pendingScreenshotRef.current;
        pendingScreenshotRef.current = null;
        setPendingScreenshot(null);

        // Library knowledge rides on top of the system prompt for this call only.
        const knowledge = knowledgeFileRef.current;
        const promptWithKnowledge = knowledge
          ? `${prompt}\n\nKnowledge from "${knowledge.name}":\n${knowledge.text}`
          : prompt;

        try {
          for await (const chunk of fetchAIResponse({
            provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: promptWithKnowledge,
            history: previousMessages,
            userMessage: transcription,
            imagesBase64: screenshotForThisCall ? [screenshotForThisCall] : [],
          })) {
            fullResponse += chunk;
            setLastAIResponse((prev) => prev + chunk);
          }
        } catch (aiError: any) {
          setError(aiError.message || "Failed to get AI response");
        }

        if (fullResponse) {
          const timestamp = Date.now();
          setConversation((prev) => ({
            ...prev,
            messages: [
              {
                id: generateMessageId("user", timestamp),
                role: "user" as const,
                content: transcription,
                timestamp,
              },
              {
                id: generateMessageId("assistant", timestamp + 1),
                role: "assistant" as const,
                content: fullResponse,
                timestamp: timestamp + 1,
              },
              ...prev.messages,
            ],
            updatedAt: timestamp,
            title: prev.title || generateConversationTitle(transcription),
          }));
          void generateFollowUps(transcription, fullResponse);
          // Phase 4 R3: the answer is an event too - the conversation list is a
          // projection of the event log, and this is what makes a reloaded
          // session show its answers even before the conversation is saved.
          void (async () => {
            try {
              const store = await getTranscriptStore();
              await store.addEvent({
                source: "system",
                kind: "ai_response",
                text: fullResponse,
                conversationId: conversation.id || null,
              });
            } catch (persistError) {
              console.warn("Could not persist AI response event:", persistError);
            }
          })();
        }
      } catch (err) {
        setError("Failed to get AI response");
      } finally {
        setIsAIProcessing(false);
        // No auto-restart - user manually controls when to start next recording
      }
    },
    [
      selectedAIProvider,
      allAiProviders,
      conversation.messages,
      conversation.id,
      generateFollowUps,
    ]
  );

  // Stop the capture engine without tearing the session down, then send what
  // was collected. Used by the spacebar / Stop button in Manual and
  // "Auto · On questions", and by the deferred in-flight stop. It never closes
  // the popover and never clears the conversation — that full teardown is
  // `stopCapture`, which belongs to Auto's Stop button.
  const stopAndSend = useCallback(
    async (text: string) => {
      try {
        await invoke<string>("stop_system_audio_capture");
      } catch (err) {
        console.error("Failed to stop capture:", err);
      }

      setCapturing(false);
      setIsProcessing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setRecordingProgress(0);
      setLivePartial("");
      livePartialRef.current = "";

      const outbound = text.trim();
      if (!outbound) return;

      const baseSystemPrompt = useSystemPrompt
        ? systemPrompt || DEFAULT_SYSTEM_PROMPT
        : contextContent || DEFAULT_SYSTEM_PROMPT;
      const effectiveSystemPrompt = composeListenPrompt(
        baseSystemPrompt,
        listenModeRef.current
      );

      const previousMessages = (conversation.messages ?? []).map((msg) => {
        return { role: msg.role, content: msg.content };
      });

      await processWithAI(outbound, effectiveSystemPrompt, previousMessages);
    },
    [systemPrompt, contextContent, conversation.messages, processWithAI]
  );

  // A finalized microphone utterance. It is shown in the transcript under the
  // "User" label and then sent to the AI through exactly the same policy the
  // system-audio path uses, so all three capture behaviours behave identically
  // whichever source the words came from.
  //
  // This used to be `pushUserSegment` on its own, which only appended the label
  // to the transcript. The mic audio was captured, transcribed and displayed,
  // but never reached the model — and because the transcript is React state that
  // is not persisted, the words vanished when capture stopped.
  //
  // Declared after `processWithAI` and `stopAndSend` on purpose: the dependency
  // array below is evaluated during render, so referencing them any earlier would
  // hit the temporal dead zone.
  const submitUserUtterance = useCallback(
    async (text: string) => {
      const transcript = text.trim();
      if (!transcript) return;

      pushUserSegment(transcript);

      const plan = planUtterance(
        captureBehaviorRef.current,
        transcript,
        pendingTranscriptRef.current,
        stopRequestedRef.current
      );
      stopRequestedRef.current = false;
      pendingTranscriptRef.current = plan.pending;

      if (plan.kind === "hold") return;

      if (plan.kind === "stop-and-send") {
        await stopAndSend(plan.text);
        return;
      }

      // The speaker tag is part of the message the model receives, so it can tell
      // the user's own words apart from the room. It is deliberately not part of
      // the transcript row, which already renders its own "User" label.
      const baseSystemPrompt = useSystemPrompt
        ? systemPrompt || DEFAULT_SYSTEM_PROMPT
        : contextContent || DEFAULT_SYSTEM_PROMPT;
      const effectiveSystemPrompt = composeListenPrompt(
        baseSystemPrompt,
        listenModeRef.current
      );

      const previousMessages = (conversation.messages ?? []).map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      await processWithAI(
        `User (microphone): ${plan.text}`,
        effectiveSystemPrompt,
        previousMessages
      );
    },
    [
      contextContent,
      conversation.messages,
      processWithAI,
      stopAndSend,
      systemPrompt,
      useSystemPrompt,
    ]
  );

  const startCapture = useCallback(async () => {
    try {
      setError("");

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setSetupRequired(true);
        setIsPopoverOpen(true);
        return;
      }

      // Set up conversation
      const conversationId = generateConversationId("sysaudio");
      setConversation({
        id: conversationId,
        title: "",
        messages: [],
        createdAt: 0,
        updatedAt: 0,
      });

      setCapturing(true);
      setIsPopoverOpen(true);
      setIsContinuousMode(false);
      setRecordingProgress(0);
      setLivePartial("");
      livePartialRef.current = "";
      setTranscriptSegments([]);
      pendingTranscriptRef.current = "";
      stopRequestedRef.current = false;
      sessionStartRef.current = Date.now();

      // Manual and Auto both start capturing audio immediately. Manual used
      // to arm first and wait for a separate Space/button press, which read
      // as dead (button clicked, nothing happens) and made `capturing` claim
      // audio was flowing while nothing was being captured.
      setIsRecordingInContinuousMode(false);

      // Stop any existing capture
      await invoke<string>("stop_system_audio_capture");

      const deviceId =
        selectedAudioDevices.output?.id &&
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      // Start capture with the VAD config. `enabled` is forced on: the loop
      // type is fixed when the Rust task spawns, and every session runs the
      // VAD loop so the listening-bar behavior can change mid-session without
      // restarting capture.
      await invoke<string>("start_system_audio_capture", {
        vadConfig: currentSpawnVadConfig(),
        deviceId: deviceId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setIsPopoverOpen(true);
    }
  }, [vadConfig, selectedAudioDevices.output?.id]);

  // Start the VAD engine inside a session that is already on screen: no
  // conversation reset, no transcript wipe, no stop-then-start. Called only
  // from explicit gestures: the Start button, the spacebar in Manual /
  // "Auto · On questions", and the global hotkey.
  const startSessionCapture = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    try {
      setError("");

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setSetupRequired(true);
        setIsPopoverOpen(true);
        return;
      }

      setCapturing(true);
      setIsPopoverOpen(true);
      setIsContinuousMode(false);
      setRecordingProgress(0);
      setLivePartial("");
      livePartialRef.current = "";
      setIsRecordingInContinuousMode(false);
      sessionStartRef.current = Date.now();

      const deviceId =
        selectedAudioDevices.output?.id &&
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      await invoke<string>("start_system_audio_capture", {
        vadConfig: currentSpawnVadConfig(),
        deviceId: deviceId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setIsPopoverOpen(true);
    } finally {
      startingRef.current = false;
    }
  }, [vadConfig, selectedAudioDevices.output?.id]);

  const stopCapture = useCallback(async () => {
    try {
      // Abort any ongoing AI requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      // Stop the audio capture
      await invoke<string>("stop_system_audio_capture");

      // Reset ALL states
      setCapturing(false);
      setIsProcessing(false);
      setIsAIProcessing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setRecordingProgress(0);
      setLastTranscription("");
      setLastAIResponse("");
      setError("");
      setIsPopoverOpen(false);
      setLivePartial("");
      livePartialRef.current = "";
      pendingTranscriptRef.current = "";
      stopRequestedRef.current = false;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to stop capture: ${errorMessage}`);
      console.error("Stop capture error:", err);
    }
  }, []);

  // Spacebar / Stop in Manual and "Auto · On questions": stop the engine and
  // send what was collected — held utterances plus the live partial, unless
  // that partial is already the tail of the held text. When a transcript is
  // mid-flight the stop is remembered and applied once it lands, so a fast
  // press still sends the utterance instead of dropping it; a second press
  // during that window is ignored.
  const manualStopAndSend = useCallback(async () => {
    if (!capturingRef.current) return;

    if (sttInFlightRef.current) {
      stopRequestedRef.current = true;
      return;
    }

    const held = pendingTranscriptRef.current;
    const partial = livePartialRef.current.trim();
    pendingTranscriptRef.current = "";

    const combined =
      partial && !held.endsWith(partial)
        ? held
          ? `${held} ${partial}`
          : partial
        : held;

    await stopAndSend(combined);
  }, [stopAndSend]);

  const handleSetup = useCallback(async () => {
    try {
      const platform = (navigator.platform || navigator.userAgent || "").toLowerCase();

      if (platform.includes("mac") || platform.includes("win")) {
        await invoke("request_system_audio_access");
      }

      // Delay to give the user time to grant permissions in the system dialog.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (hasAccess) {
        setSetupRequired(false);
        await startCapture();
      } else {
        setSetupRequired(true);
        setError("Permission not granted. Please try the manual steps.");
      }
    } catch (err) {
      setError("Failed to request access. Please try the manual steps below.");
      setSetupRequired(true);
    }
  }, [startCapture]);

  // The panel is always expanded, so "popover open" is only a UI hint now —
  // it drives the answer/error sections, never the window geometry. The
  // auto-resize that used to live here is gone: the footer's size presets are
  // the single authority over window size.
  useEffect(() => {
    setIsPopoverOpen(
      capturing || setupRequired || isAIProcessing || !!lastAIResponse || !!error
    );
  }, [capturing, setupRequired, isAIProcessing, lastAIResponse, error]);

  // The global hotkey is the same Start/Stop toggle as the button and the
  // spacebar — the non-wiping start and the stop-and-send — so the hotkey no
  // longer throws away the conversation on screen. The full reset stays behind
  // the separately labelled "New" button. Reading `capturingRef` instead of
  // the closed-over `capturing` is what keeps a start from being unreachable
  // without `capturing` in the dependency list.
  useEffect(() => {
    globalShortcuts.registerSystemAudioCallback(async () => {
      if (capturingRef.current) {
        await manualStopAndSend();
      } else {
        await startSessionCapture();
      }
    });
  }, [manualStopAndSend, startSessionCapture]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      invoke("stop_system_audio_capture").catch(() => {});
    };
  }, []);

  // Debounced save to prevent race conditions and improve performance
  useEffect(() => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Only debounce if there are messages to save
    if (
      !conversation.id ||
      conversation.updatedAt === 0 ||
      (conversation.messages?.length ?? 0) === 0
    ) {
      return;
    }

    // Debounce saves (only save 500ms after last change)
    saveTimeoutRef.current = setTimeout(async () => {
      // Don't save if already saving (prevent concurrent saves)
      if (isSavingRef.current) {
        return;
      }

      try {
        isSavingRef.current = true;
        await saveConversation(conversation);
      } catch (error) {
        console.error("Failed to save system audio conversation:", error);
      } finally {
        isSavingRef.current = false;
      }
    }, CONVERSATION_SAVE_DEBOUNCE_MS);

    // Cleanup on unmount or dependency change
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [
    conversation.messages?.length ?? 0,
    conversation.title,
    conversation.id,
    conversation.updatedAt,
  ]);

  const startNewConversation = useCallback(() => {
    setConversation({
      id: generateConversationId("sysaudio"),
      title: "",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });
    setLastTranscription("");
    setLastAIResponse("");
    setError("");
    setSetupRequired(false);
    setIsProcessing(false);
    setIsAIProcessing(false);
    setIsPopoverOpen(false);
    setUseSystemPrompt(true);
    setLivePartial("");    setSuggestedFollowUps([]);
  }, []);

  // Load an existing conversation from history into the listen panel. Used by the
  // conversation sidebar so the user can pick up a previous session.
  const loadConversation = useCallback(async (conversationId: string) => {
    try {
      const parsed = await getConversationById(conversationId);
      if (!parsed || !parsed.id) return;

      const messages = parsed.messages ?? [];
      setConversation({ ...parsed, messages });
      // Restore the last visible user message and assistant response so the panel
      // immediately shows context without requiring a new recording.
      const lastUser = messages.find((m) => m.role === "user");
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      setLastTranscription(lastUser?.content ?? "");
      setLastAIResponse(lastAssistant?.content ?? "");
      setLivePartial("");      setError("");
    } catch (err) {
      console.error("Failed to load conversation:", err);
    }
  }, []);

  const setListenModeValue = useCallback((mode: ListenMode) => {
    setListenMode(mode);
    listenModeRef.current = mode;
    safeLocalStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_LISTEN_MODE,
      JSON.stringify(mode)
    );
  }, []);

  // Update VAD configuration
  const updateVadConfiguration = useCallback(async (config: VadConfig) => {
    try {
      setVadConfig(config);
      // Writes localStorage and the Rust engine together — see the module for
      // why both are needed.
      await persistVadConfig(config);
    } catch (error) {
      console.error("Failed to update VAD config:", error);
    }
  }, []);

  // The listening bar's three-way mode. The capture engine is deliberately
  // never touched here: a session that is already capturing keeps capturing,
  // uninterrupted, and the mode only changes how its utterances reach the AI.
  // Whether Auto should be listening is decided in one place — the autostart
  // effect below — so an idle switch into Auto is not a special case.
  const setCaptureBehavior = useCallback(
    (behavior: CaptureBehavior) => {
      setCaptureBehaviorState(behavior);
      captureBehaviorRef.current = behavior;
      safeLocalStorage.setItem(
        STORAGE_KEYS.SYSTEM_AUDIO_CAPTURE_BEHAVIOR,
        JSON.stringify(behavior)
      );
    },
    []
  );

  // Capture never starts on its own (Phase 4 R7, owner decision 2026-09-30,
  // issue #12). This used to be an Auto-mode autostart effect; the owner chose
  // the explicit model, so Listen runs only from the Start button, the
  // spacebar (Manual / "Auto · On questions"), the global hotkey, or
  // push-to-talk. `scripts/mic-consent-check.ts` fails if an autostart effect
  // returns here.

  // Keyboard arrow key support for scrolling (local shortcut)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      const scrollElement = scrollAreaRef.current?.querySelector(
        "[data-radix-scroll-area-viewport]"
      ) as HTMLElement;

      if (!scrollElement) return;

      const scrollAmount = 100; // pixels to scroll

      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollElement.scrollBy({ top: scrollAmount, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollElement.scrollBy({ top: -scrollAmount, behavior: "smooth" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen]);

  // Spacebar owns capture start/stop in Manual and "Auto · On questions".
  //
  // Registered in the capture phase on purpose: a focused button — the mode
  // trigger in the listening bar, the history button, the quick-action chips,
  // the size and hide controls — activates on Space natively, and no bubble
  // phase React handler can pre-empt that. Swallowing the key here stops it
  // doubling as a click without taking any of those controls out of the tab
  // order. Typing is untouched: text fields return before the event is
  // modified, so the Ask composer and every other input keep Space. Enter and
  // Escape are not bound.
  useEffect(() => {
    panelActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    const TEXT_FIELD_TAGS = ["INPUT", "TEXTAREA", "SELECT"];

    const isTextTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      if (TEXT_FIELD_TAGS.includes(target.tagName)) return true;
      const role = target.getAttribute("role");
      return (
        target.isContentEditable ||
        role === "textbox" ||
        role === "searchbox"
      );
    };

    const handleCaptureSpace = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextTarget(e.target)) return;

      // Space is scoped to the Listen panel. The Ask panel binds the same key
      // for push-to-talk, so returning before preventDefault leaves it for that
      // handler instead of starting a system-audio capture from the Ask tab.
      if (!panelActiveRef.current) return;

      // Swallow the key for whatever has focus, then act.
      e.preventDefault();
      e.stopPropagation();

      if (e.repeat) return;

      const behavior = captureBehaviorRef.current;
      if (behavior !== "manual" && behavior !== "questions") return;

      if (capturingRef.current) {
        void manualStopAndSend();
      } else {
        void startSessionCapture();
      }
    };

    window.addEventListener("keydown", handleCaptureSpace, true);
    return () =>
      window.removeEventListener("keydown", handleCaptureSpace, true);
  }, [manualStopAndSend, startSessionCapture]);

  return {
    capturing,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    lastAIResponse,
    error,
    setupRequired,
    startCapture,
    stopCapture,
    // Non-wiping start used by the spacebar and the Start button
    startSessionCapture,
    handleSetup,
    isPopoverOpen,
    setIsPopoverOpen,
    // Conversation management
    conversation,
    setConversation,
    // AI processing
    processWithAI,
    // Context management
    useSystemPrompt,
    setUseSystemPrompt: updateUseSystemPrompt,
    contextContent,
    setContextContent: updateContextContent,
    startNewConversation,
    loadConversation,
    quickActions,
    addQuickAction,
    removeQuickAction,
    isManagingQuickActions,
    setIsManagingQuickActions,
    handleQuickActionClick,
    // VAD configuration
    vadConfig,
    updateVadConfiguration,
    // Continuous recording
    isContinuousMode,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    // Screenshot captured in the listen panel — sent with the next AI call
    pendingScreenshot,
    setPendingScreenshot,
    // Live running transcript shown while audio is still being captured
    livePartial,
    transcriptSegments,
    listenMode,
    setListenMode: setListenModeValue,
    // Listening-bar behavior (Auto / Manual / Auto · On questions)
    captureBehavior,
    setCaptureBehavior,
    // AI-generated follow-ups for the latest answer
    suggestedFollowUps,
    // Library knowledge (folder → file → prompt context)
    knowledgeFolderName,
    knowledgeFolderFiles,
    knowledgeFile,
    isKnowledgeReading,
    knowledgeReadError,
    pickKnowledgeFolder,
    selectKnowledgeFile,
    clearKnowledgeFile,
    // Typed input and the browser-side mic both join the transcript as "User".
    // `pushUserSegment` only labels the row; `submitUserUtterance` is the one to
    // wire to a mic's `onUtterance`, because it also routes the words to the AI.
    pushUserSegment,
    submitUserUtterance,
    // Live in-progress text from the browser-side "User" mic.
    // ListenUserMic writes these; the transcript thread only reads the partial.
    userMicPartial,
    setUserMicPartial,
    // Listen's "Mic + system audio" toggle — see the state declaration.
    micWithSystem,
    setMicWithSystem,
    setError,
    // Scroll area ref for keyboard navigation
    scrollAreaRef,
  };
}
