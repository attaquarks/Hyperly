/**
 * Microphone acquisition for the browser/WebView side of the app.
 *
 * # Why this file exists
 *
 * The Audio settings page lists microphones by asking the Rust backend for
 * them (`get_input_devices`). On Windows that command returns
 * `wasapi::Device::get_id()` — a raw endpoint id shaped like
 * `{0.0.0.00000000}.{2b1f...}`. It is the correct id for the *native* loopback
 * code, and the system-audio path depends on it staying that way.
 *
 * It is not, however, an id `getUserMedia` understands. WebView2 reports its
 * inputs through `navigator.mediaDevices.enumerateDevices()`, and those
 * `MediaDeviceInfo.deviceId` values are opaque, per-WebView strings. Handing a
 * WASAPI endpoint id to `getUserMedia` as `deviceId: { exact: ... }` therefore
 * fails with `OverconstrainedError`, and the microphone silently never records:
 * the mic indicator may light up, but no frames reach the VAD and no transcript
 * is ever produced.
 *
 * The two id spaces are bridged by *name*, which both sides do agree on. This
 * module owns that translation, plus the fallbacks that keep voice input alive
 * when even the name is unknown.
 *
 * Consent (Phase 4 R7): every path here sits behind the in-app consent gate in
 * `@/lib/mic-consent`. Nothing reaches `getUserMedia` before an explicit,
 * remembered decision, and a decline is surfaced as a real refusal.
 */
import { hasMicConsent, requestMicConsent } from "./mic-consent.ts";

/** Constraints applied to every capture, so gain/echo handling is consistent. */
const PROCESSING_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: true,
};

/** True for a genuine user/permission refusal, which a fallback must not mask. */
const isPermissionError = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === "NotAllowedError" || error.name === "SecurityError");

const normalizeName = (name?: string | null): string =>
  (name ?? "").trim().toLocaleLowerCase();

/**
 * Ask for the microphone briefly so `enumerateDevices()` starts reporting
 * labels.
 *
 * Chromium withholds device labels until the page has been granted microphone
 * access, which means a name-based lookup silently finds nothing on a first run.
 * Opening a throwaway stream unlocks them; the tracks are stopped immediately
 * and no audio is retained.
 */
export const primeMicrophoneLabels = async (): Promise<void> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
  // Phase 4 R7: never probe before consent exists. The WebView gate would deny
  // the probe and the labels would stay blank anyway; consent is asked for by
  // `getMicrophoneStream`, on the user's first real capture action.
  if (!hasMicConsent()) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    // No permission yet, or no device at all. The caller's real acquisition
    // attempt will surface that properly; this is only a best-effort unlock.
  }
};

/** WebView-visible audio inputs, or an empty list if enumeration is unavailable. */
const webAudioInputs = async (): Promise<MediaDeviceInfo[]> => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput");
  } catch {
    return [];
  }
};

/**
 * Find the WebView id for a device named `deviceName`.
 *
 * Falls back to a partial match because native and WebView names frequently
 * differ only in a vendor suffix or a trailing "(2)".
 */
const findWebInputByName = async (
  deviceName?: string
): Promise<string | undefined> => {
  const wanted = normalizeName(deviceName);
  if (!wanted) return undefined;

  const inputs = await webAudioInputs();
  const exact = inputs.find(
    (device) => normalizeName(device.label) === wanted
  );
  if (exact) return exact.deviceId;

  return inputs.find((device) =>
    normalizeName(device.label).includes(wanted)
  )?.deviceId;
};

export interface MicrophoneInput {
  id: string;
  name: string;
  is_default: boolean;
}

/**
 * WebView-visible audio inputs, shaped like the device rows this page renders.
 *
 * The WebView reports the system default under the literal id `"default"`.
 * Entries whose label is still blank (permission not yet granted, or a device
 * with no friendly name) get a placeholder so the dropdown never renders a
 * nameless, unselectable row.
 */
export const enumerateMicrophoneInputs = async (): Promise<
  MicrophoneInput[]
> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return [];

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        id: device.deviceId,
        name: device.label?.trim() || `Microphone ${index + 1}`,
        is_default: device.deviceId === "default",
      }));
  } catch (error) {
    console.warn("Could not enumerate microphones:", error);
    return [];
  }
};

/**
 * Open the user's microphone.
 *
 * `deviceId` may be a native id, a WebView id, or absent. Rather than trusting
 * it, the id is verified against the WebView's own device list and, when it
 * does not match, the device is recovered by name. Only if both fail do we fall
 * back to the system default, which keeps voice input working instead of
 * failing outright on a stale id.
 *
 * A refused microphone permission is rethrown: that is a real user decision,
 * not something to paper over by quietly switching devices.
 */
export const getMicrophoneStream = async (
  deviceId?: string,
  deviceName?: string
): Promise<MediaStream> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    throw new Error("Microphone capture requires a browser mediaDevices API.");
  }

  // Phase 4 R7: the single consent door. Nothing reaches `getUserMedia` before
  // an explicit decision, and a decline is a real refusal — callers treat it
  // exactly like an OS-level denial instead of retrying another device.
  if (!(await requestMicConsent())) {
    throw new DOMException("Microphone access was declined.", "NotAllowedError");
  }

  const wantsSpecificDevice = Boolean(
    deviceId && deviceId !== "default" && deviceId.trim() !== ""
  );

  if (wantsSpecificDevice) {
    // Prefer the id only when the WebView actually knows it.
    const inputs = await webAudioInputs();
    const known = inputs.some((device) => device.deviceId === deviceId);

    if (known) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { ...PROCESSING_CONSTRAINTS, deviceId: { exact: deviceId } },
        });
      } catch (error) {
        if (isPermissionError(error)) throw error;
        // Device vanished between enumeration and capture: fall through.
      }
    }
  }

  const byName = await findWebInputByName(deviceName);
  if (byName) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...PROCESSING_CONSTRAINTS, deviceId: { exact: byName } },
      });
    } catch (error) {
      if (isPermissionError(error)) throw error;
    }
  }

  // Last resort: whatever the system considers the default input.
  return navigator.mediaDevices.getUserMedia({
    audio: PROCESSING_CONSTRAINTS,
  });
};
