/** Explicit operator configuration, never inferred from a request's Host header. */
export function installationOrigin(value: string | undefined): string {
  if (!value) throw new Error("Missing installation origin");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    !url.hostname.includes(".") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
  ) {
    throw new Error("Installation requires an explicit HTTPS origin");
  }
  return value;
}
