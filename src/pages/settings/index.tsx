import {
  Theme,
  AlwaysOnTopToggle,
  AppIconToggle,
  AutostartToggle,
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

      {/* Autostart Toggle */}
      <AutostartToggle />

      {/* App Icon Toggle */}
      <AppIconToggle />

      {/* Always On Top Toggle */}
      <AlwaysOnTopToggle />
    </PageLayout>
  );
};

export default Settings;
