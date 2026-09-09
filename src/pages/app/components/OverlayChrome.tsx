import {
  BookOpenIcon,
  LayoutDashboardIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components";
import { useTheme } from "@/contexts/theme.context";
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
  const isDark = theme === "dark";

  const openDashboard = () => {
    void invoke("open_dashboard").catch((error) =>
      console.error("Failed to open dashboard:", error)
    );
  };

  const openDocs = () => {
    void openUrl("https://github.com/attaquarks/Hyperly#readme").catch((error) =>
      console.error("Failed to open Hyperly docs:", error)
    );
  };

  return (
    <div className="hyperly-overlay-shell">
      <header className="hyperly-overlay-header" aria-label="Hyperly overlay navigation">
        <div className="flex items-center gap-3">
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
            size="sm"
            variant="ghost"
            className="hyperly-header-action"
            onClick={openDocs}
            title="Open Hyperly documentation"
          >
            <BookOpenIcon className="size-3.5" />
            Docs
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
        </div>
      </header>
      <div className="hyperly-overlay-content">{children}</div>
    </div>
  );
};
