// When a missing address is a page, shared by the Worker (asset-fallback.ts),
// the self-hosted server (scripts/lib/selfhost-server.mjs) and the console's
// dev server (site-plugin.ts), so the three answer the same addresses alike.

/** The docs app owns /docs and everything under it. */
export const isDocsPath = (/** @type {string} */ pathname) =>
  pathname === "/docs" || pathname.startsWith("/docs/");

/** A page address: last segment without a file extension, or ending in .html. */
export function isPagePath(/** @type {string} */ pathname) {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".") || last.endsWith(".html");
}

/**
 * Whether the Accept header admits HTML: absent, or naming text/html, text/*
 * or *\/* without q=0. Browsers navigate with text/html; the publication smoke
 * and monitors fetch pages with *\/*. A request for JSON or images does not.
 */
export function acceptsHtml(/** @type {string | null | undefined} */ accept) {
  if (!accept) return true;
  return accept.split(",").some((range) => {
    const [type, ...params] = range.split(";").map((part) => part.trim().toLowerCase());
    return (
      ["text/html", "text/*", "*/*"].includes(type) &&
      !params.some((param) => /^q=0(\.0*)?$/.test(param))
    );
  });
}
