/**
 * Every version of the privacy policy ever published (#428): the SHA-256 of its archived text,
 * `docs/termos/arquivo/<version>.md`, which is also the text the public page `/privacidade` shows,
 * and the day it took effect. Nobody accepts the policy; the terms of use point to it. A version
 * stays here after a newer one replaces it, and the page keeps listing it (policy, section 9).
 * `apps/console/src/privacy-policy.test.tsx` fails if a file and its hash part ways.
 */
export const PRIVACY_POLICY_ARCHIVE: Readonly<Record<string, { sha256: string; since: string }>> = {
  "politica-de-privacidade-2026-11-01": {
    sha256: "02742f6e09412c1120dfde651216ce4c4c9c601a63fd453aaf3109dd04a3a899",
    since: "2026-11-01",
  },
  "politica-de-privacidade-2026-11-09": {
    sha256: "73bafea7430910be042f4afa890eb02cbfab3450fd4fa30018487b67065050c5",
    since: "2026-11-09",
  },
};
/** The version in effect, shown at `/privacidade`. */
export const PRIVACY_POLICY_VERSION: string = "politica-de-privacidade-2026-11-09";
