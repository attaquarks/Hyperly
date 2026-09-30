import { useEffect, useState } from "react";
import { CheckIcon, Maximize2Icon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { STORAGE_KEYS } from "@/config/constants";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components";

// Exactly two overlay geometries. The panel is a fixed-size shell, so every
// preset has to be a size the layout actually holds at — an arbitrary height
// would leave the transcript scroller with no room. Wide is for side-by-side
// work (a document plus the overlay), Tall for reading long transcripts.
const SIZE_PRESETS = [
  { id: "wide", label: "Wide", width: 760, height: 560 },
  { id: "tall", label: "Tall", width: 600, height: 720 },
] as const;

type SizePresetId = (typeof SIZE_PRESETS)[number]["id"];

const DEFAULT_PRESET: SizePresetId = "tall";

const isPresetId = (value: string | null): value is SizePresetId =>
  value !== null && SIZE_PRESETS.some((p) => p.id === value);

// Last row of Listen: the two overlay sizes on the left, and the hide
// shortcut as quiet text. Hide goes through the same Rust path as Ctrl+\ so
// the visibility flag never desyncs.
export const ListenFooter = () => {
  const [activePreset, setActivePreset] =
    useState<SizePresetId>(DEFAULT_PRESET);

  const applySize = (preset: SizePresetId) => {
    const match = SIZE_PRESETS.find((p) => p.id === preset);
    if (!match) return;

    void invoke("set_window_size", {
      width: match.width,
      height: match.height,
    }).catch((err) => console.error("Failed to resize window:", err));
  };

  // The chosen geometry lives in the Rust window, not React, so it has to be
  // re-applied on mount — otherwise a restart would silently fall back to
  // whatever tauri.conf.json declares and the saved preset would look lost.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.OVERLAY_SIZE);
    const preset = isPresetId(saved) ? saved : DEFAULT_PRESET;
    setActivePreset(preset);
    applySize(preset);
    // Mount-only: this restores persisted geometry, it is not a reaction to
    // anything that changes later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectPreset = (preset: SizePresetId) => {
    setActivePreset(preset);
    localStorage.setItem(STORAGE_KEYS.OVERLAY_SIZE, preset);
    applySize(preset);
  };

  const hide = () => {
    void invoke("toggle_main_window").catch((err) =>
      console.error("Failed to hide window:", err)
    );
  };

  return (
    <div className="hyperly-overlay-footer">
      <DropdownMenu>
        <DropdownMenuTrigger className="hyperly-icon-btn" title="Overlay size">
          <Maximize2Icon className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          {SIZE_PRESETS.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => selectPreset(p.id)}
            >
              <CheckIcon
                className={
                  p.id === activePreset
                    ? "size-3 opacity-100"
                    : "size-3 opacity-0"
                }
              />
              {p.label} · {p.width}×{p.height}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        className="hyperly-icon-btn"
        onClick={hide}
        title="Hide window"
      >
        Hide · Ctrl+\
      </button>
    </div>
  );
};
