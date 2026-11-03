/**
 * Erro de entrada ou de montagem detectado localmente, antes de qualquer
 * envio. `code` é estável para máquinas; `message` é pt-BR para quem opera.
 * Mensagens nunca contêm material de chave nem o XML assinado.
 */
export class NfseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NfseError";
    this.code = code;
  }
}

export const fail = (code: string, message: string): never => {
  throw new NfseError(code, message);
};
