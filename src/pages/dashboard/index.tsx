import { PageLayout } from "@/layouts";

const Dashboard = () => {
  return (
    <PageLayout
      title="Dashboard"
      description="Welcome to your personal AI assistant."
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-input/50 bg-muted/20 p-6">
          <h2 className="text-sm font-semibold mb-2">Welcome</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            This is the dashboard. Use the sidebar to manage your chats, system
            prompts, AI providers, audio devices, responses, screenshots, and
            keyboard shortcuts.
          </p>
        </div>
      </div>
    </PageLayout>
  );
};

export default Dashboard;
