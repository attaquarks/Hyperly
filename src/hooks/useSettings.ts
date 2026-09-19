import { useEffect, useRef, useState } from "react";
import { useApp } from "@/contexts";
import {
  extractVariables,
  safeLocalStorage,
  deleteAllConversations,
  fetchProviderModels,
} from "@/lib";
import { STORAGE_KEYS } from "@/config";
import { ModelListState, TYPE_PROVIDER } from "@/types";

export const useSettings = () => {
  const {
    screenshotConfiguration,
    setScreenshotConfiguration,
    allAiProviders,
    allSttProviders,
    selectedAIProvider,
    selectedSttProvider,
    onSetSelectedAIProvider,
    onSetSelectedSttProvider,
  } = useApp();
  const [variables, setVariables] = useState<{ key: string; value: string }[]>(
    []
  );
  const [sttVariables, setSttVariables] = useState<
    {
      key: string;
      value: string;
    }[]
  >([]);

  const [showDeleteConfirmDialog, setShowDeleteConfirmDialog] = useState(false);
  const [modelList, setModelList] = useState<ModelListState>({
    status: "idle",
    models: [],
  });

  const handleScreenshotModeChange = (value: "auto" | "manual") => {
    const newConfig = { ...screenshotConfiguration, mode: value };
    setScreenshotConfiguration(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  const handleScreenshotPromptChange = (value: string) => {
    const newConfig = { ...screenshotConfiguration, autoPrompt: value };
    setScreenshotConfiguration(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  const handleScreenshotEnabledChange = (enabled: boolean) => {
    // License gating removed: screenshot mode is always allowed to be toggled.
    const newConfig = { ...screenshotConfiguration, enabled };
    setScreenshotConfiguration(newConfig);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG,
      JSON.stringify(newConfig)
    );
  };

  useEffect(() => {
    if (selectedAIProvider.provider) {
      const provider = allAiProviders.find(
        (p) => p.id === selectedAIProvider.provider
      );
      if (provider) {
        const variables = extractVariables(provider?.curl);
        setVariables(variables);
      }
    }
  }, [selectedAIProvider.provider]);

  useEffect(() => {
    if (selectedSttProvider.provider) {
      const provider = allSttProviders.find(
        (p) => p.id === selectedSttProvider.provider
      );
      if (provider) {
        const variables = extractVariables(provider?.curl);
        setSttVariables(variables);
      }
    }
  }, [selectedSttProvider.provider]);

  // Guards against a slow response for a previously selected provider
  // overwriting the list of the current one.
  const modelRequestRef = useRef(0);

  const loadModels = (
    provider: TYPE_PROVIDER,
    variables: Record<string, string>,
    keepModels = false
  ) => {
    const requestId = ++modelRequestRef.current;
    setModelList((prev) => ({
      status: "loading",
      models: keepModels ? prev.models : [],
    }));
    fetchProviderModels(provider, variables).then((result) => {
      if (requestId !== modelRequestRef.current) return;
      if (result.status === "ok") {
        setModelList({ status: "ok", models: result.models });
      } else if (result.status === "unsupported") {
        setModelList({ status: "unsupported", models: [] });
      } else {
        setModelList({ status: "error", models: [], error: result.message });
      }
    });
  };

  // Model auto-detect: fetch the provider's model list when the selection
  // changes — but only unprompted when the request can't fail for missing
  // credentials, i.e. an API key is already stored or the endpoint is local
  // and keyless. Otherwise the user triggers the fetch with the refresh
  // button once they've entered the key (the key input commits per
  // keystroke, so watching it would fire a request per character).
  useEffect(() => {
    const provider = allAiProviders.find(
      (p) => p.id === selectedAIProvider.provider
    );
    if (!provider) {
      modelRequestRef.current++;
      setModelList({ status: "idle", models: [] });
      return;
    }
    const needsKey = provider.curl.includes("{{API_KEY}}");
    const hasKey = !!selectedAIProvider.variables?.api_key?.trim();
    const isLocal = /localhost|127\.0\.0\.1/.test(provider.curl);
    if (needsKey && !hasKey && !isLocal) {
      modelRequestRef.current++;
      setModelList({ status: "idle", models: [] });
      return;
    }
    loadModels(provider, selectedAIProvider.variables);
  }, [selectedAIProvider.provider]);

  const refreshModels = () => {
    const provider = allAiProviders.find(
      (p) => p.id === selectedAIProvider.provider
    );
    if (!provider) return;
    loadModels(provider, selectedAIProvider.variables, true);
  };

  const handleDeleteAllChatsConfirm = async () => {
    try {
      await deleteAllConversations();
      setShowDeleteConfirmDialog(false);
    } catch (error) {
      console.error("Failed to delete all conversations:", error);
    }
  };

  return {
    screenshotConfiguration,
    setScreenshotConfiguration,
    handleScreenshotModeChange,
    handleScreenshotPromptChange,
    handleScreenshotEnabledChange,
    allAiProviders,
    allSttProviders,
    selectedAIProvider,
    selectedSttProvider,
    onSetSelectedAIProvider,
    onSetSelectedSttProvider,
    handleDeleteAllChatsConfirm,
    showDeleteConfirmDialog,
    setShowDeleteConfirmDialog,
    variables,
    sttVariables,
    modelList,
    refreshModels,
  };
};
