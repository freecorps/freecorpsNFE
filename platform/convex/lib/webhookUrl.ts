/** Webhooks usam nomes DNS públicos, sem credenciais embutidas ou IP literal. */
export function normalizeWebhookUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !host.includes(".") ||
    host.includes(":") ||
    /^\d+(\.\d+){3}$/.test(host) ||
    ["localhost", "local", "internal"].some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  )
    throw new Error("Webhook exige https:// com nome DNS público, sem IP literal ou credenciais");
  url.hostname = host;
  url.hash = "";
  return url.href;
}
