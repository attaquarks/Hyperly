import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApp } from "@/contexts";
import {
  isStreamingCapableStt,
  resolveSttStreamConfig,
} from "@/lib/byok";
import { TYPE_PROVIDER } from "@/types";

/**
 * The streaming line under the STT selection: for providers whose endpoints
 * speak a streaming protocol Hyperly implements (e.g. the built-in Deepgram),
 * a REAL WebSocket handshake runs against the configured key, and the user
 * sees the outcome — streaming configured automatically, nothing to set up.
 */
export const SttStreamingStatus = () => {
  const { allSttProviders, selectedSttProvider } = useApp();
  const [status, setStatus] = useState<string>("");

  const provider: TYPE_PROVIDER | undefined = allSttProviders?.find(
    (p) => p?.id === selectedSttProvider?.provider
  );
  const variables = selectedSttProvider?.variables;
  const apiKey = variables?.api_key || variables?.API_KEY || "";
  const providerId = provider?.id ?? "";
  const capable = isStreamingCapableStt(provider);

  useEffect(() => {
    if (!capable) {
      setStatus("");
      return;
    }
    const config = resolveSttStreamConfig(provider, variables);
    if (!config) {
      setStatus("");
      return;
    }
    let cancelled = false;
    setStatus("checking");
    void invoke<{ supported: boolean; message: string }>(
      "byok_test_streaming",
      {
        baseUrl: config.base_url,
        apiKey: config.api_key,
        model: config.model,
      }
    )
      .then((outcome) => {
        if (cancelled) return;
        setStatus(outcome.supported ? "supported" : "unsupported");
      })
      .catch(() => {
        if (!cancelled) setStatus("");
      });
    return () => {
      cancelled = true;
    };
  }, [capable, providerId, apiKey, provider?.curl]);

  if (!capable) return null;

  if (status === "supported") {
    return (
      <p className="text-xs text-green-500">
        ● Streaming supported — your transcription and return call will be
        much faster for this provider.
      </p>
    );
  }
  if (status === "unsupported") {
    return (
      <p className="text-xs text-muted-foreground">
        Streaming could not be confirmed for this provider — it runs in
        one-shot mode (one upload per utterance).
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">Checking streaming…</p>
  );
};
