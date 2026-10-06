/**
 * Built-in speech-to-text providers.
 *
 * Contract notes (Phase 4 R4, issue #17):
 *
 * - `curl` is parsed with curl2json. In a form (`-F`) provider, the field whose
 *   value is exactly `{{AUDIO}}` is the one that receives the audio blob —
 *   `file` for OpenAI/Groq/ElevenLabs. It must not be sent as the literal
 *   placeholder text.
 * - `responseContentPath` is matched against the JSON body **case-sensitively**
 *   (`getByPath`), so Azure's `DisplayText` must stay capitalised.
 *
 * Note (D9): Speechmatics and Rev.ai used to be listed here. They are
 * asynchronous job APIs — a single request answers with a job id, never with
 * text — so they could never work in this app, which makes exactly one
 * non-polling request (`fetchSTT`). They were removed rather than left to
 * exist only to fail (implementing polling is deliberately out of scope).
 */
export const SPEECH_TO_TEXT_PROVIDERS = [
  {
    id: "openai-whisper",
    name: "OpenAI Whisper",
    curl: `curl -X POST "https://api.openai.com/v1/audio/transcriptions" \\
      -H "Authorization: Bearer {{API_KEY}}" \\
      -F "file={{AUDIO}}" \\
      -F "model={{MODEL}}"`,
    responseContentPath: "text",
    streaming: false,
  },
  {
    id: "groq",
    name: "Groq Whisper",
    curl: `curl -X POST https://api.groq.com/openai/v1/audio/transcriptions \\
      -H "Authorization: bearer {{API_KEY}}" \\
      -F "file={{AUDIO}}" \\
      -F model={{MODEL}} \\
      -F temperature=0 \\
      -F response_format=text \\
      -F language=en`,
    responseContentPath: "text",
    streaming: false,
  },
  {
    id: "elevenlabs-stt",
    name: "ElevenLabs Speech-to-Text",
    curl: `curl -X POST "https://api.elevenlabs.io/v1/speech-to-text" \\
      -H "xi-api-key: {{API_KEY}}" \\
      -F "file={{AUDIO}}" \\
      -F "model_id={{MODEL}}"`,
    responseContentPath: "text",
    streaming: false,
  },
  {
    id: "google-stt",
    name: "Google Speech-to-Text",
    curl: `curl -X POST "https://speech.googleapis.com/v1/speech:recognize" \\
      -H "Authorization: Bearer {{API_KEY}}" \\
      -H "Content-Type: application/json" \\
      -H "x-goog-user-project: {{PROJECT_ID}}" \\
      -d '{
        "config": {
          "encoding": "LINEAR16", 
          "sampleRateHertz": 16000,
          "languageCode": "en-US"
        },
        "audio": {
          "content": "{{AUDIO}}"
        }
      }'`,
    responseContentPath: "results[0].alternatives[0].transcript",
    streaming: false,
  },
  {
    id: "deepgram-stt",
    name: "Deepgram Speech-to-Text",
    curl: `curl -X POST "https://api.deepgram.com/v1/listen?model={{MODEL}}" \\
      -H "Authorization: TOKEN {{API_KEY}}" \\
      -H "Content-Type: audio/wav" \\
      --data-binary {{AUDIO}}`,
    responseContentPath: "results.channels[0].alternatives[0].transcript",
    streaming: false,
  },
  {
    id: "azure-stt",
    name: "Azure Speech-to-Text",
    curl: `curl -X POST "https://{{REGION}}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US" \\
      -H "Ocp-Apim-Subscription-Key: {{API_KEY}}" \\
      -H "Content-Type: audio/wav" \\
      --data-binary {{AUDIO}}`,
    // Case-sensitive: the conversation endpoint returns `DisplayText` exactly.
    // Lower-casing the first character (the old behaviour) made this path always
    // resolve to undefined, so Azure could never produce a transcript (R4).
    responseContentPath: "DisplayText",
    streaming: false,
  },
  {
    id: "ibm-watson-stt",
    name: "IBM Watson Speech-to-Text",
    curl: `curl -X POST "https://api.us-south.speech-to-text.watson.cloud.ibm.com/v1/recognize" \\
      -H "Authorization: Basic {{API_KEY}}" \\
      -H "Content-Type: audio/wav" \\
      --data-binary {{AUDIO}}`,
    responseContentPath: "results[0].alternatives[0].transcript",
    streaming: false,
  },
];
