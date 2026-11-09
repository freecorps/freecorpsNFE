import { register as registerAuth } from "@convex-dev/better-auth/test";
import { register as registerRateLimiter } from "@freecorps/convex-rate-limiter/test";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { vi } from "vite-plus/test";

export function register(t: Parameters<typeof registerAuth>[0]) {
  // convex-test uses host timers for scheduled functions. Retention deadlines
  // exceed Node's 32-bit delay; fake timers keep them pending until explicitly advanced.
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  registerAuth(t);
  registerRateLimiter(t);
  for (const name of [
    "importPool",
    "capturePool",
    "webhookPool",
    "exportPool",
    "issuancePool",
    "contentPool",
  ])
    registerWorkpool(t, name);
}
