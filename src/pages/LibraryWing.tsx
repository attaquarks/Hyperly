import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { FolderOpenIcon, Search, XIcon } from "lucide-react";
import {
  extractText,
  MAX_KNOWLEDGE_CHARS,
  type LibraryEntry,
} from "@/hooks/useKnowledge";
import type { KnowledgeFile } from "@/types/system-audio";

/**
 * The Listen knowledge Library as a wing window: the history wing's LEFT-side
 * twin, docked top-left of the overlay (Rust owns the geometry and move
 * sync). The wing OWNS folder picking and file reading — File objects live in
 * the window that picked them and cannot cross windows — so selecting a file
 * here extracts its text and ships the finished KnowledgeFile to the overlay
 * over the `library-wing-pick` event, then closes itself.
 *
 * Layout (matching the history wing): heading, select-folder button, search
 * bar, then the file names.
 */
export const LibraryWing = () => {
  const [folderName, setFolderName] = useState("");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const filtered = entries.filter((entry) =>
    search ? entry.name.toLowerCase().includes(search.toLowerCase()) : true
  );

  const pickFolder = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    const first = files[0] as File & { webkitRelativePath?: string };
    setFolderName(first.webkitRelativePath?.split("/")[0] ?? "Folder");
    setEntries(files.map((file) => ({ name: file.name, file })));
    setError("");
  };

  // Pick a file → extract its text HERE (the wing's webview owns the File
  // objects) → ship it to the overlay → close.
  const sendFile = async (entry: LibraryEntry) => {
    setPicking(true);
    setError("");
    try {
      const text = await extractText(entry.file);
      const truncated = text.length > MAX_KNOWLEDGE_CHARS;
      const payload: KnowledgeFile = {
        name: entry.name,
        folderName,
        text: truncated ? text.slice(0, MAX_KNOWLEDGE_CHARS) : text,
        truncated,
      };
      await emit("library-wing-pick", payload);
      await invoke("close_library_wing");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to read the file"
      );
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="hyperly-wing-shell">
      <div className="hyperly-wing-bubble" data-tauri-drag-region={true}>
        <header
          className="hyperly-wing-header"
          data-tauri-drag-region={true}
          aria-label="Library wing"
        >
          <span className="hyperly-wing-title" data-tauri-drag-region={true}>
            Library
          </span>
          <button
            type="button"
            className="hyperly-wing-close"
            title="Close library"
            onClick={() => void invoke("close_library_wing")}
          >
            <XIcon className="size-3.5" />
          </button>
        </header>
        <div className="hyperly-wing-body">
          <div className="flex w-full flex-col min-h-0">
            {/* Select-folder control: sits under the heading, above search. */}
            <div className="px-2 pt-1 pb-2">
              <button
                type="button"
                className="hyperly-wing-select"
                onClick={() => folderInputRef.current?.click()}
                title="Pick the knowledge folder"
              >
                <FolderOpenIcon className="size-3" />
                <span className="truncate">
                  {folderName || "Select folder"}
                </span>
              </button>
              <input
                ref={folderInputRef}
                type="file"
                className="hidden"
                {...({ webkitdirectory: "" } as any)}
                onChange={(e) => {
                  pickFolder(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            {/* Search bar, then the file names — same stack as history. */}
            <div className="relative px-2 pb-2">
              <Search className="absolute left-4 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search..."
                className="hyperly-wing-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="hyperly-wing-list">
              {entries.length === 0 ? (
                <p className="hyperly-wing-empty">
                  {folderName
                    ? "No files in this folder"
                    : "Pick a folder to browse its files as knowledge"}
                </p>
              ) : (
                <ul className="hyperly-wing-list-ul">
                  {filtered.map((entry, index) => (
                    <li key={`${entry.name}-${index}`}>
                      <button
                        type="button"
                        className="hyperly-wing-item"
                        disabled={picking}
                        onClick={() => void sendFile(entry)}
                        title="Use as knowledge for the next prompt"
                      >
                        <span className="truncate text-xs">{entry.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {error && (
                <p className="hyperly-wing-error">{error}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
