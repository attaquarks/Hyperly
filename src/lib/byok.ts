import type { TYPE_PROVIDER } from "@/types";

/**
 * Bring-your-own-key (BYOK) provider generation.
 *
 * The dashboard's simple form — base URL + API key + model — must never show
 * the curl-template machinery. This module converts that form into a real
 * `TYPE_PROVIDER` record whose curl template is generated HERE, so the whole
 * existing request machinery (`fetchAIResponse` / `fetchSTT` via curl2Json)
 * keeps working unchanged and the user never sees or edits a template.
 *
 * The key and model are baked into the template literally: the record already
 * lives in the user's own localStorage (exactly like a pasted custom curl
 * today), and this keeps the selection flow free of any "required variables"
 * step — the only placeholders left are the request-content ones
 * ({{SYSTEM_PROMPT}}/{{TEXT}}/{{AUDIO}}), which are never surfaced to the
 * user.
 */

export interface ByokForm {
  /** Display name, e.g. "Ollama (local)" or "freellmapi". */
  name: string;
  /** OpenAI-compatible base, e.g. http://localhost:1234 or https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** Model id as served by the endpoint (discovered or typed). */
  model: string;
  /** AI only: stream the response token by token. */
  streaming: boolean;
}

/** Trim trailing slashes and a lone /v1 duplication guard for URL building. */
export const normalizeByokBase = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, "");

const buildAiCurl = (form: ByokForm): string => {
  const base = normalizeByokBase(form.baseUrl);
  return [
    `curl -X POST ${base}/chat/completions \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Authorization: Bearer ${form.apiKey}" \\`,
    `  -d '{`,
    `    "model": "${form.model}",`,
    `    "messages": [{"role": "system", "content": "{{SYSTEM_PROMPT}}"}, {"role": "user", "content": "{{TEXT}}"}],`,
    `    "stream": ${form.streaming ? "true" : "false"}`,
    `  }'`,
  ].join("\n");
};

const buildSttCurl = (form: ByokForm): string => {
  const base = normalizeByokBase(form.baseUrl);
  return [
    `curl -X POST ${base}/audio/transcriptions \\`,
    `  -H "Authorization: Bearer ${form.apiKey}" \\`,
    `  -F "file=@{{AUDIO}}" \\`,
    `  -F "model=${form.model}"`,
  ].join("\n");
};

/** Generate the provider record the storage hooks persist. */
export const buildByokProvider = (
  form: ByokForm,
  kind: "ai" | "stt"
): Omit<TYPE_PROVIDER, "id" | "isCustom"> => {
  const byok = {
    baseUrl: normalizeByokBase(form.baseUrl),
    apiKey: form.apiKey.trim(),
    model: form.model.trim(),
  };
  if (kind === "stt") {
    return {
      name: form.name,
      curl: buildSttCurl(form),
      responseContentPath: "text",
      streaming: form.streaming,
      byok,
    };
  }
  return {
    name: form.name,
    curl: buildAiCurl(form),
    responseContentPath: "choices[0].message.content",
    streaming: form.streaming,
    byok,
  };
};

/**
 * Built-in STT providers whose endpoints speak a streaming protocol Hyperly
 * implements (the Deepgram listen protocol over WebSocket). Selecting one of
 * these from the list means streaming is available WITHOUT the BYOK form —
 * the session is built from the provider's curl URL and the configured
 * variables.
 */
export const STREAMING_STT_PROVIDER_IDS = ["deepgram-stt"];

export interface SttStreamSessionConfig {
  base_url: string;
  api_key: string;
  model: string;
}

/**
 * Build the streaming-session config for the selected STT provider:
 * BYOK providers carry it on the record; built-in streaming providers derive
 * it from the curl URL (origin only) and the configured variables. Returns
 * null when streaming does not apply or the key is missing.
 */
export const resolveSttStreamConfig = (
  provider: TYPE_PROVIDER | undefined,
  variables: Record<string, string> | undefined
): SttStreamSessionConfig | null => {
  if (!provider) return null;

  if (provider.streaming && provider.byok) {
    return {
      base_url: provider.byok.baseUrl,
      api_key: provider.byok.apiKey,
      model: provider.byok.model,
    };
  }

  if (provider.id && STREAMING_STT_PROVIDER_IDS.includes(provider.id)) {
    const match = provider.curl.match(/https?:\/\/[^"'\s\\]+/);
    if (!match) return null;
    let base: string;
    try {
      base = new URL(match[0]).origin;
    } catch {
      return null;
    }
    const apiKey =
      variables?.api_key || variables?.API_KEY || variables?.APIKEY || "";
    if (!apiKey.trim()) return null;
    const model =
      variables?.MODEL || variables?.model || "nova-3";
    return { base_url: base, api_key: apiKey.trim(), model: model.trim() };
  }

  return null;
};

/** Whether the provider's endpoint family has a streaming profile at all. */
export const isStreamingCapableStt = (
  provider: TYPE_PROVIDER | undefined
): boolean =>
  !!provider &&
  ((!!provider.byok && provider.streaming === true) ||
    (!!provider.id && STREAMING_STT_PROVIDER_IDS.includes(provider.id)));
