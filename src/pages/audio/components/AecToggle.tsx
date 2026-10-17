import { Header, Label, Switch } from "@/components";
import { readAecEnabled, writeAecEnabled } from "@/lib/aec";
import { useState } from "react";

export const AecToggle = () => {
  const [enabled, setEnabled] = useState(readAecEnabled);

  const handleChange = (next: boolean) => {
    setEnabled(next);
    writeAecEnabled(next);
  };

  return (
    <div className="space-y-3">
      <Header
        title="Acoustic Echo Cancellation"
        description="When enabled and a Listen reference is available, microphone audio is routed through the bundled AEC processor. Missing reference or processing failures fall back to the original microphone stream; processing does not guarantee echo removal."
      />

      <div className="flex items-center justify-between rounded-md border border-input/50 p-4">
        <div className="space-y-1">
          <Label htmlFor="aec-enabled" className="text-sm font-medium">
            Enable AEC
          </Label>
          <p className="text-xs text-muted-foreground">
            {enabled
              ? "AEC processing is enabled; missing reference or setup failures use the original microphone stream."
              : "AEC is off; microphone audio passes through unchanged."}
          </p>
        </div>
        <Switch
          id="aec-enabled"
          checked={enabled}
          onCheckedChange={handleChange}
          aria-label="Enable acoustic echo cancellation"
        />
      </div>
    </div>
  );
};
