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
