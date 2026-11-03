import { useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";

/** The server writes at most once a day; the tab asks at most once an hour per organization. */
const ASK_EVERY = 3_600_000;
const asked = new Map<string, number>();

/**
 * Tells the server that this person read fiscal data of the organization (a list or a detail of
 * documents or issuances), which keeps an open organization on Free out of the archive notice
 * (ADR 0009, §1; #641). Called once the read arrived (`loaded`). A failure changes nothing on the
 * page: the read itself already answered.
 */
export function useFiscalRead(organizationId: Id<"organizations">, loaded: boolean) {
  const mark = useMutation(api.archiveNotice.markFiscalRead);
  useEffect(() => {
    if (!loaded) return;
    const now = Date.now();
    if ((asked.get(organizationId) ?? -Infinity) + ASK_EVERY > now) return;
    asked.set(organizationId, now);
    void Promise.resolve(mark({ organizationId })).catch(() => undefined);
  }, [organizationId, loaded, mark]);
}
