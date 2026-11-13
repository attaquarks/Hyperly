import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, Button, Header, TextInput } from "@/components";
import { useApp } from "@/contexts";
import { addCustomAiProvider } from "@/lib/storage/ai-providers";
import { addCustomSttProvider } from "@/lib/storage/stt-providers";
import { buildByokProvider, normalizeByokBase, ByokForm } from "@/lib/byok";

/**
 * The simple BYOK form: base URL + API key + model. No curl, no JSON, no
 * response paths — the provider record is generated from this form and the
 * existing request machinery handles it. Fetch Models discovers the
 * endpoint's model list; Test Connection reports any problem IN the panel,
 * in plain language, before the user ever starts the overlay.
 */

interface ByokTestResult {
  ok: boolean;
  models: string[];
  message: string;
}

const PLACEHOLDERS: Record<"ai" | "stt", { url: string; model: string }> = {
  ai: {
    url: "https://api.openai.com/v1 or http://localhost:1234",
    model: "gpt-4o-mini",
  },
  stt: {
    url: "https://api.deepgram.com or http://localhost:9000",
    model: "nova-3",
  },
};

const ByokFormFields = ({ kind }: { kind: "ai" | "stt" }) => {
  const { loadData } = useApp();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [streaming, setStreaming] = useState(kind === "ai");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ByokTestResult | null>(null);
  const [saveError, setSaveError] = useState("");
  const [detectingStreaming, setDetectingStreaming] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState("");
  const [streamingDetected, setStreamingDetected] = useState(false);

  const detectStreaming = async () => {
    setDetectingStreaming(true);
    setStreamingMessage("");
    try {
      const outcome = await invoke<{ supported: boolean; message: string }>(
        "byok_test_streaming",
        {
          baseUrl: normalizeByokBase(baseUrl),
          apiKey,
          model: model.trim(),
        }
      );
      setStreamingDetected(outcome.supported);
      setStreaming(outcome.supported);
      setStreamingMessage(outcome.message);
    } catch (error) {
      setStreamingDetected(false);
      setStreaming(false);
      setStreamingMessage(
        `Streaming detection failed to run: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setDetectingStreaming(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setResult(null);
    try {
      const outcome = await invoke<ByokTestResult>("byok_test_connection", {
        baseUrl: normalizeByokBase(baseUrl),
        apiKey,
        kind,
        model: model.trim(),
      });
      setResult(outcome);
    } catch (error) {
      setResult({
        ok: false,
        models: [],
        message: `Connection test failed to run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    setSaveError("");
    if (!name.trim() || !baseUrl.trim() || !model.trim()) {
      setSaveError("Name, base URL and model are all required.");
      return;
    }
    const form: ByokForm = {
      name: name.trim(),
      baseUrl: normalizeByokBase(baseUrl),
      apiKey: apiKey.trim(),
      model: model.trim(),
      streaming,
    };
    const record = buildByokProvider(form, kind);
    const saved =
      kind === "stt"
        ? addCustomSttProvider(record)
        : addCustomAiProvider(record);
    if (!saved) {
      setSaveError("Could not save the provider — try again.");
      return;
    }
    loadData();
    setName("");
    setBaseUrl("");
    setApiKey("");
    setModel("");
    setResult(null);
  };

  const label =
    kind === "stt" ? "STT (speech-to-text)" : "AI (chat / answers)";

  return (
    <Card className="p-3 border !bg-transparent border-input/50 space-y-3">
      <Header
        title="Bring your own key"
        description={
          kind === "stt"
            ? `Connect any OpenAI-compatible STT endpoint — local servers (Ollama, freellmapi, LM Studio) or cloud. Test it here before using the overlay.`
            : `Connect any OpenAI-compatible AI endpoint — local servers (Ollama, freellmapi, LM Studio) or cloud. Test it here before using the overlay.`
        }
      />

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Name ({label})
          </label>
          <TextInput
            placeholder={kind === "stt" ? "My STT server" : "My AI server"}
            value={name}
            onChange={setName}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Base URL (OpenAI-compatible)
          </label>
          <TextInput
            placeholder={PLACEHOLDERS[kind].url}
            value={baseUrl}
            onChange={setBaseUrl}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            API key (leave empty for local servers without auth)
          </label>
          <TextInput
            placeholder="sk-…"
            value={apiKey}
            onChange={setApiKey}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Model (fetch, or type it)
          </label>
          <div className="flex gap-1">
            <TextInput
              placeholder={PLACEHOLDERS[kind].model}
              value={model}
              onChange={setModel}
            />
            <Button
              variant="outline"
              className="shrink-0 text-xs"
              disabled={testing || !baseUrl.trim()}
              onClick={testConnection}
            >
              {testing ? "Testing…" : "Fetch models"}
            </Button>
          </div>
        </div>
      </div>

      {result?.models && result.models.length > 0 && (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Discovered models — click one to use it
          </label>
          <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
            {result.models.slice(0, 24).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setModel(id)}
                className={`text-xs px-2 py-1 rounded border ${
                  model === id
                    ? "border-primary text-primary"
                    : "border-input/50 text-muted-foreground hover:text-foreground"
                }`}
              >
                {id}
              </button>
            ))}
          </div>
        </div>
      )}

      {kind === "ai" && (
        <div className="flex items-center gap-2">
          <input
            id="byok-streaming-toggle"
            type="checkbox"
            checked={streaming}
            onChange={(e) => setStreaming(e.target.checked)}
            className="accent-primary"
          />
          <label
            htmlFor="byok-streaming-toggle"
            className="text-xs text-muted-foreground"
          >
            Stream the answer as it is written (recommended; turn off if the
            server does not support it)
          </label>
        </div>
      )}
      {kind === "stt" && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="text-xs"
              disabled={detectingStreaming || !baseUrl.trim() || !model.trim()}
              onClick={detectStreaming}
            >
              {detectingStreaming ? "Checking…" : "Detect streaming support"}
            </Button>
            {streaming && (
              <span className="text-xs text-green-500">
                ● Streaming enabled — live words while someone talks
              </span>
            )}
          </div>
          {streamingMessage && (
            <p
              className={`text-xs ${
                streamingDetected ? "text-green-500" : "text-muted-foreground"
              }`}
            >
              {streamingMessage}
            </p>
          )}
          <p className="text-xs italic text-muted-foreground">
            Without streaming, this provider runs in one-shot mode: one upload
            per utterance, text after each one.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="outline" className="text-xs" disabled={testing || !baseUrl.trim()} onClick={testConnection}>
          Test connection
        </Button>
        <Button className="text-xs" onClick={save}>
          Save provider
        </Button>
      </div>

      {result && (
        <p
          className={`text-xs ${result.ok ? "text-green-500" : "text-red-500"}`}
        >
          {result.ok ? "✓ " : "✗ "}
          {result.message}
        </p>
      )}
      {saveError && <p className="text-xs text-red-500">{saveError}</p>}
    </Card>
  );
};

/**
 * The collapsed-by-default entry point: the page shows the provider
 * selection list first; this button (and the form behind it) appears below.
 */
export const ByokProviderCard = ({ kind }: { kind: "ai" | "stt" }) => {
  const [open, setOpen] = useState(false);
  const label = kind === "stt" ? "custom STT provider" : "custom AI provider";
  if (!open) {
    return (
      <Button className="text-xs w-full" onClick={() => setOpen(true)}>
        + Add {label}
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <ByokFormFields kind={kind} />
      <Button
        variant="outline"
        className="text-xs w-full"
        onClick={() => setOpen(false)}
      >
        Hide the {label} form
      </Button>
    </div>
  );
};
