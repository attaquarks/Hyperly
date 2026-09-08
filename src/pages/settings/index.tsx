import {
  Theme,
  AlwaysOnTopToggle,
  AppIconToggle,
  PersonalContext,
} from "./components";
import { PageLayout } from "@/layouts";

const Settings = () => {
  return (
    <PageLayout
      title="Settings"
      description="Manage your settings and personal interview context"
    >
      {/* Personal Context (interview / meeting context) */}
      <PersonalContext />

      {/* Theme */}
      <Theme />


      {/* App Icon Toggle */}
      <AppIconToggle />

      {/* Always On Top Toggle */}
      <AlwaysOnTopToggle />
    </PageLayout>
  );
};

export default Settings;
