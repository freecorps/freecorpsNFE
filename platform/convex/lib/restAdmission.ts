import { ConvexError } from "convex/values";

/** Convex's exhausted OCC error means this mutation did not commit. Fail closed if its format changes. */
export function isAbortedRateConflict(error: unknown) {
  return (
    error instanceof Error &&
    !(error instanceof ConvexError) &&
    /Documents read from or written to the (?:table "rateLimits"|"rateLimits" table) changed while this mutation was being run and on every subsequent retry\./.test(
      error.message,
    )
  );
}

/** Never retry transport/unknown failures: unlike OCC, they do not prove the tokens were not consumed. */
export async function retryRestAdmission<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isAbortedRateConflict(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
    return attempt();
  }
}
