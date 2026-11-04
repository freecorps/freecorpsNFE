/**
 * Every version of the terms of use, operator clause included, ever offered in the console
 * (#586): the SHA-256 of its archived text, `docs/termos/arquivo/<version>.md`, which is also the
 * text the console shows, and the day it entered the console (Brasília), which starts the notice
 * before it takes effect. A version stays here after a newer one replaces it: the organizations
 * that accepted it still name it. `apps/console/src/terms-of-use.test.tsx` fails if a file and its
 * hash part ways.
 *
 * The first version entered the console on 01/11/2026 (#428); 1.1, on 02/11/2026, drops the
 * retired ABRASF NFS-e import from section 1 (#142); 1.2, on 04/11/2026, moves the paid plans and
 * their quotas to the subscription month and drops Pix from section 5A (ADR 0012). Publishing a
 * new one adds the file,
 * its line here and the new current version, in the same change, and that change is deployed the
 * same day: `since` starts the 30 days of notice (docs/termos/README.md).
 */
export const TERMS_OF_USE_ARCHIVE: Readonly<Record<string, { sha256: string; since: string }>> = {
  "termos-de-uso-2026-11-01": {
    sha256: "9473250bf91250e3bb6091f01eb1f6e05b6e5259a440027bd7761b3de23e1e3b",
    since: "2026-11-01",
  },
  "termos-de-uso-2026-11-02": {
    sha256: "3d0ebb439785d879900f7822b6d7bfa2480737ea0acdf8824db6498f85ba5984",
    since: "2026-11-02",
  },
  "termos-de-uso-2026-11-04": {
    sha256: "41a617856f796a8d6219d04eb4a5260effc3eb59669d6146c483ca7f2f130748",
    since: "2026-11-04",
  },
};
/** Version an owner accepts in the console, at the organization's creation and after each change. */
export const TERMS_OF_USE_VERSION: string | null = "termos-de-uso-2026-11-04";
