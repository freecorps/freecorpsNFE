import { registryData, type RegistryData } from "../../../packages/contracts/src/registry";

export type ProviderResult =
  | { status: "found"; data: RegistryData }
  | { status: "not_found" | "unavailable" | "unsupported_format"; data: null };
const MAX_BYTES = 262_144;

/** Fixed origin, no redirects, no raw payload in storage/logs. Unknown source date stays null. */
export async function lookupOpenCnpj(
  cnpj: string,
  transport: typeof fetch = fetch,
): Promise<ProviderResult> {
  if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpj)) return { status: "unsupported_format", data: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await transport(`https://api.opencnpj.org/${cnpj}?datasets=receita`, {
      signal: controller.signal,
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return { status: "not_found", data: null };
    if (response.status === 400 && /[A-Z]/.test(cnpj))
      return { status: "unsupported_format", data: null };
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json") ||
      Number(response.headers.get("content-length")) > MAX_BYTES
    )
      return { status: "unavailable", data: null };
    const reader = response.body?.getReader();
    if (!reader) return { status: "unavailable", data: null };
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > MAX_BYTES) {
          await reader.cancel();
          return { status: "unavailable", data: null };
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || !("cnpj" in value) || value.cnpj !== cnpj)
      throw new Error("INVALID_PROVIDER_RESPONSE");
    const raw = value as Record<string, unknown>;
    const text = (key: string) => {
      const result = raw[key] ?? "";
      if (
        typeof result !== "string" ||
        result.split("").some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      )
        throw new Error("INVALID_PROVIDER_FIELD");
      return result.trim();
    };
    const data = registryData.parse({
      name: text("razao_social"),
      status: text("situacao_cadastral"),
      address: {
        street: [text("tipo_logradouro"), text("logradouro")].filter(Boolean).join(" "),
        number: text("numero"),
        complement: text("complemento"),
        district: text("bairro"),
        city: text("municipio"),
        state: text("uf"),
        postalCode: text("cep"),
      },
    });
    if (!data.name || !data.status) throw new Error("EMPTY_PROVIDER_RESPONSE");
    return { status: "found", data };
  } catch {
    return { status: "unavailable", data: null };
  } finally {
    clearTimeout(timer);
  }
}
