export interface TYPE_PROVIDER {
  id?: string;
  streaming?: boolean;
  responseContentPath?: string;
  isCustom?: boolean;
  curl: string;
  /**
   * The endpoint creates an asynchronous transcription job and answers with an
   * id rather than a transcript (Speechmatics, Rev.ai). Phase 4 R4: one request
   * cannot yield the text, so `fetchSTT` reports that instead of handing the
   * job id to the caller as if it were speech.
   */
  jobBased?: boolean;
}
