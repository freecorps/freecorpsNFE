import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readProcessIdentity } from "./worktree/process-identity.mjs";

export const VALIDATION_LOCK_TOKEN = "FNFE_VALIDATION_LOCK_TOKEN";

/**
 * Builds e relatórios intermediários pertencem ao checkout, não à tentativa.
 * Não recuperamos uma trava pela morte do dono: seus filhos podem continuar
 * escrevendo. Recuperação manual exige encerrar e conferir TODOS os executores
 * de validação deste checkout antes de remover este diretório. Locks de dev
 * não participam desta exclusão.
 */
export function acquireValidationLock(root, inheritedToken) {
  const parent = join(root, ".ci-results");
  const directory = join(parent, "validation.lock");
  const file = join(directory, "owner.json");
  if (inheritedToken !== undefined) {
    // A variável sozinha não concede posse. O dono precisa continuar sendo o
    // mesmo processo, inclusive se o sistema reutilizou seu PID após um crash.
    let owner;
    try {
      owner = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error("Token de validação inválido: trava ausente ou ilegível");
    }
    if (
      !inheritedToken ||
      owner?.schemaVersion !== 1 ||
      owner.token !== inheritedToken ||
      !owner.identity ||
      readProcessIdentity(owner.pid) !== owner.identity
    )
      throw new Error("Token de validação inválido: posse ausente, alterada ou encerrada");
    // O subprocesso participa; somente o runner que adquiriu a trava a libera.
    return Object.assign(() => {}, { token: inheritedToken });
  }
  mkdirSync(parent, { recursive: true });
  try {
    mkdirSync(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      "Validação indisponível: .ci-results/validation.lock existe. Aguarde a execução ativa. " +
        "Se houve interrupção, confira que todos os executores de validação deste checkout " +
        "encerraram antes de remover a trava manualmente. Trava ilegível também bloqueia.",
    );
  }
  const token = randomUUID();
  try {
    writeFileSync(
      file,
      `${JSON.stringify({ schemaVersion: 1, token, pid: process.pid, identity: readProcessIdentity(process.pid) })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    // Nenhum executor foi iniciado. Uma falha parcial permanece bloqueada.
    throw new Error("Não foi possível registrar o dono da trava de validação", { cause: error });
  }
  const release = () => {
    // Só o dono libera. Nenhum concorrente renomeia/apaga uma trava obsoleta.
    if (JSON.parse(readFileSync(file, "utf8")).token !== token)
      throw new Error("A trava de validação mudou de dono; preservada para inspeção");
    unlinkSync(file);
    rmdirSync(directory);
  };
  return Object.assign(release, { token });
}
