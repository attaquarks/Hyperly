import { Header } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";
import { CustomProviders } from "./CustomProvider";
import { ByokProviderCard } from "../byok/ByokProviderCard";

export const STTProviders = (settings: UseSettingsReturn) => {
  return (
    <div id="stt-providers" className="space-y-3">
      <Header
        title="STT Providers"
        description="Select your preferred STT service provider to get started."
        isMainTitle
      />

      {/* Simple BYOK form: base URL + key + model, fetch/test/save */}
      <ByokProviderCard kind="stt" />
      {/* Custom Provider */}
      <CustomProviders {...settings} />
      {/* Providers Selection */}
      <Providers {...settings} />
    </div>
  );
};
