import { createAuthClient } from "better-auth/react";
import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";
import { emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: import.meta.env.PROD ? window.location.origin : import.meta.env.VITE_CONVEX_SITE_URL,
  plugins: [convexClient(), crossDomainClient(), emailOTPClient()],
});

// The cross-domain cookie lives in localStorage. Refresh the session when another
// tab replaces or clears it; each protected Convex function still checks the DB.
if (typeof window !== "undefined") {
  const changed = (event: StorageEvent) => {
    if (event.key === "better-auth_cookie" || event.key === null)
      authClient.$store.notify("$sessionSignal");
  };
  window.addEventListener("storage", changed);
  import.meta.hot?.dispose(() => window.removeEventListener("storage", changed));
}
