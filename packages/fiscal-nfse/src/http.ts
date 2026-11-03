/**
 * Transporte injetado. O pacote não abre conexões: quem injeta decide rede,
 * timeout, limites de corpo e mTLS (o certificado do cliente no handshake é
 * a autenticação do ADN). Exceção lançada pelo transporte significa que o
 * resultado do pedido é desconhecido.
 *
 * Só tipos, sem `node:zlib`: a PTAX do subconjunto `./pure` depende deles.
 */
export type NfseHttpRequest = {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
};
/**
 * `contentType` é opcional: só entra no diagnóstico de respostas ilegíveis
 * (`ResponseDiagnostic`), nunca na classificação.
 */
export type NfseHttpResponse = { status: number; body: string; contentType?: string | null };
export type NfseTransport = (request: NfseHttpRequest) => Promise<NfseHttpResponse>;
