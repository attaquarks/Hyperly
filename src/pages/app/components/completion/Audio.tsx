import { InfoIcon, MicIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, Button } from "@/components";
import { AutoSpeechVAD } from "./AutoSpeechVad";
import { UseCompletionReturn } from "@/types";
import { useApp } from "@/contexts";

export const Audio = ({
  micOpen,
  setMicOpen,
  enableVAD,
  setEnableVAD,
  submit,
  setState,
  micTranscript,
  setMicTranscript,
}: UseCompletionReturn) => {
  const { selectedSttProvider, selectedAudioDevices } = useApp();

  const speechProviderStatus = selectedSttProvider.provider;

  return (
    // The popover stays open for as long as the mic is live so the running
    // "User" transcript remains visible; it only closes once the mic is off.
    <Popover open={enableVAD || micOpen} onOpenChange={setMicOpen}>
      {/* The trigger must be a STABLE component per provider state: swapping
          between a plain Button and AutoSpeechVAD mid-click (the old behavior)
          broke Radix's asChild ref handoff and made the mic feel dead. */}
      <PopoverTrigger asChild>
        {speechProviderStatus ? (
          <AutoSpeechVAD
            key={selectedAudioDevices.input.id}
            submit={submit}
            setState={setState}
            enableVAD={enableVAD}
            setEnableVAD={setEnableVAD}
            setMicTranscript={setMicTranscript}
            microphoneDeviceId={selectedAudioDevices.input.id}
          />
        ) : (
          <Button
            size="icon"
            className="cursor-pointer"
            title="Voice input (configure a speech provider first)"
          >
            <MicIcon className="h-4 w-4" />
          </Button>
        )}
      </PopoverTrigger>

      <PopoverContent
        align="end"
        side="bottom"
        className="w-80 p-3"
        sideOffset={8}
      >
        {!speechProviderStatus ? (
          <div className="text-sm select-none">
            <div className="font-semibold text-orange-600 mb-1">
              Speech Provider Configuration Required
            </div>
            <div className="text-muted-foreground">
              <div className="mt-2 flex flex-row gap-1 items-center text-orange-600">
                <InfoIcon size={16} />
                <span>PROVIDER IS MISSING</span>
              </div>
              <span className="block mt-2">
                Please go to settings and configure your speech provider to
                enable voice input.
              </span>
            </div>
          </div>
        ) : (
          <div className="select-none">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                User
              </span>
              {enableVAD && (
                <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              )}
            </div>
            <p className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed">
              {micTranscript ||
                (enableVAD ? "Listening… speak now" : "Mic off")}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
