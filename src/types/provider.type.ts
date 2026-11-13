export interface TYPE_PROVIDER {
  id?: string;
  /** The user's display name for a BYOK provider — shown in the selection
   * list instead of a derived URL. */
  name?: string;
  streaming?: boolean;
  responseContentPath?: string;
  isCustom?: boolean;
  curl: string;
  /** The simple-form values behind a BYOK provider, kept on the record so
   * the streaming-STT session (which needs base URL / key / model as plain
   * fields) can be started without parsing the generated template. */
  byok?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}
