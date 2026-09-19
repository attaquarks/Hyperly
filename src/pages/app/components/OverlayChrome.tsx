import {
  LayoutDashboardIcon,
  Maximize2Icon,
  Minimize2Icon,
  MinusIcon,
  MoonIcon,
  SunIcon,
  XIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState } from "react";
import { Button, DragButton } from "@/components";
import { useTheme } from "@/contexts/theme.context";
import {
  setOverlayPinnedOpen,
  useWindowResize,
} from "@/hooks/useWindow";
import { cn } from "@/lib/utils";

export type OverlayMode = "ask" | "listen";

type OverlayChromeProps = {
  mode: OverlayMode;
  onModeChange: (mode: OverlayMode) => void;
  status: string;
  statusTone?: "ready" | "active" | "working";
  children: React.ReactNode;
};

const statusToneClasses = {
  ready: "bg-muted-foreground/50",
  active: "bg-emerald-400 shadow-[0_0_0_3px_rgb(52_211_153/0.12)]",
  working: "bg-amber-300 shadow-[0_0_0_3px_rgb(252_211_77/0.12)]",
};

export const OverlayChrome = ({
  mode,
  onModeChange,
  status,
  statusTone = "ready",
  children,
}: OverlayChromeProps) => {
  const { theme, setTheme } = useTheme();
  const { resizeWindow } = useWindowResize();
  const [expanded, setExpanded] = useState(false);
  const isDark = theme === "dark";

  const openDashboard = () => {
    void invoke("open_dashboard").catch((error) =>
      console.error("Failed to open dashboard:", error)
    );
  };

  // Restore/collapse toggle. This is deliberately NOT an OS maximize: the
  // overlay is transparent and undecorated, so a real maximize would cover the
  // whole screen and swallow clicks. We only grow the height.
  const toggleExpanded = async () => {
    const next = !expanded;
    setExpanded(next);
    setOverlayPinnedOpen(next);
    await resizeWindow(next);
  };

  const minimizeWindow = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (error) {
      console.error("Failed to minimize window:", error);
    }
  };

  const closeWindow = async () => {
    try {
      await getCurrentWindow().hide();
    } catch (error) {
      console.error("Failed to hide window:", error);
    }
  };

  return (
    <div className="hyperly-overlay-shell">
      <header
        className="hyperly-overlay-header"
        aria-label="Hyperly overlay navigation"
        data-tauri-drag-region={true}
      >
        <div className="flex items-center gap-2">
          <span className="hyperly-wordmark">Hyperly</span>
          <nav className="flex items-center gap-1" aria-label="Assistant mode">
            {(["ask", "listen"] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-current={mode === item ? "page" : undefined}
                onClick={() => onModeChange(item)}
                className={cn(
                  "hyperly-tab",
                  mode === item && "hyperly-tab-active"
                )}
              >
                {item === "ask" ? "Ask" : "Listen"}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="hyperly-status" aria-live="polite">
            <span className={cn("hyperly-status-dot", statusToneClasses[statusTone])} />
            {status}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="hyperly-header-action"
            onClick={openDashboard}
            title="Open dashboard"
          >
            <LayoutDashboardIcon className="size-3.5" />
            Dashboard
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="hyperly-header-icon"
            onClick={() => setTheme(isDark ? "light" : "dark")}
            title={`Switch to ${isDark ? "light" : "dark"} theme`}
          >
            {isDark ? <SunIcon className="size-3.5" /> : <MoonIcon className="size-3.5" />}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="hyperly-header-icon"
            onClick={minimizeWindow}
            title="Minimize window"
          >
            <MinusIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="hyperly-header-icon"
            onClick={toggleExpanded}
            title={expanded ? "Collapse overlay" : "Expand overlay"}
          >
            {expanded ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="hyperly-header-icon"
            onClick={closeWindow}
            title="Hide window (Ctrl+\)"
          >
            <XIcon className="size-3.5" />
          </Button>
          <DragButton />
        </div>
      </header>
      <div className="hyperly-overlay-content overflow-y-auto max-h-[calc(100vh-3.5rem)]">{children}</div>
    </div>
  );
};
