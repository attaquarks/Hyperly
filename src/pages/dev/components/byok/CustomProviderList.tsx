import { invoke } from "@tauri-apps/api/core";
import curl2Json from "@bany/curl-to-json";
import { Trash2Icon } from "lucide-react";
import { Header } from "@/components";
import { useApp } from "@/contexts";
import {
  getCustomAiProviders,
  removeCustomAiProvider,
} from "@/lib/storage/ai-providers";
import {
  getCustomSttProviders,
  removeCustomSttProvider,
} from "@/lib/storage/stt-providers";

/**
 * The user's saved custom (BYOK) providers, each with a red trash icon —
 * deleting removes the provider from the selection list. The display name is
 * the user's own (BYOK records carry `name`); the URL-derived label is the
 * fallback for older curl-template customs. Deleting the CURRENTLY selected
 * provider resets the selection so no request targets a dead id.
 */
export const CustomProviderList = ({ kind }: { kind: "ai" | "stt" }) => {
  const {
    loadData,
    selectedAIProvider,
    selectedSttProvider,
    onSetSelectedAIProvider,
    onSetSelectedSttProvider,
  } = useApp();
  const providers =
    kind === "stt" ? getCustomSttProviders() : getCustomAiProviders();

  if (providers.length === 0) return null;

  const selectedId =
    kind === "stt"
      ? selectedSttProvider?.provider
      : selectedAIProvider?.provider;

  const remove = async (id: string) => {
    try {
      // If a live streaming session runs on this provider, stop it before the
      // provider disappears from under it.
      await invoke("configure_stt_streaming", { config: null });
    } catch {
      // Session teardown is best-effort.
    }
    const ok =
      kind === "stt"
        ? removeCustomSttProvider(id)
        : removeCustomAiProvider(id);
    if (!ok) return;
    if (selectedId === id) {
      // Reset the selection so nothing references a deleted provider.
      if (kind === "stt") {
        onSetSelectedSttProvider({ provider: "", variables: {} });
      } else {
        onSetSelectedAIProvider({ provider: "", variables: {} });
      }
    }
    loadData();
  };

  return (
    <div className="space-y-1">
      <Header
        title="Your custom providers"
        description="Saved on this machine. The trash icon removes a provider from the list."
      />
      {providers.map((provider) => {
        const derived = (() => {
          try {
            return curl2Json(provider.curl)?.url || provider.id;
          } catch {
            return provider.id;
          }
        })();
        return (
          <div
            key={provider.id}
            className="flex items-center justify-between rounded border border-input/50 px-2 py-1.5"
          >
            <span className="text-xs">
              {provider.name || derived}
              <span className="text-muted-foreground">
                {" "}
                • {kind === "stt" ? "STT" : "AI"}
                {provider.streaming ? " • streaming" : ""}
              </span>
            </span>
            <button
              type="button"
              aria-label={`Delete ${provider.name || derived}`}
              onClick={() => void remove(provider.id as string)}
              className="text-red-500 hover:text-red-400"
            >
              <Trash2Icon className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
