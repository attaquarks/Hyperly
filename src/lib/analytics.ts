// PostHog analytics has been removed for the personal build.
// The previous implementation called `PostHog.capture` from `tauri-plugin-posthog-api`.
// We keep the public surface (ANALYTICS_EVENTS + captureEvent) as no-ops so callers
// compile and run unchanged, but no telemetry is sent anywhere.

export const ANALYTICS_EVENTS = {
  // App Lifecycle
  APP_STARTED: "app_started",
} as const;

/**
 * No-op analytics capture.
 */
export const captureEvent = async (
  _eventName: string,
  _properties?: Record<string, any>
): Promise<void> => {
  // Intentionally empty: analytics removed.
};

/**
 * No-op app-start tracking.
 */
export const trackAppStart = async (
  _appVersion: string,
  _instanceId: string
): Promise<void> => {
  // Intentionally empty: analytics removed.
};
