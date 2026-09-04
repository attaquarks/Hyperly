// Updater has been removed for the personal/Windows-only build.
// The original Updater relied on the Tauri updater plugin and process
// plugin, both of which are no longer wired up.
//
// To upgrade in the future, the user can simply download the latest
// release from the project repository and reinstall — the local SQLite
// history, system prompts, and AI/STT provider configurations live in
// the OS app-data directory and are preserved across reinstalls.
export const Updater = () => {
  return null;
};
