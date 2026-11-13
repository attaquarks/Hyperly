import { AIProviders, STTProviders } from "./components";
import { useSettings } from "@/hooks";
import { PageLayout } from "@/layouts";

/**
 * The provider settings page ("AI Provider" in the dashboard nav): the only
 * four things a user needs — choose an AI provider, add a custom AI provider,
 * choose an STT provider, add a custom STT provider. BYOK providers saved
 * here appear in the selection lists under the user's own name. Nothing else
 * renders here: the curl-template power-user panels are gone from this page.
 */
const DevSpace = () => {
  const settings = useSettings();

  return (
    <PageLayout
      title="AI Provider"
      description="Choose providers or add your own — base URL, key, model, tested before you rely on it."
    >
      {/* Provider Selection */}
      <AIProviders {...settings} />

      {/* STT Providers */}
      <STTProviders {...settings} />
    </PageLayout>
  );
};

export default DevSpace;
