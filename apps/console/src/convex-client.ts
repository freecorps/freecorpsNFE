import { ConvexReactClient } from "convex/react";

// The first token was just issued by the server (to the provider or to session-boot.ts): reuse it
// until shortly before it expires instead of asking for another one at once, which would also make
// the server run every query of the connection again.
export const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL, {
  initialAuthTokenReuse: true,
});
// Open the connection now (the client opens it on first use): its handshake overlaps the wait
// for the early token and the first render. Queries still go only after the token, if any.
if (typeof window !== "undefined") convex.connectionState();
