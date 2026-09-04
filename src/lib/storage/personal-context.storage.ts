import { STORAGE_KEYS, DEFAULT_PERSONAL_CONTEXT } from "@/config";

/**
 * Get the personal context from localStorage.
 * Returns the default template if no context is set yet.
 */
export const getPersonalContext = (): string => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.PERSONAL_CONTEXT);
    if (stored !== null) {
      return stored;
    }
    return DEFAULT_PERSONAL_CONTEXT;
  } catch (error) {
    console.error("Failed to read personal context:", error);
    return DEFAULT_PERSONAL_CONTEXT;
  }
};

/**
 * Persist the personal context to localStorage.
 */
export const setPersonalContext = (text: string): void => {
  try {
    localStorage.setItem(STORAGE_KEYS.PERSONAL_CONTEXT, text);
  } catch (error) {
    console.error("Failed to save personal context:", error);
  }
};

/**
 * Whether the personal context should be prepended to every AI request.
 */
export const isInterviewContextEnabled = (): boolean => {
  try {
    const stored = localStorage.getItem(
      STORAGE_KEYS.INTERVIEW_CONTEXT_ENABLED
    );
    // Default to true so the feature "just works" out of the box.
    if (stored === null) return true;
    return stored === "true";
  } catch (error) {
    return true;
  }
};

export const setInterviewContextEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(
      STORAGE_KEYS.INTERVIEW_CONTEXT_ENABLED,
      String(enabled)
    );
  } catch (error) {
    console.error("Failed to save interview context toggle:", error);
  }
};

/**
 * Build the effective system prompt for an AI request by prepending the
 * personal context if it is enabled. Returns the original prompt
 * unchanged if no context is set or the feature is disabled.
 */
export const composeSystemPromptWithContext = (
  basePrompt: string | undefined
): string | undefined => {
  if (!isInterviewContextEnabled()) return basePrompt;
  const context = getPersonalContext();
  if (!context || !context.trim()) return basePrompt;
  if (!basePrompt || !basePrompt.trim()) return context;
  return `${context}

${basePrompt}`;
};
