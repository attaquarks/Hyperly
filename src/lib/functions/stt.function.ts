import {
  deepVariableReplacer,
  getByPath,
  blobToBase64,
} from "./common.function.ts";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type { TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";

/**
 * The outcome of a transcription attempt (Phase 4 R4, issue #17).
 *
 * Failure used to be *expressible as text*. `fetchSTT` returned a plain string
 * on the success path for a 401, an unparseable body or the literal sentence
 * "No transcription found", and a job-based provider returned its job id — so
 * every caller had to guess whether a string was speech. The guess was wrong in
 * all four cases: the text was persisted as a transcript and handed to the
 * model as a user utterance.
 *
 * A discriminated union removes the guess. `ok` is the only member that carries
 * text, so an error cannot be mistaken for speech by construction.
 */
export type SttResult =
  | { status: "ok"; text: string }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "cancelled" };

export interface STTParams {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  audio: File | Blob;
  /** Abandons an in-flight request, e.g. when capture stops. */
  signal?: AbortSignal;
  /**
   * The HTTP client to use. Defaults to the Tauri client for http(s) URLs — see
   * the fetch-selection note in `fetchSTT` — and exists so the check script can
   * drive the real request/response handling without a network. The same
   * injection pattern as `SpeechBlockQueue`'s scheduler and clock.
   */
  fetchImpl?: typeof globalThis.fetch;
}

const ok = (text: string): SttResult => ({ status: "ok", text });
const empty = (): SttResult => ({ status: "empty" });
const cancelled = (): SttResult => ({ status: "cancelled" });
const failed = (message: string): SttResult => ({ status: "error", message });

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Marks the multipart field that carries the audio. */
const AUDIO_PLACEHOLDER = "{{AUDIO}}";

/**
 * Substitute `{{ANY_CASE}}` placeholders in a URL, case-insensitively.
 *
 * Only the URL needs this: curl2json feeds it through the WHATWG URL parser,
 * which lowercases the host — so Azure's `{{REGION}}` host arrives as
 * `{{region}}` while variable keys are uppercase by convention, and an exact
 * match would leave the literal placeholder in the host, sending the request to
 * a nonexistent domain. Everything else (headers, form fields, JSON body) keeps
 * exact case, which is what the providers declare.
 */
const replaceUrlPlaceholders = (
  url: string,
  variables: Record<string, string>
): string =>
  url.replace(
    /\{\{([A-Za-z0-9_]+)\}\}/g,
    (match: string, name: string): string => {
      const key = name.toUpperCase();
      return key in variables ? variables[key] : match;
    }
  );

/**
 * curl2json flattens repeated `-F` flags into an array of `"key=value"` strings
 * (and, for some inputs, a plain object). Normalise both shapes into pairs,
 * splitting on the *first* `=` so a JSON value keeps any `=` of its own.
 */
const formEntries = (form: unknown): Array<[string, string]> => {
  if (Array.isArray(form)) {
    return form.map((item): [string, string] => {
      const text = String(item);
      const separator = text.indexOf("=");
      return separator === -1
        ? [text, ""]
        : [text.slice(0, separator), text.slice(separator + 1)];
    });
  }
  if (form && typeof form === "object") {
    return Object.entries(form as Record<string, unknown>).map(
      ([key, value]) => [key, String(value ?? "")]
    );
  }
  return [];
};

/**
 * Transcribe one block of audio.
 *
 * Failure is never signalled by returning text: the four `SttResult` outcomes
 * are distinct, and no path returns `ok` when no transcript was produced.
 * Provider misconfiguration that used to look like working speech (Azure's
 * case-mangled path, the unsubstituted `{{AUDIO}}` placeholder) now surfaces
 * as an explicit `error`. (D9: the job-based providers that answered with a
 * job id are gone entirely — one non-polling request can never yield text
 * from them, so they were removed rather than left to fail.)
 */
export async function fetchSTT(params: STTParams): Promise<SttResult> {
  const { provider, selectedProvider, audio, signal, fetchImpl } = params;

  try {
    if (!provider) return failed("Provider not provided");
    if (!selectedProvider) return failed("Selected provider not provided");
    if (!audio) return failed("Audio file is required");
    if (signal?.aborted) return cancelled();

    let curlJson: any;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      return failed(`Failed to parse curl: ${messageOf(error)}`);
    }

    // Validate audio file
    const file = audio as File;
    if (file.size === 0) return failed("Audio file is empty");

    // Stored variables are keyed lowercase while placeholders are uppercase —
    // the same re-keying fetchAIResponse applies before substitution. `AUDIO` is
    // deliberately absent: the placeholder marks *where* the audio goes, and
    // each transport below attaches it, because a form field needs the blob and
    // a JSON body needs base64.
    const allVariables = Object.fromEntries(
      Object.entries(selectedProvider.variables).map(([key, value]) => [
        key.toUpperCase(),
        value,
      ])
    ) as Record<string, string>;

    // Prepare request
    let url = replaceUrlPlaceholders(
      deepVariableReplacer(curlJson.url || "", allVariables),
      allVariables
    );
    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    const formData = deepVariableReplacer(curlJson.form || {}, allVariables);

    // To Check if API accepts Binary Data
    const isBinaryUpload = provider.curl.includes("--data-binary");
    // Fetch URL Params
    const rawParams = curlJson.params || {};
    // Decode Them
    const decodedParams = Object.fromEntries(
      Object.entries(rawParams).map(([key, value]) => [
        key,
        typeof value === "string" ? decodeURIComponent(value) : "",
      ])
    );
    // Get the Parameters from allVariables
    const replacedParams = deepVariableReplacer(decodedParams, allVariables);

    // Add query parameters to URL
    const queryString = new URLSearchParams(replacedParams).toString();
    if (queryString) {
      url += (url.includes("?") ? "&" : "?") + queryString;
    }

    let finalHeaders = { ...headers };
    let body: FormData | string | Blob;

    /** A fresh, formatted copy of the audio for one request body. */
    const freshAudio = async (): Promise<Blob> =>
      new Blob([await audio.arrayBuffer()], { type: audio.type });

    const isForm =
      provider.curl.includes("-F ") || provider.curl.includes("--form");
    if (isForm) {
      const form = new FormData();
      const headerKeys = Object.keys(headers).map((k) =>
        k.toUpperCase().replace(/[-_]/g, "")
      );

      // The provider's own curl declares which field carries the audio, and the
      // blob must be appended under *that* name. The previous code always
      // appended it as `file` and then sent the declared field as the literal
      // string "{{AUDIO}}" — which is why no form provider except the
      // `file=…` ones ever received audio (R4).
      let audioFields = 0;
      for (const [key, value] of formEntries(formData)) {
        if (value.includes(AUDIO_PLACEHOLDER)) {
          form.append(key, await freshAudio(), "audio.wav");
          audioFields += 1;
          continue;
        }
        if (!value) continue;
        if (headerKeys.includes(key.toUpperCase().replace(/[-_]/g, ""))) {
          continue;
        }
        form.append(key, value);
      }
      // A custom form provider whose curl never mentions the placeholder still
      // needs its audio attached; `file` is the convention the built-in form
      // providers use.
      if (audioFields === 0) {
        form.append("file", await freshAudio(), "audio.wav");
      }
      delete finalHeaders["Content-Type"];
      body = form;
    } else if (isBinaryUpload) {
      // Deepgram/Azure/Watson-style: raw binary body
      body = await freshAudio();
    } else {
      // Google-style: JSON payload with base64
      allVariables.AUDIO = await blobToBase64(audio);
      const dataObj = curlJson.data ? { ...curlJson.data } : {};
      body = JSON.stringify(deepVariableReplacer(dataObj, allVariables));
    }

    // The Tauri HTTP client issues the request from Rust, outside the WebView's
    // CORS enforcement — which is why the plugin is a dependency and why the
    // `http:default` capability is granted. The old ternary
    // (`url.includes("http") ? fetch : tauriFetch`) sent every real provider URL
    // (all https://) through the browser client instead, leaving that capability
    // unused and the calls subject to CORS (R4).
    const httpFetch = fetchImpl ?? (url?.includes("http") ? tauriFetch : fetch);

    // Send request
    let response: Response;
    try {
      response = await httpFetch(url, {
        method: curlJson.method || "POST",
        headers: finalHeaders,
        body: curlJson.method === "GET" ? undefined : body,
        signal,
      });
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return cancelled();
      }
      return failed(`Network error: ${messageOf(error)}`);
    }

    if (!response.ok) {
      let errText = "";
      try {
        errText = await response.text();
      } catch {}
      let errMsg: string;
      try {
        const errObj = JSON.parse(errText);
        errMsg = errObj.message || errText;
      } catch {
        errMsg = errText || response.statusText;
      }
      return failed(`HTTP ${response.status}: ${errMsg}`);
    }

    const responseText = await response.text();
    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      // `response_format=text` providers (Groq, OpenAI's default) answer with
      // the transcript itself, so a 2xx body that is not JSON is speech.
      const plain = responseText.trim();
      return plain ? ok(plain) : empty();
    }

    // Extract transcription — exactly as configured, case-sensitively. The old
    // code lower-cased the first character, which turned Azure's `DisplayText`
    // into `displayText` and guaranteed an empty result (R4).
    const path = provider.responseContentPath || "text";
    const raw = getByPath(data, path);
    // Only a string is speech. A path that lands on an object would otherwise be
    // stringified into "[object Object]" and passed off as a transcript.
    const transcription = typeof raw === "string" ? raw.trim() : "";

    if (!transcription) return empty();
    return ok(transcription);
  } catch (error) {
    // An unexpected internal failure must still not escape as something a
    // caller could read as speech.
    return failed(messageOf(error));
  }
}
