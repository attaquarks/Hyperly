import { Header } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";
import { ByokProviderCard } from "../byok/ByokProviderCard";
import { CustomProviderList } from "../byok/CustomProviderList";

export const AIProviders = (settings: UseSettingsReturn) => {
  return (
    <div id="ai-providers" className="space-y-3">
      <Header
        title="Choose your AI provider"
        description="Pick a built-in provider, or add your own below — base URL, key, model."
        isMainTitle
      />

      {/* Providers Selection (built-ins + saved custom providers, by name) */}
      <Providers {...settings} />
      {/* Delete icons for saved custom providers */}
      <CustomProviderList kind="ai" />
      {/* Simple BYOK form, collapsed until the user asks for it */}
      <ByokProviderCard kind="ai" />
    </div>
  );
};
