// Usage component has been removed for the personal/Windows-only build.
// Hyperly Pro Usage tracking was tied to the Hyperly-hosted proxy.
import type { ReactElement } from "react";

interface UsageProps {
  data: { date: string; requests: number }[];
  totalTokens: number;
  loading: boolean;
  onRefresh: () => void;
}

export function Usage(_props: UsageProps): ReactElement | null {
  return null;
}
