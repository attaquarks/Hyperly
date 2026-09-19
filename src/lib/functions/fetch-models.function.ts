import curl2Json from "@bany/curl-to-json";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { MODEL_LIST_OVERRIDES } from "@/config";
import { TYPE_PROVIDER } from "@/types";
import { deepVariableReplacer, getByPath } from "./common.function";

export type FetchModelsResult =
  | { status: "ok"; models: string[] }
  | { status: "unsupported" }
  | { status: "error"; message: string };

/**
 * Derives the model-list URL from a chat endpoint: `…/chat/completions` →
 * `…/models` (OpenAI-compatible), otherwise the last path segment is swapped
 * for `models` (e.g. Claude's `/v1/messages` → `/v1/models`).
 */
const deriveModelsUrl = (chatUrl: string): string | null => {
  if (!chatUrl) return null;
  if (chatUrl.includes("/chat/completions")) {
    return chatUrl.replace(/\/chat\/completions.*$/, "/models");
  }
  return chatUrl.replace(/\/[^/?]*(\?.*)?$/, "/models");
};

/**
 * Fetches the model list a provider exposes so the MODEL variable can be
 * picked from a dropdown instead of typed by hand. OpenAI-compatible
 * providers (built-in or custom) are covered by the default rule; providers
 * with a different shape carry an entry in MODEL_LIST_OVERRIDES, and a `null`
 * override means the provider has no list endpoint (`unsupported`).
 */
export const fetchProviderModels = async (
  provider: TYPE_PROVIDER,
  variables: Record<string, string>
): Promise<FetchModelsResult> => {
  const override = provider.id ? MODEL_LIST_OVERRIDES[provider.id] : undefined;
  if (override === null) {
    return { status: "unsupported" };
  }

  let curlJson;
  try {
    curlJson = curl2Json(provider.curl);
  } catch {
    return {
      status: "error",
      message: "Could not parse the provider's curl command.",
    };
  }

  // Stored variables are keyed lowercase while placeholders are uppercase —
  // the same re-keying fetchAIResponse applies before substitution.
  const allVariables = Object.fromEntries(
    Object.entries(variables || {}).map(([key, value]) => [
      key.toUpperCase(),
      value,
    ])
  );

  // Reuse the provider curl's own headers so its auth scheme (Bearer,
  // x-api-key, …) carries over. Headers whose variables were never filled
  // are dropped, so a keyless local server sends no dangling
  // `Authorization: Bearer {{API_KEY}}`.
  const headers: Record<string, string> = deepVariableReplacer(
    curlJson.header || {},
    allVariables
  );
  for (const key of Object.keys(headers)) {
    if (typeof headers[key] === "string" && headers[key].includes("{{")) {
      delete headers[key];
    }
  }

  const url = override
    ? override.url(variables?.api_key ?? "")
    : deriveModelsUrl(curlJson.url || "");
  if (!url) {
    return { status: "unsupported" };
  }

  const listPath = override?.listPath ?? "data";
  const idPath = override?.idPath ?? "id";

  try {
    // Same fetch split as fetchAIResponse: plain fetch for http(s) URLs.
    const fetchFunction = url.includes("http") ? fetch : tauriFetch;
    const response = await fetchFunction(url, { method: "GET", headers });
    if (!response.ok) {
      return {
        status: "error",
        message: `Model list request failed: ${response.status} ${response.statusText}`,
      };
    }

    const json = await response.json();
    const list = getByPath(json, listPath);
    if (!Array.isArray(list)) {
      return {
        status: "error",
        message: "The model list response had an unexpected shape.",
      };
    }

    let items = list;
    if (override?.filter) {
      const { path, includes } = override.filter;
      items = items.filter((item) => {
        const value = getByPath(item, path);
        return Array.isArray(value) && value.includes(includes);
      });
    }

    const models = items
      .map((item) => getByPath(item, idPath))
      .filter((id): id is string => typeof id === "string" && !!id)
      .map((id) =>
        override?.stripPrefix && id.startsWith(override.stripPrefix)
          ? id.slice(override.stripPrefix.length)
          : id
      );
    models.sort((a, b) => a.localeCompare(b));

    if (models.length === 0) {
      return { status: "error", message: "The provider returned no models." };
    }
    return { status: "ok", models };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown network error",
    };
  }
};
