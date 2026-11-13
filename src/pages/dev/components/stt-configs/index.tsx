import { Header } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";
import { ByokProviderCard } from "../byok/ByokProviderCard";

export const STTProviders = (settings: UseSettingsReturn) => {
  return (
    <div id="stt-providers" className="space-y-3">
      <Header
        title="Choose your STT provider"
        description="Pick a built-in provider or add your own — base URL, key, model."
        isMainTitle
      />

      {/* Simple BYOK form with streaming detection */}
      <ByokProviderCard kind="stt" />
      {/* Providers Selection (built-ins + saved BYOK providers, by name) */}
      <Providers {...settings} />
    </div>
  );
};
