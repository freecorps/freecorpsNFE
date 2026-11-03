import { ConvexError } from "convex/values";

/** Admission has a persisted idempotency key and performs no external fiscal IO. */
export async function retryImportAdmission<T>(admit: () => Promise<T>): Promise<T> {
  try {
    return await admit();
  } catch (error) {
    // Quotas, permission and validation failures are decisions, not transient failures.
    if (error instanceof ConvexError) throw error;
    // Also safe if the first transaction committed but its response was lost.
    // Never reuse this policy for upload tickets, confirmation or fiscal transmission.
    return admit();
  }
}
