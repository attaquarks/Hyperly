import { Header } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";
import { ByokProviderCard } from "../byok/ByokProviderCard";
import { CustomProviderList } from "../byok/CustomProviderList";

export const STTProviders = (settings: UseSettingsReturn) => {
  return (
    <div id="stt-providers" className="space-y-3">
      <Header
        title="Choose your STT provider"
        description="Pick a built-in provider, or add your own below — base URL, key, model."
        isMainTitle
      />

      {/* Providers Selection (built-ins + saved custom providers, by name) */}
      <Providers {...settings} />
      {/* Streaming availability for the selected provider */}
      {/* Delete icons for saved custom providers */}
      <CustomProviderList kind="stt" />
      {/* Simple BYOK form with streaming detection, collapsed by default */}
      <ByokProviderCard kind="stt" />
    </div>
  );
};
