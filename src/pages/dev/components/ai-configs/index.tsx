import { Header } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";
import { ByokProviderCard } from "../byok/ByokProviderCard";

export const AIProviders = (settings: UseSettingsReturn) => {
  return (
    <div id="ai-providers" className="space-y-3">
      <Header
        title="Choose your AI provider"
        description="Pick a built-in provider or add your own — base URL, key, model."
        isMainTitle
      />

      {/* Simple BYOK form: base URL + key + model, fetch/test/save */}
      <ByokProviderCard kind="ai" />
      {/* Providers Selection (built-ins + saved BYOK providers, by name) */}
      <Providers {...settings} />
    </div>
  );
};
