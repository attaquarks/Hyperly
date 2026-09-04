import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "../storage";
import { STORAGE_KEYS } from "@/config";

// Helper function to check if Hyperly API should be used
export async function shouldUseHyperlyAPI(): Promise<boolean> {
  try {
    // Check if Hyperly API is enabled in localStorage
    const hyperlyApiEnabled =
      safeLocalStorage.getItem(STORAGE_KEYS.HYPERLY_API_ENABLED) === "true";
    if (!hyperlyApiEnabled) return false;

    // Check if license is available
    const hasLicense = await invoke<boolean>("check_license_status");
    return hasLicense;
  } catch (error) {
    console.warn("Failed to check Hyperly API availability:", error);
    return false;
  }
}
