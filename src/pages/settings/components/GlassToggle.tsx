import { Switch, Label, Header } from "@/components";
import { useApp } from "@/contexts";

interface GlassToggleProps {
  className?: string;
}

export const GlassToggle = ({ className }: GlassToggleProps) => {
  const { customizable, toggleOverlayGlass } = useApp();

  const handleSwitchChange = async (checked: boolean) => {
    await toggleOverlayGlass(checked);
  };

  return (
    <div id="overlay-glass" className={`space-y-2 ${className}`}>
      <Header
        title="Ambient Glass"
        description="Translucent glass surface with rim light and grain (no GPU needed). Off = the classic solid surface"
        isMainTitle
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div>
            <Label className="text-sm font-medium">
              {customizable.glass.overlay
                ? "Disable ambient glass"
                : "Enable ambient glass"}
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              {customizable.glass.overlay
                ? "Translucent ambient glass is active"
                : "Solid overlay surface"}
            </p>
          </div>
        </div>
        <Switch
          checked={customizable.glass.overlay}
          onCheckedChange={handleSwitchChange}
          title={`Toggle to ${
            !customizable.glass.overlay ? "Enabled" : "Disabled"
          } ambient glass`}
          aria-label={`Toggle to ${
            customizable.glass.overlay ? "Enabled" : "Disabled"
          } ambient glass`}
        />
      </div>
    </div>
  );
};
