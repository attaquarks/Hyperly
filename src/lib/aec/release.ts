import type { MicAecSession } from "./index.ts";

/** Release the acquired mic itself before disposing its processing graph. */
export const releaseMicAecSession = (
  session: MicAecSession | null | undefined
): void => {
  if (!session) return;
  session.source.getTracks().forEach((track) => track.stop());
  session.dispose();
};
