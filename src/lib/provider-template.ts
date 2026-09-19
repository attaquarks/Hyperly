/**
 * Builds an OpenAI-compatible chat-completions curl template from the fields
 * the simple custom-provider form collects. Leaving the API key or model
 * empty keeps the corresponding `{{API_KEY}}` / `{{MODEL}}` placeholder, so
 * the value is asked for at selection time instead of being baked into the
 * stored curl.
 */
export const buildOpenAICompatibleCurl = ({
  baseUrl,
  apiKey = "",
  model = "",
  supportsImages = true,
}: {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  supportsImages?: boolean;
}): string => {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmedBase) return "";

  const endpoint = trimmedBase.endsWith("/chat/completions")
    ? trimmedBase
    : `${trimmedBase}/chat/completions`;
  const auth = apiKey.trim() || "{{API_KEY}}";
  const modelValue = model.trim() || "{{MODEL}}";
  const imagePart = supportsImages
    ? `, {"type": "image_url", "image_url": {"url": "data:image/png;base64,{{IMAGE}}"}}`
    : "";

  return `curl ${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${auth}" \\
  -d '{
    "model": "${modelValue}",
    "messages": [{"role": "system", "content": "{{SYSTEM_PROMPT}}"}, {"role": "user", "content": [{"type": "text", "text": "{{TEXT}}"}${imagePart}]}]
  }'`;
};
