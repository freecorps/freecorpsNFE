// Recibo dos workflows de operação num repositório público (decisão 6 de
// docs/v1.0/ACCEPTANCE.md e "Evidência restrita" em docs/v1.0/EVIDENCE-STORAGE.md).
// O artefato do run é público: `receipt.json` leva só o que o log já mostra
// (códigos, ids e estados) e o SHA-256 da resposta completa do Convex. A
// resposta completa, que pode trazer nome de empresa, motivo e dados da nota,
// sai só cifrada com age para os custodiantes de deploy/offsite-backup.json,
// em `receipt.full.json.age`, para o operador ler no prazo de retenção do
// artefato. O texto claro nunca vai a disco.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PUBLIC_RECEIPT = "receipt.json";
export const SEALED_RECEIPT = "receipt.full.json.age";

const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * As chaves públicas age dos custodiantes do plano de backup, sem repetição.
 * @param {unknown} plan conteúdo de deploy/offsite-backup.json
 */
export function custodyRecipients(plan) {
  const entries = /** @type {any} */ (plan)?.recipients;
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("SEALED_RECEIPT_NO_RECIPIENTS");
  const recipients = entries.map((entry) => entry?.recipient);
  if (!recipients.every((key) => typeof key === "string" && AGE_RECIPIENT.test(key)))
    throw new Error("SEALED_RECEIPT_RECIPIENT_INVALID");
  return [...new Set(recipients)];
}

/**
 * Cifra `plaintext` para os destinatários com o binário age. Devolve o texto
 * cifrado, ou `null` se o age faltar ou falhar: stderr e caminhos não saem.
 * @param {string} plaintext
 * @param {string[]} recipients
 * @param {{ bin?: string, spawn?: typeof spawnSync }} [tool]
 */
export function ageEncrypt(plaintext, recipients, { bin = "age", spawn = spawnSync } = {}) {
  const args = recipients.flatMap((key) => ["-r", key]);
  const run = spawn(bin, args, {
    input: plaintext,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || run.status !== 0 || !run.stdout?.length) return null;
  return Buffer.from(run.stdout);
}

/**
 * Grava o recibo público e, quando há `sensitive`, a versão completa cifrada.
 * Sem age ou sem destinatários válidos, o recibo público registra
 * `sealed.state: "unavailable"` e nada sensível é gravado; a ação já feita no
 * Convex não é desfeita por isso. `plan` pode vir como função, lida aqui: um
 * plano ausente ou ilegível também vira `unavailable`, nunca uma recusa.
 * @param {{
 *   directory: string;
 *   receipt: Record<string, unknown>;
 *   sensitive?: Record<string, unknown>;
 *   plan?: unknown;
 *   encrypt?: (plaintext: string, recipients: string[]) => Buffer | null;
 * }} input
 */
export function writeSealedReceipt({ directory, receipt, sensitive, plan, encrypt }) {
  mkdirSync(directory, { recursive: true });
  rmSync(join(directory, SEALED_RECEIPT), { force: true });
  let sealed;
  if (sensitive !== undefined) {
    const plaintext = JSON.stringify({ ...receipt, ...sensitive }, null, 2) + "\n";
    let ciphertext = null;
    try {
      const recipients = custodyRecipients(typeof plan === "function" ? plan() : plan);
      ciphertext = (
        encrypt ?? ((text, keys) => ageEncrypt(text, keys, { bin: process.env.AGE_BIN || "age" }))
      )(plaintext, recipients);
    } catch {
      ciphertext = null;
    }
    sealed = { sha256: sha256(plaintext) };
    if (ciphertext?.length) {
      writeFileSync(join(directory, SEALED_RECEIPT), ciphertext);
      sealed = {
        ...sealed,
        state: "sealed",
        file: SEALED_RECEIPT,
        ciphertextSha256: sha256(ciphertext),
      };
    } else sealed = { ...sealed, state: "unavailable" };
  }
  const shown = sealed ? { ...receipt, sealed } : receipt;
  writeFileSync(join(directory, PUBLIC_RECEIPT), JSON.stringify(shown, null, 2) + "\n");
  return shown;
}
