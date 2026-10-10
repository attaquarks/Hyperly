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
        description="The microphone currently passes through unchanged. This setting is saved for the AEC processor."
      />

      <div className="flex items-center justify-between rounded-md border border-input/50 p-4">
        <div className="space-y-1">
          <Label htmlFor="aec-enabled" className="text-sm font-medium">
            Enable AEC
          </Label>
          <p className="text-xs text-muted-foreground">
            {enabled ? "Enabled for AEC processing." : "AEC processing disabled."}
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
