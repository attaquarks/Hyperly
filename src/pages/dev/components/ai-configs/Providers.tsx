import { Button, Header, Input, Selection, TextInput } from "@/components";
import { UseSettingsReturn } from "@/types";
import curl2Json, { ResultJSON } from "@bany/curl-to-json";
import { KeyIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export const Providers = ({
  allAiProviders,
  selectedAIProvider,
  onSetSelectedAIProvider,
  variables,
  modelList,
  refreshModels,
}: UseSettingsReturn) => {
  const [localSelectedProvider, setLocalSelectedProvider] =
    useState<ResultJSON | null>(null);

  useEffect(() => {
    if (selectedAIProvider?.provider) {
      const provider = allAiProviders?.find(
        (p) => p?.id === selectedAIProvider?.provider
      );
      if (provider) {
        const json = curl2Json(provider?.curl);
        setLocalSelectedProvider(json as ResultJSON);
      }
    }
  }, [selectedAIProvider?.provider]);

  const findKeyAndValue = (key: string) => {
    return variables?.find((v) => v?.key === key);
  };

  const getApiKeyValue = () => {
    const apiKeyVar = findKeyAndValue("api_key");
    if (!apiKeyVar || !selectedAIProvider?.variables) return "";
    return selectedAIProvider?.variables?.[apiKeyVar.key] || "";
  };

  const isApiKeyEmpty = () => {
    return !getApiKeyValue().trim();
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Header
          title="Select AI Provider"
          description="Select your preferred AI service provider or custom providers to get started."
        />
        <Selection
          selected={selectedAIProvider?.provider}
          options={allAiProviders?.map((provider) => {
            const json = curl2Json(provider?.curl);
            return {
              label: provider?.isCustom
                ? json?.url || "Custom Provider"
                : provider?.id || "Custom Provider",
              value: provider?.id || "Custom Provider",
              isCustom: provider?.isCustom,
            };
          })}
          placeholder="Choose your AI provider"
          onChange={(value) => {
            onSetSelectedAIProvider({
              provider: value,
              variables: {},
            });
          }}
        />
      </div>

      {localSelectedProvider ? (
        <Header
          title={`Method: ${
            localSelectedProvider?.method || "Invalid"
          }, Endpoint: ${localSelectedProvider?.url || "Invalid"}`}
          description={`If you want to use different url or method, you can always create a custom provider.`}
        />
      ) : null}

      {findKeyAndValue("api_key") ? (
        <div className="space-y-2">
          <Header
            title="API Key"
            description={`Enter your ${
              allAiProviders?.find(
                (p) => p?.id === selectedAIProvider?.provider
              )?.isCustom
                ? "Custom Provider"
                : selectedAIProvider?.provider
            } API key to authenticate and access AI models. Your key is stored locally and never shared.`}
          />

          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="**********"
                value={getApiKeyValue()}
                onChange={(value) => {
                  const apiKeyVar = findKeyAndValue("api_key");
                  if (!apiKeyVar || !selectedAIProvider) return;

                  onSetSelectedAIProvider({
                    ...selectedAIProvider,
                    variables: {
                      ...selectedAIProvider.variables,
                      [apiKeyVar.key]:
                        typeof value === "string" ? value : value.target.value,
                    },
                  });
                }}
                onKeyDown={(e) => {
                  const apiKeyVar = findKeyAndValue("api_key");
                  if (!apiKeyVar || !selectedAIProvider) return;

                  onSetSelectedAIProvider({
                    ...selectedAIProvider,
                    variables: {
                      ...selectedAIProvider.variables,
                      [apiKeyVar.key]: (e.target as HTMLInputElement).value,
                    },
                  });
                }}
                disabled={false}
                className="flex-1 h-11 border-1 border-input/50 focus:border-primary/50 transition-colors"
              />
              {isApiKeyEmpty() ? (
                <Button
                  onClick={() => {
                    const apiKeyVar = findKeyAndValue("api_key");
                    if (!apiKeyVar || !selectedAIProvider || isApiKeyEmpty())
                      return;

                    onSetSelectedAIProvider({
                      ...selectedAIProvider,
                      variables: {
                        ...selectedAIProvider.variables,
                        [apiKeyVar.key]: getApiKeyValue(),
                      },
                    });
                  }}
                  disabled={isApiKeyEmpty()}
                  size="icon"
                  className="shrink-0 h-11 w-11"
                  title="Submit API Key"
                >
                  <KeyIcon className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    const apiKeyVar = findKeyAndValue("api_key");
                    if (!apiKeyVar || !selectedAIProvider) return;

                    onSetSelectedAIProvider({
                      ...selectedAIProvider,
                      variables: {
                        ...selectedAIProvider.variables,
                        [apiKeyVar.key]: "",
                      },
                    });
                  }}
                  size="icon"
                  variant="destructive"
                  className="shrink-0 h-11 w-11"
                  title="Remove API Key"
                >
                  <TrashIcon className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-4 mt-2">
        {variables
          .filter(
            (variable) => variable.key !== findKeyAndValue("api_key")?.key
          )
          .map((variable) => {
            const getVariableValue = () => {
              if (!variable?.key || !selectedAIProvider?.variables) return "";
              return selectedAIProvider.variables[variable.key] || "";
            };

            const setVariableValue = (value: string) => {
              if (!variable?.key || !selectedAIProvider) return;

              onSetSelectedAIProvider({
                ...selectedAIProvider,
                variables: {
                  ...selectedAIProvider.variables,
                  [variable.key]: value,
                },
              });
            };

            // The MODEL variable gets an auto-detected dropdown once the
            // provider's model list has been fetched; every other variable
            // (and the model when the list is unavailable) keeps the
            // free-text input.
            const isModelVariable = variable?.key === "model";
            const storedModel = isModelVariable ? getVariableValue() : "";
            const modelOptions = (
              storedModel && !modelList.models.includes(storedModel)
                ? [storedModel, ...modelList.models]
                : modelList.models
            ).map((id) => ({ label: id, value: id }));
            const showModelDropdown =
              modelList.status === "ok" || modelList.status === "loading";

            return (
              <div className="space-y-1" key={variable?.key}>
                <Header
                  title={variable?.value || ""}
                  description={`add your preferred ${variable?.key?.replace(
                    /_/g,
                    " "
                  )} for ${
                    allAiProviders?.find(
                      (p) => p?.id === selectedAIProvider?.provider
                    )?.isCustom
                      ? "Custom Provider"
                      : selectedAIProvider?.provider
                  }`}
                />
                {isModelVariable ? (
                  <div className="space-y-1">
                    <div className="flex gap-2">
                      <div className="flex-1">
                        {showModelDropdown ? (
                          <Selection
                            selected={storedModel}
                            options={modelOptions}
                            placeholder="Select a model"
                            isLoading={modelList.status === "loading"}
                            onChange={(value) => setVariableValue(value)}
                          />
                        ) : (
                          <TextInput
                            placeholder={`Enter ${
                              allAiProviders?.find(
                                (p) => p?.id === selectedAIProvider?.provider
                              )?.isCustom
                                ? "Custom Provider"
                                : selectedAIProvider?.provider
                            } model`}
                            value={storedModel}
                            onChange={(value) => setVariableValue(value)}
                          />
                        )}
                      </div>
                      {modelList.status !== "unsupported" ? (
                        <Button
                          variant="outline"
                          size="icon"
                          className="shrink-0 h-11 w-11 border-1 border-input/50"
                          title="Refresh model list"
                          disabled={modelList.status === "loading"}
                          onClick={refreshModels}
                        >
                          <RefreshCwIcon
                            className={cn(
                              "h-4 w-4",
                              modelList.status === "loading" && "animate-spin"
                            )}
                          />
                        </Button>
                      ) : null}
                    </div>
                    {modelList.status === "error" ? (
                      <p className="text-xs text-red-500">
                        Couldn't fetch the model list: {modelList.error} You can
                        still type the model name manually.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <TextInput
                    placeholder={`Enter ${
                      allAiProviders?.find(
                        (p) => p?.id === selectedAIProvider?.provider
                      )?.isCustom
                        ? "Custom Provider"
                        : selectedAIProvider?.provider
                    } ${variable?.key?.replace(/_/g, " ") || "value"}`}
                    value={getVariableValue()}
                    onChange={(value) => setVariableValue(value)}
                  />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
};
