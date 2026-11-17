import { cn } from "@/lib/utils";

/**
 * The dashboard's aurora canvas: a fixed full-screen backdrop of three slow,
 * drifting color blobs on the theme's base. The glass cards blur THIS —
 * without it, backdrop-filter has nothing to sample and the cards would be
 * flat translucent panels. Pure CSS (global.css .hyperly-aurora); it paints
 * once and the drift is a compositor-only transform, so it costs nothing per
 * frame beyond the initial raster.
 */
export const GlassBackdrop = ({ className }: { className?: string }) => (
  <div
    aria-hidden
    data-testid="glass-aurora"
    className={cn("hyperly-aurora", className)}
  />
);
