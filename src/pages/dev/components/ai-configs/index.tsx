import { Header } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";
import { CustomProviders } from "./CustomProvider";
import { ByokProviderCard } from "../byok/ByokProviderCard";

export const AIProviders = (settings: UseSettingsReturn) => {
  return (
    <div id="ai-providers" className="space-y-3">
      <Header
        title="AI Providers"
        description="Select your preferred AI service provider to get started."
        isMainTitle
      />

      {/* Simple BYOK form: base URL + key + model, fetch/test/save */}
      <ByokProviderCard kind="ai" />
      {/* Custom Provider */}
      <CustomProviders {...settings} />
      {/* Providers Selection */}
      <Providers {...settings} />
    </div>
  );
};
